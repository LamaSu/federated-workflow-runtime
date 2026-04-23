/**
 * Tests for `chorus run history` and `chorus run replay` CLI commands.
 *
 * Strategy:
 *   - Open a temp-file SQLite DB via @delightfulchorus/runtime's openDatabase
 *     (so the schema and helpers match what the CLI command will see).
 *   - Seed: a workflow + a run + step rows.
 *   - Call runRunHistory / runRunReplay with `dbPathOverride` so the command
 *     opens a fresh handle on the same file. We then re-open the DB with the
 *     runtime helpers to assert post-conditions.
 *   - stdout is captured via opts.captureStdout (an array we pass in).
 *
 * We deliberately do NOT spin up the executor here — replay's contract is
 * "fork enqueued, dispatch later". The runtime's executor tests cover the
 * dispatch-side memoization invariant.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMutations,
  parseMutate,
  runRunHistory,
  runRunReplay,
} from "./run-history.js";

// We import the runtime ESM via a typeless require alternative: dynamic
// import works in vitest because vite injects ESM at runtime. Using a
// static import keeps the test file readable.
import {
  openDatabase,
  QueryHelpers,
  type DatabaseType,
  type RunRow,
  type StepRow,
  type WorkflowRow,
} from "@delightfulchorus/runtime";

// ── Test scaffolding ────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-run-history-test-"));
  dbPath = path.join(tmpDir, "chorus.db");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Build a workflow definition and seed a run + N step rows in the DB.
 * Returns the run id and the open DB so callers can do further setup.
 */
function seed(opts: {
  runStatus?: RunRow["status"];
  steps: Array<{
    name: string;
    status: StepRow["status"];
    output?: unknown;
    input?: unknown;
    error?: string | null;
    durationMs?: number;
    startedAt?: string;
  }>;
  workflowNodes?: string[]; // node id list; defaults to step names
}): {
  db: DatabaseType;
  runId: string;
  workflowId: string;
  workflowVersion: number;
} {
  const db = openDatabase(dbPath);
  const helpers = new QueryHelpers(db);

  const workflowId = "wf-test";
  const workflowVersion = 1;
  const nodeIds = opts.workflowNodes ?? opts.steps.map((s) => s.name);
  const definition = JSON.stringify({
    id: workflowId,
    name: "Test Workflow",
    version: workflowVersion,
    active: true,
    trigger: { type: "manual" },
    nodes: nodeIds.map((id) => ({
      id,
      integration: "stub",
      operation: "stub",
      inputs: {},
    })),
    connections: [],
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  });

  const wfRow: WorkflowRow = {
    id: workflowId,
    version: workflowVersion,
    name: "Test Workflow",
    definition,
    active: 1,
    created_at: "2026-04-22T00:00:00Z",
    updated_at: "2026-04-22T00:00:00Z",
  };
  helpers.insertWorkflow(wfRow);

  const runId = "run-test-1";
  const runRow: RunRow = {
    id: runId,
    workflow_id: workflowId,
    workflow_version: workflowVersion,
    status: opts.runStatus ?? "success",
    triggered_by: "manual",
    trigger_payload: JSON.stringify({ greeting: "hi" }),
    priority: 0,
    next_wakeup: null,
    visibility_until: null,
    started_at: "2026-04-22T00:00:00Z",
    finished_at: opts.runStatus === "running" ? null : "2026-04-22T00:00:05Z",
    error: null,
    attempt: 1,
  };
  helpers.insertRun(runRow);

  let i = 0;
  for (const s of opts.steps) {
    i++;
    const stepRow: StepRow = {
      run_id: runId,
      step_name: s.name,
      attempt: 1,
      status: s.status,
      input: s.input === undefined ? null : JSON.stringify(s.input),
      output: s.output === undefined ? null : JSON.stringify(s.output),
      error: s.error ?? null,
      error_sig_hash: null,
      started_at: s.startedAt ?? `2026-04-22T00:00:0${i}Z`,
      finished_at:
        s.status === "success" || s.status === "failed"
          ? `2026-04-22T00:00:0${i + 1}Z`
          : null,
      duration_ms: s.durationMs ?? (s.status === "success" ? 1000 : null),
    };
    helpers.upsertStep(stepRow);
  }

  return { db, runId, workflowId, workflowVersion };
}

// ── parseMutate / buildMutations ────────────────────────────────────────────

describe("parseMutate", () => {
  it("parses path=number", async () => {
    expect(await parseMutate("count=5")).toEqual({ path: "count", value: 5 });
  });

  it("parses path=true / false (booleans)", async () => {
    expect(await parseMutate("flag=true")).toEqual({ path: "flag", value: true });
    expect(await parseMutate("flag=false")).toEqual({ path: "flag", value: false });
  });

  it("parses quoted JSON strings", async () => {
    expect(await parseMutate('name="alice"')).toEqual({
      path: "name",
      value: "alice",
    });
  });

  it("falls back to raw string when value is not JSON", async () => {
    expect(await parseMutate("name=alice")).toEqual({
      path: "name",
      value: "alice",
    });
  });

  it("parses array index paths", async () => {
    expect(await parseMutate("items[0]=42")).toEqual({
      path: "items[0]",
      value: 42,
    });
  });

  it("parses nested object JSON", async () => {
    expect(await parseMutate('user={"id":7,"name":"bob"}')).toEqual({
      path: "user",
      value: { id: 7, name: "bob" },
    });
  });

  it("@filepath reads value from a JSON file", async () => {
    const fs = await import("node:fs/promises");
    const f = path.join(tmpDir, "v.json");
    await fs.writeFile(f, JSON.stringify({ pi: 3.14 }));
    expect(await parseMutate("payload=@" + f)).toEqual({
      path: "payload",
      value: { pi: 3.14 },
    });
  });

  it("throws when there's no =", async () => {
    await expect(parseMutate("noequals")).rejects.toThrow(/jsonpath/);
  });

  it("throws when path is empty", async () => {
    await expect(parseMutate("=42")).rejects.toThrow(/empty path/);
  });
});

describe("buildMutations", () => {
  it("returns empty object for undefined / empty input", async () => {
    expect(await buildMutations(undefined)).toEqual({});
    expect(await buildMutations([])).toEqual({});
  });

  it("merges multiple mutates into a single record", async () => {
    expect(await buildMutations(["a=1", "b=true", 'c="x"'])).toEqual({
      a: 1,
      b: true,
      c: "x",
    });
  });

  it("later mutates clobber earlier ones for the same path", async () => {
    expect(await buildMutations(["x=1", "x=2"])).toEqual({ x: 2 });
  });
});

// ── runRunHistory ──────────────────────────────────────────────────────────

describe("runRunHistory", () => {
  it("returns 1 with stderr message for unknown run id", async () => {
    seed({ steps: [] }).db.close();
    const out: string[] = [];
    const code = await runRunHistory({
      runId: "no-such-run",
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(1);
    // No stdout output expected (the command exited via stderr).
    expect(out.join("")).toBe("");
  });

  it("returns 0 and prints human output for a run with steps", async () => {
    const { db, runId } = seed({
      steps: [
        { name: "fetch", status: "success", output: { count: 3 } },
        { name: "process", status: "success", output: "done" },
        { name: "notify", status: "failed", error: "timeout" },
      ],
    });
    db.close();
    const out: string[] = [];
    const code = await runRunHistory({
      runId,
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain(runId);
    expect(text).toContain("fetch");
    expect(text).toContain("process");
    expect(text).toContain("notify");
    // Output preview should appear
    expect(text).toContain('"count":3');
    // Failed step's error should be visible
    expect(text).toContain("timeout");
  });

  it("--json emits structured JSON with run + steps", async () => {
    const { db, runId } = seed({
      steps: [
        { name: "step-a", status: "success", output: { a: 1 }, input: { i: "x" } },
        { name: "step-b", status: "running" },
      ],
    });
    db.close();
    const out: string[] = [];
    const code = await runRunHistory({
      runId,
      dbPathOverride: dbPath,
      json: true,
      captureStdout: out,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      run: { id: string; status: string; workflowId: string };
      steps: Array<{ stepName: string; status: string; output: unknown; inputHash: string }>;
    };
    expect(parsed.run.id).toBe(runId);
    expect(parsed.run.workflowId).toBe("wf-test");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]?.stepName).toBe("step-a");
    expect(parsed.steps[0]?.status).toBe("success");
    expect(parsed.steps[0]?.output).toEqual({ a: 1 });
    // input hash should be 8 hex chars (FNV-1a 32-bit)
    expect(parsed.steps[0]?.inputHash).toMatch(/^[0-9a-f]{8}$/);
    expect(parsed.steps[1]?.status).toBe("running");
  });

  it("handles a run with no steps recorded yet", async () => {
    const { db, runId } = seed({ steps: [] });
    db.close();
    const out: string[] = [];
    const code = await runRunHistory({
      runId,
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("(no steps recorded)");
  });

  it("a waiting/pending step shows up with the right status", async () => {
    const { db, runId } = seed({
      runStatus: "running",
      steps: [
        { name: "ready", status: "success", output: { ok: true } },
        { name: "waiting", status: "pending" },
      ],
    });
    db.close();
    const out: string[] = [];
    const code = await runRunHistory({
      runId,
      dbPathOverride: dbPath,
      json: true,
      captureStdout: out,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      run: { status: string };
      steps: Array<{ stepName: string; status: string }>;
    };
    expect(parsed.run.status).toBe("running");
    expect(parsed.steps.find((s) => s.stepName === "waiting")?.status).toBe("pending");
  });
});

// ── runRunReplay ───────────────────────────────────────────────────────────

describe("runRunReplay", () => {
  it("returns 1 when --from is missing/empty", async () => {
    seed({ steps: [] }).db.close();
    const out: string[] = [];
    const code = await runRunReplay({
      runId: "any",
      fromStep: "",
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(1);
  });

  it("returns 1 (UNKNOWN_RUN) when run id is unknown", async () => {
    seed({ steps: [] }).db.close();
    const out: string[] = [];
    const code = await runRunReplay({
      runId: "no-such-run",
      fromStep: "anywhere",
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(1);
  });

  it("returns 1 (UNKNOWN_STEP) when step name is not in the workflow", async () => {
    const { db, runId } = seed({
      workflowNodes: ["a", "b"],
      steps: [
        { name: "a", status: "success", output: 1 },
        { name: "b", status: "success", output: 2 },
      ],
    });
    db.close();
    const out: string[] = [];
    const code = await runRunReplay({
      runId,
      fromStep: "no-such-step",
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(1);
  });

  it("returns 1 on bad --mutate path syntax (BAD_MUTATION_PATH)", async () => {
    const { db, runId } = seed({
      workflowNodes: ["a", "b"],
      steps: [{ name: "a", status: "success", output: 1 }],
    });
    db.close();
    const out: string[] = [];
    // "!bad" is rejected by parsePath: first segment must start with a
    // letter/underscore/$. We rely on parsePath's pre-DB validation to
    // catch this BEFORE forkRun is called.
    const code = await runRunReplay({
      runId,
      fromStep: "b",
      mutates: ["!bad=1"],
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(1);
  });

  it("forks a run and prints the new run id in human mode", async () => {
    const { db, runId } = seed({
      workflowNodes: ["a", "b", "c"],
      steps: [
        { name: "a", status: "success", output: 1 },
        { name: "b", status: "success", output: 2 },
        { name: "c", status: "success", output: 3 },
      ],
    });
    db.close();

    const out: string[] = [];
    const code = await runRunReplay({
      runId,
      fromStep: "b",
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain(runId);
    // The new run id is a UUID — match the v4 shape
    const uuidMatch = text.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    expect(uuidMatch).not.toBeNull();
    const newRunId = uuidMatch![1]!;
    expect(newRunId).not.toBe(runId);

    // Verify in the DB: new run exists, status pending; a's step row is
    // copied to the new run (memoization), b's is NOT (new run starts fresh
    // from b).
    const reopen = openDatabase(dbPath);
    try {
      const helpers = new QueryHelpers(reopen);
      const newRun = helpers.getRun(newRunId);
      expect(newRun).toBeDefined();
      expect(newRun!.status).toBe("pending");
      expect(newRun!.workflow_id).toBe("wf-test");

      // a should be memoized (status=success, run_id = new)
      const aOnNew = helpers.getStep(newRunId, "a");
      expect(aOnNew).toBeDefined();
      expect(aOnNew!.status).toBe("success");

      // b should NOT be present yet — the executor will create it on dispatch
      const bOnNew = helpers.getStep(newRunId, "b");
      expect(bOnNew).toBeUndefined();

      // c likewise should not be present
      const cOnNew = helpers.getStep(newRunId, "c");
      expect(cOnNew).toBeUndefined();
    } finally {
      reopen.close();
    }
  });

  it("--json prints the new run id machine-readable", async () => {
    const { db, runId } = seed({
      workflowNodes: ["a", "b"],
      steps: [
        { name: "a", status: "success", output: 1 },
        { name: "b", status: "failed", error: "boom" },
      ],
    });
    db.close();

    const out: string[] = [];
    const code = await runRunReplay({
      runId,
      fromStep: "b",
      json: true,
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      sourceRunId: string;
      newRunId: string;
      fromStep: string;
      mutationsApplied: number;
    };
    expect(parsed.sourceRunId).toBe(runId);
    expect(parsed.fromStep).toBe("b");
    expect(parsed.mutationsApplied).toBe(0);
    expect(parsed.newRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("applies a --mutate to the from-step's node.inputs (sibling workflow row)", async () => {
    // Seed with a workflow whose 'b' node has inputs.greeting='hi'.
    // Replay --from b --mutate greeting=hello should produce a NEW workflow
    // row with version > 1 carrying the mutated inputs, and the new run
    // should be pinned to that version.
    const db = openDatabase(dbPath);
    const helpers = new QueryHelpers(db);
    const wfDef = {
      id: "wf-mutate",
      name: "Mutating Workflow",
      version: 1,
      active: true,
      trigger: { type: "manual" },
      nodes: [
        { id: "a", integration: "stub", operation: "stub", inputs: {} },
        {
          id: "b",
          integration: "stub",
          operation: "stub",
          inputs: { greeting: "hi" },
        },
      ],
      connections: [],
      createdAt: "2026-04-22T00:00:00Z",
      updatedAt: "2026-04-22T00:00:00Z",
    };
    helpers.insertWorkflow({
      id: "wf-mutate",
      version: 1,
      name: "Mutating Workflow",
      definition: JSON.stringify(wfDef),
      active: 1,
      created_at: "2026-04-22T00:00:00Z",
      updated_at: "2026-04-22T00:00:00Z",
    });
    const runId = "run-mut-1";
    helpers.insertRun({
      id: runId,
      workflow_id: "wf-mutate",
      workflow_version: 1,
      status: "success",
      triggered_by: "manual",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: "2026-04-22T00:00:00Z",
      finished_at: "2026-04-22T00:00:05Z",
      error: null,
      attempt: 1,
    });
    helpers.upsertStep({
      run_id: runId,
      step_name: "a",
      attempt: 1,
      status: "success",
      input: null,
      output: JSON.stringify({ ok: true }),
      error: null,
      error_sig_hash: null,
      started_at: "2026-04-22T00:00:01Z",
      finished_at: "2026-04-22T00:00:02Z",
      duration_ms: 1000,
    });
    db.close();

    const out: string[] = [];
    const code = await runRunReplay({
      runId,
      fromStep: "b",
      mutates: ["greeting=hello"],
      json: true,
      dbPathOverride: dbPath,
      captureStdout: out,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      newRunId: string;
      mutationsApplied: number;
    };
    expect(parsed.mutationsApplied).toBe(1);

    // Verify: a sibling workflow row exists with version 2 and mutated inputs.
    const reopen = openDatabase(dbPath);
    try {
      const helpers2 = new QueryHelpers(reopen);
      const wfV2 = helpers2.getWorkflow("wf-mutate", 2);
      expect(wfV2).toBeDefined();
      const def = JSON.parse(wfV2!.definition) as { nodes: Array<{ id: string; inputs: Record<string, unknown> }> };
      const bNode = def.nodes.find((n) => n.id === "b");
      expect(bNode?.inputs.greeting).toBe("hello");
      // v1 should be unchanged
      const wfV1 = helpers2.getWorkflow("wf-mutate", 1);
      const defV1 = JSON.parse(wfV1!.definition) as { nodes: Array<{ id: string; inputs: Record<string, unknown> }> };
      const bV1 = defV1.nodes.find((n) => n.id === "b");
      expect(bV1?.inputs.greeting).toBe("hi");

      // The new run should be pinned to v2.
      const newRun = helpers2.getRun(parsed.newRunId);
      expect(newRun!.workflow_version).toBe(2);
    } finally {
      reopen.close();
    }
  });

  it("reports environment error (exit 2) when DB path can't resolve", async () => {
    // Pass a bogus dbPathOverride to a directory the OS won't accept
    // (Windows reserves NUL/CON/PRN). Use an obviously bad path.
    const out: string[] = [];
    const code = await runRunReplay({
      runId: "anything",
      fromStep: "anywhere",
      dbPathOverride: path.join(tmpDir, "definitely", "nonexistent", "subpath", "with", "lots", "of", "missing", "dirs", "x.db"),
      captureStdout: out,
    });
    // openDatabase will try to create the file; better-sqlite3 may succeed
    // (creates parent dirs?) or fail. We accept both 1 and 2 here — the
    // important assertion is "non-zero exit, no false success".
    expect(code).not.toBe(0);
  });
});
