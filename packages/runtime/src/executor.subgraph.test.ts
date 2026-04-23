/**
 * Integration tests for `integration: "workflow"` (subgraph composition).
 *
 * These tests use the real Executor + DB + the runtime's default
 * subgraphRunner (extracted from server.ts) to exercise:
 *   1. Single-level subgraph (parent invokes child, child runs to completion)
 *   2. Recursive subgraph (3 levels: A → B → C, all memoized correctly)
 *   3. Memoization replay (rerun parent → child not re-invoked, output cached)
 *   4. Child failure propagation
 *   5. Child runId queryable via getRunHistory
 *
 * The server.ts default runner is duplicated here as `makeDefaultSubgraphRunner`
 * to keep the test self-contained (no Fastify spin-up). Logic is identical
 * to the server.ts version — we'd ideally extract it to a separate module,
 * but for the MVP that ships with one default we keep it inline in server.ts
 * and re-implement here.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  Workflow,
} from "@delightfulchorus/core";
import workflowIntegration from "@delightfulchorus/integration-workflow";
import { openDatabase, QueryHelpers, type RunRow } from "./db.js";
import { RunQueue } from "./queue.js";
import {
  Executor,
  type IntegrationLoader,
  type SubgraphRunner,
} from "./executor.js";
import { getRunHistory } from "./fork-run.js";

// ── Test fixtures ─────────────────────────────────────────────────────────

function noopManifest(name: string, ops: string[]): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    description: "test",
    authType: "none",
    credentialTypes: [],
    operations: ops.map((op) => ({
      name: op,
      description: op,
      inputSchema: {},
      outputSchema: {},
      idempotent: true,
    })),
  };
}

function makeIntegration(
  name: string,
  operations: Record<string, (input: unknown) => Promise<unknown>>,
): IntegrationModule {
  return {
    manifest: noopManifest(name, Object.keys(operations)),
    operations: Object.fromEntries(
      Object.entries(operations).map(([op, fn]) => [op, async (input) => fn(input)]),
    ),
  };
}

function makeWorkflow(
  id: string,
  nodes: Workflow["nodes"],
  connections: Workflow["connections"] = [],
): Workflow {
  return {
    id,
    name: id,
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections,
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  };
}

function makeLoader(map: Record<string, IntegrationModule>): IntegrationLoader {
  return async (name) => {
    const mod = map[name];
    if (!mod) throw new Error(`unknown integration ${name}`);
    return mod;
  };
}

/** Mirrors server.ts's default subgraphRunner. Closure binds `executor` after
 * construction — we declare the binding with `let` and assign it before any
 * runner invocation. */
function makeDefaultSubgraphRunner(
  db: ReturnType<typeof openDatabase>,
  helpers: QueryHelpers,
  getExecutor: () => Executor,
): SubgraphRunner {
  return async (workflowId, triggerPayload, options) => {
    const wfRow = helpers.getWorkflow(workflowId, options?.version);
    if (!wfRow) {
      throw new Error(
        `subgraph: workflow "${workflowId}" not found in workflows table`,
      );
    }
    const childRunId = randomUUID();
    const nowIso = new Date().toISOString();
    const childRow: RunRow = {
      id: childRunId,
      workflow_id: wfRow.id,
      workflow_version: wfRow.version,
      status: "running",
      triggered_by: "subgraph",
      trigger_payload:
        triggerPayload === undefined ? null : JSON.stringify(triggerPayload),
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: nowIso,
      finished_at: null,
      error: null,
      attempt: 1,
    };
    helpers.insertRun(childRow);

    try {
      const childWorkflow = JSON.parse(wfRow.definition);
      const result = await getExecutor().run(
        childWorkflow,
        childRunId,
        triggerPayload,
      );
      const finishedAt = new Date().toISOString();
      if (result.status === "success") {
        db.prepare(
          `UPDATE runs SET status = 'success', finished_at = ? WHERE id = ?`,
        ).run(finishedAt, childRunId);
        const lastStep = result.steps[result.steps.length - 1];
        const output =
          lastStep && lastStep.output ? JSON.parse(lastStep.output) : null;
        return { runId: childRunId, output };
      } else if (result.status === "waiting") {
        db.prepare(
          `UPDATE runs SET status = 'waiting', finished_at = ?, error = ? WHERE id = ?`,
        ).run(finishedAt, "child run parked", childRunId);
        throw new Error(
          `subgraph: child "${workflowId}" suspended (not supported in MVP)`,
        );
      } else {
        db.prepare(
          `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
        ).run(finishedAt, result.error ?? "unknown", childRunId);
        throw new Error(
          `subgraph: child "${workflowId}" failed: ${result.error ?? "unknown"}`,
        );
      }
    } catch (err) {
      const finishedAt = new Date().toISOString();
      db.prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'`,
      ).run(finishedAt, (err as Error).message, childRunId);
      throw err;
    }
  };
}

/** Insert a workflow definition into the workflows table (so the
 * subgraphRunner can resolve it by id). */
function registerWorkflow(helpers: QueryHelpers, wf: Workflow): void {
  helpers.insertWorkflow({
    id: wf.id,
    version: wf.version,
    name: wf.name,
    definition: JSON.stringify(wf),
    active: wf.active ? 1 : 0,
    created_at: wf.createdAt,
    updated_at: wf.updatedAt,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Executor + integration-workflow — single-level subgraph", () => {
  it("invokes a child workflow and returns the child's terminal output", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    // Child workflow: a single 'echo' node that returns its input.
    const childWf = makeWorkflow("child-echo", [
      {
        id: "echo",
        integration: "echo",
        operation: "go",
        config: {},
        inputs: { greeting: "hello from child" },
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, childWf);

    // Parent workflow: a single 'workflow.invoke' node targeting the child.
    const parentWf = makeWorkflow("parent", [
      {
        id: "call-child",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "child-echo" },
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, parentWf);

    const echoMod = makeIntegration("echo", {
      go: async (input) => ({ ok: true, input }),
    });

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({
        echo: echoMod,
        workflow: workflowIntegration,
      }),
      subgraphRunner,
    });

    const parentRunId = queue.enqueue("parent");
    queue.claim();
    const result = await executor.run(parentWf, parentRunId, { from: "test" });

    expect(result.status).toBe("success");
    expect(result.steps).toHaveLength(1);
    const parentOut = JSON.parse(result.steps[0]!.output!);
    // The handler returns { output, childRunId, workflowId }.
    expect(parentOut.workflowId).toBe("child-echo");
    expect(typeof parentOut.childRunId).toBe("string");
    // The child's terminal output is the echo node's output.
    expect(parentOut.output.ok).toBe(true);
    expect(parentOut.output.input.greeting).toBe("hello from child");

    // The child run is queryable independently.
    const childRunId = parentOut.childRunId;
    const childHistory = getRunHistory(db, childRunId);
    expect(childHistory).toHaveLength(1);
    expect(childHistory[0]!.stepName).toBe("echo");
    expect(childHistory[0]!.status).toBe("success");

    db.close();
  });

  it("passes inputMapping → child trigger payload", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    let observedChildPayload: unknown;
    const reporterMod = makeIntegration("reporter", {
      report: async (input) => {
        observedChildPayload = input;
        return { received: true };
      },
    });

    const childWf = makeWorkflow("child-report", [
      {
        id: "do-report",
        integration: "reporter",
        operation: "report",
        config: {},
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, childWf);

    const parentWf = makeWorkflow("parent-mapper", [
      {
        id: "call-child",
        integration: "workflow",
        operation: "invoke",
        config: {
          workflowId: "child-report",
          inputMapping: { who: "userId", what: "action" },
        },
        inputs: {
          userId: "alice",
          action: "buy",
        },
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, parentWf);

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({
        reporter: reporterMod,
        workflow: workflowIntegration,
      }),
      subgraphRunner,
    });

    const parentRunId = queue.enqueue("parent-mapper");
    queue.claim();
    const result = await executor.run(parentWf, parentRunId, {});
    expect(result.status).toBe("success");

    // The reporter's handler input is `{ ...node.inputs, triggerPayload }`.
    // We mapped userId → who, action → what, so the child's TRIGGER PAYLOAD
    // (which becomes the reporter's triggerPayload key) should be { who, what }.
    expect(observedChildPayload).toMatchObject({
      triggerPayload: { who: "alice", what: "buy" },
    });

    db.close();
  });
});

describe("Executor + integration-workflow — recursive subgraphs", () => {
  it("supports 3 levels: A invokes B invokes C", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    // C is a leaf workflow.
    const wfC = makeWorkflow("wf-c", [
      {
        id: "leaf",
        integration: "echo",
        operation: "go",
        config: {},
        inputs: { from: "C" },
        onError: "retry",
      },
    ]);
    // B invokes C.
    const wfB = makeWorkflow("wf-b", [
      {
        id: "call-c",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "wf-c" },
        onError: "retry",
      },
    ]);
    // A invokes B.
    const wfA = makeWorkflow("wf-a", [
      {
        id: "call-b",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "wf-b" },
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, wfC);
    registerWorkflow(helpers, wfB);
    registerWorkflow(helpers, wfA);

    let echoCalls = 0;
    const echoMod = makeIntegration("echo", {
      go: async (input) => {
        echoCalls++;
        return { from: "C", input };
      },
    });

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({
        echo: echoMod,
        workflow: workflowIntegration,
      }),
      subgraphRunner,
    });

    const aRunId = queue.enqueue("wf-a");
    queue.claim();
    const result = await executor.run(wfA, aRunId, {});
    expect(result.status).toBe("success");
    expect(echoCalls).toBe(1); // C's leaf node invoked exactly once

    // Verify each level produced its own run row + step rows.
    const runsRows = db
      .prepare(
        `SELECT workflow_id, status, triggered_by FROM runs ORDER BY started_at ASC`,
      )
      .all() as Array<{ workflow_id: string; status: string; triggered_by: string }>;
    expect(runsRows).toHaveLength(3);
    // Order: parent (wf-a) inserted first by queue.enqueue, then wf-b
    // when subgraph runner spawns it, then wf-c. triggered_by tracks
    // origin: 'manual' for the parent, 'subgraph' for descendants.
    const aRow = runsRows.find((r) => r.workflow_id === "wf-a")!;
    const bRow = runsRows.find((r) => r.workflow_id === "wf-b")!;
    const cRow = runsRows.find((r) => r.workflow_id === "wf-c")!;
    expect(aRow.status).toBe("running"); // queue.complete not called in this test
    expect(aRow.triggered_by).toBe("manual");
    expect(bRow.status).toBe("success");
    expect(bRow.triggered_by).toBe("subgraph");
    expect(cRow.status).toBe("success");
    expect(cRow.triggered_by).toBe("subgraph");

    db.close();
  });
});

describe("Executor + integration-workflow — memoization replay", () => {
  it("rerun parent: child workflow is NOT re-invoked", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    let childInvocations = 0;
    const echoMod = makeIntegration("echo", {
      go: async () => {
        childInvocations++;
        return { invocation: childInvocations };
      },
    });

    const childWf = makeWorkflow("child-counter", [
      { id: "tick", integration: "echo", operation: "go", config: {}, onError: "retry" },
    ]);
    const parentWf = makeWorkflow("parent-once", [
      {
        id: "call-child",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "child-counter" },
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, childWf);
    registerWorkflow(helpers, parentWf);

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({
        echo: echoMod,
        workflow: workflowIntegration,
      }),
      subgraphRunner,
    });

    const parentRunId = queue.enqueue("parent-once");
    queue.claim();

    // First execution.
    const r1 = await executor.run(parentWf, parentRunId, {});
    expect(r1.status).toBe("success");
    expect(childInvocations).toBe(1);
    const firstOut = JSON.parse(r1.steps[0]!.output!);
    expect(firstOut.output.invocation).toBe(1);
    const firstChildRunId = firstOut.childRunId;

    // Replay the parent: step.run for the subgraph node short-circuits
    // because the parent's step row is status='success'. Child should NOT
    // be re-invoked.
    const r2 = await executor.run(parentWf, parentRunId, {});
    expect(r2.status).toBe("success");
    expect(childInvocations).toBe(1); // <-- key memoization assertion
    const secondOut = JSON.parse(r2.steps[0]!.output!);
    expect(secondOut.childRunId).toBe(firstChildRunId);
    expect(secondOut.output.invocation).toBe(1); // same cached output

    // Verify only ONE child run row exists in the DB (replay didn't make
    // a second one).
    const childRunRows = db
      .prepare(`SELECT id FROM runs WHERE workflow_id = 'child-counter'`)
      .all();
    expect(childRunRows).toHaveLength(1);

    db.close();
  });
});

describe("Executor + integration-workflow — failure propagation", () => {
  it("child workflow failure surfaces as parent step failure", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    const failMod = makeIntegration("fail", {
      boom: async () => {
        throw new Error("child blew up");
      },
    });

    const childWf = makeWorkflow("child-fail", [
      {
        id: "boom",
        integration: "fail",
        operation: "boom",
        config: {},
        retry: { maxAttempts: 1, backoffMs: 1, jitter: false },
        onError: "fail",
      },
    ]);
    const parentWf = makeWorkflow("parent-fail", [
      {
        id: "call-child",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "child-fail" },
        retry: { maxAttempts: 1, backoffMs: 1, jitter: false },
        onError: "fail",
      },
    ]);
    registerWorkflow(helpers, childWf);
    registerWorkflow(helpers, parentWf);

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({
        fail: failMod,
        workflow: workflowIntegration,
      }),
      subgraphRunner,
    });

    const parentRunId = queue.enqueue("parent-fail");
    queue.claim();
    const result = await executor.run(parentWf, parentRunId, {});

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/child blew up|child-fail|child run for/);

    // The child runs row should be marked failed.
    const childRow = db
      .prepare(`SELECT status, error FROM runs WHERE workflow_id = 'child-fail'`)
      .get() as { status: string; error: string };
    expect(childRow.status).toBe("failed");
    expect(childRow.error).toMatch(/child blew up/);

    db.close();
  });

  it("unknown workflowId fails the parent step cleanly", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    const parentWf = makeWorkflow("parent-unknown", [
      {
        id: "call-missing",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "does-not-exist" },
        retry: { maxAttempts: 1, backoffMs: 1, jitter: false },
        onError: "fail",
      },
    ]);
    registerWorkflow(helpers, parentWf);

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({ workflow: workflowIntegration }),
      subgraphRunner,
    });

    const parentRunId = queue.enqueue("parent-unknown");
    queue.claim();
    const result = await executor.run(parentWf, parentRunId, {});

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/does-not-exist|not found/);

    db.close();
  });
});

describe("Executor + integration-workflow — version pinning", () => {
  it("respects an explicit @version suffix in workflowId", async () => {
    const db = openDatabase(":memory:");
    const helpers = new QueryHelpers(db);
    const queue = new RunQueue(db);

    // Two versions of the same workflow id, returning different outputs.
    const v1 = makeWorkflow("versioned", [
      {
        id: "leaf",
        integration: "echo",
        operation: "go",
        config: {},
        inputs: { v: "v1" },
        onError: "retry",
      },
    ]);
    const v2: Workflow = {
      ...makeWorkflow("versioned", [
        {
          id: "leaf",
          integration: "echo",
          operation: "go",
          config: {},
          inputs: { v: "v2" },
          onError: "retry",
        },
      ]),
      version: 2,
    };
    registerWorkflow(helpers, v1);
    registerWorkflow(helpers, v2);

    const echoMod = makeIntegration("echo", {
      go: async (input) => input,
    });

    const parentWf = makeWorkflow("parent-pinned", [
      {
        id: "call-v1",
        integration: "workflow",
        operation: "invoke",
        config: { workflowId: "versioned@1" },
        onError: "retry",
      },
    ]);
    registerWorkflow(helpers, parentWf);

    let executor: Executor;
    const subgraphRunner = makeDefaultSubgraphRunner(db, helpers, () => executor);
    executor = new Executor({
      db,
      integrationLoader: makeLoader({
        echo: echoMod,
        workflow: workflowIntegration,
      }),
      subgraphRunner,
    });

    const parentRunId = queue.enqueue("parent-pinned");
    queue.claim();
    const result = await executor.run(parentWf, parentRunId, {});
    expect(result.status).toBe("success");
    const out = JSON.parse(result.steps[0]!.output!);
    expect(out.output.v).toBe("v1"); // pinned to version 1

    db.close();
  });
});
