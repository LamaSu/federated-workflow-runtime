/**
 * FBP round-trip tests for `integration: "workflow"` nodes.
 *
 * Per the wave-2 brief: "the `packages/fbp/src/adapter.ts` already encodes
 * ports as 'NODE.PORT' strings, so `integration: 'workflow'` nodes are
 * round-trippable to NoFlo for free without runtime changes."
 *
 * Verifying that claim. The integration uses the standard
 * `(integration, operation, config, inputs)` node shape, and the FBP
 * adapter handles those fields as a generic case. There are two ways to
 * carry the workflowId through a round-trip:
 *
 *   1. As an INPUT (IIP form):
 *        node.inputs.workflowId = "child-id"
 *      In FBP this becomes:  `'child-id' -> WORKFLOWID NodeName`
 *      Round-trip: lossless — the IIP machinery preserves it natively.
 *
 *   2. As CONFIG (spec form):
 *        node.config.workflowId = "child-id"
 *      In FBP this is dropped — the adapter only stashes processMetadata
 *      under config[_fbp], not arbitrary config keys.
 *      Round-trip: NOT preserved. Use the IIP form when authoring
 *      subgraph nodes that must round-trip through FBP.
 *
 * The integration handler reads workflowId from BOTH input and config (input
 * wins), so users can author in either form. For FBP-friendly subgraphs,
 * use the IIP form.
 */
import { describe, expect, it } from "vitest";
import { chorusToFbp, fbpToChorus, type ChorusWorkflow } from "@delightfulchorus/fbp";
import { emitFbp } from "@delightfulchorus/fbp";
import { parseFbp } from "@delightfulchorus/fbp";

const META = {
  id: "wf-rt",
  name: "subgraph-roundtrip",
  createdAt: "2026-04-22T00:00:00Z",
  updatedAt: "2026-04-22T00:00:00Z",
};

function freshSubgraphWorkflow(workflowId: string): ChorusWorkflow {
  return {
    id: "parent",
    name: "parent",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "call-child",
        integration: "workflow",
        operation: "invoke",
        config: {},
        // IIP form — preserved through FBP round-trip
        inputs: { workflowId },
        onError: "retry",
      },
    ],
    connections: [],
    createdAt: META.createdAt,
    updatedAt: META.updatedAt,
  };
}

/**
 * The FBP round-trip lowercases port names (FBP convention). The integration
 * handler is case-insensitive on the `workflowId` / `inputMapping` keys (see
 * resolveInvocationParams), so the lowercased recovered form is still
 * functional. Tests below assert structural preservation; lookup checks use
 * a case-insensitive helper.
 */
function lookupCi(record: Record<string, unknown>, key: string): unknown {
  const t = key.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === t) return v;
  }
  return undefined;
}

describe("integration:workflow — FBP round-trip (IIP form)", () => {
  it("a single subgraph node round-trips with workflowId preserved (case-insensitive)", () => {
    const original = freshSubgraphWorkflow("summarize-text");

    // Chorus → FBP → text → FBP AST → Chorus.
    const ast1 = chorusToFbp(original);
    const text = emitFbp(ast1);
    const ast2 = parseFbp(text);
    const recovered = fbpToChorus(ast2, META);

    expect(recovered.nodes).toHaveLength(1);
    const recoveredNode = recovered.nodes[0]!;
    expect(recoveredNode.integration).toBe("workflow");
    expect(recoveredNode.operation).toBe("invoke");
    // The workflowId IIP must survive (key may be lowercased; value is
    // unchanged).
    expect(lookupCi(recoveredNode.inputs ?? {}, "workflowId")).toBe(
      "summarize-text",
    );
  });

  it("a subgraph node with @version suffix preserves the suffix", () => {
    const original = freshSubgraphWorkflow("summarize-text@7");

    const ast1 = chorusToFbp(original);
    const text = emitFbp(ast1);
    const ast2 = parseFbp(text);
    const recovered = fbpToChorus(ast2, META);

    expect(lookupCi(recovered.nodes[0]!.inputs ?? {}, "workflowId")).toBe(
      "summarize-text@7",
    );
  });

  it("connections between subgraph and regular nodes are preserved", () => {
    const original: ChorusWorkflow = {
      ...freshSubgraphWorkflow("step-1"),
      nodes: [
        {
          id: "fetch",
          integration: "http-generic",
          operation: "request",
          config: {},
          inputs: { url: "https://example.com/data" },
          onError: "retry",
        },
        {
          id: "process",
          integration: "workflow",
          operation: "invoke",
          config: {},
          inputs: { workflowId: "process-data" },
          onError: "retry",
        },
      ],
      connections: [{ from: "fetch.OUT", to: "process.IN" }],
    };

    const ast1 = chorusToFbp(original);
    const text = emitFbp(ast1);
    const ast2 = parseFbp(text);
    const recovered = fbpToChorus(ast2, META);

    expect(recovered.nodes).toHaveLength(2);
    expect(recovered.connections).toHaveLength(1);
    expect(recovered.connections[0]).toEqual({
      from: "fetch.OUT",
      to: "process.IN",
    });
    const subgraphNode = recovered.nodes.find((n) => n.id === "process")!;
    expect(subgraphNode.integration).toBe("workflow");
    expect(subgraphNode.operation).toBe("invoke");
    expect(lookupCi(subgraphNode.inputs ?? {}, "workflowId")).toBe(
      "process-data",
    );
  });

  it("inputMapping IIP also round-trips (preserved as JSON string, parsed by handler)", () => {
    const original: ChorusWorkflow = {
      ...freshSubgraphWorkflow("child"),
      nodes: [
        {
          id: "call-child",
          integration: "workflow",
          operation: "invoke",
          config: {},
          inputs: {
            workflowId: "child",
            inputMapping: { dest: "src" },
          },
          onError: "retry",
        },
      ],
    };

    const ast1 = chorusToFbp(original);
    const text = emitFbp(ast1);
    const ast2 = parseFbp(text);
    const recovered = fbpToChorus(ast2, META);

    const node = recovered.nodes[0]!;
    expect(lookupCi(node.inputs ?? {}, "workflowId")).toBe("child");
    // inputMapping IIP survives — but the FBP emitter serializes objects as
    // single-quoted JSON STRINGS (see emitter.formatLiteral). The integration
    // handler is tolerant of this (caseInsensitiveRecord JSON-parses string
    // values), so the recovered shape is functionally equivalent even though
    // the literal value is now a string.
    const recoveredMapping = lookupCi(node.inputs ?? {}, "inputMapping");
    expect(typeof recoveredMapping).toBe("string");
    expect(JSON.parse(recoveredMapping as string)).toEqual({ dest: "src" });
  });

  it("idempotent: round-tripping twice yields the same result", () => {
    const original = freshSubgraphWorkflow("repeated");
    const t1 = emitFbp(chorusToFbp(original));
    const t2 = emitFbp(chorusToFbp(fbpToChorus(parseFbp(t1), META)));
    expect(t2).toBe(t1);
  });

  it("the handler accepts the lowercased workflowId after round-trip", async () => {
    // Simulate a workflow that's been through FBP storage.
    const original = freshSubgraphWorkflow("after-roundtrip");
    const ast1 = chorusToFbp(original);
    const text = emitFbp(ast1);
    const ast2 = parseFbp(text);
    const recovered = fbpToChorus(ast2, META);

    // The recovered node has lowercased input keys.
    const node = recovered.nodes[0]!;
    const handlerInput = { ...(node.inputs ?? {}), triggerPayload: {} };

    // Now drive the handler with this input as the executor would.
    const { invokeOp } = await import("./index.js");
    let observedId: string | undefined;
    const ctx = {
      credentials: null,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      signal: new AbortController().signal,
      runWorkflow: async (id: string) => {
        observedId = id;
        return { runId: "r", output: { ok: true } };
      },
    } as Parameters<typeof invokeOp>[1];
    const out = await invokeOp(handlerInput, ctx);
    expect(observedId).toBe("after-roundtrip");
    expect(out.output).toEqual({ ok: true });
    expect(out.workflowId).toBe("after-roundtrip");
  });
});

describe("integration:workflow — FBP round-trip (config form, documented loss)", () => {
  /**
   * The spec example uses `config.workflowId`. The FBP adapter does NOT
   * preserve arbitrary config keys (only `_fbp` metadata). This test
   * documents the limitation so users know to switch to the IIP form for
   * FBP-friendly workflows.
   */
  it("config.workflowId is NOT preserved through FBP round-trip", () => {
    const original: ChorusWorkflow = {
      ...freshSubgraphWorkflow(""),
      nodes: [
        {
          id: "call-child",
          integration: "workflow",
          operation: "invoke",
          config: { workflowId: "summarize-text" },
          // intentionally no inputs.workflowId
          onError: "retry",
        },
      ],
    };

    const ast1 = chorusToFbp(original);
    const text = emitFbp(ast1);
    const ast2 = parseFbp(text);
    const recovered = fbpToChorus(ast2, META);

    const node = recovered.nodes[0]!;
    // Structure preserved.
    expect(node.integration).toBe("workflow");
    expect(node.operation).toBe("invoke");
    // But config.workflowId is lost — it doesn't survive the round-trip.
    // Recovered node has no config.workflowId AND no inputs.workflowId.
    expect(node.config["workflowId"]).toBeUndefined();
    expect(node.inputs?.["workflowId"]).toBeUndefined();
  });
});
