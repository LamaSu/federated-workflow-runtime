import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import type { IntegrationManifest } from "@delightfulchorus/core";
import { openDatabase, createHelpers } from "../db.js";
import { RunQueue } from "../queue.js";
import { EventDispatcher } from "../triggers/event.js";
import { RuntimeCredentialService } from "../credential-service.js";
import { registerApiRoutes } from "./index.js";

/**
 * GET /api/oauth/callback test coverage:
 *   - happy path: valid state+code → token exchange → credential persisted,
 *     event fired with ok:true, 200 HTML returned
 *   - expired state → 400 HTML, event fired with ok:false
 *   - replayed state (already consumed) → 400 HTML
 *   - token endpoint rejects code → 400 HTML + consumed with error
 *   - malformed query (missing state) → 400 HTML, no DB changes
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
        {
          name: "clientId",
          displayName: "Client ID",
          type: "string",
          required: true,
          oauthManaged: false,
        },
        {
          name: "clientSecret",
          displayName: "Client Secret",
          type: "password",
          required: true,
          oauthManaged: false,
        },
        {
          name: "accessToken",
          displayName: "Access Token",
          type: "password",
          required: true,
          oauthManaged: true,
        },
      ],
    },
  ],
};

interface Setup {
  app: ReturnType<typeof Fastify>;
  db: ReturnType<typeof openDatabase>;
  dispatcher: EventDispatcher;
  service: RuntimeCredentialService;
  state: string;
  fetchCalls: { url: string; body: string }[];
}

async function setupWithPending(opts: {
  tokenResponse?: { status: number; body: unknown };
  state?: string;
} = {}): Promise<Setup> {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  const queue = new RunQueue(db);
  const dispatcher = new EventDispatcher({ queue, db });
  const fetchCalls: { url: string; body: string }[] = [];
  const fixedState = opts.state ?? "state-fixture-abcdef123456";

  const tokenResponse = opts.tokenResponse ?? {
    status: 200,
    body: {
      access_token: "xoxb-mock-token",
      refresh_token: "xoxr-mock-refresh",
      expires_in: 3600,
      scope: "chat:write",
    },
  };
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({
      url: url.toString(),
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify(tokenResponse.body), {
      status: tokenResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  const service = new RuntimeCredentialService({
    db,
    key,
    manifestLookup: (n) => (n === "slack-send" ? slackManifest : undefined),
    clientIdFor: () => ({ clientId: "ci-test", clientSecret: "cs-test" }),
    randomState: () => fixedState,
    now: () => new Date("2026-04-15T00:00:00.000Z"),
  });

  // Pre-seed the pending row via authenticate()
  await service.authenticate({
    integration: "slack-send",
    credentialTypeName: "slackOAuth2Bot",
    name: "work",
  });

  const app = Fastify({ logger: false });
  registerApiRoutes(app, db, {
    credentialService: service,
    eventDispatcher: dispatcher,
    fetchFn: fetchFn as unknown as typeof fetch,
  });

  return { app, db, dispatcher, service, state: fixedState, fetchCalls };
}

function eventsOf(db: ReturnType<typeof openDatabase>, state: string) {
  return db
    .prepare(`SELECT * FROM events WHERE type = ? ORDER BY emitted_at ASC`)
    .all(`oauth.callback.${state}`) as Array<{
    id: string;
    type: string;
    payload: string;
  }>;
}

describe("GET /api/oauth/callback — happy path", () => {
  it("exchanges code → stores credential → fires ok event → returns 200 HTML", async () => {
    const { app, db, state, fetchCalls } = await setupWithPending();
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=auth-code-abc&state=${state}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.payload).toContain("Connected");
    expect(res.payload).toContain("slackOAuth2Bot");
    expect(res.payload).toContain("close this window");

    // Token endpoint was called with the code.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(fetchCalls[0]!.body).toContain("code=auth-code-abc");
    expect(fetchCalls[0]!.body).toContain("grant_type=authorization_code");

    // Pending row is consumed with credential_id set.
    const pending = createHelpers(db).getOAuthPending(state);
    expect(pending?.consumed_at).toBe("2026-04-15T00:00:00.000Z");
    expect(pending?.credential_id).toMatch(/[0-9a-f-]{36}/);
    expect(pending?.consumed_error).toBeNull();

    // Credential was inserted.
    const cred = createHelpers(db).getCredential(pending!.credential_id!);
    expect(cred?.state).toBe("active");
    expect(cred?.type).toBe("oauth2");

    // Event was fired with ok:true.
    const events = eventsOf(db, state);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as {
      ok: boolean;
      credentialId: string;
      credentialTypeName: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.credentialId).toBe(pending?.credential_id);
    expect(payload.credentialTypeName).toBe("slackOAuth2Bot");

    await app.close();
    db.close();
  });
});

describe("GET /api/oauth/callback — failure paths", () => {
  it("400 HTML + ok:false event when token endpoint rejects code", async () => {
    const { app, db, state } = await setupWithPending({
      tokenResponse: {
        status: 400,
        body: { error: "invalid_grant", error_description: "code expired" },
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=bad&state=${state}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.payload).toContain("OAuth callback failed");

    const pending = createHelpers(db).getOAuthPending(state);
    expect(pending?.consumed_at).toBeTruthy();
    expect(pending?.consumed_error).toContain("token exchange failed");
    expect(pending?.credential_id).toBeNull();

    const events = eventsOf(db, state);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("token exchange failed");

    await app.close();
    db.close();
  });

  it("400 on replayed state (already consumed)", async () => {
    const { app, db, state } = await setupWithPending();
    // First callback succeeds.
    const first = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=c1&state=${state}`,
    });
    expect(first.statusCode).toBe(200);
    // Second callback with same state should fail — row is consumed.
    const second = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=c2&state=${state}`,
    });
    expect(second.statusCode).toBe(400);
    expect(second.payload).toContain("already consumed");
    await app.close();
    db.close();
  });

  it("400 on unknown state (no oauth_pending row)", async () => {
    const { app, db } = await setupWithPending();
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=whatever&state=unknown-state-xyzzy12345`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("unknown oauth state");
    await app.close();
    db.close();
  });

  it("400 on malformed query (missing state)", async () => {
    const { app, db } = await setupWithPending();
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=onlycode`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("Invalid OAuth callback");
    await app.close();
    db.close();
  });

  it("400 on state that's too short (below min length)", async () => {
    const { app, db } = await setupWithPending();
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=c&state=short`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("Invalid OAuth callback");
    await app.close();
    db.close();
  });

  it("400 on state with disallowed characters (e.g. whitespace)", async () => {
    const { app, db } = await setupWithPending();
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=c&state=${encodeURIComponent("state with space 123456")}`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it("400 when pending expired", async () => {
    // Build a service whose `now()` is 1 hour in the past so authorize
    // creates a short-lived pending, then the callback happens 'now' (later).
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    const queue = new RunQueue(db);
    const dispatcher = new EventDispatcher({ queue, db });
    const state = "state-will-expire-123456789";

    const svc1 = new RuntimeCredentialService({
      db,
      key,
      manifestLookup: (n) => (n === "slack-send" ? slackManifest : undefined),
      clientIdFor: () => ({ clientId: "ci", clientSecret: "cs" }),
      randomState: () => state,
      now: () => new Date("2026-04-15T00:00:00.000Z"),
      pendingTtlMs: 60_000,
    });
    await svc1.authenticate({
      integration: "slack-send",
      credentialTypeName: "slackOAuth2Bot",
      name: "x",
    });

    const svc2 = new RuntimeCredentialService({
      db,
      key,
      manifestLookup: (n) => (n === "slack-send" ? slackManifest : undefined),
      clientIdFor: () => ({ clientId: "ci", clientSecret: "cs" }),
      now: () => new Date("2026-04-15T01:00:00.000Z"),
    });

    const app = Fastify({ logger: false });
    registerApiRoutes(app, db, {
      credentialService: svc2,
      eventDispatcher: dispatcher,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=whatever&state=${state}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain("expired");

    const pending = createHelpers(db).getOAuthPending(state);
    expect(pending?.consumed_at).toBeTruthy();
    expect(pending?.consumed_error).toContain("expired");

    await app.close();
    db.close();
  });
});

describe("GET /api/oauth/callback — without eventDispatcher", () => {
  it("still works (no event fired, credential still persisted)", async () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    const state = "state-no-dispatcher-1234567";
    const fetchFn = async (): Promise<Response> =>
      new Response(
        JSON.stringify({ access_token: "t", expires_in: 60 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const service = new RuntimeCredentialService({
      db,
      key,
      manifestLookup: (n) => (n === "slack-send" ? slackManifest : undefined),
      clientIdFor: () => ({ clientId: "ci", clientSecret: "cs" }),
      randomState: () => state,
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    });
    await service.authenticate({
      integration: "slack-send",
      credentialTypeName: "slackOAuth2Bot",
      name: "nd",
    });

    const app = Fastify({ logger: false });
    registerApiRoutes(app, db, {
      credentialService: service,
      fetchFn: fetchFn as unknown as typeof fetch,
      // no eventDispatcher
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=c&state=${state}`,
    });
    expect(res.statusCode).toBe(200);
    const pending = createHelpers(db).getOAuthPending(state);
    expect(pending?.credential_id).toBeTruthy();
    await app.close();
    db.close();
  });
});

describe("GET /api/oauth/callback — auth guard", () => {
  it("401 when CHORUS_API_TOKEN is enforced and no token provided", async () => {
    // The /api/* bearer auth guard runs BEFORE our route handler. The
    // callback URL comes from a browser redirect and normally shouldn't
    // carry a bearer token — production deployments that enable the
    // bearer guard should expose a different callback host.
    const { db } = await setupWithPending();
    const key = randomBytes(32);
    const service = new RuntimeCredentialService({
      db,
      key,
      manifestLookup: (n) => (n === "slack-send" ? slackManifest : undefined),
      clientIdFor: () => ({ clientId: "ci", clientSecret: "cs" }),
    });
    const app = Fastify({ logger: false });
    registerApiRoutes(app, db, {
      apiToken: "protected",
      credentialService: service,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=x&state=abcdef1234567890`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
    db.close();
  });
});
