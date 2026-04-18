// Types mirror the AST shape emitted by the `fbp` npm package's parser. They
// also cover what its `serialize(graph)` function accepts as input, so a
// single shape works for both directions.
//
// Reference: https://github.com/flowbased/fbp/blob/master/lib/serialize.js

/** A single process instance in an FBP graph — an instantiated component. */
export interface FbpProcess {
  component: string;
  metadata?: Record<string, unknown>;
}

/** A process-name → process instance map, mirroring fbp's `processes` field. */
export type FbpProcessMap = Record<string, FbpProcess>;

/** One end (source or target) of a connection. */
export interface FbpEndpoint {
  process: string;
  port: string;
  index?: number;
}

/**
 * A connection row. One of two shapes:
 *   - data connection (IIP):  `{ data: "literal", tgt: {...} }`
 *   - wired connection:       `{ src: {...}, tgt: {...} }`
 *
 * The fbp package's parser always produces `tgt`; `src` OR `data` is always
 * present on a valid row.
 */
export interface FbpConnection {
  src?: FbpEndpoint;
  tgt: FbpEndpoint;
  data?: unknown;
  metadata?: Record<string, unknown>;
}

/** Exported port on the outer graph (re-exposed from an inner process). */
export interface FbpExportedPort {
  process: string;
  port: string;
  metadata?: Record<string, unknown>;
}

/** AST produced by `fbp.parse(text)`. */
export interface FbpAst {
  processes: FbpProcessMap;
  connections: FbpConnection[];
  inports?: Record<string, FbpExportedPort>;
  outports?: Record<string, FbpExportedPort>;
  groups?: Array<{ name: string; nodes: string[]; metadata?: Record<string, unknown> }>;
  caseSensitive?: boolean;
  properties?: Record<string, unknown>;
}

/**
 * Options for {@link fbpToChorus}. Supplies the metadata Chorus requires
 * (id, name, timestamps, trigger) that FBP does not carry in the text body.
 */
export interface FbpToChorusOptions {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Default trigger when none is specified. Defaults to a manual trigger,
   * which is the closest FBP analog (an operator starts the graph).
   */
  trigger?: unknown;
  /**
   * How to split an FBP component string into Chorus `integration`/`operation`.
   * Default: `"Integration/Operation" → { integration: "Integration",
   * operation: "Operation" }`; a bare `"Foo"` → `{ integration: "Foo",
   * operation: "invoke" }`.
   */
  splitComponent?: (component: string) => { integration: string; operation: string };
}

/**
 * Options for {@link chorusToFbp}. Lets callers choose whether process
 * names in the FBP output are the Chorus node `id` (default) or something
 * derived.
 */
export interface ChorusToFbpOptions {
  /**
   * Rebuild an FBP component string from a Chorus node. Inverse of
   * {@link FbpToChorusOptions.splitComponent}. Default joins as
   * `"Integration/Operation"` and omits the `/invoke` suffix.
   */
  joinComponent?: (node: { integration: string; operation: string }) => string;
}
