import { describe, it, expect } from "vitest";
import {
  AuthError,
  IntegrationError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import integration, {
  extractApiKey,
  planAndExecuteOp,
  testCredential,
  PROVIDER_REGISTRY,
  type PlannerLLM,
  type PlannerStepContext,
} from "./index.js";

// ── Test scaffolding ────────────────────────────────────────────────────────

interface FakeSnapshot extends SnapshotRecorder {
  calls: Array<{ key: string; request: unknown; response: unknown }>;
}

function makeSnapshot(): FakeSnapshot {
  const calls: FakeSnapshot["calls"] = [];
  return {
    calls,
    async record(key, request, response) {
      calls.push({ key, request, response });
    },
    async replay() {
      return null;
    },
  };
}

function makeFakeStep(): PlannerStepContext {
  const cache = new Map<string, unknown>();
  return {
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (cache.has(name)) return cache.get(name) as T;
      const out = await fn();
      cache.set(name, out);
      return out;
    },
  };
}

function makeFakeIntegration(
  name: string,
  operations: Record<string, (input: unknown) => Promise<unknown> | unknown>,
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
    ops[k] = (async (input: unknown) => fn(input)) as OperationHandler;
  }
  return { manifest, operations: ops };
}

/**
 * Build an OperationContext with all the runtime-injected handles the
 * `plan-and-execute` handler needs: credentials, step context,
 * integrationLoader, and optionally a plannerLLM override.
 */
function makeAgentContext(opts: {
  credentials?: Record<string, unknown> | string | null;
  integrations?: Record<string, IntegrationModule>;
  plannerLLM?: PlannerLLM;
  snapshot?: SnapshotRecorder;
  signal?: AbortSignal;
  omitStep?: boolean;
  omitLoader?: boolean;
} = {}): OperationContext {
  const baseCreds =
    "credentials" in opts ? opts.credentials : { apiKey: "sk-ant-test" };
  const creds: Record<string, unknown> | null =
    typeof baseCreds === "string"
      ? { apiKey: baseCreds }
      : (baseCreds as Record<string, unknown> | null);

  const ctx: OperationContext = {
    credentials: creds,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    signal: opts.signal ?? new AbortController().signal,
    snapshot: opts.snapshot,
  };

  if (!opts.omitStep) {
    (ctx as OperationContext & { step: PlannerStepContext }).step =
      makeFakeStep();
  }
  if (!opts.omitLoader) {
    const ints = opts.integrations ?? {};
    (
      ctx as OperationContext & {
        integrationLoader: (name: string) => Promise<IntegrationModule>;
      }
    ).integrationLoader = async (name: string) => {
      const m = ints[name];
      if (!m) throw new Error(`unknown integration: ${name}`);
      return m;
    };
  }
  if (opts.plannerLLM) {
    (ctx as OperationContext & { _plannerLLM: PlannerLLM })._plannerLLM =
      opts.plannerLLM;
  }

  return ctx;
}

/**
 * Build an OperationContext where the integrationLoader is the SOLE point
 * of integration resolution — including for the LLM integration the default
 * planner loads. Used by provider-selection tests so we can record exactly
 * which `llm-*` integration the agent ends up loading.
 *
 * Crucially: NO `_plannerLLM` override is set. This forces the agent's
 * `buildIntegrationBackedPlanner` path to run, which calls
 * `integrationLoader("llm-anthropic" | "llm-openai" | "llm-gemini")`.
 */
function makeAgentContextWithLoader(opts: {
  onLoad: (name: string) => IntegrationModule | Promise<IntegrationModule>;
  credentials?: Record<string, unknown> | null;
}): OperationContext {
  const ctx: OperationContext = {
    credentials: opts.credentials ?? { apiKey: "sk-ant-test" },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    signal: new AbortController().signal,
  };
  (ctx as OperationContext & { step: PlannerStepContext }).step = makeFakeStep();
  (
    ctx as OperationContext & {
      integrationLoader: (name: string) => Promise<IntegrationModule>;
    }
  ).integrationLoader = async (name: string) => {
    const result = await opts.onLoad(name);
    return result;
  };
  return ctx;
}

/**
 * Build a fake `llm-*` integration whose `generate` operation returns a
 * canned final answer (wrapped in the JSON envelope the planner parses).
 * Used by provider-swap tests.
 */
function makeFakeLlmIntegration(
  name: string,
  finalAnswer: string,
): IntegrationModule {
  return {
    manifest: {
      name,
      version: "0.0.1",
      description: `fake ${name}`,
      authType: "apiKey",
      credentialTypes: [],
      operations: [
        {
          name: "generate",
          description: "fake generate",
          idempotent: false,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    },
    operations: {
      generate: (async () => {
        return {
          text: JSON.stringify({
            thought: `from ${name}`,
            finalAnswer,
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }) as OperationHandler,
    },
  };
}

// ── Module shape ────────────────────────────────────────────────────────────

describe("@delightfulchorus/integration-agent module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("agent");
    expect(integration.manifest.authType).toBe("apiKey");
    expect(integration.manifest.operations.map((o) => o.name)).toContain(
      "plan-and-execute",
    );
    expect(typeof integration.operations["plan-and-execute"]).toBe("function");
  });

  it("declares an agentLlmKey credentialType with a fields catalog", () => {
    expect(integration.manifest.credentialTypes).toHaveLength(1);
    const ct = integration.manifest.credentialTypes![0]!;
    expect(ct.name).toBe("agentLlmKey");
    expect(ct.authType).toBe("apiKey");
    expect(ct.fields).toHaveLength(1);
    expect(ct.fields![0]!.name).toBe("apiKey");
    // Provider-agnostic: no pattern enforced — each provider has its own
    // prefix (sk-ant-, sk-, AIzaSy-) and we forward to the chosen llm-*
    // integration which knows the right shape.
    expect(ct.fields![0]!.pattern).toBeUndefined();
  });

  it("declares the provider input field with the three known providers", () => {
    const op = integration.manifest.operations.find(
      (o) => o.name === "plan-and-execute",
    )!;
    const props = (op.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
    }).properties ?? {};
    expect(props.provider?.enum).toEqual(["anthropic", "openai", "gemini"]);
  });

  it("declares plan-and-execute with a typed input/output schema", () => {
    const op = integration.manifest.operations.find(
      (o) => o.name === "plan-and-execute",
    )!;
    expect(op).toBeTruthy();
    const required = (op.inputSchema as { required?: string[] }).required;
    expect(required).toContain("goal");
    const outReq = (op.outputSchema as { required?: string[] }).required;
    expect(outReq).toContain("finalAnswer");
    expect(outReq).toContain("stepsTaken");
    expect(outReq).toContain("usage");
    expect(outReq).toContain("success");
  });

  it("exposes testCredential", () => {
    expect(typeof integration.testCredential).toBe("function");
  });
});

// ── plan-and-execute — happy path ───────────────────────────────────────────

describe("plan-and-execute — happy path", () => {
  it("returns a finalAnswer when the LLM completes in one step", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "easy",
      finalAnswer: "42",
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const snapshot = makeSnapshot();
    const ctx = makeAgentContext({ plannerLLM: llm, snapshot });

    const result = await planAndExecuteOp(
      { goal: "what is the answer" },
      ctx,
    );

    expect(result.finalAnswer).toBe("42");
    expect(result.success).toBe(true);
    expect(result.stepsTaken).toHaveLength(1);
    expect(result.usage.inputTokens).toBe(5);
    expect(result.usage.outputTokens).toBe(3);
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("agent.plan-and-execute.200");
  });

  it("routes a tool call through the integration loader and exits on finalAnswer", async () => {
    const toolInputs: unknown[] = [];
    const weather = makeFakeIntegration("weather", {
      current: (input) => {
        toolInputs.push(input);
        return { temp: 68, conditions: "cloudy" };
      },
    });
    let callCount = 0;
    const llm: PlannerLLM = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          thought: "need weather",
          tool: { name: "weather.current", input: { city: "Seattle" } },
          usage: { inputTokens: 30, outputTokens: 15 },
        };
      }
      return {
        thought: "got it",
        finalAnswer: "68 and cloudy in Seattle",
        usage: { inputTokens: 40, outputTokens: 12 },
      };
    };
    const ctx = makeAgentContext({
      plannerLLM: llm,
      integrations: { weather },
    });

    const result = await planAndExecuteOp(
      {
        goal: "weather in seattle",
        allowedIntegrations: ["weather"],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.finalAnswer).toContain("68");
    expect(toolInputs).toHaveLength(1);
    expect(toolInputs[0]).toEqual({ city: "Seattle" });
    expect(result.stepsTaken).toHaveLength(2);
    expect(result.stepsTaken[0]!.toolCalled).toBe("weather.current");
    expect(result.stepsTaken[1]!.toolCalled).toBeNull();
    expect(result.usage.inputTokens).toBe(70);
    expect(result.usage.outputTokens).toBe(27);
  });

  it("honours the maxSteps override", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "spinning",
      tool: { name: "weather.current", input: {} },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const weather = makeFakeIntegration("weather", {
      current: () => ({ temp: 70 }),
    });
    const ctx = makeAgentContext({
      plannerLLM: llm,
      integrations: { weather },
    });
    const result = await planAndExecuteOp(
      {
        goal: "unending",
        allowedIntegrations: ["weather"],
        maxSteps: 2,
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.stepsTaken).toHaveLength(2);
  });

  it("records a cassette on success", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "done",
      finalAnswer: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const snapshot = makeSnapshot();
    const ctx = makeAgentContext({ plannerLLM: llm, snapshot });
    await planAndExecuteOp({ goal: "g" }, ctx);
    const record = snapshot.calls[0]!;
    expect(record.key).toBe("agent.plan-and-execute.200");
    const req = record.request as {
      goal: string;
      allowedIntegrations: string[];
      maxSteps: number;
      provider: string;
      model: string;
    };
    expect(req.goal).toBe("g");
    expect(req.allowedIntegrations).toEqual([]);
    // Default maxSteps aligned with brief: 5 (was 10 in earlier draft).
    expect(req.maxSteps).toBe(5);
    // Default provider: anthropic.
    expect(req.provider).toBe("anthropic");
    // Default model: provider's default (claude-sonnet-4-5).
    expect(req.model).toBe(PROVIDER_REGISTRY.anthropic.defaultModel);
    const res = record.response as { success: boolean; stepsTaken: number };
    expect(res.success).toBe(true);
    expect(res.stepsTaken).toBe(1);
  });
});

// ── plan-and-execute — wiring errors ───────────────────────────────────────

describe("plan-and-execute — wiring errors", () => {
  it("throws IntegrationError when ctx.step is missing", async () => {
    const ctx = makeAgentContext({ omitStep: true });
    await expect(
      planAndExecuteOp({ goal: "g" }, ctx),
    ).rejects.toBeInstanceOf(IntegrationError);
    await expect(
      planAndExecuteOp({ goal: "g" }, ctx),
    ).rejects.toMatchObject({ code: "MISSING_STEP_CONTEXT" });
  });

  it("throws IntegrationError when ctx.integrationLoader is missing", async () => {
    const ctx = makeAgentContext({ omitLoader: true });
    await expect(
      planAndExecuteOp({ goal: "g" }, ctx),
    ).rejects.toMatchObject({ code: "MISSING_INTEGRATION_LOADER" });
  });

  it("throws AuthError when no apiKey is in credentials and no override", async () => {
    const ctx = makeAgentContext({ credentials: null });
    await expect(
      planAndExecuteOp({ goal: "g" }, ctx),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("does NOT throw AuthError when _plannerLLM override is present (no apiKey needed)", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "ok",
      finalAnswer: "pong",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const ctx = makeAgentContext({
      credentials: null,
      plannerLLM: llm,
    });
    const result = await planAndExecuteOp({ goal: "ping" }, ctx);
    expect(result.finalAnswer).toBe("pong");
  });
});

// ── plan-and-execute — input validation ───────────────────────────────────

describe("plan-and-execute — input validation", () => {
  it("rejects empty goal", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "",
      finalAnswer: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const ctx = makeAgentContext({ plannerLLM: llm });
    await expect(
      planAndExecuteOp({ goal: "" } as never, ctx),
    ).rejects.toThrow();
  });

  it("rejects maxSteps > 50", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "",
      finalAnswer: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const ctx = makeAgentContext({ plannerLLM: llm });
    await expect(
      planAndExecuteOp(
        { goal: "g", maxSteps: 100 } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("rejects non-positive maxSteps", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "",
      finalAnswer: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const ctx = makeAgentContext({ plannerLLM: llm });
    await expect(
      planAndExecuteOp(
        { goal: "g", maxSteps: 0 } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});

// ── Aliases (allowedTools, maxIterations) ──────────────────────────────────

describe("plan-and-execute — input aliases", () => {
  it("accepts allowedTools as an alias for allowedIntegrations", async () => {
    const calledWith: unknown[] = [];
    const weather = makeFakeIntegration("weather", {
      current: (input) => {
        calledWith.push(input);
        return { temp: 65 };
      },
    });
    let callCount = 0;
    const llm: PlannerLLM = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          thought: "use weather",
          tool: { name: "weather.current", input: { city: "PDX" } },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        thought: "done",
        finalAnswer: "65 in PDX",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const ctx = makeAgentContext({
      plannerLLM: llm,
      integrations: { weather },
    });
    const result = await planAndExecuteOp(
      // Brief's terminology: allowedTools, not allowedIntegrations.
      { goal: "weather", allowedTools: ["weather"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(calledWith).toHaveLength(1);
  });

  it("unions allowedIntegrations + allowedTools when both supplied", async () => {
    const a = makeFakeIntegration("alpha", { go: () => ({ ok: true }) });
    const b = makeFakeIntegration("beta", { go: () => ({ ok: true }) });
    const llm: PlannerLLM = async () => ({
      thought: "no tools",
      finalAnswer: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const snapshot = makeSnapshot();
    const ctx = makeAgentContext({
      plannerLLM: llm,
      integrations: { alpha: a, beta: b },
      snapshot,
    });
    await planAndExecuteOp(
      {
        goal: "g",
        allowedIntegrations: ["alpha"],
        allowedTools: ["beta"],
      },
      ctx,
    );
    const req = snapshot.calls[0]!.request as { allowedIntegrations: string[] };
    expect(req.allowedIntegrations.sort()).toEqual(["alpha", "beta"]);
  });

  it("accepts maxIterations as an alias for maxSteps (and wins when both present)", async () => {
    const llm: PlannerLLM = async () => ({
      thought: "loop",
      tool: { name: "x.y", input: {} },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const x = makeFakeIntegration("x", { y: () => ({ ok: true }) });
    const ctx = makeAgentContext({ plannerLLM: llm, integrations: { x } });
    const result = await planAndExecuteOp(
      {
        goal: "g",
        allowedIntegrations: ["x"],
        // Both supplied; maxIterations should win (brief's terminology).
        maxSteps: 50,
        maxIterations: 2,
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.stepsTaken).toHaveLength(2);
  });
});

// ── Provider selection (model swap) ────────────────────────────────────────

describe("plan-and-execute — provider/model swap", () => {
  /**
   * The brief's "model swap" requirement: same workflow with different
   * provider config picks a different LLM integration. We assert this by
   * stubbing the integrationLoader to record every integration the agent
   * loads — each provider should resolve to a different llm-* integration.
   */
  it("loads llm-anthropic when provider=anthropic", async () => {
    const loaded: string[] = [];
    const ctx = makeAgentContextWithLoader({
      onLoad: (name) => {
        loaded.push(name);
        // Return a fake llm-anthropic that satisfies the planner's protocol.
        return makeFakeLlmIntegration("llm-anthropic", "stub-final-answer");
      },
    });
    const result = await planAndExecuteOp(
      { goal: "g", provider: "anthropic" },
      ctx,
    );
    expect(loaded).toContain("llm-anthropic");
    expect(loaded).not.toContain("llm-openai");
    expect(loaded).not.toContain("llm-gemini");
    expect(result.finalAnswer).toBe("stub-final-answer");
  });

  it("loads llm-openai when provider=openai", async () => {
    const loaded: string[] = [];
    const ctx = makeAgentContextWithLoader({
      onLoad: (name) => {
        loaded.push(name);
        return makeFakeLlmIntegration("llm-openai", "openai-says-hi");
      },
    });
    const result = await planAndExecuteOp(
      { goal: "g", provider: "openai" },
      ctx,
    );
    expect(loaded).toContain("llm-openai");
    expect(loaded).not.toContain("llm-anthropic");
    expect(result.finalAnswer).toBe("openai-says-hi");
  });

  it("loads llm-gemini when provider=gemini", async () => {
    const loaded: string[] = [];
    const ctx = makeAgentContextWithLoader({
      onLoad: (name) => {
        loaded.push(name);
        return makeFakeLlmIntegration("llm-gemini", "gemini-result");
      },
    });
    const result = await planAndExecuteOp(
      { goal: "g", provider: "gemini" },
      ctx,
    );
    expect(loaded).toContain("llm-gemini");
    expect(result.finalAnswer).toBe("gemini-result");
  });

  it("the SAME workflow input run twice with different provider hits different integrations", async () => {
    // Run 1: anthropic.
    const loadedA: string[] = [];
    const ctxA = makeAgentContextWithLoader({
      onLoad: (name) => {
        loadedA.push(name);
        return makeFakeLlmIntegration(name, "answer-from-anthropic");
      },
    });
    const inputA = { goal: "what time is it", provider: "anthropic" as const };
    const a = await planAndExecuteOp(inputA, ctxA);

    // Run 2: gemini, identical goal and tools.
    const loadedG: string[] = [];
    const ctxG = makeAgentContextWithLoader({
      onLoad: (name) => {
        loadedG.push(name);
        return makeFakeLlmIntegration(name, "answer-from-gemini");
      },
    });
    const inputG = { goal: "what time is it", provider: "gemini" as const };
    const g = await planAndExecuteOp(inputG, ctxG);

    expect(loadedA).toEqual(["llm-anthropic"]);
    expect(loadedG).toEqual(["llm-gemini"]);
    expect(a.finalAnswer).toBe("answer-from-anthropic");
    expect(g.finalAnswer).toBe("answer-from-gemini");
  });

  it("uses the provider's default model when caller omits config.model", async () => {
    let capturedInput: { model?: string } | undefined;
    const ctx = makeAgentContextWithLoader({
      onLoad: (_name) => {
        return {
          manifest: {
            name: "llm-openai",
            version: "0.0.1",
            description: "stub",
            authType: "none",
            credentialTypes: [],
            operations: [
              {
                name: "generate",
                description: "stub",
                idempotent: false,
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              },
            ],
          },
          operations: {
            generate: (async (input: unknown) => {
              capturedInput = input as { model?: string };
              return {
                text: JSON.stringify({
                  thought: "ok",
                  finalAnswer: "ok",
                }),
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            }) as OperationHandler,
          },
        } satisfies IntegrationModule;
      },
    });
    await planAndExecuteOp(
      { goal: "g", provider: "openai" /* no model */ },
      ctx,
    );
    expect(capturedInput?.model).toBe(PROVIDER_REGISTRY.openai.defaultModel);
  });

  it("forwards an explicit config.model to the chosen integration", async () => {
    let capturedInput: { model?: string } | undefined;
    const ctx = makeAgentContextWithLoader({
      onLoad: (_name) => ({
        manifest: {
          name: "llm-anthropic",
          version: "0.0.1",
          description: "stub",
          authType: "none",
          credentialTypes: [],
          operations: [
            {
              name: "generate",
              description: "stub",
              idempotent: false,
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
          ],
        },
        operations: {
          generate: (async (input: unknown) => {
            capturedInput = input as { model?: string };
            return {
              text: JSON.stringify({ thought: "x", finalAnswer: "x" }),
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }) as OperationHandler,
        },
      }),
    });
    await planAndExecuteOp(
      { goal: "g", provider: "anthropic", model: "claude-opus-4-7" },
      ctx,
    );
    expect(capturedInput?.model).toBe("claude-opus-4-7");
  });
});

// ── Memoization replay (full agent step replays from cache) ────────────────

describe("plan-and-execute — memoization replay", () => {
  /**
   * Brief invariant: "Replay an agent step → returns the cached final answer
   * without re-invoking the LLM."
   *
   * The whole `plan-and-execute` invocation is ONE outer step row from the
   * workflow's POV. When a workflow re-runs (replay), the executor's
   * step.run("agent-node-id", fn) short-circuits to the cached output and the
   * agent's planner is never called.
   *
   * In this test we simulate this by passing a step context whose run() is
   * pre-populated with EVERY iteration's cached output, and verifying that
   * the planner LLM is never invoked. (The brief's "outer step row" is the
   * executor's wrapping; the agent itself uses inner step.run("agent:iter-N")
   * for each iteration. From the agent's perspective, replay = every iter
   * row already cached.)
   */
  it("returns cached final answer from a fully-replayed run without invoking the LLM", async () => {
    let llmCalls = 0;
    const llm: PlannerLLM = async () => {
      llmCalls++;
      return {
        thought: "should-not-be-called",
        finalAnswer: "should-not-be-returned",
        usage: { inputTokens: 999, outputTokens: 999 },
      };
    };

    // Pre-populate the step cache as if the entire 1-iteration run had
    // already completed in a prior process. The planner's "done" branch
    // returns kind:"done" with the final answer + trace + usage.
    const stepCache = new Map<string, unknown>();
    stepCache.set("agent:iter-0", {
      kind: "done",
      trace: {
        step: 0,
        thought: "from cache",
        toolCalled: null,
        toolInput: null,
        toolOutput: null,
      },
      usage: { inputTokens: 17, outputTokens: 23 },
      finalAnswer: "cached-final-answer",
    });

    const step: PlannerStepContext = {
      async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (stepCache.has(name)) return stepCache.get(name) as T;
        const out = await fn();
        stepCache.set(name, out);
        return out;
      },
    };

    const ctx: OperationContext = {
      credentials: { apiKey: "sk-ant-test" },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      signal: new AbortController().signal,
    };
    (ctx as OperationContext & { step: PlannerStepContext }).step = step;
    (
      ctx as OperationContext & {
        integrationLoader: (name: string) => Promise<IntegrationModule>;
      }
    ).integrationLoader = async () => {
      throw new Error("loader should not be called on replay");
    };
    (ctx as OperationContext & { _plannerLLM: PlannerLLM })._plannerLLM = llm;

    const result = await planAndExecuteOp({ goal: "anything" }, ctx);

    expect(llmCalls).toBe(0);
    expect(result.finalAnswer).toBe("cached-final-answer");
    expect(result.success).toBe(true);
    expect(result.usage.inputTokens).toBe(17);
    expect(result.usage.outputTokens).toBe(23);
    expect(result.stepsTaken).toHaveLength(1);
    expect(result.stepsTaken[0]!.thought).toBe("from cache");
  });

  it("a partially-cached run replays cached iterations and re-runs only the next", async () => {
    let llmCalls = 0;
    const llm: PlannerLLM = async () => {
      llmCalls++;
      return {
        thought: "live iteration",
        finalAnswer: "live-final-answer",
        usage: { inputTokens: 5, outputTokens: 7 },
      };
    };

    const stepCache = new Map<string, unknown>();
    // Iteration 0 already completed: it was a tool call (kind:"continue").
    stepCache.set("agent:iter-0", {
      kind: "continue",
      trace: {
        step: 0,
        thought: "cached tool call",
        toolCalled: "weather.current",
        toolInput: { city: "SF" },
        toolOutput: { temp: 70 },
      },
      usage: { inputTokens: 11, outputTokens: 13 },
      historyAppend: [
        {
          role: "assistant",
          content: JSON.stringify({
            thought: "cached tool call",
            tool: { name: "weather.current", input: { city: "SF" } },
          }),
        },
        {
          role: "tool",
          content: "[weather.current result] {\"temp\":70}",
        },
      ],
    });

    const step: PlannerStepContext = {
      async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (stepCache.has(name)) return stepCache.get(name) as T;
        const out = await fn();
        stepCache.set(name, out);
        return out;
      },
    };

    const ctx: OperationContext = {
      credentials: { apiKey: "sk-ant-test" },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      signal: new AbortController().signal,
    };
    (ctx as OperationContext & { step: PlannerStepContext }).step = step;
    (
      ctx as OperationContext & {
        integrationLoader: (name: string) => Promise<IntegrationModule>;
      }
    ).integrationLoader = async () => makeFakeIntegration("weather", {
      current: () => ({ temp: 70 }),
    });
    (ctx as OperationContext & { _plannerLLM: PlannerLLM })._plannerLLM = llm;

    const result = await planAndExecuteOp({ goal: "weather" }, ctx);

    expect(llmCalls).toBe(1); // Only iter-1 hit the LLM.
    expect(result.success).toBe(true);
    expect(result.finalAnswer).toBe("live-final-answer");
    expect(result.stepsTaken).toHaveLength(2);
    expect(result.stepsTaken[0]!.thought).toBe("cached tool call");
    expect(result.stepsTaken[1]!.thought).toBe("live iteration");
    // Usage aggregates cached + live.
    expect(result.usage.inputTokens).toBe(11 + 5);
    expect(result.usage.outputTokens).toBe(13 + 7);
  });
});

// ── testCredential ──────────────────────────────────────────────────────────

describe("testCredential", () => {
  it("returns ok:true when apiKey matches the Anthropic prefix", async () => {
    const ctx = makeAgentContext({
      credentials: { apiKey: "sk-ant-abc123" },
    });
    const result = await testCredential("agentLlmKey", ctx);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns AUTH_INVALID when no apiKey in credentials", async () => {
    const ctx = makeAgentContext({ credentials: null });
    const result = await testCredential("agentLlmKey", ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("returns AUTH_INVALID when apiKey is suspiciously short", async () => {
    const ctx = makeAgentContext({
      // Length-only heuristic: <8 chars rejected. Real keys are 30+.
      credentials: { apiKey: "x" },
    });
    const result = await testCredential("agentLlmKey", ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("accepts an OpenAI-shaped key (provider-agnostic)", async () => {
    const ctx = makeAgentContext({
      credentials: { apiKey: "sk-openai-abc123-realisticlength-456" },
    });
    const result = await testCredential("agentLlmKey", ctx);
    // Provider-agnostic: agent's testCredential is shape-only. Use the
    // llm-* integration directly for a real round-trip.
    expect(result.ok).toBe(true);
  });

  it("accepts a Gemini-shaped key (provider-agnostic)", async () => {
    const ctx = makeAgentContext({
      credentials: { apiKey: "AIzaSyA1B2C3D4E5F6G7H8I9J0KLMN" },
    });
    const result = await testCredential("agentLlmKey", ctx);
    expect(result.ok).toBe(true);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

describe("extractApiKey", () => {
  it("accepts string credential", () => {
    expect(extractApiKey("sk-ant-x")).toBe("sk-ant-x");
  });
  it("accepts { apiKey }", () => {
    expect(extractApiKey({ apiKey: "sk-ant-x" })).toBe("sk-ant-x");
  });
  it("returns undefined for unrelated shapes", () => {
    expect(extractApiKey(null)).toBeUndefined();
    expect(extractApiKey({ unrelated: 1 } as never)).toBeUndefined();
  });
});
