/**
 * `chorus share <workflow-id> [--gist] [--out FILE]` —
 *
 * Exports a workflow to a shareable template. Credentials are redacted
 * via the credential-redaction transform; the resulting JSON is safe to
 * post publicly.
 *
 * Sources (in priority order):
 *   1. `./chorus/workflows/<id>.yaml` or `.yml` or `.json`
 *   2. Local SQLite database (for workflows inserted by `chorus run` or
 *      imported via `chorus import`)
 *
 * Destinations:
 *   - Default: write `<slug>.chorus-template.json` in cwd.
 *   - `--out <file>`: write to that exact path.
 *   - `--gist`: POST to GitHub Gist via @octokit/rest (optional dep).
 *     Auth comes from GITHUB_TOKEN env or `gh auth token`. Prints URL.
 *
 * See docs/CLOUD_DISTRIBUTION.md §5.1 for the full contract.
 */
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import type {
  CredentialTypeDefinition,
  IntegrationModule,
  Workflow,
} from "@delightfulchorus/core";
import { WorkflowSchema } from "@delightfulchorus/core";
import { loadConfig } from "../config.js";
import { parseYaml } from "../yaml.js";
import {
  redactCredentials,
  type IntegrationCatalogs,
  type RedactedWorkflow,
} from "../lib/credential-redaction.js";
import { defaultIntegrationLoader, type IntegrationLoader } from "./credentials.js";

export const TEMPLATE_SCHEMA_VERSION = 1 as const;

/** JSON envelope we write and accept on the wire. */
export interface ChorusTemplate {
  $schema: "https://chorus.dev/schemas/chorus-template/v1.json";
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  workflow: RedactedWorkflow;
  /** Freeform metadata from the exporter. Travels but is optional. */
  exportedAt: string;
  /** List of (integration, credentialType) pairs the import side must rebind. */
  requiredCredentials: Array<{
    integration: string;
    credentialType: string;
    sites: number;
  }>;
}

export interface ShareOptions {
  cwd?: string;
  /** Workflow id. Must match a file under chorus/workflows OR a DB row. */
  workflowId: string;
  /** If true, POST to GitHub Gist and print the URL. */
  gist?: boolean;
  /** Override output file path (file mode only). */
  out?: string;
  /** Override integration loader. Tests inject a stub. */
  integrationLoader?: IntegrationLoader;
  /** Override the gist POST (tests inject a mock). */
  gistClient?: GistClient;
  /** Override the GitHub token lookup (tests bypass the env). */
  tokenResolver?: () => string | null;
  /** Suppress stdout/stderr in tests. */
  silent?: boolean;
}

export interface ShareResult {
  template: ChorusTemplate;
  /** File path written to, or undefined in gist-only mode. */
  writtenTo?: string;
  /** Gist URL, or undefined in file-only mode. */
  gistUrl?: string;
}

// ── Gist client abstraction ────────────────────────────────────────────────

export interface GistClient {
  create(args: {
    token: string;
    description: string;
    filename: string;
    content: string;
    public?: boolean;
  }): Promise<{ url: string; id: string }>;
}

/**
 * Load @octokit/rest lazily so it remains an optional dep. If the module
 * isn't installed, return null and let the caller print a clear error.
 */
async function loadOctokitClient(): Promise<GistClient | null> {
  // Use runtime-computed specifier so bundlers don't try to statically
  // resolve an optional dep.
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  try {
    const mod = (await dynamicImport("@octokit/rest")) as {
      Octokit?: new (opts: { auth: string }) => OctokitShape;
    };
    const Ctor = mod.Octokit;
    if (!Ctor) return null;
    return {
      async create(args) {
        const client = new Ctor({ auth: args.token });
        const res = await client.gists.create({
          description: args.description,
          public: args.public ?? false,
          files: {
            [args.filename]: { content: args.content },
          },
        });
        return {
          url: res.data.html_url ?? "",
          id: res.data.id ?? "",
        };
      },
    };
  } catch {
    return null;
  }
}

/** Minimal Octokit surface we exercise. Keeps our code type-safe without a hard dep. */
interface OctokitShape {
  gists: {
    create(args: {
      description: string;
      public: boolean;
      files: Record<string, { content: string }>;
    }): Promise<{ data: { html_url?: string; id?: string } }>;
  };
}

// ── Main entry ─────────────────────────────────────────────────────────────

export async function runShare(opts: ShareOptions): Promise<ShareResult> {
  const cwd = opts.cwd ?? process.cwd();
  const workflow = await loadWorkflow(cwd, opts.workflowId);

  // Gather credential catalogs for every integration referenced by the graph.
  const loader = opts.integrationLoader ?? defaultIntegrationLoader;
  const catalogs = await loadCatalogs(workflow, loader);

  const redactResult = redactCredentials(workflow, catalogs);
  const redacted = redactResult.workflow;

  const requiredCredentials = summarizeRequired(redacted);

  const template: ChorusTemplate = {
    $schema: "https://chorus.dev/schemas/chorus-template/v1.json",
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    workflow: redacted,
    exportedAt: new Date().toISOString(),
    requiredCredentials,
  };

  const json = JSON.stringify(template, null, 2) + "\n";

  if (opts.gist) {
    const gistResult = await postToGist(template, json, opts);
    return {
      template,
      gistUrl: gistResult.url,
    };
  }

  const outPath = opts.out
    ? path.resolve(cwd, opts.out)
    : path.resolve(cwd, `${workflow.id}.chorus-template.json`);
  await writeFile(outPath, json, "utf8");

  if (!opts.silent) {
    const p = process.stdout.write.bind(process.stdout);
    p(`${pc.green("✓")} exported ${pc.cyan(workflow.id)} → ${outPath}\n`);
    p(
      `   ${pc.dim("credentials stripped:")} ${redactResult.stubbed.length} ` +
        `${pc.dim("(via catalog)")}`,
    );
    if (redactResult.fallbackStrippedKeys.length > 0) {
      p(
        ` + ${redactResult.fallbackStrippedKeys.length} ${pc.dim("(via heuristic)")}`,
      );
    }
    p("\n");
    if (requiredCredentials.length > 0) {
      p(`   ${pc.dim("required on import:")}\n`);
      for (const r of requiredCredentials) {
        p(
          `     - ${pc.cyan(r.integration)}:${r.credentialType} ` +
            `${pc.dim(`(${r.sites} site${r.sites === 1 ? "" : "s"})`)}\n`,
        );
      }
    }
  }

  return { template, writtenTo: outPath };
}

// ── CLI entry (exit-code shim) ─────────────────────────────────────────────

export async function runShareCli(opts: ShareOptions): Promise<number> {
  try {
    await runShare(opts);
    return 0;
  } catch (err) {
    process.stderr.write(
      pc.red(`share failed: ${(err as Error).message}\n`),
    );
    return 1;
  }
}

// ── Workflow loading ───────────────────────────────────────────────────────

/**
 * Resolve a workflow id to a Workflow object. Tries:
 *   1. ./chorus/workflows/<id>.yaml (.yml, .json)
 *   2. Any workflow file under chorus/workflows with matching `id:`
 *   3. SQLite workflows table (latest version)
 *
 * Throws a descriptive error if nothing matches.
 */
async function loadWorkflow(cwd: string, id: string): Promise<Workflow> {
  // Prefer filesystem — deterministic, runtime-independent.
  const fileWorkflow = await loadWorkflowFromFilesystem(cwd, id);
  if (fileWorkflow) return fileWorkflow;

  // Fall back to SQLite.
  const dbWorkflow = await loadWorkflowFromDatabase(cwd, id);
  if (dbWorkflow) return dbWorkflow;

  throw new Error(
    `no workflow with id "${id}" found in ./chorus/workflows/ or the local database`,
  );
}

async function loadWorkflowFromFilesystem(
  cwd: string,
  id: string,
): Promise<Workflow | null> {
  let workflowsDir: string;
  try {
    const { config, chorusDir } = await loadConfig(cwd);
    workflowsDir = path.isAbsolute(config.workflowsDir)
      ? config.workflowsDir
      : path.join(chorusDir, config.workflowsDir);
  } catch {
    return null;
  }

  let entries: string[];
  try {
    entries = await readdir(workflowsDir);
  } catch {
    return null;
  }

  // Exact name match first: <id>.yaml/.yml/.json.
  for (const ext of [".yaml", ".yml", ".json"]) {
    const candidate = path.join(workflowsDir, `${id}${ext}`);
    const parsed = await tryLoadWorkflowFile(candidate);
    if (parsed && parsed.id === id) return parsed;
  }

  // Otherwise scan every file and match by `id:`.
  for (const entry of entries) {
    const full = path.join(workflowsDir, entry);
    if (!/\.(ya?ml|json)$/i.test(entry)) continue;
    const parsed = await tryLoadWorkflowFile(full);
    if (parsed && parsed.id === id) return parsed;
  }
  return null;
}

async function tryLoadWorkflowFile(p: string): Promise<Workflow | null> {
  try {
    const s = await stat(p);
    if (!s.isFile()) return null;
    const raw = await readFile(p, "utf8");
    const parsed = parseYaml(raw);
    const result = WorkflowSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function loadWorkflowFromDatabase(
  cwd: string,
  id: string,
): Promise<Workflow | null> {
  let dbPath: string;
  try {
    const { config, chorusDir } = await loadConfig(cwd);
    dbPath = path.isAbsolute(config.database.path)
      ? config.database.path
      : path.join(path.dirname(chorusDir), config.database.path);
  } catch {
    return null;
  }

  const Database = await loadSqlite();
  if (!Database) return null;

  let db: ReturnType<typeof Database>;
  try {
    db = Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  try {
    const row = db
      .prepare(
        `SELECT definition FROM workflows WHERE id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(id) as { definition: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.definition) as unknown;
    const result = WorkflowSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function loadSqlite(): Promise<
  | null
  | ((
      path: string,
      opts?: { readonly?: boolean; fileMustExist?: boolean },
    ) => {
      prepare: (sql: string) => {
        run: (...a: unknown[]) => unknown;
        all: (...a: unknown[]) => unknown;
        get: (...a: unknown[]) => unknown;
      };
      close: () => void;
    })
> {
  try {
    const mod = (await import("better-sqlite3")) as
      | { default: unknown }
      | Record<string, unknown>;
    const ctor = ((mod as { default?: unknown }).default ?? mod) as never;
    return ctor;
  } catch {
    return null;
  }
}

// ── Catalog resolution ─────────────────────────────────────────────────────

async function loadCatalogs(
  workflow: Workflow,
  loader: IntegrationLoader,
): Promise<IntegrationCatalogs> {
  const integrationNames = [...new Set(workflow.nodes.map((n) => n.integration))];
  const catalogs: IntegrationCatalogs = {};
  for (const name of integrationNames) {
    let mod: IntegrationModule;
    try {
      mod = await loader(name);
    } catch {
      // No catalog for this integration → redactor falls back to heuristic.
      continue;
    }
    const types = mod.manifest.credentialTypes ?? [];
    catalogs[name] = types as readonly CredentialTypeDefinition[];
  }
  return catalogs;
}

function summarizeRequired(
  redacted: RedactedWorkflow,
): ChorusTemplate["requiredCredentials"] {
  const seen = new Map<string, { integration: string; credentialType: string; sites: number }>();
  for (const node of redacted.nodes) {
    for (const v of Object.values(node.config)) {
      if (!v || typeof v !== "object") continue;
      const ref = v as Record<string, unknown>;
      if (ref.__credentialRef !== true) continue;
      const integration = String(ref.integration ?? "");
      const credentialType = String(ref.credentialType ?? "");
      const key = `${integration}::${credentialType}`;
      const existing = seen.get(key);
      if (existing) {
        existing.sites += 1;
      } else {
        seen.set(key, { integration, credentialType, sites: 1 });
      }
    }
  }
  return [...seen.values()];
}

// ── Gist posting ───────────────────────────────────────────────────────────

async function postToGist(
  template: ChorusTemplate,
  json: string,
  opts: ShareOptions,
): Promise<{ url: string }> {
  const token = resolveGithubToken(opts.tokenResolver);
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN not set and `gh auth token` did not return a value. " +
        "Set GITHUB_TOKEN or run `gh auth login` first.",
    );
  }
  const client = opts.gistClient ?? (await loadOctokitClient());
  if (!client) {
    throw new Error(
      "--gist requires @octokit/rest. Install it with:\n" +
        "  npm install @octokit/rest\n" +
        "(@octokit/rest is an optional dependency — only needed for --gist.)",
    );
  }
  const result = await client.create({
    token,
    description: `chorus template: ${template.workflow.name} (${template.workflow.id})`,
    filename: `${template.workflow.id}.chorus-template.json`,
    content: json,
    public: false,
  });
  if (!opts.silent) {
    const p = process.stdout.write.bind(process.stdout);
    p(`${pc.green("✓")} gist published: ${result.url}\n`);
  }
  return { url: result.url };
}

/**
 * Resolve a GitHub token from the environment. Order:
 *   1. process.env.GITHUB_TOKEN
 *   2. `gh auth token` output
 * Returns null if neither is available. Tests inject via tokenResolver.
 */
function resolveGithubToken(
  override?: () => string | null,
): string | null {
  if (override) return override();
  const env = process.env.GITHUB_TOKEN;
  if (env && env.trim().length > 0) return env.trim();
  try {
    const out = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.status === 0 && out.stdout.trim()) return out.stdout.trim();
  } catch {
    // `gh` not installed — fall through.
  }
  return null;
}
