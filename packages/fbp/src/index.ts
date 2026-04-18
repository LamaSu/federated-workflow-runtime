// Public surface of @delightfulchorus/fbp.
//
// Three entry points, named to pair:
//   parseFbp   ↔ emitFbp       (string ↔ AST)
//   fbpToChorus ↔ chorusToFbp  (AST ↔ Chorus Workflow)

export { parseFbp, FbpSyntaxError } from "./parser.js";
export { emitFbp } from "./emitter.js";
export {
  fbpToChorus,
  chorusToFbp,
  type ChorusWorkflow,
} from "./adapter.js";
export type {
  FbpAst,
  FbpProcess,
  FbpProcessMap,
  FbpEndpoint,
  FbpConnection,
  FbpExportedPort,
  FbpToChorusOptions,
  ChorusToFbpOptions,
} from "./types.js";
