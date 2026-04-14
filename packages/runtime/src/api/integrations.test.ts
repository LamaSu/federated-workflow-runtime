import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase, QueryHelpers, type DatabaseType } from "../db.js";
import { registerApiRoutes } from "./index.js";
import { IntegrationSummarySchema } from "./integrations.js";

function setup() {
  const db = openDatabase(":memory:");
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db);
  return { db, app, helpers: new QueryHelpers(db) };
}

function seedWorkflow(
  db: DatabaseType,
  id: string,
  integrations: string[],
  opts: { updatedAt?: string } = {},
) {
  const now = opts.updatedAt ?? "2026-04-14T00:00:00.000Z";
  db.prepare(
    `INSERT OR REPLACE INTO workflows
       (id, version, name, definition, active, created_at, updated_at)
     VALUES (?, 1, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    id,
    JSON.stringify({
      id,
      name: id,
      version: 1,
      trigger: { type: "manual" },
      nodes: integrations.map((i) => ({ id: `${i}-n`, integration: i, operation: "op" })),
      connections: [],
    }),
    now,
    now,
  );
}

function seedRun(h: QueryHelpers, id: string, workflowId: string, finishedAt: string) {
  h.insertRun({
    id,
    workflow_id: workflowId,
    workflow_version: 1,
    status: "success",
    triggered_by: "manual",
    trigger_payload: null,
    priority: 0,
    next_wakeup: null,
    visibility_until: null,
    started_at: finishedAt,
    finished_at: finishedAt,
    error: null,
    attempt: 1,
  });
}

function seedError(db: DatabaseType, integration: string, occurrences: number) {
  db.prepare(
    `INSERT INTO error_signatures
       (hash, integration, operation, error_class, http_status, stack_fp, message_pat,
        components, first_seen, last_seen, occurrences, reported)
     VALUES (?, ?, 'op', 'ERR', 500, 'fp', 'msg', '{}', '2026-04-13T00:00:00.000Z',
             '2026-04-14T00:00:00.000Z', ?, 0)`,
  ).run(`sig-${integration}`, integration, occurrences);
}

function seedPatch(db: DatabaseType, id: string, integration: string) {
  db.prepare(
    `INSERT INTO patches
       (id, integration, signature_hash, version, state, manifest,
        sigstore_bundle, ed25519_sig, applied_at, rolled_back_at)
     VALUES (?, ?, 'sig', '0.1', 'fleet', '{}', NULL, NULL, NULL, NULL)`,
  ).run(id, integration);
}

describe("GET /api/integrations", () => {
  it("returns [] when nothing installed", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/integrations" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ integrations: [] });
    await app.close();
    db.close();
  });

  it("aggregates integrations across workflows, runs, errors, and patches", async () => {
    const { db, app, helpers } = setup();
    seedWorkflow(db, "wf-1", ["http-generic", "slack-send"]);
    seedRun(helpers, "r1", "wf-1", "2026-04-14T10:00:00.000Z");
    seedRun(helpers, "r2", "wf-1", "2026-04-14T11:00:00.000Z");
    seedError(db, "http-generic", 5);
    seedPatch(db, "p-1", "slack-send");
    const res = await app.inject({ method: "GET", url: "/api/integrations" });
    const body = res.json() as { integrations: Array<{ name: string; runCount: number; errorCount: number; patchCount: number; lastUsedAt: string | null }> };
    const byName = Object.fromEntries(body.integrations.map((i) => [i.name, i]));
    expect(byName["http-generic"]!.runCount).toBe(2);
    expect(byName["http-generic"]!.errorCount).toBe(5);
    expect(byName["http-generic"]!.patchCount).toBe(0);
    expect(byName["slack-send"]!.patchCount).toBe(1);
    expect(byName["slack-send"]!.runCount).toBe(2);
    // Both integrations share the most-recent run; lastUsedAt should be that timestamp.
    expect(byName["http-generic"]!.lastUsedAt).toBe("2026-04-14T11:00:00.000Z");
    for (const i of body.integrations) {
      expect(() => IntegrationSummarySchema.parse(i)).not.toThrow();
    }
    await app.close();
    db.close();
  });

  it("surfaces integrations that appear only via patches or errors (never ran locally)", async () => {
    const { db, app } = setup();
    seedError(db, "only-errors", 7);
    seedPatch(db, "p-orphan", "only-patches");
    const res = await app.inject({ method: "GET", url: "/api/integrations" });
    const body = res.json() as { integrations: Array<{ name: string }> };
    const names = body.integrations.map((i) => i.name);
    expect(names).toContain("only-errors");
    expect(names).toContain("only-patches");
    await app.close();
    db.close();
  });
});
