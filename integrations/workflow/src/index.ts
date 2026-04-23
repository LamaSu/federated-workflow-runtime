/**
 * @delightfulchorus/integration-workflow
 *
 * Subgraph composition. A node whose `integration` is `"workflow"` invokes
 * another local Chorus workflow as a single memoized step. With this primitive,
 * supervisor / hierarchical / network multi-agent patterns become compositions
 * of chorus parts (no separate scaffolds needed).
 *
 * Node shape (the canonical / spec form):
 *   {
 *     id: "transcribe-then-summarize",
 *     integration: "workflow",
 *     operation: "invoke",
 *     config: {
 *       workflowId: "summarize-text@v2",     // required; resolves via the runtime's workflow registry
 *       inputMapping?: { ... },              // optional: reshape parent input → child trigger payload
 *     },
 *     inputs: { sourceText: "..." }
 *   }
 *
 * Behavior:
 *   1. Resolve `workflowId` (and optional `@version` suffix) via the runtime's
 *      existing workflow loader. The runtime attaches a `runWorkflow` callback
 *      to ctx that handles resolution + dispatch + synchronous wait.
 *   2. Apply the optional `inputMapping` to derive the child's trigger payload
 *      from `{ ...parentInputs, triggerPayload }`. With no mapping, the child
 *      receives the parent's full input payload as its trigger.
 *   3. Synchronously await the child's terminal state (the child uses chorus's
 *      normal Inngest-replay executor — same DB, same dispatch loop).
 *   4. Return the child's terminal output (the output of its terminal node).
 *      The parent's `step.run` for this node memoizes that output — replay
 *      returns cached output without re-invoking the child.
 *
 * Recursive: child workflows can themselves contain `integration: "workflow"`
 * nodes. Each level is its own `step.run` from the level above; the runtime
 * propagates `runWorkflow` through every level.
 *
 * FBP DECISION (per wave-2 brief):
 *   Subgraphs use the EXISTING Inngest-replay executor. Do NOT add FBP runtime
 *   semantics. The fbp adapter encodes ports as `"NODE.PORT"` strings, so
 *   `integration: "workflow"` nodes round-trip to NoFlo for free WITHOUT any
 *   runtime changes. The handler also accepts `workflowId`/`inputMapping` from
 *   `inputs` (i.e. as IIPs) so users who go through the FBP shape don't lose
 *   them — see "Input resolution" below.
 *
 * Memoization invariant:
 *   - Parent's `steps` table: ONE row for the subgraph node, output = the
 *     child's terminal output (JSON-encoded).
 *   - Child has its own `runId` + its own `steps` rows in the same SQLite DB.
 *   - Parent replay: subgraph node returns memoized output without re-creating
 *     the child run.
 *   - Child can be inspected/replayed independently via `chorus run history
 *     <child-runId>`.
 *
 * Input resolution (workflowId + inputMapping):
 *   The handler resolves both fields from EITHER `input` (IIP-style) OR
 *   `config` (spec-style). When both are present, `input` wins. This keeps the
 *   spec form ergonomic (inline config) while preserving FBP round-trippability
 *   (FBP encodes static input as IIPs which materialize as `node.inputs[KEY]`).
 *
 * Chorus contract notes:
 *   - Missing workflowId → IntegrationError (user error — the workflow
 *     definition is malformed).
 *   - Missing runWorkflow on ctx → IntegrationError (wiring bug — the runtime
 *     must attach this).
 *   - Unknown workflowId → IntegrationError (the child workflow isn't
 *     registered in the runtime's DB).
 *   - Child run failure → propagates as IntegrationError with the child
 *     runId attached for forensic inspection.
 */
import {
  IntegrationError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import { z } from "zod";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The shape the runtime attaches to ctx as `runWorkflow` so this handler can
 * spawn + await a child run without depending on runtime internals.
 *
 * The runtime supplies a function that:
 *   1. Looks up the child workflow definition in the workflows table by id
 *      (and optional version), exactly like the dispatcher's tick() does.
 *   2. Mints a fresh runId and creates a `runs` row attributed to that
 *      workflow + version.
 *   3. Calls Executor.run(childWorkflow, runId, triggerPayload) synchronously.
 *      The same Executor instance is reused, so credentials / signal /
 *      integrationLoader / runWorkflow itself ALL propagate to the child.
 *      That recursion is what makes `integration: "workflow"` nodes nestable.
 *   4. Returns { runId, output } where output is the child's terminal output
 *      (the output of its terminal node, or null if the child had no nodes).
 *
 * Reasons to keep this as an opaque callback (vs handing the integration the
 * raw DB + Executor):
 *   - The integration package stays free of runtime imports — depends only
 *     on @delightfulchorus/core types.
 *   - Tests can stub it cleanly (just supply a mock function).
 *   - The runtime is free to add policy (e.g., depth limits, cycle detection)
 *     without leaking implementation back into the integration.
 */
export interface SubgraphRunner {
  (
    workflowId: string,
    triggerPayload: unknown,
    options?: { version?: number },
  ): Promise<SubgraphRunResult>;
}

export interface SubgraphRunResult {
  /** The child run's id (UUID). Queryable via `chorus run history <id>`. */
  runId: string;
  /** Terminal output of the child workflow (last node's output). */
  output: unknown;
}

// ── Schemas ────────────────────────────────────────────────────────────────

/**
 * Input to the `invoke` operation.
 *
 * Both `workflowId` and `inputMapping` are accepted at the top level so they
 * round-trip through the FBP adapter as IIPs. They may also be supplied via
 * `config` (the canonical spec form, see resolveInvocationParams).
 *
 * The `triggerPayload` field is set by the executor when it composes the
 * input — `{ ...node.inputs, triggerPayload }` — and gives the handler access
 * to the parent run's trigger payload for inputMapping resolution.
 */
export const InvokeInputSchema = z
  .object({
    workflowId: z.string().min(1).optional(),
    inputMapping: z.record(z.string(), z.string()).optional(),
    triggerPayload: z.unknown().optional(),
  })
  .passthrough();

export type InvokeInput = z.infer<typeof InvokeInputSchema>;

export const InvokeOutputSchema = z.object({
  /** Whatever the child workflow's terminal node returned, verbatim. */
  output: z.unknown(),
  /** The child run's id — useful for forensic inspection. */
  childRunId: z.string(),
  /** The workflow id that was invoked (resolved from input/config). */
  workflowId: z.string(),
});

export type InvokeOutput = z.infer<typeof InvokeOutputSchema>;

// ── Manifest ───────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "workflow",
  version: "0.1.9",
  description:
    "Subgraph composition — invoke another local Chorus workflow as a single memoized step. Use this to build supervisor / hierarchical / network multi-agent patterns from existing chorus workflows. Recursive: child workflows can themselves be subgraphs.",
  authType: "none",
  credentialTypes: [],
  operations: [
    {
      name: "invoke",
      description:
        "Invoke another workflow by id. Returns the child's terminal output. The whole subgraph runs as one memoized step in the parent — replay returns cached output without re-running the child.",
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          workflowId: {
            type: "string",
            minLength: 1,
            description:
              "Id of the child workflow to invoke (e.g. 'summarize-text' or 'summarize-text@2' for an explicit version). May also be supplied via config.workflowId.",
          },
          inputMapping: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Optional dot-path map: `{ 'child.path': 'parent.path' }`. Reshapes the parent's input into the child's trigger payload. Without a mapping, the child receives the parent input verbatim.",
          },
        },
      },
      outputSchema: {
        type: "object",
        required: ["output", "childRunId", "workflowId"],
        properties: {
          output: {},
          childRunId: { type: "string" },
          workflowId: { type: "string" },
        },
      },
    },
  ],
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pull the SubgraphRunner the runtime attached to ctx. Mandatory — the
 * integration cannot work without it. The wiring bug, if any, is in the
 * runtime / server.ts wiring, not user code.
 */
function extractRunner(ctx: OperationContext): SubgraphRunner {
  const runner = (ctx as OperationContext & {
    runWorkflow?: SubgraphRunner;
  }).runWorkflow;
  if (!runner || typeof runner !== "function") {
    throw new IntegrationError({
      message:
        "workflow.invoke requires ctx.runWorkflow — the executor must attach it. This is a runtime wiring bug, not a user error.",
      integration: "workflow",
      operation: "invoke",
      code: "MISSING_SUBGRAPH_RUNNER",
    });
  }
  return runner;
}

/**
 * Resolve the workflowId + inputMapping from input/config. Input wins; this
 * keeps the spec form (`config.workflowId`) ergonomic AND preserves the FBP
 * IIP form (`inputs.workflowId`) so round-trips are lossless.
 *
 * Also splits an optional `@version` suffix out of the workflowId — `"foo@2"`
 * resolves to `{ id: "foo", version: 2 }`. Bare `"foo"` resolves to
 * `{ id: "foo" }` (latest version).
 */
export function resolveInvocationParams(
  input: InvokeInput,
  config: Record<string, unknown> | undefined,
): {
  workflowId: string;
  version?: number;
  inputMapping?: Record<string, string>;
} {
  const rawId =
    typeof input.workflowId === "string"
      ? input.workflowId
      : typeof config?.["workflowId"] === "string"
        ? (config["workflowId"] as string)
        : undefined;
  if (!rawId || rawId.length === 0) {
    throw new IntegrationError({
      message:
        "workflow.invoke requires `workflowId` (in either node.config or node.inputs). Got neither.",
      integration: "workflow",
      operation: "invoke",
      code: "MISSING_WORKFLOW_ID",
    });
  }

  // Parse the optional `@version` suffix.
  let workflowId = rawId;
  let version: number | undefined;
  const at = rawId.lastIndexOf("@");
  if (at > 0) {
    const tail = rawId.slice(at + 1);
    const n = Number.parseInt(tail, 10);
    if (Number.isInteger(n) && n > 0 && /^\d+$/.test(tail)) {
      workflowId = rawId.slice(0, at);
      version = n;
    }
    // If the suffix isn't a positive integer, leave the id intact — workflow
    // ids may contain '@' legitimately.
  }

  const inputMapping =
    input.inputMapping ??
    (config?.["inputMapping"] as Record<string, string> | undefined);

  return { workflowId, version, inputMapping };
}

/**
 * Apply the inputMapping to derive the child's trigger payload.
 *
 * Each mapping entry is `"<child path>": "<parent path>"`. The child path
 * names where in the child's trigger payload the value lands. The parent
 * path picks the value from the parent's input record (which is
 * `{ ...node.inputs, triggerPayload }`).
 *
 * Path syntax matches the runtime's `parsePath`: dot segments + `[N]` arrays.
 *
 * With no mapping, the child receives the parent's input verbatim — minus
 * the workflowId/inputMapping/triggerPayload housekeeping fields, plus the
 * parent's triggerPayload merged at the top level.
 *
 * Implementation note: we re-implement parsePath/setAtPath inline rather
 * than depending on the runtime package. Two reasons:
 *   1. The integration package's only dependency should be @delightfulchorus/core.
 *   2. The path syntax is dead simple — duplicating it costs ~30 LOC
 *      and avoids a coupling that would force the integration to ship a
 *      new version every time the runtime's pathing helpers change.
 */
export function applyInputMapping(
  parentInput: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
): unknown {
  if (!mapping || Object.keys(mapping).length === 0) {
    // Strip our own bookkeeping fields, return the rest.
    const { workflowId: _wf, inputMapping: _im, ...rest } = parentInput as {
      workflowId?: unknown;
      inputMapping?: unknown;
      [k: string]: unknown;
    };
    void _wf;
    void _im;
    return rest;
  }

  const out: Record<string, unknown> = {};
  for (const [childPath, parentPath] of Object.entries(mapping)) {
    const value = getAtPath(parentInput, parentPath);
    setAtPath(out, childPath, value);
  }
  return out;
}

// ── Path helpers (parsePath/setAtPath/getAtPath, inlined) ──────────────────

interface PathSegment {
  value: string | number;
}

/** Tokenize `"users[0].name"` into `[{value:"users"},{value:0},{value:"name"}]`. */
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(path)) !== null) {
    if (m.index !== consumed && path[consumed] !== ".") {
      throw new IntegrationError({
        message: `workflow.invoke: bad path "${path}" at offset ${consumed}`,
        integration: "workflow",
        operation: "invoke",
        code: "BAD_PATH",
      });
    }
    if (m[1] !== undefined) {
      segments.push({ value: m[1] });
    } else if (m[2] !== undefined) {
      segments.push({ value: Number.parseInt(m[2], 10) });
    }
    consumed = m.index + m[0].length;
    if (path[consumed] === ".") consumed++;
  }
  if (consumed < path.length) {
    throw new IntegrationError({
      message: `workflow.invoke: trailing characters in path "${path}" at offset ${consumed}`,
      integration: "workflow",
      operation: "invoke",
      code: "BAD_PATH",
    });
  }
  return segments;
}

/**
 * Walk a path; return the value or undefined. Never throws on missing keys —
 * the mapping should be tolerant of partial parent inputs.
 */
export function getAtPath(target: unknown, path: string): unknown {
  const segments = parsePath(path);
  let cursor: unknown = target;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof seg.value === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[seg.value];
    } else {
      if (typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[seg.value];
    }
  }
  return cursor;
}

/**
 * In-place set at a dot/bracket path. Creates intermediate objects/arrays
 * as needed. Throws on type-conflicts (e.g. setting "a.b" when a is a string).
 */
export function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = parsePath(path);
  if (segments.length === 0) {
    throw new IntegrationError({
      message: `workflow.invoke: empty path`,
      integration: "workflow",
      operation: "invoke",
      code: "BAD_PATH",
    });
  }
  let cursor: unknown = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1]!;
    cursor = ensureContainer(cursor, seg, typeof next.value === "number");
  }
  const last = segments[segments.length - 1]!;
  if (typeof last.value === "number") {
    if (!Array.isArray(cursor)) {
      throw new IntegrationError({
        message: `workflow.invoke: path "${path}" expects array at terminal segment`,
        integration: "workflow",
        operation: "invoke",
        code: "BAD_PATH",
      });
    }
    cursor[last.value] = value;
  } else {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new IntegrationError({
        message: `workflow.invoke: path "${path}" expects object at terminal segment`,
        integration: "workflow",
        operation: "invoke",
        code: "BAD_PATH",
      });
    }
    (cursor as Record<string, unknown>)[last.value] = value;
  }
}

function ensureContainer(
  parent: unknown,
  segment: PathSegment,
  nextIsArray: boolean,
): unknown {
  if (typeof segment.value === "number") {
    if (!Array.isArray(parent)) {
      throw new IntegrationError({
        message: `workflow.invoke: expected array at index segment [${segment.value}]`,
        integration: "workflow",
        operation: "invoke",
        code: "BAD_PATH",
      });
    }
    let here = parent[segment.value];
    if (here === undefined || here === null) {
      here = nextIsArray ? [] : {};
      parent[segment.value] = here;
    }
    return here;
  }
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
    throw new IntegrationError({
      message: `workflow.invoke: expected object before key "${segment.value}"`,
      integration: "workflow",
      operation: "invoke",
      code: "BAD_PATH",
    });
  }
  const obj = parent as Record<string, unknown>;
  let here = obj[segment.value];
  if (here === undefined || here === null) {
    here = nextIsArray ? [] : {};
    obj[segment.value] = here;
  }
  return here;
}

// ── Handler ────────────────────────────────────────────────────────────────

/**
 * The handler is intentionally thin. The heavy lifting (workflow lookup,
 * runId minting, run dispatch, await) lives behind ctx.runWorkflow. This
 * handler:
 *   1. Resolves the target workflowId (from input or config).
 *   2. Reshapes the trigger payload using the optional inputMapping.
 *   3. Calls ctx.runWorkflow synchronously.
 *   4. Returns the child's terminal output + runId so callers can introspect.
 *
 * The outer step.run wrapper (in the executor) is what gives us the
 * memoization invariant — see this module's docstring.
 *
 * NOTE: We do NOT extract a `step` from ctx here. The whole call to
 * ctx.runWorkflow runs INSIDE the parent's outer step.run for this node;
 * adding our own nested step.run would double-record. The child workflow's
 * own steps live in the child's runId and are queryable separately.
 */
export const invokeOp: OperationHandler<InvokeInput, InvokeOutput> = async (
  input,
  ctx,
) => {
  const parsed = InvokeInputSchema.parse(input);
  const config = (ctx as OperationContext & {
    nodeConfig?: Record<string, unknown>;
  }).nodeConfig;
  const { workflowId, version, inputMapping } = resolveInvocationParams(
    parsed,
    config,
  );

  const childPayload = applyInputMapping(
    parsed as Record<string, unknown>,
    inputMapping,
  );

  const runner = extractRunner(ctx);

  let result: SubgraphRunResult;
  try {
    result = await runner(workflowId, childPayload, version !== undefined ? { version } : undefined);
  } catch (err) {
    const e = err as Error;
    throw new IntegrationError({
      message: `workflow.invoke: child run for "${workflowId}" failed: ${e.message}`,
      integration: "workflow",
      operation: "invoke",
      code: "CHILD_RUN_FAILED",
      cause: err,
    });
  }

  await ctx.snapshot?.record(
    "workflow.invoke.200",
    {
      workflowId,
      version,
      hasInputMapping: inputMapping !== undefined,
    },
    {
      childRunId: result.runId,
    },
  );

  return {
    output: result.output,
    childRunId: result.runId,
    workflowId,
  };
};

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    invoke: invokeOp as OperationHandler,
  },
};

export default integration;
