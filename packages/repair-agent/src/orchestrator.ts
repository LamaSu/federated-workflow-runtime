import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorSignature } from "@chorus/core";
import { assembleRepairContext } from "./context.js";
import { proposePatch } from "./propose.js";
import type {
  PatchProposal,
  RepairOptions,
  RepairResult,
  SubmissionResult,
  ValidationResult,
} from "./types.js";
import {
  ReputationFloorError,
  submitPatchProposal,
} from "./submit.js";
import {
  applyPatchToTempDir,
  cleanupTempDir,
  replayCassettes,
} from "./validate.js";

/**
 * Injection point for tests — pass a stubbed proposer so we don't hit Anthropic.
 */
export interface OrchestratorInjection {
  propose?: typeof proposePatch;
  assembleContext?: typeof assembleRepairContext;
  applyPatch?: typeof applyPatchToTempDir;
  replay?: typeof replayCassettes;
  submit?: typeof submitPatchProposal;
}

/**
 * Full repair loop — matches §7 of ARCHITECTURE.md.
 *
 * Steps:
 *   1. dedupe: check if patch already exists for this signature hash → early return
 *   2. assembleRepairContext
 *   3. proposePatch (Claude)
 *   4. validate against cassettes
 *   5. if PASS: submit per mode.
 *      if FAIL and confidence was high: retry (up to maxRetries, default 2)
 *      if FAIL otherwise: return reason
 */
export async function attemptRepair(
  sig: ErrorSignature,
  opts: RepairOptions,
  inject: OrchestratorInjection = {},
): Promise<RepairResult> {
  const log = opts.logger ?? silentLogger();
  const maxRetries = opts.maxRetries ?? 2;
  const propose = inject.propose ?? proposePatch;
  const assemble = inject.assembleContext ?? assembleRepairContext;
  const applyPatch = inject.applyPatch ?? applyPatchToTempDir;
  const replay = inject.replay ?? replayCassettes;
  const submit = inject.submit ?? submitPatchProposal;

  const sigHash = hashSig(sig);
  log.info("repair.start", { sigHash, integration: sig.integration });

  // ── Phase 1: dedupe ───────────────────────────────────────────────────
  if (opts.patchesDir) {
    const existing = await findExistingPatch(opts.patchesDir, sigHash);
    if (existing) {
      log.info("repair.already-patched", { sigHash, existing });
      return {
        status: "success",
        phase: "dedupe",
        reason: "already-patched",
        attempts: 0,
        message: `patch already exists: ${existing}`,
      };
    }
  }

  // ── Phase 2: context ──────────────────────────────────────────────────
  let context;
  try {
    context = await assemble(sig, {
      integrationDir: opts.integrationDir,
      cassetteDir: opts.cassetteDir,
      vendorDocsCache: opts.vendorDocsCache,
    });
  } catch (err) {
    log.error("repair.context-failed", { error: (err as Error).message });
    return {
      status: "failed",
      phase: "context",
      reason: "context-failed",
      attempts: 0,
      message: (err as Error).message,
    };
  }

  let attempts = 0;
  let lastProposal: PatchProposal | undefined;
  let lastValidation: ValidationResult | undefined;

  while (attempts <= maxRetries) {
    attempts += 1;
    log.info("repair.propose.start", { attempt: attempts });

    // ── Phase 3: propose ────────────────────────────────────────────────
    let proposal: PatchProposal;
    try {
      proposal = await propose(context, {
        model: opts.model,
        maxTokens: opts.maxTokens,
        apiKey: opts.apiKey,
      });
    } catch (err) {
      log.error("repair.propose.failed", { error: (err as Error).message });
      return {
        status: "failed",
        phase: "propose",
        reason: "propose-failed",
        attempts,
        message: (err as Error).message,
      };
    }

    lastProposal = proposal;

    if (proposal.stub) {
      log.warn("repair.propose.stub", { reason: "no-api-key" });
      return {
        status: "failed",
        phase: "propose",
        reason: "no-api-key-stub",
        proposal,
        attempts,
        message: proposal.explanation,
      };
    }

    if (proposal.diff === "") {
      log.warn("repair.propose.empty-diff", {
        confidence: proposal.confidence,
        explanation: proposal.explanation,
      });
      return {
        status: "failed",
        phase: "propose",
        reason: "propose-failed",
        proposal,
        attempts,
        message: `Claude returned empty diff: ${proposal.explanation}`,
      };
    }

    // ── Phase 4: validate ───────────────────────────────────────────────
    log.info("repair.validate.start", { attempt: attempts });
    let tempDir: string | null = null;
    try {
      tempDir = await applyPatch(proposal.diff, opts.integrationDir);
      const validation = await replay(tempDir, context.cassettes);
      lastValidation = validation;
      log.info("repair.validate.done", {
        attempt: attempts,
        passed: validation.passed,
        failed: validation.failed,
        ok: validation.ok,
      });

      if (validation.ok) {
        // ── Phase 5: submit ──────────────────────────────────────────────
        return await doSubmit(proposal, validation, attempts, submit, sig, opts, log);
      }

      // Validation failed. Retry if high confidence and budget remains.
      if (proposal.confidence === "high" && attempts <= maxRetries) {
        log.warn("repair.validate.retry", {
          attempt: attempts,
          failed: validation.failed,
        });
        continue;
      }

      await cleanupTempDir(tempDir);
      return {
        status: "failed",
        phase: "validate",
        reason: "validation-failed",
        proposal,
        validation,
        attempts,
        message: `validation failed: ${validation.failed} of ${context.cassettes.length} cassettes regressed`,
      };
    } catch (err) {
      await cleanupTempDir(tempDir);
      log.error("repair.validate.exception", {
        attempt: attempts,
        error: (err as Error).message,
      });
      // High-confidence high-effort retry.
      if (proposal.confidence === "high" && attempts <= maxRetries) {
        continue;
      }
      return {
        status: "failed",
        phase: "validate",
        reason: "validation-failed",
        proposal,
        attempts,
        message: (err as Error).message,
      };
    }
  }

  return {
    status: "failed",
    phase: "validate",
    reason: "retries-exhausted",
    proposal: lastProposal,
    validation: lastValidation,
    attempts,
    message: `exhausted ${attempts} attempts`,
  };
}

async function doSubmit(
  proposal: PatchProposal,
  validation: ValidationResult,
  attempts: number,
  submit: typeof submitPatchProposal,
  sig: ErrorSignature,
  opts: RepairOptions,
  log: NonNullable<RepairOptions["logger"]>,
): Promise<RepairResult> {
  let submission: SubmissionResult;
  try {
    submission = await submit(proposal, sig, opts.mode, {
      registryUrl: opts.registryUrl,
      signingKey: opts.signingKey,
      reputation: opts.reputation,
      communityRepFloor: opts.communityRepFloor,
    });
  } catch (err) {
    if (err instanceof ReputationFloorError) {
      log.warn("repair.submit.rep-floor", {
        required: err.required,
        actual: err.actual,
      });
      return {
        status: "partial",
        phase: "submit",
        reason: "submission-blocked",
        proposal,
        validation,
        attempts,
        message: err.message,
      };
    }
    log.error("repair.submit.failed", { error: (err as Error).message });
    return {
      status: "partial",
      phase: "submit",
      reason: "submission-blocked",
      proposal,
      validation,
      attempts,
      message: (err as Error).message,
    };
  }

  await cleanupTempDir(validation.tempDir);
  log.info("repair.success", {
    patchId: submission.patchId,
    mode: submission.mode,
    attempts,
  });
  return {
    status: "success",
    phase: "done",
    reason: "success",
    proposal,
    validation: { ...validation, tempDir: null },
    submission,
    attempts,
    message: `patch submitted (${submission.mode}): ${submission.location}`,
  };
}

async function findExistingPatch(
  patchesDir: string,
  sigHash: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(patchesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const file = join(patchesDir, ent.name);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { signatureHash?: string };
      if (parsed.signatureHash === sigHash) return file;
    } catch {
      // skip
    }
  }
  return null;
}

function hashSig(sig: ErrorSignature): string {
  const canonical = JSON.stringify({
    integration: sig.integration,
    operation: sig.operation,
    errorClass: sig.errorClass,
    httpStatus: sig.httpStatus ?? null,
    stackFingerprint: sig.stackFingerprint,
    messagePattern: sig.messagePattern,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
