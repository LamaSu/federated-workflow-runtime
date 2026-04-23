import { z } from "zod";
import { CredentialTypeDefinitionSchema } from "./credential-catalog.js";

// ── Triggers ────────────────────────────────────────────────────────────────

export const CronTriggerSchema = z.object({
  type: z.literal("cron"),
  expression: z.string(),
  timezone: z.string().default("UTC"),
});

export const WebhookTriggerSchema = z.object({
  type: z.literal("webhook"),
  path: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("POST"),
  secret: z.string().optional(),
});

export const ManualTriggerSchema = z.object({
  type: z.literal("manual"),
});

export const TriggerSchema = z.discriminatedUnion("type", [
  CronTriggerSchema,
  WebhookTriggerSchema,
  ManualTriggerSchema,
]);

// ── Workflow & Nodes ────────────────────────────────────────────────────────

/**
 * Reference to an alternate (integration, operation) used as a fallback
 * when a Node's primary call exhausts its retry budget. Borrows from
 * LangChain's `with_fallbacks` pattern but declared on the Node itself
 * (not as a runtime wrapper).
 *
 * Intentionally strict: a NodeRef cannot have its own retry policy,
 * onError disposition, or nested fallbacks. Fallbacks are tried in
 * declaration order; the first success short-circuits the chain. If
 * every fallback also fails, the executor surfaces the ORIGINAL primary
 * failure (with metadata listing the fallbacks that were tried).
 *
 * The fallback handler receives the SAME `inputs` the primary received
 * — a fallback is meant to be a drop-in alternative, not a different
 * call shape. If a fallback truly needs different inputs, model it as
 * a separate node + a `Connection.when?` route instead.
 */
export const NodeRefSchema = z.object({
  integration: z.string(),
  operation: z.string(),
  config: z.record(z.unknown()).default({}),
});

export const NodeSchema = z.object({
  id: z.string(),
  integration: z.string(),
  operation: z.string(),
  config: z.record(z.unknown()).default({}),
  inputs: z.record(z.unknown()).optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      backoffMs: z.number().int().min(100).default(1000),
      jitter: z.boolean().default(true),
    })
    .optional(),
  onError: z.enum(["fail", "continue", "retry"]).default("retry"),
  /**
   * Optional fallback chain. After the primary `(integration, operation)`
   * exhausts its retry budget, the executor tries each fallback in order.
   * The first success returns its output as the node's output. If all
   * fallbacks also fail, the executor propagates the original primary
   * failure annotated with the list of fallback attempts.
   *
   * Single-level only — fallbacks themselves cannot have fallbacks.
   * Each fallback attempt is recorded as its own step row named
   * `<nodeId>.fallback.<i>` so the audit trail shows exactly which
   * alternates ran.
   */
  fallbacks: z.array(NodeRefSchema).optional(),
});

export const ConnectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  when: z.string().optional(),
});

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1).default(1),
  active: z.boolean().default(true),
  trigger: TriggerSchema,
  nodes: z.array(NodeSchema),
  connections: z.array(ConnectionSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── Runs & Results ──────────────────────────────────────────────────────────

export const NodeResultSchema = z.object({
  nodeId: z.string(),
  status: z.enum(["pending", "running", "success", "failed", "skipped"]),
  attempt: z.number().int().min(1).default(1),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  errorSignatureHash: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
});

export const RunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: z.enum(["pending", "running", "success", "failed", "cancelled"]),
  triggeredBy: z.enum(["cron", "webhook", "manual", "event"]),
  triggerPayload: z.unknown().optional(),
  nodeResults: z.array(NodeResultSchema).default([]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});

// ── Integrations ────────────────────────────────────────────────────────────

export const OperationDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  idempotent: z.boolean().default(false),
});

export const IntegrationManifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    /**
     * @deprecated in favor of `credentialTypes[0].authType`. Kept for v1.x
     * back-compat — existing integrations won't recompile. New integrations
     * should declare `credentialTypes` and set `authType` to match the
     * first credentialType's `authType` (or "none" when there are no
     * credential types).
     */
    authType: z.enum(["none", "apiKey", "oauth2", "basic", "bearer"]),

    /**
     * Per-integration credential type catalog. Most integrations declare
     * ONE; Slack-like integrations with multiple auth options declare
     * several. When omitted (default `[]`), the runtime synthesizes a
     * single anonymous type matching the legacy `authType` so old
     * integrations keep working.
     */
    credentialTypes: z.array(CredentialTypeDefinitionSchema).default([]),

    operations: z.array(OperationDefinitionSchema),
    baseUrl: z.string().optional(),
    docsUrl: z.string().optional(),
  })
  .refine(
    (m) =>
      m.credentialTypes.length === 0 ||
      m.credentialTypes.every((ct) => ct.authType === "none") ||
      m.credentialTypes.some((ct) => ct.authType === m.authType),
    { message: "manifest.authType must match at least one declared credentialType" },
  );

// ── Error Signatures (the crown jewel — Research 03 informs this) ────────────

export const ErrorSignatureSchema = z.object({
  schemaVersion: z.literal(1),
  integration: z.string(),
  operation: z.string(),
  errorClass: z.string(),
  httpStatus: z.number().int().optional(),
  httpStatusText: z.string().optional(),
  apiVersion: z.string().optional(),
  stackFingerprint: z.string(),
  messagePattern: z.string(),
  integrationVersion: z.string(),
  runtimeVersion: z.string(),
  occurrences: z.number().int().default(1),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

export const RedactedErrorReportSchema = z.object({
  signature: ErrorSignatureSchema,
  configFingerprint: z.record(z.union([z.string(), z.boolean(), z.number()])),
  contextShape: z.record(z.string()),
  reporterId: z.string(),
  reportedAt: z.string(),
});

// ── Patches (registry) ──────────────────────────────────────────────────────

export const PatchMetadataSchema = z.object({
  id: z.string(),
  integration: z.string(),
  errorSignatureHash: z.string(),
  description: z.string(),
  author: z.object({
    id: z.string(),
    publicKey: z.string(),
    reputation: z.number().min(0).default(0),
  }),
  beforeVersion: z.string(),
  afterVersion: z.string(),
  testsAdded: z.array(z.string()).default([]),
  canaryStage: z.enum([
    "proposed",
    "static-passed",
    "sandbox-passed",
    "diff-passed",
    "canary-1",
    "canary-10",
    "canary-100",
    "fleet",
    "revoked",
  ]),
  createdAt: z.string(),
  advancedAt: z.record(z.string()).default({}),
});

export const PatchSchema = z.object({
  metadata: PatchMetadataSchema,
  diff: z.string(),
  snapshotUpdates: z
    .array(
      z.object({
        path: z.string(),
        contentHash: z.string(),
      }),
    )
    .default([]),
  signature: z.string(),
  signatureAlgorithm: z.literal("ed25519").default("ed25519"),
});

// ── Credentials (never leaves the user box) ─────────────────────────────────

export const CredentialSchema = z.object({
  id: z.string(),
  integration: z.string(),

  /**
   * NEW: which CredentialTypeDefinition in the integration this row is an
   * instance of. Defaults to `''` for rows written before the catalog
   * existed; the runtime's resolver (see `resolveCredentialType`) falls
   * back to `authType` matching in that case. The DB backfill in
   * `packages/runtime/src/db.ts` sets this to `<integration>:legacy`.
   */
  credentialTypeName: z.string().default(""),

  /**
   * Retained for back-compat and as a fast filter ("refresher only looks
   * at oauth2"). Renamed in the TS schema from `type → authType` for
   * clarity; the DB column stays `type` to avoid migration churn. See
   * `docs/CREDENTIALS_ANALYSIS.md` §4.6.
   */
  authType: z.enum(["apiKey", "oauth2", "basic", "bearer"]),

  name: z.string(),
  encryptedPayload: z.string(),
  oauth2: z
    .object({
      accessTokenExpiresAt: z.string().optional(),
      refreshTokenExpiresAt: z.string().optional(),
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
