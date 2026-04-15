# Event Triggers + `step.waitForEvent`

> Status: v1.1 — ships in wave 2 after the MVP. Design references:
> `docs/ROADMAP.md` §6, `docs/ARCHITECTURE.md` §4.2 (trigger types) and
> §4.3 (durable execution), `docs/research/01-workflow-engines.md`
> (Inngest's `step.waitForEvent` pattern we modeled on).

## What it solves

Workflows today fire on **cron** (time), **webhook** (inbound HTTP), or
**manual** (CLI/API invocation). None of those handle the bread-and-butter
async case:

- Stripe 3DS flow: submit payment → user approves in their bank's popup →
  Stripe calls your webhook minutes later.
- OAuth flow: redirect user → wait for the authorization code callback.
- Long-running external job: submit to a queue, poll or receive push.

Without this feature, integration authors build polling hacks. With it,
the workflow _pauses_ durably, the event bus routes the callback, and the
run resumes exactly where it stopped. Inngest, Trigger.dev, and Temporal
all ship this; Chorus MVP skipped it; v1.1 adds it.

## Two primitives

### 1. `event` trigger

A workflow can subscribe to event emissions instead of cron/webhook:

```yaml
# chorus/workflows/order-paid.yaml
id: send-receipt
name: Send receipt email
trigger:
  type: event
  eventType: order.paid
  filter:          # optional shallow-equality filter on payload
    currency: USD
nodes:
  - id: fetch-customer
    integration: postgres
    operation: query
    ...
```

When anyone emits `order.paid` with `payload.currency === "USD"`, the
runtime enqueues a new run for this workflow. The event's full record
(id, type, payload, source, correlationId, emittedAt) lands in
`run.triggerPayload.event` — your first node reads from there.

### 2. `step.waitForEvent(name, opts)`

Inside a workflow node, an integration handler can pause the run durably:

```typescript
// integration action — inside an OperationHandler
async function pollStripe3DS(input, ctx) {
  const paymentIntent = await stripe.paymentIntents.create(...);
  if (paymentIntent.status === "requires_action") {
    // Return the client_secret; pause until the customer finishes 3DS.
    const result = await ctx.step.waitForEvent("wait-3ds", {
      eventType: "stripe.3ds.completed",
      matchCorrelationId: paymentIntent.id,
      timeoutMs: 15 * 60 * 1000, // 15 min
    });
    return { confirmed: true, event: result.event };
  }
  return { confirmed: true };
}
```

What happens under the hood:

1. A row is inserted into `waiting_steps` with `(run_id, step_name,
   event_type, match_payload, match_correlation_id, expires_at)`.
2. The Executor returns `{ status: "waiting", waitingOn: { ... } }` to
   the server's `tick()` loop, which `queue.release()`s the run (no
   next_wakeup). The run sits in status=`pending` but won't be claimed
   unless something wakes it.
3. When a matching event arrives (via `POST /api/events` or another
   subsystem calling `dispatcher.emit()`), the dispatcher resolves the
   `waiting_steps` row (sets `resolved_at` + `resolved_event_id`) and
   releases the run, making it immediately re-claimable.
4. The executor claims the run, calls the integration handler again.
   This time, `ctx.step.waitForEvent("wait-3ds", ...)` finds a resolved
   row and returns `{ event: { id, type, payload, ... } }` without
   suspending.
5. If the deadline passes before an event arrives, `EventDispatcher.
   expireWaitingSteps()` (called from the tick loop) marks the row
   resolved with a sentinel id `__timeout__`. On replay, the handler
   sees the timeout and `step.waitForEvent` throws
   `WaitForEventTimeoutError`.

### Replay semantics (the critical guarantee)

`step.waitForEvent` is **replay-deterministic** the same way `step.run`
is. If the process crashes between suspension and resumption, a new
Executor instance reading the same SQLite file picks up exactly where
the first left off:

- Resolved row → returns the cached event payload. Same result each
  time.
- Timed-out row → throws the same `WaitForEventTimeoutError` each time.
- Still-pending row → suspends again (same `waiting_steps` row, same
  `expires_at`, no duplicate work).

Tested end-to-end in `packages/runtime/src/executor.test.ts` — the
`CRITICAL replay-across-restart` test opens a file-backed SQLite DB,
suspends in Executor A, fully drops A (including its in-process Map),
then spins up a new Executor B on the same file and verifies the
event wakes the run with the correct payload.

## Schema surface

All shapes live in `packages/core/src/event-schemas.ts`, re-exported
from `@chorus/core`:

```typescript
export const EventSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  payload: z.unknown().default({}),
  source: z.string().optional(),
  emittedAt: z.string().datetime(),
  correlationId: z.string().optional(),
});

export const EventTriggerSchema = z.object({
  type: z.literal("event"),
  eventType: z.string(),
  filter: z.record(z.unknown()).optional(),
});

export const WaitForEventCallSchema = z.object({
  eventType: z.string(),
  matchPayload: z.record(z.unknown()).optional(),
  matchCorrelationId: z.string().optional(),
  timeoutMs: z.number().int().positive().max(7*24*60*60*1000).default(60_000),
});
```

### `ExtendedTriggerSchema` — engine-side union

The existing `TriggerSchema` lives in `core/src/schemas.ts` and is
owned by a different agent track; we cannot mutate it. Instead, this
file exports **`ExtendedTriggerSchema`** which unions the three legacy
triggers with the new `EventTriggerSchema`. The runtime parses
workflows on load against `ExtendedTriggerSchema` internally; external
YAML authoring can use either schema and migrate opportunistically.

## Tables

Two new SQLite tables in `packages/runtime/src/db.ts`:

```sql
CREATE TABLE events (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  payload           TEXT NOT NULL,      -- JSON
  source            TEXT,
  emitted_at        TEXT NOT NULL,
  correlation_id    TEXT,
  consumed_by_run   TEXT                -- NULL = never routed (fan-out friendly)
);
CREATE INDEX idx_events_type_unconsumed ON events(type, consumed_by_run);
CREATE INDEX idx_events_correlation ON events(correlation_id);

CREATE TABLE waiting_steps (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  step_name             TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  match_payload         TEXT,           -- JSON or NULL
  match_correlation_id  TEXT,
  expires_at            TEXT NOT NULL,
  resolved_at           TEXT,           -- NULL = still waiting
  resolved_event_id     TEXT,           -- or TIMEOUT_EVENT_ID sentinel
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX idx_waiting_event_type ON waiting_steps(event_type, resolved_at);
CREATE INDEX idx_waiting_expires ON waiting_steps(expires_at, resolved_at);
CREATE UNIQUE INDEX idx_waiting_run_step ON waiting_steps(run_id, step_name);
```

Note `consumed_by_run`: we deliberately don't mark an event consumed
when fan-out takes place (500 workflows waiting for `job.done` each
get a match). The column exists for observability + future pruning.

## HTTP API

`POST /api/events` — emit. Body:

```json
{
  "type": "stripe.3ds.completed",
  "payload": { "outcome": "ok" },
  "source": "stripe-webhook",
  "correlationId": "pi_3abc"
}
```

Response `202 Accepted`:

```json
{
  "id": "...uuid...",
  "type": "stripe.3ds.completed",
  "emittedAt": "2026-04-15T12:34:56.789Z",
  "triggeredRunIds": [],
  "resolvedWaitingSteps": 1
}
```

`GET /api/events?type=&limit=` — recent events, newest first. Read-only.

`GET /api/events/waiting` — runs currently parked on a
`step.waitForEvent`, with their eventType + expiry. Useful for
dashboards.

Body limit: the Fastify server enforces `bodyLimit` (default 1MB
per ARCHITECTURE §4.2). POSTs exceeding the limit return `413`.

## CLI

```
chorus event fire <type> [--payload <json|@file>] [--correlation <id>] [--source <name>]
chorus event watch [<type>] [--limit N] [--json]
chorus event list-waiting [--json]
```

The CLI talks to the runtime over HTTP — no direct SQLite access.
Honors `CHORUS_API_TOKEN` + the server-config-derived base URL.

## Filter semantics

`EventTrigger.filter` and `WaitForEventCall.matchPayload` apply the
same rules:

- Empty / undefined filter → all events of the given type match.
- Each key must be **present in the payload** (so an object-typed
  payload is required for non-empty filters).
- If the filter value is `undefined`, only presence matters.
- For primitives: strict equality.
- For objects/arrays: JSON-string equality (deep, order-sensitive for
  arrays). Don't rely on this for large nested structures — it's
  designed for routing hints, not query-style matching.

## Safety invariants

- **Match functions are pure.** Users express matching declaratively
  (filter + correlationId). No closures, no async calls, no
  wall-clock reads. This keeps replay deterministic.
- **Timeouts are capped.** Max 7 days per
  `WaitForEventCallSchema.timeoutMs.max`. Past that, use a cron
  workflow instead.
- **Payloads are size-capped.** Fastify bodyLimit at
  ingress (1MB default). Events over the limit return 413.
- **Fan-out is bounded per-tick.** The dispatcher resolves up to
  N waiting steps in-process; cross-node pub-sub is v2.

## Cross-references

- Executor implementation: `packages/runtime/src/executor.ts`
- Dispatcher: `packages/runtime/src/triggers/event.ts`
- DB tables: `packages/runtime/src/db.ts` (`EventRow`, `WaitingStepRow`)
- API: `packages/runtime/src/api/events.ts`
- CLI: `packages/cli/src/commands/event.ts`
- Tests (critical-path replay): `packages/runtime/src/executor.test.ts`
  `Executor — step.waitForEvent (durable wait primitive)`
