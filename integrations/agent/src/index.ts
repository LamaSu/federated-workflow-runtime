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
 *   - The whole `plan-and-execute` invocation is ONE outer step row from the
 *     workflow's point of view — replay of a completed agent step returns
 *     the cached final answer without any LLM call.
 *
 * Pluggable model adapters:
 *   - `config.provider` selects the vendor family ("anthropic" | "openai" |
 *     "gemini"). The default planner loads the corresponding `llm-*`
 *     integration via `ctx.integrationLoader` and calls its `generate`
 *     operation — never imports vendor SDKs directly. This keeps the agent
 *     vendor-agnostic and gives it free reuse of the LLM integrations'
 *     auth/retry/cassette machinery.
 *   - `config.model` overrides the model id within the chosen vendor.
 *   - `_plannerLLM` (test/advanced hook) bypasses the integration entirely.
 *
 * Tool catalog:
 *   - Tool allowlist is a list of integration NAMES (e.g. ["slack-send",
 *     "linear"]). For each allowed integration, every operation in its
 *     manifest becomes an addressable tool ("<integration>.<operation>").
 *   - No MCP tool discovery yet (roadmap item #1, separate work).
 *
 * Chorus contract notes:
 *   - Missing credentials AND no _plannerLLM override → AuthError (non-retryable).
 *   - Missing integrationLoader in ctx → IntegrationError (this is a wiring
 *     bug, not a user error). The runtime executor attaches it to ctx.
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
  PROVIDER_REGISTRY,
  type IntegrationLoader,
  type PlannerLLM,
  type PlannerProvider,
  type PlannerStepContext,
  type StepTrace,
} from "./planner.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Input to the `plan-and-execute` operation.
 *
 * Tool allowlist:
 *   `allowedIntegrations` (canonical) and `allowedTools` (alias) both accept
 *   an array of integration names (e.g. ["linear", "slack-send"]). When both
 *   are supplied the union is used. Omitted (or empty) → the LLM is given
 *   no tools and must answer from its own knowledge in one step (useful for
 *   pure-reasoning goals).
 *
 * Provider selection:
 *   `provider` selects the vendor family ("anthropic" | "openai" | "gemini").
 *   The default planner loads `@delightfulchorus/integration-llm-<provider>`
 *   via the runtime's integrationLoader and calls its `generate` operation.
 *
 * Model override:
 *   `model` is the specific model identifier (e.g. "claude-opus-4-7",
 *   "gpt-4o", "gemini-2.0-pro"). When omitted, falls back to the chosen
 *   provider's default model (kept in sync with each `llm-*` integration's
 *   DEFAULT_MODEL constant).
 *
 * Iteration budget:
 *   `maxSteps` (alias `maxIterations`) caps planner iterations. Default 5.
 */
export const PlanAndExecuteInputSchema = z
  .object({
    goal: z.string().min(1),
    allowedIntegrations: z.array(z.string()).optional(),
    /** Alias for `allowedIntegrations`. Brief uses "allowedTools" terminology. */
    allowedTools: z.array(z.string()).optional(),
    maxSteps: z.number().int().positive().max(50).optional(),
    /** Alias for `maxSteps` — brief calls it `maxIterations`. */
    maxIterations: z.number().int().positive().max(50).optional(),
    /**
     * Vendor family. One of "anthropic" | "openai" | "gemini". Defaults to
     * "anthropic". The default planner loads `llm-<provider>` via the
     * runtime's integrationLoader.
     */
    provider: z.enum(["anthropic", "openai", "gemini"]).optional(),
    /**
     * Specific model id within the chosen provider. Optional — falls back
     * to the provider's default model.
     */
    model: z.string().optional(),
    context: z.unknown().optional(),
  })
  .transform((value) => {
    // Reconcile aliases. Union allowedIntegrations + allowedTools (both
    // optional, both contribute to the same list) and prefer maxIterations
    // over maxSteps when both are present (brief language wins).
    const allowed = uniqueStrings([
      ...(value.allowedIntegrations ?? []),
      ...(value.allowedTools ?? []),
    ]);
    const maxSteps =
      value.maxIterations !== undefined
        ? value.maxIterations
        : value.maxSteps;
    return {
      goal: value.goal,
      allowedIntegrations: allowed.length > 0 ? allowed : undefined,
      maxSteps,
      provider: value.provider,
      model: value.model,
      context: value.context,
    };
  });

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

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

/**
 * Public input type — accepts either canonical names
 * (`allowedIntegrations`, `maxSteps`) or aliases from the brief
 * (`allowedTools`, `maxIterations`). The Zod schema's transform reconciles
 * them inside `planAndExecuteOp`.
 */
export interface PlanAndExecuteInput {
  goal: string;
  allowedIntegrations?: string[];
  allowedTools?: string[];
  maxSteps?: number;
  maxIterations?: number;
  provider?: PlannerProvider;
  model?: string;
  context?: unknown;
}
export type PlanAndExecuteOutput = z.infer<typeof PlanAndExecuteOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * Default provider. When none is supplied via input config, the agent
 * loads the `llm-anthropic` integration. Override per call via the
 * `provider` input field.
 */
const DEFAULT_PROVIDER: PlannerProvider = "anthropic";
/**
 * Default iteration budget. Aligned with the brief (section 9, "maxIterations
 * default 5"). The Ralph loop stops whichever comes first: finalAnswer OR
 * maxSteps.
 */
const DEFAULT_MAX_STEPS = 5;

export const manifest: IntegrationManifest = {
  name: "agent",
  version: "0.2.0",
  description:
    "Plan-and-execute agent step — an LLM decides which chorus integrations to call to accomplish a goal, iterating until done or maxIterations is hit. Pluggable provider (anthropic / openai / gemini) routes through the corresponding llm-* integration. Durable: each iteration wrapped in step.run for replay on process restarts.",
  authType: "apiKey",
  baseUrl: "https://api.anthropic.com",
  docsUrl: "https://docs.anthropic.com/en/api/getting-started",
  credentialTypes: [
    {
      name: "agentLlmKey",
      displayName: "Agent LLM API Key",
      authType: "apiKey",
      description:
        "API key for the LLM that drives the agent's planning loop. The credential is forwarded verbatim to whichever llm-* integration the chosen provider resolves to (llm-anthropic, llm-openai, llm-gemini), so the same { apiKey: \"...\" } shape works for every supported provider. Tool calls do NOT inherit this credential — each tool uses its own.",
      documentationUrl: "https://console.anthropic.com/settings/keys",
      fields: [
        {
          name: "apiKey",
          displayName: "API Key",
          type: "password",
          required: true,
          description:
            "API key for the chosen LLM provider. For provider='anthropic', use sk-ant-... (https://console.anthropic.com/settings/keys). For provider='openai', use sk-... (https://platform.openai.com/api-keys). For provider='gemini', use a Google AI Studio key (https://aistudio.google.com/app/apikey).",
          deepLink: "https://console.anthropic.com/settings/keys",
          // No pattern: each provider has a different prefix; we accept all.
          oauthManaged: false,
        },
      ],
      test: {
        description:
          "Validates the key by checking it's present (full round-trip via the chosen llm-* integration is available via that integration's testCredential).",
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
              "Whitelist of integration names the agent may call (canonical name). Omitted → no tools (pure reasoning).",
          },
          allowedTools: {
            type: "array",
            items: { type: "string" },
            description:
              "Alias for allowedIntegrations (brief uses 'tools' terminology). When both are supplied the union is used.",
          },
          maxSteps: {
            type: "number",
            minimum: 1,
            maximum: 50,
            description:
              "Upper bound on planner iterations. The loop exits early when the LLM says DONE. Default 5.",
          },
          maxIterations: {
            type: "number",
            minimum: 1,
            maximum: 50,
            description:
              "Alias for maxSteps. When both are supplied, maxIterations wins.",
          },
          provider: {
            type: "string",
            enum: ["anthropic", "openai", "gemini"],
            description:
              "Vendor family. Selects which llm-* integration the default planner loads. Default: 'anthropic'.",
          },
          model: {
            type: "string",
            description:
              "Specific model id within the chosen provider (e.g. 'claude-opus-4-7', 'gpt-4o', 'gemini-2.0-pro'). Optional — falls back to the provider's default model.",
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
        "agent.plan-and-execute requires an apiKey in ctx.credentials (or a _plannerLLM override). The agent forwards the credential to the chosen llm-* integration's generate operation.",
      integration: "agent",
      operation: "plan-and-execute",
    });
  }

  const provider: PlannerProvider = parsed.provider ?? DEFAULT_PROVIDER;
  // Resolve the model id we'll log, mirroring the planner's resolution logic.
  // The planner does this internally too — we duplicate here only for the
  // cassette record (so the snapshot reflects the final model used, not
  // "undefined").
  const resolvedModel =
    parsed.model ?? PROVIDER_REGISTRY[provider]?.defaultModel ?? "(unknown)";
  const resolvedMaxSteps = parsed.maxSteps ?? DEFAULT_MAX_STEPS;

  const result = await planAndExecute({
    goal: parsed.goal,
    allowedIntegrations: parsed.allowedIntegrations,
    maxSteps: resolvedMaxSteps,
    provider,
    model: parsed.model,
    userContext: parsed.context,
    step,
    integrationLoader,
    plannerLLM: plannerOverride,
    credentials: ctx.credentials,
    logger: ctx.logger,
    signal: ctx.signal,
  });

  await ctx.snapshot?.record(
    "agent.plan-and-execute.200",
    {
      goal: parsed.goal,
      goalLength: parsed.goal.length,
      allowedIntegrations: parsed.allowedIntegrations ?? [],
      maxSteps: resolvedMaxSteps,
      provider,
      model: resolvedModel,
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
 * Credential test — the agent's credential is an LLM API key forwarded to
 * whichever llm-* integration the chosen provider resolves to. Each provider
 * has a different prefix (sk-ant-..., sk-..., AIzaSy...), so the agent's
 * test-credential is shape-only: presence + non-empty.
 *
 * For a real round-trip to a specific provider, callers should test the
 * underlying llm-* integration's credential directly — that's the layer
 * which knows the provider's expected key shape and validation endpoint.
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
  if (apiKey.length < 8) {
    // Heuristic: every supported provider's API key is at least 8 chars.
    // Catches obvious typos without prejudging the provider.
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error:
        "agent.testCredential: apiKey looks too short to be a real key. For a real round-trip, test the underlying llm-* integration's credential.",
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
  buildIntegrationBackedPlanner,
  PROVIDER_REGISTRY,
  type IntegrationLoader,
  type PlannerLLM,
  type PlannerProvider,
  type PlannerStepContext,
  type StepTrace,
};
