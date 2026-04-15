# Chorus auto-MCP Guide

*Last updated: 2026-04-15. Author: mcp-papa (Wave 2, session 3).*

---

## What this is

Every Chorus integration can be exposed as a **Model Context Protocol (MCP)
server** with one CLI command. The generated server lets agents — Claude
Desktop, Cursor, Zed, or any MCP-compatible client — call integration
operations directly as tools, no workflow glue required.

`@chorus/mcp` is the library that turns `IntegrationManifest` → MCP tool array.
`chorus mcp` is the CLI surface: `list`, `generate`, `serve`, `config`.

## Why auto-MCP?

From `docs/ROADMAP.md` §1:
>Every integration in a user's `chorus/` directory is auto-exposed as an MCP
>tool... This turns Chorus from "a workflow runtime" into "the runtime your
>agent calls to do work."

The insight: workflow runtimes and agent tools are the same thing looked at
from two angles. A cron-triggered `slack-send.postMessage` step is a workflow
node; `slack-send__postMessage` as an MCP tool is that same step, invoked by
an agent in real time. One integration, two consumption modes.

The cassette library (`docs/ARCHITECTURE.md` §1.5) is the moat either way —
repair patches work identically whether the failure was in a cron job or in
an agent tool call.

## Quickstart

```bash
# 1. See what's MCP-ready in your project:
chorus mcp list

# 2. Generate a standalone MCP server for slack-send:
chorus mcp generate slack-send

# 3. Paste the printed config snippet into Claude Desktop / Cursor / Zed.
#    Restart the client. Tools appear as slack-send__postMessage, etc.

# 4. Alternative: serve inline (no scaffold) for quick experiments:
chorus mcp serve slack-send
```

## The four credential tools

Per the contract in `docs/CREDENTIALS_ANALYSIS.md` §7, every integration with
a declared `credentialTypes` catalog exposes these tools (in addition to its
operations):

| Tool | Purpose |
|---|---|
| `<integration>__list_credentials` | Read-only list of stored credentials (no secrets). |
| `<integration>__configure_<typeName>` | Create or update a credential of the named type. Input schema is derived from `CredentialTypeDefinition.fields` minus `oauthManaged: true`. |
| `<integration>__authenticate` | OAuth types only. Returns an `authorizeUrl` the user opens in a browser; Chorus receives the callback and stores the resulting token as a credential. |
| `<integration>__test_auth` | Invoke the credential type's test hook (`test.viaOperation` or `IntegrationModule.testCredential`). Returns `{ok, latencyMs, identity, error}`. |

Operation tools follow the pattern `<integration>__<operation>` and take the
operation's existing JSON-schema input unchanged.

`__test_auth` is **read-only by contract**. If an integration's
`test.viaOperation` points to a non-idempotent operation, the MCP server
refuses to dispatch — per §7.3.

## When to use MCP vs. `chorus run`

| Scenario | Tool |
|---|---|
| Scheduled execution (cron, webhook) | `chorus run` |
| Durable multi-step workflows with retries | `chorus run` |
| Agent-driven ad-hoc "post this to Slack" | MCP tool |
| Mixed: a workflow node + an agent fallback | Both |
| Developing/debugging a new integration | `chorus mcp serve` (inline) |

The executor is the same. The difference is the caller: a Chorus workflow
graph vs. an MCP client. Credentials, error signatures, snapshot cassettes
— all shared. A bug caught via an MCP tool call can be repaired by the same
agent and signed into a registry patch that helps workflow users too.

## CLI reference

### `chorus mcp list [--json]`

Lists installed integrations (packages under `node_modules/@chorus-integrations/`)
and their MCP tool count. `--json` emits a machine-readable array.

### `chorus mcp generate <integration> [--out <dir>]`

Writes a scaffold to `mcp-servers/chorus-<integration>/`:

- `package.json` — declares `@chorus/mcp` + `@chorus-integrations/<name>` as deps
- `index.js` — ESM entrypoint, calls `serveIntegration({ integration })`
- `README.md` — Claude Desktop / Cursor / Zed registration instructions

Prints a `.mcp.json` config snippet to paste into the client. The scaffold
is self-contained: `cd mcp-servers/chorus-<name> && npm install && npm start`
runs it without the rest of the Chorus project.

Regenerate anytime — scaffolds are pure boilerplate; tool shape comes from
the integration's manifest at runtime.

### `chorus mcp serve <integration>`

Starts an MCP server in the current process over stdio, using the installed
integration module. No scaffold written.

Used in two ways:
1. Manually, for quick experimentation with an agent client.
2. Inside generated scaffolds — `index.js` delegates to `serveIntegration`.

### `chorus mcp config <integration> [--out <dir>]`

Prints just the `.mcp.json` config snippet for a given integration. No
files are written. Pipe-friendly:

```bash
chorus mcp config slack-send | jq
```

## Security

MCP tools execute integration operations with the same credentials as
`chorus run`. The threat model is identical to direct CLI use:

- **Credentials never leave the machine.** The MCP server reads them
  through the runtime's credential service; plaintext never hits stdout.
- **`__test_auth` is read-only.** Non-idempotent test hooks are refused.
- **`__authenticate` surfaces URLs only.** Token exchange happens in the
  runtime via the OAuth refresher; the MCP layer never sees plaintext.
- **Every MCP tool call is a runtime invocation.** Audit logging,
  snapshot recording, error-signature extraction all run as usual.

What this means practically: anything an agent can do with these MCP
tools, a human could do with `chorus run`. MCP does not broaden the
blast radius of credentials; it just gives an agent a way to reach them
through the same service layer.

## Integration with credentials-oscar's catalog

`@chorus/mcp` imports from `@chorus/core` directly:

- `CredentialTypeDefinition`, `CredentialField`, `CredentialTestResult` —
  the canonical Zod-inferred types from
  `packages/core/src/credential-catalog.ts`.
- `IntegrationManifest.credentialTypes: CredentialTypeDefinition[]` — the
  load-bearing array that `manifestToMcpTools` consumes.

Legacy integrations that haven't yet declared `credentialTypes[]` still
work: the tool mapper synthesizes a single legacy credential type from
the integration's `authType` so MCP clients can still configure
credentials. The synthesized type is named `<integration>Legacy` and uses
canonical field names (`secret`, `username`, `password`, `accessToken`)
matching the shapes observed in the existing `extractBearerToken` helper.

When an integration author upgrades their manifest to declare
`credentialTypes`, MCP clients see richer tool metadata — deep-links in
field descriptions, `format: password` on secret fields, OAuth authorize
flow, and a typed test hook — without any re-generation.

## Library API

For programmatic use:

```typescript
import {
  manifestToMcpTools,     // pure: manifest → tool array
  operationToMcpTool,     // single operation → tool
  credentialTypeToMcpTools,  // credential type → configure tool
  buildChorusMcpServer,   // construct server + tools (you bring the transport)
  dispatchTool,           // exercise dispatch without MCP transport (tests)
  serveIntegration,       // start server on stdio (blocks)
  generateMcpServer,      // emit scaffold to disk
} from "@chorus/mcp";

// Example: inspect tool shape
import integration from "@chorus-integrations/slack-send";
const tools = manifestToMcpTools(integration.manifest);
console.log(tools.map((t) => t.name));
// [
//   "slack-send__postMessage",
//   "slack-send__list_credentials",
//   "slack-send__configure_slack-sendLegacy",
//   "slack-send__test_auth"
// ]
```

## What's next

Auto-MCP is Priority 1 in the post-MVP roadmap (`docs/ROADMAP.md` §1).
Current scope (Wave 2, shipped):

- [x] Static tool mapping (`tool-mapping.ts`)
- [x] Live MCP server over stdio (`server.ts`)
- [x] Scaffold generator (`generate.ts`)
- [x] CLI surface (`chorus mcp <list|generate|serve|config>`)
- [x] User docs (this file)

Deferred to Wave 3+:

- Credential service injection — current scaffold serves operations
  anonymously. The runtime's credential service needs to expose a public
  interface for MCP to call (delegated to credentials-oscar / runtime).
- OAuth browser callback plumbing — the `authenticate` tool returns a URL
  today but doesn't wait for the callback. Needs `step.waitForEvent` from
  events-quebec's work.
- `tools/list_changed` notifications when integrations are added/removed
  while the MCP server is running.

## Relevant files

- `C:\Users\globa\chorus\packages\mcp\src\tool-mapping.ts` — pure mapping
- `C:\Users\globa\chorus\packages\mcp\src\server.ts` — SDK-wrapped MCP server
- `C:\Users\globa\chorus\packages\mcp\src\serve.ts` — inline serve helper
- `C:\Users\globa\chorus\packages\mcp\src\generate.ts` — scaffold emitter
- `C:\Users\globa\chorus\packages\cli\src\commands\mcp.ts` — CLI wiring
- `C:\Users\globa\chorus\docs\CREDENTIALS_ANALYSIS.md` §7 — the contract
- `C:\Users\globa\chorus\docs\ROADMAP.md` §1 — why this exists
- `C:\Users\globa\chorus\docs\ARCHITECTURE.md` §8 — integration SDK
