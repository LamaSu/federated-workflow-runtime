import type { z } from "zod";
import type { CredentialTestResult } from "./credential-catalog.js";
import type {
  ConfigurableFieldSchema,
  ConnectionSchema,
  CredentialSchema,
  CronTriggerSchema,
  ErrorSignatureSchema,
  IntegrationManifestSchema,
  ManualTriggerSchema,
  NodeRefSchema,
  NodeResultSchema,
  NodeSchema,
  OperationDefinitionSchema,
  PatchMetadataSchema,
  PatchSchema,
  RedactedErrorReportSchema,
  RunSchema,
  TriggerSchema,
  WebhookTriggerSchema,
  WorkflowSchema,
} from "./schemas.js";

export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
export type ManualTrigger = z.infer<typeof ManualTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type Node = z.infer<typeof NodeSchema>;
export type NodeRef = z.infer<typeof NodeRefSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type NodeResult = z.infer<typeof NodeResultSchema>;
export type Run = z.infer<typeof RunSchema>;
export type OperationDefinition = z.infer<typeof OperationDefinitionSchema>;
export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;
export type ErrorSignature = z.infer<typeof ErrorSignatureSchema>;
export type RedactedErrorReport = z.infer<typeof RedactedErrorReportSchema>;
export type PatchMetadata = z.infer<typeof PatchMetadataSchema>;
export type Patch = z.infer<typeof PatchSchema>;
export type Credential = z.infer<typeof CredentialSchema>;
export type ConfigurableField = z.infer<typeof ConfigurableFieldSchema>;

/**
 * Convention for trigger payload `configurable` overrides (Wave 4 item 14).
 *
 * The runtime's `triggerPayload` field stays `unknown` for back-compat — any
 * shape goes through. But there's ONE structural convention the executor
 * honors: if `triggerPayload` is an object with a `configurable` key whose
 * value is `Record<string, unknown>`, those entries are treated as
 * per-invocation overrides for matching `node.configurable[fieldName]`
 * declarations. Fields not declared on a node are ignored (silently — the
 * trigger payload may carry overrides intended for OTHER nodes).
 *
 * Resolution precedence (executor.ts → resolveConfigurable):
 *   1. triggerPayload.configurable[fieldName]  (per-invocation override)
 *   2. node.config[fieldName]                  (declared workflow default)
 *   3. node.configurable[fieldName].default    (declared field default)
 *
 * The merged view is attached to OperationContext as `nodeConfig` so a
 * handler reads ONE map regardless of override source.
 *
 * This is a TYPE-LEVEL helper for documentation + ergonomic call-site code;
 * it is NOT a Zod schema we validate against (that would force a schema on
 * everyone's trigger payloads). The duck-typed extraction in the executor
 * is the source of truth.
 */
export type ConfigurableOverrides = Record<string, unknown>;
export interface TriggerPayloadWithConfigurable {
  configurable?: ConfigurableOverrides;
  [key: string]: unknown;
}

export interface OperationContext {
  credentials: Record<string, unknown> | null;
  logger: Logger;
  signal: AbortSignal;
  snapshot?: SnapshotRecorder;
}

/**
 * Durable, per-workflow (optionally per-user) key/value storage made
 * available to operation handlers via `StepContext.memory`.
 *
 * Scope:
 *   • keyed by (workflow_id, user_id?, key) — two different workflows
 *     with the same key never collide
 *   • `user_id` is derived from the run's trigger payload
 *     (`run.triggerPayload?.userId` / `run.triggerPayload?.user?.id`).
 *     Absent → workflow-global scope.
 *
 * Values are JSON-serialized so any JSON-safe value type works
 * (`string | number | boolean | null | object | array`). Round-trip
 * through JSON means `Date` / `Map` / class instances become plain
 * objects — callers must re-hydrate if needed.
 *
 * Both methods are async because they may be routed through
 * `step.run(...)` for replay durability.
 */
export interface MemoryStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface SnapshotRecorder {
  record(key: string, request: unknown, response: unknown): Promise<void>;
  replay(key: string, request: unknown): Promise<unknown | null>;
}

export type OperationHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: OperationContext,
) => Promise<TOutput>;

export interface IntegrationModule {
  manifest: IntegrationManifest;
  operations: Record<string, OperationHandler>;

  /**
   * Validate that a stored credential still works. Called by
   * `chorus credentials test <id>` and by the CLI after
   * `chorus credentials add` when the credential type has a `test:`
   * declaration.
   *
   * The runtime decrypts the credential and hands it through
   * `ctx.credentials` exactly as it does for operations. Implementations
   * MUST NOT mutate state on the target service — pick a GET/introspection
   * endpoint. Return shape is `CredentialTestResult`.
   *
   * Resolution precedence (docs/CREDENTIALS_ANALYSIS.md §4.4):
   *   1. If the credential type has `test.viaOperation`, the runtime
   *      invokes that operation with minimal input.
   *   2. Else if this `testCredential` exists, the runtime calls it.
   *   3. Else the CLI prints "no test available for this credential type".
   */
  testCredential?: (
    credentialTypeName: string,
    ctx: OperationContext,
  ) => Promise<CredentialTestResult>;
}
