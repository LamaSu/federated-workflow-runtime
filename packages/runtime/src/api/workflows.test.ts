import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase, type DatabaseType } from "../db.js";
import { registerApiRoutes } from "./index.js";
import { WorkflowSummarySchema, WorkflowDetailSchema } from "./workflows.js";

function setup() {
  const db = openDatabase(":memory:");
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db);
  return { db, app };
}

function seedWorkflow(
  db: DatabaseType,
  id: string,
  version: number,
  name: string,
  opts: { active?: boolean; updatedAt?: string; nodes?: Array<{ integration: string }> } = {},
) {
  const now = opts.updatedAt ?? "2026-04-14T10:00:00.000Z";
  db.prepare(
    `INSERT OR REPLACE INTO workflows
       (id, version, name, definition, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    version,
    name,
    JSON.stringify({
      id,
      name,
      version,
      trigger: { type: "manual" },
      nodes: opts.nodes ?? [],
      connections: [],
    }),
    opts.active === false ? 0 : 1,
    "2026-04-14T09:00:00.000Z",
    now,
  );
}

describe("GET /api/workflows", () => {
  it("returns [] when no workflows exist", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/workflows" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workflows: [] });
    await app.close();
    db.close();
  });

  it("returns latest version per workflow, newest-updated first", async () => {
    const { db, app } = setup();
    seedWorkflow(db, "wf-a", 1, "A v1", { updatedAt: "2026-04-13T00:00:00.000Z" });
    seedWorkflow(db, "wf-a", 2, "A v2", { updatedAt: "2026-04-14T00:00:00.000Z" });
    seedWorkflow(db, "wf-b", 1, "B only", { updatedAt: "2026-04-12T00:00:00.000Z" });
    const res = await app.inject({ method: "GET", url: "/api/workflows" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workflows: Array<{ id: string; name: string; version: number }> };
    // 2 entries: one per distinct id (latest version only).
    expect(body.workflows).toHaveLength(2);
    expect(body.workflows[0]!.id).toBe("wf-a");
    expect(body.workflows[0]!.version).toBe(2);
    expect(body.workflows[0]!.name).toBe("A v2");
    expect(body.workflows[1]!.id).toBe("wf-b");
    // Zod-validate every row.
    for (const w of body.workflows) {
      expect(() => WorkflowSummarySchema.parse(w)).not.toThrow();
    }
    await app.close();
    db.close();
  });

  it("reports active=false correctly", async () => {
    const { db, app } = setup();
    seedWorkflow(db, "wf-paused", 1, "Paused", { active: false });
    const res = await app.inject({ method: "GET", url: "/api/workflows" });
    const body = res.json() as { workflows: Array<{ active: boolean }> };
    expect(body.workflows[0]!.active).toBe(false);
    await app.close();
    db.close();
  });
});

describe("GET /api/workflows/:id", () => {
  it("returns 404 when unknown", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/workflows/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NOT_FOUND" });
    await app.close();
    db.close();
  });

  it("returns the latest version with its definition", async () => {
    const { db, app } = setup();
    seedWorkflow(db, "wf-c", 1, "C v1", { updatedAt: "2026-04-10T00:00:00.000Z" });
    seedWorkflow(db, "wf-c", 3, "C v3", {
      updatedAt: "2026-04-14T00:00:00.000Z",
      nodes: [{ integration: "http-generic" }, { integration: "slack-send" }],
    });
    const res = await app.inject({ method: "GET", url: "/api/workflows/wf-c" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workflow: unknown };
    const parsed = WorkflowDetailSchema.parse(body.workflow);
    expect(parsed.id).toBe("wf-c");
    expect(parsed.version).toBe(3);
    expect(parsed.name).toBe("C v3");
    expect(parsed.definition).toBeTruthy();
    expect(Array.isArray((parsed.definition as { nodes?: unknown[] })?.nodes)).toBe(true);
    await app.close();
    db.close();
  });
});
