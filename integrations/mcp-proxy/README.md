# @delightfulchorus/integration-mcp-proxy

Forward Chorus operations to **any external MCP server**. One integration, the whole MCP ecosystem — point this at GitHub's official MCP server, the `@modelcontextprotocol/server-filesystem` reference, your own custom SSE server, whatever. No per-service glue code required.

The MCP registry lives at https://registry.modelcontextprotocol.io and the reference servers at https://github.com/modelcontextprotocol/servers. There are 500+ public servers as of April 2026; every one of them becomes a Chorus integration the moment you add it to `mcp-servers.json`.

## Operations

| Name         | What it does                                            |
|--------------|----------------------------------------------------------|
| `list-tools` | Ask a configured MCP server what tools it exposes        |
| `call`       | Invoke one of those tools with arguments                 |

## Configuration: `mcp-servers.json`

Configure upstream MCP servers via JSON, resolved in this order (first match wins):

1. Runtime-passed config (`ctx.config.mcpServers`, e.g. from a workflow definition)
2. Local file: `./chorus/mcp-servers.json` (resolved from your cwd)
3. User-global: `~/.chorus/mcp-servers.json`

### Example 1 — GitHub MCP server (stdio + env-substituted secret)

```json
{
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "{{env.GITHUB_TOKEN}}"
      }
    }
  }
}
```

Then in your shell or deployment env:

```bash
export GITHUB_TOKEN=ghp_...
```

Or use the per-server override (see **Security** below):

```bash
export CHORUS_MCP_GITHUB_GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
```

### Example 2 — Filesystem MCP server (stdio, no auth)

```json
{
  "servers": {
    "fs": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/chorus-scratch"]
    }
  }
}
```

### Example 3 — Remote SSE MCP server (custom)

```json
{
  "servers": {
    "my-api": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer {{env.MY_API_TOKEN}}"
      }
    }
  }
}
```

## Calling it from a workflow

```ts
// List what GitHub's MCP server exposes
const tools = await workflow.step("github", "mcp-proxy", "list-tools", {
  serverId: "github"
});
// → { tools: [{ name: "search_issues", ... }, { name: "create_issue", ... }, ...] }

// Call one
const result = await workflow.step("search", "mcp-proxy", "call", {
  serverId: "github",
  tool: "search_issues",
  args: { owner: "LamaSu", repo: "chorus", query: "bug" }
});
// → { result: { content: [{ type: "text", text: "..." }] } }
```

## Adding a new upstream server

1. Find it in the registry: https://registry.modelcontextprotocol.io — or browse the reference list at https://github.com/modelcontextprotocol/servers.
2. Add an entry to `chorus/mcp-servers.json` (or `~/.chorus/mcp-servers.json`). Use `transport: "stdio"` for npm/binary servers, `transport: "sse"` for remote HTTP-streamed ones.
3. Put any secrets in env — either via `{{env.VAR}}` placeholders, or the `CHORUS_MCP_<server>_<var>` override pattern.
4. Call `list-tools` once in a workflow step to discover what you can do.

## Security: env-var pattern (no secrets in config files)

Two ways to keep tokens out of your repo:

### `{{env.VAR}}` substitution (works in `env`, `headers`, `args`, `url`)

```json
{ "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "{{env.GITHUB_TOKEN}}" } }
```

Reads `process.env.GITHUB_TOKEN` at resolve time. Missing vars become the empty string — never a crash — so you get a clean MCP-server auth error rather than a config-parse stack trace.

### Per-server overrides (recommended for prod)

```bash
CHORUS_MCP_<SERVER>_<VAR>
```

This **wins over** any `{{env.VAR}}` placeholder and means you never have to share one env var with two different upstream MCP servers. For example with the `github` serverId and a `GITHUB_PERSONAL_ACCESS_TOKEN` key:

```bash
export CHORUS_MCP_GITHUB_GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
```

Non-alphanumeric characters in the serverId / var name are normalized to `_`, so `my-server` + `some.var` → `CHORUS_MCP_MY_SERVER_SOME_VAR`.

## Error model

| Error code            | Retryable | Meaning                                                         |
|-----------------------|-----------|------------------------------------------------------------------|
| `MCP_UNKNOWN_SERVER`  | false     | `serverId` isn't in any config source                            |
| `MCP_TOOL_NOT_FOUND`  | false     | The upstream server doesn't expose that tool                    |
| `MCP_TOOL_ERROR`      | false     | Tool returned `isError: true` (app-level error)                 |
| `MCP_TIMEOUT`         | true      | Call exceeded `timeoutMs` (default 30s)                         |
| `NETWORK_ERROR`       | true      | Subprocess / SSE transport died — pool evicts + next call retries |

## Design notes

- **Lazy + pooled**: The first call to `list-tools` / `call` for a given `serverId` spawns the subprocess or opens the SSE connection. Subsequent calls in the same process reuse the live client.
- **Pool eviction on death**: If the transport dies mid-call, we throw `NETWORK_ERROR retryable:true` and drop the pool entry so the next call reconnects.
- **Tool discovery on `call`**: Before invoking `callTool`, we check `listTools` output to produce a friendly `MCP_TOOL_NOT_FOUND` instead of whatever the upstream server happens to throw.
