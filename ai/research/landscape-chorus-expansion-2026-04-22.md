# Landscape Report: Chorus Expansion (NL-to-workflow + Visual Editor + Cloud Distribution)

*scout-alpha, 2026-04-22. Generated for the /go pipeline building chorus's 7 new features.*

**Problem**: Before building, assess what already exists to avoid reinventing wheels.
**Constraints**: TypeScript, local-first (127.0.0.1), code-and-config-first, no drag-drop maintained UI, model-agnostic LLM wrappers, Chorus's OpenFlow JSON, federated self-repair moat must not be undermined.

---

## Axis A: NL-to-workflow Generation

| # | Solution | URL | Solves? | Maintained? | Recommendation |
|---|----------|-----|---------|-------------|----------------|
| 1 | Vercel AI SDK `generateObject` + Zod | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data | Fully (with schema) | Yes (SDK v5, Jul 2025) | **ADOPT** |
| 2 | n8n AI Workflow Builder | https://docs.n8n.io/advanced-ai/ai-workflow-builder/ | Partially | Yes (Oct 2025) | BUILD-with-reference |
| 3 | Windmill AI Flow Builder | https://www.windmill.dev/docs/flows/ai_flows | Partially | Yes | BUILD-with-reference (AGPL blocks direct use) |
| 4 | Flowise / Langflow | https://flowiseai.com / https://github.com/langflow-ai/langflow | No (builds LLM chains, not TS workflows) | Yes | SKIP |
| 5 | LangGraph JS | https://github.com/langchain-ai/langgraphjs | No (code-defined graphs, no NL) | Yes | SKIP |
| 6 | CrewAI YAML Flows | https://github.com/crewaiinc/crewai | Partially (YAML, not TS) | Yes | BUILD-with-reference |
| 7 | n8n-as-code (TS format) | https://github.com/EtienneLescot/n8n-as-code | Partially (TS repr for n8n JSON) | Yes (~100⭐, 2026) | **EXTEND-pattern** |
| 8 | flows-ai | https://github.com/callstackincubator/flows-ai | No (runtime orch, not NL→graph) | Stale (v0.4.0, Jan 2025) | SKIP |

### Top choice: Vercel AI SDK `generateObject`

- **License**: Apache 2.0
- **NL interface**: `generateObject({ model, schema: z.object(...), prompt })` — any prompt → validated JSON matching the Zod schema.
- **Multi-provider**: Yes — Claude (`@ai-sdk/anthropic`), OpenAI (`@ai-sdk/openai`), Gemini (`@ai-sdk/google`) share the same interface. Directly serves Task 3's LLM wrapper requirement.
- **Why Chorus**: `packages/core/src/schemas.ts` already defines the `WorkflowSchema` Zod type. Feed it into `generateObject` and the LLM becomes the compiler; Zod validation catches drift.
- **Effort**: ~200-line system prompt + ~50-line CLI wrapper. The work is prompt engineering, not library adoption.

### Key insight from `n8n-as-code`

LLMs hallucinate less when producing **TypeScript** than raw JSON. Chorus should emit `chorus/<slug>.ts` (typed imports from `@delightfulchorus/core`), not `.json`. Git-diffable, schema-checked at import.

---

## Axis B: Visual Editor Libraries (CDN-ready, standalone HTML)

| # | Solution | URL | License | CDN-ready | Maintained? | Recommendation |
|---|----------|-----|---------|-----------|-------------|----------------|
| 1 | Drawflow | https://github.com/jerosoler/Drawflow | MIT | **Yes** (jsDelivr, 2 lines) | Stale (Sep 2024) but feature-complete | **ADOPT** |
| 2 | Litegraph.js | https://github.com/jagenjo/litegraph.js | MIT | Yes (cdnjs) | Stale (Mar 2024); ComfyOrg fork archived | Fallback |
| 3 | React Flow | https://reactflow.dev | MIT | **No** (needs React + bundler) | Yes (25k⭐) | SKIP for CDN use-case |
| 4 | Rete.js v2 | https://retejs.org | MIT | Partial (esm.sh, 4-step init) | Yes | SKIP (too complex for single-file HTML) |
| 5 | JsPlumb community | https://github.com/jsplumb/community-edition | MIT/GPL2 | Yes (UMD) | **ABANDONED** (frozen) | SKIP |
| 6 | @xyflow/system | https://github.com/xyflow/xyflow | MIT | No (TS source) | Yes | SKIP for CDN use-case |
| 7 | NoFlo + fbp-graph | https://github.com/flowbased/fbp-graph | MIT | Partial (data model only, no renderer) | Stale | EXTEND-pattern (for FBP interop only) |

### Top choice: Drawflow

- **2 CDN lines, zero build**:
  ```html
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.css">
  <script src="https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.js"></script>
  ```
- **Vanilla JS** — `new Drawflow(container)`, `editor.addNode(...)`, `editor.export()`, `editor.import(json)`.
- **Inline prop editing** via `df-*` attributes on `<input>`/`<textarea>`/`<select>` — auto-syncs with node data.
- **Starter example to clone**: `/docs/index.html` in the Drawflow repo (400 lines, all features wired).
- **FBP fit**: Multiple input/output ports per node, drag edges. Chorus `Node{integration, operation, config}` maps cleanly.
- **Stale risk**: Acceptable because generated HTML doesn't need maintenance; if a bug shows up, the agent regenerates with a different lib.

### Fallback: Litegraph.js for "Blueprint-style" users

Canvas2D, heavier UX, named ports with types. Use `jagenjo/litegraph.js` (main repo; ComfyOrg fork is archived). Ship as optional flag `chorus ui --editor --style=blueprint`.

### SKIP React Flow for this task

Would be the gold standard if we relaxed the "open directly, no build" constraint. If we shift to serving the editor from the chorus runtime itself (`GET /editor/<workflow-id>.html` serves a bundled React app), React Flow becomes viable. Not MVP scope.

---

## Axis C: Cloud Distribution Patterns for Local-First Runtimes

| # | Pattern | URL | Preserves local-first? | Credential story | Fit for MVP |
|---|---------|-----|------------------------|------------------|-------------|
| 1 | Windmill Hub (OpenFlow JSON) | https://www.windmill.dev/docs/misc/share_on_hub | Yes | Resources separate | **ADOPT-pattern** |
| 2 | GitHub Gist | https://gist.github.com | Yes | Manual strip (we automate) | **ADOPT for MVP** |
| 3 | Appsmith/Retool export | https://docs.retool.com/apps/guides/app-management/import-export | Partial | Resources separate | BUILD-with-reference |
| 4 | Nostr naddr / IPFS | https://nostr.com / https://ipfs.io | Yes (cryptographic) | No credentials concept | DEFER to v2 |
| 5 | Docker Hub / GHCR | https://ghcr.io | Yes (container) | Baking = anti-pattern | SKIP for templates |
| 6 | Supabase self-host + sync | https://supabase.com/docs/guides/self-hosting | No (adds cloud boundary) | Complex | SKIP |

### Top choice: Windmill-pattern credential stripping + GitHub Gist distribution

**How**:
1. `chorus share <workflow-id>`:
   - Read workflow from SQLite
   - Strip credentialId references → replace with `{ __credentialRef: "slack-oauth2", placeholder: true }`
   - `--gist`: POST to GitHub Gist API via `@octokit/rest` (or store a Chorus-managed GitHub token once)
   - No flag: write `<slug>.chorus-template.json` to cwd
2. `chorus import <gist-url|file>`:
   - Fetch + Zod validate
   - For each `__credentialRef`: look up installed credential of that type, or prompt user to run `chorus credentials add`
   - Insert workflow into local SQLite

**Why this preserves the thesis**:
- Gist is a neutral JSON blob. No Chorus cloud. No credentials in the blob.
- "Credentials never leave the box" holds — only the graph structure + credential *type hints* travel.
- Validates against industry norm: both Appsmith and Retool export apps WITHOUT embedded datasource credentials.

### Defer to v2: Nostr-signed template registry

Censorship resistance + provenance signing is overkill for workflow templates today. Revisit if:
- Users want tamper-evident sharing
- GitHub dependency becomes unacceptable

---

## Consolidated Recommendations

| Task | Verdict | Top pick | Effort |
|------|---------|----------|--------|
| 2: `chorus compose` | **ADOPT** Vercel AI SDK `generateObject` | `ai` + `@ai-sdk/*` + system prompt | 1 agent-day |
| 3: LLM integrations | **ADOPT** Vercel AI SDK multi-provider (one package, not three) | `@ai-sdk/anthropic/openai/google` | 1 agent-day |
| 4a: `Connection.when?` | **ADOPT** Jexl (`@pawel-up/jexl`) | MIT, sandboxed, 20KB | 0.5 agent-day |
| 4b: `step.memory.get/set` | BUILD (SQLite KV, trivial) | No library; 1 new table | 0.5 agent-day |
| 5: `agent` step | **ADOPT** chorus repair-agent pattern + AI SDK tools | `packages/repair-agent/` + `ai` | 2 agent-days |
| 6: `chorus ui --editor` | **ADOPT** Drawflow (CDN) | `/docs/index.html` from Drawflow repo | 1 agent-day |
| 7: `chorus share` | **ADOPT** Windmill pattern + Gist | `@octokit/rest` optional | 1 agent-day |

**Total**: 7 agent-days serial; compressible to ~2 with 4-way parallel wave execution.

### Implementation details per task

**Task 2 (`chorus compose`)**:
- `packages/cli/src/commands/compose.ts` — one new file
- Install `ai`, `@ai-sdk/anthropic`
- `composeWorkflow(prompt: string, model = anthropic("claude-opus-4-7"))` → `generateObject({ schema: workflowSchema, system: <200-line prompt>, prompt })` → emit TypeScript file
- Ralph loop: if Zod validation fails, re-prompt up to 3 times with diagnostic

**Task 3 (LLM integrations)**:
- New workspace package: `@delightfulchorus/integration-llm`
- Exports three `IntegrationModule`s: `llm-anthropic`, `llm-openai`, `llm-gemini`
- Each wraps the corresponding `@ai-sdk/*` provider
- Operations: `generate` (text), `generateObject` (Zod schema → JSON)
- Credential types: `apiKey` per provider, with typed fields

**Task 4 (`when?` + `memory`)**:
- `packages/runtime/src/executor.ts` — before traversing any `Connection.when?`, eval via Jexl against source node output; skip edge if falsy
- New SQLite table: `CREATE TABLE memory (workflow_id TEXT, user_id TEXT NULL, key TEXT, value_json TEXT, updated_at INTEGER, PRIMARY KEY (workflow_id, user_id, key))`
- `StepContext.memory.get(key)` / `memory.set(key, value)` — scope: per-workflow + per-user (if trigger payload has `userId`)

**Task 5 (`agent` step)**:
- New workspace package: `@delightfulchorus/integration-agent`
- Reuses the plan-observe-act loop pattern from `packages/repair-agent/`
- Uses AI SDK's multi-step tool calling (`generateText({ tools, maxSteps })`)
- Tools sourced from: (a) other chorus integrations in-tree, (b) roadmap-#1 auto-MCP tools once shipped
- Deterministic replay: each iteration wrapped in `step.run(name, fn)` so mid-run crashes resume from memoized state

**Task 6 (`chorus ui --editor`)**:
- `packages/cli/src/commands/ui-editor.ts` — emits single HTML file
- Clone Drawflow `/docs/index.html` as base template
- Customize: node shapes = chorus Node fields; edges = Connection with inline `when?` input; import from `GET /api/workflows/:id`; export to clipboard or HTTP POST

**Task 7 (`chorus share`)**:
- `packages/cli/src/commands/share.ts` + `import.ts`
- Credential-redaction transform reads `credential-catalog.ts` to find which Node fields are sensitive
- Gist mode: `@octokit/rest` (optional dep, only loaded if `--gist` flag)
- Default mode: write template to cwd as JSON file

---

## Build justification (where we're BUILDING not ADOPTING)

Only one task requires greenfield building: **step.memory** (a trivial SQLite KV). Every other task either adopts a library directly or extends an existing in-tree pattern (chorus's repair-agent for Task 5). **No wheel is being reinvented.**

---

## Sources

- [Vercel AI SDK — Structured Data Generation](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [n8n AI Workflow Builder](https://docs.n8n.io/advanced-ai/ai-workflow-builder/)
- [Windmill AI Flow Generation](https://www.windmill.dev/docs/flows/ai_flows)
- [Windmill Hub Sharing](https://www.windmill.dev/docs/misc/share_on_hub)
- [React Flow CDN discussion #3255](https://github.com/xyflow/xyflow/discussions/3255)
- [Drawflow — GitHub](https://github.com/jerosoler/Drawflow)
- [Litegraph.js — GitHub](https://github.com/jagenjo/litegraph.js)
- [Rete.js v2 Getting Started](https://retejs.org/docs/getting-started/)
- [JsPlumb community-edition](https://github.com/jsplumb/community-edition)
- [n8n-as-code TypeScript format (community)](https://community.n8n.io/t/title-tool-workflow-tip-n8n-as-code-update-using-typescript-for-ai-generated-workflows/273862)
- [flows-ai — GitHub](https://github.com/callstackincubator/flows-ai)
- [Flowise vs Langflow](https://www.leanware.co/insights/compare-langflow-vs-flowise)
- [LangGraph JS](https://github.com/langchain-ai/langgraphjs)
- [CrewAI YAML config](https://codesignal.com/learn/courses/getting-started-with-crewai-agents-and-tasks/lessons/configuring-crewai-agents-and-tasks-with-yaml-files)
- [Jexl — npm](https://www.npmjs.com/package/jexl)
- [Appsmith export/import](https://www.appsmith.com/blog/announcing-the-import-export-feature-for-appsmith-applications)
- [Retool export/import](https://docs.retool.com/apps/guides/app-management/import-export-apps)
- [Nostr protocol](https://nostr.com/)
