/**
 * High-level `startServer` entry point — the function the CLI's `chorus run`
 * actually calls. Wraps createServer + workflow loading + trigger registration
 * + listen + graceful shutdown into one call.
 *
 * Decoupled from server.ts so tests can still exercise createServer directly
 * without the YAML/FS glue.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { WorkflowSchema, type Workflow } from "@delightfulchorus/core";
import { createServer, type ChorusServer } from "./server.js";
import { QueryHelpers } from "./db.js";
import type { IntegrationLoader } from "./executor.js";
import { maybeGenerateDashboard } from "./ui-generator.js";

export interface StartServerConfig {
  name: string;
  workflowsDir: string;
  integrationsDir?: string;
  database: { path: string };
  server: { host: string; port: number };
  repair?: { autoAttempt?: boolean };
  registry?: { url?: string; pollIntervalMs?: number };
}

export interface StartServerOptions {
  config: StartServerConfig;
  /** Paths to YAML/JSON workflow files (as discovered by the CLI). */
  workflowFiles: string[];
  /** Optional — if set, only load/run this single workflow (by id). */
  targetWorkflow?: string;
  /** Abort signal from the caller (CLI wires SIGINT/SIGTERM). */
  signal: AbortSignal;
  /**
   * Override the default integration loader. Defaults to dynamic-importing
   * `@delightfulchorus/integration-<name>`.
   */
  integrationLoader?: IntegrationLoader;
  /**
   * Fired exactly once, right after `app.listen()` resolves, with the
   * resolved base URL (e.g. "http://127.0.0.1:3710"). The CLI uses this
   * to open the ambient dashboard in the user's browser. Errors inside
   * the callback are swallowed — server startup must not depend on it.
   */
  onListen?: (url: string) => void | Promise<void>;
  /**
   * Wave 3 — when set, mounts POST /api/run + GET /api/run/:id/status
   * for incoming worknet calls. Wired by `chorus run --remote-callable`.
   * Default OFF so a fresh `chorus run` exposes no remote-invocation
   * surface. See packages/runtime/src/api/remote-run.ts for details.
   */
  remoteCallable?: {
    /** Optional Ed25519 pubkey allowlist (base64). */
    acceptedCallers?: string[];
    /** Override skew window. */
    timestampSkewMs?: number;
  };
}

/**
 * Default integration loader: dynamic-import `@delightfulchorus/integration-<name>`.
 * Works for both published packages and workspace-linked local integrations.
 */
function defaultLoader(): IntegrationLoader {
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  return async (name: string) => {
    const mod = (await dynamicImport(`@delightfulchorus/integration-${name}`)) as {
      default?: unknown;
    };
    const picked = (mod.default ?? mod) as unknown;
    if (!picked || typeof picked !== "object") {
      throw new Error(`@delightfulchorus/integration-${name} has no default export`);
    }
    return picked as ReturnType<IntegrationLoader>;
  };
}

async function loadWorkflow(filePath: string): Promise<Workflow> {
  const raw = await readFile(filePath, "utf8");
  const parsed = filePath.toLowerCase().endsWith(".json")
    ? JSON.parse(raw)
    : parseYaml(raw);
  // Fill in defaults the user shouldn't have to write:
  const now = new Date().toISOString();
  const withDefaults = {
    ...parsed,
    version: parsed?.version ?? 1,
    active: parsed?.active ?? true,
    connections: parsed?.connections ?? [],
    createdAt: parsed?.createdAt ?? now,
    updatedAt: parsed?.updatedAt ?? now,
  };
  return WorkflowSchema.parse(withDefaults);
}

/**
 * Bootstrap everything the `chorus run` command promises:
 *   - createServer (DB + queue + executor + fastify + webhook registry + cron)
 *   - Load + validate workflows
 *   - Register webhook routes + cron entries for each
 *   - Insert workflow rows into SQLite
 *   - Start the executor loop + cron scheduler
 *   - Listen on config.server.host:port
 *   - Block on the abort signal, then cleanly shut down
 */
export async function startServer(opts: StartServerOptions): Promise<void> {
  const server = createServer({
    dbPath: opts.config.database.path,
    integrationLoader: opts.integrationLoader ?? defaultLoader(),
    // Wave 3 — opt-in worknet receiver routes mount only when --remote-callable
    // was passed to `chorus run`. Default-off keeps the 127.0.0.1 default safe.
    ...(opts.remoteCallable
      ? {
          remoteCallable: {
            acceptedCallers: opts.remoteCallable.acceptedCallers,
            timestampSkewMs: opts.remoteCallable.timestampSkewMs,
          },
        }
      : {}),
  });

  const helpers = new QueryHelpers(server.db);

  // Load + register workflows ------------------------------------------------
  const workflows: Workflow[] = [];
  for (const file of opts.workflowFiles) {
    const wf = await loadWorkflow(file);
    if (opts.targetWorkflow && wf.id !== opts.targetWorkflow) continue;
    workflows.push(wf);
  }

  for (const wf of workflows) {
    // Upsert the workflow row so /workflows endpoint + run attribution work.
    helpers.insertWorkflow({
      id: wf.id,
      version: wf.version,
      name: wf.name,
      definition: JSON.stringify(wf),
      active: wf.active ? 1 : 0,
      created_at: wf.createdAt,
      updated_at: wf.updatedAt,
    });

    // Register the trigger. Event triggers are not supported here yet —
    // they route through EventDispatcher (see api/events.ts + §6 of
    // docs/EVENT_TRIGGERS.md).
    if (wf.trigger.type === "webhook") {
      server.webhookRegistry.register({
        workflowId: wf.id,
        token: randomUUID(),
        config: wf.trigger,
      });
    } else if (wf.trigger.type === "cron") {
      // CronScheduler.register() auto-schedules — no separate start call.
      server.cronScheduler.register({
        workflowId: wf.id,
        config: wf.trigger,
      });
    }
    // `manual` triggers don't need registration — fire via API.
  }

  // Start executor + listen ------------------------------------------
  const stopExecutor = server.startLoop(500);

  await server.app.listen({
    host: opts.config.server.host,
    port: opts.config.server.port,
  });

  // Fire onListen (non-fatal: CLI uses this to open the browser). The
  // displayed URL prefers 127.0.0.1/localhost over 0.0.0.0 so the browser
  // actually connects.
  const displayHost =
    opts.config.server.host === "0.0.0.0" || opts.config.server.host === "::"
      ? "127.0.0.1"
      : opts.config.server.host;
  const displayUrl = `http://${displayHost}:${opts.config.server.port}`;
  if (opts.onListen) {
    try {
      const p = opts.onListen(displayUrl);
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {
          /* onListen failures must not crash the server */
        });
      }
    } catch {
      /* onListen failures must not crash the server */
    }
  }

  // Fire-and-forget LLM dashboard generation. Never blocks startup; if
  // the API call fails or ANTHROPIC_API_KEY isn't set, the server keeps
  // serving the minimal dashboard.
  void maybeGenerateDashboard({
    workflows,
    displayUrl,
  });

  // Block until aborted ------------------------------------------------------
  if (!opts.signal.aborted) {
    await new Promise<void>((resolve) => {
      opts.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  // Clean shutdown -----------------------------------------------------------
  try {
    stopExecutor();
    server.cronScheduler.shutdown();
    await server.app.close();
    await server.close();
  } catch {
    // Best-effort — we're exiting anyway.
  }
}

/** Type re-export so the CLI can see ChorusServer without reaching into server.js. */
export type { ChorusServer } from "./server.js";
