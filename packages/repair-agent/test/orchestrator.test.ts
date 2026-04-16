import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorSignature } from "@delightfulchorus/core";
import { attemptRepair } from "../src/orchestrator.js";
import type {
  PatchProposal,
  RepairContext,
  RepairOptions,
  ValidationResult,
} from "../src/types.js";

function makeSig(): ErrorSignature {
  return {
    schemaVersion: 1,
    integration: "slack-send",
    operation: "postMessage",
    errorClass: "IntegrationError",
    httpStatus: 401,
    stackFingerprint: "fp123",
    messagePattern: "invalid_auth",
    integrationVersion: "1.4.2",
    runtimeVersion: "0.1.0",
    occurrences: 1,
    firstSeen: "2026-04-01T00:00:00Z",
    lastSeen: "2026-04-12T00:00:00Z",
  };
}

const goodDiff = [
  "--- a/src/client.ts",
  "+++ b/src/client.ts",
  "@@ -1,1 +1,1 @@",
  "-export const x = 1;",
  "+export const x = 2;",
].join("\n");

function stubContext(): RepairContext {
  return {
    error: makeSig(),
    manifest: {
      name: "slack-send",
      version: "1.4.2",
      description: "Slack",
      authType: "oauth2",
      credentialTypes: [],
      operations: [],
    },
    sourceFiles: [{ relPath: "src/client.ts", contents: "export const x = 1;\n" }],
    integrationDir: "/tmp/fake",
    cassettes: [
      {
        id: "cassette-1",
        integration: "slack-send",
        interaction: {
          request: { method: "POST", urlTemplate: "/x", headerNames: [] },
          response: { status: 200, headerNames: [] },
        },
        timestamp: "2026-04-12T00:00:00Z",
        durationMs: 100,
        succeeded: true,
      },
    ],
    vendorDocs: null,
  };
}

describe("attemptRepair — full loop with stubs", () => {
  let tmp: string;
  let integrationDir: string;
  let cassetteDir: string;
  let patchesDir: string;
  let privateDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "chorus-orch-"));
    integrationDir = join(tmp, "integration");
    cassetteDir = join(tmp, "cassettes");
    patchesDir = join(tmp, "patches");
    privateDir = join(tmp, "private");
    await mkdir(integrationDir, { recursive: true });
    await mkdir(cassetteDir, { recursive: true });
    await mkdir(patchesDir, { recursive: true });
    await mkdir(privateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function baseOpts(): RepairOptions {
    return {
      integrationDir,
      cassetteDir,
      patchesDir,
      mode: "private",
      reputation: 0,
      apiKey: "sk-test",
    };
  }

  it("full happy path: propose → validate → submit → success", async () => {
    const proposeStub = vi.fn(async (): Promise<PatchProposal> => ({
      diff: goodDiff,
      explanation: "fix",
      confidence: "high",
      testsRecommended: [],
    }));
    const applyPatchStub = vi.fn(async () => "/tmp/fake-applied");
    const replayStub = vi.fn(
      async (): Promise<ValidationResult> => ({
        passed: 1,
        failed: 0,
        errors: [],
        tempDir: "/tmp/fake-applied",
        ok: true,
      }),
    );
    const result = await attemptRepair(
      makeSig(),
      { ...baseOpts() },
      {
        assembleContext: vi.fn(async () => stubContext()),
        propose: proposeStub,
        applyPatch: applyPatchStub,
        replay: replayStub,
        submit: async (proposal, sig, mode) => ({
          mode,
          location: join(privateDir, "stub.json"),
          patchId: `${sig.integration}_stub`,
          submittedAt: new Date().toISOString(),
        }),
      },
    );

    expect(result.status).toBe("success");
    expect(result.phase).toBe("done");
    expect(result.reason).toBe("success");
    expect(result.submission?.mode).toBe("private");
    expect(proposeStub).toHaveBeenCalledTimes(1);
    expect(applyPatchStub).toHaveBeenCalledTimes(1);
    expect(replayStub).toHaveBeenCalledTimes(1);
  });

  it("dedupes when a patch for this signature already exists", async () => {
    // Pre-seed patchesDir with a file carrying the same signature hash.
    // The orchestrator computes the hash via the same canonical JSON form.
    const sig = makeSig();
    const { createHash } = await import("node:crypto");
    const sigHash = createHash("sha256")
      .update(
        JSON.stringify({
          integration: sig.integration,
          operation: sig.operation,
          errorClass: sig.errorClass,
          httpStatus: sig.httpStatus ?? null,
          stackFingerprint: sig.stackFingerprint,
          messagePattern: sig.messagePattern,
        }),
      )
      .digest("hex");
    await writeFile(
      join(patchesDir, "existing.json"),
      JSON.stringify({ signatureHash: sigHash, patchId: "existing-id" }),
      "utf8",
    );

    const proposeStub = vi.fn(async (): Promise<PatchProposal> => ({
      diff: goodDiff,
      explanation: "fix",
      confidence: "high",
      testsRecommended: [],
    }));
    const result = await attemptRepair(sig, baseOpts(), {
      assembleContext: vi.fn(async () => stubContext()),
      propose: proposeStub,
    });

    expect(result.status).toBe("success");
    expect(result.phase).toBe("dedupe");
    expect(result.reason).toBe("already-patched");
    expect(proposeStub).not.toHaveBeenCalled();
  });

  it("returns stub reason when proposer returns a stubbed proposal (no API key)", async () => {
    const result = await attemptRepair(makeSig(), baseOpts(), {
      assembleContext: vi.fn(async () => stubContext()),
      propose: async () => ({
        diff: "",
        explanation: "ANTHROPIC_API_KEY not set",
        confidence: "low",
        testsRecommended: [],
        stub: true,
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.phase).toBe("propose");
    expect(result.reason).toBe("no-api-key-stub");
  });

  it("retries once when validation fails with high confidence", async () => {
    let attempts = 0;
    const proposeStub = vi.fn(async (): Promise<PatchProposal> => {
      attempts += 1;
      return {
        diff: goodDiff,
        explanation: attempts === 1 ? "try one" : "try two",
        confidence: "high",
        testsRecommended: [],
      };
    });

    let replayCount = 0;
    const replayStub = vi.fn(async (): Promise<ValidationResult> => {
      replayCount += 1;
      const ok = replayCount === 2;
      return {
        passed: ok ? 1 : 0,
        failed: ok ? 0 : 1,
        errors: ok ? [] : [{ cassetteId: "cassette-1", message: "mismatch" }],
        tempDir: "/tmp/fake",
        ok,
      };
    });

    const result = await attemptRepair(
      makeSig(),
      { ...baseOpts(), maxRetries: 2 },
      {
        assembleContext: vi.fn(async () => stubContext()),
        propose: proposeStub,
        applyPatch: vi.fn(async () => "/tmp/fake"),
        replay: replayStub,
        submit: async (_p, sig, mode) => ({
          mode,
          location: "ok",
          patchId: `${sig.integration}_ok`,
          submittedAt: new Date().toISOString(),
        }),
      },
    );
    expect(result.status).toBe("success");
    expect(result.attempts).toBe(2);
    expect(proposeStub).toHaveBeenCalledTimes(2);
  });

  it("does not retry when confidence is low", async () => {
    const proposeStub = vi.fn(async (): Promise<PatchProposal> => ({
      diff: goodDiff,
      explanation: "guess",
      confidence: "low",
      testsRecommended: [],
    }));
    const replayStub = vi.fn(async (): Promise<ValidationResult> => ({
      passed: 0,
      failed: 1,
      errors: [{ cassetteId: "cassette-1", message: "bad" }],
      tempDir: "/tmp",
      ok: false,
    }));

    const result = await attemptRepair(
      makeSig(),
      { ...baseOpts(), maxRetries: 2 },
      {
        assembleContext: vi.fn(async () => stubContext()),
        propose: proposeStub,
        applyPatch: vi.fn(async () => "/tmp"),
        replay: replayStub,
      },
    );
    expect(result.status).toBe("failed");
    expect(result.phase).toBe("validate");
    expect(result.reason).toBe("validation-failed");
    expect(proposeStub).toHaveBeenCalledTimes(1);
  });

  it("returns submission-blocked when rep floor is enforced", async () => {
    const result = await attemptRepair(
      makeSig(),
      {
        ...baseOpts(),
        mode: "community",
        reputation: 5,
        registryUrl: "https://example.com",
        signingKey: "k",
      },
      {
        assembleContext: vi.fn(async () => stubContext()),
        propose: async () => ({
          diff: goodDiff,
          explanation: "ok",
          confidence: "high",
          testsRecommended: [],
        }),
        applyPatch: async () => "/tmp/x",
        replay: async () => ({
          passed: 1,
          failed: 0,
          errors: [],
          tempDir: "/tmp/x",
          ok: true,
        }),
      },
    );

    expect(result.status).toBe("partial");
    expect(result.phase).toBe("submit");
    expect(result.reason).toBe("submission-blocked");
    expect(result.message).toMatch(/rep/);
  });

  it("returns propose-failed when Claude returns an empty diff with non-low confidence", async () => {
    const result = await attemptRepair(
      makeSig(),
      baseOpts(),
      {
        assembleContext: vi.fn(async () => stubContext()),
        propose: async () => ({
          diff: "",
          explanation: "I am not sure",
          confidence: "medium",
          testsRecommended: [],
        }),
      },
    );
    expect(result.status).toBe("failed");
    expect(result.phase).toBe("propose");
    expect(result.reason).toBe("propose-failed");
  });

  it("logs structured events through the provided logger", async () => {
    const events: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, data?: Record<string, unknown>) =>
        events.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) =>
        events.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) =>
        events.push({ level: "error", msg, data }),
    };

    await attemptRepair(
      makeSig(),
      { ...baseOpts(), logger },
      {
        assembleContext: vi.fn(async () => stubContext()),
        propose: async () => ({
          diff: goodDiff,
          explanation: "ok",
          confidence: "high",
          testsRecommended: [],
        }),
        applyPatch: async () => "/tmp/x",
        replay: async () => ({
          passed: 1,
          failed: 0,
          errors: [],
          tempDir: "/tmp/x",
          ok: true,
        }),
        submit: async (_p, sig, mode) => ({
          mode,
          location: "/tmp/patch.json",
          patchId: `${sig.integration}_x`,
          submittedAt: new Date().toISOString(),
        }),
      },
    );

    const names = events.map((e) => e.msg);
    expect(names).toContain("repair.start");
    expect(names).toContain("repair.propose.start");
    expect(names).toContain("repair.validate.start");
    expect(names).toContain("repair.success");
  });
});
