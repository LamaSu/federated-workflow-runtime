import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import type { IntegrationManifest } from "@delightfulchorus/core";
import { openDatabase } from "../db.js";
import { RuntimeCredentialService } from "../credential-service.js";
import { registerApiRoutes } from "./index.js";

/**
 * Tests for /api/credentials endpoints:
 *   GET  /api/credentials?integration=X
 *   POST /api/credentials
 *   POST /api/credentials/:id/test
 *   POST /api/credentials/authenticate
 *
 * Invariants:
 *   - No payload (encrypted or plaintext) in list response.
 *   - Bearer token enforced when configured.
 *   - Validation errors → 400 with structured error body.
 */

const slackManifest: IntegrationManifest = {
  name: "slack-send",
  version: "0.1.0",
  description: "",
  authType: "oauth2",
  operations: [],
  credentialTypes: [
    {
      name: "slackOAuth2Bot",
      displayName: "Slack Bot",
      authType: "oauth2",
      oauth: {
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: ["chat:write"],
        pkce: true,
        clientAuthStyle: "body",
        redirectPath: "/oauth/callback",
        authorizeQueryParams: {},
      },
      fields: [
        { name: "clientId", displayName: "Client ID", type: "string", required: true, oauthManaged: false },
        { name: "clientSecret", displayName: "Secret", type: "password", required: true, oauthManaged: false },
        { name: "accessToken", displayName: "AT", type: "password", required: true, oauthManaged: true },
      ],
    },
    {
      name: "slackUserToken",
      displayName: "Slack User",
      authType: "bearer",
      fields: [
        {
          name: "token",
          displayName: "Token",
          type: "password",
          required: true,
          oauthManaged: false,
        },
      ],
    },
  ],
};

function setup(apiToken: string | null = null) {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  const service = new RuntimeCredentialService({
    db,
    key,
    manifestLookup: (n) => (n === "slack-send" ? slackManifest : undefined),
    clientIdFor: () => ({ clientId: "ci", clientSecret: "cs" }),
    randomState: () => "state-api-test-1234567",
    now: () => new Date("2026-04-15T00:00:00.000Z"),
  });
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db, { apiToken, credentialService: service });
  return { db, service, app };
}

describe("POST /api/credentials", () => {
  it("creates an encrypted credential and returns 201 + {id, name}", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: {
        integration: "slack-send",
        credentialTypeName: "slackUserToken",
        name: "work",
        fields: { token: "xoxp-some-secret" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string };
    expect(body.name).toBe("work");
    expect(body.id).toMatch(/[0-9a-f-]{36}/);
    await app.close();
    db.close();
  });

  it("400 when required field is missing", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: {
        integration: "slack-send",
        credentialTypeName: "slackUserToken",
        name: "broken",
        fields: {},
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe("CONFIGURE_FAILED");
    expect(body.message).toContain("required");
    await app.close();
    db.close();
  });

  it("400 on malformed body (missing integration)", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: { name: "x", fields: {} },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe("BAD_REQUEST");
    await app.close();
    db.close();
  });

  it("401 when bearer token required and missing", async () => {
    const { app, db } = setup("secret");
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: { integration: "x", credentialTypeName: "y", name: "z", fields: {} },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
    db.close();
  });
});

describe("GET /api/credentials", () => {
  it("lists credentials for an integration without decrypting", async () => {
    const { app, db } = setup();
    // Create two credentials via the API.
    await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: {
        integration: "slack-send",
        credentialTypeName: "slackUserToken",
        name: "a",
        fields: { token: "xoxp-a" },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: {
        integration: "slack-send",
        credentialTypeName: "slackUserToken",
        name: "b",
        fields: { token: "xoxp-b" },
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/credentials?integration=slack-send",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      credentials: Array<{
        id: string;
        name: string;
        credentialTypeName: string;
        authType: string;
        state: string;
        preview: string | null;
      }>;
    };
    expect(body.credentials).toHaveLength(2);
    const names = body.credentials.map((c) => c.name).sort();
    expect(names).toEqual(["a", "b"]);
    // No plaintext in response.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("xoxp-a");
    expect(serialized).not.toContain("xoxp-b");
    expect(body.credentials[0]!.preview).toBe("****");
    await app.close();
    db.close();
  });

  it("400 when integration query param is missing", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/credentials",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });
});

describe("POST /api/credentials/:id/test", () => {
  it("returns NO_TEST ok:true when integration lacks testCredential", async () => {
    const { app, db } = setup();
    const create = await app.inject({
      method: "POST",
      url: "/api/credentials",
      payload: {
        integration: "slack-send",
        credentialTypeName: "slackUserToken",
        name: "x",
        fields: { token: "xoxp-test" },
      },
    });
    const { id } = create.json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/credentials/${id}/test`,
      payload: { integration: "slack-send" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; errorCode?: string };
    expect(body.ok).toBe(true);
    expect(body.errorCode).toBe("NO_TEST");
    await app.close();
    db.close();
  });

  it("returns NOT_FOUND when id is unknown", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "POST",
      url: `/api/credentials/unknown-id/test`,
      payload: { integration: "slack-send" },
    });
    expect(res.statusCode).toBe(200); // testAuth returns structured error, not HTTP 404
    const body = res.json() as { ok: boolean; errorCode: string };
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe("NOT_FOUND");
    await app.close();
    db.close();
  });

  it("400 when body.integration is missing", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "POST",
      url: `/api/credentials/some-id/test`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });
});

describe("POST /api/credentials/authenticate", () => {
  it("returns authorizeUrl + state + expiresAt", async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials/authenticate",
      payload: {
        integration: "slack-send",
        credentialTypeName: "slackOAuth2Bot",
        name: "work",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      authorizeUrl: string;
      state: string;
      expiresAt: string;
    };
    expect(body.state).toBe("state-api-test-1234567");
    expect(body.authorizeUrl).toContain("slack.com/oauth/v2/authorize");
    expect(body.authorizeUrl).toContain("client_id=ci");
    await app.close();
    db.close();
  });

  it("400 when no oauth2 type exists in integration manifest", async () => {
    // Build a manifest with no oauth2 types.
    const nonOAuthManifest: IntegrationManifest = {
      name: "stripe",
      version: "0.1.0",
      description: "",
      authType: "apiKey",
      operations: [],
      credentialTypes: [
        {
          name: "stripeKey",
          displayName: "Stripe Key",
          authType: "apiKey",
          fields: [
            {
              name: "key",
              displayName: "Key",
              type: "password",
              required: true,
              oauthManaged: false,
            },
          ],
        },
      ],
    };
    const db = openDatabase(":memory:");
    const service = new RuntimeCredentialService({
      db,
      key: randomBytes(32),
      manifestLookup: (n) => (n === "stripe" ? nonOAuthManifest : undefined),
    });
    const app = Fastify({ logger: false });
    registerApiRoutes(app, db, { credentialService: service });
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials/authenticate",
      payload: { integration: "stripe", name: "x" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe("AUTHENTICATE_FAILED");
    expect(body.message).toContain("oauth2");
    await app.close();
    db.close();
  });

  it("401 when bearer is required and missing", async () => {
    const { app, db } = setup("guarded");
    const res = await app.inject({
      method: "POST",
      url: "/api/credentials/authenticate",
      payload: { integration: "slack-send", name: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
    db.close();
  });
});
