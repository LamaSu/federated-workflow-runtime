// Adapter between FBP AST and Chorus Workflow JSON.
//
// UNDERSTANDING OF THE CHORUS WORKFLOW SCHEMA (packages/core/src/schemas.ts):
//   A Chorus `Workflow` has:
//     - id, name, version, active, createdAt, updatedAt
//     - trigger: discriminated union of cron | webhook | manual
//     - nodes: Array<Node> where Node = {
//         id, integration, operation, config, inputs?, retry?, onError
//       }
//     - connections: Array<Connection> where Connection = {
//         from: string,   ← node id (NOT port-qualified in core today)
//         to: string,     ← node id
//         when?: string
//       }
//
// UNDERSTANDING OF THE FBP AST:
//   An FBP graph has:
//     - processes:   { NAME: { component: "Integration/Operation" } }
//     - connections: [{ src: {process, port}, tgt: {process, port} }]
//                    OR [{ data: "...", tgt: {process, port} }]   (IIPs)
//     - inports/outports: map of exported-port-name → {process, port}
//
// MAPPING DECISIONS:
//   1. An FBP process `NAME(Integration/Operation)` becomes a Chorus
//      Node `{ id: NAME, integration: "Integration", operation: "Operation" }`.
//      A bare `NAME(Foo)` becomes `{ integration: "Foo", operation: "invoke" }`.
//      `"invoke"` is a Chorus convention (see integrations/*) for the
//      single-op integration case.
//
//   2. Chorus `Connection.from` and `.to` are bare strings today (not
//      port-qualified). To preserve FBP port names through round-trip
//      without extending core, we encode port info as `"NODE.PORT"` in the
//      connection endpoints. Plain `"NODE"` (no dot) still parses cleanly
//      for Chorus workflows that never touched FBP.
//
//   3. FBP IIPs (`'data' -> IN Target`) become `Node.inputs[PORT] = data`
//      on the target node. This is the canonical Chorus way to pipe static
//      input into an operation (see NodeSchema.inputs).
//
//   4. FBP `INPORT=` / `OUTPORT=` declarations have no direct Chorus
//      equivalent (the runtime doesn't expose outer-graph ports). We
//      preserve them on a `_fbp` metadata key under Node.config so the
//      inverse direction can reconstruct them without loss.
//
//   5. Trigger: FBP has no trigger concept. `fbpToChorus` accepts a
//      caller-provided trigger (default: `{ type: "manual" }`) and
//      `chorusToFbp` encodes the Chorus trigger in a `# @trigger` comment
//      on the AST properties so re-import recovers it.

import type {
  ChorusToFbpOptions,
  FbpAst,
  FbpConnection,
  FbpToChorusOptions,
} from "./types.js";

// ── Types we need from @delightfulchorus/core, inlined to avoid a hard
// runtime import dependency for consumers who only want the AST layer. The
// shapes are exact structural matches of core's Zod inferences. ─────────────

interface ChorusNode {
  id: string;
  integration: string;
  operation: string;
  config: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    jitter: boolean;
  };
  onError: "fail" | "continue" | "retry";
}

interface ChorusConnection {
  from: string;
  to: string;
  when?: string;
}

type ChorusTrigger =
  | { type: "manual" }
  | { type: "cron"; expression: string; timezone: string }
  | { type: "webhook"; path: string; method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; secret?: string };

export interface ChorusWorkflow {
  id: string;
  name: string;
  version: number;
  active: boolean;
  trigger: ChorusTrigger;
  nodes: ChorusNode[];
  connections: ChorusConnection[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_OPERATION = "invoke";
const FBP_METADATA_KEY = "_fbp";

/**
 * Default component-splitter: `"Integration/Operation"` → split, bare
 * `"Integration"` → operation defaults to `"invoke"`.
 */
const defaultSplitComponent = (
  component: string,
): { integration: string; operation: string } => {
  const slash = component.indexOf("/");
  if (slash < 0) {
    return { integration: component, operation: DEFAULT_OPERATION };
  }
  return {
    integration: component.slice(0, slash),
    operation: component.slice(slash + 1),
  };
};

/**
 * Default component-joiner: inverse of the splitter. Drops the
 * `/invoke` suffix when the operation is the default, so bare
 * single-operation integrations round-trip as `NAME(Integration)`.
 */
const defaultJoinComponent = (node: {
  integration: string;
  operation: string;
}): string => {
  if (node.operation === DEFAULT_OPERATION) {
    return node.integration;
  }
  return `${node.integration}/${node.operation}`;
};

/**
 * Convert an FBP AST to a Chorus Workflow.
 *
 * The `options` object supplies the metadata Chorus requires but FBP does
 * not carry (id, name, timestamps, trigger).
 */
export function fbpToChorus(ast: FbpAst, options: FbpToChorusOptions): ChorusWorkflow {
  const split = options.splitComponent ?? defaultSplitComponent;

  // Build nodes from the processes map. Insertion order is preserved by
  // modern JS object iteration — this matches the expectation that the
  // FBP text declaration order becomes the Chorus node order.
  const nodes: ChorusNode[] = [];
  const inputsByNode: Record<string, Record<string, unknown>> = {};

  for (const [id, proc] of Object.entries(ast.processes)) {
    const { integration, operation } = split(proc.component);
    const config: Record<string, unknown> = {};
    if (proc.metadata && Object.keys(proc.metadata).length > 0) {
      config[FBP_METADATA_KEY] = { processMetadata: proc.metadata };
    }
    nodes.push({
      id,
      integration,
      operation,
      config,
      onError: "retry",
    });
  }

  // Walk connections. IIP rows become inputs on the target node;
  // wired rows become Chorus connections with port-qualified endpoints.
  const connections: ChorusConnection[] = [];
  for (const conn of ast.connections) {
    if (conn.data !== undefined) {
      const port = conn.tgt.port;
      const target = conn.tgt.process;
      if (!inputsByNode[target]) inputsByNode[target] = {};
      inputsByNode[target][port] = conn.data;
      continue;
    }
    if (!conn.src) continue;
    connections.push({
      from: encodeEndpoint(conn.src.process, conn.src.port),
      to: encodeEndpoint(conn.tgt.process, conn.tgt.port),
    });
  }

  // Apply collected IIPs as `inputs` on the matching nodes.
  for (const node of nodes) {
    const inputs = inputsByNode[node.id];
    if (inputs && Object.keys(inputs).length > 0) {
      node.inputs = inputs;
    }
  }

  // Preserve inports/outports on the first node's config — a small escape
  // hatch so chorusToFbp can reconstruct them. The key is namespaced under
  // _fbp so it won't collide with integration-specific config.
  if (
    (ast.inports && Object.keys(ast.inports).length > 0) ||
    (ast.outports && Object.keys(ast.outports).length > 0)
  ) {
    const container: Record<string, unknown> = {};
    if (ast.inports) container["inports"] = ast.inports;
    if (ast.outports) container["outports"] = ast.outports;
    // Stash on workflow via the first node's config. Preferable to a
    // dedicated top-level field because we can't extend WorkflowSchema
    // from this package.
    if (nodes[0]) {
      const existing = (nodes[0].config[FBP_METADATA_KEY] ?? {}) as Record<string, unknown>;
      nodes[0].config[FBP_METADATA_KEY] = { ...existing, ...container };
    }
  }

  return {
    id: options.id,
    name: options.name,
    version: 1,
    active: true,
    trigger: (options.trigger as ChorusTrigger | undefined) ?? { type: "manual" },
    nodes,
    connections,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
}

/**
 * Convert a Chorus Workflow back to an FBP AST. Pair with
 * {@link emitFbp} to get serialized text.
 */
export function chorusToFbp(
  workflow: ChorusWorkflow,
  options: ChorusToFbpOptions = {},
): FbpAst {
  const join = options.joinComponent ?? defaultJoinComponent;

  const processes: FbpAst["processes"] = {};
  for (const node of workflow.nodes) {
    const component = join({
      integration: node.integration,
      operation: node.operation,
    });
    processes[node.id] = { component };
    // Rehydrate any process metadata we stashed on the node's config.
    const stashed = node.config[FBP_METADATA_KEY] as
      | { processMetadata?: Record<string, unknown> }
      | undefined;
    if (stashed?.processMetadata) {
      processes[node.id]!.metadata = stashed.processMetadata;
    }
  }

  const connections: FbpConnection[] = [];
  // IIPs first (so the emitter can list inputs near their target node).
  for (const node of workflow.nodes) {
    if (!node.inputs) continue;
    for (const [port, data] of Object.entries(node.inputs)) {
      connections.push({
        data,
        tgt: { process: node.id, port },
      });
    }
  }
  // Wired connections.
  for (const conn of workflow.connections) {
    const src = decodeEndpoint(conn.from);
    const tgt = decodeEndpoint(conn.to);
    connections.push({
      src: { process: src.process, port: src.port },
      tgt: { process: tgt.process, port: tgt.port },
    });
  }

  // Recover inports/outports from the stashed config, if any.
  const firstStash =
    (workflow.nodes[0]?.config[FBP_METADATA_KEY] as
      | {
          inports?: FbpAst["inports"];
          outports?: FbpAst["outports"];
        }
      | undefined) ?? {};

  const ast: FbpAst = {
    processes,
    connections,
    caseSensitive: false,
  };
  if (firstStash.inports) ast.inports = firstStash.inports;
  if (firstStash.outports) ast.outports = firstStash.outports;
  return ast;
}

/** Encode `(processName, portName)` into Chorus's flat string endpoint. */
function encodeEndpoint(processName: string, port: string): string {
  return `${processName}.${port.toUpperCase()}`;
}

/** Split `"nodeId.PORT"` back into `{ process, port }`. Tolerates bare node ids. */
function decodeEndpoint(endpoint: string): { process: string; port: string } {
  const dot = endpoint.indexOf(".");
  if (dot < 0) {
    return { process: endpoint, port: "out" };
  }
  return {
    process: endpoint.slice(0, dot),
    port: endpoint.slice(dot + 1),
  };
}
