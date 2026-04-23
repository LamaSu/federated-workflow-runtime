/**
 * Round-trip tests for the Chorus <-> Drawflow transform.
 *
 * Strategy:
 *   1. Hand-craft minimal, medium, and branching Workflow fixtures.
 *   2. Pass each through chorusToDrawflow -> drawflowToChorus and assert
 *      the result is semantically equivalent (ids, integration/operation,
 *      connections, when expressions, onError defaults).
 *   3. Pin a few structural invariants of the Drawflow output so the
 *      browser editor can rely on them (presence of input_1/output_1,
 *      chorus-meta hidden node, numeric node ids starting at 1).
 */
import { describe, it, expect } from "vitest";
import { WorkflowSchema, type Workflow } from "@delightfulchorus/core";
import {
  chorusToDrawflow,
  drawflowToChorus,
  INLINED_TRANSFORM_JS,
} from "./drawflow-transform.js";

function makeLinearWorkflow(): Workflow {
  return WorkflowSchema.parse({
    id: "linear-bug-digest",
    name: "Daily Linear bug digest",
    version: 1,
    active: true,
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    nodes: [
      {
        id: "fetch-issues",
        integration: "http-generic",
        operation: "request",
        config: {
          url: "https://api.linear.app/graphql",
          method: "POST",
        },
        onError: "retry",
      },
      {
        id: "summarize",
        integration: "llm-anthropic",
        operation: "generate",
        config: { model: "claude-opus-4-7" },
        onError: "retry",
      },
      {
        id: "post",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#team" },
        onError: "retry",
      },
    ],
    connections: [
      { from: "fetch-issues", to: "summarize" },
      { from: "summarize", to: "post" },
    ],
    createdAt: "2026-04-22T09:00:00Z",
    updatedAt: "2026-04-22T09:00:00Z",
  });
}

function makeBranchingWorkflow(): Workflow {
  return WorkflowSchema.parse({
    id: "ticket-triage",
    name: "Ticket triage",
    version: 1,
    active: true,
    trigger: { type: "webhook", path: "/hooks/ticket", method: "POST" },
    nodes: [
      {
        id: "classify",
        integration: "llm-openai",
        operation: "generateObject",
        config: {},
      },
      {
        id: "urgent",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#oncall" },
      },
      {
        id: "normal",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#support" },
      },
    ],
    connections: [
      { from: "classify", to: "urgent", when: "output.severity === 'urgent'" },
      { from: "classify", to: "normal", when: "output.severity !== 'urgent'" },
    ],
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  });
}

function makeSingleNodeWorkflow(): Workflow {
  return WorkflowSchema.parse({
    id: "echo",
    name: "Echo",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "only",
        integration: "http-generic",
        operation: "request",
        config: { url: "https://example.com/ping" },
      },
    ],
    connections: [],
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  });
}

describe("drawflow-transform — chorusToDrawflow", () => {
  it("produces Drawflow structure with Home.data keyed by numeric ids", () => {
    const wf = makeLinearWorkflow();
    const graph = chorusToDrawflow(wf);
    expect(graph.drawflow).toBeTruthy();
    expect(graph.drawflow.Home).toBeTruthy();
    expect(graph.drawflow.Home.data).toBeTruthy();
    const keys = Object.keys(graph.drawflow.Home.data);
    // 3 real nodes + 1 hidden meta node.
    expect(keys.length).toBe(4);
    // Real nodes use ids 1..3; meta is id 0.
    expect(keys.sort()).toEqual(["0", "1", "2", "3"]);
  });

  it("writes input_1 and output_1 ports on every real node", () => {
    const wf = makeLinearWorkflow();
    const graph = chorusToDrawflow(wf);
    for (const [id, node] of Object.entries(graph.drawflow.Home.data)) {
      if (id === "0") continue;
      expect(node.inputs.input_1).toBeTruthy();
      expect(node.outputs.output_1).toBeTruthy();
    }
  });

  it("emits mirrored input/output connections for every edge", () => {
    const wf = makeLinearWorkflow();
    const graph = chorusToDrawflow(wf);
    const nodes = graph.drawflow.Home.data;
    // fetch-issues -> summarize -> post
    // Chorus assigns sequential numbers 1,2,3 based on workflow.nodes order.
    expect(nodes["1"]!.outputs.output_1!.connections).toEqual([
      { node: "2", output: "input_1" },
    ]);
    expect(nodes["2"]!.inputs.input_1!.connections).toEqual([
      { node: "1", input: "output_1" },
    ]);
    expect(nodes["2"]!.outputs.output_1!.connections).toEqual([
      { node: "3", output: "input_1" },
    ]);
  });

  it("stashes chorus-meta in the hidden node with trigger + when info", () => {
    const wf = makeBranchingWorkflow();
    const graph = chorusToDrawflow(wf);
    const meta = graph.drawflow.Home.data["0"]!.data as Record<string, unknown>;
    expect(meta.chorusMeta).toBe(true);
    expect(meta.workflowId).toBe("ticket-triage");
    expect(meta.workflowName).toBe("Ticket triage");
    expect(meta.trigger).toEqual({
      type: "webhook",
      path: "/hooks/ticket",
      method: "POST",
    });
    const whenMap = meta.whenMap as Record<string, string>;
    expect(whenMap["classify|urgent|0"]).toBe("output.severity === 'urgent'");
    expect(whenMap["classify|normal|0"]).toBe("output.severity !== 'urgent'");
  });

  it("renders inline config fields as df-cfg_* inputs in node html", () => {
    const wf = makeLinearWorkflow();
    const graph = chorusToDrawflow(wf);
    const fetchNode = graph.drawflow.Home.data["1"]!;
    expect(fetchNode.html).toContain("df-cfg_url");
    expect(fetchNode.html).toContain("df-cfg_method");
    // The subtitle exposes the Chorus id so users can orient themselves.
    expect(fetchNode.html).toContain("fetch-issues");
  });

  it("lays nodes out left-to-right by dependency depth", () => {
    const wf = makeLinearWorkflow();
    const graph = chorusToDrawflow(wf);
    // fetch-issues (col 0), summarize (col 1), post (col 2).
    const xs = [1, 2, 3].map((k) => graph.drawflow.Home.data[String(k)]!.pos_x);
    expect(xs[0]).toBeLessThan(xs[1]!);
    expect(xs[1]).toBeLessThan(xs[2]!);
  });
});

describe("drawflow-transform — drawflowToChorus", () => {
  it("round-trips a linear workflow without loss", () => {
    const original = makeLinearWorkflow();
    const graph = chorusToDrawflow(original);
    const restored = drawflowToChorus(graph, original);
    expect(restored.id).toBe(original.id);
    expect(restored.name).toBe(original.name);
    expect(restored.version).toBe(original.version);
    expect(restored.active).toBe(original.active);
    expect(restored.trigger).toEqual(original.trigger);
    expect(restored.nodes.length).toBe(original.nodes.length);
    for (const origNode of original.nodes) {
      const got = restored.nodes.find((n) => n.id === origNode.id);
      expect(got).toBeTruthy();
      expect(got!.integration).toBe(origNode.integration);
      expect(got!.operation).toBe(origNode.operation);
      expect(got!.onError).toBe(origNode.onError);
      expect(got!.config).toEqual(origNode.config);
    }
    // Connections (order-insensitive compare).
    const sortedOrig = [...original.connections].sort((a, b) =>
      `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`),
    );
    const sortedRest = [...restored.connections].sort((a, b) =>
      `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`),
    );
    expect(sortedRest).toEqual(sortedOrig);
  });

  it("round-trips a branching workflow preserving when expressions", () => {
    const original = makeBranchingWorkflow();
    const graph = chorusToDrawflow(original);
    const restored = drawflowToChorus(graph, original);
    expect(restored.nodes.length).toBe(original.nodes.length);
    expect(restored.connections.length).toBe(original.connections.length);

    const urgent = restored.connections.find(
      (c) => c.from === "classify" && c.to === "urgent",
    );
    const normal = restored.connections.find(
      (c) => c.from === "classify" && c.to === "normal",
    );
    expect(urgent?.when).toBe("output.severity === 'urgent'");
    expect(normal?.when).toBe("output.severity !== 'urgent'");
  });

  it("round-trips a single-node workflow", () => {
    const original = makeSingleNodeWorkflow();
    const graph = chorusToDrawflow(original);
    const restored = drawflowToChorus(graph, original);
    expect(restored.nodes.length).toBe(1);
    expect(restored.connections).toEqual([]);
    expect(restored.nodes[0]!.id).toBe("only");
  });

  it("restored workflow passes Zod schema validation", () => {
    const original = makeBranchingWorkflow();
    const graph = chorusToDrawflow(original);
    const restored = drawflowToChorus(graph, original);
    const parsed = WorkflowSchema.safeParse(restored);
    expect(parsed.success).toBe(true);
  });

  it("updates updatedAt on export even when createdAt is preserved", () => {
    const original = makeLinearWorkflow();
    const graph = chorusToDrawflow(original);
    const restored = drawflowToChorus(graph, original);
    expect(restored.createdAt).toBe(original.createdAt);
    // updatedAt should be >= original (usually newer, never older).
    expect(new Date(restored.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(original.updatedAt).getTime(),
    );
  });

  it("recovers integration/operation from node name when extras missing", () => {
    // Simulate a user dragging a new node onto the canvas: Drawflow will
    // name it "<integration>.<operation>" (how the sidebar palette assigns
    // names) and data will lack chorusNodeId/integration extras.
    const base = makeLinearWorkflow();
    const graph = chorusToDrawflow(base);
    // Inject a new node with only `name` and no extras.
    graph.drawflow.Home.data["99"] = {
      id: 99,
      name: "http-generic.request",
      data: {},
      class: "chorus-node",
      html: "",
      typenode: false,
      inputs: { input_1: { connections: [] } },
      outputs: { output_1: { connections: [] } },
      pos_x: 500,
      pos_y: 500,
    };
    const restored = drawflowToChorus(graph, base);
    const newNode = restored.nodes.find((n) => n.id === "node-99");
    expect(newNode).toBeTruthy();
    expect(newNode!.integration).toBe("http-generic");
    expect(newNode!.operation).toBe("request");
  });
});

describe("drawflow-transform — INLINED_TRANSFORM_JS", () => {
  it("defines chorusToDrawflow and drawflowToChorus on the given global", () => {
    // Evaluate the inlined JS in a fake global and confirm the two entry
    // points are exposed. This pins the browser contract.
    const fakeGlobal: Record<string, unknown> = {};
    // The IIFE accepts `typeof window !== "undefined" ? window : globalThis`;
    // we invoke it manually with our fake global instead.
    const mod = `${INLINED_TRANSFORM_JS};`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("global", mod.replace("typeof window!==\"undefined\"?window:globalThis", "global"))(fakeGlobal);
    const transform = fakeGlobal.chorusTransform as {
      chorusToDrawflow: unknown;
      drawflowToChorus: unknown;
    };
    expect(typeof transform).toBe("object");
    expect(typeof transform.chorusToDrawflow).toBe("function");
    expect(typeof transform.drawflowToChorus).toBe("function");
  });

  it("inlined round-trip matches the Node-side round-trip", () => {
    const original = makeLinearWorkflow();
    const fakeGlobal: Record<string, unknown> = {};
    const mod = `${INLINED_TRANSFORM_JS};`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("global", mod.replace("typeof window!==\"undefined\"?window:globalThis", "global"))(fakeGlobal);
    const { chorusToDrawflow: cToD, drawflowToChorus: dToC } = fakeGlobal.chorusTransform as {
      chorusToDrawflow: (wf: unknown) => unknown;
      drawflowToChorus: (g: unknown, base: unknown) => Workflow;
    };
    const graph = cToD(original);
    const restored = dToC(graph, original);
    expect(restored.nodes.length).toBe(original.nodes.length);
    expect(restored.connections.length).toBe(original.connections.length);
    expect(restored.id).toBe(original.id);
  });
});
