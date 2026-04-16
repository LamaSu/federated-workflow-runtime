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


## [Key discoveries — free-lunch catalogs]

### APIs.guru — "Wikipedia for Web APIs"
- github.com/APIs-guru/openapi-directory
- Community-maintained directory of **every public REST API** in OpenAPI 2.0/3.x format
- Auto-updated weekly from source
- Fully open source, REST-accessible
- Already contains 2000+ public APIs

### Bruno API Catalog (openapicatalog.com)
- "World's largest catalog of public OpenAPI specs"
- 2000+ APIs from GitHub + APIs.guru
- Ready-to-import to Bruno, free + OSS

### Implication
Chorus doesn't need to hand-write integrations for thousands of services. Point `chorus integrate <service>` at APIs.guru. The spec is already there.

## [n8n JSON workflow format — cross-runtime portability]

- n8n exports workflows as JSON. Includes node config, connections, metadata.
- Credentials are NOT included (stored separately with refs).
- **Declarative nodes use JSON syntax.** Workflow definitions are thus highly portable.
- Version-compat caveat: n8n doesn't promise across-version compatibility, but the shape is stable.

### Implication for Chorus
We can build an **n8n workflow importer** — ingest a `.n8n.json` workflow file and convert it to a Chorus workflow if the nodes it references are in our catalog (either as native integrations or as OpenAPI presets). This would be a huge "drop-in replacement for n8n" moment.

---

# SYNTHESIS FOR CHORUS

## The Three Shapes of a Chorus Integration

Every Chorus integration is one of these three shapes. That's it. No fourth.

### Shape 1: **Native TypeScript integration** (status quo — what `slack-send` and `stripe-charge` are)
- **When to use**: service has rich error model, auth quirks, or non-HTTP transport (DB, SSH, filesystem, etc.)
- **Examples**: slack-send, stripe-charge, postgres-query, gmail-send
- **Footprint**: full package, `integrations/<name>/src/index.ts`, vitest suite, README
- **Budget**: Reserved for the top-10 most-used services + non-HTTP (DB, fs)
- **Count cap**: **~12-15 total**. Not 400.

### Shape 2: **Catalog-driven Universal HTTP** (NEW — the main thing we add)
- **When to use**: service is a REST API with stable auth pattern (API key / bearer / OAuth2)
- **How**: extend `http-generic` into a **catalog-aware** variant that reads a JSON declaration
- **Catalog entry shape** (stored in `catalog/<service>.json`):

```
{
  "name": "linear",
  "displayName": "Linear",
  "docsUrl": "https://developers.linear.app",
  "baseUrl": "https://api.linear.app",
  "authType": "bearer",
  "credentialTypes": [ (shape same as slack-send) ],
  "operations": [
    {
      "name": "createIssue",
      "method": "POST",
      "url": "/graphql",
      "bodyTemplate": "mutation { issueCreate(input: {title: {{title}}}) { issue { id } } }",
      "idempotent": false
    }
  ]
}
```

- **Runtime**: `universal-http` integration iterates catalog + exposes each catalog operation as a Chorus operation.
- **Footprint**: 1 package (`universal-http`) + N JSON files (one per service).
- **Count cap**: **~40-100 catalog entries** — the "everyday SaaS" long tail.

### Shape 3: **OpenAPI generator** (NEW — the infinite-long-tail answer)
- **When to use**: any service we don't have a native or catalog entry for, but that has an OpenAPI spec (APIs.guru has 2000+)
- **How**: `chorus integrate <openapi-url-or-service-name>` CLI subcommand:
  1. Fetches OpenAPI spec (direct URL or from APIs.guru)
  2. Parses spec with `openapi-typescript` or `@hey-api/openapi-ts`
  3. Emits a Shape-2 catalog JSON to `catalog/generated/<service>.json`
  4. User can then treat it as a normal integration
- **Auth detection**: reads `components.securitySchemes` — maps to Chorus auth types automatically
- **Footprint**: 1 CLI tool, lives in `packages/cli/` as `chorus integrate`
- **Count cap**: **Infinite.** Every public OpenAPI spec is addressable.

## Concrete Package Layout (proposed)

```
chorus/
 packages/
    core/                    # existing
    runtime/                 # existing
    cli/                     # extend: chorus integrate subcommand
    mcp/                     # existing
    registry/                # existing — extend to host catalog
    openapi-import/          # NEW — parses OpenAPI → catalog JSON
 integrations/                # Shape 1 (native, ~12-15 max)
    http-generic/            # existing
    slack-send/              # existing
    stripe-charge/           # existing
    postgres-query/          # existing
    gmail-send/              # existing
    universal-http/          # NEW — Shape 2 runtime (reads catalog)
    mcp-proxy/               # NEW — forwards ops to any MCP server
    ... ~8 more top-tier ...
 catalog/                     # Shape 2 (JSON-only)
    github.json              # seed
    notion.json              # seed
    linear.json              # seed
    hubspot.json
    ... 40 curated ...
    generated/               # Shape 3 (from OpenAPI spec)
       twilio.json
       ... everything else ...
```

## Top-40 Services Worth Seeding in the Catalog

Ranked by: n8n popularity × ease-of-integration × Chorus user relevance.

| # | Service | Auth | Source | Why |
|---|---------|------|--------|-----|
| 1 | **GitHub** | Bearer (PAT/App) | Catalog Shape 2 + MCP bridge | Most-forked MCP, 28k stars |
| 2 | **Slack** | Bearer (bot) | Native Shape 1 (DONE) | Ship-tier |
| 3 | **Gmail** | OAuth2 | Native Shape 1 (DONE) | Ship-tier |
| 4 | **Google Sheets** | OAuth2 | Catalog Shape 2 | Most-used automation target |
| 5 | **Notion** | Bearer (integration token) | Catalog Shape 2 | API stable, simple auth |
| 6 | **Airtable** | Bearer (PAT) | Catalog Shape 2 | Simple REST |
| 7 | **Discord** | Bearer / Webhook | Catalog Shape 2 | Chat-heavy workflows |
| 8 | **Telegram** | Bot token in URL | Catalog Shape 2 | Trivial auth |
| 9 | **Twilio** | Basic (SID+secret) | Catalog Shape 2 / APIs.guru | SMS/WhatsApp |
| 10 | **Stripe** | Bearer (sk_) | Native Shape 1 (DONE) | Payments |
| 11 | **Postgres** | Conn string | Native Shape 1 (DONE) | Can't be HTTP |
| 12 | **MySQL** | Conn string | Shape 1 (NEW) | Like postgres |
| 13 | **HubSpot** | Bearer (PAT) | Catalog Shape 2 | CRM |
| 14 | **Salesforce** | OAuth2 | Catalog Shape 2 | CRM |
| 15 | **Google Drive** | OAuth2 | Catalog Shape 2 | File automation |
| 16 | **Jira** | Basic (user+token) | Catalog Shape 2 | Issue tracking |
| 17 | **Linear** | Bearer | Catalog Shape 2 | Modern issue tracking |
| 18 | **Asana** | Bearer (PAT) | Catalog Shape 2 | Task mgmt |
| 19 | **Trello** | API key + token | Catalog Shape 2 | Cards |
| 20 | **Microsoft Teams** | OAuth2 | Catalog Shape 2 | Enterprise chat |
| 21 | **Outlook / M365 Mail** | OAuth2 | Catalog Shape 2 | Enterprise email |
| 22 | **Calendly** | Bearer (PAT) | Catalog Shape 2 | Scheduling |
| 23 | **Google Calendar** | OAuth2 | Catalog Shape 2 | Scheduling |
| 24 | **Mailchimp** | Basic (any-user + key) | Catalog Shape 2 | Email marketing |
| 25 | **SendGrid** | Bearer | Catalog Shape 2 | Transactional email |
| 26 | **OpenAI** | Bearer | Catalog Shape 2 | LLM calls |
| 27 | **Anthropic** | x-api-key header | Catalog Shape 2 | LLM calls |
| 28 | **Supabase** | Bearer (anon/service) | Catalog Shape 2 | BaaS |
| 29 | **PostHog** | Bearer | Catalog Shape 2 | Analytics |
| 30 | **Sentry** | Bearer (PAT) | Catalog Shape 2 | Errors |
| 31 | **AWS S3** | AWS-Sig-v4 | Shape 1 (NEW, hard) | Object storage |
| 32 | **MongoDB** | Conn string | Shape 1 (NEW) | Non-HTTP |
| 33 | **Redis** | Conn string | Shape 1 (NEW) | Non-HTTP |
| 34 | **WhatsApp Cloud** | Bearer | Catalog Shape 2 | Biz messaging |
| 35 | **Zoom** | OAuth2 | Catalog Shape 2 | Meetings |
| 36 | **Webhook (generic receiver)** | HMAC/none | Shape 1 (NEW — trigger-class) | Inbound webhooks |
| 37 | **Cron** | None | Shape 1 (NEW — trigger-class) | Scheduled triggers |
| 38 | **Filesystem** | None | Shape 1 (NEW) | Read/write local files |
| 39 | **SSH/SFTP** | Key + creds | Shape 1 (NEW) | Non-HTTP transport |
| 40 | **MCP Proxy** | Pass-through | Shape 1 (NEW) | Wraps any MCP server as a Chorus integration |

### Auth-type distribution across the top 40
- **Bearer token**: 20 services (50%)
- **OAuth2**: 9 services (23%)
- **Basic auth**: 3 services
- **Connection string**: 4 services (non-HTTP)
- **Custom/AWS-sig**: 2 services
- **Trigger-class**: 2 services

**Conclusion**: A universal catalog-driven runtime that handles Bearer + OAuth2 + Basic auth covers **80% of the top 40**.

## What to SKIP / Defer

- **Every long-tail SaaS service with no OpenAPI spec and minimal user demand**: skip. If it has an OpenAPI spec, `chorus integrate` handles it. If it doesn't, user writes a catalog JSON manually (or files an issue).
- **Visual node editor**: deferred. Chorus is workflow-as-code first.
- **All 5,834 n8n community nodes**: do NOT port. Instead, ship an **n8n-compat importer** that reads `.n8n.json` workflows and tells the user which nodes map to Chorus.
- **Built-in execution history/analytics UI**: out of scope (federation + hash-chained log is a strictly better approach).

## Implementation Order for Wave 2 (3 parallel implementer agents)

### Agent 1: `implementer-alpha` — "Universal HTTP runtime"
**Task**: Build the `universal-http` Shape 2 integration package.
- Input: catalog JSON (schema drawn in this doc)
- Runtime: iterate catalog, register each operation, render template with auth splicing
- Supports: Bearer, API-key-in-header, API-key-in-query, Basic
- **Does NOT** support OAuth2 yet — defer to wave 3 (needs flow UI)
- Output: `integrations/universal-http/` package published to npm
- Tests: 5+ seed services running end-to-end with fixtures

### Agent 2: `implementer-bravo` — "OpenAPI catalog importer"
**Task**: Build the `packages/openapi-import/` tool + `chorus integrate` CLI subcommand.
- Input: OpenAPI URL (direct or service name via APIs.guru index)
- Parse with `@hey-api/openapi-ts` (only for spec parsing — we emit our own manifest)
- Map `securitySchemes` → Chorus `authType`
- Emit `catalog/generated/<service>.json`
- Validate with `universal-http` round-trip tests
- Deliverable: `npx chorus integrate github` creates a usable catalog entry

### Agent 3: `implementer-charlie` — "Seed the catalog"
**Task**: Write 10 hand-crafted catalog JSONs for top services. These become the canonical examples + regression tests.
- GitHub, Notion, Airtable, Linear, HubSpot, OpenAI, Anthropic, SendGrid, PostHog, Sentry
- Each with 3-5 operations, test fixtures, README
- Deliverable: `catalog/*.json` (10 files) + proof they run via universal-http

### Post-Wave coordination
- `implementer-delta` (wave 3): n8n-compat importer — read `.n8n.json` + map nodes
- `implementer-echo` (wave 3): OAuth2 flow support in universal-http
- `implementer-foxtrot` (wave 3): MCP-proxy integration (forward ops to any MCP server)

## Final Opinion (opinionated — pick a path)

**Adopt Shape 2 + Shape 3 immediately. Ship Shape 1 only for the top 10.**

Don't port 400 packages. Don't even try to. Instead:

1. **Ship a universal HTTP runtime** that's catalog-driven (Shape 2). A new integration becomes a JSON file, not a package.
2. **Ship a `chorus integrate` CLI** that ingests OpenAPI specs (Shape 3). This is how we answer "you support FooService?" — yes, if it has an OpenAPI spec.
3. **Ship an `mcp-proxy` integration** that wraps any MCP server as Chorus ops. This taps into the 10,000+ public MCP servers for free.
4. **Keep Shape 1 for the top 10** — native TypeScript where the auth or error model really matters.

### Why this beats every competitor's shape
- **n8n**: stuck with 400 hand-written packages. Community nodes are fragmented. We ship fewer files but cover more surface.
- **Zapier**: closed. 8,500 apps but you can't run their integrations outside their cloud.
- **Pipedream**: close to right shape (1 file per component), but TypeScript-heavy, still writing code per component.
- **Houston**: pointer-level catalog is the insight we're adopting.

**Chorus uniquely combines**: pointer catalog (houston) + universal HTTP runtime (new) + OpenAPI generator (new) + federation/hash-chain (existing) + native Shape 1 escape hatch (existing). **Nobody else has this combination.**

## Progress Tracker Update
- [x] n8n node anatomy
- [x] Pipedream components model
- [x] OpenAPI → tool generators
- [x] Universal adapter patterns
- [x] Houston-bridge pattern
- [x] Long-tail strategy research
- [x] Final synthesis: recommended 3-shape architecture
