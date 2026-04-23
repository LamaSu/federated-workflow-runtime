/**
 * Tests for @delightfulchorus/integration-workflow.
 *
 * These tests exercise the handler in isolation — the SubgraphRunner
 * is stubbed. Integration with the real executor (recursion across the
 * Inngest-replay loop, memoization across replays) is covered in the
 * runtime's executor.subgraph.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { OperationContext } from "@delightfulchorus/core";
import { IntegrationError } from "@delightfulchorus/core";
import workflowIntegration, {
  applyInputMapping,
  getAtPath,
  invokeOp,
  manifest,
  parsePath,
  resolveInvocationParams,
  setAtPath,
  type SubgraphRunner,
  type SubgraphRunResult,
} from "./index.js";

// ── Test utilities ─────────────────────────────────────────────────────────

function noopLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Build an OperationContext with an attached SubgraphRunner. */
function makeCtx(
  runner: SubgraphRunner,
  opts: { credentials?: Record<string, unknown> | null; nodeConfig?: Record<string, unknown> } = {},
): OperationContext {
  const ctx: OperationContext & {
    runWorkflow?: SubgraphRunner;
    nodeConfig?: Record<string, unknown>;
  } = {
    credentials: opts.credentials ?? null,
    logger: noopLogger(),
    signal: new AbortController().signal,
    runWorkflow: runner,
  };
  if (opts.nodeConfig) ctx.nodeConfig = opts.nodeConfig;
  return ctx;
}

// ── Manifest sanity ────────────────────────────────────────────────────────

describe("manifest", () => {
  it("declares the invoke operation", () => {
    expect(manifest.name).toBe("workflow");
    expect(manifest.operations.find((op) => op.name === "invoke")).toBeDefined();
  });

  it("requires no credentials", () => {
    expect(manifest.authType).toBe("none");
    expect(manifest.credentialTypes).toEqual([]);
  });

  it("module export wires up the invoke operation", () => {
    expect(workflowIntegration.operations["invoke"]).toBe(invokeOp);
  });
});

// ── parsePath / getAtPath / setAtPath ─────────────────────────────────────

describe("parsePath", () => {
  it("parses a single key", () => {
    expect(parsePath("foo")).toEqual([{ value: "foo" }]);
  });

  it("parses dot segments", () => {
    expect(parsePath("a.b.c")).toEqual([
      { value: "a" },
      { value: "b" },
      { value: "c" },
    ]);
  });

  it("parses array indices", () => {
    expect(parsePath("a[2]")).toEqual([{ value: "a" }, { value: 2 }]);
  });

  it("parses nested arrays + objects", () => {
    expect(parsePath("users[0].roles[1]")).toEqual([
      { value: "users" },
      { value: 0 },
      { value: "roles" },
      { value: 1 },
    ]);
  });

  it("rejects garbage paths", () => {
    expect(() => parsePath("foo!bar")).toThrow(IntegrationError);
  });
});

describe("getAtPath", () => {
  const target = {
    name: "alice",
    user: { id: "u1", roles: ["admin", "editor"] },
    items: [{ sku: "x" }, { sku: "y" }],
  };

  it("reads a top-level key", () => {
    expect(getAtPath(target, "name")).toBe("alice");
  });

  it("reads a nested key", () => {
    expect(getAtPath(target, "user.id")).toBe("u1");
  });

  it("reads array elements", () => {
    expect(getAtPath(target, "user.roles[1]")).toBe("editor");
    expect(getAtPath(target, "items[0].sku")).toBe("x");
  });

  it("returns undefined for missing paths (no throw)", () => {
    expect(getAtPath(target, "missing")).toBeUndefined();
    expect(getAtPath(target, "user.missing")).toBeUndefined();
    expect(getAtPath(target, "items[99].sku")).toBeUndefined();
  });
});

describe("setAtPath", () => {
  it("sets top-level keys", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "name", "alice");
    expect(t).toEqual({ name: "alice" });
  });

  it("creates intermediate objects", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "user.id", "u1");
    expect(t).toEqual({ user: { id: "u1" } });
  });

  it("creates intermediate arrays", () => {
    const t: Record<string, unknown> = {};
    setAtPath(t, "items[0].sku", "x");
    expect(t).toEqual({ items: [{ sku: "x" }] });
  });

  it("rejects empty paths", () => {
    expect(() => setAtPath({}, "", "x")).toThrow(IntegrationError);
  });
});

// ── resolveInvocationParams ────────────────────────────────────────────────

describe("resolveInvocationParams", () => {
  it("reads workflowId from input", () => {
    expect(resolveInvocationParams({ workflowId: "x" }, undefined)).toEqual({
      workflowId: "x",
    });
  });

  it("reads workflowId from config when input is missing", () => {
    expect(
      resolveInvocationParams({}, { workflowId: "x" } as Record<string, unknown>),
    ).toEqual({ workflowId: "x" });
  });

  it("input wins when both are present", () => {
    expect(
      resolveInvocationParams(
        { workflowId: "from-input" },
        { workflowId: "from-config" } as Record<string, unknown>,
      ),
    ).toEqual({ workflowId: "from-input" });
  });

  it("parses @version suffix", () => {
    expect(resolveInvocationParams({ workflowId: "summary@3" }, undefined)).toEqual(
      {
        workflowId: "summary",
        version: 3,
      },
    );
  });

  it("treats non-numeric @ suffix as part of the id", () => {
    // workflow ids may legitimately contain @
    const r = resolveInvocationParams({ workflowId: "team@org" }, undefined);
    expect(r.workflowId).toBe("team@org");
    expect(r.version).toBeUndefined();
  });

  it("throws when workflowId is missing entirely", () => {
    expect(() => resolveInvocationParams({}, undefined)).toThrow(IntegrationError);
  });

  it("reads inputMapping from input then config", () => {
    expect(
      resolveInvocationParams(
        { workflowId: "x", inputMapping: { a: "b" } },
        undefined,
      ).inputMapping,
    ).toEqual({ a: "b" });
    expect(
      resolveInvocationParams(
        { workflowId: "x" },
        { inputMapping: { c: "d" } } as Record<string, unknown>,
      ).inputMapping,
    ).toEqual({ c: "d" });
  });

  it("accepts case-insensitive variants (FBP round-trip lowercases)", () => {
    expect(
      resolveInvocationParams(
        { workflowid: "x" } as unknown as { workflowId: string },
        undefined,
      ),
    ).toEqual({ workflowId: "x" });
    expect(
      resolveInvocationParams(
        { WORKFLOWID: "x" } as unknown as { workflowId: string },
        undefined,
      ),
    ).toEqual({ workflowId: "x" });
  });

  it("accepts inputMapping as a JSON string (FBP round-trip serializes objects as strings)", () => {
    const r = resolveInvocationParams(
      {
        workflowId: "x",
        inputmapping: '{"dest":"src"}',
      } as unknown as { workflowId: string },
      undefined,
    );
    expect(r.inputMapping).toEqual({ dest: "src" });
  });
});

// ── applyInputMapping ─────────────────────────────────────────────────────

describe("applyInputMapping", () => {
  it("returns parent input verbatim (minus housekeeping) with no mapping", () => {
    const out = applyInputMapping(
      { workflowId: "x", inputMapping: { a: "b" }, sourceText: "hello" },
      undefined,
    );
    expect(out).toEqual({ sourceText: "hello" });
  });

  it("applies a flat mapping", () => {
    const out = applyInputMapping(
      { workflowId: "x", sourceText: "hello", userId: "u1" },
      { text: "sourceText", id: "userId" },
    );
    expect(out).toEqual({ text: "hello", id: "u1" });
  });

  it("supports nested target paths", () => {
    const out = applyInputMapping(
      { workflowId: "x", sourceText: "hello", userId: "u1" },
      { "payload.text": "sourceText", "user.id": "userId" },
    );
    expect(out).toEqual({ payload: { text: "hello" }, user: { id: "u1" } });
  });

  it("supports nested source paths", () => {
    const out = applyInputMapping(
      {
        workflowId: "x",
        triggerPayload: { content: { body: "hi", meta: { author: "alice" } } },
      },
      { text: "triggerPayload.content.body", who: "triggerPayload.content.meta.author" },
    );
    expect(out).toEqual({ text: "hi", who: "alice" });
  });

  it("missing source paths produce undefined target values", () => {
    const out = applyInputMapping({ workflowId: "x" }, { text: "missing" });
    expect(out).toEqual({ text: undefined });
  });
});

// ── Handler ───────────────────────────────────────────────────────────────

describe("invokeOp — handler", () => {
  it("calls runWorkflow with resolved id + payload, returns child output", async () => {
    let observedId: string | undefined;
    let observedPayload: unknown;
    const runner: SubgraphRunner = async (id, payload) => {
      observedId = id;
      observedPayload = payload;
      return { runId: "child-run-1", output: { summary: "done" } };
    };
    const out = await invokeOp(
      { workflowId: "summarize", sourceText: "hi" },
      makeCtx(runner),
    );
    expect(observedId).toBe("summarize");
    expect(observedPayload).toEqual({ sourceText: "hi" });
    expect(out).toEqual({
      output: { summary: "done" },
      childRunId: "child-run-1",
      workflowId: "summarize",
    });
  });

  it("passes version through when @N suffix is present", async () => {
    let observedVersion: number | undefined;
    const runner: SubgraphRunner = async (_id, _payload, options) => {
      observedVersion = options?.version;
      return { runId: "r", output: null };
    };
    await invokeOp({ workflowId: "summary@7" }, makeCtx(runner));
    expect(observedVersion).toBe(7);
  });

  it("applies inputMapping before calling runWorkflow", async () => {
    let observed: unknown;
    const runner: SubgraphRunner = async (_id, payload) => {
      observed = payload;
      return { runId: "r", output: null };
    };
    await invokeOp(
      {
        workflowId: "x",
        inputMapping: { content: "sourceText", who: "userId" },
        sourceText: "hello",
        userId: "alice",
      },
      makeCtx(runner),
    );
    expect(observed).toEqual({ content: "hello", who: "alice" });
  });

  it("reads workflowId from ctx.nodeConfig when input doesn't carry it", async () => {
    let observed: string | undefined;
    const runner: SubgraphRunner = async (id, _payload) => {
      observed = id;
      return { runId: "r", output: null };
    };
    await invokeOp({ sourceText: "hi" }, makeCtx(runner, { nodeConfig: { workflowId: "config-source" } }));
    expect(observed).toBe("config-source");
  });

  it("propagates child errors as IntegrationError with cause attached", async () => {
    const runner: SubgraphRunner = async () => {
      throw new Error("network down");
    };
    await expect(
      invokeOp({ workflowId: "x" }, makeCtx(runner)),
    ).rejects.toThrow(/network down/);
  });

  it("throws MISSING_SUBGRAPH_RUNNER when ctx.runWorkflow is absent", async () => {
    const ctx: OperationContext = {
      credentials: null,
      logger: noopLogger(),
      signal: new AbortController().signal,
    };
    await expect(invokeOp({ workflowId: "x" }, ctx)).rejects.toThrow(/runWorkflow/);
  });

  it("throws MISSING_WORKFLOW_ID when no id is supplied at all", async () => {
    const runner: SubgraphRunner = async () => ({ runId: "r", output: null });
    await expect(invokeOp({}, makeCtx(runner))).rejects.toThrow(/workflowId/);
  });

  it("records a snapshot when ctx.snapshot is wired", async () => {
    const records: Array<{ key: string; req: unknown; res: unknown }> = [];
    const ctx: OperationContext & { runWorkflow: SubgraphRunner } = {
      credentials: null,
      logger: noopLogger(),
      signal: new AbortController().signal,
      runWorkflow: async () => ({ runId: "child-r", output: null }),
      snapshot: {
        record: async (key, req, res) => {
          records.push({ key, req, res });
        },
        replay: async () => null,
      },
    };
    await invokeOp({ workflowId: "x@2" }, ctx);
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe("workflow.invoke.200");
    expect((records[0]!.req as { workflowId: string }).workflowId).toBe("x");
    expect((records[0]!.req as { version: number }).version).toBe(2);
    expect((records[0]!.res as { childRunId: string }).childRunId).toBe("child-r");
  });
});

// ── Recursion smoke (handler-only — runtime tests cover real recursion) ──

describe("invokeOp — recursion smoke", () => {
  /**
   * The handler doesn't itself recurse — recursion happens INSIDE the
   * SubgraphRunner that the runtime supplies (which calls Executor.run on
   * the child workflow, and that executor reuses the same runWorkflow on any
   * subgraph nodes the child contains). This test simulates that by having
   * the stub runner invoke the handler again with a different child id.
   */
  it("the handler is callable recursively when the runner replays into it", async () => {
    let level = 0;
    const seenIds: string[] = [];
    const runner: SubgraphRunner = async (id) => {
      seenIds.push(id);
      level++;
      if (level >= 3) {
        return { runId: `r-${id}`, output: { depth: level } };
      }
      // Simulate the runtime recursing into the same handler from inside
      // the child run.
      const r = await invokeOp(
        { workflowId: `child-${level}` },
        makeCtx(runner),
      );
      return { runId: `r-${id}`, output: r.output };
    };
    const out = await invokeOp({ workflowId: "root" }, makeCtx(runner));
    expect(seenIds).toEqual(["root", "child-1", "child-2"]);
    expect(out.output).toEqual({ depth: 3 });
  });
});
