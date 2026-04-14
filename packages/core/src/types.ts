import type { z } from "zod";
import type {
  ConnectionSchema,
  CredentialSchema,
  CronTriggerSchema,
  ErrorSignatureSchema,
  IntegrationManifestSchema,
  ManualTriggerSchema,
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

export interface OperationContext {
  credentials: Record<string, unknown> | null;
  logger: Logger;
  signal: AbortSignal;
  snapshot?: SnapshotRecorder;
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
}
