/**
 * CLI config loader: reads `./chorus/config.yaml` (or .yml/.json) into a
 * typed, Zod-validated config object.
 *
 * The config shape is intentionally minimal — it lives alongside workflows
 * and credentials in the user's `./chorus/` directory and points the
 * runtime at the rest of the project.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseYaml } from "./yaml.js";

// ── Schema ─────────────────────────────────────────────────────────────────

export const DatabaseConfigSchema = z
  .object({
    /** Absolute or relative path to SQLite file. Defaults to .chorus/chorus.db */
    path: z.string().default(".chorus/chorus.db"),
  })
  .strict()
  .default({ path: ".chorus/chorus.db" });

export const ServerConfigSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65_535).default(3710),
  })
  .strict()
  .default({ host: "127.0.0.1", port: 3710 });

export const RepairConfigSchema = z
  .object({
    autoAttempt: z.boolean().default(false),
    model: z.string().default("claude-sonnet-4-5"),
    dailyBudget: z.number().int().positive().default(10),
  })
  .strict()
  .default({ autoAttempt: false, model: "claude-sonnet-4-5", dailyBudget: 10 });

export const RegistryConfigSchema = z
  .object({
    url: z.string().url().default("https://registry.chorus.dev"),
    pollIntervalMs: z.number().int().positive().default(5 * 60 * 1000),
  })
  .strict()
  .default({ url: "https://registry.chorus.dev", pollIntervalMs: 5 * 60 * 1000 });

export const ChorusConfigSchema = z
  .object({
    /** Project name — shown in dashboards, used in telemetry fingerprinting. */
    name: z.string().min(1),
    version: z.number().int().min(1).default(1),
    /** Directory containing workflow definitions (yaml/json). */
    workflowsDir: z.string().default("workflows"),
    /** Directory containing integration packages or their manifests. */
    integrationsDir: z.string().default("integrations").optional(),
    database: DatabaseConfigSchema,
    server: ServerConfigSchema,
    repair: RepairConfigSchema,
    registry: RegistryConfigSchema,
    /** Public key identifying this install (Ed25519). Written by `chorus init`. */
    publicKey: z.string().optional(),
  })
  .strict();

export type ChorusConfig = z.infer<typeof ChorusConfigSchema>;

// ── Loader ─────────────────────────────────────────────────────────────────

export interface LoadResult {
  /** The validated config object. */
  config: ChorusConfig;
  /** Absolute path to the file that was read. */
  path: string;
  /** Absolute path to the chorus/ directory containing the config. */
  chorusDir: string;
}

/**
 * Load config from a directory. Looks for (in priority order):
 *   1. config.yaml
 *   2. config.yml
 *   3. config.json
 *
 * Returns { config, path, chorusDir }. Throws if file missing or invalid.
 */
export async function loadConfigFromDir(chorusDir: string): Promise<LoadResult> {
  const candidates = ["config.yaml", "config.yml", "config.json"];
  const abs = path.resolve(chorusDir);
  for (const name of candidates) {
    const p = path.join(abs, name);
    try {
      const s = await stat(p);
      if (s.isFile()) {
        const raw = await readFile(p, "utf8");
        const parsed = parseYaml(raw);
        return { config: ChorusConfigSchema.parse(parsed), path: p, chorusDir: abs };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  throw new ConfigNotFoundError(abs, candidates);
}

/** Shorthand: load from `<cwd>/chorus/`. */
export async function loadConfig(cwd: string = process.cwd()): Promise<LoadResult> {
  return loadConfigFromDir(path.join(cwd, "chorus"));
}

/**
 * Parse config text directly — useful for tests + for validating user input
 * before writing to disk.
 */
export function parseConfig(text: string): ChorusConfig {
  const raw = parseYaml(text);
  return ChorusConfigSchema.parse(raw);
}

export class ConfigNotFoundError extends Error {
  constructor(public dir: string, public searched: string[]) {
    super(
      `No Chorus config found in ${dir}. Looked for: ${searched.join(", ")}. Run 'chorus init' to scaffold one.`,
    );
    this.name = "ConfigNotFoundError";
  }
}
