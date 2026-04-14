/**
 * Ed25519 keypair management (base64-encoded, JSON-on-disk).
 *
 * Rationale for base64 (not hex): the fallback keys in ARCHITECTURE.md §5.3 are expected
 * to travel through manifest JSON; base64 is ~33% shorter than hex and every JSON parser
 * handles it verbatim. We document the encoding here so verifiers don't guess.
 */

import { promises as fs } from "node:fs";
import { getPublicKeyAsync, utils } from "@noble/ed25519";

export interface Keypair {
  /** base64-encoded 32-byte Ed25519 public key */
  publicKey: string;
  /** base64-encoded 32-byte Ed25519 private seed (NOT the expanded scalar) */
  privateKey: string;
}

/** Generate a fresh Ed25519 keypair. */
export async function generateKeypair(): Promise<Keypair> {
  const privRaw = utils.randomPrivateKey(); // 32 bytes
  const pubRaw = await getPublicKeyAsync(privRaw);
  return {
    publicKey: bytesToBase64(pubRaw),
    privateKey: bytesToBase64(privRaw),
  };
}

/** Load a keypair from a JSON file written by {@link saveKeypair}. */
export async function loadKeypair(path: string): Promise<Keypair> {
  const raw = await fs.readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<Keypair>;
  if (typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string") {
    throw new Error(`keypair at ${path} is missing publicKey or privateKey`);
  }
  // Sanity-check lengths so we fail loudly, not at verify-time.
  const pubBytes = base64ToBytes(parsed.publicKey);
  const privBytes = base64ToBytes(parsed.privateKey);
  if (pubBytes.length !== 32) throw new Error(`publicKey must decode to 32 bytes, got ${pubBytes.length}`);
  if (privBytes.length !== 32) throw new Error(`privateKey must decode to 32 bytes, got ${privBytes.length}`);
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

/** Persist a keypair to disk as JSON. Permissions are not chmod'd here — caller's choice. */
export async function saveKeypair(path: string, keypair: Keypair): Promise<void> {
  const payload = JSON.stringify(keypair, null, 2);
  await fs.writeFile(path, payload, "utf8");
}

// ── base64 helpers (Node 20 has globalThis.Buffer; we use Uint8Array surface) ────────

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
