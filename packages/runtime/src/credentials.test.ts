import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  CredentialDecryptError,
  CredentialKeyError,
  ENCRYPTION_KEY_ENV,
  decodeKey,
  decryptCredential,
  encryptCredential,
  generateKey,
  loadKeyFromEnv,
  rotateKey,
} from "./credentials.js";

describe("credentials — key loading", () => {
  it("generateKey returns a valid 32-byte base64 key", () => {
    const k = generateKey();
    const decoded = decodeKey(k);
    expect(decoded.length).toBe(32);
  });

  it("throws a clear error when env var is missing", () => {
    expect(() => loadKeyFromEnv({})).toThrow(CredentialKeyError);
    expect(() => loadKeyFromEnv({})).toThrow(new RegExp(ENCRYPTION_KEY_ENV));
  });

  it("throws when env var is not 32 bytes", () => {
    const tooShort = Buffer.alloc(16).toString("base64");
    expect(() => loadKeyFromEnv({ [ENCRYPTION_KEY_ENV]: tooShort })).toThrow(/32 bytes/);
  });

  it("loads a valid key from env", () => {
    const k = generateKey();
    const buf = loadKeyFromEnv({ [ENCRYPTION_KEY_ENV]: k });
    expect(buf.length).toBe(32);
  });
});

describe("credentials — encrypt/decrypt", () => {
  it("round-trips a UTF-8 plaintext", () => {
    const key = randomBytes(32);
    const plain = "super-secret-oauth-token-☯️";
    const blob = encryptCredential(plain, key);
    const out = decryptCredential(blob, key);
    expect(out).toBe(plain);
  });

  it("produces different ciphertexts each time (unique IV)", () => {
    const key = randomBytes(32);
    const b1 = encryptCredential("same", key);
    const b2 = encryptCredential("same", key);
    expect(b1.equals(b2)).toBe(false);
    expect(decryptCredential(b1, key)).toBe("same");
    expect(decryptCredential(b2, key)).toBe("same");
  });

  it("fails to decrypt with the wrong key", () => {
    const key = randomBytes(32);
    const wrong = randomBytes(32);
    const blob = encryptCredential("secret", key);
    expect(() => decryptCredential(blob, wrong)).toThrow(CredentialDecryptError);
  });

  it("fails to decrypt tampered ciphertext", () => {
    const key = randomBytes(32);
    const blob = encryptCredential("secret", key);
    // Flip the last byte of the ciphertext
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => decryptCredential(blob, key)).toThrow(CredentialDecryptError);
  });

  it("fails cleanly on truncated blob", () => {
    const key = randomBytes(32);
    const blob = Buffer.from([0, 1, 2]);
    expect(() => decryptCredential(blob, key)).toThrow(/too short/);
  });

  it("rejects keys that are not 32 bytes", () => {
    const bad = randomBytes(16);
    expect(() => encryptCredential("hi", bad)).toThrow(CredentialKeyError);
    expect(() => decryptCredential(Buffer.alloc(40), bad)).toThrow(CredentialKeyError);
  });
});

describe("credentials — key rotation", () => {
  it("rotates to a new key — old blob no longer decrypts with new key", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const plain = "my-api-token";
    const oldBlob = encryptCredential(plain, oldKey);
    const newBlob = rotateKey(oldBlob, oldKey, newKey);
    expect(decryptCredential(newBlob, newKey)).toBe(plain);
    expect(() => decryptCredential(newBlob, oldKey)).toThrow(CredentialDecryptError);
    expect(() => decryptCredential(oldBlob, newKey)).toThrow(CredentialDecryptError);
  });

  it("propagates a decrypt error cleanly if old key is wrong", () => {
    const realOld = randomBytes(32);
    const wrongOld = randomBytes(32);
    const newKey = randomBytes(32);
    const blob = encryptCredential("x", realOld);
    expect(() => rotateKey(blob, wrongOld, newKey)).toThrow(CredentialDecryptError);
  });
});
