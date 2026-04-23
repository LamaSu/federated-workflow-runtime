import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import { openDatabase, createHelpers } from "./db.js";
import { RunQueue } from "./queue.js";
import { EventDispatcher } from "./triggers/event.js";
import { registerAskRoutes } from "./ask-routes.js";
import {
  buildAskUserDescriptor,
  type AskUserSchema,
} from "./schema-validate.js";

/**
 * Tests for `POST /ask/:runId/:stepName` — the gateway-side webhook that
 * resumes a parked askUser step.
 *
 * Coverage:
 *   - happy path: valid answer → 202 + waiting_steps row resolved
 *   - schema mismatch: 400 with diagnostic, NO event emitted
 *   - 404 when no waiting_steps row
 *   - 410 when the row is already resolved
 *   - 409 when the row exists but is a vanilla waitForEvent (not askUser)
 *   - bare-value body (no {answer:} wrapping) is also accepted
 *   - Zod descriptor — webhook accepts without re-validation (handler does)
 */

function setup() {
  const db = openDatabase(":memory:");
  const q = new RunQueue(db);
  const dispatcher = new EventDispatcher({ queue: q, db });
  const app = Fastify({ logger: false });
  registerAskRoutes(app, db, { dispatcher });
  const helpers = createHelpers(db);
  return { db, q, dispatcher, app, helpers };
}

/**
 * Seed a parked askUser step. Mirrors what the executor's step.askUser
 * would have written when a handler first called it.
 */
function seedAskingStep(args: {
  helpers: ReturnType<typeof createHelpers>;
  q: RunQueue;
  prompt: string;
  schema: AskUserSchema;
  /** Override step name / run id; defaults to readable values. */
  stepName?: string;
  runId?: string;
}): { runId: string; stepName: string } {
  const stepName = args.stepName ?? "ask-size";
  const runId = args.runId ?? args.q.enqueue("wf-ask");
  args.q.claim();
  const descriptor = buildAskUserDescriptor(args.prompt, args.schema);
  const eventType = `chorus.askUser:${runId}:${stepName}`;
  args.helpers.insertWaitingStep({
    id: `ws-${runId}-${stepName}`,
    run_id: runId,
    step_name: stepName,
    event_type: eventType,
    match_payload: JSON.stringify(descriptor),
    match_correlation_id: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    resolved_at: null,
    resolved_event_id: null,
  });
  return { runId, stepName };
}

describe("POST /ask/:runId/:stepName — happy path", () => {
  it("accepts a valid JSON-schema answer and resolves the waiting_steps row", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Pick a size",
      schema: { type: "string", enum: ["S", "M", "L"] },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: "M" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      ok: boolean;
      runId: string;
      stepName: string;
      eventId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.runId).toBe(runId);
    expect(body.stepName).toBe(stepName);
    expect(body.eventId.length).toBeGreaterThan(0);

    // Waiting step is now resolved.
    const w = helpers.getWaitingStep(runId, stepName);
    expect(w?.resolved_at).not.toBeNull();
    expect(w?.resolved_event_id).toBe(body.eventId);

    // The synthetic event was persisted with payload {answer: "M"}.
    const ev = db
      .prepare(`SELECT * FROM events WHERE id = ?`)
      .get(body.eventId) as { type: string; payload: string } | undefined;
    expect(ev?.type).toBe(`chorus.askUser:${runId}:${stepName}`);
    expect(JSON.parse(ev!.payload)).toEqual({ answer: "M" });

    await app.close();
    db.close();
  });

  it("accepts a bare value (no {answer:} wrapper) and treats the whole body as the answer", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Number?",
      schema: { type: "integer", minimum: 1, maximum: 10 },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: 5,
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(202);
    const ev = db
      .prepare(
        `SELECT payload FROM events WHERE type = ?`,
      )
      .get(`chorus.askUser:${runId}:${stepName}`) as { payload: string };
    expect(JSON.parse(ev.payload)).toEqual({ answer: 5 });

    await app.close();
    db.close();
  });

  it("accepts complex object answers when the schema allows", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Address?",
      schema: {
        type: "object",
        required: ["city", "zip"],
        properties: {
          city: { type: "string", minLength: 1 },
          zip: { type: "string", pattern: "^\\d{5}$" },
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: { city: "SF", zip: "94110" } },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
    db.close();
  });
});

describe("POST /ask/:runId/:stepName — schema mismatch", () => {
  it("rejects an answer that fails JSON-schema enum validation with 400", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Pick a size",
      schema: { type: "string", enum: ["S", "M", "L"] },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: "XXL" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      message: string;
      errors: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.message).toMatch(/enum/i);
    expect(body.errors.length).toBeGreaterThan(0);

    // Critically: the waiting step is still NOT resolved.
    const w = helpers.getWaitingStep(runId, stepName);
    expect(w?.resolved_at).toBeNull();

    // And no event was emitted.
    const evCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM events WHERE type = ?`,
      )
      .get(`chorus.askUser:${runId}:${stepName}`) as { c: number };
    expect(evCount.c).toBe(0);

    await app.close();
    db.close();
  });

  it("rejects type-mismatched answers", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Number please",
      schema: { type: "integer" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { errors: Array<{ message: string }> };
    expect(body.errors.some((e) => /integer/i.test(e.message))).toBe(true);

    await app.close();
    db.close();
  });

  it("rejects missing required object fields with path-prefixed errors", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Address",
      schema: {
        type: "object",
        required: ["city", "zip"],
        properties: { city: { type: "string" }, zip: { type: "string" } },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: { city: "SF" } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { errors: Array<{ path: string }> };
    expect(body.errors.some((e) => e.path === "zip")).toBe(true);

    await app.close();
    db.close();
  });
});

describe("POST /ask/:runId/:stepName — error paths", () => {
  it("returns 404 when no waiting step exists for the (runId, stepName)", async () => {
    const { db, app } = setup();
    const res = await app.inject({
      method: "POST",
      url: `/ask/never-existed/no-such-step`,
      payload: { answer: "x" },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
    await app.close();
    db.close();
  });

  it("returns 410 when the waiting step has already been resolved", async () => {
    const { db, app, q, helpers } = setup();
    const { runId, stepName } = seedAskingStep({
      helpers,
      q,
      prompt: "Q",
      schema: { type: "string" },
    });
    // Pre-resolve the row.
    helpers.resolveWaitingStep(runId, stepName, "ev-prior", "2026-04-15T00:00:00.000Z");

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: "x" },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: string };
    expect(body.error).toBe("ALREADY_RESOLVED");
    await app.close();
    db.close();
  });

  it("returns 409 when the row exists but isn't an askUser step (vanilla waitForEvent)", async () => {
    const { db, app, q, helpers } = setup();
    const runId = q.enqueue("wf-w");
    q.claim();
    helpers.insertWaitingStep({
      id: "ws-vanilla",
      run_id: runId,
      step_name: "wait-stripe",
      event_type: "stripe.3ds.completed",
      match_payload: JSON.stringify({ sessionId: "cs_1" }),
      match_correlation_id: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/wait-stripe`,
      payload: { answer: "x" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe("NOT_AN_ASK_USER");
    await app.close();
    db.close();
  });

  it("returns 500 (defensive) when emit returns no resolved rows", async () => {
    // Construct a setup where the dispatcher's emit cannot match the row.
    // Hardest way: pre-resolve the row between the lookup and emit. We
    // simulate this by stubbing the dispatcher to emit but not resolve.
    const { db, app, q } = setup();
    const helpers = createHelpers(db);
    const stubDispatcher: EventDispatcher = {
      emit: () => ({
        event: {
          id: "ev-stub",
          type: "chorus.askUser:r/s",
          payload: "{}",
          source: null,
          emitted_at: "2026-04-15T00:00:00.000Z",
          correlation_id: null,
          consumed_by_run: null,
        },
        triggeredRunIds: [],
        resolvedWaitingSteps: [],
      }),
    } as unknown as EventDispatcher;

    const stubApp = Fastify({ logger: false });
    registerAskRoutes(stubApp, db, { dispatcher: stubDispatcher });

    const runId = q.enqueue("wf-stub");
    q.claim();
    const stepName = "ask-stub";
    helpers.insertWaitingStep({
      id: "ws-stub",
      run_id: runId,
      step_name: stepName,
      event_type: `chorus.askUser:${runId}:${stepName}`,
      match_payload: JSON.stringify(
        buildAskUserDescriptor("Q", { type: "string" }),
      ),
      match_correlation_id: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });

    const res = await stubApp.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: "ok" },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string };
    expect(body.error).toBe("INTERNAL");

    await stubApp.close();
    await app.close();
    db.close();
  });
});

describe("POST /ask/:runId/:stepName — Zod descriptor", () => {
  it("accepts inbound answer without re-validation (handler does it)", async () => {
    // Zod schemas can't be JSON-serialized; the descriptor stores
    // {kind: "zod-runtime"}. The webhook accepts the answer as-is and
    // hands off to the executor's replay, where the handler's Zod schema
    // re-validates. (If invalid, the handler will throw; the run goes to
    // failed; the parked step's *answer* is still durably persisted as
    // the event payload, so re-running with a fixed schema would still
    // see it.)
    const { db, app, q, helpers } = setup();
    const stepName = "ask-zod";
    const runId = q.enqueue("wf-z");
    q.claim();
    const zodSchema = z.object({ size: z.enum(["S", "M", "L"]) });
    const descriptor = buildAskUserDescriptor("Pick", zodSchema);
    expect(descriptor.schema.kind).toBe("zod-runtime");
    helpers.insertWaitingStep({
      id: "ws-z",
      run_id: runId,
      step_name: stepName,
      event_type: `chorus.askUser:${runId}:${stepName}`,
      match_payload: JSON.stringify(descriptor),
      match_correlation_id: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });

    // Even an answer that wouldn't pass the Zod schema is accepted at the
    // webhook tier — the gateway intentionally doesn't have the schema.
    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/${stepName}`,
      payload: { answer: { size: "WHATEVER" } },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
    db.close();
  });
});
