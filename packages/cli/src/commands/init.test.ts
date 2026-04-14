import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfigFromDir } from "../config.js";
import { AlreadyInitializedError, runInit } from "./init.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-init-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("runInit", () => {
  it("creates the expected files in an empty dir", async () => {
    const result = await runInit({ cwd: tmpDir, silent: true });

    // Config file + workflows dir + keys file
    expect((await stat(result.configPath)).isFile()).toBe(true);
    expect((await stat(result.workflowsDir)).isDirectory()).toBe(true);
    expect((await stat(result.keysPath)).isFile()).toBe(true);

    // chorus/ and .chorus/ exist
    expect((await stat(result.chorusDir)).isDirectory()).toBe(true);
    expect((await stat(result.stateDir)).isDirectory()).toBe(true);

    // Example workflow is written
    const examplePath = path.join(result.workflowsDir, "hello.example.yaml");
    expect((await stat(examplePath)).isFile()).toBe(true);

    // .env.example is written with a generated key
    const envExample = await readFile(path.join(result.chorusDir, ".env.example"), "utf8");
    expect(envExample).toMatch(/CHORUS_ENCRYPTION_KEY=.+/);
  });

  it("generated config is valid per ChorusConfigSchema", async () => {
    await runInit({ cwd: tmpDir, silent: true });
    const loaded = await loadConfigFromDir(path.join(tmpDir, "chorus"));
    // Uses basename of tmpDir as name
    expect(loaded.config.name).toBeTruthy();
    expect(loaded.config.database.path).toBe(".chorus/chorus.db");
    expect(loaded.config.publicKey).toBeTruthy();
  });

  it("writes an Ed25519 keypair to .chorus/keys.json", async () => {
    const result = await runInit({ cwd: tmpDir, silent: true });
    const keysRaw = await readFile(result.keysPath, "utf8");
    const keys = JSON.parse(keysRaw);
    expect(keys.algorithm).toBe("ed25519");
    expect(typeof keys.publicKey).toBe("string");
    expect(typeof keys.privateKey).toBe("string");
    expect(keys.publicKey.length).toBeGreaterThan(20);
    expect(keys.privateKey.length).toBeGreaterThan(20);
  });

  it("fails cleanly when chorus/ already exists and is non-empty", async () => {
    const chorusDir = path.join(tmpDir, "chorus");
    await mkdir(chorusDir, { recursive: true });
    await writeFile(path.join(chorusDir, "config.yaml"), "name: existing\n");
    await expect(runInit({ cwd: tmpDir, silent: true })).rejects.toBeInstanceOf(
      AlreadyInitializedError,
    );
  });

  it("succeeds when chorus/ exists but is empty", async () => {
    await mkdir(path.join(tmpDir, "chorus"), { recursive: true });
    const result = await runInit({ cwd: tmpDir, silent: true });
    expect((await stat(result.configPath)).isFile()).toBe(true);
  });

  it("uses explicit passphrase when provided (base64 of raw)", async () => {
    const result = await runInit({
      cwd: tmpDir,
      silent: true,
      passphrase: "my-secret-32-byte-string-padded!",
    });
    expect(result.generatedEncryptionKey).toBeDefined();
    const decoded = Buffer.from(result.generatedEncryptionKey!, "base64").toString("utf8");
    expect(decoded).toBe("my-secret-32-byte-string-padded!");
  });

  it("skips writing encryption key when passphraseFromEnv is set", async () => {
    const result = await runInit({ cwd: tmpDir, silent: true, passphraseFromEnv: true });
    expect(result.generatedEncryptionKey).toBeUndefined();
    const envExample = await readFile(path.join(result.chorusDir, ".env.example"), "utf8");
    expect(envExample).toMatch(/CHORUS_ENCRYPTION_KEY=\s/);
  });

  it("adds Chorus block to root .gitignore, idempotently", async () => {
    await runInit({ cwd: tmpDir, silent: true });
    const ignoreFirst = await readFile(path.join(tmpDir, ".gitignore"), "utf8");
    expect(ignoreFirst).toMatch(/chorus/);

    // Clean up & re-init with existing .gitignore — must not duplicate block.
    await rm(path.join(tmpDir, "chorus"), { recursive: true });
    await rm(path.join(tmpDir, ".chorus"), { recursive: true });
    await runInit({ cwd: tmpDir, silent: true });
    const ignoreSecond = await readFile(path.join(tmpDir, ".gitignore"), "utf8");
    const occurrences = (ignoreSecond.match(/chorus/g) ?? []).length;
    expect(occurrences).toBe(ignoreFirst.match(/chorus/g)!.length);
  });
});
