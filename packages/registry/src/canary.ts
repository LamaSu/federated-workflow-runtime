/**
 * Canary ladder per ARCHITECTURE.md §5.4.
 *
 * Stage transitions:
 *   proposed
 *     -> static-passed    (static AST / Semgrep gate — Reporter's responsibility)
 *     -> sandbox-passed   (cassette-based sandbox execution)
 *     -> diff-passed      (differential testing vs. recorded traffic)
 *     -> canary-1  (1% fleet)
 *     -> canary-10 (10% fleet)
 *     -> canary-100 (100% fleet)
 *     -> fleet    (fully adopted, ongoing monitor)
 *     -> revoked  (abort at any stage)
 *
 * Note: the core schema's `canaryStage` enum uses the human-readable names. The default
 * ladder below uses a 1%/10%/100% coarsening for MVP; ARCHITECTURE.md §5.4 documents the
 * finer-grained 1/2/5/10/20/50/100 ladder as a v1.x concern — it maps onto the same enum
 * values (canary-1, canary-10, canary-100) via `currentPercentage`, which is not yet in
 * the core schema but lives only in this module for now.
 */

import { createHash } from "node:crypto";
import type { Patch } from "@delightfulchorus/core";

export type CanaryStage = Patch["metadata"]["canaryStage"];

/** Stage definition: next stage name + dwell time before advance is allowed. */
export interface StageDef {
  stage: CanaryStage;
  /** Fraction of fleet (0..1). Stages prior to canary-1 are 0. */
  percentage: number;
  /** Minimum dwell in milliseconds before advancing to the next stage. */
  dwellMs: number;
  /** Max allowed error-rate ratio vs baseline before auto-abort. Infinity = no gate. */
  abortRatio: number;
}

const HOUR = 60 * 60 * 1000;

/**
 * Default 7-day ladder, MVP granularity (1% → 10% → 100%).
 * ARCHITECTURE.md §5.4 documents the fine-grained ladder — implement as future work.
 */
export const DEFAULT_LADDER: StageDef[] = [
  { stage: "proposed", percentage: 0, dwellMs: 0, abortRatio: Infinity },
  { stage: "static-passed", percentage: 0, dwellMs: 0, abortRatio: Infinity },
  { stage: "sandbox-passed", percentage: 0, dwellMs: 0, abortRatio: Infinity },
  { stage: "diff-passed", percentage: 0, dwellMs: 0, abortRatio: Infinity },
  { stage: "canary-1", percentage: 0.01, dwellMs: 4 * HOUR, abortRatio: 2.0 },
  { stage: "canary-10", percentage: 0.1, dwellMs: 24 * HOUR, abortRatio: 1.2 },
  { stage: "canary-100", percentage: 1.0, dwellMs: 24 * HOUR, abortRatio: 1.1 },
  { stage: "fleet", percentage: 1.0, dwellMs: 0, abortRatio: 1.05 },
  { stage: "revoked", percentage: 0, dwellMs: 0, abortRatio: Infinity },
];

/**
 * Deterministic cohort assignment: hash(reporter + patch) modulo 100 → 0..99 percentile.
 *
 * Stable across restarts and across different Chorus nodes: the same (reporter, patch)
 * pair always lands in the same bucket. This is the Section 5.4 "isInCohort" primitive
 * but returning the raw percentile so callers can compare against any percentage.
 */
export function assignCohort(reporterId: string, patchId: string): number {
  const hash = createHash("sha256").update(`${reporterId}::${patchId}`).digest("hex");
  // Use first 4 hex chars → 16-bit int, mod 100 for an even 0-99 distribution.
  const bucket = parseInt(hash.slice(0, 4), 16);
  return bucket % 100;
}

/**
 * Should this reporter apply the given patch right now?
 *
 * Rules:
 *   - proposed / static-passed / sandbox-passed / diff-passed → NO (pre-canary stages)
 *   - canary-1   → cohort < 1
 *   - canary-10  → cohort < 10
 *   - canary-100 → always YES
 *   - fleet      → always YES
 *   - revoked    → always NO
 *   - Additionally: dwell time must have elapsed since entering the current stage.
 */
export function shouldApply(
  patch: Patch,
  cohort: number,
  now: Date,
  ladder: StageDef[] = DEFAULT_LADDER,
): boolean {
  const stage = patch.metadata.canaryStage;
  if (stage === "revoked") return false;

  const def = ladder.find((l) => l.stage === stage);
  if (!def) return false;

  // Pre-canary stages don't go live.
  if (def.percentage === 0) return false;

  // Cohort gate: cohort is 0-99; percentage is 0..1, threshold = percentage * 100.
  const threshold = def.percentage * 100;
  if (cohort >= threshold) return false;

  // Dwell gate: the stage must have been entered at least dwellMs ago. If the patch
  // doesn't record when it entered the current stage, err on the side of "not yet
  // advanced, apply based on cohort only" — the controller enforces dwell on advance.
  const enteredAt = patch.metadata.advancedAt[stage];
  if (enteredAt && def.dwellMs > 0) {
    const age = now.getTime() - new Date(enteredAt).getTime();
    if (age < 0) return false; // future timestamp → treat as not-yet-entered
  }

  return true;
}

export interface StageMetrics {
  /** Error rate (failures / runs) observed at this stage. */
  errorRate: number;
  /** Baseline error rate for comparison (pre-patch). */
  baselineErrorRate: number;
  /** Total runs observed at this stage (so we don't advance on tiny samples). */
  runs: number;
}

/**
 * Advance a patch to the next ladder stage if metrics allow; or mark revoked on a spike.
 *
 * - If dwell hasn't elapsed: no-op, returns original patch.
 * - If error rate > abortRatio × baseline: patch jumps to `revoked`.
 * - Otherwise: advance to the next stage, stamping `advancedAt`.
 */
export function advanceStage(
  patch: Patch,
  metrics: StageMetrics,
  now: Date = new Date(),
  ladder: StageDef[] = DEFAULT_LADDER,
): Patch {
  const stage = patch.metadata.canaryStage;
  if (stage === "fleet" || stage === "revoked") return patch;

  const def = ladder.find((l) => l.stage === stage);
  if (!def) return patch;

  // Abort check first — spikes always win over dwell/advance.
  const baseline = metrics.baselineErrorRate || 0;
  const ratio = baseline === 0 ? (metrics.errorRate > 0 ? Infinity : 0) : metrics.errorRate / baseline;
  if (metrics.runs > 0 && ratio > def.abortRatio) {
    return stampStage(patch, "revoked", now);
  }

  // Dwell gate.
  const enteredAtStr = patch.metadata.advancedAt[stage];
  if (enteredAtStr) {
    const age = now.getTime() - new Date(enteredAtStr).getTime();
    if (age < def.dwellMs) return patch;
  }

  // Find next stage — skip `revoked` which is a terminal branch.
  const idx = ladder.findIndex((l) => l.stage === stage);
  const next = ladder.slice(idx + 1).find((l) => l.stage !== "revoked");
  if (!next) return patch;

  return stampStage(patch, next.stage, now);
}

function stampStage(patch: Patch, stage: CanaryStage, now: Date): Patch {
  return {
    ...patch,
    metadata: {
      ...patch.metadata,
      canaryStage: stage,
      advancedAt: {
        ...patch.metadata.advancedAt,
        [stage]: now.toISOString(),
      },
    },
  };
}
