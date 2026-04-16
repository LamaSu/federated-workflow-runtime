/**
 * @delightfulchorus/integration-mcp-proxy
 *
 * Forward Chorus operations to ANY external MCP server. One integration,
 * the entire MCP ecosystem (GitHub, Postgres, Filesystem, Exa, etc.) — the
 * user points us at a server config, we lazily spawn the subprocess (stdio)
 * or open the SSE connection, and forward `listTools` / `callTool` calls.
 *
 * See research/04-integration-architecture.md §2 for the reasoning — rather
 * than re-implement 500+ per-service integrations, we ride the existing MCP
 * server ecosystem.
 *
 * Auth model:
 *   This integration itself is `authType: "none"`. Each upstream MCP server
 *   defines its own auth (GitHub server reads `GITHUB_PERSONAL_ACCESS_TOKEN`
 *   from env, a custom SSE server reads a bearer header, etc.). Secrets are
 *   injected via either:
 *     (a) `{{env.VAR}}` substitution inside `mcp-servers.json`, or
 *     (b) the per-server override `CHORUS_MCP_<SERVER>_<VAR>` env var — use
 *         this in production so secrets never touch the config file.
 *
 * Chorus contract notes:
 *   - Unknown serverId → IntegrationError `MCP_UNKNOWN_SERVER` retryable:false
 *   - Unknown tool → IntegrationError `MCP_TOOL_NOT_FOUND` retryable:false
 *   - Tool signals isError:true → IntegrationError `MCP_TOOL_ERROR` retryable:false
 *   - Transport close / subprocess death mid-call → IntegrationError
 *     `NETWORK_ERROR` retryable:true, and we evict the pool so next call
 *     reconnects.
 *   - 30s default timeout per call → IntegrationError `MCP_TIMEOUT` retryable:true
 */
import {
  IntegrationError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import { z } from "zod";
import {
  ClientPool,
  defaultRuntime,
  type MCPProxyRuntime,
  type MCPToolInfo,
} from "./client-pool.js";
import { loadServersConfig, type ServerConfig } from "./config.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const ListToolsInputSchema = z.object({
  serverId: z.string().min(1),
});

export const ListToolsOutputSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()),
      outputSchema: z.record(z.unknown()).optional(),
    }),
  ),
});

export const CallInputSchema = z.object({
  serverId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export const CallOutputSchema = z.object({
  /**
   * The raw MCP CallToolResult. We pass this through unwrapped because
   * MCP tools return a mix of `content[]`, `structuredContent`, and legacy
   * `toolResult`; the caller knows the shape of the target tool.
   */
  result: z.unknown(),
});

export type ListToolsInput = z.infer<typeof ListToolsInputSchema>;
export type ListToolsOutput = z.infer<typeof ListToolsOutputSchema>;
export type CallInput = z.input<typeof CallInputSchema>;
export type CallParsed = z.output<typeof CallInputSchema>;
export type CallOutput = z.infer<typeof CallOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "mcp-proxy",
  version: "0.1.0",
  description:
    "Proxy to any external MCP server. Point at GitHub, Filesystem, Postgres, or a custom SSE server — auto-spawn subprocess / connect, forward listTools/callTool.",
  authType: "none",
  /**
   * This integration is credential-less from Chorus's POV. Each upstream
   * server's auth lives in `mcp-servers.json` (env-substituted) or the
   * CHORUS_MCP_<server>_<var> override, neither of which goes through the
   * Chorus credential store.
   */
  credentialTypes: [],
  docsUrl: "https://github.com/modelcontextprotocol/servers",
  operations: [
    {
      name: "list-tools",
      description:
        "List tools exposed by a configured MCP server. Connects lazily on first call.",
      idempotent: true,
      inputSchema: {
        type: "object",
        required: ["serverId"],
        properties: {
          serverId: { type: "string", minLength: 1 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["tools"],
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "inputSchema"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              },
            },
          },
        },
      },
    },
    {
      name: "call",
      description:
        "Invoke a tool on a configured MCP server. Returns the raw CallToolResult.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["serverId", "tool"],
        properties: {
          serverId: { type: "string", minLength: 1 },
          tool: { type: "string", minLength: 1 },
          args: { type: "object" },
          timeoutMs: { type: "number", minimum: 1, maximum: 600000 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: {
          result: {},
        },
      },
    },
  ],
};

// ── Pool singleton (per process) ────────────────────────────────────────────

let defaultPool: ClientPool | null = null;
let poolRuntime: MCPProxyRuntime = defaultRuntime();

/**
 * Reset the per-process pool. Used by tests and by the CLI on config reload.
 */
export function resetPool(): void {
  if (defaultPool) defaultPool.closeAll().catch(() => {});
  defaultPool = null;
}

/**
 * Inject a different runtime (tests swap in a fake-client factory here).
 * Also resets the pool so the next call picks up the new runtime.
 */
export function setRuntime(runtime: MCPProxyRuntime): void {
  poolRuntime = runtime;
  resetPool();
}

/**
 * Extract server-definitions from ctx + config files. Exported so tests can
 * drive it directly.
 */
export function resolveServers(ctx: OperationContext | undefined): Record<string, ServerConfig> {
  // OperationContext doesn't expose `config` in the current type, but the
  // runtime hands it on ctx as an extra property. We read it defensively.
  const extra = ctx as unknown as { config?: { mcpServers?: Record<string, unknown> } };
  return loadServersConfig({
    runtimeServers: extra?.config?.mcpServers,
  });
}

function getPool(ctx: OperationContext | undefined): ClientPool {
  if (defaultPool) return defaultPool;
  const servers = resolveServers(ctx);
  defaultPool = new ClientPool(poolRuntime, servers);
  return defaultPool;
}

/**
 * Test/CLI helper: build a pool directly with given servers + runtime and
 * make it the process-wide default. Saves tests from munging process.cwd.
 */
export function installPool(
  runtime: MCPProxyRuntime,
  servers: Record<string, ServerConfig>,
): ClientPool {
  resetPool();
  poolRuntime = runtime;
  defaultPool = new ClientPool(runtime, servers);
  return defaultPool;
}

// ── Handlers ────────────────────────────────────────────────────────────────

export const listTools: OperationHandler<ListToolsInput, ListToolsOutput> = async (
  input,
  ctx,
) => {
  const parsed = ListToolsInputSchema.parse(input);
  const pool = getPool(ctx);

  if (!pool.has(parsed.serverId)) {
    throw new IntegrationError({
      message: `mcp-proxy: no upstream server configured with serverId='${parsed.serverId}'`,
      integration: "mcp-proxy",
      operation: "list-tools",
      code: "MCP_UNKNOWN_SERVER",
      retryable: false,
    });
  }

  let client;
  try {
    client = await pool.getClient(parsed.serverId);
  } catch (err) {
    throw wrapTransportError("list-tools", parsed.serverId, err);
  }

  let res;
  try {
    res = await client.listTools();
  } catch (err) {
    pool.evict(parsed.serverId);
    throw wrapTransportError("list-tools", parsed.serverId, err);
  }

  const tools = (res.tools ?? []).map((t: MCPToolInfo) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
  }));

  await ctx.snapshot?.record(
    "mcp-proxy.list-tools.ok",
    { serverId: parsed.serverId },
    { toolCount: tools.length, toolNames: tools.map((t) => t.name) },
  );

  return { tools };
};

export const call: OperationHandler<CallInput, CallOutput> = async (input, ctx) => {
  const parsed = CallInputSchema.parse(input);
  const pool = getPool(ctx);

  if (!pool.has(parsed.serverId)) {
    throw new IntegrationError({
      message: `mcp-proxy: no upstream server configured with serverId='${parsed.serverId}'`,
      integration: "mcp-proxy",
      operation: "call",
      code: "MCP_UNKNOWN_SERVER",
      retryable: false,
    });
  }

  let client;
  try {
    client = await pool.getClient(parsed.serverId);
  } catch (err) {
    throw wrapTransportError("call", parsed.serverId, err);
  }

  // Discover the tool first; we want a friendly `MCP_TOOL_NOT_FOUND` error
  // rather than whatever the upstream server happens to throw.
  let tools: MCPToolInfo[];
  try {
    const listed = await client.listTools();
    tools = listed.tools ?? [];
  } catch (err) {
    pool.evict(parsed.serverId);
    throw wrapTransportError("call", parsed.serverId, err);
  }
  if (!tools.some((t) => t.name === parsed.tool)) {
    throw new IntegrationError({
      message: `mcp-proxy: tool '${parsed.tool}' not found on server '${parsed.serverId}' (available: ${tools.map((t) => t.name).join(", ") || "none"})`,
      integration: "mcp-proxy",
      operation: "call",
      code: "MCP_TOOL_NOT_FOUND",
      retryable: false,
    });
  }

  // Apply the timeout via Promise.race with an abort.
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new IntegrationError({
            message: `mcp-proxy: callTool '${parsed.tool}' on '${parsed.serverId}' exceeded ${parsed.timeoutMs}ms`,
            integration: "mcp-proxy",
            operation: "call",
            code: "MCP_TIMEOUT",
            retryable: true,
          }),
        ),
      parsed.timeoutMs,
    ).unref?.() ?? undefined,
  );

  let result;
  try {
    result = await Promise.race([
      client.callTool({ name: parsed.tool, arguments: parsed.args }),
      deadline,
    ]);
  } catch (err) {
    if (err instanceof IntegrationError) throw err; // already wrapped (MCP_TIMEOUT)
    pool.evict(parsed.serverId);
    throw wrapTransportError("call", parsed.serverId, err);
  }

  // MCP surfaces tool-level failures via `isError: true` + content. Promote
  // that to an IntegrationError so Chorus's retry/backoff logic sees it the
  // same way as any other integration-layer error.
  if (result && typeof result === "object" && (result as { isError?: boolean }).isError === true) {
    const content = (result as { content?: unknown }).content;
    const message =
      Array.isArray(content) && content.length > 0
        ? stringifyMCPContent(content)
        : "MCP tool returned isError:true without content";
    await ctx.snapshot?.record(
      "mcp-proxy.call.tool-error",
      { serverId: parsed.serverId, tool: parsed.tool },
      { isError: true, content },
    );
    throw new IntegrationError({
      message: `mcp-proxy: tool '${parsed.tool}' on '${parsed.serverId}' errored: ${message}`,
      integration: "mcp-proxy",
      operation: "call",
      code: "MCP_TOOL_ERROR",
      retryable: false,
    });
  }

  await ctx.snapshot?.record(
    "mcp-proxy.call.ok",
    { serverId: parsed.serverId, tool: parsed.tool, argKeys: Object.keys(parsed.args) },
    {
      hasContent: Array.isArray((result as { content?: unknown }).content),
      hasStructured: (result as { structuredContent?: unknown }).structuredContent !== undefined,
    },
  );

  return { result };
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function wrapTransportError(
  operation: "list-tools" | "call",
  serverId: string,
  err: unknown,
): IntegrationError {
  const message = err instanceof Error ? err.message : String(err);
  return new IntegrationError({
    message: `mcp-proxy: transport error talking to '${serverId}': ${message}`,
    integration: "mcp-proxy",
    operation,
    code: "NETWORK_ERROR",
    retryable: true,
    cause: err,
  });
}

function stringifyMCPContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
      parts.push((c as { text: string }).text);
    }
  }
  return parts.join("\n") || "(no text content)";
}

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    "list-tools": listTools as OperationHandler,
    call: call as OperationHandler,
  },
};

export default integration;
export * from "./client-pool.js";
export * from "./config.js";
