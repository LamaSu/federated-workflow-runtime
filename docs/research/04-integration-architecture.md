# Research 04: Integration Architecture — Covering n8n's Surface Without 400 Packages
Agent: scout-november
Started: 2026-04-16

## Progress Tracker
- [ ] n8n node anatomy
- [ ] Pipedream components model
- [ ] OpenAPI → tool generators
- [ ] Universal adapter patterns
- [ ] Houston-bridge pattern
- [ ] Long-tail strategy research
- [ ] Final synthesis: recommended 3-shape architecture

## Raw Research Notes


## [n8n Node Anatomy] — docs.n8n.io/integrations/creating-nodes

### Key findings
- n8n nodes ship as NPM packages in a directory structure
- Required files: `node.json` (metadata) + `Name.node.ts` (implementation)
- Classname must match filename (e.g., `NasaPics` → `NasaPics.node.ts`)
- Must export interface implementing `INodeType` with `description` object
- `description` contains `properties` array rendered by the Editor UI
- TWO node styles: **declarative** (JSON-heavy, recommended for REST APIs) vs **programmatic** (imperative TS for complex logic)
- Complex nodes use a subdirectory: `actions/<resource>/` per resource group

### Node counts (2026)
- 400+ official integrations
- **5,834 community nodes** indexed in ecosystem (January 2026)
- Growing ~13.6 nodes/day since Feb 2025
- Core nodes = HTTP Request, Code, Webhook, If, Merge, Set, Schedule Trigger, Wait, Error Trigger

### Implication for Chorus
n8n node format = a description + a handler. Declarative nodes are essentially JSON.
**These can be imported as metadata.** The runtime behavior is "pass JSON → hit HTTP endpoint".
A Chorus "integration" is already this shape in `http-generic`. What's missing: auth-aware presets.

## [Pipedream Components] — pipedream.com/docs

### Key findings
- 1,000+ pre-built components (vs n8n's 400 official)
- Open registry on GitHub — components are source-available
- Two main types: **sources** (triggers/event emitters) and **actions** (transforms)
- Components are TypeScript/JavaScript modules with `props` (inputs) and a `run` function
- **Relevance AI leverages LLM to auto-generate Pipedream component code** from natural language prompts
- OpenAPI 3.1.0 spec support for custom GPT/API integration
- Code generation pipeline for any API

### Implication for Chorus
Pipedream proves a **declarative-component + AI-codegen combo** scales to 1000+ integrations.
That's the path of least resistance to cover n8n's surface area.


## [n8n Declarative Node — Full Example] — deepwiki.com/n8n-io

### Anatomy of a declarative node

```typescript
export class MyApiNode implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'My API',
    name: 'myApi',
    icon: 'file:myapi.svg',
    version: 1,
    credentials: [{ name: 'myApiCredentials', required: true }],
    requestDefaults: {
      baseURL: 'https://api.example.com',
      headers: { 'Content-Type': 'application/json' },
    },
    properties: [
      { displayName: 'Resource', name: 'resource', type: 'options',
        options: [{ name: 'User', value: 'user' }] },
      { displayName: 'Operation', name: 'operation', type: 'options',
        options: [{ name: 'Get', value: 'get' }] },
      { displayName: 'ID', name: 'id', type: 'string',
        routing: { request: { url: '/users/{{$value}}', method: 'GET' } } },
    ],
  };
}
```

### What this means for Chorus

**THIS IS BASICALLY PURE METADATA.** There is no `execute()` method — n8n's runtime interprets the routing DSL at run-time. A declarative node is a **data structure**.

This is the *exact pattern* we should adopt:
- Base URL + default headers
- Named credential binding
- Resources × Operations matrix
- Per-operation routing: `{ method, url template, body template }`
- Expression interpolation `{{$value}}` for dynamic fields

### Authentication via `generic` credential type

When using `generic` credentials, n8n lets you specify where auth material goes: `body` | `header` | `qs`. That plus `preAuthentication` for fetching a session token covers ~80% of real-world APIs.

## [hey-api/openapi-ts] — github.com/hey-api/openapi-ts

### What it generates
- TypeScript interfaces from OpenAPI schemas
- SDK code (typed fetch wrappers per endpoint)
- Zod schemas (validation)
- TanStack Query hooks (not relevant for Chorus)
- 20+ plugins; fetch/axios clients

### Used by: Vercel, OpenCode, PayPal

### Limits for Chorus
- Generates a *code dependency*, not a data structure we can ship as an integration manifest
- No built-in MCP/LLM tool-function export
- BUT: it's a mature pipeline for *parsing* OpenAPI 3.0/3.1 reliably. We could use it as a parser and then emit our own manifest.

## [OpenAPI → MCP Server] — multiple tools

### Major projects
- **FastMCP** (gofastmcp.com) — generates MCP servers from OpenAPI, though doc notes "LLMs perform better on curated servers than auto-converted"
- **openapi-mcp-codegen** (cnoe-io) — Jinja2 templates to Python MCP server + optional LangGraph agent
- **openapi-mcp-server** (AWS Labs) — dynamic runtime tool creation from OpenAPI
- **openapi-mcp-generator** (harsha-iiiv) — CLI, generates MCP server proxy
- **Stainless** — commercial, auto-generates MCP servers from spec (used by Anthropic MCP client apps)

### Research finding (arxiv 2507.16044)
- Baseline generation succeeds for 76% of sampled OpenAPI tools
- Automated repair raises this to 94.2%
- Filtering + regrouping reduces tool count by 1/3 (i.e., curated beats raw-generated)

### Implication for Chorus
A `chorus integrate <openapi-url>` command is entirely feasible with a ~75-85% success rate on arbitrary REST APIs. This handles the **long tail**.


## [Universal Adapter Patterns] — Postman + Zapier

### Postman
- **Postman Runtime Library**: open-source Node.js library for configuration over request sending
- **Collection SDK**: Node module to build collections dynamically + run via Newman/CLI
- Collection format: JSON with `auth`, `header`, `url`, `body`, `tests`, `variables`
- Auth types supported: `basic`, `apikey`, `bearer`, `oauth1`, `oauth2`, `aws-signature`, `digest`, `hawk`, `ntlm`

### Zapier
- **Webhooks by Zapier**: supports Basic Auth + header/query-string auth (no OAuth)
- **Code by Zapier**: escape hatch for arbitrary logic
- Has a separate "Developer Platform" for private/custom OAuth integrations
- Key insight: Zapier's own universal adapter covers ~60-70% of use cases *without* OAuth

### Implication for Chorus
A Chorus universal adapter needs:
1. A request-building layer (method/url/headers/body with templating)
2. **Credential-aware** injection — read auth material from `credentials-oscar`, splice into request
3. Support for the 4 essential auth shapes:
   - **API key in header** (e.g., `X-API-Key: $key`)
   - **Bearer token in header** (e.g., `Authorization: Bearer $token`)
   - **API key in query** (e.g., `?api_key=$key`)
   - **Basic auth** (`Authorization: Basic base64(user:pass)`)
4. Plus: OAuth2 bearer with auto-refresh (already covered by `credentials-oscar` + OAuth flow)

## [Houston-Bridge Comparison] — user's point of reference

### What houston-bridge delivers (from MEMORY.md)
- `@pcc/workflow` library (durable execution, Inngest-style memo + hash-chained event log)
- **12 connector catalog** in `connectors/catalog.json` — extensible by adding registry URI entries
- **3 role agents** (Bookkeeper, HR, Sales) — SOD-flagged
- `/assist` plain-English skill
- Bridge MCP (ships per-tool; scope is "route to workflow")
- Spark daemon (Python shim dev + Node prod)
- Draft-first for external dispatch, auto for internal CRM

### Key architectural decision quoted from memory
> "Wheel-scout pivot: Adopted MCP Registry (launched Sept 2025) + Glama + mcp.so as connector source.
> Curated 12 connectors in `connectors/catalog.json` — **extensible by adding registry URI entries, no forging needed**."

**CRITICAL INSIGHT**: Houston-bridge isn't re-implementing 1000 integrations. It's **pointing at existing MCP servers** via a curated catalog. The catalog entries are URIs into the **MCP Registry** ecosystem.

And from the same file:
> "Integration count is a pointer-level choice, not engineering."

### Implication for Chorus
Chorus should NOT write 400 integration packages. It should ship:
1. A **small core** of universal shapes (HTTP, DB, filesystem)
2. A **curated catalog** that *points at* MCP servers + OpenAPI specs + preset JSON bundles
3. A **generator** that ingests an OpenAPI spec and emits a manifest

The "integration count" is then as large as the MCP Registry + any OpenAPI spec the user wants.


## [Long-Tail Strategy] — Registries + Catalogs

### MCP Registry ecosystem (2026)
- **Official MCP Registry**: registry.modelcontextprotocol.io (Sept 2025 launch)
  - Metaregistry backed by Anthropic + GitHub + PulseMCP + Microsoft
  - Stores metadata, NOT binaries
- **500+ public MCP servers** in 2026; 97M+ monthly SDK downloads
- **10,000+ active public MCP servers** total
- Top servers: GitHub (28k stars), Exa (web search), Filesystem, PostgreSQL
- **PulseMCP**: 11,840+ servers hand-reviewed
- **Smithery.ai**: 7,000+ servers, app-store UX

### n8n popular integrations (April 2026)
From n8n blog + n8nworkflows.world:
- **Top 10**: Google Sheets, Telegram, MySQL, Slack, Discord, Postgres, Notion, Gmail, Airtable, Google Drive
- **Top integration pairs**: HubSpot↔Salesforce, Twilio↔WhatsApp, GitHub↔Jira, Asana↔Slack

### Zapier stats
- **8,500+ apps** supported; 25M+ Zaps created
- 3M users; top industries: software, IT, marketing

### Strategy conclusion
The long tail is already solved for us — **just import**:
1. **For services with MCP servers**: catalog entry = registry URI + metadata override
2. **For services with OpenAPI specs**: `chorus integrate <openapi-url>` → manifest
3. **For services with neither**: user adds a universal-http preset (catalog entry = auth type + baseUrl + per-op templates)
4. **For anything left**: forget it; use `http-generic` with hand-written credential

## [Pipedream Components — deeper dive] — github.com/PipedreamHQ/pipedream

### Component shape (inferred from docs)
```javascript
export default {
  key: "slack-send-message",       // unique ID
  name: "Send Message",
  description: "Send a message to a Slack channel",
  type: "action",                  // or "source"
  version: "0.0.1",
  props: {
    slack: { type: "app", app: "slack" },   // auth binding
    channel: { type: "string", label: "Channel" },
    text: { type: "string", label: "Message" },
  },
  async run({ steps, $ }) {
    return await axios($, {
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      headers: { Authorization: `Bearer ${this.slack.$auth.oauth_access_token}` },
      data: { channel: this.channel, text: this.text },
    });
  },
};
```

### Key takeaways
- `props.app` is the auth binding — Pipedream manages the OAuth flow, component just uses the token
- `run({ steps, $ })` is the execution function with axios injected
- 1 component = 1 action; they ship *many* components per service (Slack has ~50+ actions)
- Open-source registry on GitHub = community contribution mechanism

### Why this matches Chorus nicely
Our integration `index.ts` with `execute(input, credential)` is already this shape.
What we're missing: the "many actions per service" decomposition, and the community registry.

