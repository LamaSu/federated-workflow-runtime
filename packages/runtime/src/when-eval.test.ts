import { describe, expect, it, vi } from "vitest";
import { evalWhen } from "./when-eval.js";

describe("evalWhen — basic comparisons", () => {
  it("evaluates equality on a simple result field", async () => {
    const ok = await evalWhen("result.status == 'ok'", {
      result: { status: "ok" },
      input: {},
      nodeId: "n1",
    });
    expect(ok).toBe(true);

    const fail = await evalWhen("result.status == 'ok'", {
      result: { status: "fail" },
      input: {},
      nodeId: "n1",
    });
    expect(fail).toBe(false);
  });

  it("handles arithmetic and relational operators", async () => {
    const yes = await evalWhen("result.count > 3", {
      result: { count: 5 },
      input: {},
      nodeId: "n1",
    });
    expect(yes).toBe(true);

    const no = await evalWhen("result.count > 3", {
      result: { count: 2 },
      input: {},
      nodeId: "n1",
    });
    expect(no).toBe(false);
  });

  it("boolean AND / OR short-circuits correctly", async () => {
    const both = await evalWhen("result.a && result.b", {
      result: { a: true, b: true },
      input: {},
      nodeId: "n1",
    });
    expect(both).toBe(true);

    const either = await evalWhen("result.a || result.b", {
      result: { a: false, b: true },
      input: {},
      nodeId: "n1",
    });
    expect(either).toBe(true);
  });

  it("reads from `input` (trigger payload) as well as `result`", async () => {
    const ok = await evalWhen("input.userId == 'u-123'", {
      result: {},
      input: { userId: "u-123" },
      nodeId: "n1",
    });
    expect(ok).toBe(true);
  });
});

describe("evalWhen — sandboxed transforms", () => {
  it("length transform: arrays, strings, objects", async () => {
    const arr = await evalWhen("result.items | length > 0", {
      result: { items: [1, 2, 3] },
      input: {},
      nodeId: "n1",
    });
    expect(arr).toBe(true);

    const empty = await evalWhen("result.items | length > 0", {
      result: { items: [] },
      input: {},
      nodeId: "n1",
    });
    expect(empty).toBe(false);

    const str = await evalWhen("result.name | length == 5", {
      result: { name: "hello" },
      input: {},
      nodeId: "n1",
    });
    expect(str).toBe(true);
  });

  it("includes transform: array membership", async () => {
    const hit = await evalWhen("result.tags | includes('urgent')", {
      result: { tags: ["urgent", "followup"] },
      input: {},
      nodeId: "n1",
    });
    expect(hit).toBe(true);

    const miss = await evalWhen("result.tags | includes('other')", {
      result: { tags: ["urgent"] },
      input: {},
      nodeId: "n1",
    });
    expect(miss).toBe(false);
  });

  it("keys transform: returns object keys", async () => {
    const has = await evalWhen("result | keys | length == 2", {
      result: { a: 1, b: 2 },
      input: {},
      nodeId: "n1",
    });
    expect(has).toBe(true);
  });
});

describe("evalWhen — fail-closed behavior (malformed or erroring expressions)", () => {
  it("returns false and warns on parse error", async () => {
    const warn = vi.fn();
    const ok = await evalWhen("this is not a jexl expr {{{{", {
      result: {},
      input: {},
      nodeId: "n1",
    }, { warn });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/when-eval/);
  });

  it("returns false on accessing a property of null/undefined", async () => {
    // Jexl drills into undefined safely, but comparison still works.
    // The more pernicious case is calling a transform on null and then
    // comparing to a non-zero value — should not take the edge.
    const ok = await evalWhen("result.missing.field == 'x'", {
      result: {},
      input: {},
      nodeId: "n1",
    });
    expect(ok).toBe(false);
  });

  it("returns false when expression yields a non-boolean-coercible-truthy value", async () => {
    // Empty string coerces to false, number 0 coerces to false.
    const zero = await evalWhen("0", {
      result: {},
      input: {},
      nodeId: "n1",
    });
    expect(zero).toBe(false);

    const str = await evalWhen("''", {
      result: {},
      input: {},
      nodeId: "n1",
    });
    expect(str).toBe(false);
  });

  it("coerces any truthy value to true", async () => {
    // Any non-empty string, non-zero number, object/array → true.
    const one = await evalWhen("1", { result: {}, input: {}, nodeId: "n1" });
    expect(one).toBe(true);

    const nonempty = await evalWhen("'x'", {
      result: {},
      input: {},
      nodeId: "n1",
    });
    expect(nonempty).toBe(true);
  });
});

describe("evalWhen — empty / missing expression", () => {
  it("treats empty string as 'no condition' → take edge (true)", async () => {
    const ok = await evalWhen("", { result: {}, input: {}, nodeId: "n1" });
    expect(ok).toBe(true);
  });

  it("treats whitespace-only string the same", async () => {
    const ok = await evalWhen("   ", {
      result: {},
      input: {},
      nodeId: "n1",
    });
    expect(ok).toBe(true);
  });
});

describe("evalWhen — cannot reach globals or mutate context", () => {
  it("cannot access process, global, or Buffer", async () => {
    // These are all valid jexl identifiers, but the context doesn't
    // define them, so they'll resolve to undefined → comparison → false.
    const w = vi.fn();
    const procOk = await evalWhen("process.env.SECRET == 'leak'", {
      result: {},
      input: {},
      nodeId: "n1",
    }, { warn: w });
    // Either throws (if jexl doesn't allow dotted access on undefined)
    // or yields false — both are safe.
    expect(procOk).toBe(false);
  });
});
