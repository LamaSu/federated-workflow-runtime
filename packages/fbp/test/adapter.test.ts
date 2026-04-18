import { describe, expect, it } from "vitest";
import { parseFbp } from "../src/parser.js";
import { fbpToChorus, chorusToFbp, type ChorusWorkflow } from "../src/adapter.js";
import type { FbpAst } from "../src/types.js";

const META = {
  id: "wf-test",
  name: "test",
  createdAt: "2026-04-17T00:00:00Z",
  updatedAt: "2026-04-17T00:00:00Z",
};

describe("fbpToChorus", () => {
  it("maps a simple two-node FBP graph to a Chorus workflow", () => {
    const ast = parseFbp("A(MyComp) OUT -> IN B(Other)");
    const wf = fbpToChorus(ast, META);

    expect(wf.id).toBe("wf-test");
    expect(wf.name).toBe("test");
    expect(wf.version).toBe(1);
    expect(wf.active).toBe(true);
    expect(wf.trigger).toEqual({ type: "manual" });

    expect(wf.nodes).toHaveLength(2);
    expect(wf.nodes[0]).toMatchObject({
      id: "A",
      integration: "MyComp",
      operation: "invoke",
      onError: "retry",
    });
    expect(wf.nodes[1]).toMatchObject({
      id: "B",
      integration: "Other",
      operation: "invoke",
    });

    expect(wf.connections).toEqual([
      { from: "A.OUT", to: "B.IN" },
    ]);
  });

  it("splits Integration/Operation component names by default", () => {
    const ast = parseFbp("Job(http-generic/request) OUT -> IN Sink(slack/post)");
    const wf = fbpToChorus(ast, META);
    expect(wf.nodes[0]).toMatchObject({
      integration: "http-generic",
      operation: "request",
    });
    expect(wf.nodes[1]).toMatchObject({
      integration: "slack",
      operation: "post",
    });
  });

  it("promotes FBP IIPs into the target node's `inputs` field", () => {
    const ast = parseFbp("'hello' -> IN Greeter(Display)");
    const wf = fbpToChorus(ast, META);
    expect(wf.nodes).toHaveLength(1);
    expect(wf.nodes[0]!.inputs).toEqual({ in: "hello" });
    // IIPs must NOT appear in the Chorus `connections` array.
    expect(wf.connections).toHaveLength(0);
  });

  it("accepts a custom splitComponent", () => {
    const ast = parseFbp("A(snake-case-component) OUT -> IN B(Other)");
    const wf = fbpToChorus(ast, {
      ...META,
      splitComponent: (component) => ({
        integration: component,
        operation: "custom-op",
      }),
    });
    expect(wf.nodes[0]!.operation).toBe("custom-op");
    expect(wf.nodes[0]!.integration).toBe("snake-case-component");
  });

  it("accepts a custom trigger option", () => {
    const ast = parseFbp("A(Comp) OUT -> IN B(Other)");
    const wf = fbpToChorus(ast, {
      ...META,
      trigger: { type: "cron", expression: "*/5 * * * *", timezone: "UTC" },
    });
    expect(wf.trigger).toEqual({
      type: "cron",
      expression: "*/5 * * * *",
      timezone: "UTC",
    });
  });

  it("preserves FBP INPORT/OUTPORT declarations on the first node's config", () => {
    const ast = parseFbp(
      [
        "INPORT=A.IN:INPUT",
        "OUTPORT=B.OUT:OUTPUT",
        "A(First) OUT -> IN B(Second)",
      ].join("\n"),
    );
    const wf = fbpToChorus(ast, META);
    const stash = wf.nodes[0]!.config["_fbp"] as
      | Record<string, unknown>
      | undefined;
    expect(stash).toBeDefined();
    expect(stash!["inports"]).toBeDefined();
    expect(stash!["outports"]).toBeDefined();
  });
});

describe("chorusToFbp", () => {
  it("maps a Chorus workflow back to an FBP AST", () => {
    const wf: ChorusWorkflow = {
      ...META,
      version: 1,
      active: true,
      trigger: { type: "manual" },
      nodes: [
        { id: "A", integration: "MyComp", operation: "invoke", config: {}, onError: "retry" },
        { id: "B", integration: "Other", operation: "invoke", config: {}, onError: "retry" },
      ],
      connections: [{ from: "A.OUT", to: "B.IN" }],
    };
    const ast: FbpAst = chorusToFbp(wf);

    expect(ast.processes).toEqual({
      A: { component: "MyComp" },
      B: { component: "Other" },
    });
    expect(ast.connections).toEqual([
      {
        src: { process: "A", port: "OUT" },
        tgt: { process: "B", port: "IN" },
      },
    ]);
  });

  it("preserves non-default operations as Integration/Operation components", () => {
    const wf: ChorusWorkflow = {
      ...META,
      version: 1,
      active: true,
      trigger: { type: "manual" },
      nodes: [
        { id: "A", integration: "http-generic", operation: "request", config: {}, onError: "retry" },
      ],
      connections: [],
    };
    const ast = chorusToFbp(wf);
    expect(ast.processes["A"]!.component).toBe("http-generic/request");
  });

  it("reconstructs IIPs from node inputs", () => {
    const wf: ChorusWorkflow = {
      ...META,
      version: 1,
      active: true,
      trigger: { type: "manual" },
      nodes: [
        {
          id: "Greeter",
          integration: "Display",
          operation: "invoke",
          config: {},
          inputs: { in: "hello" },
          onError: "retry",
        },
      ],
      connections: [],
    };
    const ast = chorusToFbp(wf);
    expect(ast.connections).toHaveLength(1);
    expect(ast.connections[0]!.data).toBe("hello");
    expect(ast.connections[0]!.tgt).toEqual({ process: "Greeter", port: "in" });
    expect(ast.connections[0]!.src).toBeUndefined();
  });

  it("handles bare (non-port-qualified) Chorus endpoints by defaulting to 'out'/the raw id", () => {
    const wf: ChorusWorkflow = {
      ...META,
      version: 1,
      active: true,
      trigger: { type: "manual" },
      nodes: [
        { id: "A", integration: "Src", operation: "invoke", config: {}, onError: "retry" },
        { id: "B", integration: "Sink", operation: "invoke", config: {}, onError: "retry" },
      ],
      // Pure-Chorus workflow: endpoints have no '.PORT' suffix.
      connections: [{ from: "A", to: "B" }],
    };
    const ast = chorusToFbp(wf);
    expect(ast.connections).toHaveLength(1);
    // Default port is "out" on src side and... the decode falls back when
    // there's no dot. The mapping is still lossless for downstream FBP
    // because it produces a well-formed row.
    expect(ast.connections[0]!.src!.process).toBe("A");
    expect(ast.connections[0]!.tgt.process).toBe("B");
  });
});
