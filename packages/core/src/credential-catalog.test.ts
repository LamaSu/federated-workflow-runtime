import { describe, expect, it } from "vitest";
import {
  CredentialFieldSchema,
  CredentialOAuth2FlowSchema,
  CredentialTestDefinitionSchema,
  CredentialTestResultSchema,
  CredentialTypeDefinitionSchema,
  legacyCredentialTypeName,
  resolveCredentialType,
  type CredentialTypeDefinition,
} from "./credential-catalog.js";
import { CredentialSchema, IntegrationManifestSchema } from "./schemas.js";

// ── CredentialFieldSchema (§4.1) ────────────────────────────────────────────

describe("CredentialFieldSchema", () => {
  it("accepts a minimal valid field", () => {
    const parsed = CredentialFieldSchema.parse({
      name: "token",
      displayName: "API Token",
      type: "password",
    });
    expect(parsed.name).toBe("token");
    expect(parsed.required).toBe(true); // default
    expect(parsed.oauthManaged).toBe(false); // default
  });

  it("accepts all field types", () => {
    for (const type of ["string", "password", "url", "number", "boolean", "select"] as const) {
      const parsed = CredentialFieldSchema.parse({
        name: "f",
        displayName: "F",
        type,
      });
      expect(parsed.type).toBe(type);
    }
  });

  it("rejects an invalid field name (starts with a digit)", () => {
    expect(() =>
      CredentialFieldSchema.parse({
        name: "1bad",
        displayName: "Bad",
        type: "string",
      }),
    ).toThrow(/valid JS identifier/);
  });

  it("rejects an invalid field name (contains dash)", () => {
    expect(() =>
      CredentialFieldSchema.parse({
        name: "bad-name",
        displayName: "Bad",
        type: "string",
      }),
    ).toThrow(/valid JS identifier/);
  });

  it("accepts optional deepLink and description", () => {
    const parsed = CredentialFieldSchema.parse({
      name: "pat",
      displayName: "Personal Access Token",
      type: "password",
      description: "Create at github.com/settings/tokens",
      deepLink: "https://github.com/settings/tokens",
    });
    expect(parsed.deepLink).toBe("https://github.com/settings/tokens");
  });

  it("rejects a non-URL deepLink", () => {
    expect(() =>
      CredentialFieldSchema.parse({
        name: "pat",
        displayName: "PAT",
        type: "password",
        deepLink: "not a url",
      }),
    ).toThrow();
  });

  it("accepts select with options", () => {
    const parsed = CredentialFieldSchema.parse({
      name: "env",
      displayName: "Environment",
      type: "select",
      options: [
        { value: "prod", label: "Production" },
        { value: "stage", label: "Staging" },
      ],
    });
    expect(parsed.options).toHaveLength(2);
  });

  it("respects oauthManaged: true (skips user prompts)", () => {
    const parsed = CredentialFieldSchema.parse({
      name: "accessToken",
      displayName: "Access Token",
      type: "password",
      oauthManaged: true,
    });
    expect(parsed.oauthManaged).toBe(true);
  });

  it("enforces maxLength > 0 when provided", () => {
    expect(() =>
      CredentialFieldSchema.parse({
        name: "f",
        displayName: "F",
        type: "string",
        maxLength: 0,
      }),
    ).toThrow();
  });

  it("enforces displayName max 80 chars", () => {
    expect(() =>
      CredentialFieldSchema.parse({
        name: "f",
        displayName: "x".repeat(81),
        type: "string",
      }),
    ).toThrow();
  });
});

// ── CredentialOAuth2FlowSchema (§4.2) ───────────────────────────────────────

describe("CredentialOAuth2FlowSchema", () => {
  it("accepts the minimum viable OAuth config", () => {
    const parsed = CredentialOAuth2FlowSchema.parse({
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
    });
    expect(parsed.scopes).toEqual([]); // default
    expect(parsed.pkce).toBe(true); // default
    expect(parsed.clientAuthStyle).toBe("header"); // default
    expect(parsed.redirectPath).toBe("/oauth/callback"); // default
    expect(parsed.authorizeQueryParams).toEqual({}); // default
  });

  it("rejects a non-URL authorizeUrl", () => {
    expect(() =>
      CredentialOAuth2FlowSchema.parse({
        authorizeUrl: "not-a-url",
        tokenUrl: "https://example.com/token",
      }),
    ).toThrow();
  });

  it("rejects a redirectPath that does not start with /", () => {
    expect(() =>
      CredentialOAuth2FlowSchema.parse({
        authorizeUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        redirectPath: "oauth/callback",
      }),
    ).toThrow();
  });

  it("accepts Google-style authorizeQueryParams (access_type=offline)", () => {
    const parsed = CredentialOAuth2FlowSchema.parse({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      authorizeQueryParams: { access_type: "offline", prompt: "consent" },
    });
    expect(parsed.authorizeQueryParams.access_type).toBe("offline");
  });
});

// ── CredentialTestDefinitionSchema ──────────────────────────────────────────

describe("CredentialTestDefinitionSchema", () => {
  it("accepts empty definition (testCredential lives on the module)", () => {
    const parsed = CredentialTestDefinitionSchema.parse({});
    expect(parsed.viaOperation).toBeUndefined();
  });

  it("accepts viaOperation reference", () => {
    const parsed = CredentialTestDefinitionSchema.parse({
      viaOperation: "getMe",
      description: "Calls GET /user.me — read-only",
    });
    expect(parsed.viaOperation).toBe("getMe");
  });
});

// ── CredentialTestResultSchema (§4.4) ───────────────────────────────────────

describe("CredentialTestResultSchema", () => {
  it("accepts a successful result", () => {
    const parsed = CredentialTestResultSchema.parse({
      ok: true,
      latencyMs: 142,
      identity: {
        userName: "@bot",
        workspaceName: "LamaSu",
        scopes: ["chat:write", "channels:read"],
      },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.identity?.userName).toBe("@bot");
  });

  it("accepts a failure result", () => {
    const parsed = CredentialTestResultSchema.parse({
      ok: false,
      latencyMs: 89,
      error: "token expired",
      errorCode: "AUTH_EXPIRED",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe("AUTH_EXPIRED");
  });

  it("rejects negative latency", () => {
    expect(() =>
      CredentialTestResultSchema.parse({ ok: true, latencyMs: -1 }),
    ).toThrow();
  });
});

// ── CredentialTypeDefinitionSchema (§4.2) ───────────────────────────────────

describe("CredentialTypeDefinitionSchema", () => {
  it("accepts a bearer-token credential type with no OAuth", () => {
    const parsed = CredentialTypeDefinitionSchema.parse({
      name: "slackUserToken",
      displayName: "Slack User Token",
      authType: "bearer",
      fields: [
        {
          name: "accessToken",
          displayName: "Bot User OAuth Token",
          type: "password",
          description: "Starts with `xoxb-`.",
          deepLink: "https://api.slack.com/apps",
        },
      ],
      documentationUrl: "https://api.slack.com/authentication/oauth-v2",
    });
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.fields[0]!.name).toBe("accessToken");
  });

  it("rejects oauth2 authType without oauth metadata (refiner)", () => {
    expect(() =>
      CredentialTypeDefinitionSchema.parse({
        name: "slackOAuth2Bot",
        displayName: "Slack OAuth 2.0 Bot",
        authType: "oauth2",
        fields: [],
        // oauth: missing → should fail refinement
      }),
    ).toThrow(/oauth metadata is required/);
  });

  it("accepts oauth2 authType with oauth metadata", () => {
    const parsed = CredentialTypeDefinitionSchema.parse({
      name: "slackOAuth2Bot",
      displayName: "Slack OAuth 2.0 Bot",
      authType: "oauth2",
      fields: [],
      oauth: {
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: ["chat:write"],
      },
    });
    expect(parsed.oauth?.tokenUrl).toBe("https://slack.com/api/oauth.v2.access");
  });

  it("rejects an invalid credential-type name (starts with digit)", () => {
    expect(() =>
      CredentialTypeDefinitionSchema.parse({
        name: "0bad",
        displayName: "Bad",
        authType: "apiKey",
      }),
    ).toThrow();
  });

  it("accepts a credential type with no fields (fields default to [])", () => {
    const parsed = CredentialTypeDefinitionSchema.parse({
      name: "empty",
      displayName: "Empty",
      authType: "apiKey",
    });
    expect(parsed.fields).toEqual([]);
  });
});

// ── IntegrationManifestSchema extension (§4.3) ──────────────────────────────

describe("IntegrationManifestSchema — credentialTypes extension", () => {
  it("defaults credentialTypes to an empty array (back-compat)", () => {
    const parsed = IntegrationManifestSchema.parse({
      name: "http-generic",
      version: "0.1.0",
      description: "Generic HTTP",
      authType: "none",
      operations: [],
    });
    expect(parsed.credentialTypes).toEqual([]);
  });

  it("accepts a manifest with matching credentialType + top-level authType", () => {
    const parsed = IntegrationManifestSchema.parse({
      name: "slack-send",
      version: "0.1.0",
      description: "Slack chat.postMessage",
      authType: "bearer",
      credentialTypes: [
        {
          name: "slackUserToken",
          displayName: "Slack User Token",
          authType: "bearer",
        },
      ],
      operations: [],
    });
    expect(parsed.credentialTypes).toHaveLength(1);
  });

  it("rejects a manifest where authType doesn't match any credentialType", () => {
    expect(() =>
      IntegrationManifestSchema.parse({
        name: "slack-send",
        version: "0.1.0",
        description: "Slack",
        authType: "oauth2", // top-level says oauth2
        credentialTypes: [
          {
            name: "slackUserToken",
            displayName: "Slack User Token",
            authType: "bearer", // child says bearer
          },
        ],
        operations: [],
      }),
    ).toThrow(/manifest\.authType must match/);
  });

  it("permits manifest when credentialTypes is empty regardless of authType", () => {
    const parsed = IntegrationManifestSchema.parse({
      name: "legacy",
      version: "0.1.0",
      description: "Legacy",
      authType: "bearer",
      credentialTypes: [],
      operations: [],
    });
    expect(parsed.authType).toBe("bearer");
  });

  it("permits manifest with authType=none and a 'none' credentialType", () => {
    const parsed = IntegrationManifestSchema.parse({
      name: "http-generic",
      version: "0.1.0",
      description: "HTTP",
      authType: "none",
      credentialTypes: [
        {
          name: "anon",
          displayName: "Anonymous",
          authType: "none",
        },
      ],
      operations: [],
    });
    expect(parsed.credentialTypes[0]!.authType).toBe("none");
  });
});

// ── CredentialSchema extension (§4.6) ───────────────────────────────────────

describe("CredentialSchema — credentialTypeName + authType rename", () => {
  it("defaults credentialTypeName to '' (legacy rows)", () => {
    const parsed = CredentialSchema.parse({
      id: "c-1",
      integration: "slack-send",
      authType: "bearer",
      name: "default",
      encryptedPayload: "base64...",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    });
    expect(parsed.credentialTypeName).toBe("");
    expect(parsed.authType).toBe("bearer");
  });

  it("round-trips a credential row with credentialTypeName populated", () => {
    const parsed = CredentialSchema.parse({
      id: "c-1",
      integration: "slack-send",
      credentialTypeName: "slackOAuth2Bot",
      authType: "oauth2",
      name: "work",
      encryptedPayload: "base64...",
      oauth2: { scopes: ["chat:write"] },
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    });
    expect(parsed.credentialTypeName).toBe("slackOAuth2Bot");
    expect(parsed.oauth2?.scopes).toEqual(["chat:write"]);
  });
});

// ── Resolution helpers ──────────────────────────────────────────────────────

describe("resolveCredentialType", () => {
  const catalog: CredentialTypeDefinition[] = [
    {
      name: "slackOAuth2Bot",
      displayName: "Slack OAuth 2.0 Bot",
      authType: "oauth2",
      fields: [],
      oauth: {
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: [],
        pkce: true,
        clientAuthStyle: "header",
        redirectPath: "/oauth/callback",
        authorizeQueryParams: {},
      },
    },
    {
      name: "slackUserToken",
      displayName: "Slack User Token",
      authType: "bearer",
      fields: [],
    },
  ];

  it("exact match by name wins over authType fallback", () => {
    const r = resolveCredentialType(catalog, "slackOAuth2Bot", "oauth2");
    expect(r?.name).toBe("slackOAuth2Bot");
  });

  it("legacy row (blank name) falls back to matching authType", () => {
    const r = resolveCredentialType(catalog, "", "bearer");
    expect(r?.name).toBe("slackUserToken");
  });

  it("legacy row with <integration>:legacy pattern falls back", () => {
    const r = resolveCredentialType(catalog, "slack-send:legacy", "oauth2");
    expect(r?.name).toBe("slackOAuth2Bot");
  });

  it("returns undefined when catalog is empty", () => {
    const r = resolveCredentialType([], "anything", "bearer");
    expect(r).toBeUndefined();
  });

  it("returns undefined when authType doesn't match any entry", () => {
    const r = resolveCredentialType(catalog, "nonexistent", "basic");
    expect(r).toBeUndefined();
  });
});

describe("legacyCredentialTypeName", () => {
  it("synthesizes <integration>:legacy", () => {
    expect(legacyCredentialTypeName("slack-send")).toBe("slack-send:legacy");
    expect(legacyCredentialTypeName("http-generic")).toBe("http-generic:legacy");
  });
});
