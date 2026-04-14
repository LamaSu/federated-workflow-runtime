import type { RunQueue } from "../queue.js";

/**
 * Manual trigger per ARCHITECTURE §4.2.
 *
 * Thin wrapper that enqueues a run for a workflow. The CLI (and any
 * programmatic caller) go through this so the trigger-id is recorded as
 * `manual` consistently.
 */

export interface ManualTriggerOptions {
  workflowVersion?: number;
  payload?: unknown;
  priority?: number;
  nowIso?: string;
}

export class ManualTrigger {
  constructor(private readonly queue: RunQueue) {}

  /**
   * Enqueue a run for the given workflow id. Returns the run id.
   */
  fire(workflowId: string, opts: ManualTriggerOptions = {}): string {
    return this.queue.enqueue(workflowId, {
      triggeredBy: "manual",
      workflowVersion: opts.workflowVersion,
      triggerPayload: opts.payload,
      priority: opts.priority,
      nowIso: opts.nowIso,
    });
  }
}

/**
 * Convenience function — used by tests and the CLI.
 */
export function triggerManually(
  queue: RunQueue,
  workflowId: string,
  payload?: unknown,
  opts: Omit<ManualTriggerOptions, "payload"> = {},
): string {
  return new ManualTrigger(queue).fire(workflowId, { ...opts, payload });
}
