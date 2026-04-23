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
    expect(ct.fields![0]!.pattern).toBe("^sk-ant-");
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
    const req = record.request as { goal: string; allowedIntegrations: string[]; maxSteps: number };
    expect(req.goal).toBe("g");
    expect(req.allowedIntegrations).toEqual([]);
    expect(req.maxSteps).toBe(10);
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

  it("returns AUTH_INVALID when apiKey does not match prefix", async () => {
    const ctx = makeAgentContext({
      credentials: { apiKey: "not-a-real-key" },
    });
    const result = await testCredential("agentLlmKey", ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
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
