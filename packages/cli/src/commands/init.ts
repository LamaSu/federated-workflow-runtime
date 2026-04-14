/**
 * `chorus init` — scaffold a ./chorus/ project directory.
 *
 * Writes:
 *   ./chorus/config.yaml        minimal config (name + defaults)
 *   ./chorus/workflows/         directory with `hello.example.yaml`
 *   ./chorus/.gitignore         excludes runtime state
 *   ./chorus/.env.example       encryption key placeholder
 *   ./.chorus/                  runtime-state dir (sqlite lives here)
 *   ./.chorus/keys.json         Ed25519 keypair (owner-only, never commit)
 *
 * Idempotency: if ./chorus/ already exists and is non-empty, init refuses
 * (returns error — never clobbers). Same for .chorus/keys.json.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { stringifyYaml } from "../yaml.js";
import type { ChorusConfig } from "../config.js";

export interface InitOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Project name for config. Defaults to basename(cwd). */
  name?: string;
  /**
   * Encryption passphrase. If not provided AND passphraseFromEnv is false,
   * a random 32-byte key is generated and written to .env.example.
   */
  passphrase?: string;
  /** If true, do not prompt — read CHORUS_ENCRYPTION_KEY from env. */
  passphraseFromEnv?: boolean;
  /** Suppress user-visible logging. Tests set this to true. */
  silent?: boolean;
}

export interface InitResult {
  chorusDir: string;
  stateDir: string;
  configPath: string;
  workflowsDir: string;
  keysPath: string;
  /** The generated encryption key (base64), if one was freshly created. */
  generatedEncryptionKey?: string;
  /** Public key portion of the generated Ed25519 keypair (base64). */
  publicKey: string;
}

export class AlreadyInitializedError extends Error {
  constructor(public chorusDir: string) {
    super(
      `Chorus already initialized at ${chorusDir}. Remove the directory first or use a different cwd.`,
    );
    this.name = "AlreadyInitializedError";
  }
}

/**
 * Programmatic entry point. Throws AlreadyInitializedError if the target
 * dir is already populated.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const chorusDir = path.join(cwd, "chorus");
  const stateDir = path.join(cwd, ".chorus");

  // Idempotency check — refuse if chorus/ already exists with contents.
  if (await directoryExistsNonEmpty(chorusDir)) {
    throw new AlreadyInitializedError(chorusDir);
  }

  const name = options.name ?? path.basename(cwd);

  // Generate Ed25519 keypair. We try @chorus/registry first (authoritative
  // source once it's built) and fall back to Node's crypto if not yet available.
  const keypair = await generateKeypair();

  const generatedEncryptionKey =
    options.passphraseFromEnv
      ? undefined
      : options.passphrase
        ? Buffer.from(options.passphrase).toString("base64")
        : randomBytes(32).toString("base64");

  // Build config object and serialize.
  const config: ChorusConfig = {
    name,
    version: 1,
    workflowsDir: "workflows",
    integrationsDir: "integrations",
    database: { path: ".chorus/chorus.db" },
    server: { host: "127.0.0.1", port: 3710 },
    repair: { autoAttempt: false, model: "claude-sonnet-4-5", dailyBudget: 10 },
    registry: { url: "https://registry.chorus.dev", pollIntervalMs: 5 * 60 * 1000 },
    publicKey: keypair.publicKeyBase64,
  };

  // ── Write files ───────────────────────────────────────────────────────────

  await mkdir(chorusDir, { recursive: true });
  const workflowsDir = path.join(chorusDir, "workflows");
  await mkdir(workflowsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const configPath = path.join(chorusDir, "config.yaml");
  await writeFile(
    configPath,
    [
      "# Chorus project configuration.",
      "# See https://chorus.dev/docs/config for the full schema.",
      "",
      stringifyYaml(config).trimEnd(),
      "",
    ].join("\n"),
    "utf8",
  );

  const gitignorePath = path.join(chorusDir, ".gitignore");
  await writeFile(
    gitignorePath,
    [
      "# Local runtime state — never commit.",
      "# The real SQLite DB lives in ./.chorus/, but users sometimes mistakenly",
      "# put secrets inside ./chorus/; this keeps both safe by default.",
      ".secrets/",
      "*.local.yaml",
      "",
    ].join("\n"),
    "utf8",
  );

  const envExamplePath = path.join(chorusDir, ".env.example");
  await writeFile(
    envExamplePath,
    [
      "# Copy this file to .env and keep it OUT of version control.",
      "# CHORUS_ENCRYPTION_KEY is a base64-encoded 32-byte key used to encrypt",
      "# credentials stored in the SQLite DB. Losing it means you cannot decrypt",
      "# existing credentials — treat it like a root password.",
      "",
      generatedEncryptionKey
        ? `CHORUS_ENCRYPTION_KEY=${generatedEncryptionKey}`
        : "CHORUS_ENCRYPTION_KEY=  # provide a base64 32-byte key",
      "",
      "# Optional — enable the Claude-powered repair agent.",
      "# ANTHROPIC_API_KEY=sk-ant-...",
      "",
    ].join("\n"),
    "utf8",
  );

  const keysPath = path.join(stateDir, "keys.json");
  await writeFile(
    keysPath,
    JSON.stringify(
      {
        algorithm: "ed25519",
        publicKey: keypair.publicKeyBase64,
        privateKey: keypair.privateKeyBase64,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Example workflow — gives new users something to run immediately.
  const examplePath = path.join(workflowsDir, "hello.example.yaml");
  await writeFile(examplePath, EXAMPLE_WORKFLOW, "utf8");

  // Root .gitignore — add .chorus/ + .env if not already there.
  await ensureRootGitignore(cwd);

  if (!options.silent) {
    const p = process.stdout.write.bind(process.stdout);
    p(`${pc.green("✓")} ${pc.bold("Chorus initialized")}\n`);
    p(`   ${pc.dim("config:")}     ${configPath}\n`);
    p(`   ${pc.dim("workflows:")}  ${workflowsDir}\n`);
    p(`   ${pc.dim("keys:")}       ${keysPath}\n`);
    if (generatedEncryptionKey) {
      p(`\n${pc.yellow("!")} A new encryption key was written to ${envExamplePath}.\n`);
      p(`   Copy to .env and keep it safe — losing it = losing all credentials.\n`);
    }
    p(`\nNext steps:\n`);
    p(`   ${pc.cyan("chorus credentials add slack-send --type bearer")}\n`);
    p(`   ${pc.cyan("chorus run")}\n`);
  }

  return {
    chorusDir,
    stateDir,
    configPath,
    workflowsDir,
    keysPath,
    generatedEncryptionKey,
    publicKey: keypair.publicKeyBase64,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function directoryExistsNonEmpty(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Append a standard .gitignore block for Chorus to the project root
 * .gitignore if not already present. Creates the file if missing.
 * Idempotent — safe to run multiple times.
 */
async function ensureRootGitignore(cwd: string): Promise<void> {
  const gitignore = path.join(cwd, ".gitignore");
  const marker = "# ─── chorus ─────────────────────────────────────────";
  let existing = "";
  try {
    const { readFile } = await import("node:fs/promises");
    existing = await readFile(gitignore, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing.includes(marker)) return;
  const block = [
    "",
    marker,
    ".chorus/",
    "chorus/.env",
    "chorus/.env.local",
    "chorus/.secrets/",
    "",
  ].join("\n");
  await writeFile(gitignore, existing + block, "utf8");
}

/**
 * Generate an Ed25519 keypair. Prefers @chorus/registry's implementation so
 * the whole system uses identical key material; falls back to Node crypto.
 *
 * The import is deliberately indirected through a computed specifier so
 * bundlers (vitest/vite) don't try to statically resolve it when @chorus/registry
 * hasn't been built yet.
 */
async function generateKeypair(): Promise<{
  publicKeyBase64: string;
  privateKeyBase64: string;
}> {
  const registry = await tryImportRegistry();
  if (registry && typeof registry.generateKeypair === "function") {
    const kp = await registry.generateKeypair();
    return {
      publicKeyBase64: Buffer.from(kp.publicKey).toString("base64"),
      privateKeyBase64: Buffer.from(kp.privateKey).toString("base64"),
    };
  }
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  return {
    publicKeyBase64: Buffer.from(pubDer).toString("base64"),
    privateKeyBase64: Buffer.from(privDer).toString("base64"),
  };
}

interface RegistryModule {
  generateKeypair?: () => Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
}

/**
 * Dynamic import that survives the target package being absent. We use a
 * computed specifier + catch so bundlers can't statically resolve us into
 * a compile error when the sibling hasn't shipped a dist/ yet.
 */
async function tryImportRegistry(): Promise<RegistryModule | null> {
  // Build the specifier at runtime so vite doesn't try to statically analyze it.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  try {
    const mod = (await dynamicImport("@chorus/registry")) as RegistryModule;
    return mod;
  } catch {
    return null;
  }
}

const EXAMPLE_WORKFLOW = `# Example workflow: webhook → post to Slack.
#
# Before running:
#   1. Add a Slack bot token:
#        chorus credentials add slack-send --type bearer
#   2. Start the runtime:
#        chorus run
#   3. Trigger the webhook (port defaults to 3710):
#        curl -X POST http://localhost:3710/hooks/hello -d '{"text":"hi"}'

id: hello
name: Webhook-to-Slack demo
version: 1
active: true
trigger:
  type: webhook
  path: /hooks/hello
  method: POST
nodes:
  - id: post
    integration: slack-send
    operation: postMessage
    config:
      channel: "#general"
      text: "Hello from Chorus!"
createdAt: 2026-04-13T00:00:00Z
updatedAt: 2026-04-13T00:00:00Z
`;
