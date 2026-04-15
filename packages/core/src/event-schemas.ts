import { z } from "zod";
import { TriggerSchema } from "./schemas.js";

/**
 * Event schemas per ROADMAP §6 — the missing primitive for async workflows.
 *
 * Owned by this file (not schemas.ts) because multiple wave-2 agents append
 * to core in parallel. Re-exported via packages/core/src/index.ts.
 *
 * Three schemas live here:
 *   - `EventSchema`          — shape of a durable event row in the bus
 *   - `EventTriggerSchema`   — a workflow trigger that fires on event emission
 *   - `WaitForEventCallSchema` — the input the executor receives from
 *     `step.waitForEvent(...)` inside a running workflow
 *
 * We also export `ExtendedTriggerSchema` which is the engine-side union.
 * The authoring UX is: workflows on disk can declare either a cron/webhook/
 * manual trigger (original `TriggerSchema`) OR an event trigger. At load
 * time the runtime parses against `ExtendedTriggerSchema`. See
 * docs/EVENT_TRIGGERS.md for the full story.
 */

// ── Event payload (bus row) ─────────────────────────────────────────────────

export const EventSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  payload: z.unknown().default({}),
  source: z.string().optional(),
  emittedAt: z.string().datetime(),
  correlationId: z.string().optional(),
});

// ── Event trigger (workflow.trigger union member) ───────────────────────────

export const EventTriggerSchema = z.object({
  type: z.literal("event"),
  eventType: z.string(),
  /**
   * Optional payload filter: only events whose payload JSON contains each of
   * these key/value pairs (shallow equality) match. `undefined` in the filter
   * means "any value for this key". Missing keys in the payload never match.
   */
  filter: z.record(z.unknown()).optional(),
});

// ── Engine-side trigger union (original 3 + event) ──────────────────────────
//
// NB: we can't mutate the existing `TriggerSchema` (other agents own
// schemas.ts). Instead, we build a *new* union that the runtime uses
// internally. Workflows on disk only parse `TriggerSchema` strictly until
// a v1.1 migration lands.

export const ExtendedTriggerSchema = z.discriminatedUnion("type", [
  ...TriggerSchema.options,
  EventTriggerSchema,
]);

// ── step.waitForEvent call args ─────────────────────────────────────────────

export const WaitForEventCallSchema = z.object({
  eventType: z.string(),
  /**
   * Payload filter (same semantics as EventTrigger.filter). Applied at match
   * time on the executor side. Must be JSON-serializable so replay produces
   * the same matches across process restarts.
   */
  matchPayload: z.record(z.unknown()).optional(),
  /**
   * Correlation id match. When set, only events whose `correlationId` equals
   * this string match. Useful for Stripe 3DS, OAuth callbacks.
   */
  matchCorrelationId: z.string().optional(),
  /**
   * Max wait before TimeoutError. Default 60s. Max 7 days — past that the
   * SQLite row lives too long and we'd rather you use a cron + lookup.
   */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60 * 1000)
    .default(60_000),
});

// ── Inferred TS types (flag re-exports) ─────────────────────────────────────

export type Event = z.infer<typeof EventSchema>;
export type EventTrigger = z.infer<typeof EventTriggerSchema>;
export type WaitForEventCall = z.infer<typeof WaitForEventCallSchema>;
export type ExtendedTrigger = z.infer<typeof ExtendedTriggerSchema>;
