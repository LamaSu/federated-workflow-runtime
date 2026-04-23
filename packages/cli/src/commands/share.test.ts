import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntegrationModule } from "@delightfulchorus/core";
import { runShare, type ChorusTemplate, type GistClient } from "./share.js";
import { isCredentialRef } from "../lib/credential-redaction.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-share-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────

async function scaffold(): Promise<void> {
  const chorusDir = path.join(tmpDir, "chorus");
  const workflowsDir = path.join(chorusDir, "workflows");
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(
    path.join(chorusDir, "config.yaml"),
    [
      "name: test-project",
      "version: 1",
      "workflowsDir: workflows",
      "database:",
      "  path: .chorus/chorus.db",
      "server:",
      "  host: 127.0.0.1",
      "  port: 3710",
      "repair:",
      "  autoAttempt: false",
      "  model: claude-sonnet-4-5",
      "  dailyBudget: 10",
      "registry:",
      "  url: https://registry.chorus.dev",
      "  pollIntervalMs: 300000",
      "",
    ].join("\n"),
  );
}

async function writeWorkflow(id: string, yaml: string): Promise<void> {
  const workflowsDir = path.join(tmpDir, "chorus", "workflows");
  await writeFile(path.join(workflowsDir, `${id}.yaml`), yaml);
}

const slackIntegrationStub: IntegrationModule = {
  manifest: {
    name: "slack-send",
    version: "0.1.0",
    description: "Slack sender.",
    authType: "bearer",
    credentialTypes: [
      {
        name: "slackUserToken",
        displayName: "Slack Bot Token",
        authType: "bearer",
        fields: [
          {
            name: "accessToken",
            displayName: "Bot Token",
            type: "password",
            required: true,
            oauthManaged: false,
          },
        ],
      },
    ],
    operations: [
      {
        name: "postMessage",
        description: "Post a message.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        idempotent: false,
      },
    ],
  },
} as unknown as IntegrationModule;

function makeLoader(
  map: Record<string, IntegrationModule>,
): (name: string) => Promise<IntegrationModule> {
  return async (name: string) => {
    const mod = map[name];
    if (!mod) throw new Error(`no integration ${name}`);
    return mod;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("runShare — file mode", () => {
  it("writes a template file with credentials stripped", async () => {
    await scaffold();
    await writeWorkflow(
      "greet",
      [
        "id: greet",
        "name: Hello Slack",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes:",
        "  - id: post",
        "    integration: slack-send",
        "    operation: postMessage",
        "    config:",
        "      accessToken: xoxb-FAKE-TOKEN",
        "      channel: \"#general\"",
        "      text: Hello",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );

    const result = await runShare({
      cwd: tmpDir,
      workflowId: "greet",
      integrationLoader: makeLoader({ "slack-send": slackIntegrationStub }),
      silent: true,
    });

    expect(result.writtenTo).toBe(
      path.resolve(tmpDir, "greet.chorus-template.json"),
    );
    expect(result.gistUrl).toBeUndefined();

    const raw = await readFile(result.writtenTo!, "utf8");
    const parsed = JSON.parse(raw) as ChorusTemplate;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.workflow.id).toBe("greet");
    expect(parsed.workflow.nodes).toHaveLength(1);

    const node = parsed.workflow.nodes[0]!;
    // accessToken is redacted.
    expect(isCredentialRef(node.config.accessToken)).toBe(true);
    // Non-sensitive fields survive.
    expect(node.config.channel).toBe("#general");
    expect(node.config.text).toBe("Hello");

    // Raw token is not anywhere in the JSON.
    expect(raw).not.toContain("xoxb-FAKE-TOKEN");

    // Required-credentials manifest is populated.
    expect(parsed.requiredCredentials).toHaveLength(1);
    expect(parsed.requiredCredentials[0]).toEqual({
      integration: "slack-send",
      credentialType: "slackUserToken",
      sites: 1,
    });
  });

  it("uses --out when provided", async () => {
    await scaffold();
    await writeWorkflow(
      "simple",
      [
        "id: simple",
        "name: Simple",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes: []",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );

    const outPath = path.join(tmpDir, "subdir-missing-ok.json");
    const result = await runShare({
      cwd: tmpDir,
      workflowId: "simple",
      out: outPath,
      integrationLoader: makeLoader({}),
      silent: true,
    });
    expect(result.writtenTo).toBe(outPath);
    const raw = await readFile(outPath, "utf8");
    expect(raw).toContain("\"id\": \"simple\"");
  });

  it("resolves a workflow by id even when the filename doesn't match", async () => {
    await scaffold();
    await writeWorkflow(
      "someOtherFilename",
      [
        "id: my-flow-id",
        "name: Renamed",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes: []",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );
    const result = await runShare({
      cwd: tmpDir,
      workflowId: "my-flow-id",
      integrationLoader: makeLoader({}),
      silent: true,
    });
    expect(result.template.workflow.id).toBe("my-flow-id");
  });

  it("throws when the workflow id cannot be found", async () => {
    await scaffold();
    await expect(
      runShare({
        cwd: tmpDir,
        workflowId: "nonexistent",
        integrationLoader: makeLoader({}),
        silent: true,
      }),
    ).rejects.toThrow(/no workflow with id "nonexistent"/);
  });

  it("falls back to heuristic when catalog is missing", async () => {
    await scaffold();
    await writeWorkflow(
      "mystery",
      [
        "id: mystery",
        "name: Mystery integration",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes:",
        "  - id: n1",
        "    integration: unknown-mystery-integration",
        "    operation: doThing",
        "    config:",
        "      apiKey: sk-SECRET",
        "      username: alice",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );
    const result = await runShare({
      cwd: tmpDir,
      workflowId: "mystery",
      integrationLoader: makeLoader({}),
      silent: true,
    });
    const node = result.template.workflow.nodes[0]!;
    expect(isCredentialRef(node.config.apiKey)).toBe(true);
    expect(node.config.username).toBe("alice");
    // Raw key should not be in the serialized JSON.
    const raw = await readFile(result.writtenTo!, "utf8");
    expect(raw).not.toContain("sk-SECRET");
  });
});

describe("runShare — gist mode", () => {
  it("invokes the gist client with the stripped template and returns the URL", async () => {
    await scaffold();
    await writeWorkflow(
      "post-it",
      [
        "id: post-it",
        "name: Post-it",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes:",
        "  - id: post",
        "    integration: slack-send",
        "    operation: postMessage",
        "    config:",
        "      accessToken: xoxb-SHH",
        "      channel: \"#c\"",
        "      text: hi",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );

    let captured: { token?: string; filename?: string; content?: string } = {};
    const client: GistClient = {
      async create(args) {
        captured = {
          token: args.token,
          filename: args.filename,
          content: args.content,
        };
        return { url: "https://gist.github.com/abc/xyz", id: "xyz" };
      },
    };

    const result = await runShare({
      cwd: tmpDir,
      workflowId: "post-it",
      gist: true,
      gistClient: client,
      tokenResolver: () => "ghp_TEST",
      integrationLoader: makeLoader({ "slack-send": slackIntegrationStub }),
      silent: true,
    });

    expect(result.gistUrl).toBe("https://gist.github.com/abc/xyz");
    expect(result.writtenTo).toBeUndefined();
    expect(captured.token).toBe("ghp_TEST");
    expect(captured.filename).toBe("post-it.chorus-template.json");
    expect(captured.content).toContain("\"schemaVersion\": 1");
    // No raw token in the payload.
    expect(captured.content).not.toContain("xoxb-SHH");
  });

  it("errors clearly when no token is available", async () => {
    await scaffold();
    await writeWorkflow(
      "simple",
      [
        "id: simple",
        "name: Simple",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes: []",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );
    const client: GistClient = {
      async create() {
        throw new Error("should not be called");
      },
    };
    await expect(
      runShare({
        cwd: tmpDir,
        workflowId: "simple",
        gist: true,
        gistClient: client,
        tokenResolver: () => null,
        integrationLoader: makeLoader({}),
        silent: true,
      }),
    ).rejects.toThrow(/GITHUB_TOKEN not set/);
  });
});
