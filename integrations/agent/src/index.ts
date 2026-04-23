/**
 * @delightfulchorus/integration-agent
 *
 * The `agent` step — a plan-and-execute Ralph loop that accomplishes a
 * free-form goal by repeatedly:
 *   1. Asking an LLM what to do next (given goal + history).
 *   2. Invoking one of the allowed chorus integrations.
 *   3. Appending the result to history.
 *   4. Repeating until the LLM signals DONE or maxSteps is hit.
 *
 * This mirrors Opal's Feb 2026 "agent step" capability using chorus's
 * existing repair-agent loop structure generalised to arbitrary goals.
 *
 * Durability contract:
 *   - Each planner iteration is wrapped in `step.run("agent:iter-N", fn)` so
 *     mid-run crashes replay from memoized state.
 *   - Tool invocations through the integration loader are wrapped in nested
 *     `step.run("agent:iter-N:tool", fn)` steps.
 *   - No module-level or in-process state — the planner takes every handle
 *     it needs at construction time; state lives in the executor's steps table.
 *
 * Scope (MVP):
 *   - Single planner/LLM provider (Anthropic via Vercel AI SDK) — matches the
 *     llm-anthropic integration the runtime already ships.
 *   - Tool allowlist is a list of integration-operation pairs; the loader
 *     resolves them at runtime via `ctx.integrationLoader`.
 *   - No MCP tool discovery yet (roadmap item #1, separate work).
 *
 * Chorus contract notes:
 *   - Missing apiKey → AuthError (non-retryable).
 *   - Missing integrationLoader in ctx → IntegrationError (this is a wiring
 *     bug, not a user error).
 *   - A tool failure propagates as IntegrationError with the underlying
 *     provider error preserved — the agent can observe and recover on the
 *     next iteration, OR fail the whole node if it was the final attempt.
 */
import {
  AuthError,
  IntegrationError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import { z } from "zod";
import {
  planAndExecute,
  type IntegrationLoader,
  type PlannerLLM,
  type PlannerStepContext,
  type StepTrace,
} from "./planner.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Input to the `plan-and-execute` operation.
 *
 * `allowedIntegrations` omitted → the LLM is given no tools and must answer
 * from its own knowledge in one step (useful for pure-reasoning goals).
 * Supply an array of integration names (e.g. ["linear", "slack-send"]) to
 * whitelist tool access; the planner then surfaces each allowed integration's
 * operations to the LLM as tools it may call.
 */
export const PlanAndExecuteInputSchema = z.object({
  goal: z.string().min(1),
  allowedIntegrations: z.array(z.string()).optional(),
  maxSteps: z.number().int().positive().max(50).optional(),
  model: z.string().optional(),
  context: z.unknown().optional(),
});

export const PlanAndExecuteOutputSchema = z.object({
  finalAnswer: z.string(),
  stepsTaken: z.array(
    z.object({
      step: z.number().int().nonnegative(),
      thought: z.string(),
      toolCalled: z.string().nullable(),
      toolInput: z.unknown(),
      toolOutput: z.unknown(),
    }),
  ),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  success: z.boolean(),
});

export type PlanAndExecuteInput = z.infer<typeof PlanAndExecuteInputSchema>;
export type PlanAndExecuteOutput = z.infer<typeof PlanAndExecuteOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * Default model. Kept in sync with the llm-anthropic integration's default.
 * Override per call via the `model` input field.
 */
const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_STEPS = 10;

export const manifest: IntegrationManifest = {
  name: "agent",
  version: "0.1.9",
  description:
    "Plan-and-execute agent step — an LLM decides which chorus integrations to call to accomplish a goal, iterating until done or maxSteps is hit. Durable: each iteration wrapped in step.run for replay on process restarts.",
  authType: "apiKey",
  baseUrl: "https://api.anthropic.com",
  docsUrl: "https://docs.anthropic.com/en/api/getting-started",
  credentialTypes: [
    {
      name: "agentLlmKey",
      displayName: "Agent LLM API Key",
      authType: "apiKey",
      description:
        "API key for the LLM that drives the agent's planning loop. Defaults to Anthropic; other providers can be wired by supplying a custom PlannerLLM implementation at the runtime level.",
      documentationUrl: "https://console.anthropic.com/settings/keys",
      fields: [
        {
          name: "apiKey",
          displayName: "API Key",
          type: "password",
          required: true,
          description:
            "Anthropic API key (starts with sk-ant-). The agent uses this key for every planning iteration; tool calls DO NOT inherit this key — each tool uses its own credential.",
          deepLink: "https://console.anthropic.com/settings/keys",
          pattern: "^sk-ant-",
          oauthManaged: false,
        },
      ],
      test: {
        description:
          "Validates the key by running the planner for 0 steps (just checks auth).",
      },
    },
  ],
  operations: [
    {
      name: "plan-and-execute",
      description:
        "Run the Ralph loop: ask the LLM what to do next, call a tool, observe, repeat. Returns the final answer + full trace of steps taken.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["goal"],
        properties: {
          goal: {
            type: "string",
            minLength: 1,
            description:
              "Free-form goal for the agent (e.g. 'summarize today's Linear bugs and post to #team Slack').",
          },
          allowedIntegrations: {
            type: "array",
            items: { type: "string" },
            description:
              "Whitelist of integration names the agent may call. Omitted → no tools (pure reasoning).",
          },
          maxSteps: {
            type: "number",
            minimum: 1,
            maximum: 50,
            description:
              "Upper bound on planner iterations. The loop exits early when the LLM says DONE. Default 10.",
          },
          model: {
            type: "string",
            description:
              "Override the LLM model (e.g. claude-opus-4-7). Default claude-sonnet-4-5.",
          },
          context: {
            description:
              "Free-form input data the planner receives alongside the goal.",
          },
        },
      },
      outputSchema: {
        type: "object",
        required: ["finalAnswer", "stepsTaken", "usage", "success"],
        properties: {
          finalAnswer: { type: "string" },
          stepsTaken: {
            type: "array",
            items: {
              type: "object",
              required: [
                "step",
                "thought",
                "toolCalled",
                "toolInput",
                "toolOutput",
              ],
              properties: {
                step: { type: "number" },
                thought: { type: "string" },
                toolCalled: { type: ["string", "null"] },
                toolInput: {},
                toolOutput: {},
              },
            },
          },
          usage: {
            type: "object",
            required: ["inputTokens", "outputTokens"],
            properties: {
              inputTokens: { type: "number" },
              outputTokens: { type: "number" },
            },
          },
          success: { type: "boolean" },
        },
      },
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the LLM API key from OperationContext. Symmetric with the pattern
 * used by the llm-* integrations.
 */
export function extractApiKey(
  credentials: Record<string, unknown> | string | null | undefined,
): string | undefined {
  if (!credentials) return undefined;
  if (typeof credentials === "string") return credentials;
  const candidate =
    (credentials as { apiKey?: unknown }).apiKey ??
    (credentials as { api_key?: unknown }).api_key ??
    (credentials as { token?: unknown }).token ??
    (credentials as { bearer?: unknown }).bearer;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Extract the `step` handle (StepContext) the executor attaches to ctx when
 * it invokes this handler. Mandatory — without it the agent cannot make
 * durable calls.
 */
function extractStepContext(ctx: OperationContext): PlannerStepContext {
  const step = (ctx as OperationContext & { step?: PlannerStepContext }).step;
  if (!step || typeof step.run !== "function") {
    throw new IntegrationError({
      message:
        "agent.plan-and-execute requires ctx.step — the executor must pass a StepContext. This is a wiring bug in the runtime, not user error.",
      integration: "agent",
      operation: "plan-and-execute",
      code: "MISSING_STEP_CONTEXT",
    });
  }
  return step;
}

/**
 * Extract the integration loader the executor attached to ctx. We need it to
 * resolve tool calls into real handler invocations.
 */
function extractIntegrationLoader(ctx: OperationContext): IntegrationLoader {
  const loader = (ctx as OperationContext & {
    integrationLoader?: IntegrationLoader;
  }).integrationLoader;
  if (!loader || typeof loader !== "function") {
    throw new IntegrationError({
      message:
        "agent.plan-and-execute requires ctx.integrationLoader — the executor must supply one. MVP expects `(integrationName) => Promise<IntegrationModule>`.",
      integration: "agent",
      operation: "plan-and-execute",
      code: "MISSING_INTEGRATION_LOADER",
    });
  }
  return loader;
}

/**
 * Extract an optional custom PlannerLLM from the context. When present it
 * overrides the default Anthropic-backed planner — used by tests and by
 * advanced users who want to route planning through a different provider
 * (OpenAI / Gemini) or a stub.
 *
 * Shape: a plain function matching the PlannerLLM signature.
 */
function extractPlannerOverride(
  ctx: OperationContext,
): PlannerLLM | undefined {
  const override = (ctx as OperationContext & {
    _plannerLLM?: PlannerLLM;
  })._plannerLLM;
  return typeof override === "function" ? override : undefined;
}

// ── Handler ────────────────────────────────────────────────────────────────

export const planAndExecuteOp: OperationHandler<
  PlanAndExecuteInput,
  PlanAndExecuteOutput
> = async (input, ctx) => {
  const parsed = PlanAndExecuteInputSchema.parse(input);

  const step = extractStepContext(ctx);
  const integrationLoader = extractIntegrationLoader(ctx);

  const plannerOverride = extractPlannerOverride(ctx);
  const apiKey = extractApiKey(ctx.credentials);
  if (!plannerOverride && !apiKey) {
    throw new AuthError({
      message:
        "agent.plan-and-execute requires an apiKey in ctx.credentials (or a _plannerLLM override). The agent drives planning with the LLM specified via credentials; see integration manifest.",
      integration: "agent",
      operation: "plan-and-execute",
    });
  }

  const result = await planAndExecute({
    goal: parsed.goal,
    allowedIntegrations: parsed.allowedIntegrations,
    maxSteps: parsed.maxSteps ?? DEFAULT_MAX_STEPS,
    model: parsed.model ?? DEFAULT_MODEL,
    userContext: parsed.context,
    step,
    integrationLoader,
    plannerLLM: plannerOverride,
    apiKey,
    logger: ctx.logger,
    signal: ctx.signal,
  });

  await ctx.snapshot?.record(
    "agent.plan-and-execute.200",
    {
      goal: parsed.goal,
      goalLength: parsed.goal.length,
      allowedIntegrations: parsed.allowedIntegrations ?? [],
      maxSteps: parsed.maxSteps ?? DEFAULT_MAX_STEPS,
      model: parsed.model ?? DEFAULT_MODEL,
    },
    {
      success: result.success,
      stepsTaken: result.stepsTaken.length,
      finalAnswerLength: result.finalAnswer.length,
      usage: result.usage,
    },
  );

  return result;
};

// ── testCredential ──────────────────────────────────────────────────────────

/**
 * Credential test — the agent's credential is an LLM API key. We delegate
 * validation conceptually to the underlying provider but avoid actually
 * spinning up a planner run (that would burn tokens). Instead we check the
 * key's shape. The runtime can additionally hop via the llm-anthropic
 * integration's testCredential for a real round-trip when configured.
 */
export async function testCredential(
  _credentialTypeName: string,
  ctx: OperationContext,
): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
  errorCode?: "AUTH_INVALID" | "NETWORK_ERROR";
  identity?: { workspaceName?: string };
}> {
  const startedAt = Date.now();
  const apiKey = extractApiKey(ctx.credentials);
  if (!apiKey) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: "agent.testCredential: no apiKey in ctx.credentials",
      errorCode: "AUTH_INVALID",
    };
  }
  if (!/^sk-ant-/.test(apiKey)) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error:
        "agent.testCredential: apiKey does not match expected Anthropic prefix (sk-ant-). Use the llm-anthropic integration's test for a real round-trip.",
      errorCode: "AUTH_INVALID",
    };
  }
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    identity: { workspaceName: "agent" },
  };
}

// ── Module export ───────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    "plan-and-execute": planAndExecuteOp as OperationHandler,
  },
  testCredential,
};

export default integration;

// Re-export the planner so advanced users can drive it directly.
export {
  planAndExecute,
  type IntegrationLoader,
  type PlannerLLM,
  type PlannerStepContext,
  type StepTrace,
};
