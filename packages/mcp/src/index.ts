/**
 * @chorus/mcp — public API
 *
 * Three entry points:
 *
 *   - `manifestToMcpTools(manifest)` — pure mapping, no side effects.
 *     For callers that want to inspect the tool shape without spinning up
 *     a server. Also re-exports `operationToMcpTool` /
 *     `credentialTypeToMcpTools` for fine-grained use.
 *
 *   - `serveIntegration({ integration })` — start an MCP server on stdio
 *     in the current process. Blocks until the transport closes. Use this
 *     for `chorus mcp serve <integration>`.
 *
 *   - `generateMcpServer({ integration, outDir })` — emit a standalone
 *     scaffold directory that the user can add to an MCP client. Use this
 *     for `chorus mcp generate <integration>`.
 *
 * Plus `buildChorusMcpServer` / `dispatchTool` for advanced callers who
 * want to wire their own transport or test dispatch in isolation.
 */
export {
  manifestToMcpTools,
  operationToMcpTool,
  credentialTypeToMcpTools,
  resolveCredentialTypes,
  type McpTool,
  type ChorusToolBinding,
  type CredentialVerb,
  type JsonSchemaObject,
  type CredentialTypeView,
  type CredentialFieldView,
  type ManifestWithCredentialTypes,
} from "./tool-mapping.js";

export {
  buildChorusMcpServer,
  dispatchTool,
  runChorusMcpServerStdio,
  type CredentialService,
  type CredentialSummary,
  type CredentialTestResultView,
  type ChorusMcpServerOptions,
} from "./server.js";

export {
  serveIntegration,
  type ServeIntegrationOptions,
} from "./serve.js";

export {
  generateMcpServer,
  type GenerateMcpServerOptions,
  type GenerateMcpServerResult,
} from "./generate.js";

export {
  HttpCredentialServiceClient,
  type HttpCredentialServiceClientOptions,
} from "./credential-client.js";
