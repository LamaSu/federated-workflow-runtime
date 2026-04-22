import { randomUUID } from "node:crypto";
import type {
  IntegrationModule,
  Logger,
  Node as WorkflowNode,
  OperationContext,
  OperationHandler,
  WaitForEventCall,
  Workflow,
} from "@delightfulchorus/core";
import { WaitForEventCallSchema } from "@delightfulchorus/core";
import type { DatabaseType, StepRow } from "./db.js";
import { QueryHelpers } from "./db.js";
import { TIMEOUT_EVENT_ID } from "./triggers/event.js";
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

    const makeStepContext = (): StepContext => ({
      run: async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (seenNames.has(name)) {
          logger.warn(`duplicate step name "${name}" in run ${runId} — only first executes`);
        }
        seenNames.add(name);

        const completed = this.helpers.getCompletedStep(runId, name);
        if (completed && completed.output !== null && completed.output !== undefined) {
          return JSON.parse(completed.output) as T;
        }

        const startedAt = this.now().toISOString();
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

        try {
          const out = await fn();
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
    });

    const step = makeStepContext();
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
   * Invoke a single node with retry + backoff. Exposed as a named method so
   * tests can stub invocation cleanly.
   *
   * When `stepCtx` is provided, it's attached to the OperationContext as a
   * `step` property so integration handlers can call `step.run(...)` and
   * `step.waitForEvent(...)` as sub-steps within a single node. Handlers
   * opt-in by destructuring; otherwise the field is ignored.
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

    const handler = await this.resolveHandler(node);
    const input = { ...(node.inputs ?? {}), triggerPayload };
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

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= retryCfg.maxAttempts; attempt++) {
      if (this.opts.signal?.aborted) {
        throw new Error("Executor aborted");
      }
      try {
        return await handler(input, ctx);
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
    throw lastErr ?? new Error("Unknown executor error");
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
