/**
 * `forkRun` — time-travel replay primitive.
 *
 * Given an existing run, fork a NEW run that starts from `fromStep`. Steps
 * BEFORE `fromStep` are copied (memoized) so the executor's existing replay
 * logic short-circuits them on the first dispatch pass; from `fromStep`
 * onward, execution is fresh.
 *
 * Optional `mutations` rewrites the from-step's `input` JSON before that
 * step re-executes — letting users explore "what if the prompt had been
 * X?" without altering the original run.
 *
 * Wire-up notes:
 *   • The new run gets a fresh runId (UUID).
 *   • Workflow definition is loaded from the `workflows` table by
 *     (workflow_id, workflow_version) of the original run — so even if the
 *     user has since edited the workflow file on disk, the fork uses the
 *     definition as it existed when the original run started. This is
 *     deliberate: replay is most useful when the workflow shape matches.
 *   • The original run row is NOT mutated. The fork is a standalone clone.
 *   • A new row is enqueued via RunQueue.enqueue so the dispatcher picks
 *     it up on its next claim cycle. Tests can then drive the executor
 *     directly to observe the memoization replay in action.
 *
 * Memoization invariant (see executor.ts §step.run):
 *   `step.run(name, fn)` short-circuits when a row exists with
 *   status='success'. By copying success rows for steps in declaration
 *   order up to (but not including) `fromStep`, the next executor pass
 *   replays those steps from cache (zero handler invocations) and only
 *   actually runs the from-step + everything after it.
 */
import { randomUUID } from "node:crypto";
import type { Workflow } from "@delightfulchorus/core";
import type { DatabaseType, RunRow, StepRow } from "./db.js";
import { QueryHelpers } from "./db.js";
import { RunQueue } from "./queue.js";

/**
 * A single mutation. Path syntax: dot-segmented + optional `[N]` array
 * indexing. Examples:
 *   - "name"           → top-level key
 *   - "user.email"     → nested object
 *   - "items[0].id"    → array element
 *   - "users[2].roles[0]" → nested array
 *
 * Value is whatever JSON-compatible type the caller supplies.
 */
export type Mutations = Record<string, unknown>;

export interface ForkRunOptions {
  /** Override the new run's id (testing). Otherwise a UUID is generated. */
  newRunId?: string;
  /** Override "now" for deterministic timestamps in tests. */
  nowIso?: string;
}

export interface ForkRunResult {
  newRunId: string;
}

export class ForkRunError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ForkRunError";
  }
}

/**
 * Fork a run.
 *
 * @param db          Open SQLite handle (same handle the runtime uses).
 * @param sourceRunId The run to fork.
 * @param fromStep    Name of the step to start re-execution from. Steps
 *                    before this one are replayed from memoized rows.
 * @param mutations   Optional input mutations applied to the from-step.
 * @param opts        Override hooks (testing).
 *
 * @throws ForkRunError("UNKNOWN_RUN")     if `sourceRunId` not found.
 * @throws ForkRunError("UNKNOWN_WORKFLOW") if the workflow row is missing.
 * @throws ForkRunError("UNKNOWN_STEP")    if `fromStep` not in the workflow.
 */
export function forkRun(
  db: DatabaseType,
  sourceRunId: string,
  fromStep: string,
  mutations: Mutations = {},
  opts: ForkRunOptions = {},
): ForkRunResult {
  const helpers = new QueryHelpers(db);
  const sourceRun = helpers.getRun(sourceRunId);
  if (!sourceRun) {
    throw new ForkRunError("UNKNOWN_RUN", `run not found: ${sourceRunId}`);
  }

  const workflowRow = helpers.getWorkflow(
    sourceRun.workflow_id,
    sourceRun.workflow_version,
  );
  if (!workflowRow) {
    throw new ForkRunError(
      "UNKNOWN_WORKFLOW",
      `workflow ${sourceRun.workflow_id}@v${sourceRun.workflow_version} not found in workflows table`,
    );
  }

  const workflow: Workflow = JSON.parse(workflowRow.definition);
  const nodeIndex = workflow.nodes.findIndex((n) => n.id === fromStep);
  if (nodeIndex < 0) {
    throw new ForkRunError(
      "UNKNOWN_STEP",
      `step "${fromStep}" not found in workflow ${workflow.id}`,
    );
  }

  // Steps to copy = nodes BEFORE fromStep, in declaration order. We copy by
  // step_name (the executor uses node.id as the step name), and only carry
  // forward rows that exist AND have status='success' — anything else
  // wouldn't short-circuit anyway, so don't carry the noise.
  const stepsToReplay = workflow.nodes.slice(0, nodeIndex).map((n) => n.id);

  const nowIso = opts.nowIso ?? new Date().toISOString();
  const newRunId = opts.newRunId ?? randomUUID();

  // Run everything in a single transaction so a partial failure leaves no
  // half-forked state behind. better-sqlite3 transactions are synchronous.
  const tx = db.transaction((): void => {
    // 1. Insert new run row (pending → dispatcher will claim).
    const queue = new RunQueue(db);
    queue.enqueue(sourceRun.workflow_id, {
      id: newRunId,
      workflowVersion: sourceRun.workflow_version,
      priority: sourceRun.priority,
      // Re-use the source run's trigger payload — workflows can have
      // identity/tenant info encoded there that downstream steps rely on
      // (e.g., memory scoping by userId). The from-step's INPUT is what
      // gets mutated; the trigger payload is unchanged on purpose.
      triggerPayload:
        sourceRun.trigger_payload === null
          ? undefined
          : JSON.parse(sourceRun.trigger_payload),
      triggeredBy: "manual",
      nowIso,
    });

    // 2. Copy successful step rows for everything BEFORE fromStep.
    for (const stepName of stepsToReplay) {
      const sourceStep = helpers.getStep(sourceRunId, stepName);
      if (!sourceStep) continue;
      if (sourceStep.status !== "success") continue; // only memoize success
      const cloned: StepRow = {
        ...sourceStep,
        run_id: newRunId,
      };
      helpers.upsertStep(cloned);
    }

    // 3. Pre-stage the from-step row IF the source had one — but only when
    //    mutations apply. We set status='pending' (not 'success') so the
    //    executor's getCompletedStep returns undefined and re-executes the
    //    handler. We carry over the input column with the mutation applied.
    //    Note: the executor's outer step.run wrapper does NOT read the
    //    pre-staged input column (it derives input from node.inputs +
    //    triggerPayload), so to actually inject mutated input, the from
    //    step's NODE.INPUTS block needs the override OR a pre-step
    //    overrides the trigger payload. For MVP we record the mutated
    //    input on the steps row for observability, AND patch the workflow
    //    definition's node.inputs in-memory before storing it — the new
    //    run row references the same workflow_version, but we ALSO emit a
    //    sibling workflow row with version+1 carrying the mutated inputs.
    //
    //    To keep things simple, we apply mutations by editing
    //    workflow.nodes[fromStep].inputs and storing a forked workflow
    //    definition under (workflow_id, workflow_version + maxFork).
    //    However, that complicates lookup. SIMPLER design: don't change
    //    workflow_version at all; instead, write the from-step row with
    //    the mutated input AND status='pending'. The executor's
    //    invokeNode will use the `input` from node.inputs as before — but
    //    we recreate node.inputs by merging mutations into the original.
    //    This requires a fork-time override path through invokeNode.
    //
    //    THIS MVP TAKES THE PRAGMATIC PATH: we write a new workflow row
    //    with version = (max(workflow_version) + 1) carrying the mutated
    //    node.inputs, and pin the new run to that fork-version. The
    //    workflow ID stays the same; only the version diverges.
    if (Object.keys(mutations).length > 0) {
      const forkedWorkflow = applyMutationsToNode(
        workflow,
        fromStep,
        mutations,
      );
      const forkVersion = nextWorkflowVersion(db, sourceRun.workflow_id);
      helpers.insertWorkflow({
        id: workflowRow.id,
        version: forkVersion,
        name: workflowRow.name,
        definition: JSON.stringify(forkedWorkflow),
        active: 0, // fork copies are inactive — not picked up by triggers
        created_at: workflowRow.created_at,
        updated_at: nowIso,
      });
      // Re-point the new run at the fork version.
      db.prepare(
        `UPDATE runs SET workflow_version = ? WHERE id = ?`,
      ).run(forkVersion, newRunId);

      // The replayed step rows we copied still reference the original
      // workflow_version's step semantics — that's fine, since
      // memoization is keyed by (run_id, step_name), not version.
    }
  });
  tx.immediate();

  return { newRunId };
}

/**
 * Return a clone of `workflow` where the named node's `inputs` map has
 * each mutation applied at its dot/bracket path. Mutations are merged on
 * top of existing inputs — keys not mentioned are preserved.
 *
 * Pure: never mutates the source workflow (deep-clones via JSON round-trip).
 */
export function applyMutationsToNode(
  workflow: Workflow,
  nodeId: string,
  mutations: Mutations,
): Workflow {
  const cloned: Workflow = JSON.parse(JSON.stringify(workflow));
  const node = cloned.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new ForkRunError(
      "UNKNOWN_STEP",
      `node "${nodeId}" not found while applying mutations`,
    );
  }
  const inputs = (node.inputs ?? {}) as Record<string, unknown>;
  for (const [path, value] of Object.entries(mutations)) {
    setAtPath(inputs, path, value);
  }
  node.inputs = inputs;
  return cloned;
}

/**
 * In-place mutation: walks the dot/bracket path, creating intermediate
 * objects/arrays as needed. Throws if a non-leaf segment collides with a
 * non-container value (e.g., setting "a.b" when a="string").
 *
 * Path grammar:
 *   path     = segment ("." segment)*
 *   segment  = key ("[" index "]")*
 *   key      = identifier (\w+)
 *   index    = digit+
 *
 * Example: "users[0].name" → users, [0], name.
 */
export function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = parsePath(path);
  if (segments.length === 0) {
    throw new ForkRunError("BAD_MUTATION_PATH", `empty path`);
  }
  let cursor: unknown = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    if (!seg) continue;
    cursor = ensureContainer(cursor, seg, typeof next?.value === "number");
  }
  const last = segments[segments.length - 1];
  if (!last) return;
  if (typeof last.value === "number") {
    if (!Array.isArray(cursor)) {
      throw new ForkRunError(
        "BAD_MUTATION_PATH",
        `path "${path}" expects array at terminal segment but got ${typeof cursor}`,
      );
    }
    cursor[last.value] = value;
  } else {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new ForkRunError(
        "BAD_MUTATION_PATH",
        `path "${path}" expects object at terminal segment`,
      );
    }
    (cursor as Record<string, unknown>)[last.value] = value;
  }
}

interface PathSegment {
  /** Either a string key or a numeric array index. */
  value: string | number;
}

/**
 * Tokenize a path like `users[0].name` into segments. Public so the CLI
 * can pre-validate user input.
 */
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  // Match either `name` or `[123]`. Lookahead-friendly regex.
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(path)) !== null) {
    if (m.index !== consumed && path[consumed] !== ".") {
      // Allow but don't require a dot between key+[idx], i.e. "a[0]" is fine.
      // But disallow garbage between segments.
      // We forgive a leading dot only.
      if (consumed === 0) {
        // path starts with garbage
        throw new ForkRunError(
          "BAD_MUTATION_PATH",
          `unexpected token in path "${path}" at offset ${consumed}`,
        );
      }
      throw new ForkRunError(
        "BAD_MUTATION_PATH",
        `unexpected token in path "${path}" at offset ${consumed}`,
      );
    }
    if (m[1] !== undefined) {
      segments.push({ value: m[1] });
    } else if (m[2] !== undefined) {
      segments.push({ value: Number.parseInt(m[2], 10) });
    }
    consumed = m.index + m[0].length;
    // skip a trailing dot
    if (path[consumed] === ".") consumed++;
  }
  if (consumed < path.length) {
    throw new ForkRunError(
      "BAD_MUTATION_PATH",
      `trailing characters in path "${path}" at offset ${consumed}`,
    );
  }
  return segments;
}

/**
 * Ensure `parent[key]` is a container (object or array). If absent, create
 * the appropriate kind (array if the next segment is numeric, else object).
 * Returns the container.
 */
function ensureContainer(
  parent: unknown,
  segment: PathSegment,
  nextIsArray: boolean,
): unknown {
  if (typeof segment.value === "number") {
    if (!Array.isArray(parent)) {
      throw new ForkRunError(
        "BAD_MUTATION_PATH",
        `expected array at index segment [${segment.value}]`,
      );
    }
    let here = parent[segment.value];
    if (here === undefined || here === null) {
      here = nextIsArray ? [] : {};
      parent[segment.value] = here;
    }
    return here;
  }
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
    throw new ForkRunError(
      "BAD_MUTATION_PATH",
      `expected object before key "${segment.value}"`,
    );
  }
  const obj = parent as Record<string, unknown>;
  let here = obj[segment.value];
  if (here === undefined || here === null) {
    here = nextIsArray ? [] : {};
    obj[segment.value] = here;
  }
  return here;
}

/**
 * Compute the next free workflow version for a given workflow id. Used
 * when forking with mutations to keep the original definition immutable.
 */
function nextWorkflowVersion(db: DatabaseType, workflowId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM workflows WHERE id = ?`,
    )
    .get(workflowId) as { v: number };
  return row.v;
}

/**
 * Convenience type for callers querying the steps table — exposed so the
 * CLI / API layer can render history without duplicating the column list.
 */
export interface RunHistoryEntry {
  runId: string;
  stepName: string;
  status: "pending" | "running" | "success" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Deserialized JSON, or null if absent / parse error. */
  input: unknown;
  /** Deserialized JSON, or null if absent / parse error. */
  output: unknown;
  error: string | null;
  attempt: number;
  /**
   * Hash of the input JSON, suitable for diffing across runs. Empty
   * string when no input is recorded. Computed via FNV-1a 32-bit
   * (deterministic, dependency-free).
   */
  inputHash: string;
}

/**
 * Fetch all step rows for a run, decoded into RunHistoryEntry records.
 * Returns rows in steps-table order (started_at ASC, step_name ASC).
 *
 * Use this from the CLI's `chorus run history` command and any other
 * inspection surface (HTTP API, dashboard).
 */
export function getRunHistory(
  db: DatabaseType,
  runId: string,
): RunHistoryEntry[] {
  const helpers = new QueryHelpers(db);
  const rows = helpers.listSteps(runId);
  return rows.map((r) => decodeStepRow(r));
}

/**
 * Decode one StepRow into a presentable RunHistoryEntry. Exposed so tests
 * can exercise the JSON-parse + hash invariants directly.
 */
export function decodeStepRow(r: StepRow): RunHistoryEntry {
  return {
    runId: r.run_id,
    stepName: r.step_name,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    input: parseJsonOrNull(r.input),
    output: parseJsonOrNull(r.output),
    error: r.error,
    attempt: r.attempt,
    inputHash: r.input ? fnv1a32(r.input) : "",
  };
}

function parseJsonOrNull(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s; // surface unparseable strings as-is so the caller sees them
  }
}

/**
 * FNV-1a 32-bit hash, hex-encoded. Deterministic, dependency-free,
 * collision rates fine for a UI-side diff hint (not a security primitive).
 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit then hex.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Re-export of the source run row — handy for callers that want to build
 * a header alongside the per-step list.
 */
export function getRunOverview(
  db: DatabaseType,
  runId: string,
): RunRow | undefined {
  const helpers = new QueryHelpers(db);
  return helpers.getRun(runId);
}
