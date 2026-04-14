export type {
  Cassette,
  PatchConfidence,
  PatchProposal,
  RepairContext,
  RepairOptions,
  RepairPhase,
  RepairReason,
  RepairResult,
  SourceFile,
  SubmissionMode,
  SubmissionResult,
  ValidationResult,
} from "./types.js";

export { assembleRepairContext } from "./context.js";
export type { AssembleContextOptions } from "./context.js";

export {
  parseProposal,
  proposePatch,
  renderUserPrompt,
  ProposalParseError,
  SYSTEM_PROMPT,
  validateUnifiedDiff,
} from "./propose.js";
export type { ProposeOptions } from "./propose.js";

export {
  applyPatchToTempDir,
  cleanupTempDir,
  PatchApplyError,
  replayCassettes,
} from "./validate.js";
export type { ApplyOptions, ReplayOptions } from "./validate.js";

export {
  RegistrySubmitError,
  ReputationFloorError,
  submitPatchProposal,
} from "./submit.js";
export type { SubmitOptions } from "./submit.js";

export { attemptRepair } from "./orchestrator.js";
export type { OrchestratorInjection } from "./orchestrator.js";
