/**
 * Tests for trust-policy.ts — the validator at the heart of worknet's
 * security model. Coverage goals (per wave-3-brief security checklist):
 *
 *   1. Mandatory hash pinning — missing → REJECT
 *   2. Signature verification — wrong key, wrong sig, tampered envelope → REJECT
 *   3. Timestamp skew — outside window → REJECT
 *   4. Envelope/identity timestamp consistency — mismatch → REJECT
 *   5. allowedSigners allowlist — not-in-list → REJECT
 *   6. requireOidcIssuer — mismatch / missing → REJECT
 *   7. minReputation — no lookup, unknown operator, below floor → REJECT
 *   8. Happy path — all guards green → OK
 *   9. computeWorkflowHash — deterministic, ignores `signature` field
 *  10. envelopeBytes — produces deterministic canonical JSON across field orders
 */

import { describe, expect, it } from "vitest";
import { generateKeypair } from "@delightfulchorus/registry";
import {
  computeWorkflowHash,
  DEFAULT_TIMESTAMP_SKEW_MS,
  envelopeBytes,
  signCallEnvelope,
  validateCall,
  verifyEnvelopeAgainstKeys,
  type CallEnvelope,
  type CallerIdentity,
  type TrustPolicy,
} from "./trust-policy.js";

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeIdentity(opts?: {
  oidcIssuer?: string;
  timestamp?: number;
  nonce?: string;
}): Promise<{
  identity: CallerIdentity;
  envelope: CallEnvelope;
  privateKey: string;
}> {
  const kp = await generateKeypair();
  const timestamp = opts?.timestamp ?? Date.now();
  const nonce = opts?.nonce ?? "nonce-1";
  const envelope: CallEnvelope = {
    workflowRef: "transcribe@v3",
    workflowHash: "sha256:abc",
    input: { audioUrl: "x" },
    timestamp,
    nonce,
  };
  const sig = signCallEnvelope(envelope, kp.privateKey);
  const identity: CallerIdentity = {
    signature: sig,
    publicKey: kp.publicKey,
    timestamp,
    nonce,
    ...(opts?.oidcIssuer ? { oidcIssuer: opts.oidcIssuer } : {}),
  };
  return { identity, envelope, privateKey: kp.privateKey };
}

// ── computeWorkflowHash ────────────────────────────────────────────────────

describe("computeWorkflowHash", () => {
  it("returns sha256:<hex> for a workflow definition", () => {
    const wf = { id: "w1", name: "Workflow 1", nodes: [], connections: [] };
    const h = computeWorkflowHash(wf);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic across key reordering", () => {
    const a = computeWorkflowHash({ id: "x", name: "Y", nodes: [] });
    const b = computeWorkflowHash({ name: "Y", nodes: [], id: "x" });
    expect(a).toBe(b);
  });

  it("ignores a top-level `signature` field", () => {
    const a = computeWorkflowHash({ id: "x", name: "Y", nodes: [] });
    const b = computeWorkflowHash({
      id: "x",
      name: "Y",
      nodes: [],
      signature: "deadbeef",
    });
    expect(a).toBe(b);
  });

  it("changes when the body changes", () => {
    const a = computeWorkflowHash({ id: "x", name: "Y", nodes: [] });
    const b = computeWorkflowHash({ id: "x", name: "Y", nodes: [{ id: "n1" }] });
    expect(a).not.toBe(b);
  });
});

// ── envelopeBytes ──────────────────────────────────────────────────────────

describe("envelopeBytes", () => {
  it("produces deterministic bytes regardless of field order", () => {
    const env1: CallEnvelope = {
      workflowRef: "w",
      workflowHash: "h",
      input: { a: 1, b: 2 },
      timestamp: 1000,
      nonce: "n1",
    };
    const env2: CallEnvelope = {
      // Re-orderable on the wire — internal canonicalization should yield
      // identical bytes.
      input: { b: 2, a: 1 },
      timestamp: 1000,
      workflowRef: "w",
      nonce: "n1",
      workflowHash: "h",
    };
    expect(envelopeBytes(env1)).toEqual(envelopeBytes(env2));
  });

  it("differentiates envelopes that differ in input", () => {
    const env1: CallEnvelope = {
      workflowRef: "w",
      workflowHash: "h",
      input: { a: 1 },
      timestamp: 1000,
      nonce: "n",
    };
    const env2: CallEnvelope = { ...env1, input: { a: 2 } };
    expect(envelopeBytes(env1)).not.toEqual(envelopeBytes(env2));
  });

  it("treats undefined input as null (canonical)", () => {
    const env: CallEnvelope = {
      workflowRef: "w",
      workflowHash: "h",
      input: undefined,
      timestamp: 1000,
      nonce: "n",
    };
    const bytes = envelopeBytes(env);
    expect(new TextDecoder().decode(bytes)).toContain('"input":null');
  });
});

// ── signCallEnvelope + happy path ─────────────────────────────────────────

describe("validateCall — happy path", () => {
  it("accepts a well-formed signed call with no policy", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity,
    });
    expect(r.kind).toBe("ok");
  });

  it("accepts when allowedSigners contains the caller's pubkey", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { allowedSigners: [identity.publicKey, "another-key-base64"] },
      envelope,
      identity,
    });
    expect(r.kind).toBe("ok");
  });

  it("accepts when reputation meets the floor", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 100 },
      envelope,
      identity,
      getOperatorReputation: () => 1000,
    });
    expect(r.kind).toBe("ok");
  });

  it("accepts when oidc issuer matches", async () => {
    const { identity, envelope } = await makeIdentity({
      oidcIssuer: "github.com/operator-bob",
    });
    const r = await validateCall({
      policy: { requireOidcIssuer: "github.com/operator-bob" },
      envelope,
      identity,
    });
    expect(r.kind).toBe("ok");
  });

  it("supports async getOperatorReputation", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 50 },
      envelope,
      identity,
      getOperatorReputation: async () => 500,
    });
    expect(r.kind).toBe("ok");
  });
});

// ── Mandatory pinning ──────────────────────────────────────────────────────

describe("validateCall — mandatory hash pinning", () => {
  it("rejects empty workflowHash", async () => {
    const { identity, envelope } = await makeIdentity();
    const env2 = { ...envelope, workflowHash: "" };
    const r = await validateCall({ policy: {}, envelope: env2, identity });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("MISSING_HASH");
    }
  });
});

// ── Signature verification ────────────────────────────────────────────────

describe("validateCall — signature verification", () => {
  it("rejects tampered envelope (input changed after signing)", async () => {
    const { identity, envelope } = await makeIdentity();
    const tampered = { ...envelope, input: { audioUrl: "different" } };
    const r = await validateCall({
      policy: {},
      envelope: tampered,
      identity,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("BAD_SIGNATURE");
    }
  });

  it("rejects when caller swaps in a different publicKey", async () => {
    const { identity, envelope } = await makeIdentity();
    const otherKp = await generateKeypair();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, publicKey: otherKp.publicKey },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("BAD_SIGNATURE");
    }
  });

  it("rejects malformed publicKey", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, publicKey: "not-base64-padding-broken-!@#$" },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      // base64 lib happily decodes non-base64 to bytes; either path is a reject.
      expect(["MALFORMED_PUBLIC_KEY", "BAD_SIGNATURE"]).toContain(r.code);
    }
  });

  it("rejects publicKey with wrong byte length", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, publicKey: Buffer.alloc(8).toString("base64") },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("MALFORMED_PUBLIC_KEY");
    }
  });

  it("rejects signature with wrong byte length", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, signature: Buffer.alloc(32).toString("base64") },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("MALFORMED_SIGNATURE");
    }
  });

  it("rejects missing signature", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, signature: "" },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("MISSING_SIGNATURE");
    }
  });

  it("rejects missing publicKey", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, publicKey: "" },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("MISSING_PUBLIC_KEY");
    }
  });
});

// ── Timestamp guards ──────────────────────────────────────────────────────

describe("validateCall — timestamp guards", () => {
  it("rejects timestamp outside skew window", async () => {
    const old = Date.now() - 1000 * 60 * 60; // 1h ago
    const { identity, envelope } = await makeIdentity({ timestamp: old });
    const r = await validateCall({
      policy: {},
      envelope,
      identity,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("TIMESTAMP_SKEW");
    }
  });

  it("respects custom skew window", async () => {
    const old = Date.now() - 1000 * 60 * 60;
    const { identity, envelope } = await makeIdentity({ timestamp: old });
    const r = await validateCall({
      policy: {},
      envelope,
      identity,
      timestampSkewMs: 1000 * 60 * 60 * 24, // 24h
    });
    expect(r.kind).toBe("ok");
  });

  it("rejects when envelope and identity timestamps disagree", async () => {
    const { identity, envelope } = await makeIdentity({ timestamp: 1_000_000 });
    const r = await validateCall({
      policy: {},
      envelope: { ...envelope, timestamp: 2_000_000 },
      identity,
      now: () => 1_000_000,
      timestampSkewMs: DEFAULT_TIMESTAMP_SKEW_MS,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("TIMESTAMP_SKEW");
    }
  });

  it("rejects non-finite timestamps", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: {},
      envelope,
      identity: { ...identity, timestamp: Number.NaN },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("TIMESTAMP_SKEW");
    }
  });
});

// ── allowedSigners ────────────────────────────────────────────────────────

describe("validateCall — allowedSigners", () => {
  it("rejects when caller's pubkey is not in allowlist", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { allowedSigners: ["some-other-key", "another-one"] },
      envelope,
      identity,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("SIGNER_NOT_ALLOWED");
    }
  });

  it("ignores empty allowlist (treated as no restriction)", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { allowedSigners: [] },
      envelope,
      identity,
    });
    expect(r.kind).toBe("ok");
  });
});

// ── OIDC issuer ───────────────────────────────────────────────────────────

describe("validateCall — requireOidcIssuer", () => {
  it("rejects when issuer label missing from identity", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { requireOidcIssuer: "github.com/bob" },
      envelope,
      identity,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("OIDC_MISMATCH");
    }
  });

  it("rejects on issuer mismatch", async () => {
    const { identity, envelope } = await makeIdentity({
      oidcIssuer: "github.com/alice",
    });
    const r = await validateCall({
      policy: { requireOidcIssuer: "github.com/bob" },
      envelope,
      identity,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("OIDC_MISMATCH");
    }
  });

  it("ignores empty issuer requirement", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { requireOidcIssuer: "" },
      envelope,
      identity,
    });
    expect(r.kind).toBe("ok");
  });
});

// ── Reputation ────────────────────────────────────────────────────────────

describe("validateCall — reputation", () => {
  it("rejects fail-closed when minReputation set but lookup absent", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 100 },
      envelope,
      identity,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("REPUTATION_UNAVAILABLE");
    }
  });

  it("rejects when operator unknown to lookup", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 100 },
      envelope,
      identity,
      getOperatorReputation: () => undefined,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("REPUTATION_UNAVAILABLE");
    }
  });

  it("rejects when lookup throws", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 100 },
      envelope,
      identity,
      getOperatorReputation: () => {
        throw new Error("ledger db down");
      },
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("REPUTATION_UNAVAILABLE");
      expect(r.message).toContain("ledger db down");
    }
  });

  it("rejects when below floor", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 1000 },
      envelope,
      identity,
      getOperatorReputation: () => 50,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.code).toBe("REPUTATION_BELOW_THRESHOLD");
    }
  });

  it("accepts at exactly the floor", async () => {
    const { identity, envelope } = await makeIdentity();
    const r = await validateCall({
      policy: { minReputation: 100 },
      envelope,
      identity,
      getOperatorReputation: () => 100,
    });
    expect(r.kind).toBe("ok");
  });
});

// ── verifyEnvelopeAgainstKeys ──────────────────────────────────────────────

describe("verifyEnvelopeAgainstKeys", () => {
  it("returns true when one of trusted keys matches", async () => {
    const kp = await generateKeypair();
    const env: CallEnvelope = {
      workflowRef: "w",
      workflowHash: "h",
      input: null,
      timestamp: 1000,
      nonce: "n",
    };
    const sig = signCallEnvelope(env, kp.privateKey);
    const ok = verifyEnvelopeAgainstKeys(env, sig, ["unrelated", kp.publicKey]);
    expect(ok).toBe(true);
  });

  it("returns false when no key matches", async () => {
    const kp = await generateKeypair();
    const otherKp = await generateKeypair();
    const env: CallEnvelope = {
      workflowRef: "w",
      workflowHash: "h",
      input: null,
      timestamp: 1000,
      nonce: "n",
    };
    const sig = signCallEnvelope(env, kp.privateKey);
    const ok = verifyEnvelopeAgainstKeys(env, sig, [otherKp.publicKey]);
    expect(ok).toBe(false);
  });

  it("returns false on malformed signature", async () => {
    const kp = await generateKeypair();
    const env: CallEnvelope = {
      workflowRef: "w",
      workflowHash: "h",
      input: null,
      timestamp: 1000,
      nonce: "n",
    };
    const ok = verifyEnvelopeAgainstKeys(env, "not-a-sig", [kp.publicKey]);
    expect(ok).toBe(false);
  });
});
