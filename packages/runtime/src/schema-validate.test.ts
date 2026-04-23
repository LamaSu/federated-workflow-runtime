import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  askUserEventType,
  buildAskUserDescriptor,
  isZodSchema,
  parseAskUserDescriptor,
  validateAgainstSchema,
} from "./schema-validate.js";

describe("isZodSchema", () => {
  it("accepts a Zod object", () => {
    expect(isZodSchema(z.object({ a: z.string() }))).toBe(true);
  });

  it("accepts a Zod scalar", () => {
    expect(isZodSchema(z.string())).toBe(true);
  });

  it("rejects a plain JSON-schema-shaped object", () => {
    expect(
      isZodSchema({ type: "object", properties: { a: { type: "string" } } }),
    ).toBe(false);
  });

  it("rejects null/undefined/string/number", () => {
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
    expect(isZodSchema("string")).toBe(false);
    expect(isZodSchema(42)).toBe(false);
  });
});

describe("validateAgainstSchema — Zod path", () => {
  it("accepts a value matching a Zod object", () => {
    const schema = z.object({ size: z.enum(["S", "M", "L"]) });
    const r = validateAgainstSchema(schema, { size: "M" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ size: "M" });
  });

  it("rejects a value mismatching a Zod enum", () => {
    const schema = z.object({ size: z.enum(["S", "M", "L"]) });
    const r = validateAgainstSchema(schema, { size: "XL" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.path).toBe("size");
      expect(r.message).toMatch(/size/);
    }
  });

  it("rejects extra-field violations under z.object().strict()", () => {
    const schema = z.object({ a: z.string() }).strict();
    const r = validateAgainstSchema(schema, { a: "hi", b: "no" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/b/);
  });

  it("accepts Zod refinement passes", () => {
    const schema = z.string().refine((s) => s.startsWith("ok-"), {
      message: "must start with ok-",
    });
    expect(validateAgainstSchema(schema, "ok-1").ok).toBe(true);
    const r = validateAgainstSchema(schema, "no");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ok-/);
  });
});

describe("validateAgainstSchema — JSON-schema-lite path", () => {
  it("accepts an object matching type+properties+required+enum", () => {
    const schema = {
      type: "object" as const,
      properties: { size: { enum: ["S", "M", "L"] as const } },
      required: ["size"] as const,
    };
    expect(validateAgainstSchema(schema, { size: "L" }).ok).toBe(true);
  });

  it("rejects when required is missing", () => {
    const schema = {
      type: "object" as const,
      properties: { size: { type: "string" as const } },
      required: ["size"] as const,
    };
    const r = validateAgainstSchema(schema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.path).toBe("size");
      expect(r.errors[0]?.message).toMatch(/required/i);
    }
  });

  it("rejects on enum mismatch with diagnostic", () => {
    const schema = {
      type: "object" as const,
      properties: { size: { enum: ["S", "M", "L"] as const } },
    };
    const r = validateAgainstSchema(schema, { size: "XL" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/enum/);
  });

  it("rejects on type mismatch", () => {
    const schema = { type: "number" as const };
    const r = validateAgainstSchema(schema, "not a number");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/expected number/);
  });

  it("validates string length and pattern", () => {
    const schema = {
      type: "string" as const,
      minLength: 3,
      maxLength: 8,
      pattern: "^[a-z]+$",
    };
    expect(validateAgainstSchema(schema, "abc").ok).toBe(true);
    expect(validateAgainstSchema(schema, "ab").ok).toBe(false);
    expect(validateAgainstSchema(schema, "abcdefghi").ok).toBe(false);
    expect(validateAgainstSchema(schema, "ABC").ok).toBe(false);
  });

  it("validates numeric bounds", () => {
    const schema = { type: "integer" as const, minimum: 1, maximum: 10 };
    expect(validateAgainstSchema(schema, 5).ok).toBe(true);
    expect(validateAgainstSchema(schema, 0).ok).toBe(false);
    expect(validateAgainstSchema(schema, 11).ok).toBe(false);
    // not an integer
    expect(validateAgainstSchema(schema, 5.5).ok).toBe(false);
  });

  it("rejects additional properties when additionalProperties=false", () => {
    const schema = {
      type: "object" as const,
      properties: { a: { type: "string" as const } },
      additionalProperties: false,
    };
    const r = validateAgainstSchema(schema, { a: "ok", b: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "b")).toBe(true);
  });

  it("validates array items recursively", () => {
    const schema = {
      type: "array" as const,
      items: { type: "string" as const },
    };
    expect(validateAgainstSchema(schema, ["a", "b"]).ok).toBe(true);
    const r = validateAgainstSchema(schema, ["a", 2]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("1");
  });

  it("nested objects: error path is dot-joined", () => {
    const schema = {
      type: "object" as const,
      properties: {
        user: {
          type: "object" as const,
          properties: { name: { type: "string" as const } },
          required: ["name"] as const,
        },
      },
    };
    const r = validateAgainstSchema(schema, { user: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("user.name");
  });

  it("ignores unsupported keywords (oneOf/$ref/format) without erroring", () => {
    const schema = {
      type: "string" as const,
      format: "email",
      oneOf: [{ type: "string" }, { type: "number" }],
    };
    // Value is a valid string — unsupported keywords don't fire.
    expect(validateAgainstSchema(schema, "not-an-email-but-a-string").ok).toBe(true);
  });

  it("accepts via const", () => {
    const schema = { const: "yes" };
    expect(validateAgainstSchema(schema, "yes").ok).toBe(true);
    expect(validateAgainstSchema(schema, "no").ok).toBe(false);
  });
});

describe("buildAskUserDescriptor / parseAskUserDescriptor", () => {
  it("round-trips a JSON-schema descriptor through JSON", () => {
    const schema = {
      type: "object" as const,
      properties: { size: { enum: ["S", "M"] as const } },
    };
    const desc = buildAskUserDescriptor("What size?", schema);
    expect(desc.kind).toBe("askUser");
    expect(desc.prompt).toBe("What size?");
    expect(desc.schema.kind).toBe("json");
    const reparsed = parseAskUserDescriptor(JSON.stringify(desc));
    expect(reparsed).toEqual(desc);
  });

  it("marks Zod schemas as zod-runtime in the descriptor", () => {
    const schema = z.object({ size: z.enum(["S", "M"]) });
    const desc = buildAskUserDescriptor("What size?", schema);
    expect(desc.schema.kind).toBe("zod-runtime");
    const reparsed = parseAskUserDescriptor(JSON.stringify(desc));
    expect(reparsed?.schema.kind).toBe("zod-runtime");
  });

  it("returns null on non-askUser payloads", () => {
    expect(parseAskUserDescriptor(null)).toBeNull();
    expect(parseAskUserDescriptor("not json")).toBeNull();
    expect(parseAskUserDescriptor(JSON.stringify({ foo: 1 }))).toBeNull();
    // matchPayload of a normal waitForEvent
    expect(
      parseAskUserDescriptor(JSON.stringify({ key: "value" })),
    ).toBeNull();
  });
});

describe("askUserEventType", () => {
  it("namespaces by run + step", () => {
    expect(askUserEventType("run-1", "ask-size")).toBe(
      "chorus.askUser:run-1:ask-size",
    );
  });

  it("two different runs get different event types", () => {
    expect(askUserEventType("a", "x")).not.toBe(askUserEventType("b", "x"));
  });
});
