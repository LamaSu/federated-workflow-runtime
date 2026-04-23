/**
 * Tests for the functional-API decorators (Wave 4 item 13).
 *
 * Coverage: registry isolation, HOF form, top-level chorusStep helper,
 * auto-chain connections, explicit $.connect, schema validation,
 * duplicate-name + duplicate-id rejection, class-based @-decorator variant,
 * and round-trip (decorator → emit JSON → executor runs the emitted JSON →
 * matches direct invocation).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowSchema } from "@delightfulchorus/core";
import {
  chorusConnect,
  chorusStep,
  chorusStepDecl,
  chorusWorkflow,
  chorusWorkflowClass,
  clearRegistry,
  getRegisteredWorkflows,
  type StepRef,
} from "./decorators.js";
import { openDatabase } from "./db.js";
import { Executor, type IntegrationLoader } from "./executor.js";
import { RunQueue } from "./queue.js";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
} from "@delightfulchorus/core";

beforeEach(() => {
  clearRegistry();
});

afterEach(() => {
  clearRegistry();
});

// ── HOF form ────────────────────────────────────────────────────────────────

describe("chorusWorkflow (HOF form)", () => {
  it("registers a single-step workflow with manual trigger shorthand", () => {
    const wf = chorusWorkflow(
      { id: "single", trigger: "manual" },
      ($) => {
        $.step("only", {
          integration: "http-generic",
          operation: "request",
          config: { url: "https://example.com", method: "GET" },
        });
      },
    );
    expect(wf.id).toBe("single");
    expect(wf.trigger).toEqual({ type: "manual" });
    expect(wf.nodes).toHaveLength(1);
    expect(wf.nodes[0]?.id).toBe("only");
    expect(wf.connections).toHaveLength(0);
    expect(getRegisteredWorkflows()).toHaveLength(1);
    expect(getRegisteredWorkflows()[0]?.id).toBe("single");
  });

  it("auto-chains successive steps in declaration order", () => {
    const wf = chorusWorkflow(
      { id: "linear", trigger: "manual" },
      ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
        $.step("b", { integration: "noop", operation: "noop" });
        $.step("c", { integration: "noop", operation: "noop" });
      },
    );
    expect(wf.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(wf.connections).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("returns StepRef with .ref = `{{<name>.output}}` for input templating", () => {
    const wf = chorusWorkflow(
      { id: "templated", trigger: "manual" },
      ($) => {
        const a = $.step("fetch", { integration: "http-generic", operation: "request" });
        const b = $.step("parse", {
          integration: "json",
          operation: "parse",
          inputs: { body: a.ref },
        });
        expect(a.ref).toBe("{{fetch.output}}");
        expect(b.ref).toBe("{{parse.output}}");
      },
    );
    const parseNode = wf.nodes.find((n) => n.id === "parse");
    expect(parseNode?.inputs).toEqual({ body: "{{fetch.output}}" });
  });

  it("respects opts.connect: false for parallel-branch authoring", () => {
    const wf = chorusWorkflow(
      { id: "branched", trigger: "manual" },
      ($) => {
        $.step("root", { integration: "noop", operation: "noop" });
        // Two independent branches off `root`, neither auto-chains.
        $.step("left", { integration: "noop", operation: "noop" }, { connect: false });
        $.step("right", { integration: "noop", operation: "noop" }, { connect: false });
        $.connect("root", "left");
        $.connect("root", "right");
      },
    );
    // Auto-chain DID still happen for `left` (since lastStep was `root`)
    // — but we suppressed it. Same for `right`.
    expect(wf.connections).toEqual([
      { from: "root", to: "left" },
      { from: "root", to: "right" },
    ]);
  });

  it("supports explicit $.connect with `when` predicate", () => {
    const wf = chorusWorkflow(
      { id: "conditional", trigger: "manual" },
      ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
        $.step("b", { integration: "noop", operation: "noop" }, { connect: false });
        $.connect("a", "b", "output.status == 'ok'");
      },
    );
    expect(wf.connections).toEqual([
      { from: "a", to: "b", when: "output.status == 'ok'" },
    ]);
  });

  it("rejects duplicate step names within the same workflow", () => {
    expect(() =>
      chorusWorkflow({ id: "dup", trigger: "manual" }, ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
        $.step("a", { integration: "noop", operation: "noop" });
      }),
    ).toThrow(/duplicate step name "a"/);
  });

  it("rejects duplicate workflow ids in the registry", () => {
    chorusWorkflow({ id: "dup-wf", trigger: "manual" }, ($) => {
      $.step("a", { integration: "noop", operation: "noop" });
    });
    expect(() =>
      chorusWorkflow({ id: "dup-wf", trigger: "manual" }, ($) => {
        $.step("b", { integration: "noop", operation: "noop" });
      }),
    ).toThrow(/duplicate workflow id "dup-wf"/);
  });

  it("rejects $.connect to/from unknown step", () => {
    expect(() =>
      chorusWorkflow({ id: "bad-conn", trigger: "manual" }, ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
        $.connect("a", "ghost");
      }),
    ).toThrow(/unknown target step "ghost"/);
    clearRegistry();
    expect(() =>
      chorusWorkflow({ id: "bad-conn-2", trigger: "manual" }, ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
        $.connect("ghost", "a");
      }),
    ).toThrow(/unknown source step "ghost"/);
  });

  it("rejects empty step name", () => {
    expect(() =>
      chorusWorkflow({ id: "empty-name", trigger: "manual" }, ($) => {
        $.step("", { integration: "noop", operation: "noop" });
      }),
    ).toThrow(/step name must be a non-empty string/);
  });

  it("emitted workflow round-trips through WorkflowSchema cleanly", () => {
    const wf = chorusWorkflow(
      {
        id: "rt",
        name: "Round-trip",
        trigger: "manual",
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      ($) => {
        $.step("only", {
          integration: "http-generic",
          operation: "request",
          config: { url: "https://example.com", method: "GET" },
        });
      },
    );
    const reparsed = WorkflowSchema.parse(JSON.parse(JSON.stringify(wf)));
    expect(reparsed).toEqual(wf);
  });

  it("supports cron + webhook trigger forms (full object)", () => {
    const cron = chorusWorkflow(
      {
        id: "cron-wf",
        trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      },
      ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
      },
    );
    expect(cron.trigger).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
    });
    clearRegistry();
    const webhook = chorusWorkflow(
      {
        id: "webhook-wf",
        trigger: { type: "webhook", path: "/hook", method: "POST" },
      },
      ($) => {
        $.step("a", { integration: "noop", operation: "noop" });
      },
    );
    expect(webhook.trigger).toEqual({
      type: "webhook",
      path: "/hook",
      method: "POST",
    });
  });

  it("supports per-step retry, onError, and fallbacks", () => {
    const wf = chorusWorkflow(
      { id: "robust", trigger: "manual" },
      ($) => {
        $.step("primary", {
          integration: "primary-int",
          operation: "do",
          retry: { maxAttempts: 5, backoffMs: 500, jitter: false },
          onError: "continue",
          fallbacks: [
            { integration: "fb-1", operation: "do", config: { mode: "alt" } },
            { integration: "fb-2", operation: "do" },
          ],
        });
      },
    );
    const node = wf.nodes[0]!;
    expect(node.retry).toEqual({ maxAttempts: 5, backoffMs: 500, jitter: false });
    expect(node.onError).toBe("continue");
    expect(node.fallbacks).toEqual([
      { integration: "fb-1", operation: "do", config: { mode: "alt" } },
      { integration: "fb-2", operation: "do", config: {} },
    ]);
  });

  it("propagates user-thrown errors with original stack", () => {
    expect(() =>
      chorusWorkflow({ id: "user-err", trigger: "manual" }, () => {
        throw new Error("intentional");
      }),
    ).toThrow(/intentional/);
    // Registry stayed clean — failed registration shouldn't leak.
    expect(getRegisteredWorkflows()).toHaveLength(0);
  });

  it("releases the active-builder stack even on user-thrown errors", () => {
    expect(() =>
      chorusWorkflow({ id: "stack-leak", trigger: "manual" }, () => {
        throw new Error("oops");
      }),
    ).toThrow();
    // After failure, top-level chorusStep should now be rejected because
    // there's no active builder. (If finally hadn't fired, we'd leak.)
    expect(() =>
      chorusStep("orphan", { integration: "noop", operation: "noop" }),
    ).toThrow(/no active workflow builder/);
  });
});

// ── Top-level chorusStep helper ─────────────────────────────────────────────

describe("chorusStep (top-level helper)", () => {
  it("uses the active-builder stack so builder-arg-free callers work", () => {
    const wf = chorusWorkflow({ id: "top-level", trigger: "manual" }, () => {
      const a = chorusStep("a", { integration: "noop", operation: "noop" });
      chorusStep("b", { integration: "noop", operation: "noop", inputs: { x: a.ref } });
    });
    expect(wf.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(wf.connections).toEqual([{ from: "a", to: "b" }]);
    expect(wf.nodes[1]?.inputs).toEqual({ x: "{{a.output}}" });
  });

  it("chorusConnect at top level works the same as $.connect", () => {
    const wf = chorusWorkflow({ id: "top-conn", trigger: "manual" }, () => {
      chorusStep("a", { integration: "noop", operation: "noop" });
      chorusStep("b", { integration: "noop", operation: "noop" }, { connect: false });
      chorusConnect("a", "b", "output.x > 0");
    });
    expect(wf.connections).toEqual([{ from: "a", to: "b", when: "output.x > 0" }]);
  });

  it("throws when called outside a chorusWorkflow builder", () => {
    expect(() =>
      chorusStep("orphan", { integration: "noop", operation: "noop" }),
    ).toThrow(/no active workflow builder/);
    expect(() => chorusConnect("a", "b")).toThrow(/no active workflow builder/);
  });
});

// ── Class-based @-decorator variant ─────────────────────────────────────────

describe("chorusWorkflowClass + chorusStepDecl (TC39 Stage 3)", () => {
  it("registers a workflow from class-decorated accessors", () => {
    @chorusWorkflowClass({ id: "cls-form", trigger: "manual" })
    class Transcribe {
      @chorusStepDecl({
        integration: "http-generic",
        operation: "request",
        config: { url: "{{trigger.audioUrl}}", method: "GET" },
      })
      accessor fetch!: StepRef;

      @chorusStepDecl({
        integration: "llm-openai",
        operation: "transcribe",
        inputs: { audio: "{{fetch.output}}" },
      })
      accessor transcribe!: StepRef;
    }
    // Force class evaluation so decorators fire (the const/let assignment
    // for a decorated class should trigger this, but be explicit so the
    // test self-documents.)
    expect(Transcribe.name).toBe("Transcribe");

    const registered = getRegisteredWorkflows();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe("cls-form");
    expect(registered[0]?.nodes.map((n) => n.id)).toEqual(["fetch", "transcribe"]);
    expect(registered[0]?.connections).toEqual([{ from: "fetch", to: "transcribe" }]);
    expect(registered[0]?.nodes[1]?.inputs).toEqual({ audio: "{{fetch.output}}" });
  });

  it("uses the class name when meta.id is omitted", () => {
    @chorusWorkflowClass({ trigger: "manual" } as never)
    // ^ TS rejects missing id at compile time; cast lets us assert the
    //   runtime fallback. In real code id is required.
    class MyWorkflow {
      @chorusStepDecl({ integration: "noop", operation: "noop" })
      accessor only!: StepRef;
    }
    expect(MyWorkflow.name).toBe("MyWorkflow");
    expect(getRegisteredWorkflows()[0]?.id).toBe("MyWorkflow");
  });
});

// ── Round-trip: decorator → emit JSON → executor runs ──────────────────────

describe("round-trip: decorator → JSON → executor", () => {
  it("a decorated workflow's emitted JSON runs in the executor and produces the expected result", async () => {
    // 1. Build via decorator. We use literal inputs (no `{{...}}` template
    //    references) because chorus's executor does not resolve template
    //    strings — that's an integration's responsibility. The
    //    StepRef.ref the decorator emits is a CONVENTION for integrations
    //    that DO understand templates (e.g. http-generic, llm-anthropic);
    //    the executor itself just passes inputs through verbatim.
    const wf = chorusWorkflow(
      {
        id: "rt-exec",
        trigger: "manual",
      },
      ($) => {
        $.step("greet", {
          integration: "echo",
          operation: "say",
          inputs: { message: "hello" },
        });
        $.step("uppercase", {
          integration: "transform",
          operation: "upper",
          inputs: { text: "world" },
        });
      },
    );

    // 2. Emit to JSON (bytes-on-disk equivalent: round through JSON).
    const emittedJson = JSON.stringify(wf);
    const reloaded = WorkflowSchema.parse(JSON.parse(emittedJson));

    // The reloaded workflow MUST equal the in-memory one byte-for-byte —
    // this is the round-trip guarantee for the JSON emission path.
    expect(reloaded).toEqual(wf);

    // 3. Stand up an executor with simple integrations matching the
    //    workflow's referenced integrations. Enqueue a run via the
    //    RunQueue (same pattern as executor.test.ts) so the FK from
    //    `steps.run_id → runs.id` is satisfied at write time.
    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue(reloaded.id);
    q.claim();

    const calls: string[] = [];
    const integrationLoader: IntegrationLoader = async (name) => {
      if (name === "echo") {
        return makeIntegration("echo", {
          say: async (input: unknown) => {
            calls.push("echo.say");
            const i = input as { message?: string };
            return i.message ?? null;
          },
        });
      }
      if (name === "transform") {
        return makeIntegration("transform", {
          upper: async (input: unknown) => {
            calls.push("transform.upper");
            const i = input as { text?: string };
            return (i.text ?? "").toUpperCase();
          },
        });
      }
      throw new Error(`unknown integration: ${name}`);
    };

    const executor = new Executor({ db, integrationLoader });
    const result = await executor.run(reloaded, runId, {});

    expect(result.status).toBe("success");
    // Steps ran in declaration order — proves the decorator's auto-chain
    // produced a connection graph the executor walks correctly.
    expect(calls).toEqual(["echo.say", "transform.upper"]);

    const greetStep = result.steps.find((s) => s.step_name === "greet");
    const upperStep = result.steps.find((s) => s.step_name === "uppercase");
    expect(greetStep?.status).toBe("success");
    expect(upperStep?.status).toBe("success");
    expect(JSON.parse(greetStep!.output!)).toBe("hello");
    expect(JSON.parse(upperStep!.output!)).toBe("WORLD");
    db.close();
  });

  it("a directly-built decorator workflow and its JSON-roundtripped clone behave identically in the executor", async () => {
    // Build once via decorator, emit to JSON, parse back. Run BOTH against
    // separate executor instances and assert identical results — the
    // emitted JSON is fungible with the in-memory workflow object.
    const buildWf = (id: string) =>
      chorusWorkflow({ id, trigger: "manual" }, ($) => {
        $.step("a", {
          integration: "stub",
          operation: "echo",
          inputs: { v: 1 },
        });
        $.step("b", {
          integration: "stub",
          operation: "echo",
          inputs: { v: 2 },
        });
      });

    const wfDirect = buildWf("rt-direct");
    clearRegistry();
    const wfFromJson = WorkflowSchema.parse(JSON.parse(JSON.stringify(buildWf("rt-from-json"))));

    const integrationLoader: IntegrationLoader = async () =>
      makeIntegration("stub", {
        echo: async (input: unknown) => input,
      });

    const runOnce = async (workflow: typeof wfDirect) => {
      const db = openDatabase(":memory:");
      const q = new RunQueue(db);
      const runId = q.enqueue(workflow.id);
      q.claim();
      const exec = new Executor({ db, integrationLoader });
      const r = await exec.run(workflow, runId, {});
      const result = {
        status: r.status,
        outputs: r.steps.map((s) => ({
          name: s.step_name,
          out: s.output ? JSON.parse(s.output) : null,
        })),
      };
      db.close();
      return result;
    };

    const direct = await runOnce(wfDirect);
    const fromJson = await runOnce(wfFromJson);
    // Outputs (after rename of ids) must be identical.
    expect(direct.status).toBe("success");
    expect(fromJson.status).toBe("success");
    expect(direct.outputs).toEqual(fromJson.outputs);
  });

  it("fan-out-style: multi-workflow file emits one Workflow per registration", () => {
    // Simulate "one TS file, two workflows" — both register into the same
    // registry; getRegisteredWorkflows returns both.
    chorusWorkflow({ id: "wf-1", trigger: "manual" }, ($) => {
      $.step("a", { integration: "noop", operation: "noop" });
    });
    chorusWorkflow({ id: "wf-2", trigger: "manual" }, ($) => {
      $.step("b", { integration: "noop", operation: "noop" });
      $.step("c", { integration: "noop", operation: "noop" });
    });
    const all = getRegisteredWorkflows();
    expect(all).toHaveLength(2);
    expect(all.map((w) => w.id)).toEqual(["wf-1", "wf-2"]);
    expect(all[0]?.nodes).toHaveLength(1);
    expect(all[1]?.nodes).toHaveLength(2);
  });

  it("preserves step ordering: declaration order = nodes array order", () => {
    const wf = chorusWorkflow({ id: "ordered", trigger: "manual" }, ($) => {
      // Reversed-alphabet declaration to verify we don't accidentally
      // sort by name somewhere.
      $.step("z", { integration: "noop", operation: "noop" });
      $.step("y", { integration: "noop", operation: "noop" });
      $.step("x", { integration: "noop", operation: "noop" });
    });
    expect(wf.nodes.map((n) => n.id)).toEqual(["z", "y", "x"]);
    expect(wf.connections).toEqual([
      { from: "z", to: "y" },
      { from: "y", to: "x" },
    ]);
  });
});

// ── Test helpers ────────────────────────────────────────────────────────────

function makeIntegration(
  name: string,
  operations: Record<string, (input: unknown, ctx: OperationContext) => Promise<unknown>>,
): IntegrationModule {
  const manifest: IntegrationManifest = {
    name,
    version: "1.0.0",
    description: "test integration",
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
      Object.entries(operations).map(([op, fn]) => [op, fn]),
    ),
  };
}
