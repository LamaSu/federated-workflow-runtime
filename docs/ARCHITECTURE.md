# Chorus Architecture

Version: 1.0.0-draft
Status: Implementation blueprint (drives Wave 3 parallel implementers)
Authors: Wave 2 synthesizer (synth-delta), informed by scout-alpha / scout-bravo / scout-charlie research
Date: 2026-04-13

This document is the implementer's bible. Five parallel engineers will each pick a section
and build it. They should not need to re-read the research reports in `docs/research/`
to understand what to ship. If you find yourself needing to open a research doc, that is
a defect in this document — open an issue.

**Reading order**:
1. Section 1 (Executive Summary) — 5 minutes, get the shape.
2. Section 2 (Core Concepts) — 15 minutes, absorb the data model.
3. Section 3 (System Architecture) — 10 minutes, trust boundaries.
4. Pick your section (4-9) — implementation detail.
5. Section 10 (Threat Model) + Section 11 (MVP scope) — read before merging PRs.

---

## 1. Executive Summary

### 1.1 The problem

Workflow automation tools (n8n, Zapier, Make, Pipedream) break constantly because the SaaS APIs
they integrate with change constantly. A typical mid-sized company has 200-400 integrations;
each has ~3 breaking changes per year. Someone has to notice, diagnose, patch, and roll out
the fix. That someone is usually a platform engineering team, or — in the case of hosted
services like Zapier — an internal integrations team of dozens.

For a solo developer or a 5-person team running their own automation on their own box,
this is untenable. Twenty integrations means ~60 breakages a year — one new fire every 6
days. The usual failure mode is "my Gmail integration stopped working and I didn't notice
for 3 weeks; now there are 800 unprocessed leads in a dead queue."

### 1.2 The insight

The failures are not unique. Every Chorus user running the Gmail OAuth integration will
hit the same breakage at roughly the same time, because Google changed the API for
everyone. If ONE user's repair agent can propose a fix, sign it, and publish it, then
the other 9,999 users can auto-adopt that fix — gated by a safety ladder — without any
of them having to notice or diagnose anything.

The user's pain becomes the fleet's immune system.

### 1.3 The solution

Chorus is a self-hosted workflow runtime with four paired properties:

1. **Runtime-resident integrations.** Each user runs the integration code locally. Credentials
   never leave the user's machine.
2. **Structured failure capture.** On any integration failure, Chorus extracts a stable
   error signature (like Sentry's fingerprint), strips PII, and reports it.
3. **Local AI repair.** An Anthropic-powered repair agent reads the error, fetches vendor
   docs, and proposes a code patch — validated against recorded HTTP cassettes before
   it ever runs in production.
4. **Federated signed patch registry.** Validated patches are signed (Sigstore + Ed25519)
   and published to a git-backed registry. Other users' runtimes discover them via
   signature hash match, verify signatures, and adopt through a 7-day canary ladder.

### 1.4 What we are NOT

- **Not another drag-and-drop flow builder.** Chorus is code-and-config-first. Flows live
  in a `chorus/` directory as JSON/TypeScript. The UI comes later; CLI ships first.
- **Not a hosted SaaS.** There is no Chorus cloud, only user machines + a public patch registry.
- **Not a replacement for Temporal / Inngest / Trigger.dev** at enterprise scale. Those are
  managed services for 10,000+ jobs/day. Chorus is for the user with 20 integrations and
  an n8n instance that breaks monthly.
- **Not an MCP surface for agents** (yet). Auto-MCP exposure per integration is v2; see
  Section 11.

### 1.5 The moat

Every integration failure, once signatured and redacted, becomes a permanent regression
test owned by the registry. Two years in, Chorus will have 100k+ cassettes covering edge
cases that no integration vendor documents. That corpus is the moat. Forking the code is
easy; rebuilding the cassette library from scratch is not.

### 1.6 v1 scope

MVP = end-to-end flow for ONE user on ONE machine, plus basic federation with ONE public
registry. Explicitly included:

- Workflow runtime (webhook + cron triggers, SQLite state, per-step retry)
- Durable execution (step.run / step.sleep via replay)
- Integration SDK + 2 reference integrations (http-generic, slack-send)
- Credential store with AES-256-GCM encryption
- Failure reporter with redaction + signature extraction
- Claude-powered repair agent (one-shot patch proposal)
- Signed patch registry (Sigstore primary + Ed25519 fallback)
- 7-day canary ladder with automatic rollout
- Revocation fast-path (signed kill list, 5-min poll)
- CLI (init, run, report, patch)

Explicitly deferred (see Section 11): drag-drop UI, auto-MCP per integration, Postgres
backend, nsjail sandbox, differential testing as a gate, human-in-the-loop review UI.

---

## 2. Core Concepts & Data Model

Chorus has eight first-class entities. Each is backed by a Zod schema in
`packages/core/src/schemas.ts`; the runtime, registry, reporter, and CLI agree on these
as the wire format.

### 2.1 Action

An **Action** is the atomic unit of work. It is a named, versioned operation belonging to
an integration — for example, `slack-send.postMessage`, `stripe.createCharge`,
`http-generic.request`. An Action:

- Declares an `inputSchema` (Zod) and an `outputSchema` (Zod).
- Has an `idempotent: boolean` hint so the runtime knows whether retry is safe.
- Exposes an `authType` indicating which credential kind it needs.
- Is implemented as a JavaScript/TypeScript function with signature
  `(input, ctx) => Promise<output>`.

Both triggers and steps in a workflow call Actions. Triggers are a subtype: an Action that
produces events to feed the runtime. Keeping the word "Action" unified (not splitting
Action vs Trigger) matches Pipedream's Component model and simplifies SDK surface.

### 2.2 Workflow

A **Workflow** is a directed graph of nodes (each referencing an Action) + connections +
a trigger. It is defined declaratively in a `flow.json` or `flow.ts` file. Versioned.
Immutable after publish — editing creates a new version. Workflow JSON is OpenFlow-compatible
(Windmill's public spec), with Chorus extensions for step-level durability.

A Workflow defines:
- A trigger (one of four types — Section 2.4)
- A list of nodes (each is a concrete Action invocation with bound inputs)
- Connections (edges) between nodes
- Optional `failure_module` (runs on terminal failure)
- Optional input schema for parameters

### 2.3 Run

A **Run** is one execution of one Workflow from one trigger event. It has:

- A unique ID (UUID v7, time-ordered for cheap sorting)
- A workflow ID + version
- A status: `pending | running | success | failed | cancelled`
- A `triggerPayload` (the event that started it)
- A list of `NodeResult` entries, one per step, including `attempt` counter for retries
- Memoized step outputs — so replay finds them without re-executing

The Run is the unit of durability. On crash/restart, the runtime re-reads the Run row,
discovers the latest completed step, and resumes from there via replay (Inngest model,
not CRIU).

### 2.4 Trigger

A **Trigger** fires Runs. Four trigger types (explicit, not inferred):

| Type | Source | Mechanism |
|---|---|---|
| `webhook` | Inbound HTTP | Fastify route, path-unique token |
| `cron` | Time | node-cron expression, main-instance scheduler |
| `poll` | External API | Per-workflow persistent cursor, periodic Action call |
| `event` | Internal/external bus | Published event name match (v1.1 — not MVP) |

MVP ships `webhook`, `cron`, and `manual` (user-invoked one-shot). `poll` and `event`
triggers are v1.1 (see Section 11).

### 2.5 ErrorSignature

An **ErrorSignature** is the stable hash of a specific failure mode. It is Sentry's
fingerprinting concept, adapted:

- Normalize the stack trace (in-app frames only, hash suffixes stripped)
- Normalize the error message (numbers → {n}, UUIDs → {uuid}, etc.)
- Combine with integration, operation, error class, HTTP status, adapter version
- SHA-256 the canonical JSON of that tuple → 64-char hex string

Two different runs that hit the same vendor-side bug will produce the same signature hash.
The registry uses signature hash as the primary key for failure reports and as the lookup
key for existing patches.

### 2.6 Patch

A **Patch** is a proposed or accepted integration fix. It contains:

- A unique ID + a human-readable title
- The `errorSignatureHash` it targets
- The `integration` it modifies + before/after semver version
- The diff (unified-diff text or full file content)
- Cassette updates (HTTP recordings the patch now expects to pass)
- The canary stage it has reached
- Provenance: SLSA attestation + Sigstore bundle + optional Ed25519 signature
- Author metadata: OIDC identity, reputation, timestamp

See Section 5.2 for the full manifest JSON.

### 2.7 Credential

A **Credential** is a user's authentication material for an integration. Stored encrypted
with AES-256-GCM; key comes from `CHORUS_ENCRYPTION_KEY` env var (never persisted).

Types: `apiKey`, `oauth2`, `basic`, `bearer`. OAuth2 credentials carry additional fields:
access token expiry, refresh token, scopes. The runtime auto-refreshes OAuth2 credentials
via a dedicated scheduled job (**not** on-failure — refresh-on-failure races against
retries and masks real bugs).

**Credentials NEVER leave the user's machine.** The reporter explicitly strips all
credential material from error reports. The registry rejects any report that looks like
it contains a credential pattern (see Section 6.2).

### 2.8 Cassette

A **Cassette** is a recorded HTTP interaction, redacted, indexed by error signature hash.
Cassettes serve two purposes:

1. **Local validation**: when a patch proposal arrives, replay the cassette through the
   patched code; if the response still matches, the patch is accepted for local adoption.
2. **Registry testing**: the registry runs proposed patches against the cassette library
   in sandbox; patches that regress existing cassettes are rejected.

Cassette format is a Chorus-native JSON schema (not HAR), because HAR carries too much
noise. See Section 6 for the schema.

---

## 3. System Architecture

### 3.1 Component diagram

```
                 ┌─────────────────────────────────────────────────────────────┐
                 │                    USER'S MACHINE                            │
                 │                                                              │
   webhook ──────┼──► Fastify listener ──► Trigger Router ──► enqueue          │
   cron  ────────┼──► node-cron scheduler ─┘                     │             │
   manual ───────┼──► CLI `chorus run <flow>`                    │             │
                 │                                                ▼             │
                 │                                      ┌────────────────┐     │
                 │                                      │ SQLite queue    │     │
                 │                                      │ (runs, steps,   │     │
                 │                                      │  triggers,      │     │
                 │                                      │  credentials)   │     │
                 │                                      └───────┬────────┘     │
                 │                                              │              │
                 │                 ┌────────────────────────────┴────┐         │
                 │                 ▼                                 ▼         │
                 │       ┌─────────────────┐              ┌───────────────┐   │
                 │       │ Executor (node) │              │ Credentials   │   │
                 │       │ per-run subprc ├──► decrypt──►│ store (AES-GCM)│   │
                 │       └────────┬────────┘              └───────────────┘   │
                 │                │                                            │
                 │                ▼                                            │
                 │       ┌─────────────────┐                                   │
                 │       │  Integration    │ ───────► external SaaS API        │
                 │       │  (Action fn)    │           (Stripe, Slack, etc.)   │
                 │       └────────┬────────┘                                   │
                 │                │                                            │
                 │       (on failure)                                          │
                 │                ▼                                            │
                 │       ┌─────────────────┐                                   │
                 │       │    Reporter     │                                   │
                 │       │ (signature +   │                                   │
                 │       │   redaction)    │                                   │
                 │       └────────┬────────┘                                   │
                 │                │                                            │
                 │                ▼                                            │
                 │       ┌─────────────────┐       ┌────────────────┐         │
                 │       │  Repair Agent   │ ─────►│ Claude API     │         │
                 │       │ (local)         │       │ (Anthropic)    │         │
                 │       └────────┬────────┘       └────────────────┘         │
                 │                │                                            │
                 │      (patch proposal +                                      │
                 │       cassette validation)                                  │
                 └────────────────┼────────────────────────────────────────────┘
                                  │
                         sign bundle (user OIDC / Ed25519 fallback)
                                  │
                                  ▼
                 ┌───────────────────────────────────────────────────────┐
                 │              SHARED PATCH REGISTRY                     │
                 │                                                        │
                 │    GitHub repo: github.com/chorus/patches             │
                 │      ├── integrations/slack-send/                     │
                 │      │    ├── patches/                                │
                 │      │    │    └── <patch-id>.json                    │
                 │      │    └── cassettes/                              │
                 │      │         └── <sig-hash>.cassette.json           │
                 │                                                        │
                 │    CDN:  patches.chorus.dev/v1/<patch-id>.tar.gz      │
                 │                                                        │
                 │    Sigstore Rekor: transparency log                   │
                 │                                                        │
                 │    Revocation list: patches.chorus.dev/revoked.json   │
                 │         signed, TTL 5 min                              │
                 └────────────────────────┬──────────────────────────────┘
                                          │
                                          ▼
                                (other users poll, verify,
                                 adopt via canary ladder)
```

### 3.2 Data flow: happy path

```
1. Webhook hits Fastify listener
   POST /hooks/abc123  →  Trigger Router

2. Trigger Router looks up trigger by path+token, loads Workflow,
   inserts row into `runs` table with status=pending, triggerPayload=<body>

3. Executor loop polls `runs` where status=pending ORDER BY id LIMIT 1
   UPDATE...WHERE id=... returning row (SKIP LOCKED emulated via single-executor in MVP)

4. For each node in topological order:
   a. Check `steps` table for (run_id, node_id) — if completed, skip (memoized)
   b. Load credentials by integration+name, decrypt
   c. Spawn subprocess: node -e 'import(...).then(run)'
      Pass input via stdin, receive output via stdout (JSON)
   d. On success: INSERT INTO steps (run_id, node_id, output, status=success)
   e. On failure: see Section 3.3

5. When all nodes complete: UPDATE runs SET status=success, finishedAt=now

6. If webhook trigger: Fastify responds 200 with run_id
```

### 3.3 Data flow: failure-to-repair

```
1. Action throws. Executor catches:
   try { await handler(input, ctx) }
   catch (err) {
     const sig = extractErrorSignature(err, { integration, operation, adapterVersion })
     const redacted = redactEvent({ sig, input, response: err.response })
     await reporter.submit(redacted)       // fire-and-forget, local queue
     await recordStep(run, node, { status: 'failed', error: err.message })
     if (retryable(err) && attempt < maxAttempts) { schedule retry }
     else { UPDATE runs SET status=failed }
   }

2. Reporter queues report locally (offline-tolerant).
   Eventually POSTs to registry: POST https://registry.chorus.dev/reports
   Registry groups by signatureHash, increments occurrence counter.

3. If NO existing patch exists for this signatureHash:
   Registry emits event `failure.new-signature`.
   Any Chorus node with `repair-agent.autoAttempt: true` subscribes and:
     a. Fetch the failure context (sig + shape + cassette if present)
     b. Spawn local Claude SDK call with context
     c. Receive patch proposal (diff + test cassette update)
     d. Validate LOCALLY: run `repair-agent.validate(patch, cassettes)`
        - re-run the failing cassette against patched code
        - ensure existing cassettes still pass
     e. If valid: sign + submit as PATCH PROPOSAL (goes to canary-1 ring)

4. If EXISTING patch at stage `canary-100` or `fleet`:
   Runtime's patch-fetcher (polls every 5 min) downloads bundle, verifies signature,
   checks if node falls in rollout cohort (hash(machine_id + patch_id) mod 10000),
   applies patch locally (swaps integration version), runs local cassette validation
   as a smoke test, on success retries the failed Run.
```

### 3.4 Trust boundaries

Five hard lines in the system:

1. **User machine vs external APIs.** Credentials decrypted only in the subprocess,
   destroyed when the process exits. No credential material in workflow JSON. Ever.

2. **User machine vs registry.** The registry receives SIGNATURES (hashes + shapes + error
   classes), never payloads. The Reporter is the gate — fail-closed: if validation against
   `SafeEventSchema.strict()` fails, drop the event rather than leak.

3. **Registry vs patch consumer.** Consumers verify Sigstore signatures + (optional) Ed25519
   fallback before executing patch code. Patches reach consumers ONLY via canary ladder.

4. **Consumer vs patched code.** A patch modifies an integration's `dist/` files. It is
   loaded into a subprocess (per-Run isolation) — not the main runtime. A malicious patch
   cannot escape to the scheduler or credential store.

5. **Registry vs maintainer.** Signing keys (for release promotion and revocation) live
   in GitHub Actions workload identity, not on maintainer laptops. Rekor logs every
   signing event; maintainer identity misuse is publicly detectable.

---

## 4. Runtime (@delightfulchorus/runtime)

The runtime is the single largest package. It owns the queue, executor, trigger system,
credential store, and durable-execution SDK.

### 4.1 Queue & executor

**Queue backend: SQLite (better-sqlite3) with single-writer discipline.**

Rationale: SQLite with a single writer thread + readers is sufficient for <100 runs/sec,
which is comfortably above target-user throughput. We cannot use `UPDATE ... SKIP LOCKED`
(not supported in SQLite), but we emulate by:

- Main executor acquires a `BEGIN IMMEDIATE` transaction
- Selects oldest pending run
- Updates to status=running
- Commits
- Executes outside the transaction

For v2 at 10k runs/sec or multi-node, Postgres migration is documented in Section 11.

Table: see Section 4.5.

**Executor model: one Node.js subprocess per Run.**

```typescript
// Simplified pseudo-code in @delightfulchorus/runtime
async function executorLoop() {
  while (!shuttingDown) {
    const run = await claimNextRun();           // SQLite BEGIN IMMEDIATE
    if (!run) { await sleep(100); continue; }
    runInSubprocess(run);                        // not awaited — parallelism
  }
}

function runInSubprocess(run: Run) {
  const child = spawn('node', [
    require.resolve('./worker.js'),
    '--run-id', run.id,
  ], {
    env: {
      ...minimalEnv,                              // PATH, NODE_PATH only
      CHORUS_ENCRYPTION_KEY: process.env.CHORUS_ENCRYPTION_KEY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', handleStepUpdate);     // JSON lines protocol
  child.on('exit', finalizeRun);
}
```

### 4.2 Trigger system

Three MVP trigger types, each implemented in `@delightfulchorus/runtime/src/triggers/`:

**webhook**: Fastify route registered at runtime startup. Path shape:
`POST /hooks/:workflow_id/:token` where token is a per-workflow random string stored
in the triggers table. Fastify body parser caps at 1MB (configurable). Signature
validation (HMAC) supported via `secret` field.

**cron**: One `node-cron` scheduler instance in the main process. On workflow activation,
add a cron entry; on deactivation, remove. Cron callback inserts a run row and returns —
does NOT execute inline.

**manual**: CLI-initiated: `chorus run <workflow-id> [--input=payload.json]`. Inserts a
run row and (optionally) tails its status.

### 4.3 Durable execution (step.run, replay)

Inngest-style. The runtime exports a `step` object to every action:

```typescript
// Available inside any Action via ctx.step
ctx.step.run(name, fn)           // memoize by name; exec once, replay after
ctx.step.sleep(name, duration)   // non-compute wait; scheduler resumes
ctx.step.waitForEvent(name, opts) // pause on internal event (v1.1)
```

**How replay works:**

On every attempt of a workflow, the runtime re-invokes the Action's entry function.
Inside the function, each `step.run("fetchUser", ...)` call:

1. Checks `steps` table for `(run_id, step_name)`
2. If completed → returns cached output immediately, no execution
3. If not completed → executes the fn, writes output to `steps`, returns result

`step.sleep` is special: when invoked, it throws a `StepFlowControlError`. The worker
catches this, updates `runs.nextWakeup = now + duration`, and exits the subprocess.
When `nextWakeup <= now` the executor re-claims the run and re-invokes the function.
All previously completed steps memoize; the sleep step sees its wakeup-time has passed
and returns.

**Determinism constraint:** step names MUST be unique within a run. Best practice:
literal strings, not template-interpolated. The runtime logs a warning if it sees
duplicate step names.

### 4.4 Sandbox isolation

**MVP: per-Run subprocess. Windows-compatible, zero native deps.**

The Run's worker is a fresh Node subprocess. It inherits ONLY:
- `PATH` (to find node/npm)
- `NODE_PATH` (to load integrations)
- `CHORUS_ENCRYPTION_KEY` (one-shot, erased after credential decrypt)

The subprocess has NO access to the main runtime's memory, credentials from other runs,
or the SQLite file handle. It communicates via stdin/stdout JSON lines.

**v2: nsjail on Linux.** Same subprocess model, wrapped in nsjail for filesystem +
PID namespace isolation. Documented in Section 11.

### 4.5 SQLite schema

```sql
-- Workflows (definitions)
CREATE TABLE IF NOT EXISTS workflows (
  id            TEXT PRIMARY KEY,          -- UUID v7
  version       INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  definition    TEXT NOT NULL,              -- JSON (WorkflowSchema)
  active        INTEGER NOT NULL DEFAULT 1, -- boolean 0/1
  created_at    TEXT NOT NULL,              -- ISO 8601
  updated_at    TEXT NOT NULL,
  UNIQUE(id, version)
);

-- Triggers (registered endpoints / schedules)
CREATE TABLE IF NOT EXISTS triggers (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  type          TEXT NOT NULL,              -- 'webhook'|'cron'|'manual'
  config        TEXT NOT NULL,              -- JSON (TriggerSchema specific)
  webhook_path  TEXT UNIQUE,                -- only for webhook triggers
  cron_expr     TEXT,                       -- only for cron triggers
  state         TEXT DEFAULT '{}',          -- JSON, e.g., last-polled cursor
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_triggers_workflow ON triggers(workflow_id);

-- Runs (execution instances)
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,         -- UUID v7
  workflow_id     TEXT NOT NULL REFERENCES workflows(id),
  workflow_version INTEGER NOT NULL,
  status          TEXT NOT NULL,            -- pending|running|success|failed|cancelled
  triggered_by    TEXT NOT NULL,            -- webhook|cron|manual
  trigger_payload TEXT,                     -- JSON, event body
  next_wakeup     TEXT,                     -- ISO timestamp (for sleeping runs)
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT,                     -- terminal error message
  attempt         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_runs_pending ON runs(status, started_at);
CREATE INDEX idx_runs_wakeup  ON runs(status, next_wakeup) WHERE status='running';

-- Steps (per-node memoized execution records)
CREATE TABLE IF NOT EXISTS steps (
  run_id        TEXT NOT NULL REFERENCES runs(id),
  step_name     TEXT NOT NULL,              -- deterministic step name
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL,              -- pending|running|success|failed
  input         TEXT,                       -- JSON
  output        TEXT,                       -- JSON (memoized)
  error         TEXT,                       -- error message
  error_sig_hash TEXT,                      -- FK to error_signatures
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  PRIMARY KEY (run_id, step_name)
);

-- Credentials (AES-256-GCM encrypted)
CREATE TABLE IF NOT EXISTS credentials (
  id                    TEXT PRIMARY KEY,
  integration           TEXT NOT NULL,
  type                  TEXT NOT NULL,       -- apiKey|oauth2|basic|bearer
  name                  TEXT NOT NULL,       -- user-assigned label
  encrypted_payload     BLOB NOT NULL,       -- ciphertext (IV || tag || data)
  oauth_access_expires  TEXT,                -- null for non-oauth
  oauth_refresh_expires TEXT,
  oauth_scopes          TEXT,                -- JSON array
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(integration, name)
);
CREATE INDEX idx_credentials_integration ON credentials(integration);
CREATE INDEX idx_oauth_expiring ON credentials(oauth_access_expires) WHERE type='oauth2';

-- Error signatures (local cache before reporting)
CREATE TABLE IF NOT EXISTS error_signatures (
  hash           TEXT PRIMARY KEY,           -- SHA-256 hex
  integration    TEXT NOT NULL,
  operation      TEXT NOT NULL,
  error_class    TEXT NOT NULL,
  http_status    INTEGER,
  stack_fp       TEXT NOT NULL,
  message_pat    TEXT NOT NULL,
  components     TEXT NOT NULL,              -- full components JSON
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  occurrences    INTEGER NOT NULL DEFAULT 1,
  reported       INTEGER NOT NULL DEFAULT 0  -- 0=unreported, 1=submitted
);
CREATE INDEX idx_sigs_unreported ON error_signatures(reported, last_seen);

-- Cassettes (recorded HTTP interactions for validation)
CREATE TABLE IF NOT EXISTS cassettes (
  id              TEXT PRIMARY KEY,
  signature_hash  TEXT NOT NULL REFERENCES error_signatures(hash),
  integration     TEXT NOT NULL,
  payload         TEXT NOT NULL,              -- JSON (CassetteEntrySchema)
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_cassettes_sig ON cassettes(signature_hash);

-- Patches (locally cached; downloaded from registry)
CREATE TABLE IF NOT EXISTS patches (
  id                TEXT PRIMARY KEY,
  integration       TEXT NOT NULL,
  signature_hash    TEXT NOT NULL,
  version           TEXT NOT NULL,            -- after_version in manifest
  state             TEXT NOT NULL,            -- discovered|validated|applied|rolled_back|revoked
  manifest          TEXT NOT NULL,            -- JSON (PatchManifestSchema)
  sigstore_bundle   BLOB,
  ed25519_sig       BLOB,
  applied_at        TEXT,
  rolled_back_at    TEXT
);
CREATE INDEX idx_patches_sig ON patches(signature_hash);
CREATE INDEX idx_patches_applied ON patches(state);

-- Events (internal bus — v1.1 for waitForEvent)
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_name ON events(name, created_at);
```

### 4.6 Credential storage

**Algorithm: AES-256-GCM.** Key material from `process.env.CHORUS_ENCRYPTION_KEY`
(32 bytes, base64). Fail-fast on boot if missing — the runtime refuses to start without it.

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function encryptCredential(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);   // 12 + 16 + N bytes
}

export function decryptCredential(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

Decryption happens ONLY inside the per-Run subprocess. The decrypted credential lives
in memory for the duration of the Action call, then goes out of scope. No credential
is ever written to disk in plaintext, passed on the command line, or logged.

### 4.7 Retry & backoff

Per-step retry policy (not per-workflow). Default:

```typescript
{
  maxAttempts: 3,
  backoffMs: 1000,
  jitter: true,      // ±20%
  multiplier: 2,     // exponential
  retryableErrorCodes: ['RATE_LIMIT', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
}
```

Retry delay = `backoffMs * (multiplier ^ (attempt-1)) * (1 ± jitter)`, clamped to
`min(result, 5 minutes)`.

**Rate-limit handling:** When an Action throws `RateLimitError` with `retryAfterMs`,
the runtime uses that value directly (no backoff multiplier) — respecting the vendor's
hint. If no hint, fall back to exponential.

**Circuit breaker:** If a workflow has 5 consecutive failed runs in the last hour, new
runs are rejected at trigger time with error `CIRCUIT_OPEN`. Reset after 30 min of no
failures, or via CLI `chorus circuit reset <workflow-id>`.

### 4.8 OAuth token refresh

**Design: scheduled background job, not failure-driven.**

Why: refresh-on-failure races against retries, causing duplicated refresh attempts
(and, for providers that rotate refresh tokens on use, credential corruption). Instead:

```typescript
// Runs every 5 minutes
async function oauthRefreshJob() {
  const expiring = db.prepare(`
    SELECT * FROM credentials
    WHERE type = 'oauth2'
      AND oauth_access_expires IS NOT NULL
      AND datetime(oauth_access_expires) < datetime('now', '+10 minutes')
  `).all();

  for (const cred of expiring) {
    try {
      await refreshOAuthToken(cred);
    } catch (err) {
      if (err.code === 'REFRESH_FAILED') {
        markCredentialInvalid(cred.id, err.message);
        emitCredentialHealthAlert(cred);
      }
    }
  }
}
```

On refresh failure, credential state = `invalid`. Workflows depending on it fail with
clear "credential invalid: reauthorize" message. No silent retries; make the user act.

---

## 5. Registry (@delightfulchorus/registry)

The registry is the federated trust boundary. It is the ONLY component not running on
the user's machine.

### 5.1 Git-repo-as-registry layout

**Source of truth: `github.com/chorus/patches` (public git repo).**

```
github.com/chorus/patches/
├── README.md
├── revoked.json                          # signed kill list
├── integrations/
│   ├── slack-send/
│   │   ├── manifest.json                 # integration metadata
│   │   ├── patches/
│   │   │   ├── 2026-04-10_oauth_refresh_a1b2c3d4.json
│   │   │   └── 2026-04-12_rate_limit_header_e5f6g7h8.json
│   │   └── cassettes/
│   │       ├── sig-abc123.cassette.json
│   │       └── sig-def456.cassette.json
│   ├── http-generic/
│   │   └── patches/...
│   └── (more integrations...)
└── .github/
    └── workflows/
        └── publish-patch.yml              # Trusted publisher workflow
```

Distribution mirror: `patches.chorus.dev/v1/` (CDN) serves:
- `<patch-id>.tar.gz` (patch content)
- `<patch-id>.sigstore.json` (signature bundle)
- `manifest.json` (top-level: all known patches, rollout percentages)
- `revoked.json` (signed, 5-min TTL)

Consumers POLL `manifest.json` + `revoked.json` every 5 min. Signature verification
occurs locally; CDN trust is minimal (content-addressed via hashes in the signed manifest).

### 5.2 Patch manifest JSON

Every patch on disk in the git repo has a manifest with this exact shape:

```json
{
  "$schema": "https://chorus.dev/schemas/patch-manifest-v1.json",
  "schemaVersion": "1.0.0",
  "id": "slack-send_oauth-refresh-race_a1b2c3d4",
  "integration": "slack-send",
  "version": {
    "before": "1.4.2",
    "after": "1.4.3"
  },
  "subject": {
    "errorSignatureHash": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
    "title": "Fix OAuth token refresh race when two requests coincide",
    "description": "When two concurrent requests both observe an expired access token, both attempt refresh. The second request's refresh invalidates the first request's new token, causing a subsequent 401. Solution: serialize refresh via mutex keyed on credential ID.",
    "issueRef": "https://github.com/chorus/patches/issues/123"
  },
  "content": {
    "diff": "--- a/integrations/slack-send/src/client.ts\n+++ b/integrations/slack-send/src/client.ts\n@@ -42,7 +42,9 @@\n ...",
    "contentHash": "sha256:f3e8c7a1b2d4e5f6789012345678901234567890abcdef1234567890abcdef12",
    "sizeBytes": 4821,
    "cassetteUpdates": [
      {
        "signatureHash": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
        "cassettePath": "cassettes/sig-a1b2c3d4.cassette.json",
        "contentHash": "sha256:dead1234..."
      }
    ]
  },
  "rollout": {
    "stage": "canary-10",
    "currentPercentage": 10.0,
    "ladder": [1, 2, 5, 10, 20, 50, 100],
    "ladderDwellHours": [4, 8, 12, 24, 24, 24],
    "startedAt": "2026-04-13T01:00:00Z",
    "lastAdvancedAt": "2026-04-13T13:00:00Z",
    "paused": false,
    "expedited": false
  },
  "provenance": {
    "slsaLevel": 2,
    "builder": "github.com/actions/runner",
    "sourceCommit": "abc123def456789012345678901234567890abcd",
    "sourceRepo": "github.com/chorus/patches",
    "dependenciesAdded": [],
    "dependenciesRemoved": [],
    "dependenciesChanged": []
  },
  "author": {
    "oidcIdentity": "chorus-bot@chorus.dev",
    "oidcIssuer": "https://token.actions.githubusercontent.com",
    "reputation": 2450,
    "humanAuthor": "alice@chorus.dev"
  },
  "signing": {
    "primary": "sigstore",
    "sigstoreBundle": "patches.chorus.dev/v1/slack-send_oauth-refresh-race_a1b2c3d4.sigstore.json",
    "certIdentity": "chorus-bot@chorus.dev",
    "certOidcIssuer": "https://token.actions.githubusercontent.com",
    "workflowPath": "github.com/chorus/chorus/.github/workflows/publish-patch.yml@refs/heads/main",
    "rekorLogIndex": 49384827,
    "fallbackEd25519PublicKey": null,
    "fallbackEd25519Signature": null
  },
  "verification": {
    "downloadUrl": "https://patches.chorus.dev/v1/slack-send_oauth-refresh-race_a1b2c3d4.tar.gz",
    "bundleUrl": "https://patches.chorus.dev/v1/slack-send_oauth-refresh-race_a1b2c3d4.sigstore.json"
  },
  "createdAt": "2026-04-13T00:15:00Z",
  "advancedAt": {
    "proposed": "2026-04-13T00:15:00Z",
    "static-passed": "2026-04-13T00:17:22Z",
    "sandbox-passed": "2026-04-13T00:20:11Z",
    "canary-1": "2026-04-13T01:00:00Z",
    "canary-10": "2026-04-13T13:00:00Z"
  }
}
```

### 5.3 Signing

**Primary: Sigstore keyless via GitHub Actions trusted publisher.**

Publish workflow (`.github/workflows/publish-patch.yml`) generates an ephemeral keypair,
requests an OIDC token from GitHub's token service, sends (token + ephemeral pubkey) to
Fulcio (Sigstore CA), receives a 10-minute cert binding the key to
`github.com/chorus/chorus/.github/workflows/publish-patch.yml@refs/heads/main`, signs
the patch tarball hash with the ephemeral key, publishes to Rekor (transparency log),
bundles everything into a `.sigstore.json` file, destroys the key. Trusted publisher
fields (exact-match, case-sensitive): repo = `chorus/chorus`, workflow filename =
`publish-patch.yml`, branch ref = `refs/heads/main`.

Clients verify with cosign:

```bash
cosign verify-blob \
  --bundle patch.sigstore.json \
  --certificate-identity="chorus-bot@chorus.dev" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  --certificate-github-workflow-ref="refs/heads/main" \
  --certificate-github-workflow-repository="chorus/chorus" \
  patch.tar.gz
```

**Fallback: Ed25519 per-contributor keys.** Used for:
- Self-hosted enterprise deployments (no GitHub OIDC)
- Air-gapped federation
- Non-GitHub contributors (GitLab CI, etc.)

Keys managed via `@noble/ed25519` (pure JS, no native deps). Contributors register their
public keys in the user's `~/.chorus/trusted-keys.json`; patches signed with those keys
are accepted as fallback if sigstore verification is unavailable or disabled.

Manifest `signing.fallbackEd25519PublicKey` and `signing.fallbackEd25519Signature` are
always populated (both signing paths run in parallel); consumers can prefer either.

### 5.4 Canary ladder

**Default (7-day ladder, mirrors iOS):**

| Stage | % fleet | Dwell | Abort threshold (error rate vs baseline) |
|---|---|---|---|
| 1 | 1% | 4 h | > 2.0× |
| 2 | 2% | 8 h | > 1.5× |
| 3 | 5% | 12 h | > 1.3× |
| 4 | 10% | 24 h | > 1.2× |
| 5 | 20% | 24 h | > 1.2× |
| 6 | 50% | 24 h | > 1.1× |
| 7 | 100% | — | ongoing monitor |

Total: ~5 days to full fleet.

**Expedited (security hotfix, 4-hour ladder):**

| Stage | % fleet | Dwell |
|---|---|---|
| 1 | 1% | 30 min |
| 2 | 10% | 1 h |
| 3 | 50% | 2 h |
| 4 | 100% | — |

Note: even expedited patches go through the 1% ring. No "ship to everyone now" option.

**Cohort assignment (stable per user):**

```typescript
function isInCohort(machineId: string, patchId: string, rolloutPct: number): boolean {
  const hash = sha256(`${machineId}::${patchId}`);
  const bucket = parseInt(hash.slice(0, 4), 16) % 10000;  // 0-9999
  return bucket < rolloutPct * 100;
}
```

Once a user is in a canary, they stay in for that patch. No reshuffling on ladder advance.

### 5.5 Reputation ladder

Starting rep: 0 (unknown contributor).

| Event | Δ rep |
|---|---|
| Patch merged after review | +50 |
| Patch survives canary without abort | +100 |
| Patch reaches 100% fleet without revoke | +100 |
| Upvote on patch (capped 50/day/contributor) | +5 |
| Patch revoked (bug) | −50 |
| Patch revoked (security issue) | −500 |
| Patch caused production incident | −1000 |

Monthly inactivity decay: −10/month.

**Privilege thresholds:**

| Rep | Privilege |
|---|---|
| 0 | Submit patch → human review queue |
| 100 | Auto-approve to dev ring |
| 1000 | Auto-approve to canary-1 |
| 5000 + 2-maintainer approval | Auto-approve to canary-10 |
| 10000 + 2-maintainer approval | Direct publish (still starts at canary-1, faster advance) |

**Override: ALL patches touching auth/secrets/network modules require 2-maintainer approval
regardless of reputation.** This is non-negotiable.

### 5.6 Revocation fast-path

```
t=0      Maintainer / automated signal triggers revocation
t+1s     PR to patches repo: revoked.json updated with new entry, signed
t+1s     CI merges + deploys new revoked.json to patches.chorus.dev/revoked.json
t+5min   At most 5 minutes later, every polling client has the new list
t+5min+  Clients uninstall revoked patch, roll back to previous integration version
```

`revoked.json` shape:

```json
{
  "schemaVersion": "1.0.0",
  "asOf": "2026-04-13T12:34:56Z",
  "revoked": [
    {
      "patchId": "slack-send_oauth-refresh-race_a1b2c3d4",
      "reason": "bug: second refresh invalidates first",
      "severity": "high",
      "revokedAt": "2026-04-13T12:34:56Z"
    }
  ],
  "signature": "<sigstore bundle or ed25519 sig>",
  "rekorLogIndex": 49384900
}
```

Clients poll on every integration run + every 5 min unconditionally. On new revocation:
- Immediately uninstall (swap back to pre-patch integration version)
- Emit telemetry: `revocation.acknowledged{patchId, delayMs}`
- Log user-visible notification

**Publishing a revocation IS a signing event.** Attacker cannot use revocation as a DoS
vector without stealing the signing workflow — the same threshold as publishing a patch.

---

## 6. Reporter (@delightfulchorus/reporter)

The reporter runs in the user's runtime. It catches failures, computes signatures,
redacts PII, and submits to the registry.

### 6.1 Error signature extraction

See Section 2.5 for the concept. Concrete algorithm lives in `packages/core/src/signature.ts`
(already present — implementers should refine, not rewrite). Hierarchical fallback:

1. If a stack trace exists with in-app frames → use those as primary fingerprint.
2. Else use error class + HTTP status + message template.
3. Else use message template alone (last resort).

Normalize every input through:
- `stabilizePath`: UUIDs → `{uuid}`, long hashes → `{hash}`, long numbers → `{n}`
- `stabilizeMessage`: same + strip quoted values + clamp to 500 chars
- `fingerprintStack`: top 5 in-app frames, strip `:line:col`, SHA-256 first 16 hex chars

Final hash = SHA-256 of canonical JSON (keys sorted, no whitespace) of the normalized tuple.

### 6.2 Redaction pipeline

**Three-stage defense (Sentry/OWASP model, allowlist-first):**

**Stage 1 — SDK beforeEmit hook (in the reporter itself):**

1. Build a candidate event (signature + context + config fingerprint).
2. Validate against `SafeEventSchema.strict()` — rejects any unknown keys.
3. Run string fields through `redactString()` regex sweep (9 patterns: email, cc, phone,
   jwt, sk_*, Bearer, ipv4, SSN, aws_key).
4. Extract SHAPE of request/response bodies, never values.
5. Fail-closed: if any validation fails, DROP the event (log locally, don't emit).

**Stage 2 — Registry ingestion:**

1. Re-validate against same schema (trust nothing coming off the wire).
2. Second redaction pass with server-side-updatable regex list (so new patterns can be
   added without updating every client).
3. Reject events where response/request bodies look like raw payloads.

**Stage 3 — Storage:**

1. At-rest encryption.
2. Per-reporter pseudonymized ID (SHA-256 of project ID + salt).
3. Access audit trail on any re-identification query.

Concrete Zod schemas:

```typescript
import { z } from "zod";

// The signature itself (already in packages/core/src/schemas.ts — refined here)
export const ErrorSignatureSchema = z.object({
  schemaVersion: z.literal(1),
  integration: z.string().regex(/^[a-z0-9-]+$/),
  operation: z.string(),
  errorClass: z.string(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  httpStatusText: z.string().optional(),
  apiVersion: z.string().optional(),
  stackFingerprint: z.string().regex(/^[a-f0-9]{16}$|^no-stack$/),
  messagePattern: z.string().max(500),
  integrationVersion: z.string(),
  runtimeVersion: z.string(),
  occurrences: z.number().int().positive().default(1),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
}).strict();

// The complete report sent to registry (refined from packages/core)
export const RedactedErrorReportSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  signature: ErrorSignatureSchema,
  signatureHash: z.string().regex(/^[a-f0-9]{64}$/),
  configFingerprint: z.record(
    z.string(),
    z.union([z.string(), z.boolean(), z.number()])
  ),
  contextShape: z.object({
    requestMethod: z.enum(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]).optional(),
    urlTemplate: z.string().optional(),
    requestShape: z.record(z.string(), z.string()).optional(),
    responseShape: z.record(z.string(), z.string()).optional(),
    durationMs: z.number().int().min(0).optional(),
    retryCount: z.number().int().min(0).optional(),
  }).strict(),
  reporterId: z.string().regex(/^[a-f0-9]{32}$/),
  reportedAt: z.string().datetime(),
}).strict();
```

### 6.3 Config fingerprinting

When an Action runs, the runtime captures a non-secret fingerprint of its configuration:

- All scalar config values (strings, numbers, booleans) — values are kept
- `credentials: true` (sentinel — we say it's present, never what it is)
- `integrationVersion`, `runtimeVersion`, `nodeVersion` — to correlate across users
- NOT the credential id, NOT any raw payload

This enables queries like "all users of slack-send 1.4.2 with `unfurl_links: true` are
hitting signature X." The registry can suggest config tweaks even without patches.

### 6.4 Submission protocol

```
POST https://registry.chorus.dev/v1/reports
Content-Type: application/json
User-Agent: chorus-reporter/1.0.0

{
  "schemaVersion": "1.0.0",
  "report": <RedactedErrorReport>,
  "reporterIdProof": "<HMAC over reporterId using a rotated secret>"
}
```

- Offline-tolerant: reports queue in `error_signatures` (status=unreported); background
  job POSTs when network available.
- Rate-limited: max 100 reports/minute per reporter. Registry returns 429 with
  `Retry-After` header.
- No auth header. Reporter ID is pseudonymous; no user identity is transmitted.
- Idempotent by `(reporterId, signatureHash)`; registry dedupes.

Response:

```json
{
  "accepted": true,
  "signatureHash": "...",
  "existingPatch": {
    "id": "slack-send_oauth-refresh-race_a1b2c3d4",
    "stage": "canary-10",
    "inCohortForThisReporter": false
  }
}
```

If `existingPatch` exists and `inCohortForThisReporter` is true, the reporter triggers
the runtime's patch-fetcher to download + validate + apply.

---

## 7. Repair Agent (@delightfulchorus/repair-agent)

The local AI that proposes patches. Claude-powered, runs on the user's machine.

### 7.1 Trigger: failure → agent

The repair agent is invoked when:

1. A Run fails with a signature that has NO existing patch in the registry
2. AND the user has set `repair.autoAttempt: true` in `chorus.config.json`
3. AND the user's reputation meets the threshold to auto-submit (default: rep≥100)
4. AND rate-limit budget allows (default: 10 agent invocations/day)

If auto-attempt is off (default for new users), the agent still runs but in "propose only
locally" mode — the patch is saved to `~/.chorus/proposals/` and the user is prompted.

### 7.2 Context assembly

The agent receives a structured prompt:

```
## System
You are the Chorus Repair Agent. Your job is to propose a minimal code patch
to fix an integration failure.

## Input
- Error signature: <ErrorSignature JSON>
- Integration source: <full source of failing integration>
- Recent cassettes for this integration: <up to 3 cassettes, most recent first>
- Vendor docs URL (if known): <fetch + include first 50k chars>
- Related past patches: <up to 3 patches that touched similar files>

## Output requirements
Respond with a JSON object:
{
  "diff": "<unified diff>",
  "affectedFiles": [...],
  "testCassette": {
    "signatureHash": "...",
    "request": {...},
    "response": {...}
  },
  "reasoning": "<2-3 sentences why this fixes the signature>",
  "risks": ["<list of concerns>"]
}
```

Context budget: max 200k tokens. If the integration source + cassettes exceed this, the
agent truncates cassettes first, then docs, then older patches.

### 7.3 Patch proposal (Claude SDK)

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function proposePatch(ctx: RepairContext): Promise<PatchProposal> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: renderContext(ctx) }],
  });
  const raw = extractJson(response.content[0].text);
  return PatchProposalSchema.parse(raw);  // Zod validation
}
```

Model selection: `claude-sonnet-4-5` as default (cheap + fast + strong coding). Users can
override to `claude-opus-4-5` for harder integrations via `repair.model` config.

### 7.4 Snapshot validation

BEFORE submitting the patch to the registry, the agent validates locally:

```typescript
async function validateLocally(patch: PatchProposal, cassettes: Cassette[]): Promise<ValidationResult> {
  // 1. Apply patch to a temp copy of integration source
  const tempDir = await applyPatchToTempDir(patch);

  // 2. Compile the patched integration (tsc)
  const compileResult = await compilePatchedIntegration(tempDir);
  if (!compileResult.ok) return { valid: false, reason: 'compile-failed', detail: compileResult.errors };

  // 3. Replay the failing cassette against patched code — must now succeed
  const newResult = await replayCassette(tempDir, patch.testCassette);
  if (!cassetteMatches(newResult, patch.testCassette.response)) {
    return { valid: false, reason: 'cassette-mismatch', detail: { expected, actual } };
  }

  // 4. Replay ALL EXISTING cassettes for this integration — none may regress
  for (const cassette of cassettes) {
    const result = await replayCassette(tempDir, cassette);
    if (!cassetteMatches(result, cassette.interaction.response)) {
      return { valid: false, reason: 'regression', detail: { cassetteId: cassette.id } };
    }
  }

  return { valid: true };
}
```

If validation fails, the agent does NOT submit. It logs the failure, increments the
`repair-agent.failures` counter, and either (a) retries with a refined prompt (up to
3 total attempts), or (b) gives up and falls back to "notify user."

### 7.5 Submission

If local validation passes:

1. Bundle patch + cassette into tarball
2. Compute content hash (SHA-256)
3. If user has sigstore + GitHub OIDC configured: sign via Sigstore
4. Else: sign with Ed25519 contributor key
5. POST to `registry.chorus.dev/v1/patches/propose` with manifest + bundle
6. Registry acknowledges with patch ID + entry into canary-1 (or review queue if rep < 1000)

---

## 8. Integration SDK

### 8.1 Integration manifest

Every integration package exports:

```typescript
import { defineIntegration } from '@delightfulchorus/sdk';
import { z } from 'zod';

export default defineIntegration({
  name: 'slack-send',
  version: '1.4.3',
  description: 'Send messages to Slack via webhooks or Web API',
  authType: 'oauth2',
  baseUrl: 'https://slack.com/api',
  docsUrl: 'https://api.slack.com/methods',

  operations: [
    {
      name: 'postMessage',
      description: 'Post a message to a channel',
      idempotent: false,
      inputSchema: z.object({
        channel: z.string(),
        text: z.string().max(40000),
        blocks: z.array(z.unknown()).optional(),
        thread_ts: z.string().optional(),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        channel: z.string(),
        ts: z.string(),
        message: z.object({ text: z.string() }),
      }),
      handler: postMessageHandler,
    },
  ],
});
```

### 8.2 Writing a new integration (worked example)

Full `slack-send` implementation (minimal):

```typescript
// integrations/slack-send/src/index.ts
import { defineIntegration, type OperationHandler } from '@delightfulchorus/sdk';
import { z } from 'zod';

const PostMessageInput = z.object({
  channel: z.string(),
  text: z.string().max(40000),
  blocks: z.array(z.unknown()).optional(),
  thread_ts: z.string().optional(),
});

const PostMessageOutput = z.object({
  ok: z.literal(true),
  channel: z.string(),
  ts: z.string(),
  message: z.object({ text: z.string() }),
});

type Input = z.infer<typeof PostMessageInput>;
type Output = z.infer<typeof PostMessageOutput>;

const postMessage: OperationHandler<Input, Output> = async (input, ctx) => {
  const token = ctx.credentials?.accessToken as string | undefined;
  if (!token) throw new ctx.errors.AuthError({ message: 'No access token present' });

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(input),
    signal: ctx.signal,
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '30') * 1000;
    throw new ctx.errors.RateLimitError({ message: 'Slack rate limit', retryAfterMs: retryAfter });
  }

  const body = await res.json();
  if (!body.ok) {
    throw new ctx.errors.IntegrationError({
      code: `SLACK_${body.error?.toUpperCase() ?? 'UNKNOWN'}`,
      message: body.error ?? 'unknown Slack API error',
      integration: 'slack-send',
      operation: 'postMessage',
      httpStatus: res.status,
      retryable: ['internal_error', 'ratelimited'].includes(body.error),
    });
  }

  // Record cassette for validation on future patches
  await ctx.snapshot?.record(`slack.postMessage`, input, body);

  return PostMessageOutput.parse(body);
};

export default defineIntegration({
  name: 'slack-send',
  version: '1.4.3',
  description: 'Send Slack messages',
  authType: 'oauth2',
  baseUrl: 'https://slack.com/api',
  operations: [
    {
      name: 'postMessage',
      description: 'Post a message to a channel',
      idempotent: false,
      inputSchema: PostMessageInput,
      outputSchema: PostMessageOutput,
      handler: postMessage,
    },
  ],
});
```

### 8.3 Testing integrations (cassettes)

Every integration ships with a `__cassettes__/` directory of recorded interactions.
Tests replay cassettes via vitest:

```typescript
import { describe, it, expect } from 'vitest';
import { loadCassette, replayCassette } from '@delightfulchorus/cassette';
import integration from '../src/index.js';

describe('slack-send.postMessage', () => {
  it('happy path — posts message', async () => {
    const cassette = await loadCassette('./__cassettes__/postMessage-happy.json');
    const result = await replayCassette(integration, cassette);
    expect(result.ok).toBe(true);
    expect(result.ts).toMatch(/^\d+\.\d+$/);
  });

  it('rate-limit — retryable error', async () => {
    const cassette = await loadCassette('./__cassettes__/postMessage-ratelimit.json');
    await expect(replayCassette(integration, cassette)).rejects.toThrow('rate limit');
  });
});
```

Cassette schema:

```typescript
export const CassetteEntrySchema = z.object({
  signatureHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),   // for failure cassettes
  interaction: z.object({
    request: z.object({
      method: z.enum(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]),
      urlTemplate: z.string(),
      headerNames: z.array(z.string()),   // names only, no values
      bodyShape: z.unknown().optional(),   // shape not value
    }),
    response: z.object({
      status: z.number().int().min(100).max(599),
      headerNames: z.array(z.string()),
      bodyShape: z.unknown().optional(),
      bodySnippet: z.string().max(500).optional(),  // redacted first 500 chars
    }),
  }),
  timestamp: z.string().datetime(),
  durationMs: z.number().int().min(0),
}).strict();

export const CassetteSchema = z.object({
  version: z.literal("1.0.0"),
  integration: z.string(),
  entries: z.array(CassetteEntrySchema),
}).strict();
```

---

## 9. CLI (@delightfulchorus/cli)

The `chorus` CLI is the primary user-facing interface. Five commands:

### 9.1 chorus init

Scaffolds a new Chorus project in the current directory:

```
chorus init [--name=<name>]

Creates:
  chorus.config.json         # runtime config
  flows/                     # workflow definitions (empty)
  .chorus/                   # local state (SQLite DB lives here)
  .gitignore                 # excludes .chorus/
  .env.example               # CHORUS_ENCRYPTION_KEY, ANTHROPIC_API_KEY, etc.
```

Generates a random 32-byte encryption key, writes it to `.env` (gitignored). User is
warned: "losing this key = all credentials unreadable."

### 9.2 chorus run

Executes a workflow manually (bypassing triggers):

```
chorus run <workflow-id-or-file> [--input=payload.json] [--follow]

Flags:
  --input         Path to a JSON file used as trigger payload
  --follow        Stream step output to stdout (default: print final result)
  --dry-run       Parse + validate workflow, do not execute
```

### 9.3 chorus report

Manages error reports and registry submission:

```
chorus report list                    # show local unreported signatures
chorus report submit [--signature=X]  # force-submit specific signature (or all)
chorus report status <signature>      # show submission state + any known patches
```

### 9.4 chorus patch

Manages patches (fetch, apply, revoke):

```
chorus patch list                     # all patches known to registry for installed integrations
chorus patch fetch <patch-id>         # download + verify signature (do not apply)
chorus patch apply <patch-id>         # apply to local integration copy
chorus patch revoke <patch-id>        # local-only revocation (also reports to registry)
chorus patch history                  # chronological list of applied patches
```

### 9.5 chorus credential (auxiliary)

Manages credentials for integrations:

```
chorus credential add <integration>   # interactive prompt for api key or OAuth flow
chorus credential list                # show labels (never values)
chorus credential test <id>           # make a no-op API call to validate
chorus credential remove <id>
```

All credential management happens locally. The CLI talks to the running chorus daemon
over a Unix socket (or named pipe on Windows) — never over the network.

---

## 10. Threat Model

We explicitly defend against these six threats, accept seven out of scope.

### 10.1 Defended

| # | Threat | Primary defense | Secondary defense |
|---|---|---|---|
| T1 | Malicious fix replacing token refresh with exfiltration | Static pattern deny-list in validator; capability-based restriction on network hosts for auth modules | Canary rollout catches exfil traffic anomaly; 2-maintainer review for auth-touching patches |
| T2 | Supply chain via dependency addition (Shai-Hulud class) | New-dep cooldown: any new dep triggers extra human review; dep pinning (no `^`/`~`); SBOM diff per patch | Reputation floor for dep-adding patches |
| T3 | Targeted attack (different patches to different users) | Content-addressed distribution (patch ID = hash of content) — every user gets same bytes | Rekor public log enables cross-witness comparison |
| T4 | Compromised signing key / OIDC identity | Short-lived Sigstore certs (10 min); workflow-file binding; Rekor monitoring for unexpected branches/paths | Identity revocation removes trust retroactively |
| T5 | Rollback / downgrade attack | Monotonic version enforcement on client; signed manifest with freshness timestamp | Cross-client gossip on "latest version seen" (v2) |
| T6 | Malicious insider with legitimate signing privilege | 2-person review for security-sensitive modules; canary ladder applies regardless of rep | Post-hoc audit via Rekor; reputation decay on incidents |

### 10.2 Out of scope

- **Compromise of user's local machine.** If the user's box is owned, the attacker has
  the encryption key and credentials. Game over. Chorus does not try to be a TEE.
- **Compromise of GitHub / Google OIDC providers.** Systemic failure of the software
  supply-chain ecosystem. We inherit their threat model.
- **Compromise of Sigstore Fulcio or Rekor.** Sigstore has its own security track; we
  inherit their assumptions.
- **Zero-day in the Chorus client itself.** Addressed by client auto-update, orthogonal
  to patch registry.
- **Physical coercion of maintainers.**
- **Side-channel attacks** on signing infrastructure (timing, power).
- **Quantum attacks on Ed25519/RSA.** Pre-quantum for now. Post-quantum migration
  scheduled for v3 per broader industry timeline.
- **Integration vendor API changes.** Not a "threat" — it's the problem Chorus exists
  to solve. Handled by the repair agent + cassette validation, not by the security model.

### 10.3 MVP defenses (what ships in v1)

- Gate 1 — **Static AST diff validator**: blocks patches that introduce unknown network
  hosts in auth modules, or call `eval`/`Function` constructor.
- Gate 3 — **Sandbox execution**: proposed patches run in per-Run subprocess against
  cassettes before signing.
- Gate 5 — **Canary ladder**: even a signed, validated patch reaches 1% of fleet first.
- **Sigstore + Ed25519 signatures** on every patch.
- **Revocation fast-path**: 5-min polling window.

### 10.4 Deferred defenses (v1.x and v2)

- Gate 2 — **Semgrep rules** (skipped for MVP; static AST is good enough).
- Gate 4 — **Differential testing as gate** (added by month 6; currently informational).
- Gate 6 — **Human review UI** for sensitive module patches (CLI review only in MVP).
- **nsjail** on Linux for hardened sandbox (MVP uses subprocess; cross-platform priority).
- **Multi-witness gossip** for split-view detection (v2).

---

## 11. MVP Scope vs v2 Roadmap

### 11.1 MVP (v1.0, ships first)

**In scope:**
- Workflow runtime: webhook + cron + manual triggers
- Durable execution: step.run, step.sleep (replay-based)
- SQLite state backend
- Credential storage (AES-256-GCM)
- OAuth refresh (scheduled job)
- Integration SDK + 2 reference integrations (http-generic, slack-send)
- Per-Run subprocess isolation
- Failure reporter with signature + redaction
- Claude-powered repair agent (local, opt-in auto-submit)
- Patch registry (git-backed + CDN + Sigstore)
- 7-day canary ladder (default) + 4-hour expedited
- Revocation fast-path
- Ed25519 contributor key fallback
- CLI: init, run, report, patch, credential

**Target user:** solo dev or 2-5 person team with ~20 integrations.

**Success metric:** A user can `chorus init`, configure slack-send + http-generic
integrations, wire up a webhook-triggered workflow, observe a real failure, have
the repair agent propose a valid patch, and apply it — without touching any
integration code by hand.

### 11.2 v1.1 (1-3 months after v1)

- `poll` trigger type (per-workflow cursor polling)
- `event` trigger type + `step.waitForEvent`
- Differential testing as gate (currently informational)
- Web UI (read-only dashboard: runs, patches, credentials — no flow editor)
- Auto-MCP surface: each deployed integration exposed as an MCP tool
- Integration hot-reload in dev
- Additional reference integrations: stripe, github, linear, gmail (manual draft for now)

### 11.3 v2 (6-12 months)

- Postgres backend (migration path from SQLite; users opt in via `chorus migrate`)
- nsjail sandbox on Linux (opt-in, flag-gated)
- Multi-node runtime (worker pool, shared Postgres queue)
- Flow visual editor (drag-drop) — still generates OpenFlow JSON
- Semgrep-based secondary static analysis
- Human review UI for sensitive-module patches
- Cross-node event bus for multi-machine federation within one org
- Patch propose/review/merge fully automated for high-rep contributors

### 11.4 Explicitly deferred indefinitely

- CRIU-based process checkpointing (Trigger.dev style) — too Linux-specific
- Self-hosted LLMs for repair agent — Claude is cheaper per quality
- Cryptographic PGP Web of Trust — OIDC + reputation is sufficient, UX is not
- Kubernetes-native deployment — MVP targets single-machine; K8s is a distraction
- Turing-complete flow expression language (Windmill's advanced JSONnet) — keep flows
  declarative and debuggable

---

## 12. Open Questions

These are decisions deferred to implementation or v1.x feedback. Flagged here so
implementers don't waste time trying to resolve them.

**1. Postgres migration path.** When and how does a user transition from SQLite to
Postgres? Likely answer: one-way migration CLI command `chorus migrate --to postgres
--url postgres://...`. Decide after seeing real user scale signals.

**2. nsjail / gVisor / Firecracker on Linux.** Per-Run subprocess is enough for MVP.
But a truly hostile patch could still consume resources or probe filesystem. Open
question: is nsjail enough, or do we need gVisor? Decide in v2 scope.

**3. MCP surface shape.** Auto-exposing each integration as an MCP tool is v1.1. Do we
mirror operations 1:1, or do we collapse related operations into a single tool with
a variant parameter? Decide when writing the MCP wrapper in v1.1.

**4. Federated registry topology.** MVP: one registry at `registry.chorus.dev`.
v2: can enterprises run their own private taps? What is the trust model between
a private tap and the public tap? Decide in v2 scope with early enterprise users.

**5. Cassette granularity.** Do we record every HTTP call, or only failing calls, or
only deterministic endpoints? Current default: record only on failure + sample 1%
of successful calls. Open: does this produce enough training signal for repair? May
need to tune based on repair agent performance.

**6. Repair agent cost governance.** Default daily budget: 10 invocations at ~$0.50
each = $5/day worst case. Need CLI command to adjust + surface on dashboard. Decide
pricing / quota model in v1.1.

**7. Patch rejection reasons public vs private.** If a patch is rejected at static AST
gate, do we publish the reason (educational for contributor) or keep private (denial
of security info to attackers)? Default: public for quality rejections, private for
security rejections (e.g., "deny-list match"). Revisit if users ask.

**8. Versioning of integrations.** MVP: semver per integration, manual bumps. v1.1:
automated bumps on patch merge. v2: per-operation versioning? Decide if operations
diverge in update cadence.

**9. Windows support level.** Runtime: full support. nsjail sandbox: Linux only (v2).
CLI: full support via named pipes instead of Unix sockets. Open: do we ship a Windows
installer / MSI, or rely on npm install? Default: npm install for v1; MSI if enterprise
demands.

**10. Repair-agent model rotation.** Hardcoded to Claude in v1. If Anthropic pricing
shifts or alternative models become competitive, do we abstract the SDK or prefer the
one that works? Default: keep Claude hardcoded through v2; abstract only if cost
pressure emerges.

---

*End of architecture. Implementers: pick a section, ship. Questions → open an issue
on `github.com/chorus/chorus/issues` with tag `architecture-clarification`.*
