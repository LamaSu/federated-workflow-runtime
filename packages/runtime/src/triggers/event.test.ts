import { describe, expect, it } from "vitest";
import { openDatabase, createHelpers } from "../db.js";
import { RunQueue } from "../queue.js";
import { EventDispatcher, eventMatches, TIMEOUT_EVENT_ID } from "./event.js";

function setup() {
  const db = openDatabase(":memory:");
  const q = new RunQueue(db);
  return { db, q };
}

describe("eventMatches — pure matcher", () => {
  it("exact type + no filter → true", () => {
    expect(
      eventMatches({ type: "x", payload: {} }, { eventType: "x" }),
    ).toBe(true);
  });

  it("mismatched type → false", () => {
    expect(
      eventMatches({ type: "x", payload: {} }, { eventType: "y" }),
    ).toBe(false);
  });

  it("filter: shallow key/value equality", () => {
    expect(
      eventMatches(
        { type: "x", payload: { a: 1, b: "hi" } },
        { eventType: "x", filter: { a: 1 } },
      ),
    ).toBe(true);
    expect(
      eventMatches(
        { type: "x", payload: { a: 1, b: "hi" } },
        { eventType: "x", filter: { a: 2 } },
      ),
    ).toBe(false);
  });

  it("filter: missing payload key → false", () => {
    expect(
      eventMatches(
        { type: "x", payload: { a: 1 } },
        { eventType: "x", filter: { missing: 1 } },
      ),
    ).toBe(false);
  });

  it("filter: non-object payload + non-empty filter → false", () => {
    expect(
      eventMatches(
        { type: "x", payload: "string-payload" },
        { eventType: "x", filter: { a: 1 } },
      ),
    ).toBe(false);
  });

  it("filter: undefined value means 'any value, key must exist'", () => {
    expect(
      eventMatches(
        { type: "x", payload: { a: "anything" } },
        { eventType: "x", filter: { a: undefined } },
      ),
    ).toBe(true);
    expect(
      eventMatches(
        { type: "x", payload: {} },
        { eventType: "x", filter: { a: undefined } },
      ),
    ).toBe(false);
  });

  it("filter: nested object compared by JSON equality", () => {
    expect(
      eventMatches(
        { type: "x", payload: { meta: { region: "us" } } },
        { eventType: "x", filter: { meta: { region: "us" } } },
      ),
    ).toBe(true);
    expect(
      eventMatches(
        { type: "x", payload: { meta: { region: "eu" } } },
        { eventType: "x", filter: { meta: { region: "us" } } },
      ),
    ).toBe(false);
  });

  it("correlationId: exact match when set", () => {
    expect(
      eventMatches(
        { type: "x", payload: {}, correlationId: "c1" },
        { eventType: "x", correlationId: "c1" },
      ),
    ).toBe(true);
    expect(
      eventMatches(
        { type: "x", payload: {}, correlationId: "c2" },
        { eventType: "x", correlationId: "c1" },
      ),
    ).toBe(false);
  });
});

describe("EventDispatcher — registration + trigger matching", () => {
  it("registers a trigger, matches incoming events, enqueues runs", () => {
    const { db, q } = setup();
    const dispatcher = new EventDispatcher({ queue: q, db });
    dispatcher.register({
      workflowId: "wf-orders",
      config: { type: "event", eventType: "order.paid" },
    });

    const result = dispatcher.emit({
      type: "order.paid",
      payload: { amount: 100 },
    });
    expect(result.triggeredRunIds).toHaveLength(1);
    expect(result.resolvedWaitingSteps).toHaveLength(0);

    // The run should be in the queue.
    expect(q.pendingCount()).toBe(1);
    db.close();
  });

  it("does not enqueue for non-matching event types", () => {
    const { db, q } = setup();
    const dispatcher = new EventDispatcher({ queue: q, db });
    dispatcher.register({
      workflowId: "wf-orders",
      config: { type: "event", eventType: "order.paid" },
    });

    const result = dispatcher.emit({ type: "order.refunded", payload: {} });
    expect(result.triggeredRunIds).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
    db.close();
  });

  it("respects filter on event trigger", () => {
    const { db, q } = setup();
    const dispatcher = new EventDispatcher({ queue: q, db });
    dispatcher.register({
      workflowId: "wf-usd",
      config: {
        type: "event",
        eventType: "order.paid",
        filter: { currency: "USD" },
      },
    });

    dispatcher.emit({ type: "order.paid", payload: { currency: "EUR", amount: 50 } });
    expect(q.pendingCount()).toBe(0);

    dispatcher.emit({ type: "order.paid", payload: { currency: "USD", amount: 50 } });
    expect(q.pendingCount()).toBe(1);
    db.close();
  });

  it("refuses duplicate registration with the same key", () => {
    const { db, q } = setup();
    const dispatcher = new EventDispatcher({ queue: q, db });
    dispatcher.register({
      workflowId: "wf-x",
      config: { type: "event", eventType: "x" },
    });
    expect(() =>
      dispatcher.register({
        workflowId: "wf-x",
        config: { type: "event", eventType: "x" },
      }),
    ).toThrow(/already registered/);
    db.close();
  });

  it("fan-outs an event to N matching workflows", () => {
    const { db, q } = setup();
    const dispatcher = new EventDispatcher({ queue: q, db });
    dispatcher.register({
      workflowId: "wf-a",
      config: { type: "event", eventType: "shared" },
    });
    dispatcher.register({
      workflowId: "wf-b",
      config: { type: "event", eventType: "shared" },
    });

    const r = dispatcher.emit({ type: "shared", payload: {} });
    expect(r.triggeredRunIds).toHaveLength(2);
    expect(q.pendingCount()).toBe(2);
    db.close();
  });

  it("persists every emitted event to the DB (durable)", () => {
    const { db, q } = setup();
    const dispatcher = new EventDispatcher({ queue: q, db });
    const h = createHelpers(db);
    const r = dispatcher.emit({ type: "no.listener", payload: { x: 1 } });
    expect(h.getEvent(r.event.id)).toBeTruthy();
    db.close();
  });
});

describe("EventDispatcher — waitForEvent dispatch (resolves waiting_steps)", () => {
  it("resolves a pending waiting_step when a matching event arrives", () => {
    const { db, q } = setup();
    const h = createHelpers(db);
    const runId = q.enqueue("wf-wait");
    q.claim();

    // Seed a waiting_steps row as the executor would.
    h.insertWaitingStep({
      id: "ws-1",
      run_id: runId,
      step_name: "wait-for-stripe",
      event_type: "stripe.3ds.completed",
      match_payload: null,
      match_correlation_id: "sess-1",
      expires_at: "2026-04-15T00:05:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });

    const dispatcher = new EventDispatcher({
      queue: q,
      db,
      now: () => new Date("2026-04-15T00:00:30.000Z"),
    });

    const r = dispatcher.emit({
      type: "stripe.3ds.completed",
      payload: { outcome: "ok" },
      correlationId: "sess-1",
    });
    expect(r.resolvedWaitingSteps).toHaveLength(1);
    expect(r.resolvedWaitingSteps[0]?.runId).toBe(runId);

    const resolved = h.getWaitingStep(runId, "wait-for-stripe");
    expect(resolved?.resolved_at).toBe("2026-04-15T00:00:30.000Z");
    expect(resolved?.resolved_event_id).toBe(r.event.id);
    db.close();
  });

  it("does not resolve a waiting_step for a different correlationId", () => {
    const { db, q } = setup();
    const h = createHelpers(db);
    const runId = q.enqueue("wf-wait");
    q.claim();
    h.insertWaitingStep({
      id: "ws-2",
      run_id: runId,
      step_name: "wait",
      event_type: "x",
      match_payload: null,
      match_correlation_id: "expected",
      expires_at: "2026-04-15T00:05:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    const dispatcher = new EventDispatcher({ queue: q, db });
    const r = dispatcher.emit({
      type: "x",
      payload: {},
      correlationId: "mismatch",
    });
    expect(r.resolvedWaitingSteps).toHaveLength(0);
    const still = h.getWaitingStep(runId, "wait");
    expect(still?.resolved_at).toBeNull();
    db.close();
  });

  it("applies matchPayload filter from waiting_steps", () => {
    const { db, q } = setup();
    const h = createHelpers(db);
    const runId = q.enqueue("wf-w");
    q.claim();
    h.insertWaitingStep({
      id: "ws-3",
      run_id: runId,
      step_name: "wait",
      event_type: "job.done",
      match_payload: JSON.stringify({ status: "ok" }),
      match_correlation_id: null,
      expires_at: "2026-04-15T00:05:00.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    const dispatcher = new EventDispatcher({ queue: q, db });
    const notMatching = dispatcher.emit({
      type: "job.done",
      payload: { status: "fail" },
    });
    expect(notMatching.resolvedWaitingSteps).toHaveLength(0);
    const matching = dispatcher.emit({
      type: "job.done",
      payload: { status: "ok" },
    });
    expect(matching.resolvedWaitingSteps).toHaveLength(1);
    db.close();
  });

  it("expireWaitingSteps marks overdue rows resolved with timeout sentinel", () => {
    const { db, q } = setup();
    const h = createHelpers(db);
    const runId = q.enqueue("wf-t");
    q.claim();
    h.insertWaitingStep({
      id: "ws-t",
      run_id: runId,
      step_name: "wait",
      event_type: "x",
      match_payload: null,
      match_correlation_id: null,
      expires_at: "2026-04-15T00:00:30.000Z",
      resolved_at: null,
      resolved_event_id: null,
    });
    const dispatcher = new EventDispatcher({
      queue: q,
      db,
      now: () => new Date("2026-04-15T00:01:00.000Z"),
    });
    const out = dispatcher.expireWaitingSteps();
    expect(out).toHaveLength(1);
    const row = h.getWaitingStep(runId, "wait");
    expect(row?.resolved_at).toBe("2026-04-15T00:01:00.000Z");
    expect(row?.resolved_event_id).toBe(TIMEOUT_EVENT_ID);
    db.close();
  });

  it("fans out a single event to multiple waiting steps", () => {
    const { db, q } = setup();
    const h = createHelpers(db);
    const run1 = q.enqueue("wf-a");
    q.claim();
    const run2 = q.enqueue("wf-b");
    q.claim();
    for (const [id, run] of [
      ["ws-a", run1],
      ["ws-b", run2],
    ] as const) {
      h.insertWaitingStep({
        id,
        run_id: run,
        step_name: "wait",
        event_type: "broadcast",
        match_payload: null,
        match_correlation_id: null,
        expires_at: "2026-04-15T00:05:00.000Z",
        resolved_at: null,
        resolved_event_id: null,
      });
    }
    const dispatcher = new EventDispatcher({ queue: q, db });
    const r = dispatcher.emit({ type: "broadcast", payload: {} });
    expect(r.resolvedWaitingSteps).toHaveLength(2);
    db.close();
  });
});
