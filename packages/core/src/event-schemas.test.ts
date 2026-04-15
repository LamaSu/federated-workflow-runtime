import { describe, expect, it } from "vitest";
import {
  EventSchema,
  EventTriggerSchema,
  WaitForEventCallSchema,
  ExtendedTriggerSchema,
} from "./event-schemas.js";

/**
 * Tests for event-trigger Zod schemas. Zero business logic here — we only
 * assert the contract so sibling agents (runtime, cli, mcp) can build
 * against stable shapes.
 */

describe("EventSchema", () => {
  it("accepts a minimal event", () => {
    const parsed = EventSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      type: "order.paid",
      emittedAt: "2026-04-15T00:00:00.000Z",
    });
    expect(parsed.type).toBe("order.paid");
    // payload defaults to an empty object
    expect(parsed.payload).toEqual({});
  });

  it("accepts a fully-populated event", () => {
    const parsed = EventSchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      type: "stripe.3ds.completed",
      payload: { sessionId: "cs_test_123" },
      source: "stripe-webhook",
      emittedAt: "2026-04-15T12:00:00.000Z",
      correlationId: "sess-abc",
    });
    expect(parsed.correlationId).toBe("sess-abc");
    expect((parsed.payload as { sessionId: string }).sessionId).toBe("cs_test_123");
  });

  it("rejects events with empty type", () => {
    expect(() =>
      EventSchema.parse({
        id: "33333333-3333-4333-8333-333333333333",
        type: "",
        emittedAt: "2026-04-15T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects non-UUID ids", () => {
    expect(() =>
      EventSchema.parse({
        id: "not-a-uuid",
        type: "x",
        emittedAt: "2026-04-15T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects non-ISO datetimes", () => {
    expect(() =>
      EventSchema.parse({
        id: "44444444-4444-4444-8444-444444444444",
        type: "x",
        emittedAt: "yesterday",
      }),
    ).toThrow();
  });
});

describe("EventTriggerSchema", () => {
  it("accepts a bare event trigger", () => {
    const parsed = EventTriggerSchema.parse({
      type: "event",
      eventType: "order.paid",
    });
    expect(parsed.type).toBe("event");
    expect(parsed.eventType).toBe("order.paid");
  });

  it("accepts a filter object", () => {
    const parsed = EventTriggerSchema.parse({
      type: "event",
      eventType: "order.paid",
      filter: { currency: "USD", gt100: true },
    });
    expect(parsed.filter).toEqual({ currency: "USD", gt100: true });
  });

  it("rejects the wrong discriminant", () => {
    expect(() =>
      EventTriggerSchema.parse({ type: "webhook", eventType: "x" }),
    ).toThrow();
  });
});

describe("ExtendedTriggerSchema", () => {
  it("accepts the three legacy triggers", () => {
    expect(() =>
      ExtendedTriggerSchema.parse({ type: "cron", expression: "* * * * *" }),
    ).not.toThrow();
    expect(() =>
      ExtendedTriggerSchema.parse({
        type: "webhook",
        path: "/hooks/a",
      }),
    ).not.toThrow();
    expect(() =>
      ExtendedTriggerSchema.parse({ type: "manual" }),
    ).not.toThrow();
  });

  it("accepts an event trigger", () => {
    const parsed = ExtendedTriggerSchema.parse({
      type: "event",
      eventType: "x",
    });
    expect(parsed.type).toBe("event");
  });

  it("rejects unknown types", () => {
    expect(() =>
      ExtendedTriggerSchema.parse({ type: "unknown" }),
    ).toThrow();
  });
});

describe("WaitForEventCallSchema", () => {
  it("defaults timeoutMs to 60000", () => {
    const parsed = WaitForEventCallSchema.parse({ eventType: "x" });
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("accepts matchPayload + matchCorrelationId", () => {
    const parsed = WaitForEventCallSchema.parse({
      eventType: "stripe.3ds.completed",
      matchPayload: { outcome: "ok" },
      matchCorrelationId: "sess-123",
      timeoutMs: 30_000,
    });
    expect(parsed.matchCorrelationId).toBe("sess-123");
    expect(parsed.matchPayload).toEqual({ outcome: "ok" });
    expect(parsed.timeoutMs).toBe(30_000);
  });

  it("rejects timeoutMs over 7 days", () => {
    expect(() =>
      WaitForEventCallSchema.parse({
        eventType: "x",
        timeoutMs: 8 * 24 * 60 * 60 * 1000,
      }),
    ).toThrow();
  });

  it("rejects timeoutMs <= 0", () => {
    expect(() =>
      WaitForEventCallSchema.parse({ eventType: "x", timeoutMs: 0 }),
    ).toThrow();
    expect(() =>
      WaitForEventCallSchema.parse({ eventType: "x", timeoutMs: -1 }),
    ).toThrow();
  });

  it("rejects missing eventType", () => {
    expect(() => WaitForEventCallSchema.parse({})).toThrow();
  });
});
