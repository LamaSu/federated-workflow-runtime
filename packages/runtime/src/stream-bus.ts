/**
 * In-process broadcast bus for the streaming protocol (Wave 4 item 12).
 *
 * Per-runId subscribers receive a typed stream of events emitted by the
 * executor as it walks a workflow. The bus is intentionally simple:
 *
 *   - One bus per ChorusServer (single process, single SQLite DB).
 *   - Subscribers identify themselves by `runId` + a set of modes they care
 *     about; the bus filters at delivery time so a subscriber asking for
 *     `messages` doesn't see `tasks` events.
 *   - Publishers (the executor's `step.run` and `ctx.stream.write`) call
 *     `publish()` exactly once per emit. Delivery is synchronous fan-out
 *     to every subscriber whose modes include the event's mode.
 *
 * Why in-process and not a queue:
 *   - Wave 4 ships with a single chorus serve process per project.
 *   - A real queue (Redis, NATS, Kafka) would force every emit through
 *     network IPC; that's overhead the MVP doesn't need.
 *   - Future: swap this implementation behind the same surface to support
 *     multi-process. The contract is: `publish()` is fire-and-forget,
 *     `subscribe()` returns an unsubscribe function.
 *
 * Ordering guarantee (CRITICAL):
 *   The executor emits inside the per-run write Mutex critical section,
 *   AFTER the SQLite row write. That means two concurrent `step.fanOut`
 *   children that race to write step rows ALSO race to publish — but the
 *   mutex serializes both. Subscribers therefore see events in the SAME
 *   order the steps table sees the rows. This is exercised by
 *   `stream-bus.test.ts` and `executor.streaming.test.ts`.
 */

import type { StepRow } from "./db.js";

/**
 * The four modes mirror LangGraph's stream-mode taxonomy, dropping
 * `debug` / `checkpoints` / `custom` which don't fit chorus's MVP.
 *
 *   - `values`   — current step row state for the run (latest snapshot).
 *                  Emitted on each step row write. Subscribers reading this
 *                  mode see the post-write row contents.
 *   - `updates`  — new step rows since last poll cursor. Same payload as
 *                  `values` today; the distinction matters at the HTTP
 *                  layer (the SSE endpoint backfills missed rows for
 *                  `updates` mode using the steps table on first connect).
 *   - `messages` — handler-emitted token chunks. Triggered by an
 *                  integration calling `ctx.stream.write(chunk)`. The
 *                  runtime never auto-instruments LLM token streams; it's
 *                  cooperative.
 *   - `tasks`    — step lifecycle: a `step:start` is emitted before the
 *                  handler runs (when the row's status is 'running'); a
 *                  `step:end` is emitted after (status='success'/'failed').
 */
export type StreamMode = "values" | "updates" | "messages" | "tasks";

/** All four valid modes. Useful for CLI/HTTP query validation. */
export const STREAM_MODES: readonly StreamMode[] = [
  "values",
  "updates",
  "messages",
  "tasks",
] as const;

/**
 * Discriminated event union. Keep payloads small (no full row objects in
 * the hot path) so subscribers don't pay JSON cost per emit. Subscribers
 * that want the full row can `getStep` themselves.
 */
export type StreamEvent =
  | StreamValuesEvent
  | StreamUpdatesEvent
  | StreamMessagesEvent
  | StreamTasksEvent;

export interface StreamValuesEvent {
  mode: "values";
  /** Run id. */
  runId: string;
  /** Step row contents at write time (post-Mutex). */
  step: StepEventPayload;
  /** Wall-clock ms since epoch — useful for client clock-skew adjustment. */
  ts: number;
}

export interface StreamUpdatesEvent {
  mode: "updates";
  runId: string;
  step: StepEventPayload;
  ts: number;
}

export interface StreamMessagesEvent {
  mode: "messages";
  runId: string;
  /**
   * Step name the handler was running when it called ctx.stream.write.
   * Helps the consumer attribute tokens to a particular node.
   */
  stepName: string;
  /** Whatever the handler passed in. Usually a string token; can be any JSON. */
  chunk: unknown;
  ts: number;
}

export interface StreamTasksEvent {
  mode: "tasks";
  runId: string;
  /** "step:start" before handler invocation; "step:end" after. */
  phase: "step:start" | "step:end";
  stepName: string;
  /** Final status when phase='step:end'; absent on 'step:start'. */
  status?: "success" | "failed";
  ts: number;
}

/**
 * Lightweight projection of the relevant StepRow fields. We avoid passing
 * the full row through the bus because (a) subscribers usually don't need
 * the input/error fields and (b) keeping the payload small reduces
 * per-emit JSON encoding cost.
 */
export interface StepEventPayload {
  stepName: string;
  status: StepRow["status"];
  attempt: number;
  output: unknown | null;
  error: string | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Subscriber callback. Synchronous so the bus can call it inside the
 * Mutex critical section without yielding the lock; if a subscriber needs
 * to do async work it should buffer + drain on its own.
 */
export type StreamListener = (event: StreamEvent) => void;

export interface SubscribeOptions {
  /** Which modes to receive. Empty = none (no-op subscription). */
  modes: readonly StreamMode[];
}

/**
 * The broadcast bus. One instance per ChorusServer.
 */
export class StreamBus {
  /**
   * Per-runId subscriber map. Keys are runId; values are the set of
   * (listener, modes) pairs. We use Set so removal is O(1) and we don't
   * accidentally double-deliver if the same listener subscribes twice.
   */
  private readonly subscribers = new Map<string, Set<Subscription>>();

  /**
   * Register a listener for a runId + mode set. Returns an unsubscribe
   * function (idempotent).
   *
   * Multiple subscribers per runId are supported and expected — the SSE
   * endpoint may have several browsers tailing the same run, plus the
   * CLI's `chorus stream` command, plus a dashboard widget.
   */
  subscribe(
    runId: string,
    listener: StreamListener,
    opts: SubscribeOptions,
  ): () => void {
    const sub: Subscription = { listener, modes: new Set(opts.modes) };
    let bucket = this.subscribers.get(runId);
    if (!bucket) {
      bucket = new Set();
      this.subscribers.set(runId, bucket);
    }
    bucket.add(sub);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const b = this.subscribers.get(runId);
      if (!b) return;
      b.delete(sub);
      if (b.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  /**
   * Fan-out `event` to every subscriber for `event.runId` whose modes
   * include `event.mode`. Synchronous: callers (the executor) are
   * holding the per-run write mutex; we MUST not yield inside delivery.
   *
   * Listener exceptions are caught and swallowed (with a stderr log) so
   * a misbehaving subscriber doesn't poison the run. The bus is best-effort
   * delivery — durability is the steps table, not the bus.
   */
  publish(event: StreamEvent): void {
    const bucket = this.subscribers.get(event.runId);
    if (!bucket || bucket.size === 0) return;
    // Snapshot to allow listeners to unsubscribe themselves mid-fan-out
    // without mutating the iterator.
    const subs = Array.from(bucket);
    for (const s of subs) {
      if (!s.modes.has(event.mode)) continue;
      try {
        s.listener(event);
      } catch (err) {
        // Best-effort — print and continue. A subscriber that throws
        // should not abort the executor's mutex critical section.
        // eslint-disable-next-line no-console
        console.error(
          `[StreamBus] subscriber threw on ${event.mode} event for run ${event.runId}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Number of distinct subscribers across all runs. For tests + ops.
   */
  get subscriberCount(): number {
    let n = 0;
    for (const bucket of this.subscribers.values()) n += bucket.size;
    return n;
  }

  /** Subscribers for a specific run. For tests. */
  subscriberCountForRun(runId: string): number {
    return this.subscribers.get(runId)?.size ?? 0;
  }
}

interface Subscription {
  listener: StreamListener;
  modes: Set<StreamMode>;
}

/**
 * Build a StepEventPayload from a StepRow, parsing the JSON output
 * column safely. Used by the executor when it publishes after row writes.
 */
export function stepRowToPayload(row: {
  step_name: string;
  status: StepRow["status"];
  attempt: number;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
}): StepEventPayload {
  let parsedOutput: unknown = null;
  if (row.output !== null && row.output !== undefined) {
    try {
      parsedOutput = JSON.parse(row.output);
    } catch {
      parsedOutput = row.output;
    }
  }
  return {
    stepName: row.step_name,
    status: row.status,
    attempt: row.attempt,
    output: parsedOutput,
    error: row.error,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
