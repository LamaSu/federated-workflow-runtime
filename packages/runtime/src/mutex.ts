/**
 * Tiny FIFO async mutex.
 *
 * Used by the executor to serialize SQLite write critical sections in
 * `step.run` when those calls are issued in parallel via `step.fanOut`.
 *
 * Why this exists (per Wave 2 brief item 7):
 * `better-sqlite3` is synchronous — individual `.run()` calls cannot
 * interleave at the SQLite layer. But `step.run`'s write critical section
 * (the leading "running" upsert + final "success"/"failed" upsert with the
 * handler's await between them) IS interleavable across N parallel
 * `step.run` invocations from `step.fanOut`. Without serialization, the
 * `steps` table can briefly observe inconsistent rows mid-handler — and a
 * future async-capable DB driver would race. We serialize these critical
 * sections through a single in-process FIFO mutex on the dispatcher's DB
 * connection so the per-step transition (running → success/failed) is
 * atomic from the perspective of any concurrent reader.
 *
 * Crucially: parallel reads + parallel handler invocations remain
 * unrestricted. The mutex only wraps the write moments.
 *
 * Alternative shapes considered and rejected:
 * 1. `BEGIN IMMEDIATE` per write — risks busy-wait stalls under contention.
 * 2. Per-step buffered writer flushed in batches — adds latency for no
 *    benefit at chorus's scale (single-process, single-machine).
 *
 * The mutex is FIFO so cooperating callers get fair ordering. Failures in
 * the held block still release the mutex via `try`/`finally` semantics in
 * `withLock`.
 */
export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  /**
   * Acquire the mutex. Returns a release function that MUST be called
   * exactly once (use `withLock` if you can — it does the cleanup for you).
   */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        // Caller will be the new holder. Mutex stays locked across the
        // microtask transfer.
        resolve(() => this.release());
      });
    });
  }

  /**
   * Run `fn` while holding the mutex. Releases on both success and throw.
   * Preferred over raw `acquire()` because it can't leak the lock.
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the lock straight to the next waiter — never set `locked`
      // back to false in this branch, which would create a window for a
      // newcomer to skip the queue.
      next();
    } else {
      this.locked = false;
    }
  }

  /** Whether the mutex is currently held. Visible for tests. */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Pending waiter count. Visible for tests. */
  get queueDepth(): number {
    return this.waiters.length;
  }
}
