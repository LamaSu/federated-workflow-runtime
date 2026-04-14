import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { RunQueue } from "../queue.js";
import { CronScheduler } from "./cron.js";

function setup() {
  const db = openDatabase(":memory:");
  const q = new RunQueue(db);
  return { db, q };
}

describe("CronScheduler.nextDelayMs", () => {
  it("computes the next-fire delay in UTC", () => {
    const { q, db } = setup();
    // Fake "now" at exactly 2026-04-13T00:00:00Z
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      // Stop the real scheduler so no timers fire during test.
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {},
    });
    // Every minute at second 0 → next fire = 00:01:00.000Z, delay = 60_000
    const delay = scheduler.nextDelayMs("0 * * * * *", "UTC");
    expect(delay).toBe(60_000);
    db.close();
  });

  it("respects timezone", () => {
    const { q, db } = setup();
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {},
    });
    // "At 09:00 America/New_York" from midnight UTC =
    //   on 2026-04-13 00:00Z, NY is 2026-04-12 20:00 EDT (-4h)
    //   next 09:00 local is 2026-04-13 09:00 EDT = 13:00Z
    //   delay = 13h = 46_800_000 ms
    const delay = scheduler.nextDelayMs("0 9 * * *", "America/New_York");
    expect(delay).toBe(13 * 3600 * 1000);
    db.close();
  });

  it("throws a meaningful error on bad cron expression", () => {
    const { q, db } = setup();
    const scheduler = new CronScheduler({
      queue: q,
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {},
    });
    expect(() => scheduler.nextDelayMs("not a cron expression")).toThrow();
    db.close();
  });
});

describe("CronScheduler.register / fireNow", () => {
  it("fires a trigger and enqueues a run with triggeredBy=cron", () => {
    const { q, db } = setup();
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {},
    });
    scheduler.register({
      workflowId: "wf-cron-1",
      config: { type: "cron", expression: "* * * * *", timezone: "UTC" },
    });
    expect(q.pendingCount()).toBe(0);
    scheduler.fireNow("wf-cron-1");
    expect(q.pendingCount()).toBe(1);
    const row = db.prepare("SELECT * FROM runs WHERE workflow_id = 'wf-cron-1'").get() as {
      triggered_by: string;
    };
    expect(row.triggered_by).toBe("cron");
    scheduler.shutdown();
    db.close();
  });

  it("refuses duplicate registration for the same key", () => {
    const { q, db } = setup();
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {},
    });
    scheduler.register({
      workflowId: "wf-dup",
      config: { type: "cron", expression: "* * * * *", timezone: "UTC" },
    });
    expect(() =>
      scheduler.register({
        workflowId: "wf-dup",
        config: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      }),
    ).toThrow(/already registered/);
    scheduler.shutdown();
    db.close();
  });

  it("unregister stops future firings", () => {
    const { q, db } = setup();
    let cleared = 0;
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      setTimeoutFn: () => ({ id: "mock" }),
      clearTimeoutFn: () => {
        cleared++;
      },
    });
    scheduler.register({
      workflowId: "wf-u",
      config: { type: "cron", expression: "* * * * *", timezone: "UTC" },
    });
    scheduler.unregister("wf-u");
    expect(cleared).toBe(1);
    expect(scheduler.listNextFires()).toHaveLength(0);
    db.close();
  });

  it("computes nextFireAt from now + nextDelayMs", () => {
    const { q, db } = setup();
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      setTimeoutFn: () => ({}),
      clearTimeoutFn: () => {},
    });
    scheduler.register({
      workflowId: "wf-next",
      config: { type: "cron", expression: "0 * * * * *", timezone: "UTC" },
    });
    const next = scheduler.listNextFires()[0];
    expect(next?.nextFireAt).toBe(new Date("2026-04-13T00:01:00.000Z").getTime());
    scheduler.shutdown();
    db.close();
  });

  it("reschedules after firing", () => {
    const { q, db } = setup();
    const registered: unknown[] = [];
    const scheduler = new CronScheduler({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      setTimeoutFn: (cb) => {
        registered.push(cb);
        return { id: registered.length };
      },
      clearTimeoutFn: () => {},
    });
    scheduler.register({
      workflowId: "wf-re",
      config: { type: "cron", expression: "0 * * * * *", timezone: "UTC" },
    });
    // register + fire = two setTimeout calls after fireNow.
    scheduler.fireNow("wf-re");
    expect(registered.length).toBe(2);
    scheduler.shutdown();
    db.close();
  });
});
