/**
 * Lazy-spawned pool of MCP Clients, one per configured upstream serverId.
 *
 * Design notes:
 *   - The first call to `getClient(serverId)` resolves + caches the Client.
 *   - Subsequent calls within the same process re-use the live connection,
 *     so we don't re-spawn npx subprocesses on every workflow invocation.
 *   - On transport close / subprocess death we evict the cache entry so the
 *     next call reconnects. Callers that care about retry-ability surface
 *     this as `NETWORK_ERROR retryable: true`.
 *   - We keep the MCP SDK import surface narrow (Client + transports +
 *     a single `listTools`/`callTool` surface) so the integration stays
 *     mock-able in unit tests.
 *
 * The factory functions here are injectable via the `MCPProxyRuntime` type,
 * which lets the test suite swap in a fake Client without spawning real
 * subprocesses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ServerConfig } from "./config.js";

// ── Minimal client surface we actually call ────────────────────────────────
// (Mirrors the @modelcontextprotocol/sdk Client API we rely on. Keeps test
// mocks honest — if we add a call here that the mock doesn't satisfy, the
// compile fails.)

export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface MCPListToolsResponse {
  tools: MCPToolInfo[];
}

export interface MCPCallToolResponse {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  toolResult?: unknown;
  [key: string]: unknown;
}

export interface MCPProxyClient {
  listTools(params?: Record<string, unknown>): Promise<MCPListToolsResponse>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<MCPCallToolResponse>;
  close(): Promise<void>;
}

// ── Factory interface ───────────────────────────────────────────────────────

/**
 * Runtime-injectable factory bundle. The default implementation constructs
 * real `@modelcontextprotocol/sdk` Client instances; tests pass their own
 * factory that returns fake clients.
 */
export interface MCPProxyRuntime {
  /** Build + connect a Client given a server config. */
  createClient(serverId: string, config: ServerConfig): Promise<MCPProxyClient>;
}

export class ClientPool {
  private readonly clients = new Map<string, MCPProxyClient>();
  private readonly inflight = new Map<string, Promise<MCPProxyClient>>();

  constructor(
    private readonly runtime: MCPProxyRuntime,
    private readonly servers: Record<string, ServerConfig>,
  ) {}

  has(serverId: string): boolean {
    return serverId in this.servers;
  }

  getConfig(serverId: string): ServerConfig | undefined {
    return this.servers[serverId];
  }

  /**
   * Resolve a Client for the given serverId. Spawns / connects lazily on
   * first call. Concurrent callers share a single in-flight connect promise.
   */
  async getClient(serverId: string): Promise<MCPProxyClient> {
    const cached = this.clients.get(serverId);
    if (cached) return cached;
    const existing = this.inflight.get(serverId);
    if (existing) return existing;

    const config = this.servers[serverId];
    if (!config) {
      throw new Error(`mcp-proxy: unknown serverId '${serverId}'`);
    }

    const promise = this.runtime.createClient(serverId, config).then(
      (client) => {
        this.clients.set(serverId, client);
        this.inflight.delete(serverId);
        return client;
      },
      (err) => {
        this.inflight.delete(serverId);
        throw err;
      },
    );
    this.inflight.set(serverId, promise);
    return promise;
  }

  /** Drop a cached client (e.g. on transport death) so the next call reconnects. */
  evict(serverId: string): void {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (client) {
      // Fire-and-forget close; errors closing a dead socket are fine.
      client.close().catch(() => {});
    }
  }

  /** Close every live client. Called on integration teardown. */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(entries.map((c) => c.close()));
  }
}

// ── Default runtime (real MCP SDK) ──────────────────────────────────────────

/**
 * Build the default runtime that talks to real MCP servers. Callers that want
 * to inject fakes in tests construct their own `MCPProxyRuntime` directly.
 */
export function defaultRuntime(): MCPProxyRuntime {
  return {
    async createClient(_serverId, config) {
      const client = new Client(
        { name: "chorus-mcp-proxy", version: "0.1.2" },
        { capabilities: {} },
      );
      if (config.transport === "stdio") {
        // StdioClientTransport spawns a child process; `env` here MUST be
        // fully string-keyed (already true since zod forces that shape).
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        });
        await client.connect(transport);
      } else {
        const transport = new SSEClientTransport(new URL(config.url), {
          requestInit: {
            headers: config.headers,
          },
        });
        await client.connect(transport);
      }
      // Thin wrapper so the shape matches MCPProxyClient exactly.
      return {
        async listTools(params) {
          const res = await client.listTools(params);
          return {
            tools: (res.tools ?? []).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema as Record<string, unknown>,
              outputSchema: t.outputSchema as Record<string, unknown> | undefined,
            })),
          };
        },
        async callTool(params) {
          const res = await client.callTool({
            name: params.name,
            arguments: params.arguments ?? {},
          });
          return res as MCPCallToolResponse;
        },
        async close() {
          await client.close();
        },
      };
    },
  };
}
