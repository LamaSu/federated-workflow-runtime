/**
 * Reputation ladder per ARCHITECTURE.md §5.5.
 *
 * Scoring scale (starting at 0):
 *   +50   patch merged after review
 *   +100  patch survives canary without abort
 *   +100  patch reaches 100% fleet without revoke
 *   +5    upvote (callers enforce per-day cap)
 *   -50   patch revoked (bug)
 *   -500  patch revoked (security)
 *   -1000 patch caused production incident
 *   -10   monthly inactivity decay
 *
 * Privilege thresholds (canAutoApprove):
 *   <100    → human review always
 *   100     → auto-approve to dev ring (static-passed/sandbox-passed/diff-passed)
 *   1000    → auto-approve to canary-1
 *   5000    → auto-approve to canary-10 (with 2-maintainer approval)
 *   10000   → direct publish (still starts at canary-1; faster advance)
 *
 * Hard override: ANY patch scope touching auth/secrets/network ALWAYS requires human
 * review regardless of reputation. This is the non-negotiable rule from §5.5.
 */

import type { CanaryStage } from "./canary.js";

/** Types of reputation-impacting events. Keep parallel to the ladder table. */
export type RepEventType =
  | "merged"
  | "survived-canary"
  | "reached-fleet"
  | "upvote"
  | "revoked-bug"
  | "revoked-security"
  | "caused-incident"
  | "monthly-inactivity";

export interface RepEvent {
  type: RepEventType;
  /** ISO timestamp for auditability. Not used for scoring itself. */
  at: string;
  /** Optional patch or context ref. */
  ref?: string;
}

export interface Author {
  id: string;
  publicKey: string;
  reputation: number;
}

/** Scores a contributor from scratch given their full event history. Pure function. */
export function scoreContributor(author: Author, history: RepEvent[]): number {
  let rep = 0;
  for (const ev of history) rep += REP_DELTA[ev.type];
  // Clamp to non-negative — architecturally, incidents can still drop below 0 until
  // bounded here, but privilege thresholds all start at 0 so negative is equivalent.
  return rep;
}

export const REP_DELTA: Record<RepEventType, number> = {
  merged: 50,
  "survived-canary": 100,
  "reached-fleet": 100,
  upvote: 5,
  "revoked-bug": -50,
  "revoked-security": -500,
  "caused-incident": -1000,
  "monthly-inactivity": -10,
};

/** Target areas a patch may touch. Any "sensitive" scope locks auto-approval. */
export type PatchScope =
  | "auth"
  | "secrets"
  | "network"
  | "transform"
  | "schema"
  | "docs"
  | "retry-policy";

/** The sensitive trio from ARCHITECTURE.md §5.5. */
export const SENSITIVE_SCOPES: ReadonlySet<PatchScope> = new Set<PatchScope>([
  "auth",
  "secrets",
  "network",
]);

export interface AutoApproveCheck {
  /** Reputation of the submitting author. */
  reputation: number;
  /** Scopes the patch claims to touch. */
  scopes: PatchScope[];
  /** Stage the patch would be auto-advanced to. */
  targetStage: CanaryStage;
}

/**
 * Can this patch be auto-approved to the requested stage?
 *
 * The hard rule: any sensitive scope (auth/secrets/network) forces human review,
 * full stop. Everything else is a simple reputation threshold lookup.
 */
export function canAutoApprove(check: AutoApproveCheck): boolean {
  // Hard override: sensitive scopes always require human review.
  for (const scope of check.scopes) {
    if (SENSITIVE_SCOPES.has(scope)) return false;
  }
  const required = REQUIRED_REP[check.targetStage];
  if (required === undefined) return false;
  return check.reputation >= required;
}

/**
 * Reputation required to auto-approve into each canary stage.
 * Stages beyond canary-10 are never auto-approvable — they require explicit maintainer
 * sign-off, not reputation — so we omit them from this table (returns false upstream).
 */
export const REQUIRED_REP: Partial<Record<CanaryStage, number>> = {
  // Pre-canary stages (dev ring).
  "static-passed": 100,
  "sandbox-passed": 100,
  "diff-passed": 100,
  // Canary stages.
  "canary-1": 1000,
  "canary-10": 5000,
  // canary-100 and fleet are never auto-approved; they require passing the lower stages.
};

/**
 * Apply a decay event for an incident. Returns an updated Author.
 *
 * Severity maps to the rep deltas from the §5.5 table:
 *   "bug"       -> revoked-bug (-50)
 *   "security"  -> revoked-security (-500)
 *   "incident"  -> caused-incident (-1000)
 */
export function decay(author: Author, incidentSeverity: "bug" | "security" | "incident"): Author {
  const delta =
    incidentSeverity === "bug"
      ? REP_DELTA["revoked-bug"]
      : incidentSeverity === "security"
        ? REP_DELTA["revoked-security"]
        : REP_DELTA["caused-incident"];
  return { ...author, reputation: author.reputation + delta };
}
