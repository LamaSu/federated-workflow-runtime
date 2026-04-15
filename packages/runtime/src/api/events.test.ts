import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase, createHelpers } from "../db.js";
import { RunQueue } from "../queue.js";
import { EventDispatcher } from "../triggers/event.js";
import { registerApiRoutes } from "./index.js";
import { POST_EVENT_BODY_LIMIT_BYTES } from "./events.js";

/**
 * API tests for /api/events:
 *   - POST with schema validation + 413 payload-too-large
 *   - GET list + filter
 *   - GET /waiting
 *   - dispatcher routing: event with no listener is not an error
 *   - auth mode (bearer) interaction
 */

function setup(apiToken: string | null = null) {
  const db = openDatabase(":memory:");
  const q = new RunQueue(db);
  const dispatcher = new EventDispatcher({ queue: q, db });
  const app = Fastify({ logger: false, bodyLimit: POST_EVENT_BODY_LIMIT_BYTES + 1000 });
  registerApiRoutes(app, db, { apiToken, eventDispatcher: dispatcher });
  return { db, q, dispatcher, app };
}

describe("POST /api/events", () => {
  it("emits a minimal event → 202 with id + emittedAt", async () => {
    const { db, app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "order.paid" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      id: string;
      type: string;
      emittedAt: string;
      triggeredRunIds: string[];
      resolvedWaitingSteps: number;
    };
    expect(body.id).toMatch(/[0-9a-f-]{8,}/);
    expect(body.type).toBe("order.paid");
    expect(body.triggeredRunIds).toEqual([]);
    expect(body.resolvedWaitingSteps).toBe(0);
    await app.close();
    db.close();
  });

  it("emits an event and enqueues a run for a matching workflow trigger", async () => {
    const { db, q, dispatcher, app } = setup();
    dispatcher.register({
      workflowId: "wf-stripe",
      config: { type: "event", eventType: "stripe.3ds.completed" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        type: "stripe.3ds.completed",
        payload: { sessionId: "cs_1" },
        correlationId: "corr-1",
      },
    });
    expect(res.statusCode).toBe(202);
    expect(q.pendingCount()).toBe(1);
    await app.close();
    db.close();
  });

  it("returns 400 for missing 'type'", async () => {
    const { db, app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { payload: { a: 1 } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it("returns 400 for empty 'type'", async () => {
    const { db, app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it("event with no listeners is still durable — inserts row, no error", async () => {
    const { db, app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "nobody.listens" },
    });
    expect(res.statusCode).toBe(202);
    const row = db
      .prepare("SELECT * FROM events WHERE type = 'nobody.listens'")
      .get();
    expect(row).toBeTruthy();
    await app.close();
    db.close();
  });

  it("rejects payloads over the body limit with 413", async () => {
    // Fastify returns 413 for bodies exceeding app.bodyLimit. Create a new
    // app with a tiny limit to exercise this without huge strings.
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const dispatcher = new EventDispatcher({ queue: q, db });
    const app = Fastify({ logger: false, bodyLimit: 100 });
    registerApiRoutes(app, db, { eventDispatcher: dispatcher });

    const bigPayload = "x".repeat(500);
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "t", payload: { s: bigPayload } },
    });
    expect(res.statusCode).toBe(413);
    await app.close();
    db.close();
  });

  it("rejects unauthenticated requests when bearer auth is on", async () => {
    const { db, app } = setup("secret");
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
    db.close();
  });

  it("accepts authenticated requests when bearer auth is on", async () => {
    const { db, app } = setup("secret");
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "x" },
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
    db.close();
  });
});

describe("GET /api/events", () => {
  it("returns recent events, newest first, bounded by limit", async () => {
    const { db, dispatcher, app } = setup();
    dispatcher.emit({ type: "a" });
    dispatcher.emit({ type: "b" });
    dispatcher.emit({ type: "c" });
    const res = await app.inject({ method: "GET", url: "/api/events" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events).toHaveLength(3);
    // Newest first.
    expect(body.events[0]?.type).toBe("c");
    await app.close();
    db.close();
  });

  it("filters by ?type=", async () => {
    const { db, dispatcher, app } = setup();
    dispatcher.emit({ type: "a" });
    dispatcher.emit({ type: "b" });
    dispatcher.emit({ type: "a" });
    const res = await app.inject({
      method: "GET",
      url: "/api/events?type=a",
    });
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events.every((e) => e.type === "a")).toBe(true);
    expect(body.events).toHaveLength(2);
    await app.close();
    db.close();
  });

  it("enforces limit bounds (1..500)", async () => {
    const { db, app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/events?limit=0",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });
});

describe("GET /api/events/waiting", () => {
  it("lists unresolved waiting steps", async () => {
    const { db, app, q } = setup();
    const h = createHelpers(db);
    const runId = q.enqueue("wf-w");
    q.claim();
    h.insertWaitingStep({
      id: "ws-1",
      run_id: runId,
      step_name: "s",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:01:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/events/waiting",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      waiting: Array<{ runId: string; stepName: string }>;
    };
    expect(body.waiting).toHaveLength(1);
    expect(body.waiting[0]?.runId).toBe(runId);
    expect(body.waiting[0]?.stepName).toBe("s");
    await app.close();
    db.close();
  });

  it("ignores resolved rows", async () => {
    const { db, app, q } = setup();
    const h = createHelpers(db);
    const runId = q.enqueue("wf-w");
    q.claim();
    h.insertWaitingStep({
      id: "ws-r",
      run_id: runId,
      step_name: "s",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:01:00.000Z",
      resolved_at: "2026-04-15T00:00:30.000Z",
      resolved_event_id: "ev-1",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/events/waiting",
    });
    const body = res.json() as { waiting: unknown[] };
    expect(body.waiting).toHaveLength(0);
    await app.close();
    db.close();
  });
});
