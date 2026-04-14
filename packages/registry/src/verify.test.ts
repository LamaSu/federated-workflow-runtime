import { describe, it, expect } from "vitest";
import type { Patch } from "@chorus/core";
import { generateKeypair } from "./keys.js";
import { signPatch } from "./sign.js";
import { verifyPatch } from "./verify.js";

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

describe("verifyPatch", () => {
  it("accepts a legit sign→verify round-trip", async () => {
    const kp = await generateKeypair();
    const signed = signPatch(mkPatch(), kp.privateKey);
    expect(verifyPatch(signed, [kp.publicKey])).toBe(true);
  });

  it("rejects a patch whose body was tampered post-signing", async () => {
    const kp = await generateKeypair();
    const signed = signPatch(mkPatch(), kp.privateKey);
    const tampered: Patch = { ...signed, diff: "malicious diff" };
    expect(verifyPatch(tampered, [kp.publicKey])).toBe(false);
  });

  it("rejects a patch signed by an untrusted key", async () => {
    const attacker = await generateKeypair();
    const goodGuy = await generateKeypair();
    const signed = signPatch(mkPatch(), attacker.privateKey);
    expect(verifyPatch(signed, [goodGuy.publicKey])).toBe(false);
  });

  it("supports multi-sig (trusted list): any matching key passes", async () => {
    const signer = await generateKeypair();
    const otherKey = await generateKeypair();
    const signed = signPatch(mkPatch(), signer.privateKey);
    expect(verifyPatch(signed, [otherKey.publicKey, signer.publicKey])).toBe(true);
  });

  it("rejects a patch with empty signature", () => {
    const p = mkPatch(); // signature is ""
    expect(verifyPatch(p, ["anything"])).toBe(false);
  });

  it("rejects a patch with a wrong-length signature", async () => {
    const kp = await generateKeypair();
    const p: Patch = { ...mkPatch(), signature: Buffer.from("too-short").toString("base64") };
    expect(verifyPatch(p, [kp.publicKey])).toBe(false);
  });

  it("handles malformed trusted key entries without crashing", async () => {
    const kp = await generateKeypair();
    const signed = signPatch(mkPatch(), kp.privateKey);
    expect(verifyPatch(signed, ["not-base64!@#$", "", kp.publicKey])).toBe(true);
  });
});
