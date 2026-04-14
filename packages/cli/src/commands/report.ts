/**
 * `chorus report` — summarize recent runs, failures, and known patches.
 *
 * Reads the SQLite DB directly (not via a running runtime), so this works
 * even if the runtime is offline.
 *
 * Output modes:
 *   - human table (default)
 *   - --json for agents / scripting
 */
import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";

export interface ReportOptions {
  cwd?: string;
  json?: boolean;
  /** Max rows shown in human mode. Default 20. */
  limit?: number;
}

export interface ReportRunSummary {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ReportSignatureSummary {
  hash: string;
  integration: string;
  operation: string;
  errorClass: string;
  httpStatus: number | null;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  reported: boolean;
}

export interface ReportPatchSummary {
  id: string;
  integration: string;
  signatureHash: string;
  version: string;
  state: string;
  appliedAt: string | null;
}

export interface ReportSummary {
  database: string;
  runs: ReportRunSummary[];
  signatures: ReportSignatureSummary[];
  patches: ReportPatchSummary[];
}

/**
 * Build a report summary. Opens the SQLite DB via better-sqlite3 directly —
 * we do NOT go through @chorus/runtime to avoid coupling.
 */
export async function buildReport(opts: ReportOptions = {}): Promise<ReportSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const { config, chorusDir } = await loadConfig(cwd);
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);

  const limit = opts.limit ?? 20;
  const Database = await loadBetterSqlite3();
  if (!Database) {
    // Runtime package isn't built yet; return an empty report. Keeps the CLI
    // usable for triage even in a partially-wired dev environment.
    return { database: dbPath, runs: [], signatures: [], patches: [] };
  }

  let db: ReturnType<typeof Database>;
  try {
    db = Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN" || (err as Error).message.includes("unable to open")) {
      return { database: dbPath, runs: [], signatures: [], patches: [] };
    }
    throw err;
  }
  try {
    const runs = hasTable(db, "runs")
      ? (db
          .prepare(
            `SELECT id, workflow_id AS workflowId, status, started_at AS startedAt,
                    finished_at AS finishedAt, error
               FROM runs
              ORDER BY started_at DESC
              LIMIT ?`,
          )
          .all(limit) as ReportRunSummary[])
      : [];
    const signatures = hasTable(db, "error_signatures")
      ? (db
          .prepare(
            `SELECT hash, integration, operation, error_class AS errorClass,
                    http_status AS httpStatus, occurrences,
                    first_seen AS firstSeen, last_seen AS lastSeen,
                    CASE WHEN reported = 1 THEN 1 ELSE 0 END AS reported
               FROM error_signatures
              ORDER BY last_seen DESC
              LIMIT ?`,
          )
          .all(limit) as Array<Omit<ReportSignatureSummary, "reported"> & { reported: number }>).map(
          (r) => ({ ...r, reported: Boolean(r.reported) }),
        )
      : [];
    const patches = hasTable(db, "patches")
      ? (db
          .prepare(
            `SELECT id, integration, signature_hash AS signatureHash,
                    version, state, applied_at AS appliedAt
               FROM patches
              ORDER BY COALESCE(applied_at, '') DESC
              LIMIT ?`,
          )
          .all(limit) as ReportPatchSummary[])
      : [];
    return { database: dbPath, runs, signatures, patches };
  } finally {
    db.close();
  }
}

function hasTable(db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

/**
 * CLI entry point. Returns exit code.
 */
export async function runReport(opts: ReportOptions = {}): Promise<number> {
  const summary = await buildReport(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  const p = process.stdout.write.bind(process.stdout);
  p(`${pc.bold("Chorus report")} — ${pc.dim(summary.database)}\n\n`);

  p(pc.bold("Recent runs") + pc.dim(` (${summary.runs.length})`) + "\n");
  if (summary.runs.length === 0) {
    p(`   ${pc.dim("(none)")}\n`);
  } else {
    for (const r of summary.runs) {
      const statusColor =
        r.status === "success"
          ? pc.green
          : r.status === "failed"
            ? pc.red
            : r.status === "running"
              ? pc.cyan
              : pc.dim;
      p(
        `   ${statusColor(pad(r.status, 9))} ${pc.dim(r.startedAt)}  ${r.workflowId}  ${pc.dim(r.id)}\n`,
      );
      if (r.error) p(`      ${pc.red("→")} ${truncate(r.error, 120)}\n`);
    }
  }

  p(`\n${pc.bold("Error signatures")}${pc.dim(` (${summary.signatures.length})`)}\n`);
  if (summary.signatures.length === 0) {
    p(`   ${pc.dim("(none)")}\n`);
  } else {
    for (const s of summary.signatures) {
      p(
        `   ${pc.yellow(s.hash.slice(0, 12))}…  ×${s.occurrences}  ${s.integration}.${s.operation}  ${pc.dim(s.errorClass)}${s.httpStatus ? pc.dim(` (HTTP ${s.httpStatus})`) : ""}  ${s.reported ? pc.green("reported") : pc.dim("local")}\n`,
      );
    }
  }

  p(`\n${pc.bold("Patches")}${pc.dim(` (${summary.patches.length})`)}\n`);
  if (summary.patches.length === 0) {
    p(`   ${pc.dim("(none)")}\n`);
  } else {
    for (const patch of summary.patches) {
      p(
        `   ${pc.cyan(patch.id)}  ${patch.integration}@${patch.version}  ${pc.dim("sig:")} ${patch.signatureHash.slice(0, 12)}…  state=${patch.state}${patch.appliedAt ? pc.dim(` (applied ${patch.appliedAt})`) : ""}\n`,
      );
    }
  }

  return 0;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Import better-sqlite3 dynamically so the CLI survives installs where the
 * native binding failed to build. Most users won't hit this, but it's a
 * cheap resilience win.
 */
async function loadBetterSqlite3(): Promise<
  | null
  | ((path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => {
      prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown };
      close: () => void;
    })
> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
  try {
    const mod = (await dynamicImport("better-sqlite3")) as
      | { default: unknown }
      | Record<string, unknown>;
    const ctor = ((mod as { default?: unknown }).default ?? mod) as typeof loadBetterSqlite3 extends never
      ? never
      : (path: string, opts?: unknown) => unknown;
    return ctor as never;
  } catch {
    return null;
  }
}
