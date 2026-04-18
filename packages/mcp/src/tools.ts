/**
 * Standalone MCP tools — not tied to any integration manifest.
 *
 * The existing Chorus MCP surface maps ONE integration → N tools. Some
 * capabilities are inherently server-level (they talk to the runtime, not
 * to a specific integration). This module hosts those tools; callers
 * (`packages/runtime`, a future `chorus mcp tools` command, or an agent
 * shell) can mount them directly onto any MCP server.
 *
 * First tool: `generate_dashboard` — asks the runtime to produce an
 * LLM-generated dashboard and returns the URL to open it.
 *
 * Dispatch contract (matches the pattern used in server.ts):
 *   - Each tool has a plain MCP shape (name, description, inputSchema).
 *   - Each tool has a matching `handle*` function that runs it against
 *     injected dependencies so the dispatcher stays pure and testable.
 *   - Handlers never throw; they return a shaped result so the caller
 *     can wrap it in the MCP content envelope.
 */

import type { JsonSchemaObject } from "./tool-mapping.js";

// ── generate_dashboard ──────────────────────────────────────────────────────

/**
 * Inputs accepted by `generate_dashboard`. The `prompt` is optional; when
 * omitted, the runtime uses the default "build a workflow-tailored
 * dashboard" instructions. When present, it REPLACES the default
 * instruction block (the workflow/context summary is still appended).
 */
export interface GenerateDashboardInput {
  /** Optional override instructions sent to the Haiku model. */
  prompt?: string;
  /**
   * When true, ignore the on-disk cache and always call the model. The
   * runtime defaults to reusing a cached dashboard when the workflow set
   * hasn't changed; a custom prompt usually wants a fresh generation.
   */
  force?: boolean;
}

/**
 * Shape of the tool result returned to the caller. Matches the fields
 * the runtime's `GenerateDashboardResult` already produces, plus the
 * dashboard URL + a hint to `open` it.
 */
export interface GenerateDashboardOutput {
  ok: boolean;
  /** Full URL the agent should instruct the user to open. */
  url: string;
  /** `cache` if a cached dashboard was reused, `generated` on fresh LLM call, `error`/`skipped` otherwise. */
  source: "cache" | "generated" | "error" | "skipped";
  /** Short human-readable status/error message. */
  message: string;
  /** Cache key that identifies the dashboard bundle. */
  cacheKey: string | null;
}

export const GENERATE_DASHBOARD_TOOL_NAME = "generate_dashboard";

export const generateDashboardTool: {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
} = {
  name: GENERATE_DASHBOARD_TOOL_NAME,
  description:
    "Generate (or reuse) an LLM-tailored dashboard for the currently running Chorus workflows and return a URL to open it. With no prompt, the runtime uses its default instructions. With a prompt, it replaces the default instructions (the workflow/context summary is always appended). The dashboard is served at /dashboard on the runtime's listen port — the returned URL is the agent-facing way to surface the dashboard back to the user.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Optional custom instructions for the dashboard generator. Example: 'Show only the Slack integration runs in a compact feed'.",
      },
      force: {
        type: "boolean",
        description:
          "When true, bypass the cached dashboard and always regenerate. Defaults to true when a prompt is supplied (custom prompts always regenerate).",
      },
    },
    additionalProperties: false,
  },
};

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * Duck-typed view of what the runtime's `maybeGenerateDashboard` returns.
 * Kept local so this module has no hard dep on @delightfulchorus/runtime
 * (that would create a cyclic edge: runtime depends on mcp via the CLI).
 */
export interface DashboardGenerator {
  (opts: {
    /** Array of workflow summaries the runtime currently has loaded. */
    workflows: Array<{
      id: string;
      name: string;
      version: number;
      trigger: { type: string };
      nodes: unknown[];
    }>;
    displayUrl: string;
    customPrompt?: string;
    noCache?: boolean;
  }): Promise<{
    ok: boolean;
    source: "cache" | "generated" | "error" | "skipped";
    message: string;
    cacheKey: string | null;
  }>;
}

export interface HandleGenerateDashboardDeps {
  /**
   * Return the runtime's current listen URL + loaded workflows. The
   * caller wires this from the live `ChorusServer` instance.
   */
  getContext: () => Promise<{
    displayUrl: string;
    workflows: Array<{
      id: string;
      name: string;
      version: number;
      trigger: { type: string };
      nodes: unknown[];
    }>;
  }>;
  /** The runtime's `maybeGenerateDashboard` (injected for decoupling). */
  generator: DashboardGenerator;
}

/**
 * Execute `generate_dashboard`. Never throws — all failure modes are
 * folded into the `GenerateDashboardOutput.ok=false` branch so the MCP
 * envelope can surface them to the agent without disconnecting.
 */
export async function handleGenerateDashboard(
  input: GenerateDashboardInput,
  deps: HandleGenerateDashboardDeps,
): Promise<GenerateDashboardOutput> {
  try {
    const ctx = await deps.getContext();
    const noCache =
      typeof input.force === "boolean"
        ? input.force
        : Boolean(input.prompt && input.prompt.trim().length > 0);
    const result = await deps.generator({
      workflows: ctx.workflows,
      displayUrl: ctx.displayUrl,
      customPrompt: input.prompt,
      noCache,
    });
    return {
      ok: result.ok,
      url: `${ctx.displayUrl}/dashboard`,
      source: result.source,
      message: result.message,
      cacheKey: result.cacheKey,
    };
  } catch (err) {
    return {
      ok: false,
      url: "",
      source: "error",
      message: err instanceof Error ? err.message : String(err),
      cacheKey: null,
    };
  }
}

// ── Registration helper ─────────────────────────────────────────────────────

/**
 * Attach the server-level tools to a Chorus MCP server instance. Hosts
 * that mount server-level tools (the runtime's `startServer` will do this
 * when we add an optional `mountServerTools` hook in a future change)
 * call this with their Server + deps.
 *
 * Kept thin so we can unit-test the dispatch branch without a real SDK.
 */
export const SERVER_LEVEL_TOOLS = [generateDashboardTool];

export interface ServerToolDispatchEnvelope {
  tool: string;
  args: Record<string, unknown>;
}

export interface ServerToolDispatchResult {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Single dispatch entry point for every server-level tool. The MCP
 * server's `tools/call` handler can forward any call it doesn't
 * recognize (name is not in the integration's tool list) to this.
 */
export async function dispatchServerTool(
  env: ServerToolDispatchEnvelope,
  deps: HandleGenerateDashboardDeps,
): Promise<ServerToolDispatchResult> {
  if (env.tool === GENERATE_DASHBOARD_TOOL_NAME) {
    const out = await handleGenerateDashboard(
      (env.args as GenerateDashboardInput) ?? {},
      deps,
    );
    return {
      isError: !out.ok,
      content: [
        {
          type: "text",
          text: JSON.stringify(out, null, 2),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `unknown server-level tool: ${env.tool}`,
      },
    ],
  };
}
