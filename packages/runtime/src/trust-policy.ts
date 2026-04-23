/**
 * TrustPolicy validator for worknet (Wave 3 — federated cross-instance composition).
 *
 * Validates the identity + reputation + workflow-pinning constraints declared by
 * a `remote-workflow` integration node BEFORE the runtime sends a workflow
 * invocation to a remote chorus instance. Mirror-image validation also runs on
 * the receiving side (server.ts api/remote-run.ts) before spawning the child
 * run.
 *
 * SECURITY MODEL (per wave-3-brief.md, decision 5):
 *   Trust = identity (Ed25519 public key, optional Sigstore OIDC issuer)
 *         + reputation (read-only lookup against the local registry)
 *         + content hash (sha256 of the workflow definition — pinning prevents
 *           the remote operator from swapping definitions out from under you)
 *
 *   No cryptocurrency. No staking. Same primitives as patch federation.
 *
 * REUSED PRIMITIVES (per brief — do NOT reinvent):
 *   - Ed25519 sign/verify: `@delightfulchorus/registry/sign|verify` (sha512Sync wired)
 *   - Canonical JSON for hash inputs: `@delightfulchorus/registry/manifest`
 *   - Reputation type + score lookup: `@delightfulchorus/registry/reputation`
 *
 * FAIL-CLOSED INVARIANTS:
 *   1. workflowHash is mandatory — pinning is the only way to detect definition
 *      swap. Calls without a workflowHash REJECT with code "MISSING_HASH".
 *   2. minReputation set + getOperatorReputation absent → REJECT (cannot verify
 *      reputation, so we cannot honor the policy). Code "REPUTATION_UNAVAILABLE".
 *   3. allowedSigners set + caller's publicKey not in allowlist → REJECT.
 *   4. requireOidcIssuer set + caller has no oidcIssuer attestation → REJECT.
 *   5. Signature verification failure → REJECT (caller doesn't own the
 *      publicKey it claims).
 *   6. Timestamp outside skew window (default ±5 minutes) → REJECT (replay
 *      defense; combined with caller-chosen nonce, prevents replays).
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@delightfulchorus/registry";
import { verifyPatch } from "@delightfulchorus/registry";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Wire sha512 sync — same trick the registry uses, idempotent install.
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...msgs: Uint8Array[]) => {
    let total = 0;
    for (const p of msgs) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of msgs) {
      out.set(p, off);
      off += p.length;
    }
    return sha512(out);
  };
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Trust policy declared by a remote-workflow node's config. Every field is
 * optional EXCEPT the implicit requirement of `workflowHash` on the parent
 * node config — that's enforced at the integration handler level (validateCall).
 */
export interface TrustPolicy {
  /**
   * Required Sigstore OIDC issuer for the caller's identity. e.g.
   * "github.com/operator-bob". When set, the caller's `oidcIssuer` field
   * must match exactly. (Sigstore attestation verification is out of scope
   * for Wave 3 — the issuer string is a label; future work pairs it with
   * a Rekor lookup.)
   */
  requireOidcIssuer?: string;
  /**
   * Minimum reputation score the operator must have. Validator looks this
   * up via the injected `getOperatorReputation`; absence of the lookup
   * function is fail-closed.
   */
  minReputation?: number;
  /**
   * Maximum allowed end-to-end latency for the remote call. Enforced by the
   * integration handler's polling loop (not by the validator itself); we
   * carry it through the policy object so it travels with the rest of the
   * trust contract.
   */
  maxLatencyMs?: number;
  /**
   * Optional allowlist of base64-encoded Ed25519 public keys. When set, the
   * caller's publicKey MUST appear in this list. When absent, any
   * publicKey is accepted (as long as the signature verifies).
   */
  allowedSigners?: string[];
}

/**
 * Caller identity payload — what the integration handler sends to the
 * remote endpoint, and what the receiving server validates before spawning
 * a child run. Signed over canonical JSON of the call envelope.
 */
export interface CallerIdentity {
  /** base64-encoded Ed25519 signature, 64 bytes raw. */
  signature: string;
  /** base64-encoded Ed25519 public key, 32 bytes raw. */
  publicKey: string;
  /** Optional Sigstore OIDC issuer label (see TrustPolicy.requireOidcIssuer). */
  oidcIssuer?: string;
  /** ms-since-epoch — checked against current time ±skewMs. */
  timestamp: number;
  /**
   * Caller-chosen nonce (any non-empty string). Prevents two distinct calls
   * with the same timestamp from hashing identically; receiver may also
   * track recent nonces for in-window replay defense.
   */
  nonce: string;
}

/**
 * The bytes that get signed. The integration handler computes this on the
 * sending side; the server's verifyCallEnvelope reproduces it before running
 * `verifyPatch`-style verification. Must be deterministic (canonical JSON).
 */
export interface CallEnvelope {
  workflowRef: string;
  /** SHA-256 hex of canonicalJson(workflow definition with `signature` stripped). */
  workflowHash: string;
  input: unknown;
  timestamp: number;
  nonce: string;
}

/**
 * Reputation lookup the validator depends on. The registry package owns the
 * actual ledger; we accept an injected function so the validator package
 * stays free of registry-DB coupling and tests can stub it cleanly.
 *
 * Returns undefined when the operator is unknown — the validator treats
 * unknown-operator the same as below-threshold.
 */
export type ReputationLookup = (operatorPublicKey: string) =>
  | Promise<number | undefined>
  | (number | undefined);

/**
 * Result of validateCall. `kind === "ok"` means the call may proceed; any
 * other kind names the specific reason for rejection so callers (and the
 * audit log) record a clear cause.
 */
export type TrustValidationResult =
  | { kind: "ok" }
  | { kind: "rejected"; code: TrustRejectCode; message: string };

export type TrustRejectCode =
  | "MISSING_HASH"
  | "MISSING_SIGNATURE"
  | "MISSING_PUBLIC_KEY"
  | "MALFORMED_PUBLIC_KEY"
  | "MALFORMED_SIGNATURE"
  | "TIMESTAMP_SKEW"
  | "BAD_SIGNATURE"
  | "OIDC_MISMATCH"
  | "SIGNER_NOT_ALLOWED"
  | "REPUTATION_UNAVAILABLE"
  | "REPUTATION_BELOW_THRESHOLD";

// ── Default tunables ───────────────────────────────────────────────────────

/** Default timestamp-skew window: ±5 minutes (matches OAuth/JWT industry default). */
export const DEFAULT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

// ── Hash helper ────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 content hash of a workflow definition. Mirror of
 * registry/manifest.ts `computeContentHash` shape — canonical JSON with the
 * `signature` field stripped (workflows do not currently carry a signature
 * field, but the strip is forward-compatible if they ever do).
 *
 * Returns the hash as a lowercase hex string with the `sha256:` prefix
 * (matches the brief's `workflowHash: "sha256:abc123..."` format).
 */
export function computeWorkflowHash(workflow: unknown): string {
  let body: unknown = workflow;
  if (workflow && typeof workflow === "object" && !Array.isArray(workflow)) {
    const { signature: _sig, ...rest } = workflow as Record<string, unknown>;
    body = rest;
  }
  const canonical = canonicalJson(body);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Compute the deterministic envelope hash that gets signed. Caller-side
 * (integration handler) and server-side (api/remote-run.ts) MUST produce
 * identical bytes — both go through canonicalJson over the same field set.
 */
export function envelopeBytes(env: CallEnvelope): Uint8Array {
  const canonical = canonicalJson({
    workflowRef: env.workflowRef,
    workflowHash: env.workflowHash,
    input: env.input ?? null,
    timestamp: env.timestamp,
    nonce: env.nonce,
  });
  return new TextEncoder().encode(canonical);
}

// ── Signing helper (caller side) ───────────────────────────────────────────

/**
 * Sign a CallEnvelope with the caller's Ed25519 private key. Returns the
 * base64-encoded 64-byte signature suitable for `CallerIdentity.signature`.
 *
 * Uses sync ed.sign — sha512Sync is wired at module load.
 */
export function signCallEnvelope(
  env: CallEnvelope,
  privateKeyBase64: string,
): string {
  const msg = envelopeBytes(env);
  const priv = base64ToBytes(privateKeyBase64);
  if (priv.length !== 32) {
    throw new Error(
      `signCallEnvelope: private key must decode to 32 bytes, got ${priv.length}`,
    );
  }
  const sig = ed.sign(msg, priv);
  return bytesToBase64(sig);
}

// ── Validator (used by both sides) ────────────────────────────────────────

export interface ValidateCallOpts {
  /** The trust policy declared by the caller's node config. */
  policy: TrustPolicy;
  /** The envelope the caller built (used to recompute the signed bytes). */
  envelope: CallEnvelope;
  /** The caller's identity claim. */
  identity: CallerIdentity;
  /**
   * Reputation lookup. Optional; only consulted when policy.minReputation is set.
   * Absent + policy demands reputation → REJECT (fail-closed).
   */
  getOperatorReputation?: ReputationLookup;
  /** Override the timestamp window. Defaults to DEFAULT_TIMESTAMP_SKEW_MS. */
  timestampSkewMs?: number;
  /** Override "now" for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Validate a remote-workflow call against its trust policy. Pure function
 * (modulo the optional `getOperatorReputation` callback). Returns either
 * {kind:"ok"} or {kind:"rejected", code, message}.
 *
 * Order of checks is intentional: cheap structural checks first, signature
 * verification (the most expensive curve op) last so a malformed call is
 * rejected without burning a verify cycle.
 */
export async function validateCall(
  opts: ValidateCallOpts,
): Promise<TrustValidationResult> {
  const { policy, envelope, identity } = opts;
  const skew = opts.timestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS;
  const now = opts.now ? opts.now() : Date.now();

  // 1. Hash pinning is mandatory. The integration handler is supposed to
  //    enforce this at config-resolution time; we double-check here so the
  //    server-side validator catches any handler that forgets.
  if (!envelope.workflowHash || envelope.workflowHash.length === 0) {
    return rej("MISSING_HASH", "trust policy: workflowHash is required (pinning is mandatory)");
  }

  // 2. Structural sanity on identity claims.
  if (!identity.publicKey || identity.publicKey.length === 0) {
    return rej("MISSING_PUBLIC_KEY", "trust policy: callerIdentity.publicKey is required");
  }
  if (!identity.signature || identity.signature.length === 0) {
    return rej("MISSING_SIGNATURE", "trust policy: callerIdentity.signature is required");
  }
  let pubBytes: Uint8Array;
  try {
    pubBytes = base64ToBytes(identity.publicKey);
  } catch (err) {
    return rej(
      "MALFORMED_PUBLIC_KEY",
      `trust policy: callerIdentity.publicKey is not valid base64: ${(err as Error).message}`,
    );
  }
  if (pubBytes.length !== 32) {
    return rej(
      "MALFORMED_PUBLIC_KEY",
      `trust policy: callerIdentity.publicKey must decode to 32 bytes, got ${pubBytes.length}`,
    );
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(identity.signature);
  } catch (err) {
    return rej(
      "MALFORMED_SIGNATURE",
      `trust policy: callerIdentity.signature is not valid base64: ${(err as Error).message}`,
    );
  }
  if (sigBytes.length !== 64) {
    return rej(
      "MALFORMED_SIGNATURE",
      `trust policy: callerIdentity.signature must decode to 64 bytes, got ${sigBytes.length}`,
    );
  }

  // 3. Timestamp skew. Replay defense — combined with caller-chosen nonce
  //    inside the envelope, prevents in-window replay if the receiver also
  //    tracks recent nonces (out of scope for the validator itself).
  if (typeof identity.timestamp !== "number" || !Number.isFinite(identity.timestamp)) {
    return rej("TIMESTAMP_SKEW", "trust policy: callerIdentity.timestamp must be a finite number");
  }
  const drift = Math.abs(now - identity.timestamp);
  if (drift > skew) {
    return rej(
      "TIMESTAMP_SKEW",
      `trust policy: timestamp ${identity.timestamp} is ${drift}ms from server time ${now} (max skew ${skew}ms)`,
    );
  }

  // 4. Envelope-vs-identity timestamp consistency. A caller could otherwise
  //    sign one envelope and present a fresher identity claim around it.
  if (envelope.timestamp !== identity.timestamp) {
    return rej(
      "TIMESTAMP_SKEW",
      `trust policy: envelope.timestamp (${envelope.timestamp}) does not match callerIdentity.timestamp (${identity.timestamp})`,
    );
  }

  // 5. OIDC issuer match (if policy demands it). Sigstore attestation
  //    verification (Rekor lookup, transparency log proof) is out of scope;
  //    the issuer string is a label.
  if (policy.requireOidcIssuer !== undefined && policy.requireOidcIssuer.length > 0) {
    if (identity.oidcIssuer !== policy.requireOidcIssuer) {
      return rej(
        "OIDC_MISMATCH",
        `trust policy: required oidcIssuer "${policy.requireOidcIssuer}", got "${identity.oidcIssuer ?? "<none>"}"`,
      );
    }
  }

  // 6. Allowlist check (if policy specifies one). Self-attested publicKey
  //    is fine here; the signature verification below proves possession.
  if (policy.allowedSigners && policy.allowedSigners.length > 0) {
    if (!policy.allowedSigners.includes(identity.publicKey)) {
      return rej(
        "SIGNER_NOT_ALLOWED",
        `trust policy: caller publicKey is not in the allowedSigners list (${policy.allowedSigners.length} entries)`,
      );
    }
  }

  // 7. Reputation gate (if policy demands a floor).
  if (policy.minReputation !== undefined) {
    if (!opts.getOperatorReputation) {
      return rej(
        "REPUTATION_UNAVAILABLE",
        "trust policy: minReputation requires a getOperatorReputation lookup (not provided)",
      );
    }
    let rep: number | undefined;
    try {
      const result = opts.getOperatorReputation(identity.publicKey);
      rep = result instanceof Promise ? await result : result;
    } catch (err) {
      return rej(
        "REPUTATION_UNAVAILABLE",
        `trust policy: getOperatorReputation threw: ${(err as Error).message}`,
      );
    }
    if (rep === undefined || rep === null) {
      return rej(
        "REPUTATION_UNAVAILABLE",
        `trust policy: operator ${identity.publicKey.slice(0, 12)}… has no reputation record`,
      );
    }
    if (rep < policy.minReputation) {
      return rej(
        "REPUTATION_BELOW_THRESHOLD",
        `trust policy: operator reputation ${rep} < required ${policy.minReputation}`,
      );
    }
  }

  // 8. Signature verification — the only expensive op. We reuse the same
  //    @noble/ed25519 verify path the registry uses for patch signatures.
  const expectedBytes = envelopeBytes(envelope);
  let sigOk = false;
  try {
    sigOk = ed.verify(sigBytes, expectedBytes, pubBytes);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return rej(
      "BAD_SIGNATURE",
      "trust policy: signature does not verify against caller-claimed publicKey + envelope",
    );
  }

  return { kind: "ok" };
}

/**
 * Variant of validateCall that uses the registry's existing verifyPatch
 * shape (list of trusted keys; ANY-match passes). Useful when the
 * validator wants to honor a registry-level keyset rather than (or in
 * addition to) the policy's allowedSigners list.
 *
 * Currently unused by the integration but exposed for future symmetry
 * with patch verification flows.
 */
export function verifyEnvelopeAgainstKeys(
  envelope: CallEnvelope,
  signatureBase64: string,
  trustedPublicKeys: string[],
): boolean {
  // Build a Patch-shaped object verifyPatch can verify. We can't, because
  // patchSigningPayload is patch-specific. Fall through to a direct loop.
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signatureBase64);
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;
  const msg = envelopeBytes(envelope);
  let ok = false;
  for (const keyB64 of trustedPublicKeys) {
    let keyBytes: Uint8Array;
    try {
      keyBytes = base64ToBytes(keyB64);
    } catch {
      continue;
    }
    if (keyBytes.length !== 32) continue;
    try {
      if (ed.verify(sigBytes, msg, keyBytes)) ok = true;
    } catch {
      // ignore — bad input → not-verified
    }
  }
  // Suppress unused-import lint: verifyPatch is the conceptual source of
  // this routine; we keep the import so the relationship is grep-able.
  void verifyPatch;
  return ok;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rej(code: TrustRejectCode, message: string): TrustValidationResult {
  return { kind: "rejected", code, message };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
