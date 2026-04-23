import { describe, expect, it } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  Workflow,
} from "@delightfulchorus/core";
import { openDatabase } from "./db.js";
import { RunQueue } from "./queue.js";
import { Executor, type IntegrationLoader, type StepContext } from "./executor.js";

/**
 * Tests for `step.fanOut(name, items, fn)` — Wave 2 item 7.
 *
 * Coverage:
 *   1. Happy path — 10 items, ordered results.
 *   2. Empty input — returns [].
 *   3. Single item — degenerate case still creates one child step row.
 *   4. Parallel timing — 3 children with 100ms sleeps complete in <200ms wall.
 *   5. Partial failure + rerun — failed children re-execute on replay,
 *      cached children short-circuit.
 *   6. AggregateError surface — failed children carry their original errors.
 *   7. SuspendForEvent inside a child propagates as a normal park.
 *   8. Per-child write serialization — N parallel children all produce
 *      well-formed step rows with no torn writes.
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
    id: "wf-fan",
    name: "fan-out-test",
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

describe("step.fanOut — happy path", () => {
  it("runs 10 children in parallel and returns results in input order", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    const captured: number[] = [];
    const mod = makeCtxIntegration("stub", {
      go: async (_input, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        const items = Array.from({ length: 10 }, (_, i) => i);
        const results = await step.fanOut("scrape", items, async (item, idx) => {
          captured.push(item);
          return { item, idx, doubled: item * 2 };
        });
        return { results };
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    const res = await exec.run(wf, runId, {});
    expect(res.status).toBe("success");

    const out = JSON.parse(res.steps[0]!.output ?? "null") as {
      results: Array<{ item: number; idx: number; doubled: number }>;
    };
    expect(out.results).toHaveLength(10);
    // Order preserved.
    for (let i = 0; i < 10; i++) {
      expect(out.results[i]).toEqual({ item: i, idx: i, doubled: i * 2 });
    }
    // All children invoked exactly once each (no skipped, no doubled).
    expect(captured.sort((a, b) => a - b)).toEqual(items());

    // Verify per-child step rows were written.
    const stepRows = db
      .prepare(`SELECT step_name, status FROM steps WHERE run_id = ? ORDER BY step_name`)
      .all(runId) as Array<{ step_name: string; status: string }>;
    // Outer node 'n1' + 10 fanOut children 'scrape.0'..'scrape.9'.
    expect(stepRows).toHaveLength(11);
    for (let i = 0; i < 10; i++) {
      const row = stepRows.find((r) => r.step_name === `scrape.${i}`);
      expect(row, `expected scrape.${i} row`).toBeDefined();
      expect(row!.status).toBe("success");
    }
    db.close();
  });
});

function items(): number[] {
  return Array.from({ length: 10 }, (_, i) => i);
}

describe("step.fanOut — degenerate inputs", () => {
  it("empty items returns [] and writes no child step rows", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    let invoked = 0;
    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        const out = await step.fanOut("empty", [], async () => {
          invoked++;
          return 1;
        });
        return { count: out.length };
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    const res = await exec.run(wf, runId, {});
    expect(res.status).toBe("success");
    expect(invoked).toBe(0);
    const out = JSON.parse(res.steps[0]!.output ?? "null") as { count: number };
    expect(out.count).toBe(0);

    // Only the outer node row, no fanOut children.
    const stepRows = db
      .prepare(`SELECT step_name FROM steps WHERE run_id = ?`)
      .all(runId) as Array<{ step_name: string }>;
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]!.step_name).toBe("n1");
    db.close();
  });

  it("single item still produces one memoized child step row", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        return await step.fanOut("solo", ["only"], async (item) => `got:${item}`);
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    const res = await exec.run(wf, runId, {});
    expect(res.status).toBe("success");
    const out = JSON.parse(res.steps[0]!.output ?? "null") as string[];
    expect(out).toEqual(["got:only"]);

    const childRow = db
      .prepare(`SELECT step_name, status FROM steps WHERE run_id = ? AND step_name = 'solo.0'`)
      .get(runId) as { step_name: string; status: string };
    expect(childRow.status).toBe("success");
    db.close();
  });
});

describe("step.fanOut — parallel execution timing", () => {
  it("3 children with 100ms sleeps complete in ~100ms wall (NOT 300ms)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        return await step.fanOut("slow", [1, 2, 3], async (item) => {
          await new Promise((r) => setTimeout(r, 100));
          return item * 10;
        });
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    const t0 = Date.now();
    const res = await exec.run(wf, runId, {});
    const elapsed = Date.now() - t0;

    expect(res.status).toBe("success");
    // Sequential would be ~300ms (3 × 100ms). Parallel should be ~100ms +
    // overhead. We allow a generous ceiling (250ms) to account for slow CI
    // boxes / vitest overhead, but it must be well under 300ms to prove
    // parallelism.
    expect(elapsed).toBeLessThan(250);
    expect(elapsed).toBeGreaterThanOrEqual(95); // sanity floor

    const out = JSON.parse(res.steps[0]!.output ?? "null") as number[];
    expect(out).toEqual([10, 20, 30]);
    db.close();
  });
});

describe("step.fanOut — partial failure + rerun memoization", () => {
  it("failed child re-executes on rerun; cached children replay from memo", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    // Track per-item invocation counts so we can assert which children
    // re-ran on the second exec.run() call.
    const invocations: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    let shouldFailIdx1 = true;

    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        return await step.fanOut("flaky", [0, 1, 2], async (item) => {
          invocations[item] = (invocations[item] ?? 0) + 1;
          if (item === 1 && shouldFailIdx1) {
            throw new Error("transient idx=1 failure");
          }
          return item * 100;
        });
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    // First run: idx=1 fails. The outer node 'n1' inherits its retry budget
    // (DEFAULT_RETRY = 3 attempts), so the handler will be invoked 3 times.
    // Each attempt re-runs the fanOut: indices 0, 1, 2 each fire 3 times
    // on attempt 1 — but successful indices 0 and 2 cache after attempt 1.
    // So expectation: idx 0 invoked 1x (cached on attempts 2/3), idx 1
    // invoked 3x (always fails, never cached), idx 2 invoked 1x.
    const r1 = await exec.run(wf, runId, {});
    expect(r1.status).toBe("failed");
    expect(invocations[0]).toBe(1);
    expect(invocations[1]).toBe(3);
    expect(invocations[2]).toBe(1);

    // Verify step row state on disk: 0 and 2 success, 1 failed.
    const rowFor = (n: string) =>
      db
        .prepare(`SELECT status FROM steps WHERE run_id = ? AND step_name = ?`)
        .get(runId, n) as { status: string } | undefined;
    expect(rowFor("flaky.0")?.status).toBe("success");
    expect(rowFor("flaky.1")?.status).toBe("failed");
    expect(rowFor("flaky.2")?.status).toBe("success");

    // Now flip the failure switch so idx=1 succeeds on rerun.
    shouldFailIdx1 = false;

    // Reset invocation counters and rerun the SAME runId — replay path.
    invocations[0] = 0;
    invocations[1] = 0;
    invocations[2] = 0;

    const r2 = await exec.run(wf, runId, {});
    expect(r2.status).toBe("success");
    // idx 0 + 2 cached (success rows from previous run) → 0 invocations.
    // idx 1 was failed (not success) → re-executes.
    expect(invocations[0]).toBe(0);
    expect(invocations[1]).toBe(1);
    expect(invocations[2]).toBe(0);

    // All three children now success on disk.
    expect(rowFor("flaky.0")?.status).toBe("success");
    expect(rowFor("flaky.1")?.status).toBe("success");
    expect(rowFor("flaky.2")?.status).toBe("success");

    db.close();
  });

  it("AggregateError carries each child's original Error in input order", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    let captured: unknown = null;
    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        try {
          await step.fanOut("multi-fail", [0, 1, 2, 3], async (item) => {
            if (item === 1) throw new Error("err one");
            if (item === 3) throw new Error("err three");
            return item;
          });
          return { ok: true };
        } catch (err) {
          captured = err;
          throw err;
        }
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      // onError: 'fail' so the node doesn't retry — we want to inspect
      // the FIRST aggregate error cleanly.
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "fail" },
    ]);

    const res = await exec.run(wf, runId, {});
    expect(res.status).toBe("failed");

    expect(captured).toBeInstanceOf(AggregateError);
    const ag = captured as AggregateError;
    expect(ag.errors).toHaveLength(2);
    // Errors carried in failure order (idx 1 first, idx 3 second).
    expect((ag.errors[0] as Error).message).toBe("err one");
    expect((ag.errors[1] as Error).message).toBe("err three");
    expect(ag.message).toContain("multi-fail.1");
    expect(ag.message).toContain("multi-fail.3");
    expect(ag.message).toContain("2/4");
    db.close();
  });
});

describe("step.fanOut — suspension propagation", () => {
  it("a child calling waitForEvent parks the parent run cleanly", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        return await step.fanOut("park-test", [0, 1, 2], async (item) => {
          if (item === 1) {
            // This child parks — the others should still get a chance to
            // start, but the overall fanOut returns suspension.
            await step.waitForEvent("park-test.1.wait", {
              eventType: "external-thing",
              timeoutMs: 60_000,
            });
          }
          return item;
        });
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    const res = await exec.run(wf, runId, {});
    expect(res.status).toBe("waiting");
    expect(res.waitingOn?.eventType).toBe("external-thing");
    db.close();
  });
});

describe("step.fanOut — write serialization safety", () => {
  it("20 parallel children all produce well-formed success rows", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-fan");
    q.claim();

    const N = 20;
    const mod = makeCtxIntegration("stub", {
      go: async (_i, ctx) => {
        const step = (ctx as OperationContext & { step: StepContext }).step;
        const items = Array.from({ length: N }, (_, i) => i);
        return await step.fanOut("burst", items, async (item) => {
          // Tiny varying delays to force interleaving across children.
          await new Promise((r) => setTimeout(r, item % 5));
          return item;
        });
      },
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub: mod }) });
    const wf = makeWorkflow([
      { id: "n1", integration: "stub", operation: "go", config: {}, onError: "retry" },
    ]);

    const res = await exec.run(wf, runId, {});
    expect(res.status).toBe("success");

    const rows = db
      .prepare(
        `SELECT step_name, status, started_at, finished_at, duration_ms
         FROM steps WHERE run_id = ? AND step_name LIKE 'burst.%'
         ORDER BY step_name`,
      )
      .all(runId) as Array<{
      step_name: string;
      status: string;
      started_at: string | null;
      finished_at: string | null;
      duration_ms: number | null;
    }>;
    expect(rows).toHaveLength(N);
    for (const row of rows) {
      expect(row.status).toBe("success");
      // Every row should have both timestamps filled in (no torn writes
      // where a row got stuck in 'running' but never finished).
      expect(row.started_at).toBeTruthy();
      expect(row.finished_at).toBeTruthy();
      expect(row.duration_ms).not.toBeNull();
    }
    db.close();
  });
});
