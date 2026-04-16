import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * GET /api/manifest
 *
 * Self-describing JSON that lets a user's agent (Claude, ChatGPT, custom LLM,
 * etc.) discover EVERY endpoint and data shape in Chorus with a single fetch.
 *
 * Agent UX:
 *   1. agent reads /api/manifest once
 *   2. agent learns endpoint list + data model + capabilities
 *   3. agent generates whatever UI the user asks for
 *
 * This endpoint is therefore the contract. Keep the shape stable; if you add
 * a route below, add the matching entry here.
 */

export const API_VERSION = "1";
export const CHORUS_API_MEDIA_TYPE = "application/vnd.chorus.v1+json";

export interface ManifestEndpoint {
  path: string;
  method: "GET";
  description: string;
  query?: Record<string, string>;
  responseShape: string;
}

export interface ApiManifest {
  chorusApiVersion: string;
  generatedAt: string;
  /**
   * Whether the API surface is purely read-only. Historically `true`; now
   * `false` when credential write endpoints (configure/authenticate/test)
   * and the events emit endpoint are mounted.
   */
  readOnly: boolean;
  authMode: "localhost" | "bearer";
  endpoints: ManifestEndpoint[];
  dataModel: Record<string, string>;
  capabilities: string[];
  conventions: {
    timestamps: string;
    ids: string;
    statusCodes: Record<string, string>;
    caching: string;
  };
  promptHint: string;
}

/**
 * Build the manifest response. Pure function so tests can assert shape.
 *
 * authMode: "bearer" when the runtime is protecting the API with a token
 * (CHORUS_API_TOKEN env); "localhost" when relying on 127.0.0.1 binding.
 */
export function buildManifest(authMode: "localhost" | "bearer"): ApiManifest {
  return {
    chorusApiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: false,
    authMode,
    endpoints: [
      {
        path: "/api/manifest",
        method: "GET",
        description:
          "This document. Fetch ONCE at agent startup; every other endpoint is listed here.",
        responseShape: "ApiManifest",
      },
      {
        path: "/api/workflows",
        method: "GET",
        description: "List all workflows (both active and inactive), newest first.",
        responseShape: "{ workflows: WorkflowSummary[] }",
      },
      {
        path: "/api/workflows/:id",
        method: "GET",
        description:
          "Full workflow definition for the given id (latest version). 404 if unknown.",
        responseShape: "{ workflow: WorkflowDetail }",
      },
      {
        path: "/api/runs",
        method: "GET",
        description:
          "Recent runs, newest first. Filter with ?status=pending|running|success|failed|cancelled and ?workflowId=<id>.",
        query: {
          limit: "integer, 1..500, default 50",
          status: "optional run status filter",
          workflowId: "optional workflow id filter",
        },
        responseShape: "{ runs: RunSummary[], total: number }",
      },
      {
        path: "/api/runs/:id",
        method: "GET",
        description: "One run with per-node results (input/output/error/duration). 404 if unknown.",
        responseShape: "{ run: RunDetail }",
      },
      {
        path: "/api/errors",
        method: "GET",
        description:
          "Aggregated error signatures. Each row = one stable error fingerprint with occurrence counts.",
        query: {
          limit: "integer, 1..500, default 50",
          integration: "optional integration name filter",
        },
        responseShape: "{ errors: ErrorSignatureSummary[] }",
      },
      {
        path: "/api/patches",
        method: "GET",
        description:
          "Known patches (proposed, canary, fleet, revoked). Filter by integration or canary stage.",
        query: {
          limit: "integer, 1..500, default 50",
          integration: "optional integration name filter",
          stage: "optional canary stage filter (proposed..fleet..revoked)",
        },
        responseShape: "{ patches: PatchSummary[] }",
      },
      {
        path: "/api/patches/:id",
        method: "GET",
        description: "One patch with manifest + signature metadata. 404 if unknown.",
        responseShape: "{ patch: PatchDetail }",
      },
      {
        path: "/api/integrations",
        method: "GET",
        description:
          "Installed integrations with summary stats (last used, error count, patch count).",
        responseShape: "{ integrations: IntegrationSummary[] }",
      },
      {
        path: "/api/events",
        method: "GET",
        description:
          "Recent events on the internal bus. Filter by ?type=. Each row is an EventSummary.",
        query: {
          type: "optional event type filter",
          limit: "integer, 1..500, default 50",
        },
        responseShape: "{ events: EventSummary[] }",
      },
      {
        path: "/api/events/waiting",
        method: "GET",
        description:
          "Runs currently parked on step.waitForEvent. Agents render this as a 'waiting on…' list.",
        responseShape: "{ waiting: WaitingStepSummary[] }",
      },
      {
        path: "/api/credentials",
        method: "GET",
        description:
          "List stored credentials for an integration. Never returns secrets.",
        query: { integration: "required integration name" },
        responseShape: "{ credentials: CredentialSummary[] }",
      },
    ],
    dataModel: {
      WorkflowSummary:
        "{ id: string, name: string, version: number, active: boolean, createdAt: ISO8601, updatedAt: ISO8601 }",
      WorkflowDetail:
        "WorkflowSummary + { definition: { trigger, nodes[], connections[] } }",
      RunSummary:
        "{ id: string, workflowId: string, status: 'pending'|'running'|'success'|'failed'|'cancelled', triggeredBy: 'cron'|'webhook'|'manual', startedAt: ISO8601, finishedAt: ISO8601|null, durationMs: number|null, error: string|null, attempt: number }",
      RunDetail:
        "RunSummary + { nodeResults: NodeResult[], workflowVersion: number }",
      NodeResult:
        "{ nodeId: string, status: 'pending'|'running'|'success'|'failed'|'skipped', attempt: number, output: unknown, error: string|null, errorSignatureHash: string|null, durationMs: number|null, startedAt: ISO8601|null, finishedAt: ISO8601|null }",
      ErrorSignatureSummary:
        "{ hash: string, integration: string, operation: string, errorClass: string, httpStatus: number|null, occurrences: number, firstSeen: ISO8601, lastSeen: ISO8601, reported: boolean, sampleContext: object }",
      PatchSummary:
        "{ id: string, integration: string, signatureHash: string, version: string, state: string, appliedAt: ISO8601|null, rolledBackAt: ISO8601|null }",
      PatchDetail:
        "PatchSummary + { manifest: object, hasSigstoreBundle: boolean, hasEd25519Signature: boolean }",
      IntegrationSummary:
        "{ name: string, runCount: number, errorCount: number, patchCount: number, lastUsedAt: ISO8601|null }",
      EventSummary:
        "{ id: string, type: string, payload: unknown, source: string|null, emittedAt: ISO8601, correlationId: string|null, consumedByRun: string|null }",
      WaitingStepSummary:
        "{ id: string, runId: string, stepName: string, eventType: string, matchCorrelationId: string|null, expiresAt: ISO8601, resolvedAt: ISO8601|null, resolvedEventId: string|null }",
    },
    capabilities: [
      "workflows.list",
      "workflows.get",
      "runs.list",
      "runs.get",
      "runs.filter.byStatus",
      "runs.filter.byWorkflow",
      "errors.list",
      "errors.filter.byIntegration",
      "patches.list",
      "patches.get",
      "patches.filter.byIntegration",
      "patches.filter.byStage",
      "integrations.list",
      "events.emit",
      "events.list",
      "events.waiting.list",
      "credentials.list",
      "credentials.configure",
      "credentials.test",
      "credentials.authenticate",
      "oauth.callback",
    ],
    conventions: {
      timestamps: "ISO 8601 UTC (e.g. 2026-04-14T12:34:56.789Z). Treat null as 'not applicable yet'.",
      ids: "Opaque strings. Workflow ids are human-chosen; run/patch ids are UUID-shaped.",
      statusCodes: {
        "200": "Success; body is JSON.",
        "400": "Bad query (e.g. invalid status value). Body: { error: 'BAD_REQUEST', message }.",
        "401": "Missing/invalid bearer token when CHORUS_API_TOKEN is enabled.",
        "404": "Unknown id. Body: { error: 'NOT_FOUND' }.",
        "500": "Internal error. Body: { error: 'INTERNAL', message }.",
      },
      caching: "All responses send Cache-Control: no-store. Data is live.",
    },
    promptHint:
      "When building UI: treat this endpoint as your ONLY source of truth for what the server supports. Fetch once at boot. If an endpoint disappears, the user is on an older runtime — degrade gracefully.",
  };
}

export function registerManifestRoute(app: FastifyInstance, authMode: "localhost" | "bearer"): void {
  app.get("/api/manifest", async (_req: FastifyRequest, _reply: FastifyReply) => {
    return buildManifest(authMode);
  });
}
