import { describe, expect, it, vi } from "vitest";
import { openDatabase, QueryHelpers } from "./db.js";
import {
  ExpiryAlarm,
  computeDeadline,
  startExpiryAlarm,
  DEFAULT_ROTATION_DAYS,
} from "./expiry-alarm.js";
import type { EventDispatcher } from "./triggers/event.js";

function setup() {
  const db = openDatabase(":memory:");
  const helpers = new QueryHelpers(db);
  return { db, helpers };
}

function seedCred(
  helpers: QueryHelpers,
  overrides: Partial<{
    id: string;
    integration: string;
    type: string;
    credential_type_name: string;
    name: string;
    oauth_access_expires: string | null;
    state: "active" | "invalid" | "expired";
    created_at: string;
    updated_at: string;
  }> = {},
): void {
  helpers.insertCredential({
    id: overrides.id ?? "c-1",
    integration: overrides.integration ?? "github",
    type: overrides.type ?? "apiKey",
    credential_type_name: overrides.credential_type_name ?? "githubPAT",
    name: overrides.name ?? "personal",
    encrypted_payload: Buffer.from([0]),
    oauth_access_expires: overrides.oauth_access_expires ?? null,
    oauth_refresh_expires: null,
    oauth_scopes: null,
    state: overrides.state ?? "active",
    last_error: null,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
  });
}

function fakeDispatcher() {
  const emitted: Array<{ type: string; payload?: unknown; correlationId?: string }> = [];
  const d: Pick<EventDispatcher, "emit"> = {
    emit: ((input) => {
      emitted.push({
        type: input.type,
        payload: input.payload,
        correlationId: input.correlationId,
      });
      return {
        event: {
          id: "evt-1",
          type: input.type,
          payload: JSON.stringify(input.payload ?? null),
          source: input.source ?? null,
          emitted_at: "2026-04-15T00:00:00.000Z",
          correlation_id: input.correlationId ?? null,
          consumed_by_run: null,
        },
        triggeredRunIds: [],
        resolvedWaitingSteps: [],
      };
    }) as EventDispatcher["emit"],
  };
  return { dispatcher: d as EventDispatcher, emitted };
}

// ── computeDeadline (pure helper) ───────────────────────────────────────────

describe("computeDeadline", () => {
  it("uses oauth_access_expires when set", () => {
    const cred = {
      id: "c",
      integration: "github",
      type: "apiKey",
      credential_type_name: "githubPAT",
      name: "x",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: "2026-05-01T00:00:00.000Z",
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active" as const,
      last_error: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    expect(computeDeadline(cred, 90).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("falls back to created_at + defaultRotationDays", () => {
    const cred = {
      id: "c",
      integration: "github",
      type: "apiKey",
      credential_type_name: "githubPAT",
      name: "x",
      encrypted_payload: Buffer.from([0]),
      oauth_access_expires: null,
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active" as const,
      last_error: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    // 2026-01-01 + 90 days = 2026-04-01
    expect(computeDeadline(cred, 90).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

// ── ExpiryAlarm.tick ─────────────────────────────────────────────────────────

describe("ExpiryAlarm.tick", () => {
  it("emits credential.expiring when within the 7d warn window", async () => {
    const { db, helpers } = setup();
    // Created 2026-01-01, default rotation 90d → deadline 2026-04-01.
    // Now = 2026-03-26 → 6 days out, inside 7d window.
    seedCred(helpers, { id: "c-soon" });
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    const result = await alarm.tick();
    expect(result.scanned).toBe(1);
    expect(result.emitted).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("credential.expiring");
    expect(emitted[0]!.correlationId).toBe("c-soon");
    const p = emitted[0]!.payload as Record<string, unknown>;
    expect(p.credentialId).toBe("c-soon");
    expect(p.integration).toBe("github");
    expect(p.credentialTypeName).toBe("githubPAT");
    expect(p.daysUntilDeadline).toBe(6);
    expect(p.reason).toBe("default-rotation-horizon");
    db.close();
  });

  it("does NOT emit when credential is outside the warn window", async () => {
    const { db, helpers } = setup();
    seedCred(helpers); // deadline 2026-04-01
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-01-15T00:00:00.000Z"), // 76 days out
    });
    const result = await alarm.tick();
    expect(result.scanned).toBe(1);
    expect(result.emitted).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(result.entries[0]!.reason).toBe("outside-warn-window");
    db.close();
  });

  it("uses oauth_access_expires as deadline when present (explicit-expiry reason)", async () => {
    const { db, helpers } = setup();
    seedCred(helpers, {
      id: "c-pat",
      oauth_access_expires: "2026-04-20T00:00:00.000Z",
    });
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-04-14T00:00:00.000Z"), // 6 days before explicit deadline
    });
    const result = await alarm.tick();
    expect(result.emitted).toBe(1);
    const p = emitted[0]!.payload as Record<string, unknown>;
    expect(p.reason).toBe("explicit-expiry");
  });

  it("does NOT emit for OAuth credentials (handled by OAuthRefresher)", async () => {
    const { db, helpers } = setup();
    seedCred(helpers, {
      id: "c-oauth",
      type: "oauth2",
      credential_type_name: "slackOAuth2Bot",
      oauth_access_expires: "2026-03-27T00:00:00.000Z",
    });
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    const result = await alarm.tick();
    expect(result.scanned).toBe(0); // oauth2 filtered out at the query level
    expect(result.emitted).toBe(0);
    expect(emitted).toHaveLength(0);
    db.close();
  });

  it("is idempotent across ticks: emits only once per credential rotation", async () => {
    const { db, helpers } = setup();
    seedCred(helpers);
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    const first = await alarm.tick();
    const second = await alarm.tick();
    expect(first.emitted).toBe(1);
    expect(second.emitted).toBe(0);
    expect(second.entries[0]!.reason).toBe("already-fired");
    expect(emitted).toHaveLength(1);
    db.close();
  });

  it("re-emits after a credential is rotated (updated_at changes)", async () => {
    const { db, helpers } = setup();
    seedCred(helpers);
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    await alarm.tick();
    expect(emitted).toHaveLength(1);
    // Simulate rotation: updated_at bumps, but creds are still in-window.
    seedCred(helpers, {
      updated_at: "2026-03-26T12:00:00.000Z",
    });
    const second = await alarm.tick();
    expect(second.emitted).toBe(1);
    expect(emitted).toHaveLength(2);
    db.close();
  });

  it("runs without dispatcher (reports 'no-dispatcher' reason)", async () => {
    const { db, helpers } = setup();
    seedCred(helpers);
    const alarm = new ExpiryAlarm({
      db,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    const result = await alarm.tick();
    expect(result.emitted).toBe(0);
    expect(result.entries[0]!.reason).toBe("no-dispatcher");
    db.close();
  });

  it("ignores credentials marked state='invalid'", async () => {
    const { db, helpers } = setup();
    seedCred(helpers, { state: "invalid" });
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    const result = await alarm.tick();
    expect(result.scanned).toBe(0);
    expect(emitted).toHaveLength(0);
    db.close();
  });

  it("honors custom warnWindowMs + defaultRotationDays", async () => {
    const { db, helpers } = setup();
    // Created 2026-01-01, rotation=30d → deadline 2026-01-31.
    seedCred(helpers);
    const { dispatcher, emitted } = fakeDispatcher();
    const alarm = new ExpiryAlarm({
      db,
      dispatcher,
      warnWindowMs: 3 * 24 * 60 * 60 * 1000,
      defaultRotationDays: 30,
      now: () => new Date("2026-01-29T00:00:00.000Z"), // 2 days out
    });
    const result = await alarm.tick();
    expect(result.emitted).toBe(1);
    const p = emitted[0]!.payload as Record<string, unknown>;
    expect(p.daysUntilDeadline).toBe(2);
    db.close();
  });
});

describe("ExpiryAlarm.start / stop", () => {
  it("start schedules an interval; stop clears it", () => {
    const { db } = setup();
    let scheduled = 0;
    let cleared = 0;
    const alarm = new ExpiryAlarm({
      db,
      setIntervalFn: () => {
        scheduled++;
        return { id: scheduled };
      },
      clearIntervalFn: () => {
        cleared++;
      },
    });
    alarm.start();
    alarm.start(); // idempotent
    expect(scheduled).toBe(1);
    alarm.stop();
    alarm.stop(); // idempotent
    expect(cleared).toBe(1);
    db.close();
  });

  it("startExpiryAlarm constructs + starts in one call", () => {
    const { db } = setup();
    let scheduled = 0;
    const alarm = startExpiryAlarm({
      db,
      setIntervalFn: () => {
        scheduled++;
        return { id: scheduled };
      },
      clearIntervalFn: () => {},
    });
    expect(scheduled).toBe(1);
    alarm.stop();
    db.close();
  });
});

describe("ExpiryAlarm defaults", () => {
  it("exports a 90-day default rotation horizon", () => {
    expect(DEFAULT_ROTATION_DAYS).toBe(90);
  });
});

describe("ExpiryAlarm emit error isolation", () => {
  it("records emit-failed reason when dispatcher throws", async () => {
    const { db, helpers } = setup();
    seedCred(helpers);
    const throwingDispatcher: Pick<EventDispatcher, "emit"> = {
      emit: (() => {
        throw new Error("dispatcher down");
      }) as EventDispatcher["emit"],
    };
    const alarm = new ExpiryAlarm({
      db,
      dispatcher: throwingDispatcher as EventDispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    const result = await alarm.tick();
    expect(result.emitted).toBe(0);
    expect(result.entries[0]!.reason).toContain("emit-failed:dispatcher down");
    db.close();
  });

  it("spy: vi.fn dispatcher receives emit call", async () => {
    const { db, helpers } = setup();
    seedCred(helpers);
    const spy = vi.fn();
    const d: Pick<EventDispatcher, "emit"> = {
      emit: spy as EventDispatcher["emit"],
    };
    const alarm = new ExpiryAlarm({
      db,
      dispatcher: d as EventDispatcher,
      now: () => new Date("2026-03-26T00:00:00.000Z"),
    });
    await alarm.tick();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "credential.expiring",
        source: "expiry-alarm",
      }),
    );
    db.close();
  });
});
