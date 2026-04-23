import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntegrationModule, Workflow } from "@delightfulchorus/core";
import { runShare, type ChorusTemplate } from "./share.js";
import {
  listTemplateCredentialRefs,
  runImport,
  templateHasCredentialRefs,
} from "./import.js";
import { redactCredentials } from "../lib/credential-redaction.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-import-test-"));
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

function makeTemplate(args: {
  workflowId?: string;
  withCredential?: boolean;
}): ChorusTemplate {
  const id = args.workflowId ?? "sample-wf";
  const wf: Workflow = {
    id,
    name: "Sample",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "post",
        integration: "slack-send",
        operation: "postMessage",
        config: args.withCredential
          ? { accessToken: "xoxb-REAL-SECRET", channel: "#g" }
          : { channel: "#g" },
        onError: "retry",
      },
    ],
    connections: [],
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
  };

  const redactResult = redactCredentials(wf, {
    "slack-send": slackIntegrationStub.manifest.credentialTypes ?? [],
  });

  return {
    $schema: "https://chorus.dev/schemas/chorus-template/v1.json",
    schemaVersion: 1,
    workflow: redactResult.workflow,
    exportedAt: "2026-04-22T00:00:00.000Z",
    requiredCredentials: args.withCredential
      ? [{ integration: "slack-send", credentialType: "slackUserToken", sites: 1 }]
      : [],
  };
}

async function writeTemplate(p: string, tpl: ChorusTemplate): Promise<void> {
  await writeFile(p, JSON.stringify(tpl, null, 2), "utf8");
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("runImport — from file", () => {
  it("imports a no-credential workflow into the local DB", async () => {
    await scaffold();
    const template = makeTemplate({ withCredential: false });
    const file = path.join(tmpDir, "t.json");
    await writeTemplate(file, template);

    const result = await runImport({
      cwd: tmpDir,
      source: file,
      silent: true,
    });

    expect(result.inserted).toBe(true);
    expect(result.missingCredentials).toHaveLength(0);
    expect(result.workflow.id).toBe("sample-wf");
    expect(result.workflow.name).toBe("Sample");
  });

  it("refuses to insert when credentials are missing, exits with clear guidance", async () => {
    await scaffold();
    const template = makeTemplate({ withCredential: true });
    const file = path.join(tmpDir, "t.json");
    await writeTemplate(file, template);

    const result = await runImport({
      cwd: tmpDir,
      source: file,
      silent: true,
    });

    expect(result.inserted).toBe(false);
    expect(result.missingCredentials).toHaveLength(1);
    expect(result.missingCredentials[0]!.integration).toBe("slack-send");
    expect(result.missingCredentials[0]!.credentialType).toBe("slackUserToken");
  });

  it("honors --rename", async () => {
    await scaffold();
    const template = makeTemplate({ withCredential: false, workflowId: "old-id" });
    const file = path.join(tmpDir, "t.json");
    await writeTemplate(file, template);

    const result = await runImport({
      cwd: tmpDir,
      source: file,
      rename: "new-id",
      silent: true,
    });

    expect(result.workflow.id).toBe("new-id");
    expect(result.inserted).toBe(true);
  });

  it("rejects an invalid template (schema version mismatch)", async () => {
    await scaffold();
    const template = makeTemplate({ withCredential: false });
    const file = path.join(tmpDir, "t.json");
    await writeTemplate(file, { ...template, schemaVersion: 99 as never });

    await expect(
      runImport({ cwd: tmpDir, source: file, silent: true }),
    ).rejects.toThrow(/unsupported template schemaVersion/);
  });

  it("rejects a malformed workflow payload", async () => {
    await scaffold();
    const file = path.join(tmpDir, "bad.json");
    await writeFile(
      file,
      JSON.stringify({
        $schema: "https://chorus.dev/schemas/chorus-template/v1.json",
        schemaVersion: 1,
        workflow: { id: "xxx" } /* missing fields */,
        exportedAt: "2026-04-22T00:00:00.000Z",
        requiredCredentials: [],
      }),
    );
    await expect(
      runImport({ cwd: tmpDir, source: file, silent: true }),
    ).rejects.toThrow(/failed schema validation/);
  });

  it("clearly errors on non-existent file", async () => {
    await scaffold();
    await expect(
      runImport({
        cwd: tmpDir,
        source: path.join(tmpDir, "nope.json"),
        silent: true,
      }),
    ).rejects.toThrow(/cannot open/);
  });
});

describe("runImport — HTTP source", () => {
  it("fetches template from URL and imports", async () => {
    await scaffold();
    const template = makeTemplate({ withCredential: false });

    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toBe("https://gist.example.test/raw");
      return {
        ok: true,
        status: 200,
        json: async () => template,
      } as unknown as Response;
    };

    const result = await runImport({
      cwd: tmpDir,
      source: "https://gist.example.test/raw",
      fetchFn: mockFetch,
      silent: true,
    });

    expect(result.inserted).toBe(true);
  });

  it("surfaces non-OK HTTP responses", async () => {
    await scaffold();
    const mockFetch: typeof fetch = async () => {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response;
    };

    await expect(
      runImport({
        cwd: tmpDir,
        source: "https://bogus.example.test/nope",
        fetchFn: mockFetch,
        silent: true,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

// ── Share → Import round trip ─────────────────────────────────────────────

describe("share → import round trip", () => {
  it("a workflow shared then imported preserves graph structure", async () => {
    await scaffold();
    const workflowsDir = path.join(tmpDir, "chorus", "workflows");
    await writeFile(
      path.join(workflowsDir, "rt.yaml"),
      [
        "id: rt",
        "name: Round-trip",
        "version: 1",
        "active: true",
        "trigger:",
        "  type: manual",
        "nodes:",
        "  - id: post",
        "    integration: slack-send",
        "    operation: postMessage",
        "    config:",
        "      accessToken: xoxb-SECRET",
        "      channel: \"#general\"",
        "      text: Hi",
        "  - id: log",
        "    integration: slack-send",
        "    operation: postMessage",
        "    config:",
        "      accessToken: xoxb-SECRET2",
        "      channel: \"#debug\"",
        "      text: Logged",
        "connections:",
        "  - from: post",
        "    to: log",
        "createdAt: 2026-04-22T00:00:00Z",
        "updatedAt: 2026-04-22T00:00:00Z",
        "",
      ].join("\n"),
    );

    const loader = async (name: string): Promise<IntegrationModule> => {
      if (name === "slack-send") return slackIntegrationStub;
      throw new Error(`no integration ${name}`);
    };

    const shareResult = await runShare({
      cwd: tmpDir,
      workflowId: "rt",
      integrationLoader: loader,
      silent: true,
    });

    // Import with --skipCredentialCheck (tests don't have a real DB
    // credential row; the round trip concerns graph shape here).
    const importResult = await runImport({
      cwd: tmpDir,
      source: shareResult.writtenTo!,
      silent: true,
      skipCredentialCheck: true,
    });

    expect(importResult.inserted).toBe(true);
    expect(importResult.workflow.id).toBe("rt");
    expect(importResult.workflow.name).toBe("Round-trip");
    expect(importResult.workflow.connections).toEqual([
      { from: "post", to: "log" },
    ]);
    expect(importResult.workflow.nodes).toHaveLength(2);
    expect(importResult.workflow.nodes.map((n) => n.id)).toEqual([
      "post",
      "log",
    ]);

    // The shared file contains credential refs, not raw tokens.
    const rawShared = await readFile(shareResult.writtenTo!, "utf8");
    expect(rawShared).not.toContain("xoxb-SECRET");
    expect(rawShared).not.toContain("xoxb-SECRET2");
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

describe("listTemplateCredentialRefs / templateHasCredentialRefs", () => {
  it("returns grouped refs for a template with credential stubs", () => {
    const template = makeTemplate({ withCredential: true });
    const refs = listTemplateCredentialRefs(template);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.integration).toBe("slack-send");
    expect(refs[0]!.sites).toHaveLength(1);
    expect(templateHasCredentialRefs(template)).toBe(true);
  });

  it("returns empty list when template has no stubs", () => {
    const template = makeTemplate({ withCredential: false });
    expect(listTemplateCredentialRefs(template)).toEqual([]);
    expect(templateHasCredentialRefs(template)).toBe(false);
  });
});
