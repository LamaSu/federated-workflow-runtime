/**
 * Ed25519 patch verification.
 *
 * Multi-sig note (ARCHITECTURE.md §5.3, §5.5): a patch may be co-signed by a maintainer
 * AND a canary-verifier. For MVP the on-disk schema has a single `signature` field, so
 * `verifyPatch` takes a list of trusted public keys — verification passes if ANY of them
 * successfully verifies. Multi-sig with distinct signatures is a v1.1 wire change.
 */

import * as ed from "@noble/ed25519";
import type { Patch } from "@chorus/core";
import { base64ToBytes } from "./keys.js";
import { patchSigningPayload } from "./sign.js";

/**
 * Verify a patch's signature against a list of trusted public keys.
 *
 * - Returns true iff at least one trusted key validates the signature.
 * - Tampered body (any byte diff vs. signing input) = false.
 * - Empty or absent signature = false (not an exception — makes ingest resilient).
 * - Length check is constant-time (same work regardless of key match order).
 */
export function verifyPatch(patch: Patch, trustedPublicKeys: string[]): boolean {
  if (!patch.signature) return false;

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(patch.signature);
  } catch {
    return false;
  }
  // Ed25519 signatures are always 64 bytes — reject malformed sig lengths before curve work.
  if (sigBytes.length !== 64) return false;

  const msg = patchSigningPayload(patch);

  // Iterate through all keys — don't short-circuit on first match when you want the attacker
  // not to learn anything from timing. We still return a boolean from the first PASS because
  // the attacker controls the signature, not the key order.
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
      // verify throws on malformed input; treat as failed verification, not crash.
    }
  }
  return ok;
}
