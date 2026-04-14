import type { ErrorSignature, IntegrationManifest } from "@chorus/core";

/**
 * A recorded HTTP interaction, indexed by error signature hash.
 * Matches CassetteEntrySchema in ARCHITECTURE.md §8.3.
 */
export interface Cassette {
  id: string;
  integration: string;
  signatureHash?: string;
  interaction: {
    request: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
      urlTemplate: string;
      headerNames: string[];
      bodyShape?: unknown;
    };
    response: {
      status: number;
      headerNames: string[];
      bodyShape?: unknown;
      bodySnippet?: string;
    };
  };
  timestamp: string;
  durationMs: number;
  /** Whether this cassette is known to have succeeded on the current integration code. */
  succeeded: boolean;
}

/**
 * A source file in the failing integration — path + contents.
 * Paths are relative to the integration root so patches can target them.
 */
export interface SourceFile {
  /** Relative path from integration root, forward-slash separated (e.g. "src/client.ts"). */
  relPath: string;
  contents: string;
}

/**
 * Everything the repair agent needs to propose a patch.
 */
export interface RepairContext {
  error: ErrorSignature;
  /** Full manifest of the failing integration (from its package.json / integration manifest). */
  manifest: IntegrationManifest | null;
  /** Integration source files, truncated / filtered to fit context budget. */
  sourceFiles: SourceFile[];
  /** Root directory of the integration source on disk (absolute). */
  integrationDir: string;
  /** Recent cassettes for comparison. Most recent first. May include the failing one. */
  cassettes: Cassette[];
  /** Vendor documentation text — optional, may be null if no docsUrl was fetched. */
  vendorDocs: string | null;
}

export type PatchConfidence = "low" | "medium" | "high";

/**
 * The structured output of `proposePatch`.
 * `diff` is the unified diff, exactly as produced by Claude.
 */
export interface PatchProposal {
  /** Unified diff text, applied with `git apply`. No prose, no fences. */
  diff: string;
  /** Human-readable explanation (stripped out of the diff block). */
  explanation: string;
  confidence: PatchConfidence;
  /** Names of cassette/test scenarios that would be worth re-checking. */
  testsRecommended: string[];
  /** Whether this came from a stubbed call (no ANTHROPIC_API_KEY). */
  stub?: boolean;
}

export interface ValidationResult {
  /** Number of cassettes that replayed green. */
  passed: number;
  /** Number of cassettes that replayed red. */
  failed: number;
  /** Thrown errors during replay (stringified). */
  errors: Array<{ cassetteId: string; message: string }>;
  /** Temp dir path (for inspection on failure). Null after cleanup. */
  tempDir: string | null;
  /** Overall verdict. */
  ok: boolean;
}

export type SubmissionMode = "community" | "private";

export interface SubmissionResult {
  mode: SubmissionMode;
  /** Where the patch was written. For community, this is the registry URL + id. For private, a local path. */
  location: string;
  /** Registry-assigned id, or locally-generated id for private mode. */
  patchId: string;
  submittedAt: string;
}

export interface RepairOptions {
  integrationDir: string;
  cassetteDir: string;
  /** Where existing patch proposals live (so we can dedupe by signature hash). */
  patchesDir?: string;
  vendorDocsCache?: string;
  /** "community" submits to the shared registry; "private" keeps it local. */
  mode: SubmissionMode;
  /** User's current reputation. Enforced by submit.ts. */
  reputation: number;
  /** Minimum reputation required for community submission. Default 100. */
  communityRepFloor?: number;
  /** Registry base URL (for community mode). */
  registryUrl?: string;
  /** Signing key material for community submissions (opaque — passed to submit). */
  signingKey?: string;
  /** Anthropic model to use. */
  model?: string;
  maxTokens?: number;
  /** Explicit API key. If not provided, reads ANTHROPIC_API_KEY from env. */
  apiKey?: string;
  /** Max self-retry attempts when validation fails with high confidence. */
  maxRetries?: number;
  /** Optional logger for structured events. */
  logger?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}

export type RepairPhase =
  | "dedupe"
  | "context"
  | "propose"
  | "validate"
  | "submit"
  | "done";

export type RepairReason =
  | "already-patched"
  | "context-failed"
  | "propose-failed"
  | "validation-failed"
  | "submission-blocked"
  | "success"
  | "retries-exhausted"
  | "no-api-key-stub";

export interface RepairResult {
  status: "success" | "partial" | "failed";
  phase: RepairPhase;
  reason: RepairReason;
  proposal?: PatchProposal;
  validation?: ValidationResult;
  submission?: SubmissionResult;
  attempts: number;
  /** Human-readable message for the operator. */
  message: string;
}
