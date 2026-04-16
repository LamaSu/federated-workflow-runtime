import type { FastifyInstance } from "fastify";
import type { DatabaseType } from "../db.js";
import { z } from "zod";

/**
 * GET /api/errors?limit=&integration=
 *
 * Aggregated error signatures. Each row is one stable fingerprint across many
 * occurrences — the "what keeps breaking" dashboard surface.
 *
 * `sampleContext` is parsed from the `components` JSON blob in
 * error_signatures — it's already redacted at ingest time (see @delightfulchorus/reporter)
 * so we can safely expose it to UI.
 */

export const ErrorSignatureSummarySchema = z.object({
  hash: z.string(),
  integration: z.string(),
  operation: z.string(),
  errorClass: z.string(),
  httpStatus: z.number().int().nullable(),
  occurrences: z.number().int(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  reported: z.boolean(),
  sampleContext: z.record(z.unknown()),
});

export type ErrorSignatureSummary = z.infer<typeof ErrorSignatureSummarySchema>;

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  integration: z.string().optional(),
});

interface ErrorRow {
  hash: string;
  integration: string;
  operation: string;
  error_class: string;
  http_status: number | null;
  stack_fp: string;
  message_pat: string;
  components: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  reported: number;
}

function rowToSummary(r: ErrorRow): ErrorSignatureSummary {
  let sample: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.components);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      sample = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed components JSON shouldn't break the endpoint; surface empty.
    sample = {};
  }
  // Also surface the message pattern — it's a fingerprint fragment and agents
  // often want to render it as the human label.
  sample.messagePattern = r.message_pat;
  return {
    hash: r.hash,
    integration: r.integration,
    operation: r.operation,
    errorClass: r.error_class,
    httpStatus: r.http_status,
    occurrences: r.occurrences,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    reported: r.reported === 1,
    sampleContext: sample,
  };
}

export function registerErrorsRoutes(app: FastifyInstance, db: DatabaseType): void {
  app.get("/api/errors", async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    const { limit, integration } = parsed.data;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (integration) {
      clauses.push("integration = ?");
      params.push(integration);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM error_signatures ${where} ORDER BY last_seen DESC LIMIT ?`)
      .all(...(params as never[]), limit) as ErrorRow[];
    const errors = rows.map(rowToSummary).map((r) => ErrorSignatureSummarySchema.parse(r));
    return { errors };
  });
}
