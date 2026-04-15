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
  // Pre-flight: handle a legacy `credentials` table (missing the
  // `credential_type_name` column). We must ALTER it BEFORE the main
  // db.exec() runs, because the main CREATE INDEX includes
  // credential_type_name and SQLite would fail mid-exec otherwise.
  // See docs/CREDENTIALS_ANALYSIS.md section 5.1.
  const credentialsTableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='credentials'`,
    )
    .get() as { name?: string } | undefined;
  if (credentialsTableExists?.name) {
    const credentialCols = db
      .prepare<[], { name: string }>(`PRAGMA table_info(credentials)`)
      .all()
      .map((r) => (r as unknown as { name: string }).name);
    if (!credentialCols.includes("credential_type_name")) {
      db.exec(
        `ALTER TABLE credentials ADD COLUMN credential_type_name TEXT NOT NULL DEFAULT ''`,
      );
    }
  }

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
    -- The 'type' column is the auth envelope
    -- (apiKey|oauth2|basic|bearer|none); it stays named 'type' in the DB
    -- for back-compat even though the TS schema renames it to 'authType'.
    -- The 'credential_type_name' column (docs/CREDENTIALS_ANALYSIS.md
    -- section 4.6) links the row to a CredentialTypeDefinition in the
    -- integration manifest. Pre-catalog rows are backfilled to
    -- integration+':legacy' below.
    CREATE TABLE IF NOT EXISTS credentials (
      id                    TEXT PRIMARY KEY,
      integration           TEXT NOT NULL,
      type                  TEXT NOT NULL,
      credential_type_name  TEXT NOT NULL DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_credentials_type_name
      ON credentials(integration, credential_type_name);

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
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL,
      payload           TEXT NOT NULL,         -- JSON
      source            TEXT,
      emitted_at        TEXT NOT NULL,
      correlation_id    TEXT,
      consumed_by_run   TEXT                   -- run id once dispatched (NULL = unconsumed)
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_unconsumed ON events(type, consumed_by_run);
    CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);

    -- Waiting steps (durable parking spots for step.waitForEvent) -------------
    CREATE TABLE IF NOT EXISTS waiting_steps (
      id                      TEXT PRIMARY KEY,
      run_id                  TEXT NOT NULL,
      step_name               TEXT NOT NULL,
      event_type              TEXT NOT NULL,
      match_payload           TEXT,             -- JSON or NULL
      match_correlation_id    TEXT,
      expires_at              TEXT NOT NULL,
      resolved_at             TEXT,             -- NULL = still waiting
      resolved_event_id       TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_waiting_event_type ON waiting_steps(event_type, resolved_at);
    CREATE INDEX IF NOT EXISTS idx_waiting_expires ON waiting_steps(expires_at, resolved_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_waiting_run_step ON waiting_steps(run_id, step_name);
  `);

  // Handle migrations from a pre-existing `events` table (old MVP shape:
  // id/name/payload/created_at). We need to preserve the table if it has
  // rows, but the new columns need to exist. Since the MVP table was a
  // placeholder (never written to) we can safely drop+recreate if the
  // expected columns are missing.
  const eventsCols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(events)`)
    .all()
    .map((r) => (r as unknown as { name: string }).name);
  const hasType = eventsCols.includes("type");
  const hasEmittedAt = eventsCols.includes("emitted_at");
  if (eventsCols.length > 0 && (!hasType || !hasEmittedAt)) {
    // Count rows; if empty we drop-and-recreate, else we abort loudly so a
    // developer notices. Real deployments should run a proper migration.
    const count = db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number };
    if (count.c === 0) {
      db.exec(`
        DROP INDEX IF EXISTS idx_events_name;
        DROP TABLE IF EXISTS events;
        CREATE TABLE events (
          id                TEXT PRIMARY KEY,
          type              TEXT NOT NULL,
          payload           TEXT NOT NULL,
          source            TEXT,
          emitted_at        TEXT NOT NULL,
          correlation_id    TEXT,
          consumed_by_run   TEXT
        );
        CREATE INDEX idx_events_type_unconsumed ON events(type, consumed_by_run);
        CREATE INDEX idx_events_correlation ON events(correlation_id);
      `);
    } else {
      throw new Error(
        "events table exists with legacy schema and non-zero rows — manual migration required",
      );
    }
  }

  // Credential catalog migration (docs/CREDENTIALS_ANALYSIS.md section 5.1).
  // Backfill: any credentials row with an empty credential_type_name
  // becomes integration+':legacy'. The resolver in credential-catalog.ts
  // falls back to authType matching for these rows, so integrations that
  // adopt credentialTypes[] keep working without explicit migration.
  // (The column itself was added in the pre-flight block above for
  // legacy DBs; fresh DBs already have it via the CREATE TABLE.)
  db.prepare(
    `UPDATE credentials
        SET credential_type_name = integration || ':legacy'
      WHERE credential_type_name = ''`,
  ).run();

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
  /** Auth envelope ('apiKey' | 'oauth2' | 'basic' | 'bearer' | 'none'). */
  type: string;
  /**
   * Links the row to a CredentialTypeDefinition in the integration
   * manifest. Pre-catalog rows are backfilled to integration+':legacy'
   * by runMigrations. See docs/CREDENTIALS_ANALYSIS.md section 4.6 + 5.
   */
  credential_type_name: string;
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

// ── Events bus (v1.1 — waitForEvent) ────────────────────────────────────────

export interface EventRow {
  id: string;
  type: string;
  payload: string;           // JSON
  source: string | null;
  emitted_at: string;
  correlation_id: string | null;
  consumed_by_run: string | null;
}

export interface WaitingStepRow {
  id: string;
  run_id: string;
  step_name: string;
  event_type: string;
  match_payload: string | null;       // JSON or NULL
  match_correlation_id: string | null;
  expires_at: string;
  resolved_at: string | null;
  resolved_event_id: string | null;
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
    // Default credential_type_name to integration+':legacy' if omitted
    // by callers that haven't migrated to the catalog yet. Keeps old
    // tests (seedCredential etc.) working without per-test edits.
    const credentialTypeName =
      row.credential_type_name && row.credential_type_name.length > 0
        ? row.credential_type_name
        : `${row.integration}:legacy`;
    this.get(
      `INSERT OR REPLACE INTO credentials
         (id, integration, type, credential_type_name, name, encrypted_payload,
          oauth_access_expires, oauth_refresh_expires, oauth_scopes,
          state, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.integration,
      row.type,
      credentialTypeName,
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

  /**
   * List all active non-OAuth credentials — used by the expiry-alarm
   * cron to emit credential.expiring warnings for PATs / API keys that
   * have no automated refresh path. See expiry-alarm.ts.
   */
  listActiveNonOAuthCredentials(): CredentialRow[] {
    return this.get(
      `SELECT * FROM credentials
         WHERE type != 'oauth2'
           AND state = 'active'`,
    ).all() as CredentialRow[];
  }

  listAllCredentials(): CredentialRow[] {
    return this.get(
      `SELECT * FROM credentials ORDER BY integration, name`,
    ).all() as CredentialRow[];
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

  // Events ------------------------------------------------------------------

  insertEvent(row: EventRow): void {
    this.get(
      `INSERT INTO events (id, type, payload, source, emitted_at, correlation_id, consumed_by_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.type,
      row.payload,
      row.source,
      row.emitted_at,
      row.correlation_id,
      row.consumed_by_run,
    );
  }

  getEvent(id: string): EventRow | undefined {
    return this.get(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow | undefined;
  }

  /**
   * Events of a given type that haven't been consumed yet, oldest first.
   * Used by the dispatch loop to match unconsumed events against waiting
   * steps. We don't mark `consumed_by_run` here — individual events can
   * wake multiple waiting steps (fan-out), so the consumer decides.
   */
  listUnconsumedEventsByType(type: string, limit = 100): EventRow[] {
    return this.get(
      `SELECT * FROM events WHERE type = ? AND consumed_by_run IS NULL
         ORDER BY emitted_at ASC LIMIT ?`,
    ).all(type, limit) as EventRow[];
  }

  markEventConsumed(id: string, runId: string): void {
    this.get(
      `UPDATE events SET consumed_by_run = ? WHERE id = ? AND consumed_by_run IS NULL`,
    ).run(runId, id);
  }

  listRecentEvents(type?: string, limit = 50): EventRow[] {
    if (type) {
      return this.get(
        `SELECT * FROM events WHERE type = ? ORDER BY emitted_at DESC LIMIT ?`,
      ).all(type, limit) as EventRow[];
    }
    return this.get(
      `SELECT * FROM events ORDER BY emitted_at DESC LIMIT ?`,
    ).all(limit) as EventRow[];
  }

  // Waiting steps ------------------------------------------------------------

  insertWaitingStep(row: WaitingStepRow): void {
    this.get(
      `INSERT INTO waiting_steps
         (id, run_id, step_name, event_type, match_payload, match_correlation_id,
          expires_at, resolved_at, resolved_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, step_name) DO UPDATE SET
         event_type           = excluded.event_type,
         match_payload        = excluded.match_payload,
         match_correlation_id = excluded.match_correlation_id,
         expires_at           = excluded.expires_at,
         resolved_at          = excluded.resolved_at,
         resolved_event_id    = excluded.resolved_event_id`,
    ).run(
      row.id,
      row.run_id,
      row.step_name,
      row.event_type,
      row.match_payload,
      row.match_correlation_id,
      row.expires_at,
      row.resolved_at,
      row.resolved_event_id,
    );
  }

  getWaitingStep(runId: string, stepName: string): WaitingStepRow | undefined {
    return this.get(
      `SELECT * FROM waiting_steps WHERE run_id = ? AND step_name = ?`,
    ).get(runId, stepName) as WaitingStepRow | undefined;
  }

  /**
   * Unresolved steps for a given event type. Used by dispatch to find
   * candidates for an incoming event.
   */
  listUnresolvedWaitingSteps(eventType: string): WaitingStepRow[] {
    return this.get(
      `SELECT * FROM waiting_steps WHERE event_type = ? AND resolved_at IS NULL`,
    ).all(eventType) as WaitingStepRow[];
  }

  /**
   * Steps whose expires_at has passed (and are still unresolved). The
   * dispatch loop surfaces these to the executor as timeouts.
   */
  listExpiredWaitingSteps(nowIso: string, limit = 100): WaitingStepRow[] {
    return this.get(
      `SELECT * FROM waiting_steps
         WHERE resolved_at IS NULL
           AND expires_at <= ?
         ORDER BY expires_at ASC
         LIMIT ?`,
    ).all(nowIso, limit) as WaitingStepRow[];
  }

  resolveWaitingStep(
    runId: string,
    stepName: string,
    eventId: string,
    nowIso: string,
  ): void {
    this.get(
      `UPDATE waiting_steps
          SET resolved_at = ?, resolved_event_id = ?
        WHERE run_id = ? AND step_name = ? AND resolved_at IS NULL`,
    ).run(nowIso, eventId, runId, stepName);
  }

  listWaitingSteps(limit = 100): WaitingStepRow[] {
    return this.get(
      `SELECT * FROM waiting_steps
         WHERE resolved_at IS NULL
         ORDER BY expires_at ASC
         LIMIT ?`,
    ).all(limit) as WaitingStepRow[];
  }
}

export function createHelpers(db: DatabaseType): QueryHelpers {
  return new QueryHelpers(db);
}

export type { DatabaseType };
