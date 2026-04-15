import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@chorus/core";
import {
  credentialTypeToMcpTools,
  manifestToMcpTools,
  operationToMcpTool,
  resolveCredentialTypes,
  type CredentialTypeView,
  type ManifestWithCredentialTypes,
} from "./tool-mapping.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal slack-send-ish manifest WITHOUT credentialTypes (legacy shape). */
const legacySlackManifest: IntegrationManifest = {
  name: "slack-send",
  version: "0.1.0",
  description: "Send messages to Slack via chat.postMessage (bot token).",
  authType: "bearer",
  baseUrl: "https://slack.com/api",
  docsUrl: "https://api.slack.com/methods/chat.postMessage",
  operations: [
    {
      name: "postMessage",
      description: "Post a message to a Slack channel.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["channel", "text"],
        properties: {
          channel: { type: "string" },
          text: { type: "string", maxLength: 40_000 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["ts", "channel"],
        properties: {
          ts: { type: "string" },
          channel: { type: "string" },
        },
      },
    },
  ],
};

/** slack-send with the upgraded credentialTypes shape (post-credentials-oscar). */
const upgradedSlackManifest: ManifestWithCredentialTypes = {
  ...legacySlackManifest,
  authType: "oauth2",
  credentialTypes: [
    {
      name: "slackOAuth2Bot",
      displayName: "Slack Bot (OAuth 2.0)",
      authType: "oauth2",
      description: "Bot token via OAuth 2.0",
      documentationUrl: "https://api.slack.com/authentication/oauth-v2",
      fields: [
        {
          name: "accessToken",
          displayName: "Access Token",
          type: "password",
          required: true,
          oauthManaged: true,
        },
        {
          name: "teamId",
          displayName: "Team ID",
          type: "string",
          required: true,
          oauthManaged: true,
        },
      ],
    },
    {
      name: "slackUserToken",
      displayName: "Slack User Token (legacy)",
      authType: "bearer",
      description: "Legacy user token — pasted by the user.",
      fields: [
        {
          name: "accessToken",
          displayName: "User Token",
          type: "password",
          required: true,
          description: "xoxp-... token",
          deepLink: "https://api.slack.com/legacy/custom-integrations/legacy-tokens",
        },
      ],
    },
  ],
};

/** http-generic: authType: none, should emit no credential tools. */
const httpGenericManifest: IntegrationManifest = {
  name: "http-generic",
  version: "0.1.0",
  description: "Make any HTTP request.",
  authType: "none",
  operations: [
    {
      name: "request",
      description: "Perform an HTTP request.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
};

// ── operationToMcpTool ──────────────────────────────────────────────────────

describe("operationToMcpTool", () => {
  it("maps operation name to <integration>__<operation> format", () => {
    const tool = operationToMcpTool(legacySlackManifest, legacySlackManifest.operations[0]!);
    expect(tool.name).toBe("slack-send__postMessage");
  });

  it("uses operation description as the tool description (with docsUrl appended)", () => {
    const tool = operationToMcpTool(legacySlackManifest, legacySlackManifest.operations[0]!);
    expect(tool.description).toContain("Post a message to a Slack channel");
    expect(tool.description).toContain("https://api.slack.com");
  });

  it("carries the operation inputSchema through unchanged (already JSON-schema)", () => {
    const tool = operationToMcpTool(legacySlackManifest, legacySlackManifest.operations[0]!);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toMatchObject({
      channel: { type: "string" },
      text: { type: "string" },
    });
    expect(tool.inputSchema.required).toEqual(["channel", "text"]);
  });

  it("tags the binding with kind: 'operation'", () => {
    const tool = operationToMcpTool(legacySlackManifest, legacySlackManifest.operations[0]!);
    expect(tool._chorus).toEqual({
      kind: "operation",
      integration: "slack-send",
      operation: "postMessage",
    });
  });

  it("marks idempotent operations in the description", () => {
    const idempotentOp = {
      ...legacySlackManifest.operations[0]!,
      idempotent: true,
    };
    const tool = operationToMcpTool(legacySlackManifest, idempotentOp);
    expect(tool.description).toContain("(idempotent)");
  });

  it("defaults type: object when inputSchema has no type", () => {
    const opWithBadSchema = {
      ...legacySlackManifest.operations[0]!,
      inputSchema: { properties: { a: { type: "string" } } } as Record<string, unknown>,
    };
    const tool = operationToMcpTool(legacySlackManifest, opWithBadSchema);
    expect(tool.inputSchema.type).toBe("object");
  });
});

// ── credentialTypeToMcpTools ────────────────────────────────────────────────

describe("credentialTypeToMcpTools", () => {
  const oauthType: CredentialTypeView = upgradedSlackManifest.credentialTypes![0]!;
  const userTokenType: CredentialTypeView = upgradedSlackManifest.credentialTypes![1]!;

  it("emits a configure tool named <integration>__configure_<typeName>", () => {
    const tools = credentialTypeToMcpTools(upgradedSlackManifest, oauthType);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("slack-send__configure_slackOAuth2Bot");
  });

  it("includes a 'name' field with 'default' default in the configure schema", () => {
    const [tool] = credentialTypeToMcpTools(upgradedSlackManifest, userTokenType);
    const props = tool!.inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.name).toMatchObject({ type: "string", default: "default" });
  });

  it("skips oauthManaged fields in the configure schema (per §7.2)", () => {
    const [tool] = credentialTypeToMcpTools(upgradedSlackManifest, oauthType);
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    // The OAuth type has only oauthManaged fields, so only `name` should appear.
    expect(props).toHaveProperty("name");
    expect(props).not.toHaveProperty("accessToken");
    expect(props).not.toHaveProperty("teamId");
  });

  it("includes non-managed fields with the correct JSON-schema shape", () => {
    const [tool] = credentialTypeToMcpTools(upgradedSlackManifest, userTokenType);
    const props = tool!.inputSchema.properties as Record<string, { type?: string; format?: string; writeOnly?: boolean }>;
    expect(props.accessToken).toMatchObject({
      type: "string",
      format: "password",
      writeOnly: true,
    });
  });

  it("surfaces deepLink in the field description", () => {
    const [tool] = credentialTypeToMcpTools(upgradedSlackManifest, userTokenType);
    const props = tool!.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.accessToken!.description).toContain("Get this value at");
    expect(props.accessToken!.description).toContain("legacy-tokens");
  });

  it("tags the binding with kind: 'credential' and verb: 'configure'", () => {
    const [tool] = credentialTypeToMcpTools(upgradedSlackManifest, oauthType);
    expect(tool!._chorus).toEqual({
      kind: "credential",
      integration: "slack-send",
      verb: "configure",
      credentialTypeName: "slackOAuth2Bot",
    });
  });

  it("surfaces documentationUrl in the description", () => {
    const [tool] = credentialTypeToMcpTools(upgradedSlackManifest, oauthType);
    expect(tool!.description).toContain("oauth-v2");
  });
});

// ── manifestToMcpTools (full) ───────────────────────────────────────────────

describe("manifestToMcpTools", () => {
  it("returns only operation tools when authType === 'none'", () => {
    const tools = manifestToMcpTools(httpGenericManifest);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("http-generic__request");
  });

  it("emits operations + 4-tool credential suite for oauth manifest", () => {
    const tools = manifestToMcpTools(upgradedSlackManifest);
    const names = tools.map((t) => t.name).sort();
    // Expected: 1 operation + list + configure*2 + authenticate + test_auth = 6
    expect(names).toEqual(
      [
        "slack-send__authenticate",
        "slack-send__configure_slackOAuth2Bot",
        "slack-send__configure_slackUserToken",
        "slack-send__list_credentials",
        "slack-send__postMessage",
        "slack-send__test_auth",
      ].sort(),
    );
  });

  it("synthesizes a legacy credential type when manifest lacks credentialTypes", () => {
    const tools = manifestToMcpTools(legacySlackManifest);
    const names = tools.map((t) => t.name);
    // Legacy slack: bearer type → configure + list + test_auth (no OAuth so no authenticate).
    expect(names).toContain("slack-send__postMessage");
    expect(names).toContain("slack-send__list_credentials");
    expect(names).toContain("slack-send__configure_slack-sendLegacy");
    expect(names).toContain("slack-send__test_auth");
    expect(names).not.toContain("slack-send__authenticate");
  });

  it("omits authenticate tool when no credential type is oauth2", () => {
    const tools = manifestToMcpTools({
      ...upgradedSlackManifest,
      credentialTypes: [upgradedSlackManifest.credentialTypes![1]!], // bearer only
    });
    expect(tools.map((t) => t.name)).not.toContain("slack-send__authenticate");
  });

  it("requires credentialTypeName in authenticate input when multiple OAuth types", () => {
    const manifest: ManifestWithCredentialTypes = {
      ...upgradedSlackManifest,
      credentialTypes: [
        upgradedSlackManifest.credentialTypes![0]!, // oauth2
        {
          ...upgradedSlackManifest.credentialTypes![0]!,
          name: "slackOAuth2Alt",
          displayName: "Alternate OAuth",
        },
      ],
    };
    const tools = manifestToMcpTools(manifest);
    const authTool = tools.find((t) => t.name === "slack-send__authenticate");
    expect(authTool).toBeDefined();
    const props = authTool!.inputSchema.properties as Record<string, { enum?: unknown }>;
    expect(props.credentialTypeName).toBeDefined();
    expect(props.credentialTypeName!.enum).toEqual(["slackOAuth2Bot", "slackOAuth2Alt"]);
    expect(authTool!.inputSchema.required).toContain("credentialTypeName");
  });

  it("list_credentials tool has empty input schema and describes the output", () => {
    const tools = manifestToMcpTools(upgradedSlackManifest);
    const listTool = tools.find((t) => t.name === "slack-send__list_credentials");
    expect(listTool).toBeDefined();
    expect(listTool!.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(listTool!.description).toContain("No secrets");
  });

  it("test_auth requires credentialId in input", () => {
    const tools = manifestToMcpTools(upgradedSlackManifest);
    const testTool = tools.find((t) => t.name === "slack-send__test_auth");
    expect(testTool).toBeDefined();
    expect(testTool!.inputSchema.required).toEqual(["credentialId"]);
  });

  it("operation tools come before credential tools in the output order", () => {
    const tools = manifestToMcpTools(upgradedSlackManifest);
    const operationIdx = tools.findIndex((t) => t._chorus?.kind === "operation");
    const credentialIdx = tools.findIndex((t) => t._chorus?.kind === "credential");
    expect(operationIdx).toBeLessThan(credentialIdx);
  });
});

// ── resolveCredentialTypes ──────────────────────────────────────────────────

describe("resolveCredentialTypes", () => {
  it("returns declared credentialTypes as-is when present", () => {
    const types = resolveCredentialTypes(upgradedSlackManifest);
    expect(types).toHaveLength(2);
    expect(types[0]!.name).toBe("slackOAuth2Bot");
  });

  it("returns empty array for authType: none", () => {
    expect(resolveCredentialTypes(httpGenericManifest)).toEqual([]);
  });

  it("synthesizes a legacy type for bearer-only manifest", () => {
    const types = resolveCredentialTypes(legacySlackManifest);
    expect(types).toHaveLength(1);
    expect(types[0]!.authType).toBe("bearer");
    expect(types[0]!.fields).toEqual([
      expect.objectContaining({
        name: "secret",
        type: "password",
        required: true,
      }),
    ]);
  });

  it("synthesizes {username, password} for basic auth", () => {
    const basic: IntegrationManifest = { ...legacySlackManifest, authType: "basic" };
    const types = resolveCredentialTypes(basic);
    expect(types[0]!.fields!.map((f) => f.name)).toEqual(["username", "password"]);
  });

  it("synthesizes oauthManaged fields for oauth2 (authenticate will still error until upgrade)", () => {
    const oauth: IntegrationManifest = { ...legacySlackManifest, authType: "oauth2" };
    const types = resolveCredentialTypes(oauth);
    expect(types[0]!.authType).toBe("oauth2");
    expect(types[0]!.fields!.every((f) => f.oauthManaged)).toBe(true);
  });
});
