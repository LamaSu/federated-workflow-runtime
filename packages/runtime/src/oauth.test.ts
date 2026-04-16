import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { IntegrationManifest } from "@delightfulchorus/core";
import { openDatabase } from "./db.js";
import { QueryHelpers } from "./db.js";
import { encryptCredential, decryptCredential } from "./credentials.js";
import {
  OAuthRefresher,
  defaultOAuth2Refresh,
  startOAuthRefresher,
} from "./oauth.js";

function setup() {
  const db = openDatabase(":memory:");
  const helpers = new QueryHelpers(db);
  const key = randomBytes(32);
  return { db, helpers, key };
}

function seedCredential(
  helpers: QueryHelpers,
  key: Buffer,
  overrides: Partial<{
    id: string;
    oauthAccessExpires: string | null;
    state: "active" | "invalid" | "expired";
    payload: string;
  }> = {},
) {
  const blob = encryptCredential(overrides.payload ?? '{"access":"old","refresh":"r"}', key);
  helpers.insertCredential({
    id: overrides.id ?? "c-1",
    integration: "google",
    type: "oauth2",
    credential_type_name: "",
    name: "main",
    encrypted_payload: blob,
    oauth_access_expires: overrides.oauthAccessExpires ?? "2026-04-13T00:05:00.000Z",
    oauth_refresh_expires: null,
    oauth_scopes: "[]",
    state: overrides.state ?? "active",
    last_error: null,
    created_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
  });
}

describe("OAuthRefresher.tick — fires BEFORE expiry", () => {
  it("refreshes credentials expiring within the lead time", async () => {
    const { db, helpers, key } = setup();
    // Expires at 00:05, lead time 10min, now = 00:00 → within window.
    seedCredential(helpers, key);
    const r = new OAuthRefresher({
      db,
      key,
      refresh: async () => ({
        newPayload: '{"access":"new","refresh":"r2"}',
        accessTokenExpiresAt: "2026-04-13T01:00:00.000Z",
      }),
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    const { refreshed, failed } = await r.tick();
    expect(refreshed).toBe(1);
    expect(failed).toBe(0);
    const row = helpers.getCredential("c-1")!;
    expect(row.state).toBe("active");
    expect(row.oauth_access_expires).toBe("2026-04-13T01:00:00.000Z");
    const plain = decryptCredential(row.encrypted_payload, key);
    expect(JSON.parse(plain).access).toBe("new");
    db.close();
  });

  it("does NOT refresh credentials outside the lead time window", async () => {
    const { db, helpers, key } = setup();
    // Expires at 01:00, lead time 10min, now=00:00 → delta 60min, outside window
    seedCredential(helpers, key, { oauthAccessExpires: "2026-04-13T01:00:00.000Z" });
    let called = 0;
    const r = new OAuthRefresher({
      db,
      key,
      refresh: async () => {
        called++;
        return {
          newPayload: '{"access":"new"}',
          accessTokenExpiresAt: "2026-04-13T02:00:00.000Z",
        };
      },
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    const { refreshed, failed } = await r.tick();
    expect(refreshed).toBe(0);
    expect(failed).toBe(0);
    expect(called).toBe(0);
    db.close();
  });

  it("marks credentials invalid on refresh failure", async () => {
    const { db, helpers, key } = setup();
    seedCredential(helpers, key);
    const onError: unknown[] = [];
    const r = new OAuthRefresher({
      db,
      key,
      refresh: async () => {
        throw new Error("REFRESH_FAILED: refresh_token revoked");
      },
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      onError: (cred, err) => onError.push({ id: cred.id, msg: err.message }),
    });
    const { refreshed, failed } = await r.tick();
    expect(refreshed).toBe(0);
    expect(failed).toBe(1);
    const row = helpers.getCredential("c-1")!;
    expect(row.state).toBe("invalid");
    expect(row.last_error).toMatch(/revoked/);
    expect(onError).toEqual([
      { id: "c-1", msg: expect.stringMatching(/revoked/) as unknown as string },
    ]);
    db.close();
  });

  it("skips credentials already marked invalid", async () => {
    const { db, helpers, key } = setup();
    seedCredential(helpers, key, { state: "invalid" });
    let called = 0;
    const r = new OAuthRefresher({
      db,
      key,
      refresh: async () => {
        called++;
        throw new Error("should not be called");
      },
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    const { refreshed, failed } = await r.tick();
    expect(refreshed).toBe(0);
    expect(failed).toBe(0);
    expect(called).toBe(0);
    db.close();
  });
});

describe("OAuthRefresher.start / stop", () => {
  it("start schedules an interval; stop clears it", () => {
    const { db, key } = setup();
    let scheduled = 0;
    let cleared = 0;
    const r = new OAuthRefresher({
      db,
      key,
      refresh: async () => ({ newPayload: "{}", accessTokenExpiresAt: null }),
      setIntervalFn: () => {
        scheduled++;
        return { id: scheduled };
      },
      clearIntervalFn: () => {
        cleared++;
      },
    });
    r.start();
    r.start(); // idempotent
    expect(scheduled).toBe(1);
    r.stop();
    r.stop(); // idempotent
    expect(cleared).toBe(1);
    db.close();
  });

  it("startOAuthRefresher returns a started instance", () => {
    const { db, key } = setup();
    let scheduled = 0;
    const r = startOAuthRefresher({
      db,
      key,
      refresh: async () => ({ newPayload: "{}", accessTokenExpiresAt: null }),
      setIntervalFn: () => {
        scheduled++;
        return { id: scheduled };
      },
      clearIntervalFn: () => {},
    });
    expect(scheduled).toBe(1);
    r.stop();
    db.close();
  });
});

// ── Catalog-driven default refresh (docs/CREDENTIALS_ANALYSIS.md §4.5) ──────

function makeSlackManifest(): IntegrationManifest {
  return {
    name: "slack-send",
    version: "0.1.0",
    description: "Slack chat.postMessage",
    authType: "oauth2",
    credentialTypes: [
      {
        name: "slackOAuth2Bot",
        displayName: "Slack Bot (OAuth 2.0)",
        authType: "oauth2",
        fields: [],
        oauth: {
          authorizeUrl: "https://slack.com/oauth/v2/authorize",
          tokenUrl: "https://slack.com/api/oauth.v2.access",
          scopes: ["chat:write"],
          pkce: true,
          clientAuthStyle: "header",
          redirectPath: "/oauth/callback",
          authorizeQueryParams: {},
        },
      },
    ],
    operations: [],
  };
}

function makeCredRow(
  overrides: Partial<{
    credential_type_name: string;
    integration: string;
    encrypted_payload: Buffer;
  }> = {},
) {
  return {
    id: "c-1",
    integration: overrides.integration ?? "slack-send",
    type: "oauth2",
    credential_type_name: overrides.credential_type_name ?? "slackOAuth2Bot",
    name: "work",
    encrypted_payload: overrides.encrypted_payload ?? Buffer.from([0]),
    oauth_access_expires: null,
    oauth_refresh_expires: null,
    oauth_scopes: null,
    state: "active" as const,
    last_error: null,
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
  };
}

describe("defaultOAuth2Refresh — RFC 6749 §6 token refresh", () => {
  it("posts grant_type=refresh_token to the catalog's tokenUrl", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(
        JSON.stringify({
          access_token: "xoxb-new",
          refresh_token: "xoxe-new",
          expires_in: 3600,
          scope: "chat:write",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const manifest = makeSlackManifest();
    const type = manifest.credentialTypes[0]!;

    const result = await defaultOAuth2Refresh(
      makeCredRow(),
      type,
      {
        accessToken: "xoxb-old",
        refreshToken: "xoxe-old",
        clientId: "C123",
        clientSecret: "S456",
        teamId: "T0123",
      },
      { fetchFn },
    );

    expect(captured.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(captured.init?.method).toBe("POST");
    const body = String(captured.init?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=xoxe-old");
    // Basic auth header style (header) should NOT put client_id in body.
    const headers = captured.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toMatch(/^Basic /);

    const newPayload = JSON.parse(result.newPayload) as Record<string, unknown>;
    expect(newPayload.accessToken).toBe("xoxb-new");
    expect(newPayload.refreshToken).toBe("xoxe-new");
    expect(newPayload.teamId).toBe("T0123"); // preserved
    expect(result.accessTokenExpiresAt).toMatch(/^\d{4}-/);
  });

  it("sends client credentials in body when clientAuthStyle is 'body'", async () => {
    let capturedBody = "";
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: "new" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const baseManifest = makeSlackManifest();
    const type = {
      ...baseManifest.credentialTypes[0]!,
      oauth: {
        ...baseManifest.credentialTypes[0]!.oauth!,
        clientAuthStyle: "body" as const,
      },
    };
    await defaultOAuth2Refresh(
      makeCredRow(),
      type,
      { refreshToken: "r", clientId: "C1", clientSecret: "S1" },
      { fetchFn },
    );
    expect(capturedBody).toContain("client_id=C1");
    expect(capturedBody).toContain("client_secret=S1");
  });

  it("throws when payload has no refreshToken", async () => {
    const fetchFn = vi.fn();
    const type = makeSlackManifest().credentialTypes[0]!;
    await expect(
      defaultOAuth2Refresh(
        makeCredRow(),
        type,
        { accessToken: "only-access" },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/no refreshToken/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws with helpful message when tokenUrl returns non-2xx", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("nope", { status: 400, statusText: "Bad Request" }),
    ) as unknown as typeof fetch;
    const type = makeSlackManifest().credentialTypes[0]!;
    await expect(
      defaultOAuth2Refresh(
        makeCredRow(),
        type,
        { refreshToken: "r" },
        { fetchFn },
      ),
    ).rejects.toThrow(/OAuth refresh failed \(400\)/);
  });

  it("falls back to type.oauth.tokenUrl when refreshUrl is not set", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ access_token: "new" }), { status: 200 });
    }) as unknown as typeof fetch;
    const type = makeSlackManifest().credentialTypes[0]!;
    await defaultOAuth2Refresh(
      makeCredRow(),
      type,
      { refreshToken: "r" },
      { fetchFn },
    );
    expect(urls).toEqual(["https://slack.com/api/oauth.v2.access"]);
  });
});

describe("OAuthRefresher — manifestLookup integration", () => {
  it("uses defaultOAuth2Refresh when no custom refresh function is supplied", async () => {
    const { db, helpers, key } = setup();
    // Seed with valid JSON payload containing refreshToken
    const payload = JSON.stringify({ accessToken: "old", refreshToken: "r1" });
    helpers.insertCredential({
      id: "c-1",
      integration: "slack-send",
      type: "oauth2",
      credential_type_name: "slackOAuth2Bot",
      name: "main",
      encrypted_payload: encryptCredential(payload, key),
      oauth_access_expires: "2026-04-13T00:05:00.000Z",
      oauth_refresh_expires: null,
      oauth_scopes: "[]",
      state: "active",
      last_error: null,
      created_at: "2026-04-13T00:00:00.000Z",
      updated_at: "2026-04-13T00:00:00.000Z",
    });
    const manifest = makeSlackManifest();
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "xoxb-new",
          refresh_token: "r2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const r = new OAuthRefresher({
      db,
      key,
      manifestLookup: (name) => (name === "slack-send" ? manifest : undefined),
      fetchFn,
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    const { refreshed, failed } = await r.tick();
    expect(refreshed).toBe(1);
    expect(failed).toBe(0);
    expect(fetchFn).toHaveBeenCalledOnce();

    const row = helpers.getCredential("c-1")!;
    const plain = JSON.parse(decryptCredential(row.encrypted_payload, key));
    expect(plain.accessToken).toBe("xoxb-new");
    expect(plain.refreshToken).toBe("r2");
    db.close();
  });

  it("custom refresh function overrides manifestLookup path", async () => {
    const { db, helpers, key } = setup();
    helpers.insertCredential({
      id: "c-1",
      integration: "slack-send",
      type: "oauth2",
      credential_type_name: "slackOAuth2Bot",
      name: "main",
      encrypted_payload: encryptCredential("{}", key),
      oauth_access_expires: "2026-04-13T00:05:00.000Z",
      oauth_refresh_expires: null,
      oauth_scopes: "[]",
      state: "active",
      last_error: null,
      created_at: "2026-04-13T00:00:00.000Z",
      updated_at: "2026-04-13T00:00:00.000Z",
    });
    const customRefresh = vi.fn(async () => ({
      newPayload: '{"accessToken":"from-custom"}',
      accessTokenExpiresAt: "2026-04-13T02:00:00.000Z",
    }));
    const r = new OAuthRefresher({
      db,
      key,
      refresh: customRefresh,
      // manifestLookup is ignored when refresh is present
      manifestLookup: () => undefined,
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    const { refreshed } = await r.tick();
    expect(refreshed).toBe(1);
    expect(customRefresh).toHaveBeenCalledOnce();
    db.close();
  });

  it("marks credential invalid when neither refresh nor manifestLookup is available", async () => {
    const { db, helpers, key } = setup();
    helpers.insertCredential({
      id: "c-1",
      integration: "unknown-integration",
      type: "oauth2",
      credential_type_name: "unknownType",
      name: "main",
      encrypted_payload: encryptCredential("{}", key),
      oauth_access_expires: "2026-04-13T00:05:00.000Z",
      oauth_refresh_expires: null,
      oauth_scopes: "[]",
      state: "active",
      last_error: null,
      created_at: "2026-04-13T00:00:00.000Z",
      updated_at: "2026-04-13T00:00:00.000Z",
    });
    const r = new OAuthRefresher({
      db,
      key,
      leadTimeMs: 10 * 60_000,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    const { refreshed, failed } = await r.tick();
    expect(refreshed).toBe(0);
    expect(failed).toBe(1);
    const row = helpers.getCredential("c-1")!;
    expect(row.state).toBe("invalid");
    expect(row.last_error).toMatch(/no refresh strategy/);
    db.close();
  });
});
