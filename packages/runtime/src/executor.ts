import type {
  IntegrationModule,
  Logger,
  Node as WorkflowNode,
  OperationContext,
  OperationHandler,
  Workflow,
} from "@chorus/core";
import type { DatabaseType, StepRow } from "./db.js";
import { QueryHelpers } from "./db.js";

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
  status: "success" | "failed";
  steps: StepRow[];
  error?: string;
}

/**
 * A `StepContext` is what's passed to each Action so that it can declare
 * named, memoized sub-steps. The outer node invocation is itself wrapped in
 * a step so a full-process restart replays the cached output.
 */
export interface StepContext {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
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
    });

    const step = makeStepContext();
    const steps: StepRow[] = [];

    try {
      for (const node of workflow.nodes) {
        const output = await step.run(node.id, () =>
          this.invokeNode(node, triggerPayload),
        );
        const stepRow = this.helpers.getStep(runId, node.id);
        if (stepRow) steps.push(stepRow);
        if (output === undefined) continue;
      }
      return { runId, status: "success", steps };
    } catch (err) {
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
   */
  async invokeNode(node: WorkflowNode, triggerPayload: unknown): Promise<unknown> {
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

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= retryCfg.maxAttempts; attempt++) {
      if (this.opts.signal?.aborted) {
        throw new Error("Executor aborted");
      }
      try {
        return await handler(input, ctx);
      } catch (err) {
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
