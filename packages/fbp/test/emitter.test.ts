import { describe, expect, it } from "vitest";
import { emitFbp } from "../src/emitter.js";
import { parseFbp } from "../src/parser.js";
import type { FbpAst } from "../src/types.js";

describe("emitFbp", () => {
  it("emits a single wired connection with component declarations", () => {
    const ast: FbpAst = {
      processes: {
        A: { component: "MyComp" },
        B: { component: "Other" },
      },
      connections: [
        {
          src: { process: "A", port: "out" },
          tgt: { process: "B", port: "in" },
        },
      ],
    };
    const text = emitFbp(ast);
    expect(text).toBe("A(MyComp) OUT -> IN B(Other)");
  });

  it("declares each component only once across multiple connection lines", () => {
    const ast: FbpAst = {
      processes: {
        A: { component: "Source" },
        M: { component: "Middle" },
        B: { component: "Sink" },
      },
      connections: [
        { src: { process: "A", port: "out" }, tgt: { process: "M", port: "in" } },
        { src: { process: "M", port: "out" }, tgt: { process: "B", port: "in" } },
      ],
    };
    const text = emitFbp(ast);
    expect(text).toBe(
      ["A(Source) OUT -> IN M(Middle)", "M OUT -> IN B(Sink)"].join("\n"),
    );
  });

  it("emits an IIP with a single-quoted string literal", () => {
    const ast: FbpAst = {
      processes: { Greeter: { component: "Display" } },
      connections: [
        {
          data: "hello world",
          tgt: { process: "Greeter", port: "in" },
        },
      ],
    };
    const text = emitFbp(ast);
    expect(text).toBe("'hello world' -> IN Greeter(Display)");
  });

  it("escapes embedded single quotes inside string IIPs", () => {
    const ast: FbpAst = {
      processes: { Sink: { component: "Display" } },
      connections: [
        { data: "it's fine", tgt: { process: "Sink", port: "in" } },
      ],
    };
    const text = emitFbp(ast);
    expect(text).toBe("'it\\'s fine' -> IN Sink(Display)");
  });

  it("emits numeric, boolean, and null IIPs as bare literals", () => {
    const ast: FbpAst = {
      processes: { Sink: { component: "Display" } },
      connections: [
        { data: 42, tgt: { process: "Sink", port: "num" } },
        { data: true, tgt: { process: "Sink", port: "bool" } },
        { data: null, tgt: { process: "Sink", port: "nul" } },
      ],
    };
    const text = emitFbp(ast);
    expect(text).toContain("42 -> NUM Sink(Display)");
    expect(text).toContain("true -> BOOL Sink");
    expect(text).toContain("null -> NUL Sink");
  });

  it("emits INPORT / OUTPORT lines when the AST has them", () => {
    const ast: FbpAst = {
      processes: { A: { component: "First" }, B: { component: "Second" } },
      inports: { INPUT: { process: "A", port: "in" } },
      outports: { OUTPUT: { process: "B", port: "out" } },
      connections: [
        { src: { process: "A", port: "out" }, tgt: { process: "B", port: "in" } },
      ],
    };
    const text = emitFbp(ast);
    expect(text).toContain("INPORT=A.IN:INPUT");
    expect(text).toContain("OUTPORT=B.OUT:OUTPUT");
  });

  it("emits orphan nodes that are never part of a connection", () => {
    const ast: FbpAst = {
      processes: {
        A: { component: "Lonely" },
      },
      connections: [],
    };
    const text = emitFbp(ast);
    expect(text).toBe("A(Lonely)");
  });

  it("round-trips through the fbp parser (parse(emit(parse(x))) == parse(x))", () => {
    const source = "A(MyComp) OUT -> IN B(Other)";
    const once = parseFbp(source);
    const emitted = emitFbp(once);
    const twice = parseFbp(emitted);
    expect(twice.processes).toEqual(once.processes);
    expect(twice.connections).toEqual(once.connections);
  });
});
