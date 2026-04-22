/**
 * `Connection.when?` evaluator — a sandboxed jexl wrapper used by the
 * executor's edge-traversal loop.
 *
 * Why jexl? We want conditional routing (`when: "result.status == 'ok'"`)
 * without exposing arbitrary JavaScript evaluation. Jexl is a tiny
 * (~20KB) sandboxed expression language: it cannot call functions the
 * caller hasn't explicitly registered, cannot reach globals, and cannot
 * mutate its context. See https://github.com/TomFrost/jexl.
 *
 * Design constraints (per Task 4 spec):
 *   • Keep the transform surface minimal — only `length`, `keys`,
 *     `values`, `includes`, and basic arithmetic. No extension hooks
 *     for operators beyond what jexl ships with out-of-the-box.
 *   • Fail closed: a parse error, a thrown error inside evaluation, or
 *     any non-boolean-coercible result is treated as FALSE. The edge
 *     is skipped, we log a warning, and the run continues.
 *   • No I/O, no async function calls inside the expression. Pure
 *     evaluation over the injected context.
 */

// jexl has no TypeScript types; declare a minimal structural shape for
// the subset we use. The default export is a pre-constructed Jexl
// instance; we attach transforms once at module load.
//
// NOTE: jexl is a CommonJS module (module.exports = new Jexl()). Under
// TypeScript with `esModuleInterop` (check tsconfig) we import it as a
// default import. If esModuleInterop is off, this file falls back to
// `* as jexl` because the runtime object is still the Jexl instance.
import jexlDefault from "jexl";

interface JexlLike {
  eval(expr: string, context: unknown): Promise<unknown>;
  addTransform(name: string, fn: (...args: unknown[]) => unknown): void;
}

// Resolve the runtime jexl instance in a way that works whether the
// import arrived via default-export interop or namespace interop.
const jexl: JexlLike = (jexlDefault as unknown as JexlLike) ??
  (jexlDefault as { default?: JexlLike }).default!;

/**
 * Context passed into every `when?` evaluation.
 *
 * - `result`  — the OUTPUT of the source node (the edge's `from` node)
 * - `input`   — the run's triggerPayload (what kicked off the run)
 * - `nodeId`  — the source node's id (useful for logging/diagnostics)
 */
export interface WhenContext {
  result: unknown;
  input: unknown;
  nodeId: string;
}

/**
 * Minimal logger contract — we warn on malformed/erroring expressions
 * but do NOT crash the run. Callers pass in a real Logger; tests pass
 * a stub or omit and we fall through to a no-op.
 */
export interface WhenLogger {
  warn(msg: string): void;
}

const NOOP_LOGGER: WhenLogger = { warn: () => {} };

let transformsRegistered = false;

/**
 * Register a minimal, safe transform set on the shared jexl instance.
 * Idempotent — safe to call multiple times.
 *
 * Transforms are invoked as `expr | transform(arg?)` in jexl syntax:
 *   "result.items | length"       → length of array/string
 *   "result | keys"               → array of object keys
 *   "result | values"             → array of object values
 *   "result.tags | includes('x')" → boolean membership
 */
function ensureTransforms(): void {
  if (transformsRegistered) return;
  transformsRegistered = true;

  jexl.addTransform("length", (val: unknown): number => {
    if (val == null) return 0;
    if (Array.isArray(val)) return val.length;
    if (typeof val === "string") return val.length;
    if (typeof val === "object") return Object.keys(val as object).length;
    return 0;
  });

  jexl.addTransform("keys", (val: unknown): string[] => {
    if (val == null || typeof val !== "object") return [];
    return Object.keys(val as object);
  });

  jexl.addTransform("values", (val: unknown): unknown[] => {
    if (val == null || typeof val !== "object") return [];
    return Object.values(val as object);
  });

  jexl.addTransform("includes", (val: unknown, needle: unknown): boolean => {
    if (val == null) return false;
    if (Array.isArray(val)) return val.includes(needle as never);
    if (typeof val === "string") {
      if (typeof needle !== "string") return false;
      return val.includes(needle);
    }
    return false;
  });
}

/**
 * Evaluate a `when?` expression. Returns a boolean:
 *   • true  → take the edge (include the target node)
 *   • false → skip the edge
 *
 * Any error (parse, runtime, type coercion) yields FALSE and emits a
 * single warning. This is the "fail closed" contract — we never let a
 * bad expression silently take an edge it shouldn't.
 */
export async function evalWhen(
  expr: string,
  ctx: WhenContext,
  logger: WhenLogger = NOOP_LOGGER,
): Promise<boolean> {
  ensureTransforms();

  // Guard against the common "empty string" edge-case that Zod's
  // .optional() won't catch — treat as "no condition" → take edge.
  if (!expr || expr.trim().length === 0) return true;

  try {
    const raw = await jexl.eval(expr, ctx as unknown as Record<string, unknown>);
    // Jexl returns whatever the expression yields — coerce explicitly
    // so integrations don't get surprised by truthy-but-not-true values.
    return Boolean(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `when-eval: expression "${expr}" threw ${msg} — treating as false (edge skipped)`,
    );
    return false;
  }
}
