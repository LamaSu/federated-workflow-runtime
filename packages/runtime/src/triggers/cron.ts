import cronParser from "cron-parser";
import type { CronTrigger } from "@delightfulchorus/core";
import type { RunQueue } from "../queue.js";

/**
 * Cron scheduler per ARCHITECTURE §4.2.
 *
 * In-process scheduler. For each registered trigger we compute the next-fire
 * time, set a setTimeout, and on fire: enqueue a run, then recompute.
 * Handles timezone via cron-parser's `tz` option.
 *
 * NOT a generic cron daemon — this only powers Chorus trigger firings. A
 * single process-wide scheduler is sufficient for the MVP (one runtime per
 * user machine).
 */

export interface CronScheduleEntry {
  workflowId: string;
  config: CronTrigger;
  /** Unique key for deregistration; defaults to workflowId. */
  key?: string;
}

export interface CronSchedulerOptions {
  queue: RunQueue;
  /** Override Date.now() — used by tests. */
  now?: () => Date;
  /** Override setTimeout — used by tests. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Override clearTimeout — used by tests. */
  clearTimeoutFn?: (handle: unknown) => void;
}

interface ActiveEntry {
  entry: CronScheduleEntry;
  handle: unknown;
  nextFireAt: number;
}

export class CronScheduler {
  private readonly active = new Map<string, ActiveEntry>();
  private readonly now: () => Date;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly opts: CronSchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  register(entry: CronScheduleEntry): void {
    const key = entry.key ?? entry.workflowId;
    if (this.active.has(key)) {
      throw new Error(`Cron entry with key "${key}" already registered`);
    }
    this.scheduleNext(key, entry);
  }

  unregister(key: string): void {
    const e = this.active.get(key);
    if (!e) return;
    this.clearTimeoutFn(e.handle);
    this.active.delete(key);
  }

  /**
   * Return next-fire timestamps for an introspection API / tests.
   */
  listNextFires(): Array<{ key: string; nextFireAt: number }> {
    return [...this.active.entries()].map(([key, e]) => ({
      key,
      nextFireAt: e.nextFireAt,
    }));
  }

  /**
   * Manually force a scheduled trigger to fire now. Used by tests.
   */
  fireNow(key: string): void {
    const e = this.active.get(key);
    if (!e) throw new Error(`No cron entry for key ${key}`);
    this.fireAndReschedule(key, e.entry);
  }

  shutdown(): void {
    for (const [, e] of this.active) this.clearTimeoutFn(e.handle);
    this.active.clear();
  }

  /**
   * Return the ms delay until the next fire for a given cron expression.
   * Exported for tests.
   */
  nextDelayMs(expression: string, timezone = "UTC"): number {
    const nowMs = this.now().getTime();
    const interval = cronParser.parseExpression(expression, {
      currentDate: new Date(nowMs),
      tz: timezone,
    });
    const next = interval.next();
    const nextMs = next.toDate().getTime();
    return Math.max(0, nextMs - nowMs);
  }

  private scheduleNext(key: string, entry: CronScheduleEntry): void {
    const delay = this.nextDelayMs(entry.config.expression, entry.config.timezone);
    const fireAt = this.now().getTime() + delay;
    const handle = this.setTimeoutFn(() => {
      this.fireAndReschedule(key, entry);
    }, delay);
    this.active.set(key, { entry, handle, nextFireAt: fireAt });
  }

  private fireAndReschedule(key: string, entry: CronScheduleEntry): void {
    const existing = this.active.get(key);
    if (existing) {
      this.clearTimeoutFn(existing.handle);
    }
    try {
      this.opts.queue.enqueue(entry.workflowId, {
        triggeredBy: "cron",
        triggerPayload: { cronExpression: entry.config.expression, firedAt: this.now().toISOString() },
        nowIso: this.now().toISOString(),
      });
    } catch (err) {
      // Surface the error but don't take down the scheduler: a single bad
      // enqueue shouldn't silence every other cron-registered workflow.
      const msg = `[cron] failed to enqueue run for ${key}: ${(err as Error).message}`;
      console.error(msg);
    }
    // Reschedule for the next occurrence.
    this.scheduleNext(key, entry);
  }
}
