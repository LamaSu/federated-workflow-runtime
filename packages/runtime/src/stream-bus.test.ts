import { describe, expect, it } from "vitest";
import {
  StreamBus,
  STREAM_MODES,
  stepRowToPayload,
  type StreamEvent,
  type StreamMode,
} from "./stream-bus.js";

/**
 * Unit tests for the in-process StreamBus. The executor-level
 * "publishes-under-mutex" ordering invariant is exercised separately in
 * `executor.streaming.test.ts` because it requires a real Executor.
 *
 * What this file covers:
 *   - subscribe / publish basic delivery
 *   - mode filter (subscriber only sees declared modes)
 *   - per-run isolation (events for run A don't reach subscribers of B)
 *   - unsubscribe is idempotent + actually removes
 *   - listener exceptions don't poison the bus
 *   - subscriber count introspection
 */

describe("StreamBus", () => {
  it("delivers an event to a single matching subscriber", () => {
    const bus = new StreamBus();
    const seen: StreamEvent[] = [];
    bus.subscribe("run-1", (e) => seen.push(e), { modes: ["values"] });
    bus.publish(makeValuesEvent("run-1", "step-a"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe("values");
    expect((seen[0] as { runId: string }).runId).toBe("run-1");
  });

  it("filters by mode — subscriber asking for messages does not see values", () => {
    const bus = new StreamBus();
    const messages: StreamEvent[] = [];
    bus.subscribe("run-1", (e) => messages.push(e), { modes: ["messages"] });
    bus.publish(makeValuesEvent("run-1", "step-a"));
    expect(messages).toHaveLength(0);
    bus.publish({
      mode: "messages",
      runId: "run-1",
      stepName: "step-a",
      chunk: "hi",
      ts: 1,
    });
    expect(messages).toHaveLength(1);
  });

  it("isolates by runId", () => {
    const bus = new StreamBus();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    bus.subscribe("run-A", (e) => a.push(e), { modes: ["values"] });
    bus.subscribe("run-B", (e) => b.push(e), { modes: ["values"] });
    bus.publish(makeValuesEvent("run-A", "step-1"));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    bus.publish(makeValuesEvent("run-B", "step-2"));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("delivers to multiple subscribers on the same run", () => {
    const bus = new StreamBus();
    let count = 0;
    bus.subscribe("run-1", () => count++, { modes: ["values"] });
    bus.subscribe("run-1", () => count++, { modes: ["values"] });
    bus.subscribe("run-1", () => count++, { modes: ["values"] });
    bus.publish(makeValuesEvent("run-1", "step-a"));
    expect(count).toBe(3);
  });

  it("subscribe-with-multiple-modes receives each matching event", () => {
    const bus = new StreamBus();
    const seen: StreamMode[] = [];
    bus.subscribe("run-1", (e) => seen.push(e.mode), {
      modes: ["values", "tasks"],
    });
    bus.publish(makeValuesEvent("run-1", "step-a"));
    bus.publish({
      mode: "tasks",
      runId: "run-1",
      phase: "step:start",
      stepName: "step-b",
      ts: 2,
    });
    bus.publish({
      mode: "messages",
      runId: "run-1",
      stepName: "step-c",
      chunk: "x",
      ts: 3,
    });
    expect(seen).toEqual(["values", "tasks"]);
  });

  it("unsubscribe stops delivery + is idempotent", () => {
    const bus = new StreamBus();
    let n = 0;
    const off = bus.subscribe("run-1", () => n++, { modes: ["values"] });
    bus.publish(makeValuesEvent("run-1", "a"));
    expect(n).toBe(1);
    off();
    bus.publish(makeValuesEvent("run-1", "b"));
    expect(n).toBe(1);
    // Idempotent: calling off() again does nothing.
    off();
    bus.publish(makeValuesEvent("run-1", "c"));
    expect(n).toBe(1);
    // Bucket cleaned up after last unsubscribe.
    expect(bus.subscriberCountForRun("run-1")).toBe(0);
  });

  it("a throwing listener does not break others", () => {
    const bus = new StreamBus();
    const good: StreamEvent[] = [];
    bus.subscribe(
      "run-1",
      () => {
        throw new Error("boom");
      },
      { modes: ["values"] },
    );
    bus.subscribe("run-1", (e) => good.push(e), { modes: ["values"] });
    // Should not throw — bus catches.
    bus.publish(makeValuesEvent("run-1", "a"));
    expect(good).toHaveLength(1);
  });

  it("publish to a runId with no subscribers is a no-op", () => {
    const bus = new StreamBus();
    expect(() => bus.publish(makeValuesEvent("ghost", "x"))).not.toThrow();
    expect(bus.subscriberCount).toBe(0);
  });

  it("STREAM_MODES contains exactly the four shipped modes", () => {
    expect(STREAM_MODES).toEqual(["values", "updates", "messages", "tasks"]);
  });

  it("listener-self-unsubscribe-during-fanout does not skip later subscribers", () => {
    const bus = new StreamBus();
    let unsub2: (() => void) | undefined;
    let count1 = 0;
    let count2 = 0;
    let count3 = 0;
    bus.subscribe("run-1", () => count1++, { modes: ["values"] });
    unsub2 = bus.subscribe(
      "run-1",
      () => {
        count2++;
        unsub2?.(); // self-unsubscribe mid-publish
      },
      { modes: ["values"] },
    );
    bus.subscribe("run-1", () => count3++, { modes: ["values"] });
    bus.publish(makeValuesEvent("run-1", "a"));
    // All three saw the first publish.
    expect(count1).toBe(1);
    expect(count2).toBe(1);
    expect(count3).toBe(1);
    // Second publish — listener 2 is gone.
    bus.publish(makeValuesEvent("run-1", "b"));
    expect(count1).toBe(2);
    expect(count2).toBe(1);
    expect(count3).toBe(2);
  });
});

describe("stepRowToPayload", () => {
  it("parses output JSON safely", () => {
    const p = stepRowToPayload({
      step_name: "x",
      status: "success",
      attempt: 1,
      output: '{"ok":true,"n":42}',
      error: null,
      duration_ms: 10,
      started_at: "2026-04-23T00:00:00Z",
      finished_at: "2026-04-23T00:00:00.010Z",
    });
    expect(p.output).toEqual({ ok: true, n: 42 });
    expect(p.stepName).toBe("x");
    expect(p.durationMs).toBe(10);
  });

  it("falls back to raw string when output isn't valid JSON", () => {
    const p = stepRowToPayload({
      step_name: "x",
      status: "success",
      attempt: 1,
      output: "not-json",
      error: null,
      duration_ms: null,
      started_at: null,
      finished_at: null,
    });
    expect(p.output).toBe("not-json");
  });

  it("null output → null", () => {
    const p = stepRowToPayload({
      step_name: "x",
      status: "running",
      attempt: 1,
      output: null,
      error: null,
      duration_ms: null,
      started_at: null,
      finished_at: null,
    });
    expect(p.output).toBeNull();
  });
});

function makeValuesEvent(runId: string, stepName: string): StreamEvent {
  return {
    mode: "values",
    runId,
    step: {
      stepName,
      status: "success",
      attempt: 1,
      output: null,
      error: null,
      durationMs: 0,
      startedAt: null,
      finishedAt: null,
    },
    ts: Date.now(),
  };
}
