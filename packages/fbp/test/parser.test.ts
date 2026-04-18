import { describe, expect, it } from "vitest";
import { parseFbp, FbpSyntaxError } from "../src/parser.js";

describe("parseFbp", () => {
  it("parses the canonical single-connection example", () => {
    const ast = parseFbp("A(MyComponent) OUT -> IN B(Other)");
    expect(ast.processes).toEqual({
      A: { component: "MyComponent" },
      B: { component: "Other" },
    });
    expect(ast.connections).toHaveLength(1);
    expect(ast.connections[0]).toMatchObject({
      src: { process: "A", port: "out" },
      tgt: { process: "B", port: "in" },
    });
  });

  it("parses a chain of three processes referencing the middle twice", () => {
    const source = [
      "A(Source) OUT -> IN Middle(Mid)",
      "Middle OUT -> IN B(Sink)",
    ].join("\n");
    const ast = parseFbp(source);
    expect(Object.keys(ast.processes)).toEqual(["A", "Middle", "B"]);
    expect(ast.connections).toHaveLength(2);
  });

  it("parses an IIP (initial information packet)", () => {
    const ast = parseFbp("'hello world' -> IN Greeter(Display)");
    expect(ast.processes).toEqual({ Greeter: { component: "Display" } });
    expect(ast.connections).toHaveLength(1);
    const conn = ast.connections[0]!;
    expect(conn.data).toBe("hello world");
    expect(conn.src).toBeUndefined();
    expect(conn.tgt).toEqual({ process: "Greeter", port: "in" });
  });

  it("parses slashed integration/operation component names", () => {
    const ast = parseFbp("Job(http-generic/request) OUT -> IN Next(Sink)");
    expect(ast.processes["Job"]).toEqual({
      component: "http-generic/request",
    });
  });

  it("parses INPORT and OUTPORT declarations", () => {
    const source = [
      "INPORT=A.IN:INPUT",
      "OUTPORT=B.OUT:OUTPUT",
      "A(First) OUT -> IN B(Second)",
    ].join("\n");
    const ast = parseFbp(source);
    expect(ast.inports).toBeDefined();
    expect(ast.outports).toBeDefined();
    // fbp lowercases port and inport names unless caseSensitive is true.
    expect(ast.inports!["input"]).toMatchObject({ process: "A" });
    expect(ast.outports!["output"]).toMatchObject({ process: "B" });
  });

  it("throws a SyntaxError on malformed input", () => {
    expect(() => parseFbp("this is not valid fbp !!!")).toThrow();
  });

  it("exports the fbp package's SyntaxError class for instanceof checks", () => {
    expect(FbpSyntaxError).toBeDefined();
    expect(typeof FbpSyntaxError).toBe("function");
  });
});
