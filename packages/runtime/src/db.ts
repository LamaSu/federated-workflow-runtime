import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";

/**
 * Runtime SQLite schema per docs/ARCHITECTURE.md §4.5.
 *
 * Tables: workflows, triggers, runs, steps, credentials, error_signatures,
 * cassettes, patches, events.
 *
 * WAL mode + foreign keys enforced. Idempotent migrations (CREATE IF NOT EXISTS).
 */

export const SCHEMA_VERSION = 1;

/**
 * Opens (or creates) a Chorus runtime database at the given path, applies
 * pragmas, runs migrations, and returns the handle.
 *
 * - Pass an absolute file path or `":memory:"` for an ephemeral in-memory DB.
 * - Safe to call against an existing DB — migrations are idempotent.
 */
export function openDatabase(path: string): DatabaseType {
  const db = new Database(path);

  // Pragmas — performance & correctness.
  // WAL is not applicable to in-memory DBs; better-sqlite3 silently ignores,
  // but guard so tests don't emit warnings in environments that do warn.
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);
  return db;
}

/**
 * Applies all schema migrations to the given database. Idempotent.
 */
export function runMigrations(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Workflows (definitions) --------------------------------------------------
    CREATE TABLE IF NOT EXISTS workflows (
      id             TEXT NOT NULL,
      version        INTEGER NOT NULL DEFAULT 1,
      name           TEXT NOT NULL,
      definition     TEXT NOT NULL,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_active ON workflows(active);

    -- Triggers (registered endpoints / schedules) ------------------------------
    CREATE TABLE IF NOT EXISTS triggers (
      id            TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      type          TEXT NOT NULL,
      config        TEXT NOT NULL,
      webhook_path  TEXT UNIQUE,
      cron_expr     TEXT,
      state         TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_workflow ON triggers(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_triggers_type ON triggers(type);

    -- Runs (execution instances) -----------------------------------------------
    CREATE TABLE IF NOT EXISTS runs (
      id               TEXT PRIMARY KEY,
      workflow_id      TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      status           TEXT NOT NULL,
      triggered_by     TEXT NOT NULL,
      trigger_payload  TEXT,
      priority         INTEGER NOT NULL DEFAULT 0,
      next_wakeup      TEXT,
      visibility_until TEXT,
      started_at       TEXT NOT NULL,
      finished_at      TEXT,
      error            TEXT,
      attempt          INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_runs_pending ON runs(status, priority, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_wakeup ON runs(status, next_wakeup);
    CREATE INDEX IF NOT EXISTS idx_runs_visibility ON runs(status, visibility_until);
    CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);

    -- Steps (per-node memoized execution records) ------------------------------
    CREATE TABLE IF NOT EXISTS steps (
      run_id         TEXT NOT NULL,
      step_name      TEXT NOT NULL,
      attempt        INTEGER NOT NULL DEFAULT 1,
      status         TEXT NOT NULL,
      input          TEXT,
      output         TEXT,
      error          TEXT,
      error_sig_hash TEXT,
      started_at     TEXT,
      finished_at    TEXT,
      duration_ms    INTEGER,
      PRIMARY KEY (run_id, step_name),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(run_id, status);

    -- Credentials (AES-256-GCM encrypted) --------------------------------------
    CREATE TABLE IF NOT EXISTS credentials (
      id                    TEXT PRIMARY KEY,
      integration           TEXT NOT NULL,
      type                  TEXT NOT NULL,
      name                  TEXT NOT NULL,
      encrypted_payload     BLOB NOT NULL,
      oauth_access_expires  TEXT,
      oauth_refresh_expires TEXT,
      oauth_scopes          TEXT,
      state                 TEXT NOT NULL DEFAULT 'active',
      last_error            TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      UNIQUE(integration, name)
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_integration ON credentials(integration);
    CREATE INDEX IF NOT EXISTS idx_oauth_expiring
      ON credentials(oauth_access_expires)
      WHERE type='oauth2';

    -- Error signatures (local cache before reporting) -------------------------
    CREATE TABLE IF NOT EXISTS error_signatures (
      hash         TEXT PRIMARY KEY,
      integration  TEXT NOT NULL,
      operation    TEXT NOT NULL,
      error_class  TEXT NOT NULL,
      http_status  INTEGER,
      stack_fp     TEXT NOT NULL,
      message_pat  TEXT NOT NULL,
      components   TEXT NOT NULL,
      first_seen   TEXT NOT NULL,
      last_seen    TEXT NOT NULL,
      occurrences  INTEGER NOT NULL DEFAULT 1,
      reported     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sigs_unreported ON error_signatures(reported, last_seen);

    -- Cassettes (recorded HTTP interactions for validation) -------------------
    CREATE TABLE IF NOT EXISTS cassettes (
      id              TEXT PRIMARY KEY,
      signature_hash  TEXT NOT NULL,
      integration     TEXT NOT NULL,
      payload         TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cassettes_sig ON cassettes(signature_hash);

    -- Patches (locally cached) -------------------------------------------------
    CREATE TABLE IF NOT EXISTS patches (
      id              TEXT PRIMARY KEY,
      integration     TEXT NOT NULL,
      signature_hash  TEXT NOT NULL,
      version         TEXT NOT NULL,
      state           TEXT NOT NULL,
      manifest        TEXT NOT NULL,
      sigstore_bundle BLOB,
      ed25519_sig     BLOB,
      applied_at      TEXT,
      rolled_back_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_patches_sig ON patches(signature_hash);
    CREATE INDEX IF NOT EXISTS idx_patches_applied ON patches(state);

    -- Events (internal bus — v1.1 for waitForEvent) ----------------------------
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);
  `);

  db.prepare(
    "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)",
  ).run(String(SCHEMA_VERSION));
}

// ── Row types (match SQLite schema exactly) ─────────────────────────────────

export type RunStatus = "pending" | "running" | "success" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "success" | "failed";
export type CredentialState = "active" | "invalid" | "expired";

export interface WorkflowRow {
  id: string;
  version: number;
  name: string;
  definition: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface TriggerRow {
  id: string;
  workflow_id: string;
  type: string;
  config: string;
  webhook_path: string | null;
  cron_expr: string | null;
  state: string;
  created_at: string;
}

export interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  triggered_by: string;
  trigger_payload: string | null;
  priority: number;
  next_wakeup: string | null;
  visibility_until: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  attempt: number;
}

export interface StepRow {
  run_id: string;
  step_name: string;
  attempt: number;
  status: StepStatus;
  input: string | null;
  output: string | null;
  error: string | null;
  error_sig_hash: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface CredentialRow {
  id: string;
  integration: string;
  type: string;
  name: string;
  encrypted_payload: Buffer;
  oauth_access_expires: string | null;
  oauth_refresh_expires: string | null;
  oauth_scopes: string | null;
  state: CredentialState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Typed query helpers ─────────────────────────────────────────────────────

/**
 * A small bundle of prepared statements for hot paths. Caches statements on
 * first use for reuse across calls.
 */
export class QueryHelpers {
  private readonly cache = new Map<string, Statement>();

  constructor(public readonly db: DatabaseType) {}

  private get(sql: string): Statement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  // Workflows ----------------------------------------------------------------

  insertWorkflow(row: WorkflowRow): void {
    this.get(
      `INSERT OR REPLACE INTO workflows (id, version, name, definition, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.version,
      row.name,
      row.definition,
      row.active,
      row.created_at,
      row.updated_at,
    );
  }

  getWorkflow(id: string, version?: number): WorkflowRow | undefined {
    if (typeof version === "number") {
      return this.get(
        `SELECT * FROM workflows WHERE id = ? AND version = ?`,
      ).get(id, version) as WorkflowRow | undefined;
    }
    return this.get(
      `SELECT * FROM workflows WHERE id = ? ORDER BY version DESC LIMIT 1`,
    ).get(id) as WorkflowRow | undefined;
  }

  // Runs ---------------------------------------------------------------------

  insertRun(row: RunRow): void {
    this.get(
      `INSERT INTO runs
         (id, workflow_id, workflow_version, status, triggered_by, trigger_payload,
          priority, next_wakeup, visibility_until, started_at, finished_at, error, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.workflow_id,
      row.workflow_version,
      row.status,
      row.triggered_by,
      row.trigger_payload,
      row.priority,
      row.next_wakeup,
      row.visibility_until,
      row.started_at,
      row.finished_at,
      row.error,
      row.attempt,
    );
  }

  getRun(id: string): RunRow | undefined {
    return this.get(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  updateRunStatus(
    id: string,
    status: RunStatus,
    extras: Partial<Pick<RunRow, "finished_at" | "error" | "next_wakeup" | "visibility_until">> = {},
  ): void {
    const sets: string[] = ["status = ?"];
    const params: unknown[] = [status];
    if (extras.finished_at !== undefined) {
      sets.push("finished_at = ?");
      params.push(extras.finished_at);
    }
    if (extras.error !== undefined) {
      sets.push("error = ?");
      params.push(extras.error);
    }
    if (extras.next_wakeup !== undefined) {
      sets.push("next_wakeup = ?");
      params.push(extras.next_wakeup);
    }
    if (extras.visibility_until !== undefined) {
      sets.push("visibility_until = ?");
      params.push(extras.visibility_until);
    }
    params.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...(params as never[]));
  }

  // Steps --------------------------------------------------------------------

  upsertStep(row: StepRow): void {
    this.get(
      `INSERT INTO steps
         (run_id, step_name, attempt, status, input, output, error, error_sig_hash,
          started_at, finished_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, step_name) DO UPDATE SET
         attempt        = excluded.attempt,
         status         = excluded.status,
         input          = excluded.input,
         output         = excluded.output,
         error          = excluded.error,
         error_sig_hash = excluded.error_sig_hash,
         started_at     = excluded.started_at,
         finished_at    = excluded.finished_at,
         duration_ms    = excluded.duration_ms`,
    ).run(
      row.run_id,
      row.step_name,
      row.attempt,
      row.status,
      row.input,
      row.output,
      row.error,
      row.error_sig_hash,
      row.started_at,
      row.finished_at,
      row.duration_ms,
    );
  }

  getStep(runId: string, stepName: string): StepRow | undefined {
    return this.get(
      `SELECT * FROM steps WHERE run_id = ? AND step_name = ?`,
    ).get(runId, stepName) as StepRow | undefined;
  }

  getCompletedStep(runId: string, stepName: string): StepRow | undefined {
    return this.get(
      `SELECT * FROM steps WHERE run_id = ? AND step_name = ? AND status = 'success'`,
    ).get(runId, stepName) as StepRow | undefined;
  }

  listSteps(runId: string): StepRow[] {
    return this.get(
      `SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC NULLS LAST, step_name ASC`,
    ).all(runId) as StepRow[];
  }

  // Credentials --------------------------------------------------------------

  insertCredential(row: CredentialRow): void {
    this.get(
      `INSERT OR REPLACE INTO credentials
         (id, integration, type, name, encrypted_payload,
          oauth_access_expires, oauth_refresh_expires, oauth_scopes,
          state, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.integration,
      row.type,
      row.name,
      row.encrypted_payload,
      row.oauth_access_expires,
      row.oauth_refresh_expires,
      row.oauth_scopes,
      row.state,
      row.last_error,
      row.created_at,
      row.updated_at,
    );
  }

  getCredential(id: string): CredentialRow | undefined {
    return this.get(`SELECT * FROM credentials WHERE id = ?`).get(id) as CredentialRow | undefined;
  }

  getCredentialByName(integration: string, name: string): CredentialRow | undefined {
    return this.get(
      `SELECT * FROM credentials WHERE integration = ? AND name = ?`,
    ).get(integration, name) as CredentialRow | undefined;
  }

  listExpiringOAuthCredentials(beforeIso: string): CredentialRow[] {
    return this.get(
      `SELECT * FROM credentials
         WHERE type = 'oauth2'
           AND state = 'active'
           AND oauth_access_expires IS NOT NULL
           AND oauth_access_expires < ?`,
    ).all(beforeIso) as CredentialRow[];
  }

  markCredentialInvalid(id: string, error: string, nowIso: string): void {
    this.get(
      `UPDATE credentials
          SET state = 'invalid', last_error = ?, updated_at = ?
        WHERE id = ?`,
    ).run(error, nowIso, id);
  }

  updateCredentialPayload(
    id: string,
    encryptedPayload: Buffer,
    oauthAccessExpires: string | null,
    nowIso: string,
  ): void {
    this.get(
      `UPDATE credentials
          SET encrypted_payload = ?, oauth_access_expires = ?, state = 'active',
              last_error = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(encryptedPayload, oauthAccessExpires, nowIso, id);
  }
}

export function createHelpers(db: DatabaseType): QueryHelpers {
  return new QueryHelpers(db);
}

export type { DatabaseType };
