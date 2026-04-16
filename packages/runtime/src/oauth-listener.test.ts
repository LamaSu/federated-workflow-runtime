import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { RunQueue } from "./queue.js";
import { EventDispatcher } from "./triggers/event.js";
import { OAuthCallbackListener } from "./oauth-listener.js";

/**
 * OAuthCallbackListener tests — short-poll of events table.
 * Uses fake sleep + fake clock so we don't spend real time.
 */

function setup() {
  const db = openDatabase(":memory:");
  const queue = new RunQueue(db);
  const dispatcher = new EventDispatcher({ queue, db });
  return { db, dispatcher };
}

describe("OAuthCallbackListener", () => {
  it("resolves with {ok: true} when success event arrives", async () => {
    const { db, dispatcher } = setup();
    // Emit the event BEFORE the listener starts — our listener filters
    // by `emitted_at >= startedAtIso`, so events that predate the
    // listener would be missed. In production the emit happens DURING
    // the wait. Here, we first start waiting, then emit mid-sleep.
    let currentTime = 1_000_000;
    const listener = new OAuthCallbackListener({
      db,
      pollIntervalMs: 10,
      sleepFn: async (ms) => {
        currentTime += ms;
        if (currentTime === 1_000_020) {
          // On second poll, emit the event.
          dispatcher.emit({
            type: "oauth.callback.state-happy-123",
            payload: {
              ok: true,
              credentialId: "cred-new-42",
              credentialTypeName: "slackOAuth2Bot",
            },
          });
        }
      },
      now: () => currentTime,
    });
    const result = await listener.waitForOAuthCallback(
      "state-happy-123",
      60_000,
    );
    expect(result).toEqual({
      ok: true,
      credentialId: "cred-new-42",
      credentialTypeName: "slackOAuth2Bot",
    });
    db.close();
  });

  it("resolves with {ok: false} on timeout", async () => {
    const { db } = setup();
    let currentTime = 0;
    const listener = new OAuthCallbackListener({
      db,
      pollIntervalMs: 100,
      sleepFn: async (ms) => {
        currentTime += ms;
      },
      now: () => currentTime,
    });
    const result = await listener.waitForOAuthCallback("nope", 500);
    expect(result).toEqual({ ok: false, error: "timeout" });
    db.close();
  });

  it("resolves with {ok: false, error} when callback event reports failure", async () => {
    const { db, dispatcher } = setup();
    let currentTime = 0;
    const listener = new OAuthCallbackListener({
      db,
      pollIntervalMs: 10,
      sleepFn: async (ms) => {
        currentTime += ms;
        if (currentTime === 10) {
          dispatcher.emit({
            type: "oauth.callback.state-failed-1",
            payload: { ok: false, error: "token exchange failed (400)" },
          });
        }
      },
      now: () => currentTime,
    });
    const result = await listener.waitForOAuthCallback(
      "state-failed-1",
      10_000,
    );
    expect(result).toEqual({
      ok: false,
      error: "token exchange failed (400)",
    });
    db.close();
  });

  it("only matches events emitted after the wait starts (no replay)", async () => {
    const { db, dispatcher } = setup();
    // Emit an old event with a past timestamp BEFORE starting the wait.
    // Real dispatcher uses now(); override via a custom EventDispatcher.
    dispatcher.emit({
      type: "oauth.callback.state-stale-1",
      payload: {
        ok: true,
        credentialId: "cred-old",
        credentialTypeName: "anyType",
      },
    });
    // Wait — our listener should NOT pick this up because emitted_at
    // is from dispatcher's real clock (before now), and startedAtIso
    // is computed FROM our fake `now`. To avoid a flaky timing
    // dependency, configure the listener's now to return a time that's
    // well after that real emit — meaning our filter will treat the
    // event as "too old".
    const startedFakeTime = new Date("2099-01-01T00:00:00Z").getTime();
    let currentTime = startedFakeTime;
    const listener = new OAuthCallbackListener({
      db,
      pollIntervalMs: 10,
      sleepFn: async (ms) => {
        currentTime += ms;
      },
      now: () => currentTime,
    });
    const result = await listener.waitForOAuthCallback(
      "state-stale-1",
      100,
    );
    // The old event was before our fake startedAtIso, so we time out.
    expect(result).toEqual({ ok: false, error: "timeout" });
    db.close();
  });

  it("returns malformed error on non-JSON payload", async () => {
    const { db } = setup();
    // Directly insert an invalid event payload (bypass dispatcher).
    db.prepare(
      `INSERT INTO events (id, type, payload, source, emitted_at, correlation_id, consumed_by_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ev-bad",
      "oauth.callback.state-bad-json-1",
      "not-valid-json{",
      null,
      new Date().toISOString(),
      null,
      null,
    );
    let currentTime = 0;
    const listener = new OAuthCallbackListener({
      db,
      pollIntervalMs: 10,
      sleepFn: async (ms) => {
        currentTime += ms;
      },
      now: () => currentTime,
    });
    // Note: the payload we stored has emitted_at = Date.now() (real),
    // our fake `now` is at 0 so startedAtIso would be epoch. The
    // stored row's emitted_at is in the future of epoch, so it DOES
    // match the filter.
    const result = await listener.waitForOAuthCallback(
      "state-bad-json-1",
      10_000,
    );
    expect(result).toEqual({
      ok: false,
      error: "oauth.callback event has malformed payload",
    });
    db.close();
  });
});
