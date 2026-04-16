/**
 * `chorus patch <list|apply|propose|revoke>` — patch management.
 *
 * This command delegates to @delightfulchorus/registry (for catalog ops) and reads/
 * writes the local SQLite DB for the user's adoption state. As with the
 * rest of the CLI, sibling package imports are indirected so the CLI can
 * still build/test when siblings haven't shipped dist/ yet.
 */
import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";

export type PatchAction = "list" | "apply" | "propose" | "revoke";

export interface PatchOptions {
  cwd?: string;
  json?: boolean;
  patchId?: string;
  /** For `propose` — path to a patch manifest JSON file. */
  manifestPath?: string;
  /** For `apply` — skip the 7-day canary ladder (testing only). */
  force?: boolean;
}

export interface PatchListEntry {
  id: string;
  integration: string;
  signatureHash: string;
  version: string;
  state: string;
  appliedAt: string | null;
}

export async function runPatchCommand(
  action: PatchAction,
  opts: PatchOptions = {},
): Promise<number> {
  switch (action) {
    case "list":
      return await listPatches(opts);
    case "apply":
      return await applyPatch(opts);
    case "propose":
      return await proposePatch(opts);
    case "revoke":
      return await revokePatch(opts);
    default:
      process.stderr.write(pc.red(`unknown patch action: ${action as string}\n`));
      return 1;
  }
}

// ── list ────────────────────────────────────────────────────────────────────

export async function listPatches(opts: PatchOptions): Promise<number> {
  const rows = await readPatchesFromDB(opts.cwd);
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  const p = process.stdout.write.bind(process.stdout);
  if (rows.length === 0) {
    p(`${pc.dim("no patches registered")}\n`);
    return 0;
  }
  p(`${pc.bold("Registered patches")}\n`);
  for (const r of rows) {
    p(
      `   ${pc.cyan(r.id)}  ${r.integration}@${r.version}  ${pc.dim("sig:")} ${r.signatureHash.slice(0, 12)}…  state=${r.state}${r.appliedAt ? pc.dim(` (applied ${r.appliedAt})`) : ""}\n`,
    );
  }
  return 0;
}

// ── apply ───────────────────────────────────────────────────────────────────

async function applyPatch(opts: PatchOptions): Promise<number> {
  if (!opts.patchId) {
    process.stderr.write(pc.red("error: patch apply <patch-id> is required\n"));
    return 1;
  }
  const registry = await tryImport<RegistryModule>("@delightfulchorus/registry");
  const p = process.stdout.write.bind(process.stdout);
  if (!registry?.fetchPatch || !registry?.verifyPatch) {
    p(
      `${pc.yellow("!")} @delightfulchorus/registry not available — recording intent locally only.\n` +
        `   Once the registry package ships fetchPatch/verifyPatch, re-run to complete.\n`,
    );
    return await recordLocalIntent(opts.cwd, opts.patchId, "apply_pending");
  }
  const patch = await registry.fetchPatch(opts.patchId);
  const verdict = await registry.verifyPatch(patch);
  if (!verdict.ok) {
    p(`${pc.red("✗")} signature verification failed: ${verdict.reason ?? "unknown"}\n`);
    return 2;
  }
  if (!opts.force && patch.rollout?.currentPercentage !== undefined && patch.rollout.currentPercentage < 100) {
    p(
      `${pc.yellow("!")} patch is still on canary (${patch.rollout.currentPercentage}%). Pass --force to apply early.\n`,
    );
    return 3;
  }
  await recordLocalIntent(opts.cwd, opts.patchId, "applied");
  p(`${pc.green("✓")} applied ${pc.cyan(opts.patchId)}\n`);
  return 0;
}

// ── propose ─────────────────────────────────────────────────────────────────

async function proposePatch(opts: PatchOptions): Promise<number> {
  if (!opts.manifestPath) {
    process.stderr.write(pc.red("error: patch propose --manifest=<path> is required\n"));
    return 1;
  }
  const registry = await tryImport<RegistryModule>("@delightfulchorus/registry");
  const p = process.stdout.write.bind(process.stdout);
  if (!registry?.submitProposal) {
    p(`${pc.yellow("!")} @delightfulchorus/registry not available — proposal not submitted.\n`);
    return 2;
  }
  const abs = path.resolve(opts.manifestPath);
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(abs, "utf8");
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const receipt = await registry.submitProposal(manifest);
  if (opts.json) {
    p(JSON.stringify(receipt, null, 2) + "\n");
  } else {
    p(`${pc.green("✓")} submitted proposal ${pc.cyan(receipt.id)}\n`);
  }
  return 0;
}

// ── revoke ──────────────────────────────────────────────────────────────────

async function revokePatch(opts: PatchOptions): Promise<number> {
  if (!opts.patchId) {
    process.stderr.write(pc.red("error: patch revoke <patch-id> is required\n"));
    return 1;
  }
  const p = process.stdout.write.bind(process.stdout);
  await recordLocalIntent(opts.cwd, opts.patchId, "revoked");
  p(`${pc.green("✓")} locally revoked ${pc.cyan(opts.patchId)}\n`);
  const registry = await tryImport<RegistryModule>("@delightfulchorus/registry");
  if (registry?.reportRevocation) {
    await registry.reportRevocation(opts.patchId);
    p(`   ${pc.dim("reported to registry")}\n`);
  }
  return 0;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function readPatchesFromDB(cwd?: string): Promise<PatchListEntry[]> {
  const root = cwd ?? process.cwd();
  let dbPath: string;
  try {
    const { config, chorusDir } = await loadConfig(root);
    dbPath = path.isAbsolute(config.database.path)
      ? config.database.path
      : path.join(path.dirname(chorusDir), config.database.path);
  } catch {
    return [];
  }
  const Database = await loadSqlite();
  if (!Database) return [];
  let db: ReturnType<typeof Database>;
  try {
    db = Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, integration, signature_hash AS signatureHash, version, state,
                applied_at AS appliedAt
           FROM patches
          ORDER BY COALESCE(applied_at, '') DESC`,
      )
      .all() as PatchListEntry[];
    return rows;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function recordLocalIntent(
  cwd: string | undefined,
  patchId: string,
  state: string,
): Promise<number> {
  const root = cwd ?? process.cwd();
  const { config, chorusDir } = await loadConfig(root);
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);
  const Database = await loadSqlite();
  if (!Database) return 0;
  const db = Database(dbPath, { readonly: false, fileMustExist: false });
  try {
    // Ensure the patches table exists (defensive — runtime normally owns it).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS patches (
         id              TEXT PRIMARY KEY,
         integration     TEXT NOT NULL DEFAULT '',
         signature_hash  TEXT NOT NULL DEFAULT '',
         version         TEXT NOT NULL DEFAULT '',
         state           TEXT NOT NULL,
         manifest        TEXT NOT NULL DEFAULT '{}',
         sigstore_bundle BLOB,
         ed25519_sig     BLOB,
         applied_at      TEXT,
         rolled_back_at  TEXT
       )`,
    ).run();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO patches (id, integration, signature_hash, version, state, manifest, applied_at)
       VALUES (?, '', '', '', ?, '{}', CASE WHEN ? = 'applied' THEN ? ELSE NULL END)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state,
         applied_at = CASE WHEN excluded.state = 'applied' THEN excluded.applied_at ELSE patches.applied_at END,
         rolled_back_at = CASE WHEN excluded.state = 'revoked' THEN ? ELSE patches.rolled_back_at END`,
    ).run(patchId, state, state, nowIso, nowIso);
  } finally {
    db.close();
  }
  return 0;
}

// ── Dynamic imports ─────────────────────────────────────────────────────────

async function tryImport<T>(specifier: string): Promise<T | null> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
  try {
    return (await dynamicImport(specifier)) as T;
  } catch {
    return null;
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
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
  try {
    const mod = (await dynamicImport("better-sqlite3")) as
      | { default: unknown }
      | Record<string, unknown>;
    const ctor = ((mod as { default?: unknown }).default ?? mod) as never;
    return ctor;
  } catch {
    return null;
  }
}

// ── Registry module shape ───────────────────────────────────────────────────

interface RegistryModule {
  fetchPatch?: (id: string) => Promise<{
    rollout?: { currentPercentage?: number };
    [k: string]: unknown;
  }>;
  verifyPatch?: (
    patch: unknown,
  ) => Promise<{ ok: boolean; reason?: string }>;
  submitProposal?: (manifest: unknown) => Promise<{ id: string }>;
  reportRevocation?: (patchId: string) => Promise<void>;
}
