/**
 * @delightfulchorus/cli — programmatic entry points.
 *
 * This module re-exports the command functions so other packages (or users'
 * scripts) can invoke them without going through the commander layer. The
 * CLI binary lives in ./cli.ts and is referenced by package.json#bin.
 */
export { buildProgram } from "./cli.js";

export {
  runInit,
  AlreadyInitializedError,
  type InitOptions,
  type InitResult,
} from "./commands/init.js";

export {
  runRun,
  bootstrap,
  type RunOptions,
  type RunBootstrap,
} from "./commands/run.js";

export {
  runReport,
  buildReport,
  type ReportOptions,
  type ReportSummary,
  type ReportRunSummary,
  type ReportSignatureSummary,
  type ReportPatchSummary,
} from "./commands/report.js";

export {
  runValidate,
  validateWorkflowFile,
  type ValidateResult,
} from "./commands/validate.js";

export {
  runSkill,
  generateSkill,
  renderSkill,
  type SkillOptions,
  type SkillResult,
} from "./commands/skill.js";

export {
  runCompose,
  composeCommand,
  ComposeFailedError,
  renderTypeScriptWorkflow,
  slugify,
  deriveSlug,
  type ComposeOptions,
  type ComposeResult,
  type GenerateObjectFn,
  type GenerateObjectResult,
  type LanguageModelLike,
} from "./commands/compose.js";

export { COMPOSE_SYSTEM_PROMPT } from "./prompts/compose-system.js";

export {
  runPatchCommand,
  listPatches,
  type PatchAction,
  type PatchOptions,
  type PatchListEntry,
} from "./commands/patch.js";

export {
  credentialsAdd,
  credentialsList,
  credentialsRemove,
  encryptAesGcm,
  type CredentialType,
  type CredentialsAddOptions,
  type CredentialsListOptions,
  type CredentialsRemoveOptions,
  type CredentialSummary,
} from "./commands/credentials.js";

export {
  runShare,
  runShareCli,
  TEMPLATE_SCHEMA_VERSION,
  type ShareOptions,
  type ShareResult,
  type ChorusTemplate,
  type GistClient,
} from "./commands/share.js";

export {
  runImport,
  runImportCli,
  listTemplateCredentialRefs,
  templateHasCredentialRefs,
  type ImportOptions,
  type ImportResult,
} from "./commands/import.js";

export {
  redactCredentials,
  gatherCredentialRefs,
  countCredentialRefs,
  isCredentialRef,
  type CredentialRef,
  type IntegrationCatalogs,
  type RedactResult,
  type RedactedWorkflow,
  type RedactedNode,
  type RefBucket,
} from "./lib/credential-redaction.js";

export {
  ChorusConfigSchema,
  ConfigNotFoundError,
  loadConfig,
  loadConfigFromDir,
  parseConfig,
  type ChorusConfig,
  type LoadResult,
} from "./config.js";

export { parseYaml, stringifyYaml, YamlParseError } from "./yaml.js";
