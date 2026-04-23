import { describe, expect, it } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  Workflow,
} from "@delightfulchorus/core";
import { openDatabase } from "./db.js";
import { RunQueue } from "./queue.js";
import { Executor, type IntegrationLoader, type StreamWriter } from "./executor.js";
import { StreamBus, type StreamEvent } from "./stream-bus.js";

/**
 * Tests for Wave 4 item 12 — streaming protocol integration with executor.
 *
 * What this file covers (the bus's internals are covered separately in
 * stream-bus.test.ts):
 *
 *   1. values + updates + tasks events fire on each step row write
 *   2. ctx.stream.write reaches messages subscribers attributed to the right step
 *   3. concurrent fanOut writes maintain ordering — subscriber sees events
 *      in the same order step rows are written (mutex invariant)
 *   4. failure path emits values/updates(failed) + tasks(step:end, failed)
 *   5. memoization replay does NOT re-emit values events (cached steps
 *      short-circuit before the row write)
 *   6. when no streamBus is wired, executor behavior is identical to baseline
 */

function makeIntegration(
  name: string,
  operations: Record<string, (input: unknown, ctx: OperationContext) => Promise<unknown>>,
): IntegrationModule {
  const manifest: IntegrationManifest = {
    name,
    version: "1.0.0",
    description: "test",
    authType: "none",
    credentialTypes: [],
    operations: Object.keys(operations).map((op) => ({
      name: op,
      description: op,
      inputSchema: {},
      outputSchema: {},
      idempotent: true,
    })),
  };
  return {
    manifest,
    operations: Object.fromEntries(
      Object.entries(operations).map(([op, fn]) => [
        op,
        async (input, ctx) => fn(input, ctx),
      ]),
    ),
  };
}

function makeWorkflow(nodes: Workflow["nodes"]): Workflow {
  return {
    id: "wf-stream",
    name: "stream",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections: [],
    createdAt: "2026-04-23T00:00:00Z",
    updatedAt: "2026-04-23T00:00:00Z",
  };
}

function makeLoader(map: Record<string, IntegrationModule>): IntegrationLoader {
  return async (name) => {
    const mod = map[name];
    if (!mod) throw new Error(`unknown integration ${name}`);
    return mod;
  };
}

describe("Executor + StreamBus — happy path", () => {
  it("emits values + updates + tasks for each step in declaration order", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();
    const events: StreamEvent[] = [];
    bus.subscribe(runId, (e) => events.push(e), {
      modes: ["values", "updates", "tasks"],
    });

    const mod = makeIntegration("stub", {
      echo: async (input) => ({ echoed: input }),
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "echo", config: {}, inputs: { x: 1 }, onError: "retry" },
      { id: "n2", integration: "stub", operation: "echo", config: {}, inputs: { x: 2 }, onError: "retry" },
    ]);
    const result = await exec.run(wf, runId, {});
    expect(result.status).toBe("success");

    // Each step writes 2 row writes (running → success), each emits 2 mode
    // events (values + updates). Plus 2 tasks events (step:start + step:end).
    // For 2 nodes:
    //   running write → 2 (values, updates)
    //   step:start tasks → 1
    //   success write → 2 (values, updates)
    //   step:end tasks → 1
    // Total per node = 6. For 2 nodes = 12 events.
    expect(events.length).toBe(12);

    // Order: n1 running → n1 step:start → n1 success → n1 step:end → n2 running → ...
    const eventDescs = events.map((e) => {
      if (e.mode === "values" || e.mode === "updates") {
        return `${e.mode}:${e.step.stepName}:${e.step.status}`;
      }
      if (e.mode === "tasks") {
        return `tasks:${e.phase}:${e.stepName}`;
      }
      return e.mode;
    });
    expect(eventDescs).toEqual([
      "values:n1:running",
      "updates:n1:running",
      "tasks:step:start:n1",
      "values:n1:success",
      "updates:n1:success",
      "tasks:step:end:n1",
      "values:n2:running",
      "updates:n2:running",
      "tasks:step:start:n2",
      "values:n2:success",
      "updates:n2:success",
      "tasks:step:end:n2",
    ]);
  });

  it("ctx.stream.write reaches messages subscribers, attributed to current step", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();
    const messages: Array<{ stepName: string; chunk: unknown }> = [];
    bus.subscribe(
      runId,
      (e) => {
        if (e.mode === "messages") {
          messages.push({ stepName: e.stepName, chunk: e.chunk });
        }
      },
      { modes: ["messages"] },
    );

    const mod = makeIntegration("llm", {
      stream: async (_input, ctx) => {
        const c = ctx as OperationContext & { stream?: StreamWriter };
        // Handler emits 3 token chunks via the new API.
        c.stream?.write("Hello");
        c.stream?.write(" ");
        c.stream?.write("world");
        return { tokens: 3 };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ llm: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      { id: "tokenizer", integration: "llm", operation: "stream", config: {}, inputs: {}, onError: "retry" },
    ]);
    await exec.run(wf, runId, {});
    expect(messages).toEqual([
      { stepName: "tokenizer", chunk: "Hello" },
      { stepName: "tokenizer", chunk: " " },
      { stepName: "tokenizer", chunk: "world" },
    ]);
  });

  it("ctx.stream.write attributes correctly across multiple sequential nodes", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();
    const messages: Array<{ stepName: string; chunk: unknown }> = [];
    bus.subscribe(
      runId,
      (e) => {
        if (e.mode === "messages") {
          messages.push({ stepName: e.stepName, chunk: e.chunk });
        }
      },
      { modes: ["messages"] },
    );

    const mod = makeIntegration("llm", {
      stream: async (input, ctx) => {
        const c = ctx as OperationContext & { stream?: StreamWriter };
        c.stream?.write({ from: (input as { triggerPayload: { id: string } }).triggerPayload.id });
        return { ok: true };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ llm: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      { id: "alpha", integration: "llm", operation: "stream", config: {}, inputs: {}, onError: "retry" },
      { id: "bravo", integration: "llm", operation: "stream", config: {}, inputs: {}, onError: "retry" },
    ]);
    await exec.run(wf, runId, { id: "trig" });
    expect(messages).toEqual([
      { stepName: "alpha", chunk: { from: "trig" } },
      { stepName: "bravo", chunk: { from: "trig" } },
    ]);
  });

  it("handler with no stream call → no messages events", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();
    const messages: StreamEvent[] = [];
    bus.subscribe(runId, (e) => messages.push(e), { modes: ["messages"] });

    const mod = makeIntegration("plain", {
      noop: async () => ({ ok: true }),
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ plain: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      { id: "n1", integration: "plain", operation: "noop", config: {}, inputs: {}, onError: "retry" },
    ]);
    await exec.run(wf, runId, {});
    expect(messages).toHaveLength(0);
  });

  it("when no streamBus is wired, ctx.stream is undefined", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });

    let observedHasStream: boolean | null = null;
    const mod = makeIntegration("stub", {
      probe: async (_input, ctx) => {
        const c = ctx as OperationContext & { stream?: StreamWriter };
        observedHasStream = c.stream !== undefined;
        return { ok: true };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      // no streamBus
    });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "probe", config: {}, inputs: {}, onError: "retry" },
    ]);
    await exec.run(wf, runId, {});
    expect(observedHasStream).toBe(false);
  });

  it("failure path emits failed values + failed tasks event", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();
    const events: StreamEvent[] = [];
    bus.subscribe(runId, (e) => events.push(e), {
      modes: ["values", "tasks"],
    });

    const mod = makeIntegration("stub", {
      bad: async () => {
        throw new Error("boom");
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "bad",
        config: {},
        inputs: {},
        onError: "fail",
        retry: { maxAttempts: 1, backoffMs: 1, jitter: false },
      },
    ]);
    const result = await exec.run(wf, runId, {});
    expect(result.status).toBe("failed");

    // running, step:start, failed, step:end
    const failedEvent = events.find(
      (e) => e.mode === "values" && e.step.status === "failed",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent && (failedEvent as { step: { error: string } }).step.error).toBe("boom");
    const endTask = events.find(
      (e) => e.mode === "tasks" && e.phase === "step:end",
    );
    expect(endTask && (endTask as { status: string }).status).toBe("failed");
  });
});

describe("Executor + StreamBus — ordering under fanOut concurrency", () => {
  it("concurrent fanOut children emit values events in row-write order", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();
    const events: StreamEvent[] = [];
    bus.subscribe(runId, (e) => events.push(e), { modes: ["values"] });

    // A handler that uses step.fanOut to spawn N parallel children. Each
    // child returns its index after a tiny async tick — this guarantees
    // they interleave at the JS scheduler boundary.
    const mod = makeIntegration("worker", {
      fanout: async (_input, ctx) => {
        const c = ctx as OperationContext & {
          step: {
            fanOut: <T, R>(
              name: string,
              items: readonly T[],
              fn: (item: T, idx: number) => Promise<R>,
            ) => Promise<R[]>;
          };
        };
        const out = await c.step.fanOut("kid", [0, 1, 2, 3, 4], async (i) => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return i;
        });
        return out;
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ worker: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      { id: "n1", integration: "worker", operation: "fanout", config: {}, inputs: {}, onError: "retry" },
    ]);
    const result = await exec.run(wf, runId, {});
    expect(result.status).toBe("success");

    // The KEY assertion: for each child step name, the running event must
    // come BEFORE the success event in the global event order. The mutex
    // serializes both writes through the bus, so values:running:kid.X
    // must appear before values:success:kid.X for every X.
    for (let i = 0; i < 5; i++) {
      const stepName = `kid.${i}`;
      const runningIdx = events.findIndex(
        (e) => e.mode === "values" && e.step.stepName === stepName && e.step.status === "running",
      );
      const successIdx = events.findIndex(
        (e) => e.mode === "values" && e.step.stepName === stepName && e.step.status === "success",
      );
      expect(runningIdx).toBeGreaterThanOrEqual(0);
      expect(successIdx).toBeGreaterThan(runningIdx);
    }

    // Bonus: also assert that no two same-named events appear back-to-back
    // out of order (running after success, or two successes for the same
    // name without a running in between).
    const seenStatus = new Map<string, "running" | "success">();
    for (const e of events) {
      if (e.mode !== "values") continue;
      const prev = seenStatus.get(e.step.stepName);
      if (prev === undefined) {
        // First time: must be running.
        expect(e.step.status).toBe("running");
      } else if (prev === "running") {
        // Next: must be success (or failed in this happy-path test).
        expect(["success", "failed"]).toContain(e.step.status);
      }
      seenStatus.set(e.step.stepName, e.step.status as "running" | "success");
    }
  });
});

describe("Executor + StreamBus — replay / cached steps", () => {
  it("cached step on rerun does NOT re-emit values events (short-circuit before row write)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-stream");
    q.claim({ nowIso: "2026-04-23T00:00:00Z" });
    const bus = new StreamBus();

    const mod = makeIntegration("stub", {
      echo: async (input) => ({ echoed: input }),
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      streamBus: bus,
    });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "echo", config: {}, inputs: { x: 1 }, onError: "retry" },
    ]);
    // First run — no subscriber attached yet.
    const r1 = await exec.run(wf, runId, {});
    expect(r1.status).toBe("success");

    // NOW subscribe and rerun (replay reuses memoized step).
    const events: StreamEvent[] = [];
    bus.subscribe(runId, (e) => events.push(e), {
      modes: ["values", "updates", "tasks"],
    });
    const r2 = await exec.run(wf, runId, {});
    expect(r2.status).toBe("success");

    // No new events — the step short-circuited inside the mutex BEFORE
    // any publishStep call. Subscribers see only fresh writes.
    expect(events).toHaveLength(0);
  });
});
