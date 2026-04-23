import { describe, expect, it, vi } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  Workflow,
} from "@delightfulchorus/core";
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

function makeWorkflow(
  nodes: Workflow["nodes"],
  connections: Workflow["connections"] = [],
): Workflow {
  return {
    id: "wf-test",
    name: "test",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections,
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

// ─── step.askUser: durable HITL primitive ──────────────────────────────────
//
// step.askUser builds on step.waitForEvent — these tests verify the
// askUser-specific glue (descriptor persistence, answer unwrapping,
// validation handoff to the webhook) without re-testing the underlying
// memoization (already covered by the waitForEvent block above).

describe("Executor — step.askUser (durable HITL)", () => {
  it("first pass: persists an AskUserDescriptor in match_payload + suspends", async () => {
    const { z } = await import("zod");
    const { parseAskUserDescriptor, askUserEventType } = await import(
      "./schema-validate.js"
    );

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-ask");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      pickSize: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.askUser(
          "ask-size",
          "Pick a size",
          z.object({ size: z.enum(["S", "M", "L"]) }),
        );
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-ask", integration: "stub", operation: "pickSize", config: {}, onError: "fail" },
    ]);

    const r = await exec.run(workflow, runId, {});
    expect(r.status).toBe("waiting");
    expect(r.waitingOn?.eventType).toBe(askUserEventType(runId, "ask-size"));

    const row = db
      .prepare(`SELECT * FROM waiting_steps WHERE run_id = ?`)
      .get(runId) as { match_payload: string; event_type: string };
    expect(row.event_type).toBe(askUserEventType(runId, "ask-size"));
    const desc = parseAskUserDescriptor(row.match_payload);
    expect(desc?.kind).toBe("askUser");
    expect(desc?.prompt).toBe("Pick a size");
    expect(desc?.schema.kind).toBe("zod-runtime");
    db.close();
  });

  it("happy path via webhook: emits, resolves, replay returns the answer", async () => {
    // End-to-end flow: handler parks → webhook resumes → handler returns.
    const Fastify = (await import("fastify")).default;
    const { registerAskRoutes } = await import("./ask-routes.js");
    const { EventDispatcher } = await import("./triggers/event.js");

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-ask");
    q.claim();

    let returned: unknown = undefined;
    const mod = makeCtxIntegration("stub", {
      pickSize: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        const answer = await step.askUser("ask-size", "Pick", {
          type: "string",
          enum: ["S", "M", "L"],
        });
        returned = answer;
        return { ok: true, answer };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-ask", integration: "stub", operation: "pickSize", config: {}, onError: "fail" },
    ]);

    // First pass — suspend.
    const first = await exec.run(workflow, runId, {});
    expect(first.status).toBe("waiting");

    // Stand up a fastify with the ask route + a real dispatcher tied to
    // the same db & queue.
    const dispatcher = new EventDispatcher({ queue: q, db });
    const app = Fastify({ logger: false });
    registerAskRoutes(app, db, { dispatcher });

    const res = await app.inject({
      method: "POST",
      url: `/ask/${runId}/ask-size`,
      payload: { answer: "M" },
    });
    expect(res.statusCode).toBe(202);
    await app.close();

    // Replay — handler runs again; askUser returns "M" without re-parking.
    q.claim();
    const second = await exec.run(workflow, runId, {});
    expect(second.status).toBe("success");
    expect(returned).toBe("M");
    const node = second.steps.find((s) => s.step_name === "n-ask");
    const out = JSON.parse(node!.output ?? "null") as { ok: boolean; answer: string };
    expect(out.answer).toBe("M");
    db.close();
  });

  it("schema mismatch from the webhook does NOT resolve the row, replay still parks", async () => {
    const Fastify = (await import("fastify")).default;
    const { registerAskRoutes } = await import("./ask-routes.js");
    const { EventDispatcher } = await import("./triggers/event.js");

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-ask");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      pickSize: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.askUser("ask", "Pick", {
          type: "string",
          enum: ["S", "M", "L"],
        });
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-ask", integration: "stub", operation: "pickSize", config: {}, onError: "fail" },
    ]);

    const first = await exec.run(workflow, runId, {});
    expect(first.status).toBe("waiting");

    const dispatcher = new EventDispatcher({ queue: q, db });
    const app = Fastify({ logger: false });
    registerAskRoutes(app, db, { dispatcher });

    // Bad answer.
    const bad = await app.inject({
      method: "POST",
      url: `/ask/${runId}/ask`,
      payload: { answer: "XL" },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();

    // Replay — still suspended.
    q.claim();
    const second = await exec.run(workflow, runId, {});
    expect(second.status).toBe("waiting");

    const w = db
      .prepare(`SELECT * FROM waiting_steps WHERE run_id = ?`)
      .get(runId) as { resolved_at: string | null };
    expect(w.resolved_at).toBeNull();
    db.close();
  });

  it("memoization: replay during park does not duplicate the descriptor row (RULE 13)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-ask");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      pickSize: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.askUser("ask", "Q", { type: "string" });
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-ask", integration: "stub", operation: "pickSize", config: {}, onError: "fail" },
    ]);

    await exec.run(workflow, runId, {});
    q.claim();
    await exec.run(workflow, runId, {});
    q.claim();
    await exec.run(workflow, runId, {});

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM waiting_steps WHERE run_id = ?`)
      .get(runId) as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("times out cleanly — subsequent run() throws WaitForEventTimeoutError (default 24h, override to 1s)", async () => {
    const { EventDispatcher } = await import("./triggers/event.js");
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-ask");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      pickSize: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return await step.askUser("ask", "Q", { type: "string" }, { timeoutMs: 1000 });
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "n-ask", integration: "stub", operation: "pickSize", config: {}, onError: "fail" },
    ]);

    const first = await exec.run(workflow, runId, {});
    expect(first.status).toBe("waiting");

    // Advance clock past the deadline using the dispatcher.
    const dispatcher = new EventDispatcher({
      queue: q,
      db,
      now: () => new Date("2026-04-22T00:05:00.000Z"),
    });
    const expired = dispatcher.expireWaitingSteps();
    expect(expired).toHaveLength(1);

    q.claim();
    const second = await exec.run(workflow, runId, {});
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/timed out/i);
    db.close();
  });

  it("CRITICAL restart-during-park: new Executor instance + new DB handle resumes from webhook answer", async () => {
    // Mirror the existing waitForEvent restart test, but with askUser.
    const path = await import("node:path");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const crypto = await import("node:crypto");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chorus-askU-"));
    const dbPath = path.join(tmp, "chorus.db");

    // Phase A: handler suspends.
    let runId = "";
    {
      const dbA = openDatabase(dbPath);
      const qA = new RunQueue(dbA);
      runId = "run-restart-" + crypto.randomUUID();
      qA.enqueue("wf-restart", { id: runId });
      qA.claim();

      const mod = makeCtxIntegration("stub", {
        pickColor: async (_input, ctx) => {
          const step = (ctx as OperationContext & {
            step: import("./executor.js").StepContext;
          }).step;
          return await step.askUser("ask-color", "Color?", {
            type: "string",
            enum: ["red", "green", "blue"],
          });
        },
      });
      const execA = new Executor({
        db: dbA,
        integrationLoader: makeLoader({ stub: mod }),
        now: () => new Date("2026-04-22T00:00:00.000Z"),
      });
      const wf = makeWorkflow([
        { id: "n", integration: "stub", operation: "pickColor", config: {}, onError: "fail" },
      ]);
      const r = await execA.run(wf, runId, {});
      expect(r.status).toBe("waiting");
      dbA.close();
    }

    // Phase B: new process — fresh DB handle, fresh server, webhook arrives,
    // new executor instance replays.
    {
      const Fastify = (await import("fastify")).default;
      const { registerAskRoutes } = await import("./ask-routes.js");
      const { EventDispatcher } = await import("./triggers/event.js");

      const dbB = openDatabase(dbPath);
      const qB = new RunQueue(dbB);
      const dispatcher = new EventDispatcher({
        queue: qB,
        db: dbB,
        now: () => new Date("2026-04-22T00:01:00.000Z"),
      });
      const app = Fastify({ logger: false });
      registerAskRoutes(app, dbB, { dispatcher });

      const webhook = await app.inject({
        method: "POST",
        url: `/ask/${runId}/ask-color`,
        payload: { answer: "blue" },
      });
      expect(webhook.statusCode).toBe(202);
      await app.close();

      const mod = makeCtxIntegration("stub", {
        pickColor: async (_input, ctx) => {
          const step = (ctx as OperationContext & {
            step: import("./executor.js").StepContext;
          }).step;
          return await step.askUser("ask-color", "Color?", {
            type: "string",
            enum: ["red", "green", "blue"],
          });
        },
      });
      const execB = new Executor({
        db: dbB,
        integrationLoader: makeLoader({ stub: mod }),
        now: () => new Date("2026-04-22T00:01:00.000Z"),
      });
      const wf = makeWorkflow([
        { id: "n", integration: "stub", operation: "pickColor", config: {}, onError: "fail" },
      ]);
      qB.claim();
      const r = await execB.run(wf, runId, {});
      expect(r.status).toBe("success");
      const node = r.steps.find((s) => s.step_name === "n");
      const out = JSON.parse(node!.output ?? "null") as string;
      expect(out).toBe("blue");
      dbB.close();
    }

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("two parallel asks in one workflow do not cross-talk (unique event types)", async () => {
    const Fastify = (await import("fastify")).default;
    const { registerAskRoutes } = await import("./ask-routes.js");
    const { EventDispatcher } = await import("./triggers/event.js");

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-2-asks");
    q.claim();

    let collected: { color?: string; size?: string } = {};
    const mod = makeCtxIntegration("stub", {
      pickColor: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        const color = await step.askUser("ask-color", "Color?", {
          type: "string",
          enum: ["red", "green", "blue"],
        });
        collected.color = color as string;
        return { color };
      },
      pickSize: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        const size = await step.askUser("ask-size", "Size?", {
          type: "string",
          enum: ["S", "M", "L"],
        });
        collected.size = size as string;
        return { size };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const workflow = makeWorkflow([
      { id: "color", integration: "stub", operation: "pickColor", config: {}, onError: "fail" },
      { id: "size", integration: "stub", operation: "pickSize", config: {}, onError: "fail" },
    ]);

    // First pass: parks on the FIRST ask (executor walks nodes in order).
    const first = await exec.run(workflow, runId, {});
    expect(first.status).toBe("waiting");
    expect(first.waitingOn?.stepName).toBe("ask-color");

    // Answer color first.
    const dispatcher = new EventDispatcher({ queue: q, db });
    const app = Fastify({ logger: false });
    registerAskRoutes(app, db, { dispatcher });
    const r1 = await app.inject({
      method: "POST",
      url: `/ask/${runId}/ask-color`,
      payload: { answer: "blue" },
    });
    expect(r1.statusCode).toBe(202);

    // Replay — first node memoized, second now parks.
    q.claim();
    const second = await exec.run(workflow, runId, {});
    expect(second.status).toBe("waiting");
    expect(second.waitingOn?.stepName).toBe("ask-size");

    // Answer size — the unique event type means color row is unaffected.
    const r2 = await app.inject({
      method: "POST",
      url: `/ask/${runId}/ask-size`,
      payload: { answer: "M" },
    });
    expect(r2.statusCode).toBe(202);
    await app.close();

    // Replay — both memoized, success.
    q.claim();
    const third = await exec.run(workflow, runId, {});
    expect(third.status).toBe("success");
    expect(collected.color).toBe("blue");
    expect(collected.size).toBe("M");
    db.close();
  });
});

// ─── Connection.when? conditional routing ──────────────────────────────────
//
// A Connection may carry a jexl-style expression in `when?`. Before the
// target node runs, the expression is evaluated against the source node's
// output (`result`) and the run's trigger payload (`input`). If the
// expression is falsy the edge is skipped; if every incoming edge is
// skipped, the target node itself is skipped.

describe("Executor — Connection.when? conditional edge routing", () => {
  it("takes an edge when `when?` evaluates truthy", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      check: async () => {
        calls.push("check");
        return { status: "ok" };
      },
      next: async () => {
        calls.push("next");
        return { done: true };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow(
      [
        { id: "A", integration: "stub", operation: "check", config: {}, onError: "fail" },
        { id: "B", integration: "stub", operation: "next", config: {}, onError: "fail" },
      ],
      [{ from: "A", to: "B", when: "result.status == 'ok'" }],
    );

    const res = await exec.run(workflow, runId, { event: "trigger" });
    expect(res.status).toBe("success");
    expect(calls).toEqual(["check", "next"]);
    db.close();
  });

  it("skips an edge when `when?` evaluates falsy → target is skipped", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      check: async () => {
        calls.push("check");
        return { status: "fail" };
      },
      next: async () => {
        calls.push("next");
        return { done: true };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow(
      [
        { id: "A", integration: "stub", operation: "check", config: {}, onError: "fail" },
        { id: "B", integration: "stub", operation: "next", config: {}, onError: "fail" },
      ],
      [{ from: "A", to: "B", when: "result.status == 'ok'" }],
    );

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(calls).toEqual(["check"]);
    // B was skipped — only A wrote a step row.
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]?.step_name).toBe("A");
    db.close();
  });

  it("diamond branching: two conditional edges → only the matching path runs", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      route: async () => {
        calls.push("route");
        return { tier: "gold" };
      },
      goldPath: async () => {
        calls.push("gold");
        return { tier: "gold-handled" };
      },
      silverPath: async () => {
        calls.push("silver");
        return { tier: "silver-handled" };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow(
      [
        { id: "router", integration: "stub", operation: "route", config: {}, onError: "fail" },
        { id: "gold", integration: "stub", operation: "goldPath", config: {}, onError: "fail" },
        { id: "silver", integration: "stub", operation: "silverPath", config: {}, onError: "fail" },
      ],
      [
        { from: "router", to: "gold", when: "result.tier == 'gold'" },
        { from: "router", to: "silver", when: "result.tier == 'silver'" },
      ],
    );

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(calls).toEqual(["route", "gold"]);
    expect(calls).not.toContain("silver");
    db.close();
  });

  it("no `when?` on a connection → edge always taken (back-compat)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      one: async () => {
        calls.push("one");
        return { any: "value" };
      },
      two: async () => {
        calls.push("two");
        return { any: "value" };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow(
      [
        { id: "A", integration: "stub", operation: "one", config: {}, onError: "fail" },
        { id: "B", integration: "stub", operation: "two", config: {}, onError: "fail" },
      ],
      // Connection declared but no `when?` clause — unconditional edge.
      [{ from: "A", to: "B" }],
    );

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(calls).toEqual(["one", "two"]);
    db.close();
  });

  it("malformed `when?` → logs warning, skips the edge (fail-closed)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const warn = vi.fn();
    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      a: async () => {
        calls.push("a");
        return { x: 1 };
      },
      b: async () => {
        calls.push("b");
        return { x: 2 };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    });
    const workflow = makeWorkflow(
      [
        { id: "A", integration: "stub", operation: "a", config: {}, onError: "fail" },
        { id: "B", integration: "stub", operation: "b", config: {}, onError: "fail" },
      ],
      // Malformed jexl — extra braces.
      [{ from: "A", to: "B", when: "result. ))) {{{" }],
    );

    const res = await exec.run(workflow, runId, {});
    // Run as a whole still succeeds — the malformed expression does NOT
    // crash the run. Instead B is skipped, and a warning is logged.
    expect(res.status).toBe("success");
    expect(calls).toEqual(["a"]);
    expect(warn).toHaveBeenCalled();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("when-eval")),
    ).toBe(true);
    db.close();
  });

  it("workflow with no connections at all → all nodes run in order (pre-when? behavior preserved)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-test");
    q.claim();

    const calls: string[] = [];
    const mod = makeIntegration("stub", {
      foo: async () => {
        calls.push("foo");
        return { k: 1 };
      },
      bar: async () => {
        calls.push("bar");
        return { k: 2 };
      },
      baz: async () => {
        calls.push("baz");
        return { k: 3 };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow(
      [
        { id: "a", integration: "stub", operation: "foo", config: {}, onError: "fail" },
        { id: "b", integration: "stub", operation: "bar", config: {}, onError: "fail" },
        { id: "c", integration: "stub", operation: "baz", config: {}, onError: "fail" },
      ],
      // No connections — classic linear MVP flow.
      [],
    );
    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(calls).toEqual(["foo", "bar", "baz"]);
    db.close();
  });
});

// ─── step.memory.get/set — durable per-workflow KV ─────────────────────────
//
// The memory primitive gives handlers a durable, scoped KV store they can
// use to carry state across runs of the same workflow. Scope is always
// (workflow_id, user_id?) — two different workflows, and two different
// users of the same workflow, don't see each other's data.
//
// Both get/set are routed through `step.run(...)` so a crash mid-write
// re-executes idempotently on replay.

describe("Executor — step.memory (durable per-workflow KV)", () => {
  it("set then get round-trips within a single run", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-mem");
    q.claim();

    let observed: unknown;
    const mod = makeCtxIntegration("stub", {
      roundtrip: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        await step.memory.set("greeting", "hello");
        observed = await step.memory.get("greeting");
        return { observed };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow([
      { id: "n", integration: "stub", operation: "roundtrip", config: {}, onError: "fail" },
    ]);
    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(observed).toBe("hello");
    db.close();
  });

  it("persists across runs of the same workflow (run 1 sets; run 2 reads)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);

    const mod1 = makeCtxIntegration("stub", {
      bump: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        const prev = (await step.memory.get("counter")) as number | null;
        const next = (prev ?? 0) + 1;
        await step.memory.set("counter", next);
        return { counter: next };
      },
    });
    const exec1 = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod1 }),
    });
    const workflow = makeWorkflow([
      { id: "n", integration: "stub", operation: "bump", config: {}, onError: "fail" },
    ]);

    // Run #1: counter → 1
    const r1Id = q.enqueue("wf-counter", { id: "run-1" });
    q.claim();
    const r1 = await exec1.run(
      { ...workflow, id: "wf-counter" },
      r1Id,
      {},
    );
    expect(r1.status).toBe("success");
    const out1 = JSON.parse(r1.steps.find((s) => s.step_name === "n")!.output ?? "null") as {
      counter: number;
    };
    expect(out1.counter).toBe(1);

    // Run #2: counter → 2 (inherits from run #1's set)
    const r2Id = q.enqueue("wf-counter", { id: "run-2" });
    q.claim();
    const r2 = await exec1.run(
      { ...workflow, id: "wf-counter" },
      r2Id,
      {},
    );
    expect(r2.status).toBe("success");
    const out2 = JSON.parse(r2.steps.find((s) => s.step_name === "n")!.output ?? "null") as {
      counter: number;
    };
    expect(out2.counter).toBe(2);
    db.close();
  });

  it("get on an unset key returns null", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-mem");
    q.claim();

    let observed: unknown = "UNSET";
    const mod = makeCtxIntegration("stub", {
      peek: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        observed = await step.memory.get("never-set");
        return { observed };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow([
      { id: "n", integration: "stub", operation: "peek", config: {}, onError: "fail" },
    ]);
    await exec.run(workflow, runId, {});
    expect(observed).toBeNull();
    db.close();
  });

  it("scopes by workflow_id: two workflows don't share memory", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);

    const mod = makeCtxIntegration("stub", {
      setA: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        await step.memory.set("shared", "a-value");
        return { ok: true };
      },
      readB: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return { val: await step.memory.get("shared") };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const baseWf = makeWorkflow([
      { id: "n", integration: "stub", operation: "setA", config: {}, onError: "fail" },
    ]);
    const wfA = { ...baseWf, id: "wf-A" };
    const wfB = {
      ...makeWorkflow([
        { id: "n", integration: "stub", operation: "readB", config: {}, onError: "fail" },
      ]),
      id: "wf-B",
    };

    const r1 = q.enqueue("wf-A");
    q.claim();
    await exec.run(wfA, r1, {});

    const r2 = q.enqueue("wf-B");
    q.claim();
    const res = await exec.run(wfB, r2, {});
    const out = JSON.parse(res.steps[0]!.output ?? "null") as { val: unknown };
    expect(out.val).toBeNull(); // wf-B can't see wf-A's memory
    db.close();
  });

  it("scopes by user_id (from triggerPayload.userId): different users isolated", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);

    const mod = makeCtxIntegration("stub", {
      dump: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        await step.memory.set("prefs", { theme: "dark" });
        return { ok: true };
      },
      read: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return { val: await step.memory.get("prefs") };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const writer = {
      ...makeWorkflow([
        { id: "n", integration: "stub", operation: "dump", config: {}, onError: "fail" },
      ]),
      id: "wf-users",
    };
    const reader = {
      ...makeWorkflow([
        { id: "n", integration: "stub", operation: "read", config: {}, onError: "fail" },
      ]),
      id: "wf-users",
    };

    // User A writes.
    const r1 = q.enqueue("wf-users");
    q.claim();
    await exec.run(writer, r1, { userId: "user-a" });

    // User B reads — should see nothing because user-a's row is scoped.
    const r2 = q.enqueue("wf-users");
    q.claim();
    const resB = await exec.run(reader, r2, { userId: "user-b" });
    const outB = JSON.parse(resB.steps[0]!.output ?? "null") as { val: unknown };
    expect(outB.val).toBeNull();

    // User A reads — should see its own row.
    const r3 = q.enqueue("wf-users");
    q.claim();
    const resA = await exec.run(reader, r3, { userId: "user-a" });
    const outA = JSON.parse(resA.steps[0]!.output ?? "null") as { val: { theme: string } };
    expect(outA.val?.theme).toBe("dark");
    db.close();
  });

  it("memory.get/set are memoized per-run (replay short-circuits re-execution)", async () => {
    // This test exercises the durability contract: if a handler calls
    // set() inside a step that's later retried/replayed, the write is
    // recorded once and NOT reapplied — the memoized step-output (null)
    // short-circuits the handler re-invocation.
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-mem");
    q.claim();

    let setCalls = 0;
    const mod = makeCtxIntegration("stub", {
      write: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        await step.memory.set("k", ++setCalls);
        return { done: true };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow([
      { id: "n", integration: "stub", operation: "write", config: {}, onError: "fail" },
    ]);

    await exec.run(workflow, runId, {});
    expect(setCalls).toBe(1);

    // Replay: node "n" is memoized as success, so the handler doesn't
    // re-execute at all. setCalls must still be 1.
    await exec.run(workflow, runId, {});
    expect(setCalls).toBe(1);
    db.close();
  });

  it("accepts JSON-safe values: objects, arrays, numbers, booleans, null", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-mem");
    q.claim();

    let observedObj: unknown;
    let observedArr: unknown;
    let observedNum: unknown;
    let observedBool: unknown;
    let observedNull: unknown;
    const mod = makeCtxIntegration("stub", {
      types: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        await step.memory.set("obj", { a: 1, b: "two" });
        await step.memory.set("arr", [1, 2, 3]);
        await step.memory.set("num", 42);
        await step.memory.set("bool", true);
        await step.memory.set("null", null);
        observedObj = await step.memory.get("obj");
        observedArr = await step.memory.get("arr");
        observedNum = await step.memory.get("num");
        observedBool = await step.memory.get("bool");
        observedNull = await step.memory.get("null");
        return { ok: true };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const workflow = makeWorkflow([
      { id: "n", integration: "stub", operation: "types", config: {}, onError: "fail" },
    ]);
    await exec.run(workflow, runId, {});
    expect(observedObj).toEqual({ a: 1, b: "two" });
    expect(observedArr).toEqual([1, 2, 3]);
    expect(observedNum).toBe(42);
    expect(observedBool).toBe(true);
    expect(observedNull).toBeNull();
    db.close();
  });

  it("falls back to workflow-global scope when triggerPayload has no userId", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);

    const mod = makeCtxIntegration("stub", {
      write: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        await step.memory.set("k", "global");
        return { ok: true };
      },
      read: async (_input, ctx) => {
        const step = (ctx as OperationContext & {
          step: import("./executor.js").StepContext;
        }).step;
        return { val: await step.memory.get("k") };
      },
    });
    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ stub: mod }),
    });
    const writer = {
      ...makeWorkflow([
        { id: "n", integration: "stub", operation: "write", config: {}, onError: "fail" },
      ]),
      id: "wf-nou",
    };
    const reader = {
      ...makeWorkflow([
        { id: "n", integration: "stub", operation: "read", config: {}, onError: "fail" },
      ]),
      id: "wf-nou",
    };
    const r1 = q.enqueue("wf-nou");
    q.claim();
    await exec.run(writer, r1, {}); // no userId → null scope
    const r2 = q.enqueue("wf-nou");
    q.claim();
    const res = await exec.run(reader, r2, {}); // no userId → same null scope
    const out = JSON.parse(res.steps[0]!.output ?? "null") as { val: unknown };
    expect(out.val).toBe("global");
    db.close();
  });
});
