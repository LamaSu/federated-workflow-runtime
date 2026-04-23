import { describe, expect, it } from "vitest";
import { parseFbp } from "../src/parser.js";
import { emitFbp } from "../src/emitter.js";
import { fbpToChorus, chorusToFbp } from "../src/adapter.js";

const META = {
  id: "wf-rt",
  name: "roundtrip",
  createdAt: "2026-04-17T00:00:00Z",
  updatedAt: "2026-04-17T00:00:00Z",
};

/**
 * Round-trip a string through the full bridge and return the re-emitted
 * string. For a structurally-identical input, output should be stable on
 * the second run.
 */
function roundtrip(source: string): string {
  const ast = parseFbp(source);
  const workflow = fbpToChorus(ast, META);
  const astBack = chorusToFbp(workflow);
  return emitFbp(astBack);
}

describe("fbp → Chorus → fbp round-trip", () => {
  it("preserves a minimal two-node graph", () => {
    const source = "A(MyComp) OUT -> IN B(Other)";
    const out = roundtrip(source);
    // The input is already in our canonical form, so the output must match.
    expect(out).toBe(source);
  });

  it("preserves Integration/Operation component names", () => {
    const source = "Job(http-generic/request) OUT -> IN Sink(slack/post)";
    const out = roundtrip(source);
    expect(out).toBe(source);
  });

  it("preserves IIPs (string literal initial information packets)", () => {
    const source = "'hello world' -> IN Greeter(Display)";
    const out = roundtrip(source);
    // Target component declared once; data literal preserved.
    expect(out).toContain("'hello world' -> IN Greeter(Display)");
  });

  it("preserves a three-node chain with shared middle process", () => {
    const source = [
      "A(Source) OUT -> IN M(Middle)",
      "M OUT -> IN B(Sink)",
    ].join("\n");
    const out = roundtrip(source);
    expect(out).toBe(source);
  });

  it("is idempotent — running round-trip twice yields the same output", () => {
    const source = "A(Source) OUT -> IN M(Middle)\nM OUT -> IN B(Sink)";
    const first = roundtrip(source);
    const second = roundtrip(first);
    expect(second).toBe(first);
  });

  it("preserves structure when FBP input has a superset of metadata we support", () => {
    // Input has INPORT/OUTPORT; those must survive round-trip (stashed in
    // Chorus node config, rehydrated on the way out).
    const source = [
      "INPORT=A.IN:INPUT",
      "OUTPORT=B.OUT:OUTPUT",
      "A(First) OUT -> IN B(Second)",
    ].join("\n");
    const out = roundtrip(source);
    // Parse both and compare by structure so whitespace/ordering doesn't
    // matter — this is the real definition of "round-trip identity modulo
    // whitespace".
    const parsedOriginal = parseFbp(source);
    const parsedOut = parseFbp(out);
    expect(parsedOut.inports).toEqual(parsedOriginal.inports);
    expect(parsedOut.outports).toEqual(parsedOriginal.outports);
    expect(parsedOut.processes).toEqual(parsedOriginal.processes);
    expect(parsedOut.connections).toEqual(parsedOriginal.connections);
  });

  it("preserves structure for graphs mixing IIPs and wired connections", () => {
    const source = [
      "'startup' -> IN A(Bootstrap)",
      "A OUT -> IN B(Handler)",
      "B OUT -> IN C(Sink)",
    ].join("\n");
    const parsedOriginal = parseFbp(source);
    const out = roundtrip(source);
    const parsedOut = parseFbp(out);
    expect(parsedOut.processes).toEqual(parsedOriginal.processes);
    expect(parsedOut.connections).toEqual(parsedOriginal.connections);
  });

  it("FBP-source round-trip: a workflow that originates from FBP never gains fallbacks", () => {
    // A workflow constructed via `parseFbp → fbpToChorus` has no Node.fallbacks
    // (since FBP can't express them). Round-tripping back to FBP and forward
    // again preserves that absence — the fallback feature is opt-in only on
    // workflows authored as Chorus JSON.
    const source = "A(MyComp) OUT -> IN B(Other)";
    const ast1 = parseFbp(source);
    const wf1 = fbpToChorus(ast1, META);
    expect(wf1.nodes[0]).not.toHaveProperty("fallbacks");
    expect(wf1.nodes[1]).not.toHaveProperty("fallbacks");

    const text2 = roundtrip(source);
    const wf2 = fbpToChorus(parseFbp(text2), META);
    expect(wf2.nodes[0]).not.toHaveProperty("fallbacks");
    expect(wf2.nodes[1]).not.toHaveProperty("fallbacks");
  });
});
