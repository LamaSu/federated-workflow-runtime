import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { RunQueue } from "./queue.js";

function setup() {
  const db = openDatabase(":memory:");
  const q = new RunQueue(db);
  return { db, q };
}

describe("RunQueue.enqueue", () => {
  it("enqueues a run and returns an id", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1", { triggeredBy: "manual", triggerPayload: { foo: "bar" } });
    expect(id).toMatch(/[0-9a-f-]{8,}/);
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.triggered_by).toBe("manual");
    expect(JSON.parse(row.trigger_payload as string)).toEqual({ foo: "bar" });
    db.close();
  });

  it("honors priority on claim — higher priority first", () => {
    const { q, db } = setup();
    q.enqueue("wf-1", { priority: 0, nowIso: "2026-04-13T00:00:00.000Z" });
    const hi = q.enqueue("wf-1", { priority: 10, nowIso: "2026-04-13T00:00:01.000Z" });
    q.enqueue("wf-1", { priority: 5, nowIso: "2026-04-13T00:00:02.000Z" });
    const claimed = q.claim({ nowIso: "2026-04-13T00:00:05.000Z" });
    expect(claimed?.id).toBe(hi);
    db.close();
  });

  it("ties broken by earliest started_at", () => {
    const { q, db } = setup();
    const first = q.enqueue("wf-1", { nowIso: "2026-04-13T00:00:00.000Z" });
    q.enqueue("wf-1", { nowIso: "2026-04-13T00:00:01.000Z" });
    const claimed = q.claim({ nowIso: "2026-04-13T00:00:05.000Z" });
    expect(claimed?.id).toBe(first);
    db.close();
  });
});

describe("RunQueue.claim", () => {
  it("marks the claimed run as running and sets visibility_until", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1");
    const claimed = q.claim({ visibilityMs: 30_000, nowIso: "2026-04-13T00:00:00.000Z" });
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.visibility_until).toBe("2026-04-13T00:00:30.000Z");
    db.close();
  });

  it("returns null when the queue is empty", () => {
    const { q, db } = setup();
    expect(q.claim()).toBeNull();
    db.close();
  });

  it("does not return a run whose next_wakeup is in the future", () => {
    const { q, db } = setup();
    q.enqueue("wf-1", { nextWakeup: "2026-04-13T00:10:00.000Z" });
    expect(q.claim({ nowIso: "2026-04-13T00:00:00.000Z" })).toBeNull();
    expect(q.claim({ nowIso: "2026-04-13T00:15:00.000Z" })?.status).toBe("running");
    db.close();
  });

  it("each claim happens only once across consumers", () => {
    const { q, db } = setup();
    q.enqueue("wf-1");
    const a = q.claim({ nowIso: "2026-04-13T00:00:00.000Z" });
    const b = q.claim({ nowIso: "2026-04-13T00:00:00.000Z" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    db.close();
  });

  it("re-claims a run whose visibility has expired (crashed-worker recovery)", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1");
    const first = q.claim({ visibilityMs: 1_000, nowIso: "2026-04-13T00:00:00.000Z" });
    expect(first?.id).toBe(id);

    // Simulate clock advancing past visibility window.
    const second = q.claim({ nowIso: "2026-04-13T00:01:00.000Z" });
    expect(second?.id).toBe(id);
    expect(second?.attempt).toBe(2);
    db.close();
  });

  it("does NOT re-claim a run whose visibility has not expired yet", () => {
    const { q, db } = setup();
    q.enqueue("wf-1");
    q.claim({ visibilityMs: 60_000, nowIso: "2026-04-13T00:00:00.000Z" });
    const second = q.claim({ nowIso: "2026-04-13T00:00:10.000Z" });
    expect(second).toBeNull();
    db.close();
  });
});

describe("RunQueue.heartbeat / complete / release", () => {
  it("heartbeat extends visibility_until", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1");
    q.claim({ visibilityMs: 5_000, nowIso: "2026-04-13T00:00:00.000Z" });
    q.heartbeat(id, { visibilityMs: 60_000, nowIso: "2026-04-13T00:00:04.000Z" });
    const row = db.prepare("SELECT visibility_until FROM runs WHERE id = ?").get(id) as {
      visibility_until: string;
    };
    expect(row.visibility_until).toBe("2026-04-13T00:01:04.000Z");
    db.close();
  });

  it("complete transitions to success and clears visibility", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1");
    q.claim();
    q.complete(id, "success", { nowIso: "2026-04-13T00:00:01.000Z" });
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.status).toBe("success");
    expect(row.finished_at).toBe("2026-04-13T00:00:01.000Z");
    expect(row.visibility_until).toBeNull();
    db.close();
  });

  it("complete failed records the error message", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1");
    q.claim();
    q.complete(id, "failed", { error: "boom", nowIso: "2026-04-13T00:00:02.000Z" });
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom");
    db.close();
  });

  it("release returns the run to pending", () => {
    const { q, db } = setup();
    const id = q.enqueue("wf-1");
    q.claim();
    q.release(id, { nextWakeup: "2026-04-13T00:05:00.000Z" });
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.visibility_until).toBeNull();
    expect(row.next_wakeup).toBe("2026-04-13T00:05:00.000Z");
    db.close();
  });

  it("pendingCount reflects the queue depth", () => {
    const { q, db } = setup();
    q.enqueue("wf-1");
    q.enqueue("wf-2");
    q.enqueue("wf-3");
    expect(q.pendingCount()).toBe(3);
    q.claim();
    expect(q.pendingCount()).toBe(2);
    db.close();
  });
});
