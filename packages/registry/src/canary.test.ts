import { describe, it, expect } from "vitest";
import type { Patch } from "@chorus/core";
import {
  advanceStage,
  assignCohort,
  DEFAULT_LADDER,
  shouldApply,
} from "./canary.js";

function patchAt(
  stage: Patch["metadata"]["canaryStage"],
  advancedAt: Record<string, string> = {},
): Patch {
  return {
    metadata: {
      id: "test-patch",
      integration: "slack-send",
      errorSignatureHash: "sig",
      description: "",
      author: { id: "a", publicKey: "pk", reputation: 0 },
      beforeVersion: "1.0.0",
      afterVersion: "1.0.1",
      testsAdded: [],
      canaryStage: stage,
      createdAt: "2026-04-13T00:00:00Z",
      advancedAt,
    },
    diff: "",
    snapshotUpdates: [],
    signature: "",
    signatureAlgorithm: "ed25519",
  };
}

describe("assignCohort", () => {
  it("is stable for the same (reporter, patch) pair across calls", () => {
    const a = assignCohort("reporter-1", "patch-A");
    const b = assignCohort("reporter-1", "patch-A");
    expect(a).toBe(b);
  });

  it("returns a value in [0, 99]", () => {
    for (let i = 0; i < 50; i++) {
      const v = assignCohort(`r-${i}`, "patch-A");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(100);
    }
  });

  it("differs across reporters (distribution check, not exhaustive)", () => {
    const s = new Set<number>();
    for (let i = 0; i < 200; i++) {
      s.add(assignCohort(`reporter-${i}`, "patch-A"));
    }
    // With 200 reporters over 100 buckets we expect many distinct bucket hits.
    expect(s.size).toBeGreaterThan(50);
  });
});

describe("shouldApply", () => {
  const NOW = new Date("2026-04-15T00:00:00Z");

  it("rejects pre-canary stages (proposed, static-passed, sandbox-passed, diff-passed)", () => {
    for (const s of ["proposed", "static-passed", "sandbox-passed", "diff-passed"] as const) {
      expect(shouldApply(patchAt(s), 0, NOW)).toBe(false);
    }
  });

  it("rejects revoked patches regardless of cohort", () => {
    expect(shouldApply(patchAt("revoked"), 0, NOW)).toBe(false);
    expect(shouldApply(patchAt("revoked"), 99, NOW)).toBe(false);
  });

  it("canary-1: only cohort 0 applies", () => {
    const p = patchAt("canary-1", { "canary-1": "2026-04-13T00:00:00Z" });
    expect(shouldApply(p, 0, NOW)).toBe(true);
    expect(shouldApply(p, 1, NOW)).toBe(false);
    expect(shouldApply(p, 50, NOW)).toBe(false);
  });

  it("canary-10: cohorts 0-9 apply, 10+ do not", () => {
    const p = patchAt("canary-10", { "canary-10": "2026-04-13T00:00:00Z" });
    for (let i = 0; i < 10; i++) expect(shouldApply(p, i, NOW)).toBe(true);
    for (let i = 10; i < 100; i++) expect(shouldApply(p, i, NOW)).toBe(false);
  });

  it("canary-100: all cohorts apply", () => {
    const p = patchAt("canary-100", { "canary-100": "2026-04-13T00:00:00Z" });
    for (const c of [0, 50, 99]) expect(shouldApply(p, c, NOW)).toBe(true);
  });

  it("fleet: all cohorts apply", () => {
    const p = patchAt("fleet", { fleet: "2026-04-13T00:00:00Z" });
    expect(shouldApply(p, 50, NOW)).toBe(true);
  });

  it("cohort stability across restarts: same pair, same result", () => {
    const c = assignCohort("reporter-X", "patch-Y");
    const p = patchAt("canary-10", { "canary-10": "2026-04-13T00:00:00Z" });
    expect(shouldApply(p, c, NOW)).toBe(shouldApply(p, c, NOW));
  });
});

describe("advanceStage", () => {
  const metricsOk = { errorRate: 0.01, baselineErrorRate: 0.01, runs: 1000 };
  const metricsSpike = { errorRate: 0.5, baselineErrorRate: 0.01, runs: 1000 };

  it("advances from canary-1 to canary-10 after dwell with healthy metrics", () => {
    const entered = new Date("2026-04-13T00:00:00Z");
    const afterDwell = new Date("2026-04-13T05:00:00Z"); // 5h > 4h dwell
    const p = patchAt("canary-1", { "canary-1": entered.toISOString() });
    const advanced = advanceStage(p, metricsOk, afterDwell);
    expect(advanced.metadata.canaryStage).toBe("canary-10");
    expect(advanced.metadata.advancedAt["canary-10"]).toBeDefined();
  });

  it("does NOT advance if dwell has not elapsed", () => {
    const entered = new Date("2026-04-13T00:00:00Z");
    const tooEarly = new Date("2026-04-13T01:00:00Z"); // 1h < 4h
    const p = patchAt("canary-1", { "canary-1": entered.toISOString() });
    const next = advanceStage(p, metricsOk, tooEarly);
    expect(next.metadata.canaryStage).toBe("canary-1");
  });

  it("aborts to revoked on error-rate spike above abortRatio", () => {
    const entered = new Date("2026-04-13T00:00:00Z");
    const later = new Date("2026-04-13T05:00:00Z");
    const p = patchAt("canary-1", { "canary-1": entered.toISOString() });
    const aborted = advanceStage(p, metricsSpike, later);
    expect(aborted.metadata.canaryStage).toBe("revoked");
  });

  it("is a no-op at fleet (terminal stage)", () => {
    const p = patchAt("fleet", { fleet: "2026-04-13T00:00:00Z" });
    expect(advanceStage(p, metricsOk).metadata.canaryStage).toBe("fleet");
  });

  it("is a no-op when already revoked", () => {
    const p = patchAt("revoked", { revoked: "2026-04-13T00:00:00Z" });
    expect(advanceStage(p, metricsOk).metadata.canaryStage).toBe("revoked");
  });

  it("walks through pre-canary stages on repeated advance (dwell=0)", () => {
    const p = patchAt("proposed", { proposed: "2026-04-13T00:00:00Z" });
    const s1 = advanceStage(p, metricsOk, new Date("2026-04-13T01:00:00Z"));
    expect(s1.metadata.canaryStage).toBe("static-passed");
    const s2 = advanceStage(s1, metricsOk, new Date("2026-04-13T01:01:00Z"));
    expect(s2.metadata.canaryStage).toBe("sandbox-passed");
  });
});

describe("default ladder self-consistency", () => {
  it("has abortRatio >= 1.0 for every canary stage", () => {
    for (const def of DEFAULT_LADDER) {
      if (def.stage.startsWith("canary") || def.stage === "fleet") {
        expect(def.abortRatio).toBeGreaterThanOrEqual(1.0);
      }
    }
  });

  it("has strictly non-decreasing percentages through canary-*", () => {
    const canaryDefs = DEFAULT_LADDER.filter((d) => d.stage.startsWith("canary"));
    for (let i = 1; i < canaryDefs.length; i++) {
      const prev = canaryDefs[i - 1];
      const curr = canaryDefs[i];
      if (prev && curr) {
        expect(curr.percentage).toBeGreaterThanOrEqual(prev.percentage);
      }
    }
  });
});
