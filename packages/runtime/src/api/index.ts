import type { FastifyInstance } from "fastify";
import type { DatabaseType } from "../db.js";
import type { EventDispatcher } from "../triggers/event.js";
import type { RuntimeCredentialService } from "../credential-service.js";
import type { ReputationLookup } from "../trust-policy.js";
import { registerManifestRoute, API_VERSION } from "./manifest.js";
import { registerWorkflowsRoutes } from "./workflows.js";
import { registerRunsRoutes } from "./runs.js";
import { registerErrorsRoutes } from "./errors.js";
import { registerPatchesRoutes } from "./patches.js";
import { registerIntegrationsRoutes } from "./integrations.js";
import { registerEventsRoutes } from "./events.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerCredentialsRoutes } from "./credentials.js";
import { registerRemoteRunRoutes } from "./remote-run.js";

/**
 * Mount the read-only JSON API under /api/*.
 *
 *   registerApiRoutes(fastify, db, { apiToken })
 *
 * Cross-cutting behavior installed on every /api/ request:
 *   - `X-Chorus-API-Version: 1` header so clients can detect breaking changes
 *   - `Cache-Control: no-store` so dashboards never see stale data
 *   - optional bearer-token auth when `CHORUS_API_TOKEN` is set
 *
 * Why these live here and not on each route: they should be impossible to
 * accidentally skip. `onRequest` + `onSend` hooks apply to anything matched
 * under `/api/` even as new sub-routes are added.
 */

export interface RegisterApiOptions {
  /**
   * If provided, every /api/ request must carry
   *   `Authorization: Bearer <apiToken>`.
   * If omitted (or empty), rely on 127.0.0.1 binding for security.
   */
  apiToken?: string | null;
  /**
   * EventDispatcher for the POST /api/events route. When omitted, the
   * events routes are skipped (read-only clients don't need them).
   */
  eventDispatcher?: EventDispatcher;
  /**
   * Credential service — when wired, enables the write-side credential
   * endpoints (POST /api/credentials, /test, /authenticate) and the OAuth
   * callback (GET /api/oauth/callback). When omitted, those routes do
   * not mount.
   */
  credentialService?: RuntimeCredentialService;
  /**
   * Optional fetch override — passed into the OAuth callback's token
   * exchange for tests.
   */
  fetchFn?: typeof fetch;
  /**
   * Wave 3 worknet — when set, mounts POST /api/run + GET /api/run/:id/status
   * for remote workflow invocations. Default OFF: every chorus instance
   * that wants to be call-able from outside opts in via `chorus run
   * --remote-callable`. See api/remote-run.ts for the per-call security
   * model (signature verify + hash pinning + optional acceptedCallers).
   */
  remoteCallable?: {
    /**
     * Optional Ed25519 pubkey allowlist (base64). Empty/omitted → accept
     * any caller whose signature verifies.
     */
    acceptedCallers?: string[];
    /** Reputation lookup for trustPolicy.minReputation enforcement. */
    getOperatorReputation?: ReputationLookup;
    /** Override timestamp skew window (default ±5min). */
    timestampSkewMs?: number;
    /** Override `now` (test hook). */
    now?: () => number;
  };
}

export function registerApiRoutes(
  app: FastifyInstance,
  db: DatabaseType,
  opts: RegisterApiOptions = {},
): void {
  const authMode: "localhost" | "bearer" =
    opts.apiToken && opts.apiToken.length > 0 ? "bearer" : "localhost";

  // Auth guard + always-on headers. Hooks are scoped at the app level, but
  // we keep them limited to /api/* via URL prefix check — other parts of the
  // server (existing /health, /workflows, /hooks/*) must remain untouched.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (authMode === "bearer") {
      const header = req.headers.authorization;
      if (!header || !header.startsWith("Bearer ")) {
        reply.code(401);
        void reply.send({ error: "UNAUTHORIZED", message: "Bearer token required" });
        return;
      }
      const provided = header.slice("Bearer ".length).trim();
      if (provided !== opts.apiToken) {
        reply.code(401);
        void reply.send({ error: "UNAUTHORIZED", message: "Invalid token" });
        return;
      }
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.url.startsWith("/api/")) return payload;
    reply.header("X-Chorus-API-Version", API_VERSION);
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  registerManifestRoute(app, authMode);
  registerWorkflowsRoutes(app, db);
  registerRunsRoutes(app, db);
  registerErrorsRoutes(app, db);
  registerPatchesRoutes(app, db);
  registerIntegrationsRoutes(app, db);
  if (opts.eventDispatcher) {
    registerEventsRoutes(app, db, { dispatcher: opts.eventDispatcher });
  }
  if (opts.credentialService) {
    registerCredentialsRoutes(app, {
      credentialService: opts.credentialService,
    });
    registerOAuthRoutes(app, {
      credentialService: opts.credentialService,
      eventDispatcher: opts.eventDispatcher,
      fetchFn: opts.fetchFn,
    });
  }
  // Wave 3 — opt-in worknet receiver routes.
  if (opts.remoteCallable) {
    registerRemoteRunRoutes(app, db, {
      acceptedCallers: opts.remoteCallable.acceptedCallers,
      getOperatorReputation: opts.remoteCallable.getOperatorReputation,
      timestampSkewMs: opts.remoteCallable.timestampSkewMs,
      now: opts.remoteCallable.now,
    });
  }
}

export { API_VERSION, CHORUS_API_MEDIA_TYPE, buildManifest } from "./manifest.js";
export type { ApiManifest, ManifestEndpoint } from "./manifest.js";
export {
  WorkflowSummarySchema,
  WorkflowDetailSchema,
  type WorkflowSummary,
  type WorkflowDetail,
} from "./workflows.js";
export {
  RunSummarySchema,
  RunDetailSchema,
  NodeResultSummarySchema,
  type RunSummary,
  type RunDetail,
  type NodeResultSummary,
} from "./runs.js";
export {
  ErrorSignatureSummarySchema,
  type ErrorSignatureSummary,
} from "./errors.js";
export {
  PatchSummarySchema,
  PatchDetailSchema,
  type PatchSummary,
  type PatchDetail,
} from "./patches.js";
export { IntegrationSummarySchema, type IntegrationSummary } from "./integrations.js";
export {
  EventSummarySchema,
  WaitingStepSummarySchema,
  registerEventsRoutes,
  type EventSummary,
  type WaitingStepSummary,
  type RegisterEventsRoutesOptions,
} from "./events.js";
export {
  registerRemoteRunRoutes,
  computeStepsHashRoot,
  type RegisterRemoteRunOptions,
} from "./remote-run.js";
