import type { FastifyInstance } from "fastify";
import type { DatabaseType, RunRow, RunStatus, StepRow } from "../db.js";
import { z } from "zod";

/**
 * GET /api/runs?limit=&status=&workflowId=   — filterable list
 * GET /api/runs/:id                          — detail with per-node results
 */

export const RunSummarySchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowVersion: z.number().int(),
  status: z.enum(["pending", "running", "success", "failed", "cancelled"]),
  triggeredBy: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  attempt: z.number().int(),
});

export const NodeResultSummarySchema = z.object({
  nodeId: z.string(),
  status: z.enum(["pending", "running", "success", "failed"]),
  attempt: z.number().int(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  errorSignatureHash: z.string().nullable(),
  durationMs: z.number().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const RunDetailSchema = RunSummarySchema.extend({
  nodeResults: z.array(NodeResultSummarySchema),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type NodeResultSummary = z.infer<typeof NodeResultSummarySchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: z
    .enum(["pending", "running", "success", "failed", "cancelled"])
    .optional(),
  workflowId: z.string().optional(),
});

function rowToSummary(r: RunRow): RunSummary {
  const duration =
    r.started_at && r.finished_at
      ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
      : null;
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowVersion: r.workflow_version,
    status: r.status as RunStatus,
    triggeredBy: r.triggered_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: duration !== null && Number.isFinite(duration) ? duration : null,
    error: r.error,
    attempt: r.attempt,
  };
}

function stepToNodeResult(s: StepRow): NodeResultSummary {
  let output: unknown = null;
  if (s.output) {
    try {
      output = JSON.parse(s.output);
    } catch {
      output = s.output;
    }
  }
  return {
    nodeId: s.step_name,
    status: s.status,
    attempt: s.attempt,
    output,
    error: s.error,
    errorSignatureHash: s.error_sig_hash,
    durationMs: s.duration_ms,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
  };
}

export function registerRunsRoutes(app: FastifyInstance, db: DatabaseType): void {
  app.get("/api/runs", async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    const { limit, status, workflowId } = parsed.data;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (workflowId) {
      clauses.push("workflow_id = ?");
      params.push(workflowId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM runs ${where}`);
    const rowsStmt = db.prepare(
      `SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ?`,
    );
    const total = (countStmt.get(...(params as never[])) as { c: number }).c;
    const rows = rowsStmt.all(...(params as never[]), limit) as RunRow[];
    const summaries = rows.map(rowToSummary).map((s) => RunSummarySchema.parse(s));
    return { runs: summaries, total };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(req.params.id) as
      | RunRow
      | undefined;
    if (!run) {
      reply.code(404);
      return { error: "NOT_FOUND" };
    }
    const steps = db
      .prepare(
        `SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC NULLS LAST, step_name ASC`,
      )
      .all(req.params.id) as StepRow[];
    const detail = RunDetailSchema.parse({
      ...rowToSummary(run),
      nodeResults: steps.map(stepToNodeResult),
    });
    return { run: detail };
  });
}
