// Public API surface for @delightfulchorus/runtime.
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
  type EventRow,
  type OAuthPendingRow,
  type RunRow,
  type RunStatus,
  type StepRow,
  type StepStatus,
  type TriggerRow,
  type WaitingStepRow,
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
  RuntimeCredentialService,
  type AuthenticateResult,
  type CredentialSummaryView,
  type RuntimeCredentialServiceOptions,
} from "./credential-service.js";

export {
  OAuthCallbackListener,
  type OAuthCallbackListenerOptions,
} from "./oauth-listener.js";

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
  ASK_USER_DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRY,
  Executor,
  WaitForEventTimeoutError,
  computeBackoff,
  type AskUserOpts,
  type ExecutorOptions,
  type ExecutorResult,
  type IntegrationLoader,
  type RetryPolicy,
  type StepContext,
  type WaitForEventResult,
} from "./executor.js";

export {
  registerAskRoutes,
  type RegisterAskRoutesOptions,
} from "./ask-routes.js";

export {
  askUserEventType,
  buildAskUserDescriptor,
  isZodSchema,
  parseAskUserDescriptor,
  validateAgainstSchema,
  type AskUserDescriptor,
  type AskUserSchema,
  type JsonSchemaLite,
  type ValidateResult,
  type ValidateOk,
  type ValidateErr,
} from "./schema-validate.js";

export {
  ForkRunError,
  applyMutationsToNode,
  decodeStepRow,
  fnv1a32,
  forkRun,
  getRunHistory,
  getRunOverview,
  parsePath,
  setAtPath,
  type ForkRunOptions,
  type ForkRunResult,
  type Mutations,
  type RunHistoryEntry,
} from "./fork-run.js";

export {
  EventDispatcher,
  TIMEOUT_EVENT_ID,
  eventMatches,
  type EmitEventInput,
  type EmitResult,
  type EventDispatcherOptions,
  type EventTriggerEntry,
} from "./triggers/event.js";

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
  defaultOAuth2Refresh,
  startOAuthRefresher,
  type DefaultOAuth2RefreshOptions,
  type ManifestLookup,
  type OAuthRefresherOptions,
  type RefreshFn,
  type RefreshedToken,
} from "./oauth.js";

export {
  DEFAULT_INTERVAL_MS as EXPIRY_ALARM_DEFAULT_INTERVAL_MS,
  DEFAULT_ROTATION_DAYS,
  DEFAULT_WARN_WINDOW_MS,
  ExpiryAlarm,
  computeDeadline,
  startExpiryAlarm,
  type ExpiryAlarmOptions,
  type ExpiryAlarmResult,
} from "./expiry-alarm.js";

export { createServer, type ChorusServer, type CreateServerOptions } from "./server.js";
export { startServer, type StartServerOptions, type StartServerConfig } from "./start-server.js";

export {
  setDashboard,
  resetDashboard,
  getDashboardHtml,
  getDashboardEtag,
} from "./static/holder.js";
export { MINIMAL_HTML } from "./static/index.js";
export {
  maybeGenerateDashboard,
  buildPrompt,
  extractHtml,
  hashWorkflowSet,
  hashString,
  DEFAULT_MODEL,
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  CACHE_DIR_NAME,
  type GenerateDashboardOptions,
  type GenerateDashboardResult,
} from "./ui-generator.js";

export {
  API_VERSION,
  CHORUS_API_MEDIA_TYPE,
  buildManifest,
  registerApiRoutes,
  registerEventsRoutes,
  WorkflowSummarySchema,
  WorkflowDetailSchema,
  RunSummarySchema,
  RunDetailSchema,
  NodeResultSummarySchema,
  ErrorSignatureSummarySchema,
  PatchSummarySchema,
  PatchDetailSchema,
  IntegrationSummarySchema,
  EventSummarySchema,
  WaitingStepSummarySchema,
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
  type EventSummary,
  type WaitingStepSummary,
  type RegisterEventsRoutesOptions,
} from "./api/index.js";
