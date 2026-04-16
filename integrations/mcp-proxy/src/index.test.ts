import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationError,
  type OperationContext,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import integration, {
  buildOverrideKey,
  call,
  installPool,
  listTools,
  loadServersConfig,
  resetPool,
  ServerConfig,
  type MCPProxyClient,
  type MCPProxyRuntime,
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

function makeContext(opts: { snapshot?: SnapshotRecorder; signal?: AbortSignal } = {}): OperationContext {
  return {
    credentials: null,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    signal: opts.signal ?? new AbortController().signal,
    snapshot: opts.snapshot,
  };
}

/**
 * Build a fake MCPProxyClient with configurable listTools / callTool impls.
 * Tracks call count + spawn count so tests can assert on pool reuse.
 */
interface FakeClient extends MCPProxyClient {
  listToolsCalls: number;
  callToolCalls: number;
  closed: boolean;
}

interface FakeClientOpts {
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  callImpl?: (params: { name: string; arguments?: Record<string, unknown> }) => unknown | Promise<unknown>;
  listImpl?: () => unknown | Promise<unknown>;
}

function makeFakeClient(opts: FakeClientOpts = {}): FakeClient {
  const client: FakeClient = {
    listToolsCalls: 0,
    callToolCalls: 0,
    closed: false,
    async listTools() {
      client.listToolsCalls += 1;
      if (opts.listImpl) {
        const result = await opts.listImpl();
        return result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      }
      return {
        tools: (opts.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object" as const },
        })),
      };
    },
    async callTool(params) {
      client.callToolCalls += 1;
      if (opts.callImpl) {
        const out = await opts.callImpl(params);
        return out as Record<string, unknown>;
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      client.closed = true;
    },
  };
  return client;
}

interface FakeRuntimeHandle {
  runtime: MCPProxyRuntime;
  clientsByServer: Record<string, FakeClient>;
  spawnCounts: Record<string, number>;
}

function makeFakeRuntime(builders: Record<string, () => FakeClient>): FakeRuntimeHandle {
  const clientsByServer: Record<string, FakeClient> = {};
  const spawnCounts: Record<string, number> = {};
  const runtime: MCPProxyRuntime = {
    async createClient(serverId) {
      spawnCounts[serverId] = (spawnCounts[serverId] ?? 0) + 1;
      const builder = builders[serverId];
      if (!builder) throw new Error(`test bug: no fake builder for ${serverId}`);
      const c = builder();
      clientsByServer[serverId] = c;
      return c;
    },
  };
  return { runtime, clientsByServer, spawnCounts };
}

const stdioCfg = (command = "npx"): ServerConfig => ({
  transport: "stdio",
  command,
  args: [],
  env: {},
});

beforeEach(() => {
  resetPool();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPool();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@delightfulchorus/integration-mcp-proxy module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("mcp-proxy");
    expect(integration.manifest.authType).toBe("none");
    const ops = integration.manifest.operations.map((o) => o.name);
    expect(ops).toContain("list-tools");
    expect(ops).toContain("call");
    expect(typeof integration.operations["list-tools"]).toBe("function");
    expect(typeof integration.operations.call).toBe("function");
  });

  it("declares no credential types (each upstream server carries its own auth)", () => {
    expect(integration.manifest.credentialTypes).toEqual([]);
  });
});

// ── list-tools ──────────────────────────────────────────────────────────────

describe("list-tools", () => {
  it("returns tool names + schemas from the upstream server", async () => {
    const { runtime } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [
            {
              name: "search_issues",
              description: "Search issues on a repo",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
            { name: "create_issue", inputSchema: { type: "object" } },
          ],
        }),
    });
    installPool(runtime, { github: stdioCfg() });

    const snap = makeSnapshot();
    const res = await listTools({ serverId: "github" }, makeContext({ snapshot: snap }));
    expect(res.tools).toHaveLength(2);
    expect(res.tools[0]!.name).toBe("search_issues");
    expect(res.tools[0]!.description).toBe("Search issues on a repo");
    expect(res.tools[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(res.tools[1]!.name).toBe("create_issue");
    expect(snap.calls.at(-1)?.key).toBe("mcp-proxy.list-tools.ok");
  });

  it("throws MCP_UNKNOWN_SERVER for an unconfigured serverId", async () => {
    const { runtime } = makeFakeRuntime({});
    installPool(runtime, {});
    await expect(
      listTools({ serverId: "ghost-server" }, makeContext()),
    ).rejects.toMatchObject({
      code: "MCP_UNKNOWN_SERVER",
      retryable: false,
    });
  });

  it("wraps transport-spawn errors as NETWORK_ERROR (retryable)", async () => {
    const runtime: MCPProxyRuntime = {
      async createClient() {
        throw new Error("ECONNREFUSED");
      },
    };
    installPool(runtime, { github: stdioCfg() });
    await expect(listTools({ serverId: "github" }, makeContext())).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });
});

// ── call (happy path) ───────────────────────────────────────────────────────

describe("call — happy path", () => {
  it("routes to the right serverId + tool and returns the raw result", async () => {
    const { runtime, clientsByServer } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [{ name: "search_issues", inputSchema: { type: "object" } }],
          callImpl: (params) => ({
            content: [{ type: "text", text: `got ${JSON.stringify(params.arguments)}` }],
          }),
        }),
    });
    installPool(runtime, { github: stdioCfg() });

    const snap = makeSnapshot();
    const res = await call(
      { serverId: "github", tool: "search_issues", args: { query: "bug" } },
      makeContext({ snapshot: snap }),
    );
    expect(res.result).toMatchObject({
      content: [{ type: "text", text: `got {"query":"bug"}` }],
    });
    expect(clientsByServer.github!.callToolCalls).toBe(1);
    expect(snap.calls.at(-1)?.key).toBe("mcp-proxy.call.ok");
  });

  it("falls back to an empty args object if none supplied", async () => {
    let seenArgs: unknown = undefined;
    const { runtime } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [{ name: "ping", inputSchema: { type: "object" } }],
          callImpl: (params) => {
            seenArgs = params.arguments;
            return { content: [{ type: "text", text: "pong" }] };
          },
        }),
    });
    installPool(runtime, { github: stdioCfg() });
    await call(
      { serverId: "github", tool: "ping" },
      makeContext(),
    );
    expect(seenArgs).toEqual({});
  });
});

// ── call (error paths) ──────────────────────────────────────────────────────

describe("call — error paths", () => {
  it("MCP_UNKNOWN_SERVER when serverId is unconfigured", async () => {
    installPool(makeFakeRuntime({}).runtime, {});
    await expect(
      call({ serverId: "nope", tool: "anything" }, makeContext()),
    ).rejects.toMatchObject({
      code: "MCP_UNKNOWN_SERVER",
      retryable: false,
    });
  });

  it("MCP_TOOL_NOT_FOUND when the upstream server does not expose the tool", async () => {
    const { runtime } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [{ name: "search_issues", inputSchema: { type: "object" } }],
        }),
    });
    installPool(runtime, { github: stdioCfg() });
    await expect(
      call({ serverId: "github", tool: "nuke_everything", args: {} }, makeContext()),
    ).rejects.toMatchObject({
      code: "MCP_TOOL_NOT_FOUND",
      retryable: false,
    });
  });

  it("MCP_TOOL_ERROR when the tool returns isError:true", async () => {
    const { runtime } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [{ name: "create_issue", inputSchema: { type: "object" } }],
          callImpl: () => ({
            isError: true,
            content: [{ type: "text", text: "forbidden: missing scope" }],
          }),
        }),
    });
    installPool(runtime, { github: stdioCfg() });
    const snap = makeSnapshot();
    await expect(
      call({ serverId: "github", tool: "create_issue", args: {} }, makeContext({ snapshot: snap })),
    ).rejects.toMatchObject({
      code: "MCP_TOOL_ERROR",
      retryable: false,
    });
    expect(snap.calls.at(-1)?.key).toBe("mcp-proxy.call.tool-error");
  });

  it("NETWORK_ERROR (retryable) when callTool throws and evicts the pool entry", async () => {
    let built = 0;
    const runtime: MCPProxyRuntime = {
      async createClient() {
        built += 1;
        if (built === 1) {
          return makeFakeClient({
            tools: [{ name: "ping", inputSchema: { type: "object" } }],
            callImpl: () => {
              throw new Error("server died");
            },
          });
        }
        return makeFakeClient({
          tools: [{ name: "ping", inputSchema: { type: "object" } }],
          callImpl: () => ({ content: [{ type: "text", text: "pong" }] }),
        });
      },
    };
    installPool(runtime, { github: stdioCfg() });

    await expect(
      call({ serverId: "github", tool: "ping", args: {} }, makeContext()),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
    // Second call should trigger a fresh spawn (pool entry was evicted).
    const res = await call(
      { serverId: "github", tool: "ping", args: {} },
      makeContext(),
    );
    expect((res.result as { content: Array<{ text: string }> }).content[0]!.text).toBe("pong");
    expect(built).toBe(2);
  });

  it("MCP_TIMEOUT (retryable) when the tool hangs past timeoutMs", async () => {
    const { runtime } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [{ name: "slow_op", inputSchema: { type: "object" } }],
          callImpl: () => new Promise(() => {}),
        }),
    });
    installPool(runtime, { github: stdioCfg() });
    await expect(
      call(
        { serverId: "github", tool: "slow_op", args: {}, timeoutMs: 5 },
        makeContext(),
      ),
    ).rejects.toMatchObject({
      code: "MCP_TIMEOUT",
      retryable: true,
    });
  });
});

// ── Pool reuse ──────────────────────────────────────────────────────────────

describe("client pool", () => {
  it("spawns the stdio subprocess only once across multiple calls (reuse)", async () => {
    const { runtime, spawnCounts } = makeFakeRuntime({
      github: () =>
        makeFakeClient({
          tools: [{ name: "ping", inputSchema: { type: "object" } }],
          callImpl: () => ({ content: [{ type: "text", text: "pong" }] }),
        }),
    });
    installPool(runtime, { github: stdioCfg() });

    await listTools({ serverId: "github" }, makeContext());
    await call({ serverId: "github", tool: "ping", args: {} }, makeContext());
    await call({ serverId: "github", tool: "ping", args: {} }, makeContext());
    expect(spawnCounts.github).toBe(1);
  });

  it("coalesces concurrent connects so a parallel burst only spawns once", async () => {
    let resolveConnect!: (c: FakeClient) => void;
    const client = makeFakeClient({
      tools: [{ name: "ping", inputSchema: { type: "object" } }],
    });
    const runtime: MCPProxyRuntime = {
      async createClient() {
        return new Promise<MCPProxyClient>((resolve) => {
          resolveConnect = resolve as (c: FakeClient) => void;
        });
      },
    };
    installPool(runtime, { github: stdioCfg() });

    const p1 = listTools({ serverId: "github" }, makeContext());
    const p2 = listTools({ serverId: "github" }, makeContext());
    resolveConnect(client);
    await Promise.all([p1, p2]);
    // Only one client was ever made because both getters shared the same
    // in-flight promise.
    expect(client.listToolsCalls).toBe(2);
  });
});

// ── Config loading + env substitution ──────────────────────────────────────

describe("config loading", () => {
  it("loads from runtimeServers (highest precedence)", () => {
    const out = loadServersConfig({
      runtimeServers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: ["@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "literal" },
        },
      },
      readFile: () => {
        throw new Error("no files in this test");
      },
      env: {},
    });
    expect(out.github!.transport).toBe("stdio");
    if (out.github!.transport === "stdio") {
      expect(out.github!.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("literal");
    }
  });

  it("substitutes {{env.FOO}} inside env / headers / args / url", () => {
    const out = loadServersConfig({
      runtimeServers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: ["@modelcontextprotocol/server-github", "--project={{env.GITHUB_PROJECT}}"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{env.GITHUB_TOKEN}}" },
        },
        remote: {
          transport: "sse",
          url: "https://{{env.MCP_HOST}}/sse",
          headers: { Authorization: "Bearer {{env.REMOTE_TOKEN}}" },
        },
      },
      readFile: () => {
        throw new Error("no files");
      },
      env: {
        GITHUB_TOKEN: "ghp_abc",
        GITHUB_PROJECT: "chorus",
        MCP_HOST: "api.example.com",
        REMOTE_TOKEN: "bearer-xyz",
      },
    });
    if (out.github!.transport === "stdio") {
      expect(out.github!.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_abc");
      expect(out.github!.args[1]).toBe("--project=chorus");
    }
    if (out.remote!.transport === "sse") {
      expect(out.remote!.url).toBe("https://api.example.com/sse");
      expect(out.remote!.headers.Authorization).toBe("Bearer bearer-xyz");
    }
  });

  it("CHORUS_MCP_<server>_<var> override wins over {{env.FOO}}", () => {
    const out = loadServersConfig({
      runtimeServers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: [],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{env.GITHUB_TOKEN}}" },
        },
      },
      readFile: () => {
        throw new Error("no files");
      },
      env: {
        GITHUB_TOKEN: "should-not-win",
        CHORUS_MCP_GITHUB_GITHUB_PERSONAL_ACCESS_TOKEN: "override-wins",
      },
    });
    if (out.github!.transport === "stdio") {
      expect(out.github!.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("override-wins");
    }
  });

  it("missing env var resolves to empty string (not crash)", () => {
    const out = loadServersConfig({
      runtimeServers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: [],
          env: { TOKEN: "{{env.NOT_SET}}" },
        },
      },
      readFile: () => {
        throw new Error("no files");
      },
      env: {},
    });
    if (out.github!.transport === "stdio") {
      expect(out.github!.env.TOKEN).toBe("");
    }
  });

  it("merges local + home files with runtime overriding both", () => {
    const readFile = (path: string): string => {
      if (path.endsWith(".chorus/mcp-servers.json") || path.endsWith(".chorus\\mcp-servers.json")) {
        return JSON.stringify({
          servers: {
            home: { transport: "stdio", command: "home-cmd", args: [] },
            shared: { transport: "stdio", command: "home-shared", args: [] },
          },
        });
      }
      if (path.endsWith("chorus/mcp-servers.json") || path.endsWith("chorus\\mcp-servers.json")) {
        return JSON.stringify({
          servers: {
            local: { transport: "stdio", command: "local-cmd", args: [] },
            shared: { transport: "stdio", command: "local-shared-wins", args: [] },
          },
        });
      }
      throw new Error(`no file at ${path}`);
    };
    const out = loadServersConfig({
      runtimeServers: {
        runtime: { transport: "stdio", command: "runtime-cmd", args: [] },
      },
      readFile,
      cwd: "/project",
      homeDir: "/home/user",
      env: {},
    });
    expect(Object.keys(out).sort()).toEqual(["home", "local", "runtime", "shared"]);
    if (out.shared!.transport === "stdio") {
      // local file overrode home
      expect(out.shared!.command).toBe("local-shared-wins");
    }
  });

  it("buildOverrideKey normalises non-alnum chars", () => {
    expect(buildOverrideKey("github", "GITHUB_TOKEN")).toBe(
      "CHORUS_MCP_GITHUB_GITHUB_TOKEN",
    );
    expect(buildOverrideKey("my-server", "some.var")).toBe(
      "CHORUS_MCP_MY_SERVER_SOME_VAR",
    );
  });
});
