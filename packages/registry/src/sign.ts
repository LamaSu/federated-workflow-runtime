/**
 * Ed25519 patch signing.
 *
 * @noble/ed25519 v2 ships only async hashing by default. We wire the sync sha512 from
 * @noble/hashes into `ed.etc.sha512Sync` once at import time so the sync `sign()` / `verify()`
 * paths work — they're simpler to reason about in tests and don't need to thread a Promise
 * through verifyPatch().
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import type { Patch } from "@delightfulchorus/core";
import { canonicalJson } from "./manifest.js";
import { base64ToBytes, bytesToBase64 } from "./keys.js";

// Wire sha512 sync implementation for @noble/ed25519 (otherwise sign/verify async-only).
// Guard against double-install in case multiple modules import sign.ts.
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...msgs: Uint8Array[]) => sha512(concat(msgs));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * The exact bytes that get signed. Signature field itself is excluded (chicken-and-egg).
 * Algorithm is fixed to the default so that Patch objects with an empty `signature` field
 * still produce a stable signing input.
 */
export function patchSigningPayload(patch: Patch): Uint8Array {
  const { signature: _sig, ...body } = patch;
  const canonical = canonicalJson(body);
  return new TextEncoder().encode(canonical);
}

/**
 * Sign a patch in-place (returns a new object, input not mutated).
 * Fills the `signature` field with a base64-encoded 64-byte Ed25519 signature.
 */
export function signPatch(patch: Patch, privateKeyBase64: string): Patch {
  const msg = patchSigningPayload(patch);
  const priv = base64ToBytes(privateKeyBase64);
  const sigBytes = ed.sign(msg, priv);
  return {
    ...patch,
    signature: bytesToBase64(sigBytes),
    signatureAlgorithm: "ed25519",
  };
}
