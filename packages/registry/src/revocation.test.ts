import { describe, it, expect, vi } from "vitest";
import {
  isRevoked,
  loadRevocationList,
  RevocationListSchema,
  startRevocationPoller,
  type RevocationList,
  type PollerDb,
} from "./revocation.js";

function sampleList(): RevocationList {
  return {
    schemaVersion: "1.0.0",
    asOf: "2026-04-13T12:00:00Z",
    revoked: [
      {
        patchId: "bad-patch-1",
        reason: "bug",
        severity: "high",
        revokedAt: "2026-04-13T12:00:00Z",
      },
    ],
  };
}

describe("isRevoked", () => {
  it("returns true for revoked patch ids", () => {
    expect(isRevoked("bad-patch-1", sampleList())).toBe(true);
  });

  it("returns false for unknown patch ids", () => {
    expect(isRevoked("unknown", sampleList())).toBe(false);
  });

  it("returns false for empty list", () => {
    const list: RevocationList = { ...sampleList(), revoked: [] };
    expect(isRevoked("anything", list)).toBe(false);
  });
});

describe("RevocationListSchema", () => {
  it("accepts a well-formed list", () => {
    const res = RevocationListSchema.safeParse(sampleList());
    expect(res.success).toBe(true);
  });

  it("rejects unknown severity values", () => {
    const bad = sampleList();
    (bad.revoked[0] as { severity: string }).severity = "nope";
    expect(RevocationListSchema.safeParse(bad).success).toBe(false);
  });
});

describe("loadRevocationList", () => {
  it("returns the parsed list on a 200 response", async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify(sampleList()), { status: 200 });
    const result = await loadRevocationList("https://x/revoked.json", fake);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    expect(result.revoked).toHaveLength(1);
  });

  it("returns an Error on non-2xx status", async () => {
    const fake: typeof fetch = async () => new Response("nope", { status: 503 });
    const result = await loadRevocationList("https://x/revoked.json", fake);
    expect(result).toBeInstanceOf(Error);
  });

  it("returns an Error when the body is malformed", async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ garbage: true }), { status: 200 });
    const result = await loadRevocationList("https://x/revoked.json", fake);
    expect(result).toBeInstanceOf(Error);
  });

  it("returns an Error on network failure", async () => {
    const fake: typeof fetch = async () => {
      throw new Error("econnreset");
    };
    const result = await loadRevocationList("https://x/revoked.json", fake);
    expect(result).toBeInstanceOf(Error);
  });
});

describe("startRevocationPoller", () => {
  it("invokes setRevocationList on a successful poll, then stopper halts further polls", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify(sampleList()), { status: 200 });
    };
    const received: RevocationList[] = [];
    const db: PollerDb = {
      setRevocationList(list) {
        received.push(list);
      },
    };
    const stop = startRevocationPoller(db, "https://x/revoked.json", 10_000, fake);

    // The first tick is scheduled via setTimeout(0); advance to trigger it.
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeGreaterThanOrEqual(1);

    stop();

    // After stop, further time advancement should not trigger more polls.
    const callsBefore = calls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(callsBefore);

    vi.useRealTimers();
  });

  it("invokes onError (if provided) on load failure and keeps polling", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response("nope", { status: 500 });
    };
    const errors: Error[] = [];
    const db: PollerDb = {
      setRevocationList: () => {
        /* never called */
      },
      onError(err) {
        errors.push(err);
      },
    };
    const stop = startRevocationPoller(db, "https://x/revoked.json", 5_000, fake);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    expect(errors.length).toBe(1);

    // Advance past the next interval to get a second tick.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(calls).toBeGreaterThanOrEqual(2);

    stop();
    vi.useRealTimers();
  });

  it("stopper is idempotent", () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify(sampleList()), { status: 200 });
    const db: PollerDb = { setRevocationList: () => undefined };
    const stop = startRevocationPoller(db, "https://x", 1000, fake);
    // Calling stop() twice should not throw.
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});
