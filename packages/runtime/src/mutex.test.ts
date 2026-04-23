import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

describe("Mutex — basic semantics", () => {
  it("serializes overlapping critical sections", async () => {
    const m = new Mutex();
    const log: string[] = [];

    const task = async (id: string, holdMs: number): Promise<void> => {
      await m.withLock(async () => {
        log.push(`enter:${id}`);
        await new Promise((r) => setTimeout(r, holdMs));
        log.push(`leave:${id}`);
      });
    };

    await Promise.all([task("A", 20), task("B", 10), task("C", 5)]);

    // FIFO order: A starts first, B is queued next, then C. So we expect
    // strict pairs without interleaving.
    expect(log).toEqual([
      "enter:A",
      "leave:A",
      "enter:B",
      "leave:B",
      "enter:C",
      "leave:C",
    ]);
  });

  it("releases the lock on throw inside withLock", async () => {
    const m = new Mutex();
    await expect(
      m.withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(m.isLocked).toBe(false);
    expect(m.queueDepth).toBe(0);
    // Should be acquirable again immediately.
    let entered = false;
    await m.withLock(async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("manually-released acquire still works", async () => {
    const m = new Mutex();
    const release1 = await m.acquire();
    expect(m.isLocked).toBe(true);

    const stages: string[] = [];
    const p2 = m.acquire().then((release2) => {
      stages.push("got2");
      release2();
    });

    expect(m.queueDepth).toBe(1);
    release1();
    await p2;
    expect(stages).toEqual(["got2"]);
    expect(m.isLocked).toBe(false);
  });

  it("handles many parallel waiters in FIFO order", async () => {
    const m = new Mutex();
    const log: number[] = [];
    const N = 20;
    const tasks = Array.from({ length: N }, (_, i) =>
      m.withLock(async () => {
        log.push(i);
        // No delay — exercise the synchronous-ish hand-off path.
      }),
    );
    await Promise.all(tasks);
    expect(log).toEqual(Array.from({ length: N }, (_, i) => i));
  });
});
