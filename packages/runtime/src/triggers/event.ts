import { randomUUID } from "node:crypto";
import type { EventTrigger } from "@delightfulchorus/core";
import type { RunQueue } from "../queue.js";
import type { DatabaseType, EventRow, WaitingStepRow } from "../db.js";
import { QueryHelpers } from "../db.js";

/**
 * Event trigger + dispatch per ROADMAP §6.
 *
 * Two responsibilities:
 *
 *  1. **Trigger routing** — workflows with an `event` trigger register a
 *     subscription here (eventType + optional payload filter). When an event
 *     arrives, we enqueue a run for every matching workflow.
 *
 *  2. **waitForEvent dispatch** — the executor writes a `waiting_steps` row
 *     on `step.waitForEvent(...)`. The dispatch loop queries for unresolved
 *     rows matching an incoming event, resolves them in SQL, and wakes the
 *     run (re-enqueues if it was put in status='waiting').
 *
 * Both paths share one `emit(event)` entry point. Tests can drive it directly;
 * the HTTP layer (api/events.ts) forwards POST /api/events bodies here.
 *
 * Durable-first invariant: every state transition goes through SQL. In-memory
 * registration is a cache for fast routing; a restart rebuilds it from the
 * `triggers` table (wiring done in server.ts when we fully hook this up).
 */

export interface EventTriggerEntry {
  workflowId: string;
  config: EventTrigger;
  /** Unique key for deregistration. Defaults to workflowId+eventType. */
  key?: string;
}

export interface EventDispatcherOptions {
  queue: RunQueue;
  db: DatabaseType;
  /** Override Date.now()-based timestamps; used by tests. */
  now?: () => Date;
}

export interface EmitEventInput {
  type: string;
  payload?: unknown;
  source?: string;
  correlationId?: string;
  /** Pre-set id (optional). If omitted, a UUID is generated. */
  id?: string;
}

export interface EmitResult {
  event: EventRow;
  /** runIds enqueued from matching event-trigger subscriptions. */
  triggeredRunIds: string[];
  /** waiting_steps resolved by this event. */
  resolvedWaitingSteps: Array<{
    runId: string;
    stepName: string;
  }>;
}

/**
 * Matches a candidate event against a (type, filter, correlationId) pattern.
 * Pure function — exported so tests can exercise the shape independently.
 *
 * - `filter`: shallow key/value equality on the event's payload.
 * - `correlationIdMatch`: exact-match if set.
 */
export function eventMatches(
  event: { type: string; payload: unknown; correlationId?: string | null },
  pattern: {
    eventType: string;
    filter?: Record<string, unknown> | undefined | null;
    correlationId?: string | undefined | null;
  },
): boolean {
  if (event.type !== pattern.eventType) return false;
  if (pattern.correlationId && event.correlationId !== pattern.correlationId) {
    return false;
  }
  if (!pattern.filter || Object.keys(pattern.filter).length === 0) return true;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    // Non-object payloads can never satisfy a key/value filter.
    return false;
  }
  const p = payload as Record<string, unknown>;
  for (const [k, v] of Object.entries(pattern.filter)) {
    // The filter semantics: if the filter value is `undefined`, the key must
    // merely be present. Otherwise, shallow strict equality on primitives,
    // JSON-string equality on everything else.
    if (!(k in p)) return false;
    if (v === undefined) continue;
    const actual = p[k];
    if (typeof v !== "object" || v === null) {
      if (actual !== v) return false;
    } else {
      if (JSON.stringify(actual) !== JSON.stringify(v)) return false;
    }
  }
  return true;
}

/**
 * Event dispatcher: in-memory registry for workflow subscriptions +
 * SQL-backed emit path. Single instance per runtime.
 */
export class EventDispatcher {
  private readonly entries = new Map<string, EventTriggerEntry>();
  private readonly helpers: QueryHelpers;
  private readonly now: () => Date;

  constructor(private readonly opts: EventDispatcherOptions) {
    this.helpers = new QueryHelpers(opts.db);
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Register a workflow trigger. Key defaults to `${workflowId}::${eventType}`.
   */
  register(entry: EventTriggerEntry): void {
    const key = entry.key ?? `${entry.workflowId}::${entry.config.eventType}`;
    if (this.entries.has(key)) {
      throw new Error(`Event trigger for ${key} already registered`);
    }
    this.entries.set(key, entry);
  }

  unregister(key: string): void {
    this.entries.delete(key);
  }

  listEntries(): EventTriggerEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Match an emitted event against registered workflow triggers, returning
   * the subscriptions whose pattern accepts the event. Useful for tests.
   */
  matchingEntries(event: {
    type: string;
    payload: unknown;
    correlationId?: string | null;
  }): EventTriggerEntry[] {
    const out: EventTriggerEntry[] = [];
    for (const entry of this.entries.values()) {
      if (
        eventMatches(event, {
          eventType: entry.config.eventType,
          filter: entry.config.filter ?? null,
        })
      ) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Emit an event. Writes a durable row, then:
   *   1. enqueues a run for each registered workflow that matches
   *   2. resolves any waiting_steps rows whose pattern matches (re-enqueueing
   *      the runs they belong to if those runs were parked in
   *      status='pending' with a next_wakeup sentinel)
   *
   * Returns enough info for the caller (test / API) to assert behavior.
   */
  emit(input: EmitEventInput): EmitResult {
    const event: EventRow = {
      id: input.id ?? randomUUID(),
      type: input.type,
      payload: JSON.stringify(input.payload ?? {}),
      source: input.source ?? null,
      emitted_at: this.now().toISOString(),
      correlation_id: input.correlationId ?? null,
      consumed_by_run: null,
    };
    this.helpers.insertEvent(event);

    // 1. Route to workflow triggers.
    const triggeredRunIds: string[] = [];
    const parsedPayload = safeParseJson(event.payload);
    const matches = this.matchingEntries({
      type: event.type,
      payload: parsedPayload,
      correlationId: event.correlation_id,
    });
    for (const entry of matches) {
      const runId = this.opts.queue.enqueue(entry.workflowId, {
        triggeredBy: "event",
        triggerPayload: {
          event: {
            id: event.id,
            type: event.type,
            payload: parsedPayload,
            source: event.source,
            correlationId: event.correlation_id,
            emittedAt: event.emitted_at,
          },
        },
        nowIso: event.emitted_at,
      });
      triggeredRunIds.push(runId);
    }

    // 2. Resolve matching waiting_steps (fan-out — a single event can wake
    // many parked steps). We resolve in SQL, then release their runs back
    // to the queue so the executor picks them up on next tick.
    const candidates = this.helpers.listUnresolvedWaitingSteps(event.type);
    const resolvedWaitingSteps: Array<{ runId: string; stepName: string }> = [];
    for (const w of candidates) {
      if (!this.waitingStepMatches(w, event.type, parsedPayload, event.correlation_id)) {
        continue;
      }
      this.helpers.resolveWaitingStep(w.run_id, w.step_name, event.id, event.emitted_at);
      // Re-enqueue the parked run. Executor will replay; step.waitForEvent
      // finds resolved_at != null and returns the event payload.
      this.opts.queue.release(w.run_id);
      resolvedWaitingSteps.push({ runId: w.run_id, stepName: w.step_name });
    }

    return { event, triggeredRunIds, resolvedWaitingSteps };
  }

  private waitingStepMatches(
    w: WaitingStepRow,
    eventType: string,
    payload: unknown,
    correlationId: string | null,
  ): boolean {
    let filter: Record<string, unknown> | null = null;
    if (w.match_payload) {
      filter = safeParseJson(w.match_payload) as Record<string, unknown> | null;
    }
    return eventMatches(
      { type: eventType, payload, correlationId: correlationId ?? undefined },
      {
        eventType: w.event_type,
        filter,
        correlationId: w.match_correlation_id ?? undefined,
      },
    );
  }

  /**
   * Time out waiting_steps whose expires_at has passed. We don't resolve the
   * row with an event id — instead we leave resolved_event_id=null and set
   * resolved_at to the expiry marker so the executor knows it timed out
   * (vs resolved cleanly). The executor then raises TimeoutError on replay.
   */
  expireWaitingSteps(nowIso?: string): Array<{ runId: string; stepName: string }> {
    const now = nowIso ?? this.now().toISOString();
    const expired = this.helpers.listExpiredWaitingSteps(now);
    const out: Array<{ runId: string; stepName: string }> = [];
    for (const w of expired) {
      // Mark resolved (without an event) using a sentinel event id.
      this.helpers.resolveWaitingStep(w.run_id, w.step_name, "__timeout__", now);
      this.opts.queue.release(w.run_id);
      out.push({ runId: w.run_id, stepName: w.step_name });
    }
    return out;
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Sentinel value used by resolveWaitingStep when a waiting step times out
 * rather than resolves to a real event. Exported so the executor can tell
 * the difference on replay.
 */
export const TIMEOUT_EVENT_ID = "__timeout__";
