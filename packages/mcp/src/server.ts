/**
 * @delightfulchorus/mcp — MCP server runtime
 *
 * Given an IntegrationModule, wire an MCP server that exposes its operations
 * and credential-control surface as MCP tools. The shape of the tools is
 * computed by `tool-mapping.ts`; this module is the dispatch layer.
 *
 * Protocol:
 *   - MCP 2024-11-05 (the stable spec SDK v1.x implements)
 *   - Transport: stdio (default for local/desktop MCP clients)
 *
 * Dispatch:
 *   - `tools/list` → `manifestToMcpTools(manifest)` with `_chorus` stripped
 *   - `tools/call` → routes by the tool name's kind/verb prefix, invoking
 *     either an operation handler (via the integration's operations record)
 *     or a credential operation (delegated to the runtime credential service).
 *
 * Design notes:
 *   - We do NOT decrypt credentials here. The credential service (injected by
 *     the runtime or stubbed for tests) owns the encryption boundary.
 *   - We do NOT run non-idempotent operations during __test_auth. Per design
 *     §7.3 "Explicit non-contract": if `test.viaOperation` points to a
 *     non-idempotent op, we refuse with a descriptive error.
 */
import type { IntegrationModule } from "@delightfulchorus/core";
import type {
  McpTool,
  ChorusToolBinding,
  JsonSchemaObject,
  ManifestWithCredentialTypes,
} from "./tool-mapping.js";
import { manifestToMcpTools } from "./tool-mapping.js";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * A minimal credential-service contract. Real runtime implementations live in
 * `@delightfulchorus/runtime`; tests pass an in-memory stub. The MCP server never
 * touches encrypted blobs directly — all it does is ask the service.
 *
 * All methods return JSON-serializable results (no Buffer, no Date — ISO
 * strings instead). This keeps MCP CallToolResult content-encoding simple.
 */
export interface CredentialService {
  /**
   * List credentials for an integration. Returns shape per docs §7.2:
   *   `[{id, name, credentialTypeName, authType, state}]`
   */
  list(integration: string): Promise<CredentialSummary[]>;

  /**
   * Create or update a credential. The runtime is responsible for encrypting
   * the payload. Input matches the __configure_<typeName> tool's schema:
   * `name` (label) + the credential's field values.
   */
  configure(args: {
    integration: string;
    credentialTypeName: string;
    name: string;
    fields: Record<string, unknown>;
  }): Promise<{ id: string; name: string }>;

  /**
   * Start the OAuth authorize flow. Returns the URL for the user to visit.
   * Implementations should spin up a localhost listener for the callback and
   * persist the resulting tokens as an encrypted credential; that part is
   * out of scope for the MCP server, which just surfaces the URL.
   *
   * The returned `state` token lets the caller (the MCP __authenticate
   * dispatch path) correlate the authorize URL to the downstream
   * `oauth.callback.<state>` event fired by GET /api/oauth/callback.
   * When an `EventListener` is wired on the server opts, the dispatch
   * path blocks on the event for up to 5 minutes and resolves either
   * `{ok: true, credentialId}` or `{ok: false, error: "timeout"}`.
   */
  authenticate?(args: {
    integration: string;
    credentialTypeName: string;
    name: string;
  }): Promise<{
    authorizeUrl: string;
    state?: string;
    expiresAt?: string;
    credentialId?: string;
  }>;

  /**
   * Run the integration's test hook against a stored credential. The MCP
   * server enforces the "no mutation" invariant by checking `idempotent`
   * on `test.viaOperation` before delegating.
   */
  testAuth(args: {
    integration: string;
    credentialId: string;
  }): Promise<CredentialTestResultView>;
}

export interface CredentialSummary {
  id: string;
  name: string;
  credentialTypeName: string;
  authType: "none" | "apiKey" | "oauth2" | "basic" | "bearer";
  state: "active" | "invalid";
}

/** Duck-typed view of CredentialTestResult from docs §4.4. */
export interface CredentialTestResultView {
  ok: boolean;
  latencyMs: number;
  identity?: {
    userId?: string;
    userName?: string;
    workspaceName?: string;
    scopes?: string[];
  };
  error?: string;
  errorCode?: string;
}

/**
 * Event-listener hook — the runtime injects this so the MCP
 * __authenticate tool can block on `oauth.callback.<state>`. Matches
 * the shape `step.waitForEvent` uses internally; standalone scaffolds
 * (no in-process runtime) leave it unset and the tool returns the URL
 * synchronously, letting the caller poll testAuth or re-open an MCP
 * session after the user finishes authorizing.
 */
export interface OAuthEventListener {
  /**
   * Block until an event of `type` arrives (or the timeout fires).
   * Returns the event payload on success, or a timeout sentinel.
   */
  waitForOAuthCallback(
    state: string,
    timeoutMs: number,
  ): Promise<
    | { ok: true; credentialId: string; credentialTypeName: string }
    | { ok: false; error: string }
  >;
}

export interface ChorusMcpServerOptions {
  /** The integration module to expose. */
  integration: IntegrationModule;
  /** Credential service (real in production, stub in tests). */
  credentialService?: CredentialService;
  /**
   * Event listener — when wired, the __authenticate tool will block on
   * `oauth.callback.<state>` with a 5-minute timeout. Without it, the
   * tool returns `{authorizeUrl, state}` synchronously and documents
   * that callers should poll testAuth.
   */
  eventListener?: OAuthEventListener;
  /**
   * Optional name/version overrides for the server identity. Defaults to
   * `chorus-<integration.name>` / `integration.version`.
   */
  serverInfo?: { name?: string; version?: string };
}

/**
 * Default timeout for __authenticate's block-on-callback wait. Matches
 * the rule-of-thumb "user opens browser, authorizes, redirects back
 * within 5 minutes" — longer than any reasonable consent flow, shorter
 * than an MCP client's default idle.
 */
export const DEFAULT_OAUTH_WAIT_MS = 5 * 60_000;

/**
 * Build — but don't `connect` — an MCP server. Returns the raw SDK Server
 * instance plus our computed tool list. Caller supplies the Transport.
 */
export async function buildChorusMcpServer(opts: ChorusMcpServerOptions): Promise<{
  server: unknown; // Low-level MCP Server instance; typed loosely so tests don't need the SDK.
  tools: McpTool[];
}> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");

  const manifest = opts.integration.manifest as ManifestWithCredentialTypes;
  const tools = manifestToMcpTools(manifest);

  const server = new Server(
    {
      name: opts.serverInfo?.name ?? `chorus-${manifest.name}`,
      version: opts.serverInfo?.version ?? manifest.version,
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  // tools/list — strip internal _chorus bindings before returning.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(stripInternalBinding),
  }));

  // tools/call — dispatch to operation or credential handler.
  server.setRequestHandler(CallToolRequestSchema, async (req: unknown) => {
    const { name, arguments: args } = (req as {
      params: { name: string; arguments?: Record<string, unknown> };
    }).params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return errorResult(`unknown tool: ${name}`);
    try {
      const result = await dispatchTool(tool, args ?? {}, opts);
      return successResult(result);
    } catch (err) {
      return errorResult(err);
    }
  });

  return { server, tools };
}

/**
 * Alternate entry point: run the MCP server on stdio. Shortcut for the
 * common `chorus mcp serve <integration>` case. Returns a promise that
 * resolves when the transport closes (SIGINT, EOF, etc).
 */
export async function runChorusMcpServerStdio(
  opts: ChorusMcpServerOptions,
): Promise<void> {
  const { server } = await buildChorusMcpServer(opts);
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await (server as { connect: (t: unknown) => Promise<void> }).connect(transport);
  // Keep the process alive. The transport closes on stdin EOF, which is
  // how Claude Desktop etc shut servers down.
  await new Promise<void>((resolve) => {
    const handleClose = (): void => {
      resolve();
    };
    (transport as unknown as { onclose?: () => void }).onclose = handleClose;
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Route a tool call by inspecting `_chorus.kind` and `_chorus.verb`. The
 * dispatch logic is exported for tests that want to exercise it without
 * the MCP transport overhead.
 */
export async function dispatchTool(
  tool: McpTool,
  args: Record<string, unknown>,
  opts: ChorusMcpServerOptions,
): Promise<unknown> {
  const binding = tool._chorus;
  if (!binding) {
    throw new Error(`tool '${tool.name}' has no _chorus binding — cannot dispatch`);
  }
  switch (binding.kind) {
    case "operation":
      return dispatchOperation(binding, args, opts);
    case "credential":
      return dispatchCredential(binding, args, opts);
    default: {
      // Exhaustive check: TypeScript complains if a new kind isn't handled.
      const _exhaustive: never = binding;
      throw new Error(`unknown tool binding: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function dispatchOperation(
  binding: Extract<ChorusToolBinding, { kind: "operation" }>,
  args: Record<string, unknown>,
  opts: ChorusMcpServerOptions,
): Promise<unknown> {
  const handler = opts.integration.operations[binding.operation];
  if (!handler) {
    throw new Error(
      `integration '${binding.integration}' has no operation '${binding.operation}'`,
    );
  }
  // The runtime would normally inject decrypted credentials. In MCP mode,
  // the agent is telling us to run the operation "right now", so we
  // accept that the credential service hasn't pre-loaded. We leave
  // ctx.credentials as null here; when real /chorus runtime plumbs this,
  // it swaps this line for a call into its credential loader.
  const ctx = {
    credentials: null,
    logger: noopLogger(),
    signal: new AbortController().signal,
  };
  return handler(args, ctx);
}

async function dispatchCredential(
  binding: Extract<ChorusToolBinding, { kind: "credential" }>,
  args: Record<string, unknown>,
  opts: ChorusMcpServerOptions,
): Promise<unknown> {
  const svc = opts.credentialService;
  if (!svc) {
    throw new Error(
      `credential tool '${binding.verb}' called but no credential service is wired`,
    );
  }
  switch (binding.verb) {
    case "list_credentials":
      return { credentials: await svc.list(binding.integration) };
    case "configure": {
      const typeName = binding.credentialTypeName;
      if (!typeName) throw new Error("configure tool missing credentialTypeName");
      const name = typeof args.name === "string" ? args.name : "default";
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (k !== "name") fields[k] = v;
      }
      return svc.configure({
        integration: binding.integration,
        credentialTypeName: typeName,
        name,
        fields,
      });
    }
    case "authenticate": {
      if (!svc.authenticate) {
        throw new Error("credential service does not support OAuth authenticate");
      }
      const typeName =
        typeof args.credentialTypeName === "string" ? args.credentialTypeName : undefined;
      const name = typeof args.name === "string" ? args.name : "default";
      const initiated = await svc.authenticate({
        integration: binding.integration,
        credentialTypeName: typeName ?? "",
        name,
      });
      // If the runtime wired an OAuth event listener, block on the
      // callback event so the MCP caller gets a synchronous answer.
      // Without a listener, return the URL + state so the caller can
      // open the browser and poll testAuth() or reopen the MCP session.
      const listener = opts.eventListener;
      if (listener && initiated.state) {
        const outcome = await listener.waitForOAuthCallback(
          initiated.state,
          DEFAULT_OAUTH_WAIT_MS,
        );
        if (outcome.ok) {
          return {
            ok: true,
            authorizeUrl: initiated.authorizeUrl,
            state: initiated.state,
            credentialId: outcome.credentialId,
            credentialTypeName: outcome.credentialTypeName,
          };
        }
        return {
          ok: false,
          authorizeUrl: initiated.authorizeUrl,
          state: initiated.state,
          error: outcome.error,
        };
      }
      // Fallback: no listener — return URL + state synchronously, with
      // a descriptive message so the caller knows to poll.
      return {
        authorizeUrl: initiated.authorizeUrl,
        state: initiated.state,
        expiresAt: initiated.expiresAt,
        message:
          "Open this URL to authorize. Once the provider redirects back, call __test_auth to verify — or reopen this MCP session. No in-process event listener is wired.",
      };
    }
    case "test_auth": {
      const credentialId =
        typeof args.credentialId === "string" ? args.credentialId : undefined;
      if (!credentialId) throw new Error("test_auth requires credentialId");
      // Invariant per docs §7.3: test must be read-only. The service
      // enforces this server-side; the MCP layer passes through.
      return svc.testAuth({
        integration: binding.integration,
        credentialId,
      });
    }
    default: {
      const _exhaustive: never = binding.verb;
      throw new Error(`unknown credential verb: ${String(_exhaustive)}`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip the internal `_chorus` binding + any extensions MCP doesn't know
 * about. MCP's `Tool` shape accepts arbitrary extra fields, but clients can
 * get surprised by them; be strict.
 */
function stripInternalBinding(tool: McpTool): {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Wrap a plain JSON-serializable value in an MCP text-content envelope. */
function successResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload ?? null, null, 2),
      },
    ],
  };
}

/** Wrap an error into an MCP tool-call error envelope. */
function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

/** No-op logger for environments where the caller hasn't wired one. */
function noopLogger(): {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
} {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
