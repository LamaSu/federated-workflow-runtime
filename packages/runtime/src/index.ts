// Public API surface for @chorus/runtime.
// Keep exports explicit so downstream packages don't accidentally depend on
// internals.

export {
  openDatabase,
  runMigrations,
  createHelpers,
  QueryHelpers,
  SCHEMA_VERSION,
  type CredentialRow,
  type CredentialState,
  type DatabaseType,
  type RunRow,
  type RunStatus,
  type StepRow,
  type StepStatus,
  type TriggerRow,
  type WorkflowRow,
} from "./db.js";

export {
  CredentialDecryptError,
  CredentialKeyError,
  ENCRYPTION_KEY_ENV,
  decodeKey,
  decryptCredential,
  encryptCredential,
  generateKey,
  loadKeyFromEnv,
  rotateKey,
} from "./credentials.js";

export {
  DEFAULT_VISIBILITY_MS,
  RunQueue,
  type ClaimOptions,
  type EnqueueOptions,
} from "./queue.js";

export {
  SandboxError,
  resolveWorkerPath,
  runIsolated,
  type ChildMsg,
  type ParentMsg,
  type RunIsolatedOptions,
  type RunIsolatedResult,
} from "./sandbox.js";

export {
  DEFAULT_RETRY,
  Executor,
  computeBackoff,
  type ExecutorOptions,
  type ExecutorResult,
  type IntegrationLoader,
  type RetryPolicy,
  type StepContext,
} from "./executor.js";

export {
  CronScheduler,
  type CronScheduleEntry,
  type CronSchedulerOptions,
} from "./triggers/cron.js";

export {
  DEFAULT_SIGNATURE_HEADER,
  WebhookRegistry,
  signWebhookBody,
  verifyWebhookSignature,
  type WebhookEntry,
  type WebhookRegistryOptions,
} from "./triggers/webhook.js";

export {
  ManualTrigger,
  triggerManually,
  type ManualTriggerOptions,
} from "./triggers/manual.js";

export {
  DEFAULT_INTERVAL_MS,
  DEFAULT_LEAD_TIME_MS,
  OAuthRefresher,
  startOAuthRefresher,
  type OAuthRefresherOptions,
  type RefreshFn,
  type RefreshedToken,
} from "./oauth.js";

export { createServer, type ChorusServer, type CreateServerOptions } from "./server.js";

export {
  API_VERSION,
  CHORUS_API_MEDIA_TYPE,
  buildManifest,
  registerApiRoutes,
  WorkflowSummarySchema,
  WorkflowDetailSchema,
  RunSummarySchema,
  RunDetailSchema,
  NodeResultSummarySchema,
  ErrorSignatureSummarySchema,
  PatchSummarySchema,
  PatchDetailSchema,
  IntegrationSummarySchema,
  type ApiManifest,
  type ManifestEndpoint,
  type WorkflowSummary,
  type WorkflowDetail,
  type RunSummary,
  type RunDetail,
  type NodeResultSummary,
  type ErrorSignatureSummary,
  type PatchSummary,
  type PatchDetail,
  type IntegrationSummary,
  type RegisterApiOptions,
} from "./api/index.js";
