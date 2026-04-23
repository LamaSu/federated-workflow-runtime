import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import type { IntegrationLoader, SubgraphRunner } from "./executor.js";
import type { ManifestLookup, RefreshFn } from "./oauth.js";
import type { ReputationLookup } from "./trust-policy.js";
import { openDatabase, QueryHelpers, type DatabaseType, type RunRow } from "./db.js";
import { loadKeyFromEnv } from "./credentials.js";
import { RunQueue } from "./queue.js";
import { Executor } from "./executor.js";
import { CronScheduler } from "./triggers/cron.js";
import { WebhookRegistry } from "./triggers/webhook.js";
import { ManualTrigger } from "./triggers/manual.js";
import { OAuthRefresher } from "./oauth.js";
import { ExpiryAlarm } from "./expiry-alarm.js";
import { registerApiRoutes } from "./api/index.js";
import { registerAskRoutes } from "./ask-routes.js";
import type { EventDispatcher } from "./triggers/event.js";
import { getDashboardHtml, getDashboardEtag } from "./static/holder.js";

/**
 * Fastify server composition per ARCHITECTURE §4.
 *
 * Wires the independently-tested pieces together:
 *  - SQLite DB + migrations
 *  - Run queue
 *  - Executor (driven by a polling loop; see `runLoop()`)
 *  - Cron scheduler
 *  - Webhook registry (Fastify routes)
 *  - OAuth refresher (background cron)
 *
 * Exposes the minimal MVP HTTP surface:
 *  - GET  /health
 *  - GET  /workflows
 *  - GET  /runs/:id
 */

export interface CreateServerOptions {
  /** SQLite DB path; `:memory:` for tests. */
  dbPath: string;
  /** Integration loader — how we resolve action code for each node. */
  integrationLoader: IntegrationLoader;
  /**
   * OAuth refresh implementation (see oauth.ts). Optional — when omitted,
   * the refresher uses `defaultOAuth2Refresh` against each credential
   * type's oauth metadata (requires `manifestLookup`).
   */
  refreshOAuth?: RefreshFn;
  /**
   * Manifest lookup used by the OAuth refresher's default path and the
   * credential-catalog-aware credential accessor. When omitted, only
   * legacy credentials without a catalog entry will work.
   */
  manifestLookup?: ManifestLookup;
  /**
   * Event dispatcher used by the expiry-alarm cron to emit
   * `credential.expiring` events for non-OAuth credentials approaching
   * their rotation horizon. Optional — omit to disable the alarm.
   */
  eventDispatcher?: EventDispatcher;
  /** Encryption key. Defaults to loading from env per credentials.ts. */
  encryptionKey?: Buffer;
  /** Bind port for Fastify. Not auto-listened; the caller decides. */
  listen?: { port: number; host?: string };
  /** Max body size in bytes (default 1 MB per §4.2). */
  bodyLimitBytes?: number;
  /**
   * Bearer token required on /api/* requests. When omitted/empty, the API is
   * accessible without auth — callers MUST bind to 127.0.0.1.
   * Defaults to `process.env.CHORUS_API_TOKEN` if that env var is set.
   */
  apiToken?: string | null;
  /**
   * Wave 3 — opt-in worknet receiver. When set, mounts POST /api/run +
   * GET /api/run/:id/status (handled in api/remote-run.ts). Default OFF;
   * the CLI flag `chorus run --remote-callable` toggles this on. The
   * default 127.0.0.1 binding is preserved either way — operators who
   * want callers from outside also rebind via `chorus run --host 0.0.0.0`.
   */
  remoteCallable?: {
    /**
     * Optional Ed25519 pubkey allowlist (base64). When set, only callers
     * whose `callerIdentity.publicKey` appears in this list are accepted.
     * Empty/omitted → accept any caller whose signature verifies.
     */
    acceptedCallers?: string[];
    /**
     * Reputation lookup. Forwarded into the trust validator so callers'
     * `trustPolicy.minReputation` hints can be honored. When absent, calls
     * with minReputation in their trustPolicy are rejected (fail-closed).
     */
    getOperatorReputation?: ReputationLookup;
    /** Override the timestamp skew window (default ±5min). */
    timestampSkewMs?: number;
    /** Override `now` (test hook). */
    now?: () => number;
  };
}

export interface ChorusServer {
  app: FastifyInstance;
  db: DatabaseType;
  queue: RunQueue;
  executor: Executor;
  cronScheduler: CronScheduler;
  webhookRegistry: WebhookRegistry;
  manualTrigger: ManualTrigger;
  oauthRefresher?: OAuthRefresher;
  expiryAlarm?: ExpiryAlarm;
  /** Run one pass of the executor loop. Primarily for tests. */
  tick(): Promise<void>;
  /** Start the continuous executor loop. Returns a stop() function. */
  startLoop(intervalMs?: number): () => void;
  close(): Promise<void>;
}

export function createServer(opts: CreateServerOptions): ChorusServer {
  const key = opts.encryptionKey ?? loadKeyFromEnv();
  const db = openDatabase(opts.dbPath);
  const helpers = new QueryHelpers(db);
  const queue = new RunQueue(db);
  // Default subgraphRunner — wired so `integration: "workflow"` nodes
  // resolve a child workflow + execute it inline against the SAME
  // Executor instance. We close over `executor` (declared just below); the
  // closure isn't invoked until a node actually calls `ctx.runWorkflow`,
  // by which time `executor` is assigned.
  //
  // Why inline (not enqueue): we want the child to run synchronously from
  // the parent's POV so the parent's `step.run` for the subgraph node
  // wraps the entire child execution in ONE memoized step. If we enqueued
  // and waited, we'd have to either poll the queue (ugly) or hand off to
  // the dispatcher (which would steal CPU from the parent and break the
  // memoization invariant — the child run could span multiple ticks).
  //
  // We DO write a `runs` row for the child so it shows up in the runs
  // table for attribution and `chorus run history <child-runId>` works.
  // The child's row is set to status='running' on creation, then to
  // 'success'/'failed'/'waiting' after executor.run returns.
  let executor: Executor;
  const subgraphRunner: SubgraphRunner = async (
    workflowId,
    triggerPayload,
    options,
  ) => {
    const wfRow = helpers.getWorkflow(workflowId, options?.version);
    if (!wfRow) {
      const versionLabel = options?.version !== undefined ? `@${options.version}` : "";
      throw new Error(
        `subgraph: workflow "${workflowId}${versionLabel}" not found in workflows table`,
      );
    }
    const childRunId = randomUUID();
    const nowIso = new Date().toISOString();
    const childRow: RunRow = {
      id: childRunId,
      workflow_id: wfRow.id,
      workflow_version: wfRow.version,
      status: "running",
      triggered_by: "subgraph",
      trigger_payload:
        triggerPayload === undefined ? null : JSON.stringify(triggerPayload),
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: nowIso,
      finished_at: null,
      error: null,
      attempt: 1,
    };
    helpers.insertRun(childRow);

    try {
      const childWorkflow = JSON.parse(wfRow.definition);
      const result = await executor.run(childWorkflow, childRunId, triggerPayload);

      const finishedAt = new Date().toISOString();
      // Update the runs row based on the child's terminal status.
      if (result.status === "success") {
        db.prepare(
          `UPDATE runs SET status = 'success', finished_at = ? WHERE id = ?`,
        ).run(finishedAt, childRunId);
        // Terminal output = last step's output. The executor's result.steps
        // is in declaration order; use the last entry's parsed output. If
        // there are no steps (an empty-nodes workflow), output is null.
        const lastStep = result.steps[result.steps.length - 1];
        const output =
          lastStep && lastStep.output ? safeParseJson(lastStep.output) : null;
        return { runId: childRunId, output };
      } else if (result.status === "waiting") {
        // The child parked on a waiting_steps row (e.g. it asked the user
        // a question). MVP behavior: surface as an error to the parent
        // because we don't yet support the parent suspending on a child's
        // wait. A future iteration could propagate the suspend through the
        // subgraph node so the parent ALSO parks; for now, fail fast.
        db.prepare(
          `UPDATE runs SET status = 'waiting', finished_at = ?, error = ? WHERE id = ?`,
        ).run(
          finishedAt,
          `child run parked on event "${result.waitingOn?.eventType ?? "unknown"}"`,
          childRunId,
        );
        throw new Error(
          `subgraph: child "${workflowId}" suspended on event "${result.waitingOn?.eventType ?? "unknown"}" (subgraph-from-event suspension not supported in MVP)`,
        );
      } else {
        db.prepare(
          `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
        ).run(finishedAt, result.error ?? "unknown failure", childRunId);
        throw new Error(
          `subgraph: child "${workflowId}" failed: ${result.error ?? "unknown"}`,
        );
      }
    } catch (err) {
      // Defensive: even if executor.run threw before terminating, mark
      // the child run as failed so it doesn't sit in 'running' forever.
      // The thrown error is re-raised so the parent step.run records it.
      const finishedAt = new Date().toISOString();
      db.prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'`,
      ).run(finishedAt, (err as Error).message, childRunId);
      throw err;
    }
  };
  executor = new Executor({
    db,
    integrationLoader: opts.integrationLoader,
    subgraphRunner,
  });
  const cronScheduler = new CronScheduler({ queue });
  const webhookRegistry = new WebhookRegistry({ queue });
  const manualTrigger = new ManualTrigger(queue);

  const app = Fastify({
    logger: false,
    bodyLimit: opts.bodyLimitBytes ?? 1 * 1024 * 1024,
  });

  // Webhooks attach on the shared app instance.
  webhookRegistry.installRoutes(app);

  // Read-only JSON API for agent-built dashboards (see ./api).
  // When an event dispatcher is wired, POST /api/events + event routes
  // also mount (see ./api/events.ts).
  const apiToken =
    opts.apiToken !== undefined
      ? opts.apiToken
      : process.env.CHORUS_API_TOKEN && process.env.CHORUS_API_TOKEN.length > 0
        ? process.env.CHORUS_API_TOKEN
        : null;
  registerApiRoutes(app, db, {
    apiToken,
    eventDispatcher: opts.eventDispatcher,
    // Wave 3 — wire the worknet receiver routes through. registerApiRoutes
    // mounts them ONLY when this option is set so `chorus run` (without
    // --remote-callable) leaves no remote-invocation surface exposed.
    remoteCallable: opts.remoteCallable,
  });

  // POST /ask/:runId/:stepName — webhook endpoint for step.askUser answers.
  // Only mounts when an event dispatcher is configured (otherwise there's
  // nowhere to route the resulting synthetic event).
  if (opts.eventDispatcher) {
    registerAskRoutes(app, db, { dispatcher: opts.eventDispatcher });
  }

  // Ambient dashboard --------------------------------------------------------
  // `/` and `/dashboard` serve the current dashboard HTML (minimal by
  // default; may be upgraded at startup by an LLM-generated custom build
  // via `start-server.ts` → `setDashboard()`). Kept thin so tests don't
  // have to load files off disk; the HTML is embedded as a TS constant in
  // `./static/index.ts`.
  const serveDashboard = async (
    _req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string> => {
    const html = getDashboardHtml();
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-cache");
    reply.header("ETag", getDashboardEtag());
    return html;
  };
  app.get("/", serveDashboard);
  app.get("/dashboard", serveDashboard);

  // Health & introspection routes -------------------------------------------
  app.get("/health", async () => ({
    status: "ok",
    pending: queue.pendingCount(),
    timestamp: new Date().toISOString(),
  }));

  app.get("/workflows", async () => {
    const rows = db
      .prepare(
        `SELECT id, version, name, active, created_at, updated_at FROM workflows ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      id: string;
      version: number;
      name: string;
      active: number;
      created_at: string;
      updated_at: string;
    }>;
    return {
      workflows: rows.map((r) => ({
        id: r.id,
        version: r.version,
        name: r.name,
        active: r.active === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const run = helpers.getRun(req.params.id);
    if (!run) {
      reply.code(404);
      return { error: "NOT_FOUND" };
    }
    const steps = helpers.listSteps(req.params.id);
    return {
      run: {
        id: run.id,
        workflowId: run.workflow_id,
        workflowVersion: run.workflow_version,
        status: run.status,
        triggeredBy: run.triggered_by,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        error: run.error,
        attempt: run.attempt,
      },
      steps: steps.map((s) => ({
        runId: s.run_id,
        stepName: s.step_name,
        attempt: s.attempt,
        status: s.status,
        output: s.output ? JSON.parse(s.output) : null,
        error: s.error,
        durationMs: s.duration_ms,
      })),
    };
  });

  // OAuth refresher ----------------------------------------------------------
  // Start the refresher when either a custom refresh function is supplied
  // (legacy path) OR a manifestLookup is wired (catalog-driven path). A
  // caller providing neither explicitly disables OAuth refresh.
  let oauthRefresher: OAuthRefresher | undefined;
  if (opts.refreshOAuth || opts.manifestLookup) {
    oauthRefresher = new OAuthRefresher({
      db,
      key,
      refresh: opts.refreshOAuth,
      manifestLookup: opts.manifestLookup,
    });
    oauthRefresher.start();
  }

  // Expiry alarm (non-OAuth credentials) -------------------------------------
  // Only starts when an event dispatcher is wired — otherwise there's
  // nowhere to send `credential.expiring` events.
  let expiryAlarm: ExpiryAlarm | undefined;
  if (opts.eventDispatcher) {
    expiryAlarm = new ExpiryAlarm({
      db,
      dispatcher: opts.eventDispatcher,
    });
    expiryAlarm.start();
  }

  // Executor loop ------------------------------------------------------------
  /**
   * Poll for claimable runs, load the workflow, execute it.
   * Single-writer discipline: we don't spawn concurrent runs inside this
   * instance because a single better-sqlite3 process serializes writers
   * anyway. For parallelism, the architecture calls for subprocess workers
   * (v2) — MVP keeps it simple.
   */
  async function tick(): Promise<void> {
    const claimed = queue.claim();
    if (!claimed) return;
    const wfRow = helpers.getWorkflow(claimed.workflow_id, claimed.workflow_version);
    if (!wfRow) {
      queue.complete(claimed.id, "failed", {
        error: `workflow ${claimed.workflow_id}@${claimed.workflow_version} not found`,
      });
      return;
    }
    try {
      const workflow = JSON.parse(wfRow.definition);
      const payload = claimed.trigger_payload ? JSON.parse(claimed.trigger_payload) : null;
      const result = await executor.run(workflow, claimed.id, payload);
      if (result.status === "success") {
        queue.complete(claimed.id, "success");
      } else if (result.status === "waiting") {
        // Run is parked on a waiting_steps row. Release it back to the
        // queue without a next_wakeup — the event dispatcher's emit/expire
        // paths will call queue.release() when the waiting_steps row
        // resolves, making the run immediately re-claimable. See §6.
        queue.release(claimed.id);
      } else {
        queue.complete(claimed.id, "failed", { error: result.error ?? "unknown failure" });
      }
    } catch (err) {
      queue.complete(claimed.id, "failed", {
        error: `executor crashed: ${(err as Error).message}`,
      });
    }
  }

  function startLoop(intervalMs = 100): () => void {
    let stopped = false;
    const loop = async (): Promise<void> => {
      while (!stopped) {
        await tick();
        await new Promise<void>((r) => setTimeout(r, intervalMs));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }

  const close = async (): Promise<void> => {
    expiryAlarm?.stop();
    oauthRefresher?.stop();
    cronScheduler.shutdown();
    await app.close();
    db.close();
  };

  return {
    app,
    db,
    queue,
    executor,
    cronScheduler,
    webhookRegistry,
    manualTrigger,
    oauthRefresher,
    expiryAlarm,
    tick,
    startLoop,
    close,
  };
}

/**
 * Defensive JSON parse — used by the subgraph runner to surface a child's
 * terminal output. A corrupted column shouldn't crash the parent run.
 */
function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
