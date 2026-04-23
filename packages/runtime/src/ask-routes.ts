import type { FastifyInstance } from "fastify";
import type { DatabaseType, WaitingStepRow } from "./db.js";
import { QueryHelpers } from "./db.js";
import {
  askUserEventType,
  parseAskUserDescriptor,
  validateAgainstSchema,
  type AskUserDescriptor,
} from "./schema-validate.js";
import type { EventDispatcher } from "./triggers/event.js";

/**
 * `POST /ask/:runId/:stepName` — webhook endpoint for `step.askUser`
 * answers per ROADMAP §6 (HITL primitive).
 *
 * Wire-up (handled by server.ts when `eventDispatcher` is configured):
 *
 *   1. The endpoint looks up the waiting_steps row for (runId, stepName).
 *      404 if not found, 410 if already resolved.
 *   2. It parses the row's match_payload as an AskUserDescriptor. If the
 *      row exists but isn't an askUser descriptor (e.g. a vanilla
 *      waitForEvent row), 409 — the step exists but isn't an ask.
 *   3. Validate the inbound body against the descriptor's schema (Zod or
 *      JSON-schema-lite). On invalid: 400 + diagnostic. On valid:
 *      emit a synthetic `chorus.askUser:<runId>:<stepName>` event whose
 *      payload is `{ answer: <validated value> }`. The dispatcher's
 *      `waitingStepMatches` askUser-aware fast path resolves the row
 *      immediately and re-enqueues the parked run.
 *
 * Why a separate path (`/ask/...`) instead of `/api/events`:
 *   - The user/UI doesn't need to know about events. They POST an answer.
 *   - We don't want to require a bearer token from end users.
 *   - We want a stable URL shape that can be embedded in a "respond here"
 *     link in chat / SMS / email — `runId/stepName` is easy to template.
 *
 * Security: the endpoint is unauthenticated by design (capability-style URL
 * — knowing both runId AND stepName is the auth surface), BUT bind the
 * runtime to 127.0.0.1 in production. For internet-exposed deployments,
 * front this route with reverse-proxy auth or supply `apiToken` and route
 * answers through the gated /api/events POST instead.
 */

/**
 * Schema for the body of `POST /ask/:runId/:stepName`.
 *
 *   { "answer": <any JSON> }
 *
 * Accepts either a wrapped object (`{answer: {...}}`) — the recommended
 * shape — or a bare value posted as the entire body. We unwrap to match
 * the executor side's `result.event.payload.answer` extraction.
 */
function extractAnswer(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "answer" in (body as Record<string, unknown>)
  ) {
    return (body as Record<string, unknown>)["answer"];
  }
  return body;
}

export interface RegisterAskRoutesOptions {
  dispatcher: EventDispatcher;
  /**
   * Override Date.now() for tests. The dispatcher already takes its own
   * `now` — this is purely for diagnostic timestamps in 410 responses.
   */
  now?: () => Date;
}

export function registerAskRoutes(
  app: FastifyInstance,
  db: DatabaseType,
  opts: RegisterAskRoutesOptions,
): void {
  const helpers = new QueryHelpers(db);
  const now = opts.now ?? (() => new Date());

  app.post<{
    Params: { runId: string; stepName: string };
    Body: unknown;
  }>(
    "/ask/:runId/:stepName",
    async (req, reply) => {
      const { runId, stepName } = req.params;

      // 1. Find the waiting_steps row.
      const waiting = helpers.getWaitingStep(runId, stepName) as
        | WaitingStepRow
        | undefined;
      if (!waiting) {
        reply.code(404);
        return {
          error: "NOT_FOUND",
          message: `no waiting step for run=${runId} step=${stepName}`,
        };
      }
      if (waiting.resolved_at) {
        reply.code(410);
        return {
          error: "ALREADY_RESOLVED",
          message: `step already resolved at ${waiting.resolved_at}`,
        };
      }

      // 2. Parse the descriptor.
      const descriptor: AskUserDescriptor | null = parseAskUserDescriptor(
        waiting.match_payload,
      );
      if (!descriptor) {
        reply.code(409);
        return {
          error: "NOT_AN_ASK_USER",
          message: `step exists but is not an askUser interrupt`,
        };
      }

      // 3. Validate inbound answer against the persisted schema.
      //
      // Zod descriptors store only a marker — the original Zod object is
      // not JSON-serializable. The expected shape on the descriptor side
      // is `{kind: "zod-runtime"}`, meaning "the live integration handler
      // owns the schema; here we only do JSON-schema-lite checks (or skip
      // if none)." We accept the answer as-is for zod-runtime descriptors;
      // the handler re-validates on replay (Zod path inside step.askUser).
      const answer = extractAnswer(req.body);
      if (descriptor.schema.kind === "json") {
        const result = validateAgainstSchema(
          descriptor.schema.value,
          answer,
        );
        if (!result.ok) {
          reply.code(400);
          return {
            error: "VALIDATION_FAILED",
            message: result.message,
            errors: result.errors,
          };
        }
      }

      // 4. Emit the synthetic event. The dispatcher inserts the events row,
      //    matches it against the waiting_steps row (askUser-aware fast
      //    path), resolves the row, and re-enqueues the parked run.
      const eventType = askUserEventType(runId, stepName);
      const emit = opts.dispatcher.emit({
        type: eventType,
        payload: { answer },
        // No correlationId — askUser uses event type for routing.
      });

      // Sanity: exactly one waiting step should have been resolved. If
      // zero, something is wrong (race condition with another concurrent
      // POST, or the dispatcher matching is broken). Surface as 500 so
      // a caller doesn't believe the answer was accepted.
      if (emit.resolvedWaitingSteps.length === 0) {
        reply.code(500);
        return {
          error: "INTERNAL",
          message: "event emitted but no waiting step resolved",
          eventId: emit.event.id,
        };
      }

      reply.code(202);
      return {
        ok: true,
        runId,
        stepName,
        eventId: emit.event.id,
        emittedAt: emit.event.emitted_at,
        resolvedAt: now().toISOString(),
      };
    },
  );
}
