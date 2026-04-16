import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv } from "node:crypto";
import type { IntegrationModule } from "@delightfulchorus/core";
import {
  credentialsMigrate,
  credentialsPatHelp,
  credentialsTest,
  credentialsTypes,
  summarizeCredentialTypes,
} from "./credentials.js";

/**
 * CLI tests for the catalog-aware credential subcommands (§6 of
 * docs/CREDENTIALS_ANALYSIS.md). We spin up isolated temp directories,
 * write a minimal chorus config, pre-create a credentials table, and
 * inject a fake IntegrationModule loader to avoid relying on real
 * @delightfulchorus/integration-* packages.
 */

// ── Test helpers ────────────────────────────────────────────────────────────

interface TestProject {
  dir: string;
  chorusDir: string;
  dbPath: string;
  key: Buffer;
  cleanup(): Promise<void>;
}

async function makeProject(): Promise<TestProject> {
  const dir = await mkdtemp(join(tmpdir(), "chorus-cred-"));
  const chorusDir = join(dir, "chorus");
  await mkdir(chorusDir, { recursive: true });
  await mkdir(join(dir, ".chorus"), { recursive: true });
  const config = {
    name: "test-proj",
    database: { path: ".chorus/chorus.db" },
  };
  await writeFile(
    join(chorusDir, "config.yaml"),
    `name: test-proj\ndatabase:\n  path: .chorus/chorus.db\n`,
  );
  void config;
  // Pre-create the credentials table with the new column so the queries work.
  const Database = (await import("better-sqlite3")).default;
  const dbPath = join(dir, ".chorus", "chorus.db");
  const db = Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id                    TEXT PRIMARY KEY,
      integration           TEXT NOT NULL,
      type                  TEXT NOT NULL,
      credential_type_name  TEXT NOT NULL DEFAULT '',
      name                  TEXT NOT NULL,
      encrypted_payload     BLOB NOT NULL,
      oauth_access_expires  TEXT,
      oauth_refresh_expires TEXT,
      oauth_scopes          TEXT,
      state                 TEXT NOT NULL DEFAULT 'active',
      last_error            TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      UNIQUE(integration, name)
    );
  `);
  db.close();
  const key = randomBytes(32);
  return {
    dir,
    chorusDir,
    dbPath,
    key,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

async function seedCredential(
  project: TestProject,
  overrides: Partial<{
    id: string;
    integration: string;
    type: string;
    credential_type_name: string;
    name: string;
    payload: string;
  }> = {},
): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const db = Database(project.dbPath);
  const blob = encrypt(overrides.payload ?? '{"accessToken":"xoxb-test"}', project.key);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO credentials
        (id, integration, type, credential_type_name, name, encrypted_payload,
         oauth_access_expires, oauth_refresh_expires, oauth_scopes,
         state, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', NULL, ?, ?)`,
  ).run(
    overrides.id ?? "c-1",
    overrides.integration ?? "slack-send",
    overrides.type ?? "bearer",
    overrides.credential_type_name ?? "slackUserToken",
    overrides.name ?? "default",
    blob,
    now,
    now,
  );
  db.close();
}

function fakeSlackModule(
  overrides: Partial<IntegrationModule> = {},
): IntegrationModule {
  const base: IntegrationModule = {
    manifest: {
      name: "slack-send",
      version: "0.1.0",
      description: "Slack",
      authType: "bearer",
      credentialTypes: [
        {
          name: "slackUserToken",
          displayName: "Slack User Token",
          authType: "bearer",
          description: "Bot token starting with xoxb-",
          documentationUrl: "https://api.slack.com/authentication/oauth-v2",
          fields: [
            {
              name: "accessToken",
              displayName: "Bot User OAuth Token",
              type: "password",
              required: true,
              deepLink: "https://api.slack.com/apps",
              oauthManaged: false,
            },
          ],
        },
      ],
      operations: [],
    },
    operations: {},
    ...overrides,
  };
  return base;
}

// Persist CHORUS_ENCRYPTION_KEY for the duration of each test.
const originalEnvKey = process.env.CHORUS_ENCRYPTION_KEY;
beforeEach(() => {
  // Set a valid 32-byte base64 key so readEncryptionKey succeeds.
  process.env.CHORUS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  if (originalEnvKey === undefined) delete process.env.CHORUS_ENCRYPTION_KEY;
  else process.env.CHORUS_ENCRYPTION_KEY = originalEnvKey;
});

// ── credentialsTest (§6.2) ──────────────────────────────────────────────────

describe("credentialsTest", () => {
  it("returns 2 on malformed ref", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitCode = await credentialsTest({ ref: "no-colon" });
    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });


  it("returns 0 when testCredential returns ok:true", async () => {
    const project = await makeProject();
    try {
      // Use the project's key by re-encoding and setting env var:
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      await seedCredential(project);
      const testCredential = vi.fn(async () => ({
        ok: true,
        latencyMs: 42,
        identity: { userName: "chorus-bot", workspaceName: "LamaSu" },
      }));
      const mod = fakeSlackModule({ testCredential });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = await credentialsTest({
        cwd: project.dir,
        ref: "slack-send:default",
        integrationLoader: async () => mod,
      });
      expect(code).toBe(0);
      expect(testCredential).toHaveBeenCalledWith(
        "slackUserToken",
        expect.objectContaining({ credentials: { accessToken: "xoxb-test" } }),
      );
      stdout.mockRestore();
    } finally {
      await project.cleanup();
    }
  });

  it("returns 1 when testCredential returns ok:false", async () => {
    const project = await makeProject();
    try {
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      await seedCredential(project);
      const mod = fakeSlackModule({
        testCredential: async () => ({
          ok: false,
          latencyMs: 89,
          error: "token expired",
          errorCode: "AUTH_EXPIRED",
        }),
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = await credentialsTest({
        cwd: project.dir,
        ref: "slack-send:default",
        integrationLoader: async () => mod,
      });
      expect(code).toBe(1);
      stdout.mockRestore();
    } finally {
      await project.cleanup();
    }
  });

  it("returns 0 with 'unchecked' message when integration has no testCredential", async () => {
    const project = await makeProject();
    try {
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      await seedCredential(project);
      const mod = fakeSlackModule({ testCredential: undefined });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = await credentialsTest({
        cwd: project.dir,
        ref: "slack-send:default",
        integrationLoader: async () => mod,
      });
      expect(code).toBe(0);
      stdout.mockRestore();
    } finally {
      await project.cleanup();
    }
  });

  it("returns 2 when credential is not found", async () => {
    const project = await makeProject();
    try {
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      // Don't seed anything
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const code = await credentialsTest({
        cwd: project.dir,
        ref: "slack-send:missing",
        integrationLoader: async () => fakeSlackModule(),
      });
      expect(code).toBe(2);
      stderr.mockRestore();
    } finally {
      await project.cleanup();
    }
  });

  it("JSON output returns structured result", async () => {
    const project = await makeProject();
    try {
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      await seedCredential(project);
      const mod = fakeSlackModule({
        testCredential: async () => ({ ok: true, latencyMs: 10 }),
      });
      const writes: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          writes.push(String(chunk));
          return true;
        });
      const code = await credentialsTest({
        cwd: project.dir,
        ref: "slack-send:default",
        integrationLoader: async () => mod,
        json: true,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join(""));
      expect(parsed.ok).toBe(true);
      expect(parsed.typeName).toBe("slackUserToken");
      stdout.mockRestore();
    } finally {
      await project.cleanup();
    }
  });
});

// ── credentialsPatHelp (§6.3) ──────────────────────────────────────────────

describe("credentialsPatHelp", () => {
  it("opens the credentialType.documentationUrl", async () => {
    const opened: string[] = [];
    const code = await credentialsPatHelp({
      integration: "slack-send",
      integrationLoader: async () => fakeSlackModule(),
      openFn: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual([
      "https://api.slack.com/authentication/oauth-v2",
    ]);
  });

  it("opens the first field's deepLink when no documentationUrl", async () => {
    const opened: string[] = [];
    const mod = fakeSlackModule();
    delete mod.manifest.credentialTypes![0]!.documentationUrl;
    const code = await credentialsPatHelp({
      integration: "slack-send",
      integrationLoader: async () => mod,
      openFn: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual(["https://api.slack.com/apps"]);
  });

  it("respects --type when integration has multiple types", async () => {
    const mod = fakeSlackModule({
      manifest: {
        ...fakeSlackModule().manifest,
        credentialTypes: [
          {
            name: "slackUserToken",
            displayName: "Slack User Token",
            authType: "bearer",
            fields: [],
            documentationUrl: "https://user.example.com/",
          },
          {
            name: "slackOAuth2Bot",
            displayName: "Slack OAuth 2.0",
            authType: "oauth2",
            fields: [],
            documentationUrl: "https://oauth.example.com/",
            oauth: {
              authorizeUrl: "https://x.example/auth",
              tokenUrl: "https://x.example/token",
              scopes: [],
              pkce: true,
              clientAuthStyle: "header",
              redirectPath: "/oauth/callback",
              authorizeQueryParams: {},
            },
          },
        ],
      },
    });
    const opened: string[] = [];
    const code = await credentialsPatHelp({
      integration: "slack-send",
      type: "slackOAuth2Bot",
      integrationLoader: async () => mod,
      openFn: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual(["https://oauth.example.com/"]);
  });

  it("returns 2 when --type doesn't match any declared type", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await credentialsPatHelp({
      integration: "slack-send",
      type: "nonexistent",
      integrationLoader: async () => fakeSlackModule(),
      openFn: () => {},
    });
    expect(code).toBe(2);
    stderr.mockRestore();
  });

  it("falls back to manifest.docsUrl when no credentialTypes declared", async () => {
    const opened: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mod = fakeSlackModule();
    mod.manifest.credentialTypes = [];
    mod.manifest.docsUrl = "https://slack.com/docs";
    const code = await credentialsPatHelp({
      integration: "slack-send",
      integrationLoader: async () => mod,
      openFn: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual(["https://slack.com/docs"]);
    stderr.mockRestore();
  });
});

// ── credentialsTypes (§6.4) ────────────────────────────────────────────────

describe("credentialsTypes", () => {
  it("prints human-readable listing for a specified integration", async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await credentialsTypes({
      integration: "slack-send",
      integrationLoader: async () => fakeSlackModule(),
    });
    expect(code).toBe(0);
    const joined = writes.join("");
    expect(joined).toContain("slack-send");
    expect(joined).toContain("slackUserToken");
    expect(joined).toContain("bearer");
    stdout.mockRestore();
  });

  it("JSON mode emits structured summary", async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await credentialsTypes({
      integration: "slack-send",
      integrationLoader: async () => fakeSlackModule(),
      json: true,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join("")) as Array<{
      integration: string;
      types: Array<{ name: string; fields: unknown[] }>;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.integration).toBe("slack-send");
    expect(parsed[0]!.types[0]!.name).toBe("slackUserToken");
    expect(parsed[0]!.types[0]!.fields).toHaveLength(1);
    stdout.mockRestore();
  });

  it("can be called with a list of integrationNames when no integration flag", async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await credentialsTypes({
      integrationNames: ["slack-send"],
      integrationLoader: async () => fakeSlackModule(),
      json: true,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join("")) as Array<{ integration: string }>;
    expect(parsed[0]!.integration).toBe("slack-send");
    stdout.mockRestore();
  });

  it("reports (no credentialTypes declared) for integrations without a catalog", async () => {
    const mod = fakeSlackModule();
    mod.manifest.credentialTypes = [];
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await credentialsTypes({
      integration: "slack-send",
      integrationLoader: async () => mod,
    });
    expect(code).toBe(0);
    expect(writes.join("")).toContain("no credentialTypes declared");
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

// ── credentialsMigrate (§6.5) ──────────────────────────────────────────────

describe("credentialsMigrate", () => {
  it("updates credential_type_name for an existing row", async () => {
    const project = await makeProject();
    try {
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      await seedCredential(project, {
        id: "c-legacy",
        credential_type_name: "slack-send:legacy",
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = await credentialsMigrate({
        cwd: project.dir,
        id: "c-legacy",
        to: "slackUserToken",
      });
      expect(code).toBe(0);

      // Verify DB state directly.
      const Database = (await import("better-sqlite3")).default;
      const db = Database(project.dbPath, { readonly: true });
      const row = db
        .prepare(`SELECT credential_type_name FROM credentials WHERE id = ?`)
        .get("c-legacy") as { credential_type_name: string };
      expect(row.credential_type_name).toBe("slackUserToken");
      db.close();
      stdout.mockRestore();
    } finally {
      await project.cleanup();
    }
  });

  it("returns 1 when credential id not found", async () => {
    const project = await makeProject();
    try {
      process.env.CHORUS_ENCRYPTION_KEY = project.key.toString("base64");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const code = await credentialsMigrate({
        cwd: project.dir,
        id: "nonexistent",
        to: "slackUserToken",
      });
      expect(code).toBe(1);
      stderr.mockRestore();
    } finally {
      await project.cleanup();
    }
  });
});

// ── summarizeCredentialTypes (mcp-papa helper) ─────────────────────────────

describe("summarizeCredentialTypes", () => {
  it("flattens credentialTypes for mcp-papa-style consumption", () => {
    const summary = summarizeCredentialTypes(fakeSlackModule().manifest);
    expect(summary).toEqual([
      {
        name: "slackUserToken",
        authType: "bearer",
        displayName: "Slack User Token",
        fieldCount: 1,
      },
    ]);
  });

  it("handles missing credentialTypes gracefully", () => {
    const manifest = { ...fakeSlackModule().manifest, credentialTypes: undefined as never };
    expect(summarizeCredentialTypes(manifest as never)).toEqual([]);
  });
});
