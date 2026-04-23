import { z } from "zod";

/**
 * Schema validation for `step.askUser` payloads.
 *
 * The author hands us either a Zod type or a plain JSON-schema-shaped
 * object. We need three things:
 *
 *   1. Detect which one it is (Zod vs plain object).
 *   2. Validate an arbitrary `value` against it.
 *   3. Serialize the schema for durable storage in the waiting_steps row,
 *      so a process restart that resumes the run can re-validate the
 *      same way.
 *
 * Zod schemas are NOT JSON-serializable; for restart durability the
 * runtime stores a *descriptor* — either a marker that the original
 * schema lives in the in-process closure (`{ kind: "zod-runtime" }`) plus
 * the JSON-schema export of it (best-effort), or the original plain
 * JSON-schema object (`{ kind: "json", schema: {...} }`).
 *
 * Why not just require ajv? Three reasons:
 *   - Adding a runtime dep widens the supply-chain footprint and triggers
 *     a vet pass we don't need yet.
 *   - The HITL prompt schemas users actually write are tiny (size enums,
 *     yes/no, free-text + pattern, small objects). The covered subset of
 *     JSON Schema below is sufficient.
 *   - Zod is already a chorus dep and the typical author uses it.
 *
 * If a schema field that JsonSchemaLite doesn't support shows up
 * (`oneOf`, `$ref`, `format`), we fall through and accept the value
 * — see "Unsupported keywords" below.
 */

// ── Public types ────────────────────────────────────────────────────────────

/**
 * The plain-object subset of JSON Schema we evaluate. Authors may pass
 * any superset; unknown keywords are ignored.
 */
export interface JsonSchemaLite {
  type?:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "object"
    | "array"
    | "null";
  enum?: ReadonlyArray<unknown>;
  const?: unknown;
  properties?: Record<string, JsonSchemaLite>;
  required?: ReadonlyArray<string>;
  additionalProperties?: boolean | JsonSchemaLite;
  items?: JsonSchemaLite;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  pattern?: string;
  // Allow arbitrary extra keywords without type-narrowing pain.
  [k: string]: unknown;
}

/** What `step.askUser`'s schema parameter accepts. */
export type AskUserSchema = z.ZodType<unknown> | JsonSchemaLite;

/** Result of a successful validation: the parsed/normalized value. */
export interface ValidateOk {
  ok: true;
  value: unknown;
}

/** Result of a failed validation: a 1-line message + a path-prefixed list. */
export interface ValidateErr {
  ok: false;
  message: string;
  errors: ReadonlyArray<{ path: string; message: string }>;
}

export type ValidateResult = ValidateOk | ValidateErr;

/**
 * Durable descriptor — what we persist into `waiting_steps.match_payload`.
 *
 *   - "json"        : the original schema is plain JSON, persist verbatim.
 *   - "zod-runtime" : a Zod type was passed; the resumed validation needs
 *                     the in-process Zod schema. The descriptor is a flag
 *                     so the resume path can re-fetch the schema from the
 *                     handler's call site (which it does on every replay
 *                     anyway, since handlers re-execute up to the
 *                     parking step).
 *
 * `prompt` is always carried for downstream UI consumers.
 */
export interface AskUserDescriptor {
  kind: "askUser";
  prompt: string;
  schema:
    | { kind: "json"; value: JsonSchemaLite }
    | { kind: "zod-runtime" };
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * True iff `s` is a Zod type. We test for the presence of `_def` and a
 * `safeParse` method — Zod's structural marker — instead of relying on
 * `instanceof ZodType` because Zod re-exports may produce different
 * constructor identities across bundling boundaries.
 */
export function isZodSchema(s: unknown): s is z.ZodType<unknown> {
  if (s === null || typeof s !== "object") return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj["safeParse"] === "function" &&
    typeof obj["parse"] === "function" &&
    "_def" in obj
  );
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate `value` against `schema`. Branches on the schema's shape (Zod
 * vs JSON-schema-lite). Always returns a ValidateResult — never throws.
 */
export function validateAgainstSchema(
  schema: AskUserSchema,
  value: unknown,
): ValidateResult {
  if (isZodSchema(schema)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.length === 0 ? "" : i.path.join("."),
      message: i.message,
    }));
    return {
      ok: false,
      message: issues
        .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
        .join("; "),
      errors: issues,
    };
  }
  // JSON-schema-lite path.
  const errors: Array<{ path: string; message: string }> = [];
  validateJsonSchemaLite(schema as JsonSchemaLite, value, "", errors);
  if (errors.length === 0) return { ok: true, value };
  return {
    ok: false,
    message: errors
      .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
      .join("; "),
    errors,
  };
}

function validateJsonSchemaLite(
  schema: JsonSchemaLite,
  value: unknown,
  path: string,
  errors: Array<{ path: string; message: string }>,
): void {
  // 1. const
  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, value)) {
      errors.push({
        path,
        message: `expected const ${JSON.stringify(schema.const)}, got ${stringifyForErr(value)}`,
      });
      return;
    }
  }

  // 2. enum
  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push({
        path,
        message: `not in enum (${schema.enum.map((e) => JSON.stringify(e)).join(", ")})`,
      });
      return;
    }
  }

  // 3. type
  if (schema.type !== undefined) {
    if (!matchesType(schema.type, value)) {
      errors.push({
        path,
        message: `expected ${schema.type}, got ${jsType(value)}`,
      });
      return;
    }
  }

  // 4. type-specific constraints
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({
        path,
        message: `string shorter than minLength=${schema.minLength}`,
      });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `string longer than maxLength=${schema.maxLength}`,
      });
    }
    if (typeof schema.pattern === "string") {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push({
            path,
            message: `does not match pattern /${schema.pattern}/`,
          });
        }
      } catch {
        // Bad regex in the schema — surface as a distinct error so the
        // author notices rather than getting silent acceptance.
        errors.push({
          path,
          message: `schema pattern is not a valid regex: ${schema.pattern}`,
        });
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `< minimum=${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `> maximum=${schema.maximum}` });
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push({
        path,
        message: `<= exclusiveMinimum=${schema.exclusiveMinimum}`,
      });
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      errors.push({
        path,
        message: `>= exclusiveMaximum=${schema.exclusiveMaximum}`,
      });
    }
  }
  if (
    schema.type === "object" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    // required
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!(k in obj)) {
          errors.push({
            path: childPath(path, k),
            message: "missing required",
          });
        }
      }
    }
    // properties — recurse for each declared
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in obj) {
          validateJsonSchemaLite(sub, obj[k], childPath(path, k), errors);
        }
      }
    }
    // additionalProperties: false
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) {
          errors.push({
            path: childPath(path, k),
            message: "additional property not permitted",
          });
        }
      }
    }
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.items) {
      const itemSchema = schema.items;
      value.forEach((it, i) =>
        validateJsonSchemaLite(itemSchema, it, childPath(path, String(i)), errors),
      );
    }
  }
}

function matchesType(
  t: NonNullable<JsonSchemaLite["type"]>,
  v: unknown,
): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && !Number.isNaN(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
  }
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      const arr = a as unknown[];
      const arrB = b as unknown[];
      if (arr.length !== arrB.length) return false;
      return arr.every((x, i) => deepEqual(x, arrB[i]));
    }
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keysA = Object.keys(oa);
    const keysB = Object.keys(ob);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => deepEqual(oa[k], ob[k]));
  }
  return false;
}

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function stringifyForErr(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return String(v);
  }
}

// ── Descriptor build / parse (round-trip via SQLite) ────────────────────────

/**
 * Build the descriptor we persist into `waiting_steps.match_payload`.
 * Caller is responsible for serializing to JSON.
 *
 * For Zod schemas we only write the marker — the active validation on
 * resume uses the schema the handler passes when it re-executes (which
 * is the same closure that suspended the first time, since we are
 * Inngest-style replay).
 */
export function buildAskUserDescriptor(
  prompt: string,
  schema: AskUserSchema,
): AskUserDescriptor {
  if (isZodSchema(schema)) {
    return { kind: "askUser", prompt, schema: { kind: "zod-runtime" } };
  }
  return {
    kind: "askUser",
    prompt,
    schema: { kind: "json", value: schema as JsonSchemaLite },
  };
}

/**
 * Parse a descriptor stored in `waiting_steps.match_payload`. Returns
 * `null` if the stored payload is not an askUser descriptor (e.g. it's
 * a normal waitForEvent filter).
 */
export function parseAskUserDescriptor(
  raw: string | null,
): AskUserDescriptor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>)["kind"] !== "askUser"
  ) {
    return null;
  }
  return parsed as AskUserDescriptor;
}

/**
 * Synthetic event type used by the askUser machinery. Per-(run, step) so
 * one user's answer to step "size" doesn't accidentally resolve another
 * run's identical-named ask.
 */
export function askUserEventType(runId: string, stepName: string): string {
  return `chorus.askUser:${runId}:${stepName}`;
}
