import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorSignature } from "@delightfulchorus/core";
import {
  RegistrySubmitError,
  ReputationFloorError,
  submitPatchProposal,
} from "../src/submit.js";
import type { PatchProposal } from "../src/types.js";

function makeSig(): ErrorSignature {
  return {
    schemaVersion: 1,
    integration: "slack-send",
    operation: "postMessage",
    errorClass: "IntegrationError",
    httpStatus: 401,
    stackFingerprint: "fp",
    messagePattern: "invalid_auth",
    integrationVersion: "1.4.2",
    runtimeVersion: "0.1.0",
    occurrences: 1,
    firstSeen: "2026-04-01T00:00:00Z",
    lastSeen: "2026-04-12T00:00:00Z",
  };
}

function makeProposal(): PatchProposal {
  return {
    diff: [
      "--- a/src/client.ts",
      "+++ b/src/client.ts",
      "@@ -1,1 +1,1 @@",
      "-export const x = 1;",
      "+export const x = 2;",
    ].join("\n"),
    explanation: "fix",
    confidence: "high",
    testsRecommended: [],
  };
}

describe("submitPatchProposal", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "chorus-submit-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("private mode", () => {
    it("writes the proposal to the pending dir", async () => {
      const result = await submitPatchProposal(makeProposal(), makeSig(), "private", {
        privateDir: tmp,
        reputation: 0,
      });

      expect(result.mode).toBe("private");
      expect(result.location).toContain(tmp);
      expect(result.patchId).toContain("slack-send");

      const entries = await readdir(tmp);
      expect(entries.length).toBe(1);

      const raw = await readFile(join(tmp, entries[0] as string), "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.integration).toBe("slack-send");
      expect(parsed.proposal.diff).toContain("--- a/src/client.ts");
      expect(parsed.signatureHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("does not require registry URL or reputation for private mode", async () => {
      // rep=0 should be fine for private mode.
      const result = await submitPatchProposal(makeProposal(), makeSig(), "private", {
        privateDir: tmp,
        reputation: 0,
      });
      expect(result.mode).toBe("private");
    });
  });

  describe("community mode — reputation floor", () => {
    it("throws ReputationFloorError when rep < 100 by default", async () => {
      await expect(
        submitPatchProposal(makeProposal(), makeSig(), "community", {
          registryUrl: "https://registry.example.com",
          signingKey: "fake-key",
          reputation: 50,
        }),
      ).rejects.toBeInstanceOf(ReputationFloorError);
    });

    it("includes the required threshold and actual reputation in the error message", async () => {
      try {
        await submitPatchProposal(makeProposal(), makeSig(), "community", {
          registryUrl: "https://registry.example.com",
          signingKey: "fake-key",
          reputation: 42,
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ReputationFloorError);
        const rf = err as ReputationFloorError;
        expect(rf.message).toContain("100");
        expect(rf.message).toContain("42");
        expect(rf.required).toBe(100);
        expect(rf.actual).toBe(42);
      }
    });

    it("respects a custom community rep floor", async () => {
      await expect(
        submitPatchProposal(makeProposal(), makeSig(), "community", {
          registryUrl: "https://registry.example.com",
          signingKey: "fake-key",
          reputation: 500,
          communityRepFloor: 1000,
        }),
      ).rejects.toBeInstanceOf(ReputationFloorError);
    });

    it("permits community submission when rep >= floor (via stubbed fetch)", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedHeaders: Record<string, string> = {};
      const fakeFetch: typeof fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedBody = (init?.body ?? "") as string;
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(
          JSON.stringify({ patchId: "server-assigned-id", location: "https://reg/v1/patches/server-assigned-id" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const result = await submitPatchProposal(makeProposal(), makeSig(), "community", {
        registryUrl: "https://registry.example.com/",
        signingKey: "sk-fake-key",
        reputation: 500,
        fetch: fakeFetch,
      });

      expect(result.mode).toBe("community");
      expect(result.patchId).toBe("server-assigned-id");
      expect(capturedUrl).toBe("https://registry.example.com/v1/patches/propose");
      expect(capturedHeaders["x-chorus-signing-key"]).toBe("sk-fake-key");
      expect(capturedHeaders["x-chorus-reputation"]).toBe("500");

      const bodyParsed = JSON.parse(capturedBody);
      expect(bodyParsed.integration).toBe("slack-send");
      expect(bodyParsed.proposal.diff).toContain("--- a/src/client.ts");
    });

    it("throws RegistrySubmitError when the registry responds with non-2xx", async () => {
      const fakeFetch: typeof fetch = async () => {
        return new Response("no", { status: 500 });
      };

      await expect(
        submitPatchProposal(makeProposal(), makeSig(), "community", {
          registryUrl: "https://registry.example.com",
          signingKey: "sk-fake-key",
          reputation: 500,
          fetch: fakeFetch,
        }),
      ).rejects.toBeInstanceOf(RegistrySubmitError);
    });

    it("requires registryUrl for community mode", async () => {
      await expect(
        submitPatchProposal(makeProposal(), makeSig(), "community", {
          signingKey: "sk-fake-key",
          reputation: 500,
        }),
      ).rejects.toThrow(/registryUrl/);
    });

    it("requires signingKey for community mode", async () => {
      await expect(
        submitPatchProposal(makeProposal(), makeSig(), "community", {
          registryUrl: "https://registry.example.com",
          reputation: 500,
        }),
      ).rejects.toThrow(/signingKey/);
    });
  });
});
