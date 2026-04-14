/**
 * @chorus/cli — programmatic entry points.
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
  ChorusConfigSchema,
  ConfigNotFoundError,
  loadConfig,
  loadConfigFromDir,
  parseConfig,
  type ChorusConfig,
  type LoadResult,
} from "./config.js";

export { parseYaml, stringifyYaml, YamlParseError } from "./yaml.js";
