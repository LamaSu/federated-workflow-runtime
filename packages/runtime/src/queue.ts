import { randomUUID } from "node:crypto";
import type { DatabaseType, RunRow, RunStatus } from "./db.js";
import { QueryHelpers } from "./db.js";

/**
 * In-process run queue backed by the SQLite `runs` table.
 *
 * Per docs/ARCHITECTURE.md §4.1 we:
 *  - claim the oldest pending run inside a `BEGIN IMMEDIATE` transaction,
 *  - prefer higher priority (greater integer => earlier),
 *  - honor a visibility timeout so crashed workers' runs become eligible again.
 *
 * Single-node MVP. Concurrent consumers are safe because SQLite serializes
 * writers via the immediate transaction.
 */

export interface EnqueueOptions {
  id?: string;
  workflowVersion?: number;
  priority?: number;
  triggerPayload?: unknown;
  triggeredBy?: "webhook" | "cron" | "manual";
  /** Defer visibility until this ISO time. Useful for scheduled/sleep runs. */
  nextWakeup?: string;
  /** Override the default "started_at" timestamp. */
  nowIso?: string;
}

export interface ClaimOptions {
  /** How long (ms) the claimed run is hidden from other consumers. */
  visibilityMs?: number;
  /** Override the "now" used for visibility calculations. */
  nowIso?: string;
}

export const DEFAULT_VISIBILITY_MS = 60_000;

export class RunQueue {
  private readonly helpers: QueryHelpers;

  constructor(private readonly db: DatabaseType) {
    this.helpers = new QueryHelpers(db);
  }

  /**
   * Enqueue a new run. Returns the generated run ID.
   */
  enqueue(workflowId: string, opts: EnqueueOptions = {}): string {
    const id = opts.id ?? randomUUID();
    const now = opts.nowIso ?? new Date().toISOString();
    const row: RunRow = {
      id,
      workflow_id: workflowId,
      workflow_version: opts.workflowVersion ?? 1,
      status: "pending",
      triggered_by: opts.triggeredBy ?? "manual",
      trigger_payload: opts.triggerPayload === undefined ? null : JSON.stringify(opts.triggerPayload),
      priority: opts.priority ?? 0,
      next_wakeup: opts.nextWakeup ?? null,
      visibility_until: null,
      started_at: now,
      finished_at: null,
      error: null,
      attempt: 1,
    };
    this.helpers.insertRun(row);
    return id;
  }

  /**
   * Claim the next eligible run atomically. Returns the claimed row (now
   * status='running' with a fresh visibility_until) or `null` if the queue
   * is empty.
   *
   * Eligibility rules:
   *   - status = 'pending', OR
   *   - status = 'running' AND visibility_until <= now (stale/crashed worker)
   *   - next_wakeup IS NULL OR next_wakeup <= now
   */
  claim(opts: ClaimOptions = {}): RunRow | null {
    const now = opts.nowIso ?? new Date().toISOString();
    const vMs = opts.visibilityMs ?? DEFAULT_VISIBILITY_MS;
    const visibilityUntil = new Date(Date.parse(now) + vMs).toISOString();

    const txn = this.db.transaction((): RunRow | null => {
      const row = this.db
        .prepare<
          [string, string, string],
          RunRow
        >(
          `SELECT * FROM runs
            WHERE (status = 'pending' OR (status = 'running' AND visibility_until IS NOT NULL AND visibility_until <= ?))
              AND (next_wakeup IS NULL OR next_wakeup <= ?)
            ORDER BY priority DESC, started_at ASC
            LIMIT 1`,
        )
        .get(now, now);
      if (!row) return null;

      this.db
        .prepare(
          `UPDATE runs
              SET status = 'running',
                  visibility_until = ?,
                  attempt = CASE WHEN status = 'running' THEN attempt + 1 ELSE attempt END
            WHERE id = ?`,
        )
        .run(visibilityUntil, row.id);

      // Re-fetch so returned row reflects the mutation.
      return this.helpers.getRun(row.id) ?? null;
    });

    // better-sqlite3 typed "transaction" returns the inner fn's return.
    return txn.immediate() as RunRow | null;
  }

  /**
   * Extend the visibility lease on a claimed run. Call periodically during
   * long-running execution so the queue doesn't re-assign it.
   */
  heartbeat(runId: string, opts: ClaimOptions = {}): void {
    const now = opts.nowIso ?? new Date().toISOString();
    const vMs = opts.visibilityMs ?? DEFAULT_VISIBILITY_MS;
    const visibilityUntil = new Date(Date.parse(now) + vMs).toISOString();
    this.db
      .prepare(`UPDATE runs SET visibility_until = ? WHERE id = ? AND status = 'running'`)
      .run(visibilityUntil, runId);
  }

  /**
   * Mark a run as complete. `status` is typically 'success' or 'failed'.
   */
  complete(
    runId: string,
    status: Exclude<RunStatus, "pending" | "running">,
    opts: { error?: string | null; nowIso?: string } = {},
  ): void {
    const now = opts.nowIso ?? new Date().toISOString();
    this.helpers.updateRunStatus(runId, status, {
      finished_at: now,
      error: opts.error ?? null,
      visibility_until: null,
    });
  }

  /**
   * Release a run back to the queue (e.g., after a recoverable error).
   * Clears visibility and optionally defers the next attempt.
   */
  release(runId: string, opts: { nextWakeup?: string } = {}): void {
    this.helpers.updateRunStatus(runId, "pending", {
      visibility_until: null,
      next_wakeup: opts.nextWakeup ?? null,
    });
  }

  /**
   * Depth of the pending queue (for tests / /health).
   */
  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM runs WHERE status = 'pending'`)
      .get() as { c: number };
    return row.c;
  }
}
