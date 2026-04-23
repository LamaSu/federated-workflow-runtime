/**
 * Integration test: the `agent` integration end-to-end through the real
 * Executor.
 *
 * Exercises three contracts that can ONLY be verified by running through the
 * actual executor (not the agent's own unit tests):
 *
 *   1. The executor wires `ctx.integrationLoader` so the agent integration
 *      can resolve other integrations as tools (the new wiring in
 *      `invokeNode`). Without this, every agent invocation would fail with
 *      MISSING_INTEGRATION_LOADER.
 *
 *   2. The whole `agent.plan-and-execute` invocation is ONE outer step row
 *      from the workflow's POV — replay of a completed agent step returns
 *      the cached output without invoking the planner LLM. This is the
 *      "memoization invariant" the brief calls out.
 *
 *   3. Inner iteration steps (`agent:iter-N`) and tool calls
 *      (`agent:iter-N:tool:<int>.<op>`) appear in the steps table as
 *      memoized rows nested under the outer agent node row.
 *
 * The agent's own unit tests use a fake step.run; here the real
 * SQLite-backed executor's step.run is the durability boundary.
 */
import { describe, expect, it } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  OperationHandler,
  Workflow,
} from "@delightfulchorus/core";
import { openDatabase } from "./db.js";
import { QueryHelpers } from "./db.js";
import { RunQueue } from "./queue.js";
import { Executor, type IntegrationLoader } from "./executor.js";

// ── Test helpers (mirror executor.test.ts conventions) ────────────────────

function makeWorkflow(
  nodes: Workflow["nodes"],
  connections: Workflow["connections"] = [],
): Workflow {
  return {
    id: "wf-agent",
    name: "agent-workflow",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections,
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  };
}

function makeFakeIntegration(
  name: string,
  operations: Record<
    string,
    (input: unknown, ctx?: OperationContext) => Promise<unknown> | unknown
  >,
): IntegrationModule {
  const manifest: IntegrationManifest = {
    name,
    version: "0.0.1",
    description: `fake ${name}`,
    authType: "none",
    credentialTypes: [],
    operations: Object.keys(operations).map((op) => ({
      name: op,
      description: `fake ${op}`,
      idempotent: false,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    })),
  };
  const ops: Record<string, OperationHandler> = {};
  for (const [k, fn] of Object.entries(operations)) {
    ops[k] = (async (input: unknown, ctx?: OperationContext) =>
      fn(input, ctx)) as OperationHandler;
  }
  return { manifest, operations: ops };
}

function makeLoader(
  map: Record<string, IntegrationModule>,
): IntegrationLoader {
  return async (name) => {
    const mod = map[name];
    if (!mod) throw new Error(`unknown integration ${name}`);
    return mod;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("agent integration — wired through real Executor", () => {
  it("ctx.integrationLoader is attached and the agent can resolve a tool by name", async () => {
    // Load the real agent integration.
    const agentMod = (
      await import("@delightfulchorus/integration-agent")
    ).default;

    // A fake "weather" integration the agent will call.
    const weatherMod = makeFakeIntegration("weather", {
      current: () => ({ temp: 72, condition: "sunny" }),
    });

    // The map keys are the integration names the executor and the agent will
    // both resolve via `integrationLoader(name)`. The agent looks up
    // `llm-anthropic` for its planner; we DON'T provide that (we'll use
    // `_plannerLLM` override instead, which the runtime can't pass through
    // ctx). To test through the real executor we instead supply a fake
    // `llm-anthropic` integration whose `generate` op returns canned JSON
    // the planner parses.
    const fakeLlmAnthropic = makeFakeIntegration("llm-anthropic", {
      generate: () => {
        // The planner makes 2 calls in this scenario:
        //   - call 1: tool call (it asks for weather.current)
        //   - call 2: final answer
        // We return both via a stateful counter on the closure.
        return {
          text: JSON.stringify({
            thought: "use the weather tool",
            tool: { name: "weather.current", input: { city: "SF" } },
          }),
          usage: { inputTokens: 5, outputTokens: 7 },
        };
      },
    });
    // Track call count so we can return different responses per turn.
    let llmCalls = 0;
    fakeLlmAnthropic.operations["generate"] = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return {
          text: JSON.stringify({
            thought: "use the weather tool",
            tool: { name: "weather.current", input: { city: "SF" } },
          }),
          usage: { inputTokens: 5, outputTokens: 7 },
        };
      }
      return {
        text: JSON.stringify({
          thought: "got data",
          finalAnswer: "72 and sunny in SF",
        }),
        usage: { inputTokens: 6, outputTokens: 9 },
      };
    }) as OperationHandler;

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-agent");
    q.claim();

    const exec = new Executor({
      db,
      integrationLoader: makeLoader({
        agent: agentMod,
        weather: weatherMod,
        "llm-anthropic": fakeLlmAnthropic,
      }),
      // Hand a fake apiKey so the agent's apiKey check passes; the fake
      // llm-anthropic ignores it.
      credentialsFor: (integration: string) =>
        integration === "agent" ? { apiKey: "sk-ant-fake" } : null,
    });

    const workflow = makeWorkflow([
      {
        id: "research",
        integration: "agent",
        operation: "plan-and-execute",
        config: {},
        inputs: {
          goal: "Find the weather in SF",
          allowedTools: ["weather"],
          maxIterations: 5,
        },
        onError: "fail",
      },
    ]);

    const res = await exec.run(workflow, runId, { event: "trigger" });
    expect(res.status).toBe("success");

    // The outer agent step should be persisted.
    expect(res.steps.find((s) => s.step_name === "research")).toBeTruthy();

    // Inner iteration + tool steps are persisted by ctx.step.run inside
    // the planner but not included in res.steps (which only contains
    // top-level node steps). Query the DB directly to assert they're there.
    const allSteps = new QueryHelpers(db).listSteps(runId);
    const stepNames = allSteps.map((s) => s.step_name);
    expect(stepNames).toContain("agent:iter-0");
    expect(stepNames).toContain("agent:iter-0:tool:weather.current");
    expect(stepNames).toContain("agent:iter-1");

    // The output of the outer step should be the agent's full result.
    const outerStep = res.steps.find((s) => s.step_name === "research")!;
    const out = JSON.parse(outerStep.output ?? "null") as {
      success: boolean;
      finalAnswer: string;
      stepsTaken: { step: number; toolCalled: string | null }[];
    };
    expect(out.success).toBe(true);
    expect(out.finalAnswer).toBe("72 and sunny in SF");
    expect(out.stepsTaken).toHaveLength(2);
    expect(out.stepsTaken[0]!.toolCalled).toBe("weather.current");
    expect(out.stepsTaken[1]!.toolCalled).toBeNull();

    // The planner LLM was called exactly twice (once per planner iteration).
    expect(llmCalls).toBe(2);

    db.close();
  });

  it("MEMOIZATION REPLAY: re-running the same workflow returns the cached agent result without re-invoking the planner LLM", async () => {
    const agentMod = (
      await import("@delightfulchorus/integration-agent")
    ).default;

    const weatherMod = makeFakeIntegration("weather", {
      current: () => ({ temp: 70 }),
    });

    let llmCalls = 0;
    const fakeLlmAnthropic = makeFakeIntegration("llm-anthropic", {
      generate: (async () => {
        llmCalls++;
        if (llmCalls === 1) {
          return {
            text: JSON.stringify({
              thought: "use the weather tool",
              tool: { name: "weather.current", input: { city: "SF" } },
            }),
            usage: { inputTokens: 5, outputTokens: 7 },
          };
        }
        return {
          text: JSON.stringify({
            thought: "done",
            finalAnswer: "70 in SF",
          }),
          usage: { inputTokens: 5, outputTokens: 7 },
        };
      }) as OperationHandler,
    });

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-agent");
    q.claim();

    const exec = new Executor({
      db,
      integrationLoader: makeLoader({
        agent: agentMod,
        weather: weatherMod,
        "llm-anthropic": fakeLlmAnthropic,
      }),
      credentialsFor: (integration: string) =>
        integration === "agent" ? { apiKey: "sk-ant-fake" } : null,
    });

    const workflow = makeWorkflow([
      {
        id: "research",
        integration: "agent",
        operation: "plan-and-execute",
        config: {},
        inputs: {
          goal: "Find the weather in SF",
          allowedTools: ["weather"],
          maxIterations: 5,
        },
        onError: "fail",
      },
    ]);

    // First run.
    const r1 = await exec.run(workflow, runId, { event: "trigger" });
    expect(r1.status).toBe("success");
    expect(llmCalls).toBe(2);

    // Second run with the SAME runId — replay. The outer agent step is
    // already in the steps table → step.run returns the cached output and
    // the agent handler is NEVER invoked again. Hence the planner LLM is
    // also never called again.
    const llmCallsBeforeReplay = llmCalls;
    const r2 = await exec.run(workflow, runId, { event: "trigger" });
    expect(r2.status).toBe("success");
    expect(llmCalls).toBe(llmCallsBeforeReplay); // No new LLM calls.

    // Both runs produce the same final answer (deterministic from cache).
    const r1Outer = r1.steps.find((s) => s.step_name === "research")!;
    const r2Outer = r2.steps.find((s) => s.step_name === "research")!;
    expect(r2Outer.output).toBe(r1Outer.output);

    db.close();
  });

  it("provider override: workflow with provider='openai' loads llm-openai, not llm-anthropic", async () => {
    const agentMod = (
      await import("@delightfulchorus/integration-agent")
    ).default;

    const loaded: string[] = [];
    let llmCalls = 0;
    const fakeLlmOpenai = makeFakeIntegration("llm-openai", {
      generate: (async () => {
        llmCalls++;
        return {
          text: JSON.stringify({
            thought: "easy",
            finalAnswer: "answer-from-openai",
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }) as OperationHandler,
    });
    const fakeLlmAnthropic = makeFakeIntegration("llm-anthropic", {
      generate: (async () => {
        throw new Error(
          "llm-anthropic.generate should NOT be called when provider=openai",
        );
      }) as OperationHandler,
    });

    const db = openDatabase(":memory:");
    const q = new RunQueue(db);
    const runId = q.enqueue("wf-agent");
    q.claim();

    const exec = new Executor({
      db,
      integrationLoader: async (name) => {
        loaded.push(name);
        if (name === "agent") return agentMod;
        if (name === "llm-openai") return fakeLlmOpenai;
        if (name === "llm-anthropic") return fakeLlmAnthropic;
        throw new Error(`unknown integration ${name}`);
      },
      credentialsFor: () => ({ apiKey: "sk-ant-fake" }),
    });

    const workflow = makeWorkflow([
      {
        id: "research",
        integration: "agent",
        operation: "plan-and-execute",
        config: {},
        inputs: {
          goal: "what's 2+2",
          provider: "openai",
        },
        onError: "fail",
      },
    ]);

    const res = await exec.run(workflow, runId, {});
    expect(res.status).toBe("success");
    expect(loaded).toContain("llm-openai");
    expect(loaded).not.toContain("llm-anthropic");
    expect(llmCalls).toBe(1);

    const outer = res.steps.find((s) => s.step_name === "research")!;
    const out = JSON.parse(outer.output ?? "null") as { finalAnswer: string };
    expect(out.finalAnswer).toBe("answer-from-openai");

    db.close();
  });
});
