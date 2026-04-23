import { describe, it, expect } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationHandler,
} from "@delightfulchorus/core";
import {
  parsePlannerResponseJson,
  planAndExecute,
  renderSystemPrompt,
  type IntegrationLoader,
  type PlannerLLM,
  type PlannerResponse,
  type PlannerStepContext,
} from "./planner.js";

// ── Test scaffolding ────────────────────────────────────────────────────────

/**
 * Minimal in-memory StepContext that honours the memoization contract.
 *
 * On first call with a given name, runs the function and caches the result.
 * On subsequent calls with the same name, returns the cached result without
 * re-invoking the function (that's the durability guarantee the planner
 * relies on).
 */
function makeFakeStep(): PlannerStepContext & {
  /** How many times we executed each named step's fn. */
  invocations: Map<string, number>;
  /** Reset the cache — simulates a fresh process where memoized rows exist. */
  cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const invocations = new Map<string, number>();
  return {
    cache,
    invocations,
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (cache.has(name)) {
        return cache.get(name) as T;
      }
      invocations.set(name, (invocations.get(name) ?? 0) + 1);
      const out = await fn();
      cache.set(name, out);
      return out;
    },
  };
}

/**
 * Build a fake integration with the given operations. Each operation handler
 * is a `(input) => output` pure function for tests; the wrapping logic
 * wraps it into an `OperationHandler` signature.
 */
function makeFakeIntegration(
  name: string,
  operations: Record<string, (input: unknown) => Promise<unknown> | unknown>,
): IntegrationModule {
  const manifest: IntegrationManifest = {
    name,
    version: "0.0.1",
    description: `fake integration ${name}`,
    authType: "none",
    credentialTypes: [],
    operations: Object.keys(operations).map((op) => ({
      name: op,
      description: `fake op ${op}`,
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
      },
    })),
  };
  const ops: Record<string, OperationHandler> = {};
  for (const [k, fn] of Object.entries(operations)) {
    ops[k] = (async (input: unknown) => fn(input)) as OperationHandler;
  }
  return {
    manifest,
    operations: ops,
  };
}

/**
 * Build an integration loader that resolves fake integrations from a map.
 */
function makeFakeLoader(
  integrations: Record<string, IntegrationModule>,
): IntegrationLoader {
  return async (name) => {
    const m = integrations[name];
    if (!m) throw new Error(`unknown integration: ${name}`);
    return m;
  };
}

/**
 * Build a scripted PlannerLLM that returns a pre-defined sequence of
 * responses. Each call consumes one response. If the LLM is called more
 * times than the script has responses, the final response is re-emitted
 * (useful for "stays stuck" tests).
 */
function makeScriptedLLM(
  responses: Array<Omit<PlannerResponse, "usage"> & { usage?: Partial<PlannerResponse["usage"]> }>,
): PlannerLLM & { calls: Array<{ systemPrompt: string; history: unknown }>; } {
  let idx = 0;
  const calls: Array<{ systemPrompt: string; history: unknown }> = [];
  const fn: PlannerLLM = async ({ systemPrompt, history }) => {
    const i = Math.min(idx, responses.length - 1);
    idx += 1;
    const r = responses[i]!;
    calls.push({ systemPrompt, history: JSON.parse(JSON.stringify(history)) });
    return {
      thought: r.thought,
      tool: r.tool,
      finalAnswer: r.finalAnswer,
      usage: {
        inputTokens: r.usage?.inputTokens ?? 10,
        outputTokens: r.usage?.outputTokens ?? 20,
      },
    };
  };
  return Object.assign(fn, { calls });
}

// ── parsePlannerResponseJson ────────────────────────────────────────────────

describe("parsePlannerResponseJson", () => {
  it("parses a tool-call shape", () => {
    const raw = JSON.stringify({
      thought: "need to fetch bugs",
      tool: { name: "linear.listIssues", input: { label: "bug" } },
    });
    const parsed = parsePlannerResponseJson(raw);
    expect(parsed.thought).toBe("need to fetch bugs");
    expect(parsed.tool).toEqual({
      name: "linear.listIssues",
      input: { label: "bug" },
    });
    expect(parsed.finalAnswer).toBeUndefined();
  });

  it("parses a final-answer shape", () => {
    const raw = JSON.stringify({
      thought: "enough data gathered",
      finalAnswer: "3 bugs filed today",
    });
    const parsed = parsePlannerResponseJson(raw);
    expect(parsed.finalAnswer).toBe("3 bugs filed today");
    expect(parsed.tool).toBeUndefined();
  });

  it("strips markdown fences", () => {
    const raw = "```json\n" +
      JSON.stringify({ thought: "t", finalAnswer: "done" }) +
      "\n```";
    const parsed = parsePlannerResponseJson(raw);
    expect(parsed.finalAnswer).toBe("done");
  });

  it("tolerates prose around the JSON", () => {
    const raw =
      "Sure, here's my response:\n" +
      JSON.stringify({ thought: "ok", finalAnswer: "hi" }) +
      "\nHope that helps!";
    const parsed = parsePlannerResponseJson(raw);
    expect(parsed.finalAnswer).toBe("hi");
  });

  it("returns a bare-thought shape when JSON is unparseable", () => {
    const parsed = parsePlannerResponseJson("totally not json");
    expect(parsed.tool).toBeUndefined();
    expect(parsed.finalAnswer).toBeUndefined();
    // `thought` falls back to the raw text — lets the LLM see its own mistake.
    expect(parsed.thought).toBe("totally not json");
  });
});

// ── renderSystemPrompt ──────────────────────────────────────────────────────

describe("renderSystemPrompt", () => {
  it("includes the goal verbatim", () => {
    const p = renderSystemPrompt({
      goal: "do the thing",
      toolCatalog: [],
    });
    expect(p).toContain("do the thing");
  });

  it("tells the LLM to answer from knowledge when no tools are available", () => {
    const p = renderSystemPrompt({
      goal: "what is 2+2",
      toolCatalog: [],
    });
    expect(p).toContain("No tools are available");
    expect(p).toContain("finalAnswer");
  });

  it("lists each tool with its schema when tools exist", () => {
    const loader = makeFakeLoader({
      foo: makeFakeIntegration("foo", { bar: () => ({ ok: true }) }),
    });
    // Use the planner's internal resolver indirectly by running through
    // planAndExecute for one iteration — but we just want to verify render
    // output. Mirror the exported surface: pass a handcrafted catalog.
    const p = renderSystemPrompt({
      goal: "g",
      toolCatalog: [
        {
          name: "foo.bar",
          description: "fake op bar",
          integration: "foo",
          operation: "bar",
          handler: (async () => ({ ok: true })) as never,
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(p).toContain("## Tools (1 available)");
    expect(p).toContain("### foo.bar");
    expect(p).toContain("fake op bar");
    expect(loader).toBeTruthy(); // silence unused-var for lint readers
  });

  it("embeds user context as JSON when provided", () => {
    const p = renderSystemPrompt({
      goal: "g",
      userContext: { userId: "alice", tier: "pro" },
      toolCatalog: [],
    });
    expect(p).toContain('"userId": "alice"');
  });
});

// ── planAndExecute — basic loop control ─────────────────────────────────────

describe("planAndExecute — loop control", () => {
  it("exits with success=true on the iteration the LLM returns finalAnswer", async () => {
    const loader = makeFakeLoader({});
    const llm = makeScriptedLLM([
      { thought: "easy", finalAnswer: "2+2=4" },
    ]);
    const step = makeFakeStep();

    const result = await planAndExecute({
      goal: "what is 2+2",
      allowedIntegrations: [],
      maxSteps: 10,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(true);
    expect(result.finalAnswer).toBe("2+2=4");
    expect(result.stepsTaken).toHaveLength(1);
    expect(result.stepsTaken[0]!.toolCalled).toBeNull();
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
    expect(llm.calls).toHaveLength(1);
  });

  it("invokes the tool when LLM requests it then exits on finalAnswer", async () => {
    const toolCalls: Array<{ input: unknown }> = [];
    const weather = makeFakeIntegration("weather", {
      current: (input) => {
        toolCalls.push({ input });
        return { temp: 72, condition: "sunny" };
      },
    });
    const loader = makeFakeLoader({ weather });
    const llm = makeScriptedLLM([
      {
        thought: "need the weather",
        tool: { name: "weather.current", input: { city: "SF" } },
      },
      {
        thought: "got the data",
        finalAnswer: "It's sunny and 72°F in SF.",
      },
    ]);
    const step = makeFakeStep();

    const result = await planAndExecute({
      goal: "what's the weather in SF",
      allowedIntegrations: ["weather"],
      maxSteps: 5,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(true);
    expect(result.finalAnswer).toContain("sunny");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.input).toEqual({ city: "SF" });
    expect(result.stepsTaken).toHaveLength(2);
    expect(result.stepsTaken[0]!.toolCalled).toBe("weather.current");
    expect(result.stepsTaken[0]!.toolOutput).toEqual({
      temp: 72,
      condition: "sunny",
    });
    expect(result.stepsTaken[1]!.toolCalled).toBeNull();
    // Both LLM calls counted toward usage.
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(40);
  });

  it("exits with success=false when maxSteps is reached without finalAnswer", async () => {
    const weather = makeFakeIntegration("weather", {
      current: () => ({ ok: true }),
    });
    const loader = makeFakeLoader({ weather });
    const llm = makeScriptedLLM([
      {
        thought: "keep going",
        tool: { name: "weather.current", input: {} },
      },
    ]);
    const step = makeFakeStep();

    const result = await planAndExecute({
      goal: "forever",
      allowedIntegrations: ["weather"],
      maxSteps: 3,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(false);
    expect(result.stepsTaken).toHaveLength(3);
    // Message to the caller mentions maxSteps exhaustion.
    expect(result.finalAnswer.toLowerCase()).toContain("maxsteps");
  });

  it("reports an observation and continues when LLM picks a tool not in the allowlist", async () => {
    const weather = makeFakeIntegration("weather", {
      current: () => ({ ok: true }),
    });
    const loader = makeFakeLoader({ weather });
    const llm = makeScriptedLLM([
      {
        thought: "hallucinate a tool",
        tool: { name: "stocks.quote", input: {} },
      },
      {
        thought: "oh right, only weather",
        finalAnswer: "I'll skip the stocks lookup",
      },
    ]);
    const step = makeFakeStep();

    const result = await planAndExecute({
      goal: "mixed request",
      allowedIntegrations: ["weather"],
      maxSteps: 5,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(true);
    expect(result.stepsTaken[0]!.toolCalled).toBe("stocks.quote");
    expect(result.stepsTaken[0]!.toolOutput).toMatchObject({
      error: expect.stringContaining("not available"),
    });
  });

  it("reports malformed LLM responses and lets it self-correct", async () => {
    const loader = makeFakeLoader({});
    const llm = makeScriptedLLM([
      { thought: "confused" }, // neither tool nor finalAnswer
      { thought: "clearer now", finalAnswer: "done" },
    ]);
    const step = makeFakeStep();

    const result = await planAndExecute({
      goal: "g",
      allowedIntegrations: [],
      maxSteps: 5,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(true);
    expect(result.stepsTaken).toHaveLength(2);
    expect(result.stepsTaken[0]!.toolOutput).toMatchObject({
      error: expect.stringContaining("neither a tool call nor a finalAnswer"),
    });
  });
});

// ── planAndExecute — tool failures ─────────────────────────────────────────

describe("planAndExecute — tool failures", () => {
  it("propagates tool errors into history as observations", async () => {
    const broken = makeFakeIntegration("broken", {
      fail: () => {
        throw new Error("api down");
      },
    });
    const loader = makeFakeLoader({ broken });
    const llm = makeScriptedLLM([
      { thought: "call it", tool: { name: "broken.fail", input: {} } },
      { thought: "recover", finalAnswer: "handled gracefully" },
    ]);
    const step = makeFakeStep();

    const result = await planAndExecute({
      goal: "g",
      allowedIntegrations: ["broken"],
      maxSteps: 5,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(true);
    expect(result.stepsTaken[0]!.toolOutput).toMatchObject({
      error: "api down",
    });
    // History passed to the 2nd LLM call should include the error observation
    // on the `tool` role entry we appended after the failed call.
    const secondCallHistory = llm.calls[1]!.history as Array<{
      role: string;
      content: string;
    }>;
    const toolObservation = secondCallHistory.find((h) => h.role === "tool");
    expect(toolObservation?.content).toContain("api down");
  });
});

// ── Durability (memoization replay) ────────────────────────────────────────

describe("planAndExecute — durability", () => {
  it("replays completed iterations from the step cache (no re-query)", async () => {
    // Simulate mid-run crash + restart: we pre-populate the step cache with
    // the first iteration's output and verify planAndExecute skips the LLM
    // call for iteration 0.
    const weather = makeFakeIntegration("weather", {
      current: () => ({ temp: 70 }),
    });
    const loader = makeFakeLoader({ weather });
    // Only ONE response is needed — iter-0 comes from the cache; iter-1 is
    // the first iteration that actually consults the LLM.
    const llm = makeScriptedLLM([
      { thought: "done", finalAnswer: "70 degrees" },
    ]);
    const step = makeFakeStep();

    // Pre-seed the cache with an iteration-0 output as if it had already
    // completed in a previous process run.
    step.cache.set("agent:iter-0", {
      kind: "continue",
      trace: {
        step: 0,
        thought: "from replay",
        toolCalled: "weather.current",
        toolInput: { city: "SF" },
        toolOutput: { temp: 68, condition: "foggy" },
      },
      usage: { inputTokens: 5, outputTokens: 10 },
      historyAppend: [
        {
          role: "assistant",
          content: JSON.stringify({
            thought: "from replay",
            tool: { name: "weather.current", input: { city: "SF" } },
          }),
        },
        {
          role: "user",
          content: `[weather.current result] ${JSON.stringify({ temp: 68 })}`,
        },
      ],
    });

    const result = await planAndExecute({
      goal: "replay test",
      allowedIntegrations: ["weather"],
      maxSteps: 5,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    expect(result.success).toBe(true);
    // The first LLM response (index 0) was never consumed — iter-0 came
    // from cache. Only iter-1 called the LLM.
    expect(llm.calls).toHaveLength(1);
    // The trace reflects the cached iter-0 + the live iter-1.
    expect(result.stepsTaken[0]!.thought).toBe("from replay");
    expect(result.stepsTaken[0]!.toolOutput).toEqual({
      temp: 68,
      condition: "foggy",
    });
    expect(result.stepsTaken[1]!.toolCalled).toBeNull();
  });

  it("tool invocation within an iteration is wrapped in its own step.run", async () => {
    const weather = makeFakeIntegration("weather", {
      current: () => ({ temp: 72 }),
    });
    const loader = makeFakeLoader({ weather });
    const llm = makeScriptedLLM([
      { thought: "t", tool: { name: "weather.current", input: {} } },
      { thought: "done", finalAnswer: "72" },
    ]);
    const step = makeFakeStep();

    await planAndExecute({
      goal: "g",
      allowedIntegrations: ["weather"],
      maxSteps: 5,
      model: "claude-test",
      step,
      integrationLoader: loader,
      plannerLLM: llm,
    });

    // We expect named steps for:
    //   agent:iter-0                  (iteration wrapper)
    //   agent:iter-0:tool:weather.current  (nested tool call)
    //   agent:iter-1                  (iteration wrapper)
    const names = Array.from(step.invocations.keys());
    expect(names).toContain("agent:iter-0");
    expect(names).toContain("agent:iter-0:tool:weather.current");
    expect(names).toContain("agent:iter-1");
  });
});

// ── Determinism: two identical runs produce identical traces ──────────────

describe("planAndExecute — determinism", () => {
  it("produces identical traces across two runs when the LLM is deterministic", async () => {
    const build = () => {
      const weather = makeFakeIntegration("weather", {
        current: () => ({ temp: 72 }),
      });
      const loader = makeFakeLoader({ weather });
      const llm = makeScriptedLLM([
        {
          thought: "fetch",
          tool: { name: "weather.current", input: { city: "NYC" } },
          usage: { inputTokens: 7, outputTokens: 13 },
        },
        {
          thought: "emit",
          finalAnswer: "72 in NYC",
          usage: { inputTokens: 9, outputTokens: 11 },
        },
      ]);
      return { loader, llm };
    };

    const runOnce = async () => {
      const { loader, llm } = build();
      const step = makeFakeStep();
      return planAndExecute({
        goal: "weather",
        allowedIntegrations: ["weather"],
        maxSteps: 5,
        model: "claude-test",
        step,
        integrationLoader: loader,
        plannerLLM: llm,
      });
    };

    const a = await runOnce();
    const b = await runOnce();
    expect(a.finalAnswer).toBe(b.finalAnswer);
    expect(a.success).toBe(b.success);
    expect(a.stepsTaken).toEqual(b.stepsTaken);
    expect(a.usage).toEqual(b.usage);
  });
});
