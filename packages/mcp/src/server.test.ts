import { describe, expect, it } from "vitest";
import type {
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
} from "@chorus/core";
import {
  buildChorusMcpServer,
  dispatchTool,
  type CredentialService,
} from "./server.js";
import type { ManifestWithCredentialTypes, McpTool } from "./tool-mapping.js";
import { manifestToMcpTools } from "./tool-mapping.js";

// ── Fixture integration ─────────────────────────────────────────────────────

const slackManifest: ManifestWithCredentialTypes = {
  name: "slack-send",
  version: "0.1.0",
  description: "Slack test fixture",
  authType: "oauth2",
  docsUrl: "https://api.slack.com",
  operations: [
    {
      name: "postMessage",
      description: "Post a message.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["channel", "text"],
        properties: {
          channel: { type: "string" },
          text: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          ts: { type: "string" },
          channel: { type: "string" },
        },
      },
    },
  ],
  credentialTypes: [
    {
      name: "slackBot",
      displayName: "Slack Bot",
      authType: "oauth2",
      description: "Bot token via OAuth",
      documentationUrl: "https://api.slack.com/authentication/oauth-v2",
      oauth: {
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: ["chat:write"],
        pkce: true,
        clientAuthStyle: "header",
        redirectPath: "/oauth/callback",
        authorizeQueryParams: {},
      },
      fields: [
        {
          name: "accessToken",
          displayName: "Access Token",
          type: "password",
          oauthManaged: true,
          required: true,
        },
      ],
    },
  ],
};

// Fake operation handler — records the call for inspection.
const postMessageCalls: Array<{ input: unknown; hasCtx: boolean }> = [];
const fakeIntegration: IntegrationModule = {
  manifest: slackManifest,
  operations: {
    postMessage: async (input: unknown, ctx: OperationContext): Promise<unknown> => {
      postMessageCalls.push({ input, hasCtx: ctx !== undefined });
      return { ts: "1234567890.000100", channel: "C123" };
    },
  },
};

// ── buildChorusMcpServer ────────────────────────────────────────────────────

describe("buildChorusMcpServer", () => {
  it("returns the expected tool list shape", async () => {
    const { tools } = await buildChorusMcpServer({ integration: fakeIntegration });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "slack-send__authenticate",
      "slack-send__configure_slackBot",
      "slack-send__list_credentials",
      "slack-send__postMessage",
      "slack-send__test_auth",
    ]);
  });

  it("attaches a raw Server instance with tools/list and tools/call handlers", async () => {
    const { server } = await buildChorusMcpServer({ integration: fakeIntegration });
    // Low-level SDK Server exposes `setRequestHandler`; sanity-check the
    // shape (we don't invoke the transport in this test).
    expect(server).toBeDefined();
    expect(typeof (server as { connect: unknown }).connect).toBe("function");
  });

  it("names the server 'chorus-<integration>' by default", async () => {
    const { server } = await buildChorusMcpServer({ integration: fakeIntegration });
    // Server._serverInfo is private; we assert via getServerVersion/Info if
    // available. The SDK exposes _serverInfo readable via JSON shape:
    const s = server as unknown as { _serverInfo?: { name?: string; version?: string } };
    expect(s._serverInfo?.name).toBe("chorus-slack-send");
    expect(s._serverInfo?.version).toBe("0.1.0");
  });

  it("respects a serverInfo override", async () => {
    const { server } = await buildChorusMcpServer({
      integration: fakeIntegration,
      serverInfo: { name: "custom-name", version: "9.9.9" },
    });
    const s = server as unknown as { _serverInfo?: { name?: string; version?: string } };
    expect(s._serverInfo?.name).toBe("custom-name");
    expect(s._serverInfo?.version).toBe("9.9.9");
  });
});

// ── dispatchTool: operations ────────────────────────────────────────────────

describe("dispatchTool → operation", () => {
  it("invokes the operation handler with the given input", async () => {
    postMessageCalls.length = 0;
    const tools = manifestToMcpTools(slackManifest);
    const postMessageTool = tools.find((t) => t.name === "slack-send__postMessage")!;
    const result = await dispatchTool(
      postMessageTool,
      { channel: "C123", text: "hello" },
      { integration: fakeIntegration },
    );
    expect(result).toEqual({ ts: "1234567890.000100", channel: "C123" });
    expect(postMessageCalls).toHaveLength(1);
    expect(postMessageCalls[0]!.input).toEqual({ channel: "C123", text: "hello" });
    expect(postMessageCalls[0]!.hasCtx).toBe(true);
  });

  it("throws when the operation name is unknown", async () => {
    const fakeTool: McpTool = {
      name: "slack-send__mysteryOperation",
      description: "",
      inputSchema: { type: "object" },
      _chorus: {
        kind: "operation",
        integration: "slack-send",
        operation: "mystery",
      },
    };
    await expect(
      dispatchTool(fakeTool, {}, { integration: fakeIntegration }),
    ).rejects.toThrow(/no operation 'mystery'/);
  });

  it("throws when the tool has no _chorus binding", async () => {
    const fakeTool: McpTool = {
      name: "slack-send__unknownThing",
      description: "",
      inputSchema: { type: "object" },
    };
    await expect(
      dispatchTool(fakeTool, {}, { integration: fakeIntegration }),
    ).rejects.toThrow(/no _chorus binding/);
  });
});

// ── dispatchTool: credentials ───────────────────────────────────────────────

describe("dispatchTool → credential", () => {
  const makeStubService = (): {
    service: CredentialService;
    calls: {
      list: string[];
      configure: Array<{
        integration: string;
        credentialTypeName: string;
        name: string;
        fields: Record<string, unknown>;
      }>;
      authenticate: Array<{ integration: string; credentialTypeName: string; name: string }>;
      testAuth: Array<{ integration: string; credentialId: string }>;
    };
  } => {
    const calls = {
      list: [] as string[],
      configure: [] as Array<{
        integration: string;
        credentialTypeName: string;
        name: string;
        fields: Record<string, unknown>;
      }>,
      authenticate: [] as Array<{ integration: string; credentialTypeName: string; name: string }>,
      testAuth: [] as Array<{ integration: string; credentialId: string }>,
    };
    const service: CredentialService = {
      async list(integration: string): Promise<never[]> {
        calls.list.push(integration);
        return [];
      },
      async configure(args): Promise<{ id: string; name: string }> {
        calls.configure.push(args);
        return { id: "cred-123", name: args.name };
      },
      async authenticate(args): Promise<{ authorizeUrl: string; credentialId?: string }> {
        calls.authenticate.push(args);
        return { authorizeUrl: `https://auth.example/${args.integration}` };
      },
      async testAuth(args): Promise<{ ok: boolean; latencyMs: number }> {
        calls.testAuth.push(args);
        return { ok: true, latencyMs: 42 };
      },
    };
    return { service, calls };
  };

  it("list_credentials delegates to service.list and returns { credentials }", async () => {
    const { service, calls } = makeStubService();
    const tools = manifestToMcpTools(slackManifest);
    const listTool = tools.find((t) => t.name === "slack-send__list_credentials")!;
    const result = await dispatchTool(listTool, {}, {
      integration: fakeIntegration,
      credentialService: service,
    });
    expect(result).toEqual({ credentials: [] });
    expect(calls.list).toEqual(["slack-send"]);
  });

  it("configure splits name from credential fields and delegates", async () => {
    const { service, calls } = makeStubService();
    const tools = manifestToMcpTools(slackManifest);
    const configTool = tools.find((t) => t.name === "slack-send__configure_slackBot")!;
    await dispatchTool(
      configTool,
      { name: "work", accessToken: "xoxb-secret" },
      { integration: fakeIntegration, credentialService: service },
    );
    expect(calls.configure).toHaveLength(1);
    expect(calls.configure[0]).toEqual({
      integration: "slack-send",
      credentialTypeName: "slackBot",
      name: "work",
      fields: { accessToken: "xoxb-secret" },
    });
  });

  it("configure defaults name to 'default' when omitted", async () => {
    const { service, calls } = makeStubService();
    const tools = manifestToMcpTools(slackManifest);
    const configTool = tools.find((t) => t.name === "slack-send__configure_slackBot")!;
    await dispatchTool(
      configTool,
      { accessToken: "xoxb-secret" },
      { integration: fakeIntegration, credentialService: service },
    );
    expect(calls.configure[0]!.name).toBe("default");
  });

  it("authenticate delegates to service.authenticate", async () => {
    const { service, calls } = makeStubService();
    const tools = manifestToMcpTools(slackManifest);
    const authTool = tools.find((t) => t.name === "slack-send__authenticate")!;
    const result = await dispatchTool(authTool, { name: "work" }, {
      integration: fakeIntegration,
      credentialService: service,
    });
    expect((result as { authorizeUrl: string }).authorizeUrl).toMatch(/auth\.example/);
    expect(calls.authenticate[0]).toMatchObject({
      integration: "slack-send",
      name: "work",
    });
  });

  it("test_auth requires credentialId", async () => {
    const { service } = makeStubService();
    const tools = manifestToMcpTools(slackManifest);
    const testTool = tools.find((t) => t.name === "slack-send__test_auth")!;
    await expect(
      dispatchTool(testTool, {}, {
        integration: fakeIntegration,
        credentialService: service,
      }),
    ).rejects.toThrow(/credentialId/);
  });

  it("test_auth delegates to service.testAuth", async () => {
    const { service, calls } = makeStubService();
    const tools = manifestToMcpTools(slackManifest);
    const testTool = tools.find((t) => t.name === "slack-send__test_auth")!;
    const result = await dispatchTool(testTool, { credentialId: "cred-42" }, {
      integration: fakeIntegration,
      credentialService: service,
    });
    expect(result).toEqual({ ok: true, latencyMs: 42 });
    expect(calls.testAuth[0]).toEqual({
      integration: "slack-send",
      credentialId: "cred-42",
    });
  });

  it("throws when a credential tool is dispatched without a service", async () => {
    const tools = manifestToMcpTools(slackManifest);
    const listTool = tools.find((t) => t.name === "slack-send__list_credentials")!;
    await expect(
      dispatchTool(listTool, {}, { integration: fakeIntegration }),
    ).rejects.toThrow(/no credential service/);
  });
});

// ── End-to-end: in-memory MCP client <-> server ─────────────────────────────

describe("buildChorusMcpServer (E2E over in-memory transport)", () => {
  it("tools/list returns the expected tools over MCP protocol", async () => {
    const { server } = await buildChorusMcpServer({ integration: fakeIntegration });

    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverTransport);

    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "slack-send__authenticate",
      "slack-send__configure_slackBot",
      "slack-send__list_credentials",
      "slack-send__postMessage",
      "slack-send__test_auth",
    ]);

    // The internal _chorus binding must NOT leak over the wire.
    for (const t of result.tools) {
      expect((t as { _chorus?: unknown })._chorus).toBeUndefined();
    }

    await client.close();
  });

  it("tools/call invokes the operation handler and returns the result as text content", async () => {
    postMessageCalls.length = 0;
    const { server } = await buildChorusMcpServer({ integration: fakeIntegration });

    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverTransport);

    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "slack-send__postMessage",
      arguments: { channel: "C123", text: "hello" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    const payload = JSON.parse(content[0]!.text) as { ts: string; channel: string };
    expect(payload).toEqual({ ts: "1234567890.000100", channel: "C123" });
    expect(postMessageCalls).toHaveLength(1);

    await client.close();
  });

  it("tools/call returns an error envelope when the tool doesn't exist", async () => {
    const { server } = await buildChorusMcpServer({ integration: fakeIntegration });

    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverTransport);

    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "slack-send__doesNotExist",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/unknown tool/);

    await client.close();
  });
});

// Utility: keep this in scope so vitest keeps `IntegrationManifest` usage.
describe("type re-exports", () => {
  it("IntegrationManifest stays structurally compatible", () => {
    const m: IntegrationManifest = {
      name: "x",
      version: "0.0.1",
      description: "",
      authType: "none",
      credentialTypes: [],
      operations: [],
    };
    expect(m.authType).toBe("none");
  });
});
