import { describe, expect, it } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  Workflow,
} from "@delightfulchorus/core";
import { openDatabase } from "./db.js";
import { RunQueue } from "./queue.js";
import {
  Executor,
  configurableStepName,
  type IntegrationLoader,
} from "./executor.js";

/**
 * Wave 4 item 14 — Node.configurable + invoke-time overrides.
 *
 * Borrows from LCEL's `configurable_fields` pattern: a node declares which
 * config keys callers may override at invoke-time, and a trigger payload
 * may carry a top-level `configurable: {...}` map that swaps node config
 * without forking the workflow.
 *
 * Resolution precedence (asserted by the suite below):
 *   1. triggerPayload.configurable[fieldName]   (per-invocation override)
 *   2. node.config[fieldName]                   (declared workflow default)
 *   3. node.configurable[fieldName].default     (declared field default)
 *
 * Memoization key embeds the resolved declared values, so a re-run with
 * different overrides produces a different memo row even on the same
 * (workflow, runId)-shaped ground.
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
      Object.entries(operations).map(([op, fn]) => [
        op,
        async (input, ctx) => fn(input, ctx),
      ]),
    ),
  };
}

function makeWorkflow(
  nodes: Workflow["nodes"],
  connections: Workflow["connections"] = [],
): Workflow {
  return {
    id: "wf-cfg",
    name: "configurable test",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections,
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

describe("Executor — Node.configurable resolution", () => {
  it("declared field + no override → declared field default flows through", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    let observedConfig: unknown;
    const stub = makeCtxIntegration("stub", {
      run: async (_input, ctx) => {
        observedConfig = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        return { ok: true };
      },
    });

    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: {},
        configurable: { model: { default: "claude-haiku-4-5" } },
        onError: "retry",
      },
    ]);

    const result = await exec.run(wf, runId, {});
    expect(result.status).toBe("success");
    expect(observedConfig).toEqual({ model: "claude-haiku-4-5" });
  });

  it("declared field + workflow default → static default beats field default", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    let observedConfig: unknown;
    const stub = makeCtxIntegration("stub", {
      run: async (_input, ctx) => {
        observedConfig = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        return { ok: true };
      },
    });

    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        // node.config takes precedence over the field default.
        config: { model: "claude-sonnet-4-6" },
        configurable: { model: { default: "claude-haiku-4-5" } },
        onError: "retry",
      },
    ]);

    const result = await exec.run(wf, runId, {});
    expect(result.status).toBe("success");
    expect(observedConfig).toEqual({ model: "claude-sonnet-4-6" });
  });

  it("declared field + invoke-time override → override wins (top precedence)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    let observedConfig: unknown;
    const stub = makeCtxIntegration("stub", {
      run: async (_input, ctx) => {
        observedConfig = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        return { ok: true };
      },
    });

    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: { model: "claude-sonnet-4-6" },
        configurable: { model: { default: "claude-haiku-4-5" } },
        onError: "retry",
      },
    ]);

    const result = await exec.run(wf, runId, {
      configurable: { model: "claude-opus-4-7" },
    });
    expect(result.status).toBe("success");
    expect(observedConfig).toEqual({ model: "claude-opus-4-7" });
  });

  it("override for an UNDECLARED key on a node is silently ignored (override may target other nodes)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    let observedConfig: unknown;
    const stub = makeCtxIntegration("stub", {
      run: async (_input, ctx) => {
        observedConfig = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        return { ok: true };
      },
    });

    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        // Node has NO `configurable` declaration. Trigger payload's override
        // for `model` must NOT leak into ctx.nodeConfig — the workflow-wide
        // override map may target other nodes that DO declare it.
        id: "n1",
        integration: "stub",
        operation: "run",
        config: { static: "yes" },
        onError: "retry",
      },
    ]);

    const result = await exec.run(wf, runId, {
      configurable: { model: "claude-opus-4-7", temperature: 0.9 },
    });
    expect(result.status).toBe("success");
    expect(observedConfig).toEqual({ static: "yes" });
  });

  it("merged ctx.nodeConfig preserves non-declared static keys + layered declared values", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    let observedConfig: Record<string, unknown> | undefined;
    const stub = makeCtxIntegration("stub", {
      run: async (_input, ctx) => {
        observedConfig = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        return { ok: true };
      },
    });

    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: {
          // Static keys (no `configurable` declaration) flow through unchanged.
          systemPrompt: "you are helpful",
          // Declared key with a static workflow default.
          temperature: 0.7,
        },
        configurable: {
          // Override of declared key.
          model: { default: "claude-haiku-4-5" },
          // Declared key NOT overridden + NOT in node.config → field default fills in.
          maxTokens: { default: 4096 },
          // Declared key WITH a workflow default + WITH override → override wins.
          temperature: { default: 0.5 },
        },
        onError: "retry",
      },
    ]);

    const result = await exec.run(wf, runId, {
      configurable: {
        model: "claude-opus-4-7",
        temperature: 1.2,
      },
    });
    expect(result.status).toBe("success");
    expect(observedConfig).toEqual({
      systemPrompt: "you are helpful",
      model: "claude-opus-4-7",
      maxTokens: 4096,
      temperature: 1.2,
    });
  });
});

describe("Executor — Node.configurable memoization key", () => {
  it("same workflow, different override → different memo step rows (no cache cross-talk)", async () => {
    // Two SEPARATE runs of the same workflow definition with DIFFERENT
    // overrides must each produce their own memo row — same workflow does
    // NOT mean same cached output when the override differs. We assert
    // both observed model values land in handler invocations and both
    // step rows exist with override-suffixed names.
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);

    const observedModels: string[] = [];
    const stub = makeCtxIntegration("stub", {
      run: async (_input, ctx) => {
        const cfg = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        observedModels.push(String(cfg?.model ?? "<none>"));
        return { ok: true, model: cfg?.model };
      },
    });

    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: {},
        configurable: { model: { default: "claude-haiku-4-5" } },
        onError: "retry",
      },
    ]);

    // Run 1 — opus override.
    const runId1 = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });
    const r1 = await exec.run(wf, runId1, {
      configurable: { model: "claude-opus-4-7" },
    });
    expect(r1.status).toBe("success");

    // Run 2 — sonnet override (same workflow, same node, different override).
    const runId2 = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });
    const r2 = await exec.run(wf, runId2, {
      configurable: { model: "claude-sonnet-4-6" },
    });
    expect(r2.status).toBe("success");

    // Each handler invocation saw its OWN model (no cache cross-talk).
    expect(observedModels).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);

    // Step rows for each run carry the override-suffixed name (#cfg=<hash>).
    const stepsR1 = db
      .prepare(
        `SELECT step_name FROM steps WHERE run_id = ? ORDER BY step_name`,
      )
      .all(runId1) as { step_name: string }[];
    const stepsR2 = db
      .prepare(
        `SELECT step_name FROM steps WHERE run_id = ? ORDER BY step_name`,
      )
      .all(runId2) as { step_name: string }[];

    expect(stepsR1).toHaveLength(1);
    expect(stepsR2).toHaveLength(1);
    expect(stepsR1[0]!.step_name).toMatch(/^n1#cfg=[0-9a-f]{12}$/);
    expect(stepsR2[0]!.step_name).toMatch(/^n1#cfg=[0-9a-f]{12}$/);
    // Different overrides → different hashes → different step names.
    expect(stepsR1[0]!.step_name).not.toBe(stepsR2[0]!.step_name);
  });

  it("same override across two runs → same memo step name (replay-friendly)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const stub = makeCtxIntegration("stub", {
      run: async () => ({ ok: true }),
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: {},
        configurable: { model: { default: "claude-haiku-4-5" } },
        onError: "retry",
      },
    ]);

    // Two runs, identical override. The hash → suffix should match.
    const runId1 = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });
    await exec.run(wf, runId1, { configurable: { model: "claude-opus-4-7" } });

    const runId2 = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });
    await exec.run(wf, runId2, { configurable: { model: "claude-opus-4-7" } });

    const stepsR1 = db
      .prepare(`SELECT step_name FROM steps WHERE run_id = ?`)
      .all(runId1) as { step_name: string }[];
    const stepsR2 = db
      .prepare(`SELECT step_name FROM steps WHERE run_id = ?`)
      .all(runId2) as { step_name: string }[];

    expect(stepsR1[0]!.step_name).toBe(stepsR2[0]!.step_name);
  });

  it("no override + no configurable declaration → memo key is plain node.id (back-compat)", async () => {
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    const stub = makeCtxIntegration("stub", {
      run: async () => ({ ok: true }),
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: {},
        // No `configurable` declaration; no override in trigger payload.
        onError: "retry",
      },
    ]);

    const result = await exec.run(wf, runId, {});
    expect(result.status).toBe("success");

    const steps = db
      .prepare(`SELECT step_name FROM steps WHERE run_id = ?`)
      .all(runId) as { step_name: string }[];
    expect(steps).toHaveLength(1);
    // Plain node.id, no #cfg=<hash> suffix.
    expect(steps[0]!.step_name).toBe("n1");
  });

  it("declared configurable + no override applied → memo key is plain node.id (zero overrides → no suffix)", async () => {
    // Even though the node DECLARES configurable, if no override was
    // active for ANY declared field, we keep the legacy step name. This
    // keeps audit trails clean for workflows whose nodes opt into
    // configurable but whose typical invocations don't override anything.
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    const stub = makeCtxIntegration("stub", {
      run: async () => ({ ok: true }),
    });
    const exec = new Executor({ db, integrationLoader: makeLoader({ stub }) });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "stub",
        operation: "run",
        config: { temperature: 0.7 },
        configurable: { model: { default: "claude-haiku-4-5" } },
        onError: "retry",
      },
    ]);

    // Trigger has no `configurable` map at all.
    const result = await exec.run(wf, runId, { someUnrelatedField: 1 });
    expect(result.status).toBe("success");

    const steps = db
      .prepare(`SELECT step_name FROM steps WHERE run_id = ?`)
      .all(runId) as { step_name: string }[];
    expect(steps[0]!.step_name).toBe("n1");
  });
});

describe("Executor — Node.configurable + nested fallbacks (sanity, not extension)", () => {
  it("a fallback handler still receives a merged ctx.nodeConfig (override flows to fallback)", async () => {
    // Per Wave 4 brief, nested fallback NodeRefs do NOT have their own
    // `configurable` declaration; they inherit the PRIMARY's merged
    // ctx.nodeConfig (Wave 2/3 behavior, preserved here). This guards
    // against a regression where fallbacks accidentally see only
    // `node.config` after our shallow-clone substitution.
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-cfg");
    q.claim({ nowIso: "2026-04-23T00:00:00.000Z" });

    let primaryAttempts = 0;
    let fallbackObservedConfig: unknown;

    const primary = makeCtxIntegration("primary", {
      go: async () => {
        primaryAttempts++;
        throw new Error("primary down");
      },
    });
    const fb = makeCtxIntegration("fb", {
      go: async (_input, ctx) => {
        fallbackObservedConfig = (ctx as OperationContext & {
          nodeConfig?: Record<string, unknown>;
        }).nodeConfig;
        return { ok: true, viaFallback: true };
      },
    });

    const exec = new Executor({
      db,
      integrationLoader: makeLoader({ primary, fb }),
      sleep: () => Promise.resolve(),
    });
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "primary",
        operation: "go",
        config: {},
        configurable: { model: { default: "claude-haiku-4-5" } },
        retry: { maxAttempts: 1, backoffMs: 100, jitter: false },
        onError: "retry",
        fallbacks: [{ integration: "fb", operation: "go", config: {} }],
      },
    ]);

    const result = await exec.run(wf, runId, {
      configurable: { model: "claude-opus-4-7" },
    });
    expect(result.status).toBe("success");
    expect(primaryAttempts).toBe(1);
    // The fallback received the SAME merged config the primary would have
    // seen (override applied, declared default for missing keys).
    expect(fallbackObservedConfig).toEqual({ model: "claude-opus-4-7" });
  });
});

describe("configurableStepName helper (unit)", () => {
  it("zero overrides → returns nodeId unchanged", () => {
    const name = configurableStepName("n1", {
      merged: { x: 1 },
      resolvedDeclared: {},
      activeOverrides: 0,
    } as never);
    expect(name).toBe("n1");
  });

  it("overrides active → suffixes with #cfg=<12 hex>", () => {
    const name = configurableStepName("n1", {
      merged: { model: "opus" },
      resolvedDeclared: { model: "opus" },
      activeOverrides: 1,
    } as never);
    expect(name).toMatch(/^n1#cfg=[0-9a-f]{12}$/);
  });

  it("same resolvedDeclared → same suffix (deterministic)", () => {
    const a = configurableStepName("n1", {
      merged: { model: "opus", temperature: 0.5 },
      resolvedDeclared: { model: "opus", temperature: 0.5 },
      activeOverrides: 1,
    } as never);
    const b = configurableStepName("n1", {
      // key insertion order swapped — must produce the same hash.
      merged: { temperature: 0.5, model: "opus" },
      resolvedDeclared: { temperature: 0.5, model: "opus" },
      activeOverrides: 1,
    } as never);
    expect(a).toBe(b);
  });

  it("different resolvedDeclared → different suffix", () => {
    const a = configurableStepName("n1", {
      merged: { model: "opus" },
      resolvedDeclared: { model: "opus" },
      activeOverrides: 1,
    } as never);
    const b = configurableStepName("n1", {
      merged: { model: "sonnet" },
      resolvedDeclared: { model: "sonnet" },
      activeOverrides: 1,
    } as never);
    expect(a).not.toBe(b);
  });
});
