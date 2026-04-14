import { z } from "zod";

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
  triggeredBy: z.enum(["cron", "webhook", "manual"]),
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

export const IntegrationManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  authType: z.enum(["none", "apiKey", "oauth2", "basic", "bearer"]),
  operations: z.array(OperationDefinitionSchema),
  baseUrl: z.string().optional(),
  docsUrl: z.string().optional(),
});

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
  type: z.enum(["apiKey", "oauth2", "basic", "bearer"]),
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
