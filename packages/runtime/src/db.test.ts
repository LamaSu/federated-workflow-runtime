import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  SCHEMA_VERSION,
  createHelpers,
  openDatabase,
  runMigrations,
  type CredentialRow,
  type EventRow,
  type OAuthPendingRow,
  type RunRow,
  type StepRow,
  type WaitingStepRow,
  type WorkflowRow,
} from "./db.js";

function newMemDb(): ReturnType<typeof openDatabase> {
  return openDatabase(":memory:");
}

describe("openDatabase / runMigrations", () => {
  it("creates all expected tables on a fresh db", () => {
    const db = newMemDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);

    for (const expected of [
      "cassettes",
      "credentials",
      "error_signatures",
      "events",
      "memory",
      "oauth_pending",
      "patches",
      "runs",
      "schema_meta",
      "steps",
      "triggers",
      "waiting_steps",
      "workflows",
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it("is idempotent — running migrations twice is a no-op", () => {
    const db = newMemDb();
    // Second call should not throw.
    expect(() => runMigrations(db)).not.toThrow();
    const ver = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(ver.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("records schema version in schema_meta", () => {
    const db = newMemDb();
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe("1");
    db.close();
  });

  it("enables foreign keys", () => {
    const db = newMemDb();
    const fkResult = db.pragma("foreign_keys", { simple: true });
    expect(fkResult).toBe(1);
    db.close();
  });

  it("runs against an externally-constructed Database instance", () => {
    const raw = new Database(":memory:");
    runMigrations(raw);
    const tables = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("runs");
    raw.close();
  });
});

describe("QueryHelpers", () => {
  it("inserts + fetches workflows; version filter works", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const wf: WorkflowRow = {
      id: "wf-1",
      version: 1,
      name: "Test",
      definition: JSON.stringify({ nodes: [] }),
      active: 1,
      created_at: "2026-04-13T00:00:00Z",
      updated_at: "2026-04-13T00:00:00Z",
    };
    h.insertWorkflow(wf);
    h.insertWorkflow({ ...wf, version: 2, name: "Test v2" });

    const latest = h.getWorkflow("wf-1");
    expect(latest?.version).toBe(2);

    const v1 = h.getWorkflow("wf-1", 1);
    expect(v1?.name).toBe("Test");
    db.close();
  });

  it("inserts + fetches runs", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const run: RunRow = {
      id: "run-1",
      workflow_id: "wf-1",
      workflow_version: 1,
      status: "pending",
      triggered_by: "manual",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: "2026-04-13T00:00:00Z",
      finished_at: null,
      error: null,
      attempt: 1,
    };
    h.insertRun(run);
    const fetched = h.getRun("run-1");
    expect(fetched?.status).toBe("pending");
    h.updateRunStatus("run-1", "success", { finished_at: "2026-04-13T00:01:00Z" });
    const done = h.getRun("run-1");
    expect(done?.status).toBe("success");
    expect(done?.finished_at).toBe("2026-04-13T00:01:00Z");
    db.close();
  });

  it("upserts steps — second call replaces fields", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    // Need a parent run because of FK cascade (but FK is optional here).
    h.insertRun({
      id: "run-2",
      workflow_id: "wf-1",
      workflow_version: 1,
      status: "running",
      triggered_by: "manual",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: "2026-04-13T00:00:00Z",
      finished_at: null,
      error: null,
      attempt: 1,
    });
    const step: StepRow = {
      run_id: "run-2",
      step_name: "fetch",
      attempt: 1,
      status: "running",
      input: JSON.stringify({}),
      output: null,
      error: null,
      error_sig_hash: null,
      started_at: "2026-04-13T00:00:00Z",
      finished_at: null,
      duration_ms: null,
    };
    h.upsertStep(step);
    h.upsertStep({
      ...step,
      status: "success",
      output: JSON.stringify({ ok: true }),
      finished_at: "2026-04-13T00:00:01Z",
      duration_ms: 1000,
    });
    const done = h.getCompletedStep("run-2", "fetch");
    expect(done?.status).toBe("success");
    expect(done?.output).toBe(JSON.stringify({ ok: true }));
    db.close();
  });

  it("lists expiring oauth credentials only", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const base: Omit<CredentialRow, "id" | "integration" | "type" | "name" | "oauth_access_expires"> = {
      credential_type_name: "",
      encrypted_payload: Buffer.from([0, 1, 2]),
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: "2026-04-13T00:00:00Z",
      updated_at: "2026-04-13T00:00:00Z",
    };
    h.insertCredential({
      ...base,
      id: "c-expiring",
      integration: "slack",
      type: "oauth2",
      name: "main",
      oauth_access_expires: "2026-04-13T00:05:00Z",
    });
    h.insertCredential({
      ...base,
      id: "c-valid",
      integration: "slack",
      type: "oauth2",
      name: "other",
      oauth_access_expires: "2026-05-13T00:00:00Z",
    });
    h.insertCredential({
      ...base,
      id: "c-apikey",
      integration: "stripe",
      type: "apiKey",
      name: "prod",
      oauth_access_expires: null,
    });
    const expiring = h.listExpiringOAuthCredentials("2026-04-13T00:10:00Z");
    expect(expiring.map((c) => c.id)).toEqual(["c-expiring"]);
    db.close();
  });

  it("marks credential invalid", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertCredential({
      id: "c-1",
      integration: "slack",
      type: "oauth2",
      name: "main",
      credential_type_name: "",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: "2026-05-13T00:00:00Z",
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: "2026-04-13T00:00:00Z",
      updated_at: "2026-04-13T00:00:00Z",
    });
    h.markCredentialInvalid("c-1", "refresh failed", "2026-04-13T00:01:00Z");
    const after = h.getCredential("c-1");
    expect(after?.state).toBe("invalid");
    expect(after?.last_error).toBe("refresh failed");
    db.close();
  });
});

describe("QueryHelpers — events bus", () => {
  it("inserts + fetches an event", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const ev: EventRow = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "order.paid",
      payload: JSON.stringify({ amount: 100 }),
      source: "test",
      emitted_at: "2026-04-15T00:00:00.000Z",
      correlation_id: "corr-1",
      consumed_by_run: null,
    };
    h.insertEvent(ev);
    const fetched = h.getEvent(ev.id);
    expect(fetched?.type).toBe("order.paid");
    expect(fetched?.consumed_by_run).toBeNull();
    db.close();
  });

  it("lists unconsumed events by type, ignoring consumed ones", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const mkEv = (id: string, type: string, consumed: string | null): EventRow => ({
      id,
      type,
      payload: "{}",
      source: null,
      emitted_at: `2026-04-15T00:00:0${id.slice(-1)}.000Z`,
      correlation_id: null,
      consumed_by_run: consumed,
    });
    h.insertEvent(mkEv("11111111-1111-4111-8111-111111111111", "x", null));
    h.insertEvent(mkEv("22222222-2222-4222-8222-222222222222", "x", "run-consumed"));
    h.insertEvent(mkEv("33333333-3333-4333-8333-333333333333", "y", null));

    const xs = h.listUnconsumedEventsByType("x");
    expect(xs.map((r) => r.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
    db.close();
  });

  it("marks an event consumed only once (idempotent)", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertEvent({
      id: "11111111-1111-4111-8111-111111111111",
      type: "x",
      payload: "{}",
      source: null,
      emitted_at: "2026-04-15T00:00:00.000Z",
      correlation_id: null,
      consumed_by_run: null,
    });
    h.markEventConsumed("11111111-1111-4111-8111-111111111111", "run-a");
    const first = h.getEvent("11111111-1111-4111-8111-111111111111");
    expect(first?.consumed_by_run).toBe("run-a");
    // Second call should NOT overwrite the first run-id.
    h.markEventConsumed("11111111-1111-4111-8111-111111111111", "run-b");
    const second = h.getEvent("11111111-1111-4111-8111-111111111111");
    expect(second?.consumed_by_run).toBe("run-a");
    db.close();
  });

  it("lists recent events, newest first", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertEvent({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      type: "a",
      payload: "{}",
      source: null,
      emitted_at: "2026-04-15T00:00:01.000Z",
      correlation_id: null,
      consumed_by_run: null,
    });
    h.insertEvent({
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      type: "b",
      payload: "{}",
      source: null,
      emitted_at: "2026-04-15T00:00:02.000Z",
      correlation_id: null,
      consumed_by_run: null,
    });
    const recent = h.listRecentEvents();
    expect(recent.map((r) => r.id)).toEqual([
      "bbbbbbbb-2222-4222-8222-222222222222",
      "aaaaaaaa-1111-4111-8111-111111111111",
    ]);
    const onlyA = h.listRecentEvents("a");
    expect(onlyA.map((r) => r.id)).toEqual(["aaaaaaaa-1111-4111-8111-111111111111"]);
    db.close();
  });
});

describe("QueryHelpers — waiting_steps", () => {
  function seedRun(db: ReturnType<typeof openDatabase>, runId: string): void {
    const h = createHelpers(db);
    h.insertRun({
      id: runId,
      workflow_id: "wf-e",
      workflow_version: 1,
      status: "running",
      triggered_by: "manual",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: "2026-04-15T00:00:00.000Z",
      finished_at: null,
      error: null,
      attempt: 1,
    });
  }

  it("inserts + fetches a waiting step", () => {
    const db = newMemDb();
    seedRun(db, "run-w");
    const h = createHelpers(db);
    const w: WaitingStepRow = {
      id: "ws-1",
      run_id: "run-w",
      step_name: "wait-for-stripe",
      event_type: "stripe.3ds.completed",
      match_payload: null,
      match_correlation_id: "sess-1",
      expires_at: "2026-04-15T00:01:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    };
    h.insertWaitingStep(w);
    const got = h.getWaitingStep("run-w", "wait-for-stripe");
    expect(got?.event_type).toBe("stripe.3ds.completed");
    expect(got?.resolved_at).toBeNull();
    db.close();
  });

  it("lists unresolved steps by event type", () => {
    const db = newMemDb();
    seedRun(db, "run-a");
    seedRun(db, "run-b");
    const h = createHelpers(db);
    h.insertWaitingStep({
      id: "w1",
      run_id: "run-a",
      step_name: "s1",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:01:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    h.insertWaitingStep({
      id: "w2",
      run_id: "run-b",
      step_name: "s2",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:01:00.000Z",
      resolved_at: "2026-04-15T00:00:30.000Z",
      resolved_event_id: "ev-1",
    });
    const pending = h.listUnresolvedWaitingSteps("x");
    expect(pending.map((r) => r.run_id)).toEqual(["run-a"]);
    db.close();
  });

  it("surfaces expired waiting steps once a time has passed", () => {
    const db = newMemDb();
    seedRun(db, "run-t");
    const h = createHelpers(db);
    h.insertWaitingStep({
      id: "ws-t",
      run_id: "run-t",
      step_name: "s-exp",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:00:30.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    const before = h.listExpiredWaitingSteps("2026-04-15T00:00:00.000Z");
    expect(before).toHaveLength(0);
    const after = h.listExpiredWaitingSteps("2026-04-15T00:01:00.000Z");
    expect(after.map((r) => r.id)).toEqual(["ws-t"]);
    db.close();
  });

  it("resolveWaitingStep sets resolved_at + event id, once", () => {
    const db = newMemDb();
    seedRun(db, "run-r");
    const h = createHelpers(db);
    h.insertWaitingStep({
      id: "wr",
      run_id: "run-r",
      step_name: "sr",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:01:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    h.resolveWaitingStep("run-r", "sr", "ev-1", "2026-04-15T00:00:30.000Z");
    const got1 = h.getWaitingStep("run-r", "sr");
    expect(got1?.resolved_event_id).toBe("ev-1");
    // Second resolve is a no-op (resolved_at IS NULL guard).
    h.resolveWaitingStep("run-r", "sr", "ev-2", "2026-04-15T00:00:40.000Z");
    const got2 = h.getWaitingStep("run-r", "sr");
    expect(got2?.resolved_event_id).toBe("ev-1");
    db.close();
  });
});

describe("migration", () => {
  it("runs migrations twice, idempotent, when events+waiting_steps already exist", () => {
    const db = newMemDb();
    // Fresh DB; run a second migration pass.
    expect(() => runMigrations(db)).not.toThrow();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("events");
    expect(tables).toContain("waiting_steps");
    db.close();
  });
});

// ── Credential catalog migration (docs/CREDENTIALS_ANALYSIS.md §5.1) ─────────

describe("credential catalog migration", () => {
  it("fresh DB has credential_type_name column and its index", () => {
    const db = newMemDb();
    const cols = db
      .prepare(`PRAGMA table_info(credentials)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("credential_type_name");

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='credentials'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain("idx_credentials_type_name");
    db.close();
  });

  it("ALTER TABLE + backfill for legacy DB (pre-catalog schema)", () => {
    // Simulate a pre-catalog DB: create the credentials table WITHOUT the
    // credential_type_name column, insert a row, then run migrations.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE credentials (
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
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare(
      `INSERT INTO credentials (id, integration, type, name, encrypted_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "c-legacy",
      "slack-send",
      "bearer",
      "default",
      Buffer.from([0, 1]),
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    );
    // Now run the full migration (should ALTER + backfill).
    runMigrations(db as unknown as ReturnType<typeof openDatabase>);

    const cols = db
      .prepare(`PRAGMA table_info(credentials)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("credential_type_name");

    const row = db
      .prepare(`SELECT credential_type_name FROM credentials WHERE id = ?`)
      .get("c-legacy") as { credential_type_name: string };
    expect(row.credential_type_name).toBe("slack-send:legacy");
    db.close();
  });

  it("insertCredential defaults empty credential_type_name to '<integration>:legacy'", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertCredential({
      id: "c-x",
      integration: "slack-send",
      type: "bearer",
      credential_type_name: "", // explicitly empty
      name: "default",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: null,
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: "2026-04-15T00:00:00.000Z",
      updated_at: "2026-04-15T00:00:00.000Z",
    });
    const row = h.getCredential("c-x") as CredentialRow & {
      credential_type_name: string;
    };
    expect(row.credential_type_name).toBe("slack-send:legacy");
    db.close();
  });

  it("insertCredential respects explicit credential_type_name", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertCredential({
      id: "c-y",
      integration: "slack-send",
      type: "oauth2",
      credential_type_name: "slackOAuth2Bot",
      name: "work",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: "2026-05-01T00:00:00.000Z",
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: "2026-04-15T00:00:00.000Z",
      updated_at: "2026-04-15T00:00:00.000Z",
    });
    const row = h.getCredential("c-y") as CredentialRow & {
      credential_type_name: string;
    };
    expect(row.credential_type_name).toBe("slackOAuth2Bot");
    db.close();
  });

  it("listActiveNonOAuthCredentials returns only apiKey/bearer/basic", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const base = {
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: null,
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active" as const,
      last_error: null,
      created_at: "2026-04-15T00:00:00.000Z",
      updated_at: "2026-04-15T00:00:00.000Z",
    };
    h.insertCredential({
      ...base,
      id: "c-pat",
      integration: "github",
      type: "apiKey",
      credential_type_name: "githubPAT",
      name: "personal",
    });
    h.insertCredential({
      ...base,
      id: "c-oauth",
      integration: "slack-send",
      type: "oauth2",
      credential_type_name: "slackOAuth2Bot",
      name: "work",
    });
    h.insertCredential({
      ...base,
      id: "c-bearer",
      integration: "slack-send",
      type: "bearer",
      credential_type_name: "slackUserToken",
      name: "legacy",
    });
    const rows = h.listActiveNonOAuthCredentials();
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["c-bearer", "c-pat"]);
    db.close();
  });

  it("listAllCredentials returns everything ordered", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertCredential({
      id: "c-b",
      integration: "zzz",
      type: "apiKey",
      credential_type_name: "",
      name: "default",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: null,
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: "2026-04-15T00:00:00.000Z",
      updated_at: "2026-04-15T00:00:00.000Z",
    });
    h.insertCredential({
      id: "c-a",
      integration: "aaa",
      type: "apiKey",
      credential_type_name: "",
      name: "default",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: null,
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: "2026-04-15T00:00:00.000Z",
      updated_at: "2026-04-15T00:00:00.000Z",
    });
    const all = h.listAllCredentials();
    expect(all.map((r) => r.integration)).toEqual(["aaa", "zzz"]);
    db.close();
  });
});

// ── OAuth pending (docs/CREDENTIALS_ANALYSIS.md §4.5 + §7 callback) ──────────

describe("QueryHelpers — oauth_pending", () => {
  const makePending = (over: Partial<OAuthPendingRow> = {}): OAuthPendingRow => ({
    state: "state-abc-123",
    integration: "slack-send",
    credential_type_name: "slackOAuth2Bot",
    credential_name: "work",
    redirect_uri: "http://127.0.0.1:3000/api/oauth/callback",
    code_verifier: null,
    created_at: "2026-04-15T00:00:00.000Z",
    expires_at: "2026-04-15T00:05:00.000Z",
    consumed_at: null,
    consumed_error: null,
    credential_id: null,
    ...over,
  });

  it("fresh DB has oauth_pending table and expected indexes", () => {
    const db = newMemDb();
    const cols = db
      .prepare(`PRAGMA table_info(oauth_pending)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "state",
        "integration",
        "credential_type_name",
        "credential_name",
        "redirect_uri",
        "code_verifier",
        "created_at",
        "expires_at",
        "consumed_at",
        "consumed_error",
        "credential_id",
      ]),
    );

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='oauth_pending'`,
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain("idx_oauth_pending_state");
    expect(indexes).toContain("idx_oauth_pending_expires");
    db.close();
  });

  it("inserts + fetches a pending row", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertOAuthPending(makePending());
    const got = h.getOAuthPending("state-abc-123");
    expect(got?.integration).toBe("slack-send");
    expect(got?.credential_type_name).toBe("slackOAuth2Bot");
    expect(got?.consumed_at).toBeNull();
    db.close();
  });

  it("markOAuthPendingConsumed — success path sets credential_id", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertOAuthPending(makePending());
    h.markOAuthPendingConsumed("state-abc-123", "2026-04-15T00:01:00.000Z", {
      credentialId: "cred-new",
    });
    const after = h.getOAuthPending("state-abc-123");
    expect(after?.consumed_at).toBe("2026-04-15T00:01:00.000Z");
    expect(after?.credential_id).toBe("cred-new");
    expect(after?.consumed_error).toBeNull();
    db.close();
  });

  it("markOAuthPendingConsumed — error path sets consumed_error", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertOAuthPending(makePending());
    h.markOAuthPendingConsumed("state-abc-123", "2026-04-15T00:01:00.000Z", {
      error: "token endpoint rejected code",
    });
    const after = h.getOAuthPending("state-abc-123");
    expect(after?.consumed_at).toBe("2026-04-15T00:01:00.000Z");
    expect(after?.consumed_error).toBe("token endpoint rejected code");
    expect(after?.credential_id).toBeNull();
    db.close();
  });

  it("markOAuthPendingConsumed is idempotent — second call is a no-op", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertOAuthPending(makePending());
    h.markOAuthPendingConsumed("state-abc-123", "2026-04-15T00:01:00.000Z", {
      credentialId: "cred-1",
    });
    h.markOAuthPendingConsumed("state-abc-123", "2026-04-15T00:02:00.000Z", {
      credentialId: "cred-2",
    });
    const after = h.getOAuthPending("state-abc-123");
    expect(after?.consumed_at).toBe("2026-04-15T00:01:00.000Z");
    expect(after?.credential_id).toBe("cred-1");
    db.close();
  });

  it("listExpiredOAuthPending returns rows past expires_at, unconsumed only", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertOAuthPending(makePending({ state: "s-expired", expires_at: "2026-04-15T00:00:30.000Z" }));
    h.insertOAuthPending(makePending({ state: "s-future", expires_at: "2026-04-15T01:00:00.000Z" }));
    h.insertOAuthPending(
      makePending({
        state: "s-consumed",
        expires_at: "2026-04-15T00:00:10.000Z",
        consumed_at: "2026-04-15T00:00:20.000Z",
      }),
    );
    const expired = h.listExpiredOAuthPending("2026-04-15T00:01:00.000Z");
    expect(expired.map((r) => r.state)).toEqual(["s-expired"]);
    db.close();
  });

  it("enforces state PRIMARY KEY — duplicate insert throws", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.insertOAuthPending(makePending());
    expect(() => h.insertOAuthPending(makePending())).toThrow();
    db.close();
  });
});

describe("QueryHelpers — memory", () => {
  it("round-trips set/get for a workflow-global key (user_id = null)", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: null,
      key: "counter",
      value_json: JSON.stringify(42),
      updated_at: 1_700_000_000_000,
    });
    const row = h.getMemory("wf-1", null, "counter");
    expect(row).toBeDefined();
    expect(row?.value_json).toBe("42");
    expect(JSON.parse(row!.value_json)).toBe(42);
    db.close();
  });

  it("upsertMemory overwrites an existing row for the same (workflow_id, user_id, key)", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: null,
      key: "counter",
      value_json: "1",
      updated_at: 1_700_000_000_000,
    });
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: null,
      key: "counter",
      value_json: "2",
      updated_at: 1_700_000_000_001,
    });
    const row = h.getMemory("wf-1", null, "counter");
    expect(row?.value_json).toBe("2");
    expect(row?.updated_at).toBe(1_700_000_000_001);

    // Only one row exists (we upserted, not inserted twice).
    const rows = h.listMemory("wf-1");
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("isolates memory by user_id: two users don't see each other's data", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: "user-a",
      key: "theme",
      value_json: JSON.stringify("dark"),
      updated_at: 1,
    });
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: "user-b",
      key: "theme",
      value_json: JSON.stringify("light"),
      updated_at: 2,
    });
    expect(h.getMemory("wf-1", "user-a", "theme")?.value_json).toBe('"dark"');
    expect(h.getMemory("wf-1", "user-b", "theme")?.value_json).toBe('"light"');
    expect(h.listMemory("wf-1", "user-a")).toHaveLength(1);
    expect(h.listMemory("wf-1", "user-b")).toHaveLength(1);
    expect(h.listMemory("wf-1")).toHaveLength(2);
    db.close();
  });

  it("isolates memory by workflow_id: two workflows don't share keys", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: null,
      key: "x",
      value_json: "1",
      updated_at: 1,
    });
    h.upsertMemory({
      workflow_id: "wf-2",
      user_id: null,
      key: "x",
      value_json: "99",
      updated_at: 1,
    });
    expect(h.getMemory("wf-1", null, "x")?.value_json).toBe("1");
    expect(h.getMemory("wf-2", null, "x")?.value_json).toBe("99");
    db.close();
  });

  it("getMemory returns undefined for an unset key", () => {
    const db = newMemDb();
    const h = createHelpers(db);
    const row = h.getMemory("wf-1", null, "never-set");
    expect(row).toBeUndefined();
    db.close();
  });

  it("distinguishes null user_id from empty-string user_id — but both are scoped correctly", () => {
    // The COALESCE(user_id, '') in the unique index means a row with
    // user_id=NULL and another with user_id='' would COLLIDE. That's
    // intentional — we don't support '' as a real user identifier.
    const db = newMemDb();
    const h = createHelpers(db);
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: null,
      key: "k",
      value_json: '"null-user"',
      updated_at: 1,
    });
    // Upserting with user_id='' should update the same logical row.
    h.upsertMemory({
      workflow_id: "wf-1",
      user_id: "",
      key: "k",
      value_json: '"empty-user"',
      updated_at: 2,
    });
    expect(h.listMemory("wf-1")).toHaveLength(1);
    // getMemory('wf-1', null, 'k') should find the upserted row.
    const viaNull = h.getMemory("wf-1", null, "k");
    expect(viaNull?.value_json).toBe('"empty-user"');
    db.close();
  });
});
