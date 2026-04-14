import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  SCHEMA_VERSION,
  createHelpers,
  openDatabase,
  runMigrations,
  type CredentialRow,
  type RunRow,
  type StepRow,
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
      "patches",
      "runs",
      "schema_meta",
      "steps",
      "triggers",
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
