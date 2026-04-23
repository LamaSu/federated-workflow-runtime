import { describe, it, expect } from "vitest";
import type { CredentialTypeDefinition, Workflow } from "@delightfulchorus/core";
import {
  countCredentialRefs,
  gatherCredentialRefs,
  isCredentialRef,
  redactCredentials,
  type IntegrationCatalogs,
} from "./credential-redaction.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const slackCatalog: CredentialTypeDefinition[] = [
  {
    name: "slackUserToken",
    displayName: "Slack Bot User Token",
    authType: "bearer",
    description: "Bot token.",
    fields: [
      {
        name: "accessToken",
        displayName: "Bot User OAuth Token",
        type: "password",
        required: true,
        oauthManaged: false,
      },
    ],
  },
];

const githubCatalog: CredentialTypeDefinition[] = [
  {
    name: "githubPAT",
    displayName: "GitHub Personal Access Token",
    authType: "bearer",
    fields: [
      {
        name: "token",
        displayName: "PAT",
        type: "password",
        required: true,
        oauthManaged: false,
      },
      {
        name: "username",
        displayName: "Username",
        type: "string",
        required: false,
        oauthManaged: false,
      },
    ],
  },
];

function makeWorkflow(nodes: Workflow["nodes"]): Workflow {
  return {
    id: "test-wf",
    name: "Test Workflow",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections: [],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
  };
}

// ── redactCredentials ──────────────────────────────────────────────────────

describe("redactCredentials", () => {
  it("strips password-type fields and replaces with __credentialRef stubs", () => {
    const wf = makeWorkflow([
      {
        id: "post",
        integration: "slack-send",
        operation: "postMessage",
        config: {
          accessToken: "xoxb-FAKE-TOKEN",
          channel: "#general",
          text: "hi",
        },
        onError: "retry",
      },
    ]);
    const catalogs: IntegrationCatalogs = { "slack-send": slackCatalog };

    const result = redactCredentials(wf, catalogs);

    const node = result.workflow.nodes[0]!;
    expect(isCredentialRef(node.config.accessToken)).toBe(true);
    if (isCredentialRef(node.config.accessToken)) {
      expect(node.config.accessToken.credentialType).toBe("slackUserToken");
      expect(node.config.accessToken.integration).toBe("slack-send");
      expect(node.config.accessToken.fieldName).toBe("accessToken");
    }
    // Non-sensitive fields preserved verbatim.
    expect(node.config.channel).toBe("#general");
    expect(node.config.text).toBe("hi");

    expect(result.stubbed).toHaveLength(1);
    expect(result.stubbed[0]!.nodeId).toBe("post");
  });

  it("preserves non-password fields (workspace urls, clientIds, etc)", () => {
    const wf = makeWorkflow([
      {
        id: "n1",
        integration: "github",
        operation: "createIssue",
        config: {
          token: "ghp_SECRET",
          username: "octocat",
          repo: "hello-world",
        },
        onError: "retry",
      },
    ]);
    const result = redactCredentials(wf, { github: githubCatalog });

    const node = result.workflow.nodes[0]!;
    expect(isCredentialRef(node.config.token)).toBe(true);
    // username is `type: "string"`, not `type: "password"` — preserved.
    expect(node.config.username).toBe("octocat");
    expect(node.config.repo).toBe("hello-world");
  });

  it("round-trip preserves graph structure (ids, connections, triggers)", () => {
    const wf = makeWorkflow([
      {
        id: "a",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "xoxb-1", channel: "#alerts" },
        onError: "retry",
      },
      {
        id: "b",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "xoxb-2", channel: "#debug" },
        onError: "retry",
      },
    ]);
    const wfWithConn: Workflow = {
      ...wf,
      connections: [{ from: "a", to: "b" }],
    };

    const result = redactCredentials(wfWithConn, { "slack-send": slackCatalog });

    expect(result.workflow.id).toBe(wfWithConn.id);
    expect(result.workflow.name).toBe(wfWithConn.name);
    expect(result.workflow.trigger).toEqual(wfWithConn.trigger);
    expect(result.workflow.connections).toEqual([{ from: "a", to: "b" }]);
    expect(result.workflow.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    // Two stubs, one per node.
    expect(result.stubbed).toHaveLength(2);
  });

  it("does not mutate the original workflow object", () => {
    const wf = makeWorkflow([
      {
        id: "post",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "xoxb-ORIGINAL", channel: "#x" },
        onError: "retry",
      },
    ]);
    const originalToken = wf.nodes[0]!.config.accessToken;

    redactCredentials(wf, { "slack-send": slackCatalog });

    expect(wf.nodes[0]!.config.accessToken).toBe(originalToken);
    expect(wf.nodes[0]!.config.accessToken).toBe("xoxb-ORIGINAL");
  });

  it("falls back to heuristic stripping when catalog is missing", () => {
    const wf = makeWorkflow([
      {
        id: "unknown",
        integration: "some-custom-integration",
        operation: "doThing",
        config: {
          apiKey: "sk_live_FAKE",
          userEmail: "hello@example.com",
          count: 5,
        },
        onError: "retry",
      },
    ]);

    const result = redactCredentials(wf, {} /* no catalogs */);

    const node = result.workflow.nodes[0]!;
    expect(isCredentialRef(node.config.apiKey)).toBe(true);
    // Email is NOT a secret-looking key — preserved.
    expect(node.config.userEmail).toBe("hello@example.com");
    expect(node.config.count).toBe(5);

    expect(result.fallbackStrippedKeys).toEqual([
      { nodeId: "unknown", key: "apiKey" },
    ]);
  });

  it("heuristic strips common secret-looking key names", () => {
    const wf = makeWorkflow([
      {
        id: "n",
        integration: "custom",
        operation: "op",
        config: {
          password: "hunter2",
          client_secret: "s",
          access_token: "t",
          bearerToken: "b",
          refresh_token: "r",
          name: "Alice",
        },
        onError: "retry",
      },
    ]);
    const result = redactCredentials(wf, {});
    const node = result.workflow.nodes[0]!;
    expect(isCredentialRef(node.config.password)).toBe(true);
    expect(isCredentialRef(node.config.client_secret)).toBe(true);
    expect(isCredentialRef(node.config.access_token)).toBe(true);
    expect(isCredentialRef(node.config.bearerToken)).toBe(true);
    expect(isCredentialRef(node.config.refresh_token)).toBe(true);
    // Non-secret.
    expect(node.config.name).toBe("Alice");
  });

  it("yields an empty stubbed list when no credential fields are present", () => {
    const wf = makeWorkflow([
      {
        id: "n",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#x", text: "y" },
        onError: "retry",
      },
    ]);
    const result = redactCredentials(wf, { "slack-send": slackCatalog });
    expect(result.stubbed).toHaveLength(0);
    expect(result.fallbackStrippedKeys).toHaveLength(0);
    expect(result.workflow.nodes[0]!.config).toEqual({
      channel: "#x",
      text: "y",
    });
  });

  it("handles nodes that don't have the password field at all", () => {
    // Slack catalog declares accessToken, but this node doesn't supply
    // one (e.g., user configured credentials via the catalog system).
    const wf = makeWorkflow([
      {
        id: "n",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#x", text: "y" },
        onError: "retry",
      },
    ]);
    const result = redactCredentials(wf, { "slack-send": slackCatalog });
    expect(result.stubbed).toHaveLength(0);
  });
});

// ── isCredentialRef ────────────────────────────────────────────────────────

describe("isCredentialRef", () => {
  it("recognizes correctly-shaped refs", () => {
    expect(
      isCredentialRef({
        __credentialRef: true,
        integration: "slack-send",
        credentialType: "slackUserToken",
        fieldName: "accessToken",
        hint: "x",
      }),
    ).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isCredentialRef(null)).toBe(false);
    expect(isCredentialRef(undefined)).toBe(false);
    expect(isCredentialRef("str")).toBe(false);
    expect(isCredentialRef(42)).toBe(false);
    expect(isCredentialRef(true)).toBe(false);
  });

  it("rejects objects missing required fields", () => {
    expect(isCredentialRef({})).toBe(false);
    expect(isCredentialRef({ __credentialRef: true })).toBe(false);
    expect(isCredentialRef({ __credentialRef: true, integration: "x" })).toBe(
      false,
    );
    expect(
      isCredentialRef({
        __credentialRef: false,
        integration: "x",
        credentialType: "y",
        fieldName: "z",
      }),
    ).toBe(false);
  });
});

// ── gatherCredentialRefs / countCredentialRefs ─────────────────────────────

describe("gatherCredentialRefs", () => {
  it("groups refs by (integration, credentialType) and lists sites", () => {
    const wf = makeWorkflow([
      {
        id: "a",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "x1", channel: "#x" },
        onError: "retry",
      },
      {
        id: "b",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "x2", channel: "#y" },
        onError: "retry",
      },
      {
        id: "c",
        integration: "github",
        operation: "createIssue",
        config: { token: "ghp", username: "u", repo: "r" },
        onError: "retry",
      },
    ]);
    const redacted = redactCredentials(wf, {
      "slack-send": slackCatalog,
      github: githubCatalog,
    }).workflow;

    const buckets = gatherCredentialRefs(redacted);
    expect(buckets).toHaveLength(2);

    const slack = buckets.find((b) => b.integration === "slack-send");
    expect(slack).toBeDefined();
    expect(slack!.credentialType).toBe("slackUserToken");
    expect(slack!.sites.map((s) => s.nodeId).sort()).toEqual(["a", "b"]);

    const gh = buckets.find((b) => b.integration === "github");
    expect(gh).toBeDefined();
    expect(gh!.credentialType).toBe("githubPAT");
    expect(gh!.sites).toEqual([{ nodeId: "c", fieldName: "token" }]);
  });

  it("returns an empty array for a workflow with no refs", () => {
    const wf = makeWorkflow([
      {
        id: "n",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#x", text: "hello" },
        onError: "retry",
      },
    ]);
    const redacted = redactCredentials(wf, { "slack-send": slackCatalog })
      .workflow;
    expect(gatherCredentialRefs(redacted)).toEqual([]);
  });
});

describe("countCredentialRefs", () => {
  it("counts every ref in the workflow", () => {
    const wf = makeWorkflow([
      {
        id: "a",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "x1", channel: "#x" },
        onError: "retry",
      },
      {
        id: "b",
        integration: "slack-send",
        operation: "postMessage",
        config: { accessToken: "x2", channel: "#y" },
        onError: "retry",
      },
    ]);
    const redacted = redactCredentials(wf, { "slack-send": slackCatalog })
      .workflow;
    expect(countCredentialRefs(redacted)).toBe(2);
  });

  it("counts zero when nothing is stubbed", () => {
    const wf = makeWorkflow([
      {
        id: "n",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#x", text: "hi" },
        onError: "retry",
      },
    ]);
    const redacted = redactCredentials(wf, { "slack-send": slackCatalog })
      .workflow;
    expect(countCredentialRefs(redacted)).toBe(0);
  });
});
