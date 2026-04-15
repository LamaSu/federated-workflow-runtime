import Fastify, { type FastifyInstance } from "fastify";
import type { IntegrationLoader } from "./executor.js";
import type { ManifestLookup, RefreshFn } from "./oauth.js";
import { openDatabase, QueryHelpers, type DatabaseType } from "./db.js";
import { loadKeyFromEnv } from "./credentials.js";
import { RunQueue } from "./queue.js";
import { Executor } from "./executor.js";
import { CronScheduler } from "./triggers/cron.js";
import { WebhookRegistry } from "./triggers/webhook.js";
import { ManualTrigger } from "./triggers/manual.js";
import { OAuthRefresher } from "./oauth.js";
import { ExpiryAlarm } from "./expiry-alarm.js";
import { registerApiRoutes } from "./api/index.js";
import type { EventDispatcher } from "./triggers/event.js";

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
  const executor = new Executor({ db, integrationLoader: opts.integrationLoader });
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
  const apiToken =
    opts.apiToken !== undefined
      ? opts.apiToken
      : process.env.CHORUS_API_TOKEN && process.env.CHORUS_API_TOKEN.length > 0
        ? process.env.CHORUS_API_TOKEN
        : null;
  registerApiRoutes(app, db, { apiToken });

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
