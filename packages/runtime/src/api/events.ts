import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseType, EventRow, WaitingStepRow } from "../db.js";
import type { EventDispatcher } from "../triggers/event.js";

/**
 * Event bus HTTP surface per ROADMAP §6.
 *
 *   POST /api/events                — fire an event (external or internal)
 *   GET  /api/events?type=&limit=   — recent events for debugging / agents
 *   GET  /api/events/waiting        — runs currently parked on waitForEvent
 *
 * The POST path is the only WRITE surface on /api (all other /api/* endpoints
 * are read-only). We're comfortable with this because:
 *   - events are append-only
 *   - the runtime already writes to /hooks/* on webhook fire
 *   - the POST body is validated + payload-size capped
 */

export const POST_EVENT_BODY_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MB per §4.2

const PostEventBodySchema = z.object({
  type: z.string().min(1),
  payload: z.unknown().optional(),
  source: z.string().optional(),
  correlationId: z.string().optional(),
});

const EventSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  source: z.string().nullable(),
  emittedAt: z.string(),
  correlationId: z.string().nullable(),
  consumedByRun: z.string().nullable(),
});

const WaitingStepSummarySchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepName: z.string(),
  eventType: z.string(),
  matchCorrelationId: z.string().nullable(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedEventId: z.string().nullable(),
});

export type EventSummary = z.infer<typeof EventSummarySchema>;
export type WaitingStepSummary = z.infer<typeof WaitingStepSummarySchema>;
export { EventSummarySchema, WaitingStepSummarySchema };

const ListQuerySchema = z.object({
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

function rowToEventSummary(r: EventRow): EventSummary {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = r.payload;
  }
  return {
    id: r.id,
    type: r.type,
    payload,
    source: r.source,
    emittedAt: r.emitted_at,
    correlationId: r.correlation_id,
    consumedByRun: r.consumed_by_run,
  };
}

function rowToWaitingSummary(r: WaitingStepRow): WaitingStepSummary {
  return {
    id: r.id,
    runId: r.run_id,
    stepName: r.step_name,
    eventType: r.event_type,
    matchCorrelationId: r.match_correlation_id,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
    resolvedEventId: r.resolved_event_id,
  };
}

export interface RegisterEventsRoutesOptions {
  dispatcher: EventDispatcher;
  bodyLimitBytes?: number;
}

export function registerEventsRoutes(
  app: FastifyInstance,
  db: DatabaseType,
  opts: RegisterEventsRoutesOptions,
): void {
  // POST /api/events — emit an event. Body limit comes from the calling
  // app (Fastify-wide default: 1MB) unless opts.bodyLimitBytes overrides.
  const routeOptions = opts.bodyLimitBytes !== undefined
    ? { bodyLimit: opts.bodyLimitBytes }
    : {};
  app.post(
    "/api/events",
    routeOptions,
    async (req, reply) => {
      const parsed = PostEventBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "BAD_REQUEST", message: parsed.error.message };
      }
      try {
        const { event, triggeredRunIds, resolvedWaitingSteps } =
          opts.dispatcher.emit({
            type: parsed.data.type,
            payload: parsed.data.payload ?? {},
            source: parsed.data.source,
            correlationId: parsed.data.correlationId,
          });
        reply.code(202);
        return {
          id: event.id,
          type: event.type,
          emittedAt: event.emitted_at,
          triggeredRunIds,
          resolvedWaitingSteps: resolvedWaitingSteps.length,
        };
      } catch (err) {
        reply.code(500);
        return { error: "INTERNAL", message: (err as Error).message };
      }
    },
  );

  // GET /api/events — recent events (optionally filter by type).
  // Order by emitted_at DESC, rowid DESC as a tiebreaker so fast emits in
  // the same millisecond preserve insertion order (newest first).
  app.get("/api/events", async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    const { type, limit } = parsed.data;
    let rows: EventRow[];
    if (type) {
      rows = db
        .prepare(
          `SELECT * FROM events WHERE type = ? ORDER BY emitted_at DESC, rowid DESC LIMIT ?`,
        )
        .all(type, limit) as EventRow[];
    } else {
      rows = db
        .prepare(`SELECT * FROM events ORDER BY emitted_at DESC, rowid DESC LIMIT ?`)
        .all(limit) as EventRow[];
    }
    return {
      events: rows
        .map(rowToEventSummary)
        .map((e) => EventSummarySchema.parse(e)),
    };
  });

  // GET /api/events/waiting — unresolved waiting_steps for dashboards.
  app.get("/api/events/waiting", async () => {
    const rows = db
      .prepare(
        `SELECT * FROM waiting_steps WHERE resolved_at IS NULL ORDER BY expires_at ASC LIMIT 500`,
      )
      .all() as WaitingStepRow[];
    return {
      waiting: rows
        .map(rowToWaitingSummary)
        .map((w) => WaitingStepSummarySchema.parse(w)),
    };
  });
}
