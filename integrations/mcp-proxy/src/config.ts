/**
 * MCP proxy config loader.
 *
 * Resolves upstream MCP server definitions from (in order of precedence):
 *   1. Runtime-passed config (`ctx.config.mcpServers` — see note below about
 *      how we surface it since OperationContext doesn't expose `config` yet).
 *   2. Local file: `./chorus/mcp-servers.json` (resolved from cwd).
 *   3. User-global: `~/.chorus/mcp-servers.json`.
 *
 * Env-var substitution: any string value inside `env` / `headers` of the form
 * `{{env.FOO}}` is replaced with `process.env.FOO` at resolve time. Missing
 * vars resolve to an empty string. We ALSO support the per-server override
 * pattern `CHORUS_MCP_<serverId>_<VAR>` (uppercased, non-alnum → `_`); that
 * takes precedence over the explicit `{{env.VAR}}` form so that a Chorus
 * operator can rotate upstream secrets without editing files.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────────────

const StdioTransportSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
});

const SseTransportSchema = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
});

export const ServerConfigSchema = z.discriminatedUnion("transport", [
  StdioTransportSchema,
  SseTransportSchema,
]);

export const ServersFileSchema = z.object({
  servers: z.record(ServerConfigSchema).default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServersFile = z.infer<typeof ServersFileSchema>;

// ── Loaders ─────────────────────────────────────────────────────────────────

export interface ConfigResolveOptions {
  /** Explicit runtime-passed config (highest precedence). */
  runtimeServers?: Record<string, unknown>;
  /** Override cwd for the local file lookup (tests). */
  cwd?: string;
  /** Override home dir for the user-global file lookup (tests). */
  homeDir?: string;
  /** Optional injected fs.readFileSync (tests). */
  readFile?: (path: string) => string;
  /** Optional injected process.env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load and merge config from all three sources. Lower-precedence sources are
 * tried first; higher-precedence sources (runtime-passed) override matching
 * serverId entries.
 */
export function loadServersConfig(opts: ConfigResolveOptions = {}): Record<string, ServerConfig> {
  const reader = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
  const env = opts.env ?? process.env;

  const merged: Record<string, unknown> = {};

  // 3. User-global
  const home = opts.homeDir ?? homedir();
  tryMerge(merged, reader, join(home, ".chorus", "mcp-servers.json"));

  // 2. Local file
  const cwd = opts.cwd ?? process.cwd();
  tryMerge(merged, reader, join(cwd, "chorus", "mcp-servers.json"));

  // 1. Runtime-passed
  if (opts.runtimeServers) Object.assign(merged, opts.runtimeServers);

  // Parse + env-substitute each entry so errors point at the offending server.
  const out: Record<string, ServerConfig> = {};
  for (const [serverId, raw] of Object.entries(merged)) {
    const parsed = ServerConfigSchema.parse(raw);
    out[serverId] = substituteEnv(serverId, parsed, env);
  }
  return out;
}

function tryMerge(
  target: Record<string, unknown>,
  reader: (path: string) => string,
  path: string,
): void {
  let text: string;
  try {
    text = reader(path);
  } catch {
    // ENOENT / permission denied — file is optional.
    return;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`mcp-proxy config: ${path} is not valid JSON (${msg})`);
  }
  const file = ServersFileSchema.parse(obj);
  Object.assign(target, file.servers);
}

// ── Env substitution ────────────────────────────────────────────────────────

const ENV_PLACEHOLDER = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function substituteEnv(
  serverId: string,
  cfg: ServerConfig,
  env: NodeJS.ProcessEnv,
): ServerConfig {
  if (cfg.transport === "stdio") {
    return {
      ...cfg,
      env: substituteRecord(serverId, cfg.env, env),
      args: cfg.args.map((a) => substituteString(a, env)),
    };
  }
  return {
    ...cfg,
    headers: substituteRecord(serverId, cfg.headers, env),
    url: substituteString(cfg.url, env),
  };
}

function substituteRecord(
  serverId: string,
  rec: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    // Per-server override: CHORUS_MCP_<SERVER>_<VAR>
    const override = env[buildOverrideKey(serverId, k)];
    if (typeof override === "string") {
      out[k] = override;
      continue;
    }
    out[k] = substituteString(v, env);
  }
  return out;
}

function substituteString(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(ENV_PLACEHOLDER, (_, varName: string) => {
    const v = env[varName];
    return typeof v === "string" ? v : "";
  });
}

/** Build a per-server env-var override key (e.g. `CHORUS_MCP_GITHUB_TOKEN`). */
export function buildOverrideKey(serverId: string, varName: string): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `CHORUS_MCP_${slug(serverId)}_${slug(varName)}`;
}
