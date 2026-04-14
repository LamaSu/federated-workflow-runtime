import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { openDatabase } from "./db.js";
import { QueryHelpers } from "./db.js";
import { encryptCredential, decryptCredential } from "./credentials.js";
import { OAuthRefresher, startOAuthRefresher } from "./oauth.js";

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
