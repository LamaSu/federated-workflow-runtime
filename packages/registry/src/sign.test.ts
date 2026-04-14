import { describe, it, expect } from "vitest";
import type { Patch } from "@chorus/core";
import { generateKeypair } from "./keys.js";
import { signPatch } from "./sign.js";

function mkPatch(): Patch {
  return {
    metadata: {
      id: "p-test",
      integration: "slack-send",
      errorSignatureHash: "sig-abc",
      description: "test patch",
      author: { id: "a", publicKey: "pk", reputation: 0 },
      beforeVersion: "1.0.0",
      afterVersion: "1.0.1",
      testsAdded: [],
      canaryStage: "proposed",
      createdAt: "2026-04-13T00:00:00Z",
      advancedAt: {},
    },
    diff: "the diff text",
    snapshotUpdates: [],
    signature: "",
    signatureAlgorithm: "ed25519",
  };
}

describe("signPatch", () => {
  it("fills the signature field with a base64-encoded 64-byte Ed25519 signature", async () => {
    const kp = await generateKeypair();
    const signed = signPatch(mkPatch(), kp.privateKey);
    expect(signed.signature.length).toBeGreaterThan(0);
    // 64 bytes Ed25519 sig = ~88 base64 chars
    expect(Buffer.from(signed.signature, "base64").length).toBe(64);
  });

  it("does not mutate the input patch", async () => {
    const kp = await generateKeypair();
    const before = mkPatch();
    const beforeSnapshot = JSON.stringify(before);
    signPatch(before, kp.privateKey);
    expect(JSON.stringify(before)).toBe(beforeSnapshot);
  });

  it("produces the same signature for the same patch + key", async () => {
    const kp = await generateKeypair();
    const p = mkPatch();
    const s1 = signPatch(p, kp.privateKey).signature;
    const s2 = signPatch(p, kp.privateKey).signature;
    expect(s1).toBe(s2);
  });

  it("produces different signatures for different diffs", async () => {
    const kp = await generateKeypair();
    const s1 = signPatch(mkPatch(), kp.privateKey).signature;
    const altered = { ...mkPatch(), diff: "altered" };
    const s2 = signPatch(altered, kp.privateKey).signature;
    expect(s1).not.toBe(s2);
  });
});
