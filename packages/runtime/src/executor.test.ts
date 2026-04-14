import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifest, IntegrationModule, Workflow } from "@chorus/core";
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
