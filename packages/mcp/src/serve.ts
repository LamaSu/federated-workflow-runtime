/**
 * @chorus/mcp — serve
 *
 * Inline MCP serve: given an IntegrationModule, start an MCP server on
 * stdio in the CURRENT process. No files written, no scaffold emitted —
 * just dispatch. Use this for `chorus mcp serve <integration>` and for
 * quick experimentation.
 *
 * For the scaffold-a-standalone-server variant, see `generate.ts`.
 */
import type { IntegrationModule } from "@chorus/core";
import {
  runChorusMcpServerStdio,
  buildChorusMcpServer,
  type CredentialService,
  type OAuthEventListener,
} from "./server.js";

export interface ServeIntegrationOptions {
  /** The integration module to expose (already imported by the caller). */
  integration: IntegrationModule;
  /**
   * Credential service. When omitted, credential-control tools still appear
   * in `tools/list` but calling them errors. That's a graceful failure mode
   * for read-only use cases where the agent only calls operations.
   */
  credentialService?: CredentialService;
  /**
   * OAuth event listener. When wired, __authenticate blocks on the
   * oauth.callback.<state> event (5-min timeout). When omitted, the
   * tool returns the authorizeUrl+state synchronously.
   */
  eventListener?: OAuthEventListener;
  /** Optional override of the advertised server name/version. */
  serverInfo?: { name?: string; version?: string };
  /**
   * Transport. Default stdio — the universal local MCP transport.
   * "inMemory" exists only for tests (returns a handle without blocking).
   */
  transport?: "stdio" | "inMemory";
}

/**
 * Start an MCP server for a pre-loaded integration and block until the
 * transport closes. For stdio (default), that happens when stdin EOFs — the
 * way Claude Desktop / Cursor / Zed shut down MCP subprocesses cleanly.
 *
 * Returns a promise that resolves after the transport closes. Callers
 * typically do NOT await this in production — the process exits when stdio
 * closes. In tests, mock the transport via `buildChorusMcpServer` directly.
 */
export async function serveIntegration(
  opts: ServeIntegrationOptions,
): Promise<void> {
  const transportKind = opts.transport ?? "stdio";

  if (transportKind === "inMemory") {
    // Not a real use case; provided only so tests can assert the
    // "server construction path" works end-to-end without actually
    // holding stdin open. The test returns immediately after build.
    await buildChorusMcpServer({
      integration: opts.integration,
      credentialService: opts.credentialService,
      eventListener: opts.eventListener,
      serverInfo: opts.serverInfo,
    });
    return;
  }

  if (transportKind !== "stdio") {
    // Exhaustiveness check.
    const _exhaustive: never = transportKind;
    throw new Error(`unsupported transport: ${String(_exhaustive)}`);
  }

  await runChorusMcpServerStdio({
    integration: opts.integration,
    credentialService: opts.credentialService,
    eventListener: opts.eventListener,
    serverInfo: opts.serverInfo,
  });
}
