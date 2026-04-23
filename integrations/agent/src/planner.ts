/**
 * planner.ts — the Ralph loop itself, separated from the integration
 * manifest/operation wrapper so it can be unit-tested without touching the
 * executor's StepContext or credential plumbing.
 *
 * The loop:
 *   1. Build a system prompt describing the goal + available tools.
 *   2. For each iteration up to maxSteps:
 *      a. Ask the LLM what to do next (thought + tool choice + input, OR final answer).
 *      b. If final answer → exit with success=true.
 *      c. If tool call → invoke the integration operation, append result to history.
 *      d. If parse error → feed the error back as an observation so the LLM can self-correct.
 *   3. If maxSteps hit without DONE → return success=false with the accumulated trace.
 *
 * Each iteration is wrapped in `step.run("agent:iter-N", fn)` via the caller;
 * every tool call inside an iteration is wrapped in a nested
 * `step.run("agent:iter-N:tool:<integration>.<op>", fn)`. This means a
 * process crash anywhere in the loop replays deterministically from the last
 * memoized step.
 *
 * IMPORTANT — determinism: we pass a fixed seed/temperature in the prompt but
 * LLMs aren't bit-identical on replay. Durability here means "pick up where
 * we left off," not "reproduce the same answer byte-for-byte." The executor's
 * step.run memoization ensures iterations that already completed return their
 * cached output on replay; only the NEXT iteration re-queries the LLM.
 */
import {
  AuthError,
  IntegrationError,
  type IntegrationModule,
  type Logger,
  type OperationContext,
} from "@delightfulchorus/core";

// ── Public types ────────────────────────────────────────────────────────────

/**
 * A minimal StepContext surface — the planner only needs step.run. We type
 * this narrowly (rather than re-importing the runtime's full StepContext) so
 * this package has zero runtime dependency on `@delightfulchorus/runtime`.
 */
export interface PlannerStepContext {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Resolves an integration name to its module. Supplied by the caller —
 * usually the runtime's executor via `ctx.integrationLoader`.
 */
export type IntegrationLoader = (
  integration: string,
) => Promise<IntegrationModule>;

/**
 * One step of the audit trail. Populated once per planner iteration; the
 * final answer iteration has toolCalled=null.
 */
export interface StepTrace {
  step: number;
  thought: string;
  toolCalled: string | null;
  toolInput: unknown;
  toolOutput: unknown;
}

/**
 * Aggregated usage across all planner iterations.
 */
export interface PlannerUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What the LLM is allowed to emit per iteration. Either a tool call OR a
 * final answer, never both. See renderSystemPrompt() for the contract we
 * ship to the model.
 */
export interface PlannerResponse {
  thought: string;
  /** Present iff this is a tool call. */
  tool?: {
    /**
     * Canonical "<integration>.<operation>". Matches what renderSystemPrompt
     * showed the LLM.
     */
    name: string;
    input: unknown;
  };
  /** Present iff this is a final answer. */
  finalAnswer?: string;
  /** Tokens reported by the provider for this call. */
  usage: PlannerUsage;
}

/**
 * The PlannerLLM abstraction. Accepts a full conversation-style prompt and
 * returns the next response. This shape makes it trivial to swap providers
 * (Anthropic / OpenAI / Gemini) and to stub in tests.
 */
export type PlannerLLM = (call: {
  model: string;
  systemPrompt: string;
  history: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
  }>;
  signal?: AbortSignal;
}) => Promise<PlannerResponse>;

export interface PlanAndExecuteParams {
  goal: string;
  allowedIntegrations?: string[];
  maxSteps: number;
  model: string;
  userContext?: unknown;
  step: PlannerStepContext;
  integrationLoader: IntegrationLoader;
  /**
   * Optional override. When absent, a default Anthropic-backed PlannerLLM is
   * built from `apiKey`.
   */
  plannerLLM?: PlannerLLM;
  /**
   * When no plannerLLM is provided, this is the key the default Anthropic
   * planner will use.
   */
  apiKey?: string;
  logger?: Logger;
  signal?: AbortSignal;
}

export interface PlanAndExecuteResult {
  finalAnswer: string;
  stepsTaken: StepTrace[];
  usage: PlannerUsage;
  success: boolean;
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Run the Ralph loop. This is the function the `plan-and-execute` operation
 * wraps, and what advanced users can drive directly if they want to bypass
 * the IntegrationModule surface.
 */
export async function planAndExecute(
  params: PlanAndExecuteParams,
): Promise<PlanAndExecuteResult> {
  const {
    goal,
    allowedIntegrations = [],
    maxSteps,
    model,
    userContext,
    step,
    integrationLoader,
    logger,
    signal,
  } = params;

  const llm =
    params.plannerLLM ??
    buildDefaultAnthropicPlanner({ apiKey: params.apiKey });

  // Resolve tool catalog: for each allowed integration, load it and collect
  // its operations. We do this ONCE at the start, not per iteration, so a
  // single resolution failure surfaces cleanly.
  const toolCatalog = await resolveToolCatalog(
    allowedIntegrations,
    integrationLoader,
  );

  const systemPrompt = renderSystemPrompt({ goal, userContext, toolCatalog });

  const history: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
  }> = [];
  const stepsTaken: StepTrace[] = [];
  const usage: PlannerUsage = { inputTokens: 0, outputTokens: 0 };

  for (let i = 0; i < maxSteps; i++) {
    // Each iteration is durable — crash + replay short-circuits to the
    // memoized response on the executor side.
    const iterationName = `agent:iter-${i}`;
    const iterResult = await step.run<
      | {
          kind: "done";
          trace: StepTrace;
          usage: PlannerUsage;
          finalAnswer: string;
        }
      | {
          kind: "continue";
          trace: StepTrace;
          usage: PlannerUsage;
          historyAppend: Array<{
            role: "user" | "assistant" | "tool";
            content: string;
          }>;
        }
      | {
          kind: "error";
          trace: StepTrace;
          usage: PlannerUsage;
          historyAppend: Array<{
            role: "user" | "assistant" | "tool";
            content: string;
          }>;
        }
    >(iterationName, async () => {
      logger?.debug(`agent.iter ${i} — calling LLM`);
      let response: PlannerResponse;
      try {
        response = await llm({
          model,
          systemPrompt,
          history,
          signal,
        });
      } catch (err) {
        // Auth / network failures from the planner itself are fatal —
        // propagate them up to the operation handler so the node fails.
        throw wrapLLMError(err);
      }

      const stepNum = i;

      // ── Final answer branch ─────────────────────────────────────────────
      if (response.finalAnswer !== undefined && response.finalAnswer !== null) {
        const trace: StepTrace = {
          step: stepNum,
          thought: response.thought || "",
          toolCalled: null,
          toolInput: null,
          toolOutput: null,
        };
        return {
          kind: "done",
          trace,
          usage: response.usage,
          finalAnswer: response.finalAnswer,
        } as const;
      }

      // ── Tool call branch ────────────────────────────────────────────────
      if (!response.tool) {
        // Malformed response: neither finalAnswer nor tool. Feed an
        // observation back so the LLM self-corrects next turn.
        const observation =
          "Your last response had neither a tool call nor a finalAnswer. Respond with exactly one of: { thought, tool: { name, input } } OR { thought, finalAnswer }.";
        const trace: StepTrace = {
          step: stepNum,
          thought: response.thought || "",
          toolCalled: null,
          toolInput: null,
          toolOutput: { error: observation },
        };
        return {
          kind: "error",
          trace,
          usage: response.usage,
          historyAppend: [
            {
              role: "assistant",
              content: JSON.stringify({
                thought: response.thought,
                // Echo whatever they sent so the LLM can see its own mistake.
              }),
            },
            {
              role: "tool",
              content: observation,
            },
          ],
        } as const;
      }

      const toolName = response.tool.name;
      const toolInput = response.tool.input;

      // Verify the tool is on the allowlist.
      const catalogEntry = toolCatalog.find((t) => t.name === toolName);
      if (!catalogEntry) {
        const observation = `Tool "${toolName}" is not available. Allowed tools: ${toolCatalog
          .map((t) => t.name)
          .join(", ") || "(none — answer from your own knowledge)"}.`;
        const trace: StepTrace = {
          step: stepNum,
          thought: response.thought || "",
          toolCalled: toolName,
          toolInput,
          toolOutput: { error: observation },
        };
        return {
          kind: "error",
          trace,
          usage: response.usage,
          historyAppend: [
            {
              role: "assistant",
              content: JSON.stringify({
                thought: response.thought,
                tool: response.tool,
              }),
            },
            {
              role: "tool",
              content: observation,
            },
          ],
        } as const;
      }

      // Invoke the tool. We nest the call in another step.run so the
      // individual tool invocation is memoized separately from the planner
      // LLM call — a crash mid-tool-call replays only that tool, not the
      // whole iteration.
      const toolStepName = `agent:iter-${i}:tool:${toolName}`;
      let toolOutput: unknown;
      let toolError: Error | null = null;
      try {
        toolOutput = await step.run(toolStepName, async () => {
          const opCtx: OperationContext = {
            credentials: null, // Runtime supplies the tool's own creds via a sub-invocation when needed.
            logger: logger ?? silentLogger(),
            signal: signal ?? new AbortController().signal,
          };
          return await catalogEntry.handler(toolInput, opCtx);
        });
      } catch (err) {
        toolError = err as Error;
      }

      const trace: StepTrace = {
        step: stepNum,
        thought: response.thought || "",
        toolCalled: toolName,
        toolInput,
        toolOutput: toolError
          ? {
              error: toolError.message,
              name: toolError.name,
            }
          : toolOutput,
      };

      // Append to history for next LLM call — include a simple JSON
      // observation of the tool result (or error).
      const observationContent = toolError
        ? JSON.stringify({
            error: toolError.message,
            name: toolError.name,
          })
        : safeJsonStringify(toolOutput);

      return {
        kind: toolError ? "error" : "continue",
        trace,
        usage: response.usage,
        historyAppend: [
          {
            role: "assistant",
            content: JSON.stringify({
              thought: response.thought,
              tool: response.tool,
            }),
          },
          {
            role: "tool",
            content: `[${toolName} result] ${observationContent}`,
          },
        ],
      } as const;
    });

    usage.inputTokens += iterResult.usage.inputTokens;
    usage.outputTokens += iterResult.usage.outputTokens;
    stepsTaken.push(iterResult.trace);

    if (iterResult.kind === "done") {
      return {
        finalAnswer: iterResult.finalAnswer,
        stepsTaken,
        usage,
        success: true,
      };
    }

    // Append to in-memory history for next LLM call. Note: the history is
    // rebuilt from stepsTaken on replay (since stepsTaken comes back from
    // the memoized step output), so cross-restart determinism is preserved.
    for (const h of iterResult.historyAppend) {
      history.push(h);
    }
  }

  // Max steps hit without DONE. Return the trace with success=false.
  return {
    finalAnswer:
      "Agent reached maxSteps without completing the goal. See stepsTaken for the trace.",
    stepsTaken,
    usage,
    success: false,
  };
}

// ── System prompt ───────────────────────────────────────────────────────────

interface ResolvedTool {
  name: string;
  description: string;
  integration: string;
  operation: string;
  handler: (
    input: unknown,
    ctx: OperationContext,
  ) => Promise<unknown>;
  inputSchema: Record<string, unknown>;
}

async function resolveToolCatalog(
  allowedIntegrations: string[],
  loader: IntegrationLoader,
): Promise<ResolvedTool[]> {
  const tools: ResolvedTool[] = [];
  for (const name of allowedIntegrations) {
    const mod = await loader(name);
    for (const op of mod.manifest.operations) {
      const handler = mod.operations[op.name];
      if (!handler) continue; // Manifest/handlers mismatch — skip.
      tools.push({
        name: `${name}.${op.name}`,
        description: op.description,
        integration: name,
        operation: op.name,
        handler,
        inputSchema: op.inputSchema,
      });
    }
  }
  return tools;
}

/**
 * Build the system prompt. We show the LLM:
 *   - The goal
 *   - The user-supplied context (if any)
 *   - Every available tool with its input schema
 *   - The response contract it MUST follow
 *
 * Exported for testing.
 */
export function renderSystemPrompt(opts: {
  goal: string;
  userContext?: unknown;
  toolCatalog: ResolvedTool[];
}): string {
  const { goal, userContext, toolCatalog } = opts;
  const parts: string[] = [];

  parts.push("You are a planning agent in the Chorus federated workflow runtime.");
  parts.push("");
  parts.push(`## Goal`);
  parts.push(goal);
  parts.push("");

  if (userContext !== undefined && userContext !== null) {
    parts.push("## Context");
    parts.push("```json");
    parts.push(safeJsonStringify(userContext));
    parts.push("```");
    parts.push("");
  }

  if (toolCatalog.length === 0) {
    parts.push("## Tools");
    parts.push(
      "No tools are available. Answer the goal from your own knowledge in one step by returning { thought, finalAnswer }.",
    );
  } else {
    parts.push(`## Tools (${toolCatalog.length} available)`);
    for (const t of toolCatalog) {
      parts.push(`### ${t.name}`);
      parts.push(t.description);
      parts.push("Input schema:");
      parts.push("```json");
      parts.push(safeJsonStringify(t.inputSchema));
      parts.push("```");
      parts.push("");
    }
  }

  parts.push("## Response contract");
  parts.push("");
  parts.push(
    "You MUST respond with exactly one JSON object per turn. Two shapes are valid:",
  );
  parts.push("");
  parts.push("1. Tool call:");
  parts.push("```json");
  parts.push(
    '{ "thought": "<reason>", "tool": { "name": "<integration>.<operation>", "input": { ... } } }',
  );
  parts.push("```");
  parts.push("");
  parts.push("2. Final answer (loop exits):");
  parts.push("```json");
  parts.push('{ "thought": "<reason>", "finalAnswer": "<answer for the caller>" }');
  parts.push("```");
  parts.push("");
  parts.push(
    "NEVER emit both `tool` and `finalAnswer`. NEVER emit anything else. No prose outside the JSON. The runtime will feed the tool result back to you on the next turn as role=tool content.",
  );
  parts.push("");
  parts.push(
    "When you have enough information to satisfy the goal, emit finalAnswer. Do not keep calling tools after the goal is met.",
  );

  return parts.join("\n");
}

// ── Default Anthropic PlannerLLM ────────────────────────────────────────────

/**
 * Build the default PlannerLLM backed by Vercel AI SDK's Anthropic provider.
 * Separated so tests can bypass it entirely.
 *
 * IMPORTANT: we keep the import of @ai-sdk/anthropic DYNAMIC so that
 * environments that supply their own plannerLLM override don't have to
 * install @ai-sdk/anthropic. Hence the peer-dependency optional flag in
 * package.json.
 */
function buildDefaultAnthropicPlanner(opts: {
  apiKey?: string;
}): PlannerLLM {
  return async ({ model, systemPrompt, history, signal }) => {
    if (!opts.apiKey) {
      throw new AuthError({
        message:
          "No apiKey supplied to the default Anthropic PlannerLLM — pass a _plannerLLM override or supply ctx.credentials.apiKey.",
        integration: "agent",
        operation: "plan-and-execute",
      });
    }

    // Dynamic import so this package doesn't fail to load when the optional
    // @ai-sdk/anthropic peer dep is absent (users with an override).
    let anthropicMod: typeof import("@ai-sdk/anthropic");
    let aiMod: typeof import("ai");
    try {
      anthropicMod = await import("@ai-sdk/anthropic");
      aiMod = await import("ai");
    } catch (err) {
      throw new IntegrationError({
        message: `agent: default Anthropic planner requires @ai-sdk/anthropic and ai packages (install them or supply a _plannerLLM override). Underlying: ${(err as Error).message}`,
        integration: "agent",
        operation: "plan-and-execute",
        code: "MISSING_PEER_DEP",
      });
    }

    const provider = anthropicMod.createAnthropic({ apiKey: opts.apiKey });
    const languageModel = provider.languageModel(model);

    // Flatten the conversation — system + each history entry maps to the
    // AI SDK's `messages` array with role=system|user|assistant|tool.
    // We encode tool observations as role=user messages with a prefix,
    // because the AI SDK v4's `tool` role requires a paired tool_call_id
    // which we don't track here (the LLM emits names, not IDs).
    const messages = history.map((h) => {
      if (h.role === "tool") {
        return {
          role: "user" as const,
          content: `[tool-observation] ${h.content}`,
        };
      }
      return { role: h.role, content: h.content };
    });
    if (messages.length === 0) {
      messages.push({ role: "user" as const, content: "Begin." });
    }

    const { text, usage } = await aiMod.generateText({
      model: languageModel,
      system: systemPrompt,
      messages,
      abortSignal: signal,
    });

    return {
      ...parsePlannerResponseJson(text),
      usage: {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      },
    };
  };
}

/**
 * Parse an LLM response into a PlannerResponse. Exported for testing.
 * Strict but forgiving:
 *   - Accepts either a raw JSON object or one wrapped in markdown fences.
 *   - Rejects responses that have neither `tool` nor `finalAnswer` at the
 *     top level — caller handles that by re-prompting.
 */
export function parsePlannerResponseJson(raw: string): Omit<
  PlannerResponse,
  "usage"
> {
  let text = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) {
    text = fence[1].trim();
  }
  // Some models prepend `here is...` prose. Try to locate a JSON object.
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    text = text.slice(jsonStart, jsonEnd + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { thought: raw, tool: undefined, finalAnswer: undefined };
  }

  if (!parsed || typeof parsed !== "object") {
    return { thought: raw, tool: undefined, finalAnswer: undefined };
  }

  const obj = parsed as Record<string, unknown>;
  const thought = typeof obj["thought"] === "string" ? obj["thought"] : "";
  const finalAnswer =
    typeof obj["finalAnswer"] === "string" ? obj["finalAnswer"] : undefined;
  const toolField = obj["tool"];
  let tool: { name: string; input: unknown } | undefined;
  if (
    toolField &&
    typeof toolField === "object" &&
    typeof (toolField as Record<string, unknown>)["name"] === "string"
  ) {
    tool = {
      name: (toolField as { name: string }).name,
      input: (toolField as { input?: unknown }).input,
    };
  }

  return { thought, tool, finalAnswer };
}

// ── Error wrapping ─────────────────────────────────────────────────────────

function wrapLLMError(err: unknown): Error {
  if (err instanceof AuthError || err instanceof IntegrationError) return err;
  const asErr = err as { name?: string; message?: string; statusCode?: number };
  const status = asErr.statusCode;
  if (status === 401 || status === 403) {
    return new AuthError({
      message: `agent.plan-and-execute: planner LLM auth failed: ${asErr.message ?? "unknown"}`,
      integration: "agent",
      operation: "plan-and-execute",
      httpStatus: status,
    });
  }
  return new IntegrationError({
    message: `agent.plan-and-execute: planner LLM call failed: ${asErr.message ?? String(err)}`,
    integration: "agent",
    operation: "plan-and-execute",
    code: asErr.name ?? "PLANNER_LLM_ERROR",
    httpStatus: status,
    retryable: status === undefined ? false : status >= 500,
    cause: err,
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
