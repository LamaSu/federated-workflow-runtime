import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase, QueryHelpers, type DatabaseType } from "../db.js";
import { registerApiRoutes } from "./index.js";
import { RunSummarySchema, RunDetailSchema } from "./runs.js";

function setup() {
  const db = openDatabase(":memory:");
  const helpers = new QueryHelpers(db);
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db);
  return { db, helpers, app };
}

function seedRun(
  h: QueryHelpers,
  id: string,
  opts: {
    workflowId?: string;
    status?: "pending" | "running" | "success" | "failed" | "cancelled";
    startedAt?: string;
    finishedAt?: string | null;
    error?: string | null;
  } = {},
) {
  h.insertRun({
    id,
    workflow_id: opts.workflowId ?? "wf-1",
    workflow_version: 1,
    status: opts.status ?? "success",
    triggered_by: "manual",
    trigger_payload: null,
    priority: 0,
    next_wakeup: null,
    visibility_until: null,
    started_at: opts.startedAt ?? "2026-04-14T10:00:00.000Z",
    finished_at: opts.finishedAt ?? "2026-04-14T10:00:05.000Z",
    error: opts.error ?? null,
    attempt: 1,
  });
}

function seedStep(
  h: QueryHelpers,
  runId: string,
  stepName: string,
  opts: { output?: unknown; error?: string | null } = {},
) {
  h.upsertStep({
    run_id: runId,
    step_name: stepName,
    attempt: 1,
    status: "success",
    input: null,
    output: opts.output !== undefined ? JSON.stringify(opts.output) : null,
    error: opts.error ?? null,
    error_sig_hash: null,
    started_at: "2026-04-14T10:00:00.000Z",
    finished_at: "2026-04-14T10:00:02.000Z",
    duration_ms: 2000,
  });
}

describe("GET /api/runs", () => {
  it("returns empty list + total=0 when no runs", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runs: [], total: 0 });
    await app.close();
    db.close();
  });

  it("returns runs newest-first and computes durationMs", async () => {
    const { db, helpers, app } = setup();
    seedRun(helpers, "r-older", { startedAt: "2026-04-13T10:00:00.000Z" });
    seedRun(helpers, "r-newer", { startedAt: "2026-04-14T10:00:00.000Z" });
    const res = await app.inject({ method: "GET", url: "/api/runs" });
    const body = res.json() as { runs: Array<{ id: string; durationMs: number | null }>; total: number };
    expect(body.total).toBe(2);
    expect(body.runs[0]!.id).toBe("r-newer");
    expect(body.runs[0]!.durationMs).toBe(5000);
    // Validate rows.
    for (const r of body.runs) {
      expect(() => RunSummarySchema.parse(r)).not.toThrow();
    }
    await app.close();
    db.close();
  });

  it("filters by status=failed", async () => {
    const { db, helpers, app } = setup();
    seedRun(helpers, "r-ok");
    seedRun(helpers, "r-bad", { status: "failed", error: "boom" });
    const res = await app.inject({ method: "GET", url: "/api/runs?status=failed" });
    const body = res.json() as { runs: Array<{ id: string; status: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]!.id).toBe("r-bad");
    expect(body.runs[0]!.status).toBe("failed");
    await app.close();
    db.close();
  });

  it("filters by workflowId", async () => {
    const { db, helpers, app } = setup();
    seedRun(helpers, "r1", { workflowId: "wf-a" });
    seedRun(helpers, "r2", { workflowId: "wf-b" });
    const res = await app.inject({ method: "GET", url: "/api/runs?workflowId=wf-b" });
    const body = res.json() as { runs: Array<{ id: string; workflowId: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.runs[0]!.workflowId).toBe("wf-b");
    await app.close();
    db.close();
  });

  it("400s on invalid status value", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/runs?status=bogus" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("BAD_REQUEST");
    await app.close();
    db.close();
  });

  it("respects ?limit=N", async () => {
    const { db, helpers, app } = setup();
    for (let i = 0; i < 5; i++) {
      seedRun(helpers, `r-${i}`, { startedAt: `2026-04-14T10:00:0${i}.000Z` });
    }
    const res = await app.inject({ method: "GET", url: "/api/runs?limit=2" });
    const body = res.json() as { runs: unknown[]; total: number };
    expect(body.total).toBe(5);
    expect(body.runs).toHaveLength(2);
    await app.close();
    db.close();
  });
});

describe("GET /api/runs/:id", () => {
  it("returns 404 when unknown", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/runs/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it("returns run with node results", async () => {
    const { db, helpers, app } = setup();
    seedRun(helpers, "r-1");
    seedStep(helpers, "r-1", "step-a", { output: { hello: "world" } });
    seedStep(helpers, "r-1", "step-b", { output: 42 });
    const res = await app.inject({ method: "GET", url: "/api/runs/r-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { run: unknown };
    const parsed = RunDetailSchema.parse(body.run);
    expect(parsed.id).toBe("r-1");
    expect(parsed.nodeResults).toHaveLength(2);
    expect(parsed.nodeResults.map((n) => n.nodeId)).toContain("step-a");
    expect(parsed.nodeResults.find((n) => n.nodeId === "step-a")!.output).toEqual({
      hello: "world",
    });
    await app.close();
    db.close();
  });
});
