import { randomUUID } from "node:crypto";
import type {
  IntegrationModule,
  Logger,
  MemoryStore,
  Node as WorkflowNode,
  NodeRef,
  OperationContext,
  OperationHandler,
  WaitForEventCall,
  Workflow,
} from "@delightfulchorus/core";
import { FallbacksExhaustedError, WaitForEventCallSchema } from "@delightfulchorus/core";
import type { DatabaseType, StepRow } from "./db.js";
import { QueryHelpers } from "./db.js";
import { Mutex } from "./mutex.js";
import { TIMEOUT_EVENT_ID } from "./triggers/event.js";
import {
  askUserEventType,
  buildAskUserDescriptor,
  type AskUserSchema,
} from "./schema-validate.js";
import { evalWhen } from "./when-eval.js";

/**
 * Runtime executor — replay-based durable execution per §4.3.
 *
 * Given a workflow + a pre-enqueued `runId`, it:
 *   1. Loads each node's integration module (via a pluggable loader).
 *   2. Walks nodes in declaration order.
 *   3. Wraps each node invocation in a `step.run(name, fn)` with the node ID
 *      as the step name — so if the process crashes mid-run and is retried,
 *      completed steps short-circuit to their memoized output.
 *   4. Persists node I/O, status, and timings into the `steps` table.
 *
 * The critical contract: `step.run("foo", fn)` invoked twice with the same
 * name in the same run must return the first call's cached output. This is
 * exercised by `executor.test.ts` as the durability guarantee.
 */

export type IntegrationLoader = (integration: string) => Promise<IntegrationModule>;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  multiplier: number;
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1000,
  multiplier: 2,
  jitter: true,
};

export interface ExecutorOptions {
  db: DatabaseType;
  integrationLoader: IntegrationLoader;
  logger?: Logger;
  /** Abort all in-flight work. */
  signal?: AbortSignal;
  /** Override Date.now()-based timestamps; used by tests. */
  now?: () => Date;
  /** Override the per-step retry delay scheduler; used by tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Credentials resolver. Given an integration name, returns the decrypted
   * credential payload (or null if none configured). Injected by the runtime
   * server wiring; executor.ts does not read the crypto key directly.
   */
  credentialsFor?: (integration: string) => Record<string, unknown> | null;
}

export interface ExecutorResult {
  runId: string;
  status: "success" | "failed" | "waiting";
  steps: StepRow[];
  error?: string;
  /**
   * When status='waiting', which step the run parked on. The dispatch loop
   * will re-enqueue this run when the waiting_steps row resolves (via event)
   * or expires (timeout).
   */
  waitingOn?: { stepName: string; eventType: string };
}

/**
 * Optional knobs for `step.askUser`. Today only `timeoutMs` is meaningful;
 * exposed as an object so future fields (`prompt-format` hints, etc.) don't
 * change the call shape.
 *
 * Default timeout is 24h (vs waitForEvent's 60s) — humans are slow.
 */
export interface AskUserOpts {
  timeoutMs?: number;
}

export const ASK_USER_DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Result payload returned by `step.waitForEvent` on success.
 */
export interface WaitForEventResult {
  event: {
    id: string;
    type: string;
    payload: unknown;
    source: string | null;
    correlationId: string | null;
    emittedAt: string;
  };
}

/**
 * Thrown by `step.waitForEvent` when the waiting_steps row has expired
 * (reached its timeoutMs deadline). Distinguish from a generic Error so
 * integration authors can try/catch cleanly:
 *
 *   try {
 *     await step.waitForEvent({ eventType: "x", timeoutMs: 60_000 });
 *   } catch (err) {
 *     if (err instanceof WaitForEventTimeoutError) {
 *       // plan B
 *     }
 *   }
 */
export class WaitForEventTimeoutError extends Error {
  constructor(eventType: string, timeoutMs: number) {
    super(`Timed out waiting for event "${eventType}" after ${timeoutMs}ms`);
    this.name = "WaitForEventTimeoutError";
  }
}

/**
 * Internal control-flow signal: thrown when the current run must suspend
 * until a waiting_steps row resolves. The outer `run()` catches this and
 * returns status='waiting' — the run is NOT failed, just parked.
 *
 * Not exported: integration authors should never see this; if it escapes
 * `run()`, that's a bug worth catching in tests.
 */
class SuspendForEvent extends Error {
  constructor(
    public readonly stepName: string,
    public readonly eventType: string,
  ) {
    super(`run suspended, waiting for event "${eventType}" in step "${stepName}"`);
    this.name = "SuspendForEvent";
  }
}

/**
 * A `StepContext` is what's passed to each Action so that it can declare
 * named, memoized sub-steps. The outer node invocation is itself wrapped in
 * a step so a full-process restart replays the cached output.
 */
export interface StepContext {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
  /**
   * Runtime-decided parallel fan-out (chorus's answer to LangGraph's `Send`).
   *
   * For each `items[i]`, invoke `fn(item, i)` wrapped in its own memoized
   * `step.run("${name}.${i}", ...)` call. All children run in parallel; the
   * promise resolves to an array of results in INPUT ORDER (not completion
   * order).
   *
   * Memoization invariants:
   *   • Each child gets its own `${name}.${index}` row in the `steps` table
   *     with its own retry budget (inherited from the enclosing node).
   *   • The fanOut itself is NOT a separate step row — it's a coordination
   *     primitive over its children.
   *   • Replay: cached children short-circuit; failed children re-execute.
   *     Partial-failure recovery is automatic via the underlying step.run
   *     memoization.
   *
   * Failure mode:
   *   • If any child throws, fanOut rejects with an `AggregateError`
   *     wrapping the failed children. Successful children still write their
   *     `success` rows; on rerun the cached results replay and only the
   *     failed children re-invoke.
   *   • A child throwing `SuspendForEvent` (from `step.waitForEvent` /
   *     `step.askUser`) propagates as a normal suspension — the parent run
   *     parks. Other in-flight children's results are NOT lost: their
   *     step.run rows are written before suspension propagates.
   *
   * Example:
   * ```ts
   * const results = await step.fanOut("scrape", urls, async (url, i) => {
   *   return await fetchAndExtract(url);
   * });
   * // results[0] corresponds to urls[0], etc.
   * ```
   *
   * Concurrency note: SQLite writes from parallel children are serialized
   * through an internal Mutex on the dispatcher's DB connection — handler
   * invocations themselves remain unrestricted (true parallelism).
   */
  fanOut<TItem, TResult>(
    name: string,
    items: readonly TItem[],
    fn: (item: TItem, index: number) => Promise<TResult>,
  ): Promise<TResult[]>;
  /**
   * Durably wait for an external event (ROADMAP §6). Survives process
   * restarts — a waiting_steps row is persisted; the dispatch loop
   * resolves it when a matching event arrives or the timeout passes.
   *
   * On success, returns `{ event: ... }` with the matched payload.
   * On timeout, throws `WaitForEventTimeoutError`.
   *
   * Replay semantics mirror `step.run`:
   *   - First call parks and suspends.
   *   - Replay with resolved row → returns cached payload.
   *   - Replay with timed-out row → throws deterministic TimeoutError.
   *   - Replay with still-pending row → suspends again.
   */
  waitForEvent(stepName: string, call: WaitForEventCall): Promise<WaitForEventResult>;
  /**
   * Durable HITL (human-in-the-loop) interrupt. The handler asks the user a
   * question, the run parks until the user answers via the gateway's
   *   POST /ask/<runId>/<stepName>
   * webhook (validated against the supplied schema), then returns the
   * validated answer. Survives process restarts via the same waiting_steps
   * machinery that backs `waitForEvent`.
   *
   * Replay semantics:
   *   - First call writes a waiting_steps row whose match_payload carries
   *     an AskUserDescriptor (prompt + serialized schema). The run suspends.
   *   - The webhook validates the inbound answer against the persisted
   *     descriptor (via parseAskUserDescriptor + validateAgainstSchema),
   *     then emits a synthetic `chorus.askUser:<runId>:<stepName>` event
   *     whose payload is `{ answer: <validated> }`. The dispatcher's
   *     unique-event-type guarantee routes the event to exactly this row.
   *   - Replay → resolved row → `step.askUser` returns the validated answer.
   *   - Replay during park → suspends again (deterministic).
   *   - Timeout → throws WaitForEventTimeoutError, same as waitForEvent.
   *
   * The gateway never invokes the handler directly; we ride waitForEvent
   * because it already gets the durability story right.
   */
  askUser(stepName: string, prompt: string, schema: AskUserSchema, opts?: AskUserOpts): Promise<unknown>;
  /**
   * Per-workflow (optionally per-user) durable KV store.
   *
   * Reads/writes are routed through `step.run(...)` so a crash between
   * a `set()` and the next replay re-executes the set idempotently. The
   * memoization key embeds the memory key, so different memory keys
   * don't collide inside a single run.
   *
   * Per-user scoping is automatic: the run's trigger payload is
   * inspected for `userId` (or `user.id`); when present, writes are
   * scoped to that user. Otherwise the row is workflow-global.
   */
  memory: MemoryStore;
}

export class Executor {
  private readonly helpers: QueryHelpers;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly credentialsFor: (integration: string) => Record<string, unknown> | null;

  constructor(private readonly opts: ExecutorOptions) {
    this.helpers = new QueryHelpers(opts.db);
    this.logger = opts.logger ?? consoleLogger();
    this.now = opts.now ?? (() => new Date());
    this.sleep =
      opts.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.credentialsFor = opts.credentialsFor ?? (() => null);
  }

  /**
   * Execute a workflow for a given run. Steps are written to the `steps`
   * table as they progress; a re-invocation for the same runId finds
   * completed steps and skips them (replay).
   */
  async run(
    workflow: Workflow,
    runId: string,
    triggerPayload: unknown,
  ): Promise<ExecutorResult> {
    const seenNames = new Set<string>();
    const logger = this.logger;

    // Extract userId for memory scoping. We look at `triggerPayload.userId`
    // first (the common case — webhook body, manual invocation, etc.)
    // and fall back to `triggerPayload.user.id` for providers that nest
    // the identity. Anything else → null (workflow-global namespace).
    const userId = extractUserId(triggerPayload);
    const workflowId = workflow.id;
    const helpers = this.helpers;
    const now = this.now;

    // Per-run mutex serializing the SQLite write critical sections of
    // step.run. Created fresh per run so two concurrent runs (different
    // runIds) don't contend on each other unnecessarily — SQLite's own
    // synchronous nature handles cross-run serialization at the DB layer.
    // Within a single run, parallel `step.fanOut` children DO need this:
    // their per-child step.run invocations interleave at the JS scheduler
    // boundary, and the read-then-write sequence (getCompletedStep →
    // upsertStep('running')) must observe a consistent view per name.
    // See packages/runtime/src/mutex.ts for the rationale + alternatives.
    const writeMutex = new Mutex();

    const makeStepContext = (): StepContext => ({
      run: async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        // Phase 1: memoization check + 'running' upsert under the write
        // mutex. Holding across both keeps the (read miss → insert running)
        // transition atomic w.r.t. concurrent step.run calls. Releases
        // BEFORE the handler awaits so handlers can run in parallel.
        let cachedOutput: string | undefined;
        let startedAt = "";
        await writeMutex.withLock(() => {
          if (seenNames.has(name)) {
            logger.warn(`duplicate step name "${name}" in run ${runId} — only first executes`);
          }
          seenNames.add(name);

          const completed = this.helpers.getCompletedStep(runId, name);
          if (completed && completed.output !== null && completed.output !== undefined) {
            cachedOutput = completed.output;
            return;
          }

          startedAt = this.now().toISOString();
          this.helpers.upsertStep({
            run_id: runId,
            step_name: name,
            attempt: 1,
            status: "running",
            input: null,
            output: null,
            error: null,
            error_sig_hash: null,
            started_at: startedAt,
            finished_at: null,
            duration_ms: null,
          });
        });

        if (cachedOutput !== undefined) {
          return JSON.parse(cachedOutput) as T;
        }

        // Phase 2: handler runs OUTSIDE the mutex — full parallelism.
        try {
          const out = await fn();
          // Phase 3: success upsert under the write mutex.
          await writeMutex.withLock(() => {
            const finishedAt = this.now().toISOString();
            this.helpers.upsertStep({
              run_id: runId,
              step_name: name,
              attempt: 1,
              status: "success",
              input: null,
              output: JSON.stringify(out ?? null),
              error: null,
              error_sig_hash: null,
              started_at: startedAt,
              finished_at: finishedAt,
              duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
            });
          });
          return out;
        } catch (err) {
          // SuspendForEvent is not a failure — it's a control signal that
          // the run must park. Do NOT overwrite the step row; the inner
          // waitForEvent already wrote a 'running' row on insert. Re-throw
          // so the outer run() catches it and returns status='waiting'.
          if (err instanceof SuspendForEvent) {
            throw err;
          }
          const e = err as Error;
          // Phase 3 (failure path): failed upsert under the write mutex.
          await writeMutex.withLock(() => {
            const finishedAt = this.now().toISOString();
            this.helpers.upsertStep({
              run_id: runId,
              step_name: name,
              attempt: 1,
              status: "failed",
              input: null,
              output: null,
              error: e.message,
              error_sig_hash: null,
              started_at: startedAt,
              finished_at: finishedAt,
              duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
            });
          });
          throw e;
        }
      },

      sleep: async (name: string, durationMs: number): Promise<void> => {
        // For MVP we implement in-process sleep (no cross-run durability on
        // sleep — full replay-across-restarts for sleep is v1.1).
        const completed = this.helpers.getCompletedStep(runId, name);
        if (completed) return;
        await this.sleep(durationMs);
        const nowIso = this.now().toISOString();
        this.helpers.upsertStep({
          run_id: runId,
          step_name: name,
          attempt: 1,
          status: "success",
          input: null,
          output: JSON.stringify({ slept: durationMs }),
          error: null,
          error_sig_hash: null,
          started_at: nowIso,
          finished_at: nowIso,
          duration_ms: durationMs,
        });
      },

      fanOut: async <TItem, TResult>(
        name: string,
        items: readonly TItem[],
        fn: (item: TItem, index: number) => Promise<TResult>,
      ): Promise<TResult[]> => {
        // Empty-input fast path: nothing to fan out, no step rows written.
        // Idiomatic Promise.all([]) returns []; we mirror that exactly.
        if (items.length === 0) {
          return [];
        }

        // Each child is an independent memoized step.run with a unique
        // name. Promise.allSettled (vs Promise.all) lets us drain ALL
        // children even when some fail — successful children's step.run
        // rows are written to disk before we surface the aggregate
        // failure, so a rerun replays them from cache. SuspendForEvent
        // children must propagate immediately, so we re-throw the first
        // suspension we see (other children's writes have already
        // completed via step.run's own write-mutex serialization, so we
        // don't lose their progress on park).
        const settled = await Promise.allSettled(
          items.map((item, index) =>
            // step.run's own naming check would fire on collisions;
            // ${name}.${index} is collision-free by construction.
            step.run(`${name}.${index}`, () => fn(item, index)),
          ),
        );

        // First pass: surface a SuspendForEvent immediately if any child
        // is parking. Their step rows have already been written by the
        // inner step.run's write-mutex critical sections — no progress
        // is lost. The outer run() will return status='waiting'.
        for (const r of settled) {
          if (r.status === "rejected" && r.reason instanceof SuspendForEvent) {
            throw r.reason;
          }
        }

        // Second pass: collect failures (NOT suspensions). If any child
        // genuinely failed, throw an AggregateError that carries every
        // child error in input order. Successful children remain
        // memoized — partial-failure rerun replays them.
        const failures: Array<{ index: number; error: unknown }> = [];
        const results: TResult[] = new Array(items.length);
        for (let i = 0; i < settled.length; i++) {
          const r = settled[i]!;
          if (r.status === "fulfilled") {
            results[i] = r.value;
          } else {
            failures.push({ index: i, error: r.reason });
          }
        }
        if (failures.length > 0) {
          // Use Node's built-in AggregateError so callers can introspect
          // `err.errors`. Preserve the original Error instances so stack
          // traces survive. Also carry the failed child names for ops
          // visibility — these are the rows that will re-execute on
          // rerun.
          const errs = failures.map((f) =>
            f.error instanceof Error ? f.error : new Error(String(f.error)),
          );
          const failedNames = failures
            .map((f) => `${name}.${f.index}`)
            .join(", ");
          const ag = new AggregateError(
            errs,
            `step.fanOut("${name}") had ${failures.length}/${items.length} failure(s) [${failedNames}]; on rerun, only failed children re-execute`,
          );
          throw ag;
        }
        return results;
      },

      waitForEvent: async (
        name: string,
        rawCall: WaitForEventCall,
      ): Promise<WaitForEventResult> => {
        const call = WaitForEventCallSchema.parse(rawCall);

        // 1. Fast-path: step already completed (prior resolution cached as
        //    a step row output, OR on replay we look at the waiting_steps
        //    row).
        const completedStep = this.helpers.getCompletedStep(runId, name);
        if (completedStep && completedStep.output) {
          // Previous resolution stored as the step's JSON output.
          return JSON.parse(completedStep.output) as WaitForEventResult;
        }

        // 2. Look up the waiting_steps row for this run+step.
        const existing = this.helpers.getWaitingStep(runId, name);

        if (existing && existing.resolved_at) {
          // Already resolved (by dispatcher or timeout expiry). Complete
          // the step durably and return the result — OR throw timeout.
          if (existing.resolved_event_id === TIMEOUT_EVENT_ID) {
            const finishedAt = this.now().toISOString();
            this.helpers.upsertStep({
              run_id: runId,
              step_name: name,
              attempt: 1,
              status: "failed",
              input: JSON.stringify(call),
              output: null,
              error: `timed out after ${call.timeoutMs}ms`,
              error_sig_hash: null,
              started_at: existing.resolved_at,
              finished_at: finishedAt,
              duration_ms: 0,
            });
            throw new WaitForEventTimeoutError(call.eventType, call.timeoutMs);
          }

          const event = this.helpers.getEvent(existing.resolved_event_id ?? "");
          if (!event) {
            // Should never happen (resolve writes the event id), but handle
            // defensively — treat as timeout to keep replay deterministic.
            throw new WaitForEventTimeoutError(call.eventType, call.timeoutMs);
          }
          const result: WaitForEventResult = {
            event: {
              id: event.id,
              type: event.type,
              payload: safeParseJsonExecutor(event.payload),
              source: event.source,
              correlationId: event.correlation_id,
              emittedAt: event.emitted_at,
            },
          };
          const finishedAt = this.now().toISOString();
          this.helpers.upsertStep({
            run_id: runId,
            step_name: name,
            attempt: 1,
            status: "success",
            input: JSON.stringify(call),
            output: JSON.stringify(result),
            error: null,
            error_sig_hash: null,
            started_at: existing.resolved_at,
            finished_at: finishedAt,
            duration_ms: 0,
          });
          return result;
        }

        // 3. Insert or refresh the waiting_steps row (first call or replay
        //    while still pending).
        if (!existing) {
          const startedAt = this.now().toISOString();
          const expiresAt = new Date(
            Date.parse(startedAt) + call.timeoutMs,
          ).toISOString();
          this.helpers.insertWaitingStep({
            id: randomUUID(),
            run_id: runId,
            step_name: name,
            event_type: call.eventType,
            match_payload: call.matchPayload
              ? JSON.stringify(call.matchPayload)
              : null,
            match_correlation_id: call.matchCorrelationId ?? null,
            expires_at: expiresAt,
            resolved_at: null,
            resolved_event_id: null,
          });
          // Also write a 'running' step row so the steps table reflects the
          // wait. It'll be upserted to 'success'/'failed' on resolve/timeout.
          this.helpers.upsertStep({
            run_id: runId,
            step_name: name,
            attempt: 1,
            status: "running",
            input: JSON.stringify(call),
            output: null,
            error: null,
            error_sig_hash: null,
            started_at: startedAt,
            finished_at: null,
            duration_ms: null,
          });
        }

        // 4. Suspend — throw a control-flow signal the outer run() catches.
        throw new SuspendForEvent(name, call.eventType);
      },

      askUser: async (
        name: string,
        prompt: string,
        schema: AskUserSchema,
        opts?: AskUserOpts,
      ): Promise<unknown> => {
        // The webhook handler reads the descriptor back from the
        // waiting_steps row's match_payload column, validates the answer
        // against it, and emits the synthetic event below. Storing the
        // descriptor in match_payload (vs a sidecar table) keeps everything
        // durable in the row that already has to exist for waitForEvent.
        const descriptor = buildAskUserDescriptor(prompt, schema);
        const eventType = askUserEventType(runId, name);
        const timeoutMs = opts?.timeoutMs ?? ASK_USER_DEFAULT_TIMEOUT_MS;

        // Delegate to step.waitForEvent — same memoization, same parking,
        // same restart-survival. The descriptor rides as matchPayload; the
        // dispatcher's askUser-aware match path (in waitingStepMatches)
        // bypasses the filter check because the unique event type already
        // pins this event to this (runId, stepName) pair.
        const result = await step.waitForEvent(name, {
          eventType,
          // matchPayload type is Record<string, unknown> — the descriptor
          // is structurally compatible.
          matchPayload: descriptor as unknown as Record<string, unknown>,
          timeoutMs,
        });

        // The webhook emits `{ answer: <validated value> }`. Unwrap.
        const payload = result.event.payload;
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          "answer" in (payload as Record<string, unknown>)
        ) {
          return (payload as Record<string, unknown>)["answer"];
        }
        // Defensive — the webhook always wraps in {answer}, but if a test
        // bypasses the gateway and emits a raw event we return the payload
        // unchanged rather than crash.
        return payload;
      },

      memory: {
        // Both get and set are routed through step.run(...) so repeated
        // executions of the same handler (replay, retries) don't
        // duplicate writes or misattribute reads. The step name embeds
        // the memory key so different keys get different memoization
        // slots inside the same run.
        //
        // NOTE: These closures reference `step` declared below
        // `makeStepContext()`. That's safe — the closures only dereference
        // `step` when invoked (after `const step = makeStepContext()`
        // runs), not when the object literal is constructed.
        get: async (key: string): Promise<unknown> => {
          return step.run(
            `memory:get:${key}`,
            async () => {
              const row = helpers.getMemory(workflowId, userId, key);
              if (!row) return null;
              try {
                return JSON.parse(row.value_json);
              } catch {
                // Defensive — a corrupted row shouldn't crash the run.
                logger.warn(
                  `memory:get:${key} — stored value is not valid JSON, returning null`,
                );
                return null;
              }
            },
          );
        },
        set: async (key: string, value: unknown): Promise<void> => {
          // The set is routed through a step.run so a crash between the
          // SQLite write and the next cache-miss replay is idempotent:
          // the memoized output (undefined) short-circuits the second
          // write. Even without memoization the upsert is idempotent by
          // PK, but step.run keeps the write semantically "once per run
          // + key".
          await step.run(`memory:set:${key}`, async () => {
            helpers.upsertMemory({
              workflow_id: workflowId,
              user_id: userId,
              key,
              value_json: JSON.stringify(value ?? null),
              updated_at: now().getTime(),
            });
            return null;
          });
        },
      },
    });

    const step: StepContext = makeStepContext();
    const steps: StepRow[] = [];

    // Track per-node outputs (keyed by node.id) so `Connection.when?`
    // expressions on outgoing edges can reference the source node's
    // result. A node is "skipped" if NO incoming edge evaluates to true;
    // skipped nodes don't run but also don't propagate (their absence
    // deactivates downstream edges automatically).
    const nodeOutputs = new Map<string, unknown>();
    const skippedNodes = new Set<string>();
    const connections = workflow.connections ?? [];

    try {
      for (const node of workflow.nodes) {
        // Decide whether to execute this node based on incoming edges.
        const incoming = connections.filter((c) => c.to === node.id);
        let shouldRun: boolean;
        if (incoming.length === 0) {
          // Root node (no incoming edges) — always runs. This preserves
          // the pre-`when?` MVP behavior for workflows with no
          // connections declared at all.
          shouldRun = true;
        } else {
          // Run iff at least one incoming edge is "active":
          //   • source node was not skipped
          //   • source node has a recorded output (it ran successfully)
          //   • the edge's `when?`, if present, evaluates to true
          shouldRun = false;
          for (const conn of incoming) {
            if (skippedNodes.has(conn.from)) continue;
            if (!nodeOutputs.has(conn.from)) continue;
            const sourceOutput = nodeOutputs.get(conn.from);
            let pass: boolean;
            if (conn.when && conn.when.trim().length > 0) {
              pass = await evalWhen(
                conn.when,
                {
                  result: sourceOutput,
                  input: triggerPayload,
                  nodeId: conn.from,
                },
                logger,
              );
            } else {
              pass = true;
            }
            if (pass) {
              shouldRun = true;
              break;
            }
          }
        }

        if (!shouldRun) {
          skippedNodes.add(node.id);
          logger.debug(
            `node ${node.id} skipped — no active incoming edges`,
          );
          continue;
        }

        const output = await step.run(node.id, () =>
          this.invokeNode(node, triggerPayload, step),
        );
        nodeOutputs.set(node.id, output);
        const stepRow = this.helpers.getStep(runId, node.id);
        if (stepRow) steps.push(stepRow);
        if (output === undefined) continue;
      }
      return { runId, status: "success", steps };
    } catch (err) {
      // Suspension signal: the run is parked on a waiting_steps row. Return
      // status='waiting' — the dispatch loop will re-enqueue when the event
      // arrives or timeout expires. This is NOT a failure.
      if (err instanceof SuspendForEvent) {
        logger.info(
          `run ${runId} suspended in step "${err.stepName}" waiting for event "${err.eventType}"`,
        );
        return {
          runId,
          status: "waiting",
          steps: this.helpers.listSteps(runId),
          waitingOn: { stepName: err.stepName, eventType: err.eventType },
        };
      }
      const e = err as Error;
      logger.error(`run ${runId} failed: ${e.message}`);
      return {
        runId,
        status: "failed",
        steps: this.helpers.listSteps(runId),
        error: e.message,
      };
    }
  }

  /**
   * Invoke a single node with retry + backoff, plus optional fallback chain.
   * Exposed as a named method so tests can stub invocation cleanly.
   *
   * Execution model:
   *   1. Try primary `(node.integration, node.operation)` with the node's
   *      retry policy. Each attempt runs in-process; failures are retried
   *      per `computeBackoff`, capped at `retry.maxAttempts`. Suspension
   *      signals (waitForEvent) propagate without retry.
   *   2. If the primary exhausts its retry budget AND `node.fallbacks` is
   *      non-empty, iterate fallbacks in declaration order. Each fallback
   *      attempt is wrapped in `stepCtx.run('<nodeId>.fallback.<i>', ...)`
   *      so it gets its own memoized step row — replay short-circuits a
   *      cached fallback success without re-invoking. Fallbacks themselves
   *      get NO retry budget (single attempt each); per spec they're
   *      single-level only and meant to be drop-in alternatives.
   *   3. First fallback success returns its output as the node's output.
   *   4. If every fallback also fails, throw `FallbacksExhaustedError`
   *      carrying the original primary failure (most diagnostically useful)
   *      plus a list of the attempted fallbacks and their errors.
   *
   * When `stepCtx` is provided, it's attached to the OperationContext as a
   * `step` property so integration handlers can call `step.run(...)` and
   * `step.waitForEvent(...)` as sub-steps within a single node. Handlers
   * opt-in by destructuring; otherwise the field is ignored. `stepCtx` is
   * also REQUIRED to invoke fallbacks (we use it to write their step rows);
   * if a node declares fallbacks but is invoked without stepCtx, we throw
   * an explicit error rather than silently skipping them.
   */
  async invokeNode(
    node: WorkflowNode,
    triggerPayload: unknown,
    stepCtx?: StepContext,
  ): Promise<unknown> {
    const retryCfg = node.retry
      ? {
          maxAttempts: node.retry.maxAttempts,
          backoffMs: node.retry.backoffMs,
          multiplier: 2,
          jitter: node.retry.jitter,
        }
      : DEFAULT_RETRY;

    const ctx: OperationContext = {
      credentials: this.credentialsFor(node.integration),
      logger: this.logger,
      signal: this.opts.signal ?? new AbortController().signal,
    };
    if (stepCtx) {
      // Structural extension — existing handlers ignore, handlers that
      // opt-in read ctx.step from a cast.
      (ctx as OperationContext & { step: StepContext }).step = stepCtx;
    }

    // ── Primary attempt with retry budget ──────────────────────────────
    const primaryResult = await this.tryPrimary(node, triggerPayload, ctx, retryCfg);
    if (primaryResult.kind === "success") {
      return primaryResult.value;
    }
    const primaryErr = primaryResult.error;

    // ── Fallback chain ─────────────────────────────────────────────────
    const fallbacks = node.fallbacks ?? [];
    if (fallbacks.length === 0) {
      throw primaryErr;
    }
    if (!stepCtx) {
      // Defensive: invokeNode is callable without stepCtx (some tests do
      // this), but fallbacks REQUIRE per-attempt memoized step rows. If
      // someone declares fallbacks without going through run(), surface
      // the misuse rather than silently dropping fallbacks.
      throw new Error(
        `node ${node.id} declares ${fallbacks.length} fallbacks but was invoked without a StepContext`,
      );
    }

    const attempts: Array<{ integration: string; operation: string; error: string }> = [];
    for (let i = 0; i < fallbacks.length; i++) {
      const fb = fallbacks[i]!;
      const fbStepName = `${node.id}.fallback.${i}`;
      try {
        // step.run gives us memoization: on replay, a previously-successful
        // fallback short-circuits without re-invocation. step.run also
        // writes the step row, so the audit trail records exactly which
        // fallback ran. Pre-existing failed fallback rows DO re-execute
        // (step.run only short-circuits on status='success').
        const out = await stepCtx.run(fbStepName, async () => {
          return await this.invokeFallback(node, fb, triggerPayload, ctx);
        });
        return out;
      } catch (err) {
        if (err instanceof SuspendForEvent) throw err;
        const fbErr = err as Error;
        attempts.push({
          integration: fb.integration,
          operation: fb.operation,
          error: fbErr.message,
        });
        this.logger.warn(
          `node ${node.id} fallback[${i}] (${fb.integration}/${fb.operation}) failed: ${fbErr.message}`,
        );
      }
    }

    // All fallbacks failed.
    throw new FallbacksExhaustedError({
      message: `node ${node.id}: primary (${node.integration}/${node.operation}) and all ${fallbacks.length} fallback(s) failed; original error: ${primaryErr.message}`,
      integration: node.integration,
      operation: node.operation,
      cause: primaryErr,
      fallbackAttempts: attempts,
    });
  }

  /**
   * Run the primary handler with the node's retry budget. Returns either
   * `{ kind: 'success', value }` or `{ kind: 'failed', error }` so the
   * caller (invokeNode) can decide to invoke fallbacks vs. propagate.
   *
   * Suspension signals (`SuspendForEvent`) propagate via throw — they're
   * NOT failures and never trigger fallbacks.
   */
  private async tryPrimary(
    node: WorkflowNode,
    triggerPayload: unknown,
    ctx: OperationContext,
    retryCfg: RetryPolicy,
  ): Promise<{ kind: "success"; value: unknown } | { kind: "failed"; error: Error }> {
    const handler = await this.resolveHandler(node);
    const input = { ...(node.inputs ?? {}), triggerPayload };

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= retryCfg.maxAttempts; attempt++) {
      if (this.opts.signal?.aborted) {
        throw new Error("Executor aborted");
      }
      try {
        const value = await handler(input, ctx);
        return { kind: "success", value };
      } catch (err) {
        // Suspension signals are NOT retryable — they're cooperative pauses
        // for waitForEvent. Propagate immediately.
        if (err instanceof SuspendForEvent) throw err;
        lastErr = err as Error;
        if (attempt >= retryCfg.maxAttempts) break;
        if (node.onError === "fail") break;
        const delay = computeBackoff(retryCfg, attempt);
        this.logger.warn(
          `node ${node.id} attempt ${attempt} failed: ${lastErr.message}; backing off ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }
    return { kind: "failed", error: lastErr ?? new Error("Unknown executor error") };
  }

  /**
   * Invoke a single fallback once, with no retry. Resolves the alternate
   * integration/operation and runs it with the SAME inputs the primary
   * received (per NodeRefSchema docstring: drop-in alternative). Throws on
   * failure so the caller can record the attempt and proceed to the next
   * fallback.
   *
   * The credentials passed to the fallback handler are scoped to the
   * fallback's integration (NOT the primary's), since they're separate
   * connectors that may use entirely different services.
   */
  private async invokeFallback(
    primaryNode: WorkflowNode,
    fb: NodeRef,
    triggerPayload: unknown,
    primaryCtx: OperationContext,
  ): Promise<unknown> {
    const mod = await this.opts.integrationLoader(fb.integration);
    const handler = mod.operations[fb.operation];
    if (!handler) {
      throw new Error(
        `Fallback integration "${fb.integration}" has no operation "${fb.operation}"`,
      );
    }
    const input = { ...(primaryNode.inputs ?? {}), triggerPayload };
    // Re-resolve credentials for the fallback's integration (different
    // service → different credential row). We carry over signal/logger
    // and the optional `step` property so handlers retain access to
    // sub-step capabilities even inside a fallback.
    const fbCtx: OperationContext = {
      credentials: this.credentialsFor(fb.integration),
      logger: this.logger,
      signal: this.opts.signal ?? new AbortController().signal,
    };
    const stepProp = (primaryCtx as OperationContext & { step?: StepContext }).step;
    if (stepProp) {
      (fbCtx as OperationContext & { step: StepContext }).step = stepProp;
    }
    return await handler(input, fbCtx);
  }

  private async resolveHandler(node: WorkflowNode): Promise<OperationHandler> {
    const mod = await this.opts.integrationLoader(node.integration);
    const op = mod.operations[node.operation];
    if (!op) {
      throw new Error(
        `Integration "${node.integration}" has no operation "${node.operation}"`,
      );
    }
    return op;
  }
}

export function computeBackoff(p: RetryPolicy, attempt: number): number {
  const base = p.backoffMs * Math.pow(p.multiplier, attempt - 1);
  const capped = Math.min(base, 5 * 60_000);
  if (!p.jitter) return capped;
  const delta = capped * 0.2;
  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * delta));
}

function consoleLogger(): Logger {
  return {
    debug: () => {},
    info: (m) => console.info(`[runtime] ${m}`),
    warn: (m) => console.warn(`[runtime] ${m}`),
    error: (m) => console.error(`[runtime] ${m}`),
  };
}

function safeParseJsonExecutor(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Derive a user-scope identifier from the run's trigger payload for
 * use with `step.memory`. Supports the two shapes most commonly produced
 * by webhook/manual triggers:
 *
 *   { userId: "abc" }         → "abc"
 *   { user: { id: "abc" } }   → "abc"
 *
 * Anything else (undefined, wrong type, absent) yields null — the
 * workflow-global namespace.
 */
function extractUserId(triggerPayload: unknown): string | null {
  if (!triggerPayload || typeof triggerPayload !== "object") return null;
  const p = triggerPayload as Record<string, unknown>;
  const direct = p["userId"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = p["user"];
  if (nested && typeof nested === "object") {
    const nid = (nested as Record<string, unknown>)["id"];
    if (typeof nid === "string" && nid.length > 0) return nid;
  }
  return null;
}
