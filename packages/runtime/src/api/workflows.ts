import type { FastifyInstance } from "fastify";
import type { DatabaseType } from "../db.js";
import { z } from "zod";

/**
 * GET /api/workflows           — list
 * GET /api/workflows/:id       — detail (latest version)
 *
 * Read-only JSON for agent-built dashboards. All reads go through prepared
 * statements on the supplied `db` handle.
 */

export const WorkflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  definition: z.record(z.unknown()).nullable(),
});

export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;

interface WorkflowListRow {
  id: string;
  version: number;
  name: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface WorkflowDetailRow extends WorkflowListRow {
  definition: string;
}

export function registerWorkflowsRoutes(app: FastifyInstance, db: DatabaseType): void {
  // GET /api/workflows — list (newest updated first). One row per id (latest
  // version), in case history gets large in the future.
  app.get("/api/workflows", async () => {
    const rows = db
      .prepare(
        `SELECT w.id, w.version, w.name, w.active, w.created_at, w.updated_at
           FROM workflows w
           JOIN (
             SELECT id, MAX(version) AS v FROM workflows GROUP BY id
           ) latest ON latest.id = w.id AND latest.v = w.version
         ORDER BY w.updated_at DESC`,
      )
      .all() as WorkflowListRow[];
    const workflows: WorkflowSummary[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      active: r.active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    // Validate before sending — catches schema drift in dev.
    const validated = workflows.map((w) => WorkflowSummarySchema.parse(w));
    return { workflows: validated };
  });

  // GET /api/workflows/:id — detail, latest version
  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
    const row = db
      .prepare(
        `SELECT id, version, name, active, definition, created_at, updated_at
           FROM workflows
          WHERE id = ?
          ORDER BY version DESC
          LIMIT 1`,
      )
      .get(req.params.id) as WorkflowDetailRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND" };
    }
    let definition: unknown = null;
    try {
      definition = JSON.parse(row.definition);
    } catch {
      // Definition is expected JSON text; if it ever isn't, we surface the
      // raw string rather than 500.
      definition = row.definition;
    }
    const detail: WorkflowDetail = WorkflowDetailSchema.parse({
      id: row.id,
      name: row.name,
      version: row.version,
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      definition: (typeof definition === "object" && definition !== null
        ? (definition as Record<string, unknown>)
        : null),
    });
    return { workflow: detail };
  });
}
