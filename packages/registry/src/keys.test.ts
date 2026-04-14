import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  base64ToBytes,
  bytesToBase64,
  generateKeypair,
  loadKeypair,
  saveKeypair,
} from "./keys.js";

describe("keypair generation", () => {
  it("returns 32-byte public + private keys (base64-encoded)", async () => {
    const kp = await generateKeypair();
    expect(base64ToBytes(kp.publicKey).length).toBe(32);
    expect(base64ToBytes(kp.privateKey).length).toBe(32);
  });

  it("produces distinct keypairs on each call", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe("keypair save/load round-trip", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chorus-registry-keys-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saves and reloads the same keypair", async () => {
    const kp = await generateKeypair();
    const keyPath = path.join(tmpDir, "signing.json");
    await saveKeypair(keyPath, kp);
    const loaded = await loadKeypair(keyPath);
    expect(loaded).toEqual(kp);
  });

  it("rejects files missing publicKey or privateKey", async () => {
    const keyPath = path.join(tmpDir, "broken.json");
    await fs.writeFile(keyPath, JSON.stringify({ publicKey: "abc" }), "utf8");
    await expect(loadKeypair(keyPath)).rejects.toThrow(/missing/);
  });

  it("rejects keys with wrong byte length", async () => {
    const keyPath = path.join(tmpDir, "wrong-length.json");
    const badShort = bytesToBase64(new Uint8Array(16)); // only 16 bytes
    await fs.writeFile(
      keyPath,
      JSON.stringify({ publicKey: badShort, privateKey: badShort }),
      "utf8",
    );
    await expect(loadKeypair(keyPath)).rejects.toThrow(/32 bytes/);
  });
});
