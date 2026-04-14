import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Credential encryption per docs/ARCHITECTURE.md §4.6.
 *
 * AES-256-GCM. Key sourced from env var `CHORUS_ENCRYPTION_KEY`, base64, 32 bytes.
 * On-disk layout: `IV (12B) || AUTH_TAG (16B) || CIPHERTEXT (N bytes)`.
 *
 * The runtime fails-fast at boot if the key env var is missing or invalid; if a
 * caller explicitly passes a key it is validated per-call.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export const ENCRYPTION_KEY_ENV = "CHORUS_ENCRYPTION_KEY";

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

/**
 * Load the encryption key from env, validating shape. Throws a clear error if
 * the env var is missing, unparseable, or not 32 bytes.
 */
export function loadKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new CredentialKeyError(
      `${ENCRYPTION_KEY_ENV} not set. Runtime cannot start without an encryption key. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return decodeKey(raw);
}

/**
 * Decode a base64 (or base64url) string to a 32-byte key Buffer.
 */
export function decodeKey(encoded: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(encoded, "base64");
  } catch (err) {
    throw new CredentialKeyError(
      `Failed to base64-decode ${ENCRYPTION_KEY_ENV}: ${(err as Error).message}`,
    );
  }
  if (buf.length !== KEY_LEN) {
    throw new CredentialKeyError(
      `${ENCRYPTION_KEY_ENV} must decode to ${KEY_LEN} bytes, got ${buf.length}. ` +
        `Ensure the value is exactly 32 bytes of base64-encoded key material.`,
    );
  }
  return buf;
}

/**
 * Generate a fresh 32-byte key and return its base64 encoding. Intended for
 * CLI bootstrap (`chorus keygen`), not for use inside the runtime itself.
 */
export function generateKey(): string {
  return randomBytes(KEY_LEN).toString("base64");
}

/**
 * Encrypt a plaintext credential. Returns opaque bytes suitable for storage.
 */
export function encryptCredential(plaintext: string, key: Buffer): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/**
 * Decrypt an opaque credential blob back to its UTF-8 plaintext.
 * Throws `CredentialDecryptError` on tampering or bad key.
 */
export function decryptCredential(blob: Buffer, key: Buffer): string {
  assertKey(key);
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new CredentialDecryptError("Credential blob too short to be valid");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new CredentialDecryptError(
      `Decryption failed (bad key or tampered ciphertext): ${(err as Error).message}`,
    );
  }
}

/**
 * Re-encrypt a blob under a new key. Used when rotating the runtime key.
 * Caller is responsible for persisting the new blob atomically with the new key.
 */
export function rotateKey(blob: Buffer, oldKey: Buffer, newKey: Buffer): Buffer {
  const plaintext = decryptCredential(blob, oldKey);
  return encryptCredential(plaintext, newKey);
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new CredentialKeyError(
      `Encryption key must be a ${KEY_LEN}-byte Buffer (got ${
        Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key
      })`,
    );
  }
}
