/**
 * `chorus import <url|file> [--rename <new-slug>]` —
 *
 * Inverse of `chorus share`. Fetches or reads a chorus-template JSON,
 * validates its embedded workflow against WorkflowSchema, enumerates
 * the credential references, and inserts the workflow into the local
 * SQLite database.
 *
 * Transport:
 *   - file path: readFile + parse JSON
 *   - http(s):// URL: fetch + parse JSON (expected form for gist raw URLs)
 *
 * Credential rebinding model:
 *   - Every __credentialRef stub names an (integration, credentialType).
 *   - If a credential of that type exists locally → link transparently.
 *   - If none → print the `chorus credentials add <integration>`
 *     incantation the user must run first, and exit non-zero.
 *
 * See docs/CLOUD_DISTRIBUTION.md §5.2 for the full contract.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import type { Workflow } from "@delightfulchorus/core";
import { WorkflowSchema } from "@delightfulchorus/core";
import { loadConfig } from "../config.js";
import {
  gatherCredentialRefs,
  isCredentialRef,
  type RedactedWorkflow,
  type RefBucket,
} from "../lib/credential-redaction.js";
import type { ChorusTemplate } from "./share.js";

export interface ImportOptions {
  cwd?: string;
  /** Source: file path OR http(s):// URL. */
  source: string;
  /** Optionally rename the imported workflow (slug replacement). */
  rename?: string;
  /**
   * Supply a fetch implementation — tests inject. Defaults to global
   * fetch (Node 20+).
   */
  fetchFn?: typeof fetch;
  /**
   * If true, skip the "required credentials" check. Used by CI / tests
   * that install credentials after import. Humans should NOT set this.
   */
  skipCredentialCheck?: boolean;
  /** Suppress stdout/stderr (tests). */
  silent?: boolean;
}

export interface ImportResult {
  /** The imported workflow, post-rename. */
  workflow: Workflow;
  /** Credentials that need to be configured before the workflow can run. */
  missingCredentials: RefBucket[];
  /** True if the DB path is writable AND the workflow was inserted. */
  inserted: boolean;
  /** Any warnings the user should see (stale catalog entries, etc). */
  warnings: string[];
}

// ── Entry ──────────────────────────────────────────────────────────────────

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const cwd = opts.cwd ?? process.cwd();
  const template = await fetchTemplate(opts.source, opts.fetchFn);

  // Validate schema version + workflow shape.
  if (template.schemaVersion !== 1) {
    throw new Error(
      `unsupported template schemaVersion: ${template.schemaVersion} ` +
        `(this chorus CLI supports version 1)`,
    );
  }
  const workflowResult = WorkflowSchema.safeParse(template.workflow);
  if (!workflowResult.success) {
    const joined = workflowResult.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`template workflow failed schema validation: ${joined}`);
  }

  // Apply --rename if requested. WorkflowSchema.parse has stripped
  // non-schema keys, so .id is guaranteed to be a string.
  const workflow: Workflow = opts.rename
    ? { ...workflowResult.data, id: opts.rename }
    : workflowResult.data;

  // Enumerate credential requirements. Note we inspect the redacted
  // template.workflow directly — it has __credentialRef stubs; the
  // Zod-parsed shape is a Workflow that passes schema but still
  // contains those refs inside node.config (which is z.record(unknown)).
  const refs = gatherCredentialRefs(template.workflow as RedactedWorkflow);

  let missingCredentials: RefBucket[] = [];
  let inserted = false;
  const warnings: string[] = [];

  if (!opts.skipCredentialCheck) {
    missingCredentials = await findMissingCredentials(cwd, refs);
  }

  if (missingCredentials.length > 0 && !opts.skipCredentialCheck) {
    // Don't insert a workflow the runtime can't execute. Tell the user
    // what's missing and how to configure it.
    if (!opts.silent) {
      printMissingInstructions(workflow.id, missingCredentials);
    }
    return { workflow, missingCredentials, inserted: false, warnings };
  }

  // Insert into SQLite. The redacted workflow (with __credentialRef
  // stubs still in node.config) is what we store; the runtime will
  // re-resolve them at execution time. That separation keeps the
  // import operation idempotent and inspectable.
  inserted = await insertWorkflow(cwd, workflow, template);

  if (!opts.silent && inserted) {
    const p = process.stdout.write.bind(process.stdout);
    p(`${pc.green("✓")} imported workflow ${pc.cyan(workflow.id)}\n`);
    if (refs.length > 0) {
      p(
        `   ${pc.dim("credentials linked:")} ${refs.length} ref(s) across ` +
          `${refs.length === 1 ? "1 type" : `${refs.length} types`}\n`,
      );
    }
    p(`\n   Next steps:\n`);
    p(`     ${pc.cyan(`chorus validate chorus/workflows/${workflow.id}.yaml`)} ` +
      `${pc.dim("# once you dump it out")}\n`);
    p(`     ${pc.cyan(`chorus run ${workflow.id}`)}\n`);
  }

  return { workflow, missingCredentials, inserted, warnings };
}

// ── CLI shim ───────────────────────────────────────────────────────────────

export async function runImportCli(opts: ImportOptions): Promise<number> {
  try {
    const result = await runImport(opts);
    if (!result.inserted && result.missingCredentials.length > 0) {
      return 2;
    }
    if (!result.inserted) {
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      pc.red(`import failed: ${(err as Error).message}\n`),
    );
    return 1;
  }
}

// ── Transport ──────────────────────────────────────────────────────────────

async function fetchTemplate(
  source: string,
  fetchFn?: typeof fetch,
): Promise<ChorusTemplate> {
  const looksLikeUrl = /^https?:\/\//i.test(source);
  if (looksLikeUrl) {
    const f = fetchFn ?? fetch;
    const res = await f(source);
    if (!res.ok) {
      throw new Error(`fetch ${source} failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;
    return json as ChorusTemplate;
  }
  // File path.
  const abs = path.resolve(source);
  let s;
  try {
    s = await stat(abs);
  } catch (err) {
    throw new Error(`cannot open ${abs}: ${(err as Error).message}`);
  }
  if (!s.isFile()) throw new Error(`${abs} is not a file`);
  const raw = await readFile(abs, "utf8");
  return JSON.parse(raw) as ChorusTemplate;
}

// ── Credential gating ──────────────────────────────────────────────────────

async function findMissingCredentials(
  cwd: string,
  refs: RefBucket[],
): Promise<RefBucket[]> {
  if (refs.length === 0) return [];

  // Read the local credentials table. If the DB doesn't exist yet, every
  // ref is missing — the user hasn't configured anything.
  let credentials: Array<{ integration: string }> = [];
  try {
    credentials = await queryCredentialIntegrations(cwd);
  } catch {
    credentials = [];
  }

  // We currently match on `integration` alone — the per-type name match
  // (credential_type_name) is not yet enforced here. The runtime resolver
  // (packages/core/src/credential-catalog.ts `resolveCredentialType`) will
  // handle type-name matching at execution time; all we need to know for
  // the import gate is "does the user have ANY credential for this
  // integration?" — if not, the workflow will 100% fail to run.
  //
  // Sharper matching (same credential type name) is a TODO once
  // credential_type_name is reliably populated on rows across the
  // installed base. Today many rows still have the empty string.
  const installed = new Set(credentials.map((c) => c.integration));
  return refs.filter((r) => !installed.has(r.integration));
}

async function queryCredentialIntegrations(
  cwd: string,
): Promise<Array<{ integration: string }>> {
  const { config, chorusDir } = await loadConfig(cwd);
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);

  const Database = await loadSqlite();
  if (!Database) return [];

  let db: ReturnType<typeof Database>;
  try {
    db = Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    if (!hasTable(db, "credentials")) return [];
    const rows = db
      .prepare(`SELECT DISTINCT integration FROM credentials`)
      .all() as Array<{ integration: string }>;
    return rows;
  } finally {
    db.close();
  }
}

function printMissingInstructions(
  workflowId: string,
  missing: RefBucket[],
): void {
  const out = process.stderr.write.bind(process.stderr);
  out(
    `${pc.yellow("!")} workflow ${pc.cyan(workflowId)} cannot be imported ` +
      `until the following credentials exist locally:\n`,
  );
  for (const m of missing) {
    out(
      `     - ${pc.cyan(m.integration)}:${pc.cyan(m.credentialType)} ` +
        `${pc.dim(`(${m.sites.length} site${m.sites.length === 1 ? "" : "s"})`)}\n`,
    );
    out(`       ${pc.dim("add with:")} chorus credentials add ${m.integration}\n`);
  }
  out(`\n   Once configured, re-run:\n`);
  out(
    `     ${pc.cyan(`chorus import <same-source> ${workflowId ? `--rename ${workflowId}` : ""}`)}\n`,
  );
}

// ── Insertion ──────────────────────────────────────────────────────────────

async function insertWorkflow(
  cwd: string,
  workflow: Workflow,
  template: ChorusTemplate,
): Promise<boolean> {
  let dbPath: string;
  try {
    const { config, chorusDir } = await loadConfig(cwd);
    dbPath = path.isAbsolute(config.database.path)
      ? config.database.path
      : path.join(path.dirname(chorusDir), config.database.path);
  } catch {
    return false;
  }
  const Database = await loadSqlite();
  if (!Database) return false;

  // Ensure the directory tree for the SQLite file exists. The runtime
  // normally creates it at server startup; if the user is importing
  // without ever having run `chorus run`, we create it ourselves.
  try {
    await mkdir(path.dirname(dbPath), { recursive: true });
  } catch {
    // ignore — Database() below will produce a cleaner error if it fails
  }

  const db = Database(dbPath, { readonly: false, fileMustExist: false });
  try {
    ensureWorkflowsTable(db);
    const now = new Date().toISOString();

    // Store the *redacted* workflow definition. The node.config still
    // contains __credentialRef stubs, which the runtime resolver
    // translates into decrypted credentials at execution time.
    // We keep the stubs rather than filling in `credentialId` because
    // doing so here would require this command to know about the runtime's
    // credential resolution — it doesn't, and separation of concerns is
    // worth preserving. The runtime's executor does the resolution.
    const definition = JSON.stringify({
      ...workflow,
      nodes: template.workflow.nodes.map((n) =>
        applyRenameToNode(n, template.workflow.id, workflow.id),
      ),
    });

    db.prepare(
      `INSERT OR REPLACE INTO workflows
         (id, version, name, definition, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workflow.id,
      workflow.version,
      workflow.name,
      definition,
      workflow.active ? 1 : 0,
      workflow.createdAt ?? now,
      now,
    );
    return true;
  } finally {
    db.close();
  }
}

/**
 * Future-proofing helper: rename-aware node shallow-copy. Today nodes
 * don't reference their parent workflow id anywhere in node.config, but
 * if a future schema addition starts doing that, we want the rename to
 * propagate. For now this is effectively a passthrough.
 */
function applyRenameToNode(
  node: unknown,
  _fromId: string,
  _toId: string,
): unknown {
  return node;
}

function ensureWorkflowsTable(db: {
  prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
}): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS workflows (
       id             TEXT NOT NULL,
       version        INTEGER NOT NULL DEFAULT 1,
       name           TEXT NOT NULL,
       definition     TEXT NOT NULL,
       active         INTEGER NOT NULL DEFAULT 1,
       created_at     TEXT NOT NULL,
       updated_at     TEXT NOT NULL,
       PRIMARY KEY (id, version)
     )`,
  ).run();
}

// Reserved for future use — imported template may carry an exportedAt
// we want to stash somewhere visible. Currently we just echo on stdout.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _unusedId(): string {
  return randomUUID();
}

// ── SQLite loader (shared pattern) ─────────────────────────────────────────

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

function hasTable(
  db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } },
  name: string,
): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

// ── Public helper: identify credential refs inside a parsed template ───────

/**
 * Exposed for tooling that wants to enumerate what a template needs
 * without actually importing it. Used by the dashboard preview, by
 * agents generating import plans, and by tests.
 */
export function listTemplateCredentialRefs(
  template: ChorusTemplate,
): RefBucket[] {
  return gatherCredentialRefs(template.workflow);
}

/** Sanity check — does a given template appear to carry a credential ref? */
export function templateHasCredentialRefs(template: ChorusTemplate): boolean {
  for (const node of template.workflow.nodes) {
    for (const v of Object.values(node.config)) {
      if (isCredentialRef(v)) return true;
    }
  }
  return false;
}
