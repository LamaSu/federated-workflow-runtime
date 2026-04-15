import { describe, expect, it, vi } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  Workflow,
} from "@chorus/core";
import { openDatabase } from "./db.js";
import { RunQueue } from "./queue.js";
import { Executor, type IntegrationLoader } from "./executor.js";

function makeIntegration(
  name: string,
  operations: Record<string, (input: unknown) => Promise<unknown>>,
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
      Object.entries(operations).map(([op, fn]) => [op, async (input) => fn(input)]),
    ),
  };
}

/**
 * Like makeIntegration, but passes the OperationContext through so handlers
 * can access ctx.step, ctx.credentials, etc. Used by waitForEvent tests
 * where the handler must call `ctx.step.waitForEvent(...)`.
 */
function makeCtxIntegration(
  name: string,
  operations: Record<
    string,
    (input: unknown, ctx: OperationContext) => Promise<unknown>
  >,
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
      Object.entries(operations).map(([op, fn]) => [op, async (input, ctx) => fn(input, ctx)]),
    ),
  };
}

function makeWorkflow(nodes: Workflow["nodes"]): Workflow {
  return {
    id: "wf-test",
    name: "test",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections: [],
    createdAt: "2026-04-13T00:00:00Z",
    updatedAt: "2026-04-13T00:00:00Z",
  };
}

function makeLoader(map: Record<string, IntegrationModule>): IntegrationLoader {
  return async (name) => {
    const mod = map[name];
    if (!mod) throw new Error(`unknown integration ${name}`);
    return mod;
  };
}

describe("Executor — happy path", () => {
  it("runs a single-node workflow successfully", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim({ nowIso: "2026-04-13T00:00:00.000Z" });

    const mod = makeIntegration("stub", {
      echo: async (input) => ({ ok: true, input }),
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "echo",
        config: {},
        inputs: { message: "hi" },
        onError: "retry",
      },
    ]);

    const res = await exec.run(workflow, runId, { event: "trigger" });
    expect(res.status).toBe("success");
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]?.status).toBe("success");
    const out = JSON.parse(res.steps[0]!.output ?? "null") as {
      ok: boolean;
      input: { message: string; triggerPayload: { event: string } };
    };
    expect(out.ok).toBe(true);
    expect(out.input.message).toBe("hi");
    expect(out.input.triggerPayload.event).toBe("trigger");
    db.close();
  });

  it("runs multiple nodes in order and persists steps", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      a: async () => {
        calls.push("a");
        return { from: "a" };
      },
      b: async () => {
        calls.push("b");
        return { from: "b" };
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const workflow = makeWorkflow([
      { id: "step-a", integration: "stub", operation: "a", config: {}, onError: "retry" },
      { id: "step-b", integration: "stub", operation: "b", config: {}, onError: "retry" },
    ]);

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(calls).toEqual(["a", "b"]);
    expect(res.steps).toHaveLength(2);
    db.close();
  });
});

describe("Executor — CRITICAL: replay-based durable execution", () => {
  it("replay: completed steps are NOT re-executed on a second run() invocation", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    let aCalls = 0;
    let bCalls = 0;
    const mod = makeIntegration("stub", {
      a: async () => {
        aCalls++;
        return { from: "a", v: aCalls };
      },
      b: async () => {
        bCalls++;
        return { from: "b", v: bCalls };
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const workflow = makeWorkflow([
      { id: "step-a", integration: "stub", operation: "a", config: {}, onError: "retry" },
      { id: "step-b", integration: "stub", operation: "b", config: {}, onError: "retry" },
    ]);

    // First run: both steps execute.
    const r1 = await exec.run(workflow, runId, {});
    expect(r1.status).toBe("success");
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    // Simulate a restart: the same workflow is re-executed against the same
    // runId. Both step names are present in the `steps` table with status
    // 'success', so neither integration call should fire again.
    const r2 = await exec.run(workflow, runId, {});
    expect(r2.status).toBe("success");
    expect(aCalls).toBe(1); // MUST still be 1 — proof of durability
    expect(bCalls).toBe(1);

    // The replayed run should return the SAME outputs the first run did.
    const aRow = JSON.parse(r2.steps.find((s) => s.step_name === "step-a")!.output ?? "null");
    expect(aRow).toEqual({ from: "a", v: 1 });
    db.close();
  });

  it("replay: partially-completed runs resume from the first unfinished step", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    let aCalls = 0;
    let bCalls = 0;
    const mod1 = makeIntegration("stub", {
      a: async () => {
        aCalls++;
        return { v: aCalls };
      },
      b: async () => {
        bCalls++;
        throw new Error("transient on first attempt");
      },
    });
    const exec1 = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod1 }),
      sleep: async () => {},
    });
    const workflow = makeWorkflow([
      { id: "step-a", integration: "stub", operation: "a", config: {}, onError: "fail" },
      { id: "step-b", integration: "stub", operation: "b", config: {}, onError: "fail" },
    ]);

    const r1 = await exec1.run(workflow, runId, {});
    expect(r1.status).toBe("failed");
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    // Second attempt with a fixed integration — step-a must NOT re-run.
    const mod2 = makeIntegration("stub", {
      a: async () => {
        aCalls++;
        return { v: aCalls };
      },
      b: async () => {
        bCalls++;
        return { from: "b", v: bCalls };
      },
    });
    const exec2 = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod2 }),
      sleep: async () => {},
    });

    // But first, step-b was left in 'failed' state. Durable execution only
    // skips steps with status=success; we must clear/retry the failed step
    // to re-execute it. The Executor does this implicitly: it only short-
    // circuits on successful steps.
    const r2 = await exec2.run(workflow, runId, {});
    expect(r2.status).toBe("success");
    expect(aCalls).toBe(1); // step-a replayed from cache
    expect(bCalls).toBe(2); // step-b retried
    db.close();
  });

  it("writes step rows even when execution fails", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const mod = makeIntegration("stub", {
      boom: async () => {
        throw new Error("oops");
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      sleep: async () => {},
    });
    const workflow = makeWorkflow([
      { id: "bad", integration: "stub", operation: "boom", config: {}, onError: "fail" },
    ]);

    const r = await exec.run(workflow, runId, {});
    expect(r.status).toBe("failed");
    expect(r.steps.length).toBeGreaterThanOrEqual(1);
    expect(r.steps[0]?.status).toBe("failed");
    expect(r.steps[0]?.error).toBe("oops");
    db.close();
  });
});

describe("Executor — retry", () => {
  it("retries up to maxAttempts on transient failure", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    let calls = 0;
    const mod = makeIntegration("stub", {
      flaky: async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return { ok: true, calls };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      sleep: async () => {},
    });
    const workflow = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "flaky",
        config: {},
        retry: { maxAttempts: 3, backoffMs: 100, jitter: false },
        onError: "retry",
      },
    ]);

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(calls).toBe(3);
    db.close();
  });

  it("honors onError='fail' by NOT retrying", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    let calls = 0;
    const mod = makeIntegration("stub", {
      always: async () => {
        calls++;
        throw new Error("bad");
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      sleep: async () => {},
    });
    const workflow = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "always",
        config: {},
        retry: { maxAttempts: 5, backoffMs: 50, jitter: false },
        onError: "fail",
      },
    ]);
    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("failed");
    expect(calls).toBe(1);
    db.close();
  });
});

describe("Executor — integration loader", () => {
  it("raises a clear error on missing operation", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const mod = makeIntegration("stub", { echo: async (i) => i });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      sleep: async () => {},
    });
    const workflow = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "nope",
        config: {},
        onError: "fail",
      },
    ]);
    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/has no operation/);
    db.close();
  });

  it("warns on duplicate step names", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const warn = vi.fn();
    const mod = makeIntegration("stub", { echo: async (i) => i });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    });
    const workflow = makeWorkflow([
      { id: "dup", integration: "stub", operation: "echo", config: {}, onError: "retry" },
      { id: "dup", integration: "stub", operation: "echo", config: {}, onError: "retry" },
    ]);
    await exec.run(workflow, runId, {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate step name"));
    db.close();
  });
});

describe("computeBackoff", () => {
  it("exponential without jitter", async () => {
    const { computeBackoff } = await import("./executor.js");
    const p = { maxAttempts: 5, backoffMs: 100, multiplier: 2, jitter: false };
    expect(computeBackoff(p, 1)).toBe(100);
    expect(computeBackoff(p, 2)).toBe(200);
    expect(computeBackoff(p, 3)).toBe(400);
  });

  it("caps at 5 minutes", async () => {
    const { computeBackoff } = await import("./executor.js");
    const p = { maxAttempts: 10, backoffMs: 60_000, multiplier: 10, jitter: false };
    expect(computeBackoff(p, 10)).toBeLessThanOrEqual(5 * 60_000);
  });
});

// ─── step.waitForEvent: the durable wait primitive ─────────────────────────
//
// These tests prove ROADMAP §6: an integration handler can pause durably,
// survive a process restart, and pick up where it left off when the event
// arrives. This is the whole point of the feature.

describe("Executor — step.waitForEvent (durable wait primitive)", () => {
  it("first pass: suspends and returns status='waiting' + inserts a waiting_steps row", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-wait");
    q.claim();

    // Integration handler uses ctx.step.waitForEvent.
    const mod = makeCtxIntegration("stub", {
      wait: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.waitForEvent("wait-for-stripe", {
          eventType: "stripe.3ds.completed",
          matchCorrelationId: "sess-1",
          timeoutMs: 60_000,
        });
      },
    });

    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      {
        id: "n-wait",
        integration: "stub",
        operation: "wait",
        config: {},
        onError: "fail",
      },
    ]);

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("waiting");
    expect(res.waitingOn?.eventType).toBe("stripe.3ds.completed");

    // A durable waiting_steps row was created. step_name reflects the name
    // passed to step.waitForEvent(), not the outer node id.
    const waiting = db
      .prepare(`SELECT * FROM waiting_steps WHERE run_id = ?`)
      .get(runId) as {
      step_name: string;
      resolved_at: string | null;
      match_correlation_id: string | null;
    };
    expect(waiting.step_name).toBe("wait-for-stripe");
    expect(waiting.resolved_at).toBeNull();
    expect(waiting.match_correlation_id).toBe("sess-1");

    db.close();
  });

  it("resolves on event arrival → returns payload on subsequent run()", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-wait");
    q.claim();

    let invocations = 0;
    const mod = makeCtxIntegration("stub", {
      wait: async (_input, ctx) => {
        invocations++;
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.waitForEvent("wait-stripe", {
          eventType: "stripe.3ds.completed",
          matchCorrelationId: "sess-1",
          timeoutMs: 60_000,
        });
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-wait", integration: "stub", operation: "wait", config: {}, onError: "fail" },
    ]);

    // First call suspends.
    const first = await exec.run(workflow, runId, {});
    expect(first.status).toBe("waiting");
    expect(invocations).toBe(1);

    // Simulate event arrival through the dispatcher.
    const { EventDispatcher } = await import("./triggers/event.js");
    const dispatcher = new EventDispatcher({
      queue: q,
      db,
      now: () => new Date("2026-04-15T00:00:30.000Z"),
    });
    const emit = dispatcher.emit({
      type: "stripe.3ds.completed",
      payload: { outcome: "ok" },
      correlationId: "sess-1",
    });
    expect(emit.resolvedWaitingSteps).toHaveLength(1);

    // Replay the run — step.waitForEvent should return the cached event.
    q.claim();
    const second = await exec.run(workflow, runId, {});
    expect(second.status).toBe("success");
    // Handler ran a second time but step.waitForEvent returned without
    // suspending — because the waiting_steps row is resolved.
    expect(invocations).toBe(2);

    const step = second.steps.find((s) => s.step_name === "n-wait");
    expect(step?.status).toBe("success");
    const output = JSON.parse(step!.output ?? "null") as {
      event: { id: string; type: string; payload: { outcome: string } };
    };
    expect(output.event.type).toBe("stripe.3ds.completed");
    expect(output.event.payload.outcome).toBe("ok");
    db.close();
  });

  it("times out cleanly — subsequent run() throws WaitForEventTimeoutError", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-wait");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      wait: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.waitForEvent("wait-x", {
          eventType: "never-arrives",
          timeoutMs: 1000,
        });
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-wait", integration: "stub", operation: "wait", config: {}, onError: "fail" },
    ]);

    // First pass suspends.
    const first = await exec.run(workflow, runId, {});
    expect(first.status).toBe("waiting");

    // Fake the passage of time past the deadline via the dispatcher.
    const { EventDispatcher } = await import("./triggers/event.js");
    const dispatcher = new EventDispatcher({
      queue: q,
      db,
      now: () => new Date("2026-04-15T00:00:05.000Z"),
    });
    const expired = dispatcher.expireWaitingSteps();
    expect(expired).toHaveLength(1);

    // Replay — the run should fail with a clean timeout error.
    q.claim();
    const second = await exec.run(workflow, runId, {});
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/timed out/i);
    db.close();
  });

  it("CRITICAL replay-across-restart: survives a new Executor instance + new DB handle", async () => {
    // This test simulates a process restart:
    //   1. Executor instance A runs the workflow; it suspends.
    //   2. We drop instance A entirely (including its in-process Map).
    //   3. A separate Executor instance B, reading from the same SQLite
    //      file, picks up where A left off once the event arrives.
    //
    // "Same SQLite file" instead of ":memory:" — we really want a disk
    // round-trip to prove durability.
    const path = await import("node:path");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const crypto = await import("node:crypto");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chorus-evt-"));
    const dbPath = path.join(tmp, "chorus.db");

    // ── Phase A: suspend ───────────────────────────────────────────────────
    {
      const dbA = openDatabase(dbPath);
      const qA = new RunQueue(dbA);
      const runId = "run-restart-" + crypto.randomUUID();
      // Seed pre-existing run with known id.
      qA.enqueue("wf-restart", { id: runId });
      qA.claim();

      const mod = makeCtxIntegration("stub", {
        wait: async (_input, ctx) => {
          const step = (ctx as OperationContext & {
            step: import("./executor.js").StepContext;
          }).step;
          return await step.waitForEvent("w1", {
            eventType: "order.shipped",
            matchCorrelationId: "order-42",
            timeoutMs: 60_000,
          });
        },
      });

      const execA = new Executor({
        db: dbA,
        integrationLoader: makeLoader({ stub: mod }),
        now: () => new Date("2026-04-15T00:00:00.000Z"),
      });
      const workflow = makeWorkflow([
        { id: "n-wait", integration: "stub", operation: "wait", config: {}, onError: "fail" },
      ]);
      const r = await execA.run(workflow, runId, {});
      expect(r.status).toBe("waiting");

      // Sanity: waiting_steps row exists on disk. step_name is the name
      // passed into step.waitForEvent, which was "w1".
      const row = dbA.prepare("SELECT * FROM waiting_steps WHERE run_id = ?").get(runId) as
        | { step_name: string }
        | undefined;
      expect(row?.step_name).toBe("w1");
      dbA.close();
    }

    // ── Phase B: new process — new DB handle, new Executor, emit event ────
    {
      const dbB = openDatabase(dbPath);
      const qB = new RunQueue(dbB);

      const { EventDispatcher } = await import("./triggers/event.js");
      const dispatcher = new EventDispatcher({
        queue: qB,
        db: dbB,
        now: () => new Date("2026-04-15T00:01:00.000Z"),
      });
      const emit = dispatcher.emit({
        type: "order.shipped",
        payload: { tracking: "1Z999" },
        correlationId: "order-42",
      });
      expect(emit.resolvedWaitingSteps).toHaveLength(1);
      const runId = emit.resolvedWaitingSteps[0]!.runId;

      // Re-run the workflow from a fresh Executor — proves state was durable.
      const mod = makeCtxIntegration("stub", {
        wait: async (_input, ctx) => {
          const step = (ctx as OperationContext & {
            step: import("./executor.js").StepContext;
          }).step;
          return await step.waitForEvent("w1", {
            eventType: "order.shipped",
            matchCorrelationId: "order-42",
            timeoutMs: 60_000,
          });
        },
      });
      const execB = new Executor({
        db: dbB,
        integrationLoader: makeLoader({ stub: mod }),
        now: () => new Date("2026-04-15T00:01:00.000Z"),
      });
      const workflow = makeWorkflow([
        { id: "n-wait", integration: "stub", operation: "wait", config: {}, onError: "fail" },
      ]);
      qB.claim();
      const r = await execB.run(workflow, runId, {});
      expect(r.status).toBe("success");
      const step = r.steps.find((s) => s.step_name === "n-wait");
      const output = JSON.parse(step!.output ?? "null") as {
        event: { type: string; payload: { tracking: string } };
      };
      expect(output.event.type).toBe("order.shipped");
      expect(output.event.payload.tracking).toBe("1Z999");
      dbB.close();
    }

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("replay: still-pending waiting_steps row suspends again (deterministic)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-w");
    q.claim();

    let calls = 0;
    const mod = makeCtxIntegration("stub", {
      wait: async (_input, ctx) => {
        calls++;
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.waitForEvent("w", {
          eventType: "x",
          timeoutMs: 60_000,
        });
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-wait", integration: "stub", operation: "wait", config: {}, onError: "fail" },
    ]);

    const r1 = await exec.run(workflow, runId, {});
    expect(r1.status).toBe("waiting");
    expect(calls).toBe(1);

    // No event arrived. Replay.
    q.claim();
    const r2 = await exec.run(workflow, runId, {});
    expect(r2.status).toBe("waiting");
    expect(calls).toBe(2);

    // Waiting_steps row is still the SAME (not duplicated).
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM waiting_steps WHERE run_id = ?`)
      .get(runId) as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });
});
