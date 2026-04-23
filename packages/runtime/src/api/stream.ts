import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabaseType, StepRow } from "../db.js";
import {
  STREAM_MODES,
  type StreamBus,
  type StreamEvent,
  type StreamMode,
} from "../stream-bus.js";

/**
 * GET /api/run/:runId/stream?mode=values|updates|messages|tasks[,...]
 *
 * Server-Sent Events endpoint for the Wave 4 streaming protocol.
 *
 * Wire format: standard SSE per the WHATWG spec —
 *   data: <single line of JSON>\n
 *   \n
 *
 * Each frame is one StreamEvent object as JSON. Frames carry no event
 * name (no `event:` line) because the consumer can read `mode` from the
 * data; this keeps the wire compatible with stock browser EventSource
 * AND with naive tail readers like `curl -N`.
 *
 * Supported modes (comma-separated):
 *   values    — current step row state on each write
 *   updates   — alias of values plus an initial backfill of existing rows
 *               so a late connector catches up to where the run is
 *   messages  — handler-emitted token chunks via ctx.stream.write
 *   tasks     — step:start / step:end lifecycle events
 *
 * Mounting requires a StreamBus instance. The server.ts wiring constructs
 * one bus per process and passes it both into the executor (publisher)
 * and into this endpoint (subscriber). When no bus is wired, the route
 * is not mounted; clients get a 404.
 *
 * Lifecycle:
 *   - Client connects → SSE headers sent, subscriber registered, optional
 *     backfill flushed (for `updates` mode only).
 *   - Each StreamEvent → frame written to the response stream.
 *   - Client disconnects (close, abort) → subscriber unregistered, response
 *     ended.
 *   - Optional heartbeat: every 15s a `:keepalive\n\n` comment line keeps
 *     intermediate proxies from idle-closing the connection. Counters use
 *     a one-line comment per the SSE spec — clients ignore comments.
 *
 * Why we don't use Fastify's built-in async-iterable response: the SSE
 * frame format is simple enough to write by hand, and using `reply.raw`
 * gives us deterministic flushing semantics and `unsubscribe` on close.
 */

// 15s — stays well below most HTTP idle timeouts (60s is the common floor)
// while not flooding the wire.
export const STREAM_HEARTBEAT_MS = 15_000;

const QuerySchema = z.object({
  mode: z
    .string()
    .optional()
    .superRefine((s, ctx) => {
      if (!s) return;
      const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (!STREAM_MODES.includes(p as StreamMode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown stream mode "${p}"; valid: ${STREAM_MODES.join(", ")}`,
          });
        }
      }
    })
    .transform((s) => {
      if (!s) return ["values"] as StreamMode[];
      // CSV: split, trim, dedupe. Validation happened in superRefine.
      const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
      const seen = new Set<StreamMode>();
      for (const p of parts) seen.add(p as StreamMode);
      return Array.from(seen);
    }),
});

export interface RegisterStreamRoutesOptions {
  /**
   * The shared in-process bus. Required — without it the runtime has no
   * way to receive events from the executor.
   */
  bus: StreamBus;
  /**
   * Heartbeat interval override (tests). Default 15s.
   */
  heartbeatMs?: number;
}

/**
 * Mount GET /api/run/:runId/stream. Idempotent: callers should only
 * invoke once per Fastify instance.
 */
export function registerStreamRoutes(
  app: FastifyInstance,
  db: DatabaseType,
  opts: RegisterStreamRoutesOptions,
): void {
  const bus = opts.bus;
  const heartbeatMs = opts.heartbeatMs ?? STREAM_HEARTBEAT_MS;

  app.get<{ Params: { runId: string } }>(
    "/api/run/:runId/stream",
    async (req, reply) => {
      const parsed = QuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "BAD_REQUEST", message: parsed.error.message };
      }
      const modes = parsed.data.mode;
      const runId = req.params.runId;

      // Verify the run exists. Otherwise we'd be opening a long-lived
      // connection to a phantom — better to fail fast.
      const runRow = db
        .prepare("SELECT id FROM runs WHERE id = ?")
        .get(runId) as { id: string } | undefined;
      if (!runRow) {
        reply.code(404);
        return { error: "NOT_FOUND", message: `unknown run: ${runId}` };
      }

      // Take ownership of the response stream — Fastify's auto-serializer
      // would JSON-stringify our return value, so we hijack here.
      reply.hijack();
      const raw = reply.raw;
      raw.setHeader("Content-Type", "text/event-stream");
      raw.setHeader("Cache-Control", "no-cache, no-transform");
      raw.setHeader("Connection", "keep-alive");
      raw.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering
      raw.flushHeaders();

      // For `updates` mode, backfill the steps table so a late connector
      // catches up. We do this AFTER setting up the subscription so we
      // don't miss any concurrent writes (subscriber sees fresh rows;
      // backfill provides the historical baseline). Order matters:
      // subscribe first, snapshot rows, replay snapshot, then live events
      // continue arriving on the same subscriber.
      const wantsUpdates = modes.includes("updates");

      // Frame writer. SSE frame = "data: <json>\n\n". Newlines INSIDE the
      // JSON are not allowed by the SSE spec (they'd start a new field),
      // but JSON.stringify never emits raw newlines so we're safe.
      const writeEvent = (e: StreamEvent): void => {
        try {
          raw.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch {
          // Client disconnected mid-write — bail; the close handler will
          // unsubscribe shortly.
        }
      };

      // Subscribe to live events.
      const unsubscribe = bus.subscribe(runId, writeEvent, { modes });

      // Backfill for updates mode. We synthesize values events from the
      // current rows so a fresh consumer sees the baseline state without
      // needing a separate API call.
      if (wantsUpdates) {
        try {
          const rows = db
            .prepare(
              `SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC NULLS LAST, step_name ASC`,
            )
            .all(runId) as StepRow[];
          for (const r of rows) {
            writeEvent({
              mode: "updates",
              runId,
              step: {
                stepName: r.step_name,
                status: r.status,
                attempt: r.attempt,
                output: r.output ? safeParseJson(r.output) : null,
                error: r.error,
                durationMs: r.duration_ms,
                startedAt: r.started_at,
                finishedAt: r.finished_at,
              },
              ts: Date.now(),
            });
          }
        } catch {
          // Backfill is best-effort; if SQLite errors here, fall through
          // to live events.
        }
      }

      // Heartbeat — keeps proxies from idle-closing.
      const heartbeat = setInterval(() => {
        try {
          raw.write(`:keepalive\n\n`);
        } catch {
          // ignore — close handler will tidy up
        }
      }, heartbeatMs);

      // Tear down on close. Both ends matter:
      //   - "close" fires when the client TCP-closes (browser tab close,
      //     curl ^C, etc.)
      //   - request.raw "aborted" covers HTTP/2 RST and similar.
      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      raw.on("close", cleanup);
      raw.on("error", cleanup);
      req.raw.on("aborted", cleanup);
    },
  );
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
