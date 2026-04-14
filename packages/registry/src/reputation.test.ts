import { describe, it, expect } from "vitest";
import {
  canAutoApprove,
  decay,
  REP_DELTA,
  scoreContributor,
  SENSITIVE_SCOPES,
  type Author,
  type RepEvent,
} from "./reputation.js";

function author(reputation = 0): Author {
  return { id: "alice", publicKey: "pk", reputation };
}

describe("scoreContributor", () => {
  it("starts at 0 for no history", () => {
    expect(scoreContributor(author(), [])).toBe(0);
  });

  it("sums event deltas in order", () => {
    const history: RepEvent[] = [
      { type: "merged", at: "2026-01-01T00:00:00Z" },
      { type: "survived-canary", at: "2026-01-02T00:00:00Z" },
      { type: "reached-fleet", at: "2026-01-03T00:00:00Z" },
    ];
    expect(scoreContributor(author(), history)).toBe(50 + 100 + 100);
  });

  it("applies negative events (revoked-bug, revoked-security)", () => {
    const history: RepEvent[] = [
      { type: "merged", at: "2026-01-01T00:00:00Z" },
      { type: "revoked-bug", at: "2026-01-02T00:00:00Z" },
    ];
    expect(scoreContributor(author(), history)).toBe(50 - 50);
  });

  it("incident is the heaviest hit (-1000)", () => {
    expect(REP_DELTA["caused-incident"]).toBe(-1000);
  });
});

describe("canAutoApprove — sensitive scopes always require human review", () => {
  for (const scope of ["auth", "secrets", "network"] as const) {
    it(`refuses to auto-approve a patch touching ${scope} at ANY reputation`, () => {
      const result = canAutoApprove({
        reputation: 1_000_000,
        scopes: [scope],
        targetStage: "canary-1",
      });
      expect(result).toBe(false);
    });
  }

  it("SENSITIVE_SCOPES contains exactly auth/secrets/network", () => {
    expect(SENSITIVE_SCOPES.has("auth")).toBe(true);
    expect(SENSITIVE_SCOPES.has("secrets")).toBe(true);
    expect(SENSITIVE_SCOPES.has("network")).toBe(true);
    expect(SENSITIVE_SCOPES.has("transform")).toBe(false);
  });

  it("refuses if ANY scope in the list is sensitive, even if others are not", () => {
    const result = canAutoApprove({
      reputation: 10_000,
      scopes: ["transform", "auth"], // mixed — auth makes it sensitive
      targetStage: "canary-1",
    });
    expect(result).toBe(false);
  });
});

describe("canAutoApprove — reputation thresholds", () => {
  it("rep=0 cannot auto-approve to any canary stage", () => {
    expect(
      canAutoApprove({ reputation: 0, scopes: ["transform"], targetStage: "static-passed" }),
    ).toBe(false);
    expect(
      canAutoApprove({ reputation: 0, scopes: ["transform"], targetStage: "canary-1" }),
    ).toBe(false);
  });

  it("rep=100 unlocks dev-ring stages (static/sandbox/diff-passed)", () => {
    expect(
      canAutoApprove({ reputation: 100, scopes: ["transform"], targetStage: "static-passed" }),
    ).toBe(true);
    expect(
      canAutoApprove({ reputation: 100, scopes: ["transform"], targetStage: "sandbox-passed" }),
    ).toBe(true);
  });

  it("rep=1000 unlocks canary-1 (not canary-10)", () => {
    expect(
      canAutoApprove({ reputation: 1000, scopes: ["transform"], targetStage: "canary-1" }),
    ).toBe(true);
    expect(
      canAutoApprove({ reputation: 1000, scopes: ["transform"], targetStage: "canary-10" }),
    ).toBe(false);
  });

  it("rep=5000 unlocks canary-10", () => {
    expect(
      canAutoApprove({ reputation: 5000, scopes: ["transform"], targetStage: "canary-10" }),
    ).toBe(true);
  });

  it("canary-100 and fleet are never auto-approved", () => {
    expect(
      canAutoApprove({ reputation: 1_000_000, scopes: ["transform"], targetStage: "canary-100" }),
    ).toBe(false);
    expect(
      canAutoApprove({ reputation: 1_000_000, scopes: ["transform"], targetStage: "fleet" }),
    ).toBe(false);
  });
});

describe("decay", () => {
  it("bug incident subtracts 50", () => {
    const a = decay(author(200), "bug");
    expect(a.reputation).toBe(150);
  });

  it("security incident subtracts 500", () => {
    const a = decay(author(1000), "security");
    expect(a.reputation).toBe(500);
  });

  it("production incident subtracts 1000", () => {
    const a = decay(author(2000), "incident");
    expect(a.reputation).toBe(1000);
  });

  it("is pure — input unchanged", () => {
    const orig = author(500);
    decay(orig, "bug");
    expect(orig.reputation).toBe(500);
  });
});
