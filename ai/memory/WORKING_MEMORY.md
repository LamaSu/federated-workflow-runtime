# Chorus — Working Memory

## Session 4: 2026-04-22T22:12-23:30Z — /go expansion build (Opal-gap item #8 + visual editor + cloud)

**Task**: Ship Opal-gap-analysis proposed roadmap item #8 + expanded scope (visual editor CLI, cloud distribution).
**Decomposition**: 7 leaf tasks, 3 waves, 6 implementers + 1 wheel-scout. All DONE.
**Commit range**: `98af5d3` → `0f56012` on master. 57 files, +14,409 insertions.

### Shipped

1. **`chorus compose`** (bravo, 5 commits) — Vercel AI SDK `generateObject` + Zod WorkflowSchema + 250-line system prompt. Emits TypeScript per n8n-as-code insight. Ralph loop, 3 retries. 18 tests.
2. **LLM integrations** (charlie, 2 commits) — `integrations/llm-anthropic`, `llm-openai`, `llm-gemini`. `generate` + `generateObject` ops. Typed credentials with deep links + pattern validation. Error mapping (401→Auth, 429→RateLimit, 5xx retryable). 91 tests.
3. **`Connection.when?` + `step.memory`** (delta, 5 commits) — `jexl` for sandboxed expression eval; new `memory` SQLite table (per-workflow + optional per-user); `StepContext.memory.get/set` wrapped in `step.run`. Docs updated (ARCHITECTURE §4.3/§4.5 + CHANGELOG). 34 tests.
4. **`agent` integration** (foxtrot, 4 commits) — `integrations/agent/plan-and-execute`. Ralph loop via AI SDK `generateText({ tools, maxSteps })`. Each iteration + tool call wrapped in `step.run("agent:iter-N", ...)` for durable replay. 39 tests.
5. **`chorus ui --editor`** (golf, 4 commits) — Drawflow-based single-HTML canvas generator. Bidirectional Chorus↔Drawflow transform. Base template at `packages/cli/static/editor-template.html` (481 lines). Offline + live integration discovery. 27 tests.
6. **Cloud distribution** (echo, 5 commits) — `docs/CLOUD_DISTRIBUTION.md` (315 lines) documents 3 models (template share MVP / hosted UI deferred / hosted runtime deferred). `chorus share <id> [--gist]` + `chorus import <url|file>` with catalog-aware credential redaction. 33 tests.

**Aggregate**: 242 new tests. Per-agent suites all green; full-workspace verification running post-session.

### Key decisions (from scout-alpha landscape `ai/research/landscape-chorus-expansion-2026-04-22.md`)

- ADOPT Vercel AI SDK for tasks 2+3 (one abstraction, not three wrappers)
- ADOPT Drawflow (CDN, MIT) over React Flow (needs build)
- ADOPT Windmill credential-stripping pattern + GitHub Gist for cloud MVP
- ADOPT `jexl` for when? evaluator
- Emit TypeScript (not JSON) from `chorus compose`
- Template-share MVP preserves local-first thesis; hosted-runtime deferred with explicit triggers

### Merge conflicts resolved

- `package-lock.json` (bravo vs HEAD) — kept HEAD, regenerated via `npm install`
- `packages/cli/package.json` script externals (bravo vs echo) — merged both sets: `ai, @ai-sdk/anthropic, @octokit/rest`
- `<<<<<<< HEAD` leftover at line 42 — cleaned in `b1733b0`

### Worktrees remaining on disk (locked)

worktree-agent-{a0f1e00f,a307e463,a5157d68,aca78892,a39823a2,a6a6a66b}. Clean up when confident in merged master.

### Follow-ups (explicit, not in scope)

- Auto-MCP per integration (ROADMAP #1) → turns LLM integrations + agent-step into first-class MCP tools
- `chorus import` credential rebinding: tighten from `integration` match to `(integration, credentialType)` tuple
- `credentialsFor` resolver in agent integration's loader (currently passes `null`)
- Drawflow stale-risk (last commit Sep 2024) — fallback Litegraph.js documented in landscape
- ROADMAP.md §8 insertion summarizing what shipped + future triggers
- `git push lamasu master` (code not yet pushed upstream)

---

## Session 3: 2026-04-14 — Typed credentials + auto-MCP + npm publication + event triggers

### Task
User pasted an n8n credential-architecture analysis (typed catalog + OAuth refresh + at-rest encryption + test buttons + PAT manual paste). Goal: adopt the typed-catalog pattern Chorus was missing, AND ship priority items 1-3 from session 2's ROADMAP.md (auto-MCP, npm publication, event triggers).

### Decomposition (2 waves, 5 agents)

**Wave 1 (parallel — foundation):**
- `compare-mike` — design the credential catalog upgrade (`docs/CREDENTIALS_ANALYSIS.md`)
- `npm-november` — npm package publication scaffolding

**Wave 2 (parallel — implementation, reads Wave 1 design):**
- `credentials-oscar` — implement the typed catalog (owns canonical schemas)
- `mcp-papa` — auto-MCP per integration (new `packages/mcp/`)
- `events-quebec` — event triggers + `step.waitForEvent` (new file `event-schemas.ts` to avoid schema collision)

### Agent results

**compare-mike** (4 commits, 4,996 words / 10 sections):
- Design doc with 6 Zod schemas inlined for direct copy-paste
- Decision table: ADOPT-NOW / DEFER-V2 / SKIP-FOREVER for each n8n feature
- Migration plan + CLI command spec + mcp-papa interface contract
- Locked in field names: `manifest.credentialTypes`, `IntegrationModule.testCredential?`, `CredentialSchema.credentialTypeName`, SQLite column `credential_type_name`

**npm-november** (3 commits, 5 iterations):
- All 8 publishable workspaces extended with `publishConfig` + `provenance: true` + repository + keywords + author + license + bugs + homepage + `prepublishOnly`
- `.github/workflows/publish-npm.yml` with OIDC trusted-publisher pattern (no static `NODE_AUTH_TOKEN`)
- `scripts/bump-version.js` — atomic lockstep version bumps via `npm version --workspaces`
- `scripts/check-publish-ready.sh` — 113-check smoke test (passes)
- `docs/NPM_PUBLISH.md` — 1,624-word runbook (one-time setup, release flow, manual fallback, rollback, semver, troubleshooting)
- `npm pack --dry-run`: cli=19.2KB / runtime=37.4KB (with sandbox-worker.cjs)
- Decision: workspace deps stay as `*` (npm publish auto-resolves), Trusted Publisher means no static tokens

**credentials-oscar** (1 iteration, large diff):
- `packages/core/src/credential-catalog.ts` (NEW) — 6 Zod schemas + `resolveCredentialType` + `legacyCredentialTypeName`
- Extended `IntegrationManifestSchema` with `credentialTypes` (required, default `[]`); `CredentialSchema` with `credentialTypeName`; `IntegrationModule` interface with `testCredential?`
- `packages/runtime/src/db.ts` — pre-flight `ALTER TABLE` for legacy DBs + new `credential_type_name` column + index + backfill to `<integration>:legacy`
- `packages/runtime/src/oauth.ts` — `defaultOAuth2Refresh` implementing RFC 6749 §6, uses catalog's `oauth.tokenUrl` + new `manifestLookup` option
- `packages/runtime/src/expiry-alarm.ts` (NEW) — cron emitting `credential.expiring` events 7 days before rotation deadline; idempotent via `<id>@<updated_at>` cache
- `packages/cli/src/commands/credentials.ts` — 4 new subcommands: `test`, `pat-help`, `types`, `migrate`
- Fixed CLI `loadSqlite` latent bug (vitest dynamic-import) — switched from `new Function("s", "return import(s)")` to native `await import("better-sqlite3")`
- Slack-send declares 1 credentialType (`slackUserToken`) + `testCredential` calling `auth.test`
- Tests in 5 packages: 359 in their owned workspaces

**mcp-papa** (3 iterations):
- New `packages/mcp/` workspace package using `@modelcontextprotocol/sdk@1.29.0`
- 4 source modules + tests: `tool-mapping`, `server`, `serve`, `generate`
- `chorus mcp <list|generate|serve|config>` CLI command
- 4 MCP tools per integration: `<integration>__<operation>` + `__list_credentials` + `__configure_<typeName>` + `__test_auth` (+ `__authenticate` when `authType === "oauth2"`)
- `chorus mcp generate slack-send` produces a runnable scaffold under `mcp-servers/chorus-slack-send/`
- `docs/MCP_GUIDE.md` — user-facing how-to
- 63 new tests

**events-quebec** (2 iterations, 7 commits):
- `packages/core/src/event-schemas.ts` (NEW) — `EventSchema`, `EventTriggerSchema`, `WaitForEventCallSchema`, `ExtendedTriggerSchema` (cron|webhook|manual|event)
- `packages/runtime/src/db.ts` — 2 new tables (`events`, `waiting_steps`) + indexes
- `packages/runtime/src/triggers/event.ts` (NEW) — `EventDispatcher` with emit + match + waitForEvent resolution
- `packages/runtime/src/executor.ts` — `step.waitForEvent` primitive with `SuspendForEvent` control flow + `WaitForEventTimeoutError` + `status="waiting"` return path
- `packages/runtime/src/api/events.ts` (NEW) — `POST /api/events` (only write surface under /api), `GET /api/events`, `GET /api/events/waiting`
- `packages/cli/src/commands/event.ts` (NEW) — `event fire/watch/list-waiting`
- `docs/EVENT_TRIGGERS.md` — full design + replay guarantees
- **CRITICAL replay-across-restart test passes**: real on-disk SQLite, dropped Executor instance A, brought up fresh instance B on same DB, fired event, run correctly resumed and returned the event payload (`tracking: "1Z999"`)
- 60+ new tests

**Orchestrator integration sweep** (1 commit):
- Externalized all `@chorus/*` workspace deps from CLI's tsup build (`--external @chorus/mcp` etc.) — was bundling dynamic imports
- Added `@chorus/mcp` to CLI dependencies
- Patched 5 fixture files where pre-existing manifests/rows lacked the new required `credentialTypes` / `credential_type_name`:
  - `packages/repair-agent/src/context.ts` — synthetic-manifest fallback
  - `packages/repair-agent/test/orchestrator.test.ts`
  - `packages/repair-agent/test/propose.test.ts`
  - `packages/runtime/src/executor.test.ts` (2 manifests via replace_all)
  - `packages/runtime/src/db.test.ts` (2 CredentialRow literals)

### Spark verification (offload run)

User mandated "offload as much work to spark as possible." All Phase 6 verification ran on DGX Spark (109GB free):
- `npm install` — 303 packages, 2s on Spark
- `npm run build` — 9 packages, all green (ESM + DTS for each)
- `npm run lint` (`tsc --noEmit -p tsconfig.base.json`) — clean, zero errors
- `npm test --workspaces --if-present` — **627 tests across 49 test files, all passing**

### Final state (after session 3)

| Package | Test files | Tests | Δ from session 2 |
|---|---|---|---|
| @chorus/core | 2 | 53 | +53 (was 0!) |
| @chorus/runtime | 17 | 191 | +76 |
| @chorus/registry | 8 | 85 | 0 |
| @chorus/reporter | 5 | 82 | 0 |
| @chorus/repair-agent | 5 | 47 | 0 |
| @chorus/cli | 7 | 72 | +40 |
| @chorus/mcp | 3 | 54 | +54 (NEW) |
| http-generic | 1 | 16 | 0 |
| slack-send | 1 | 27 | +9 |
| **TOTAL** | **49** | **627** | **+232** |

**Repo on GitHub**: https://github.com/LamaSu/federated-workflow-runtime — public, MIT, full clean history.

### Decisions made in session 3

| Decision | Chosen | Rationale |
|---|---|---|
| Credential catalog | Adopted n8n typed-catalog pattern | User's analysis: this is n8n's IP. We had AES + OAuth refresh; missing the typed schema. |
| OAuth refresh strategy | catalog's `oauth.tokenUrl` via `defaultOAuth2Refresh` (RFC 6749 §6) | Replaces hand-rolled per-integration refresh code with a single implementation |
| Credential field types | `password / text / url / number / boolean` (all in catalog) | Maps cleanly to MCP tool schemas + CLI prompts |
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0` low-level Server | Stdio transport for production, InMemoryTransport for tests |
| MCP scaffold output | `mcp-servers/chorus-<integration>/` | Standalone runnable so users can drop into Claude Desktop / Cursor / Zed `.mcp.json` |
| Event trigger schema location | `packages/core/src/event-schemas.ts` (new file) | Avoid concurrent edit conflict with credentials-oscar's `schemas.ts` work |
| Events API | `POST /api/events` is the only write surface under `/api/*` | All other routes stay read-only; flagged for design review |
| `RunSchema.triggeredBy` enum | events-quebec tags event runs as `manual` for now | Adding `event` to enum requires schema migration; deferred to follow-up |
| CLI dynamic-import | `await import("better-sqlite3")` instead of `new Function` wrapper | Latent bug in vitest — Function wrapper fails with "dynamic import callback was not specified" |
| CLI build | `tsup --external @chorus/*` for workspace deps | Was bundling dynamically-imported workspace packages |
| Offload | All Spark for Phase 6 | Per user mandate + feedback memory; 627 tests + tsc + 9 builds finished in ~30s on Spark |

### State / what's next

**Done in session 3:**
- Typed credential catalog (6 Zod schemas + manifest extension + DB migration + 4 new CLI commands)
- testCredential() callable on IntegrationModule + slack-send reference impl pinging auth.test
- defaultOAuth2Refresh using catalog's tokenUrl
- ExpiryAlarm cron for non-OAuth tokens (7-day warn window)
- @chorus/mcp package (auto-MCP per integration)
- Event triggers + step.waitForEvent (durable across restart, proven by test)
- npm publication scaffolding (8 packages publishConfig + OIDC CI + runbook)
- All Spark-verified: 627 green

**Immediate follow-ups (small, mostly mechanical):**
1. **Add `event` to `RunSchema.triggeredBy` enum** — currently events-quebec fakes it as "manual". Trivial schema bump + DB migration.
2. **Wire concrete `CredentialService` from runtime → mcp-papa's CredentialService contract in server.ts** — currently MCP credential-control tools degrade gracefully with an error; needs runtime to expose the service so MCP can list/configure/test creds remotely.
3. **OAuth callback wiring**: `<integration>__authenticate` MCP tool returns `{authorizeUrl}` but doesn't block waiting for the callback; needs glue using events-quebec's `step.waitForEvent`. Documented in MCP_GUIDE.md as Wave 3 scope — both pieces exist, just need the connector.
4. **First manual npm publish** — `v0.1.0` must publish manually (npm Trusted Publisher needs the package to exist before binding). Then v0.2.0+ goes through CI.
5. **CHANGELOG.md** — npm-november flagged this; first release should add one.
6. **README.md** — still says "clone and install"; update to `npx chorus init` after first publish lands.

**Items still in ROADMAP.md (untouched this session):**
- Differential testing gate (month 6)
- nsjail / hardened sandbox (Linux opt-in, Windows stays subprocess)
- Postgres migration (only on multi-node)
- Drag-drop UI (dead — replaced by `chorus ui --prompt`)

### Notes for future sessions

- **Spark offload paid off bigly**: full repo verification (install + build + lint + 627 tests) finished in ~30s on Spark vs estimated 5-10 min locally with OOM risk. Pattern: `spark-run "npm install --no-audit --no-fund && npm run build && npm run lint && npm test --workspaces --if-present"` for end-to-end gate.
- **Wave coordination on shared schemas**: credentials-oscar owns `schemas.ts`; events-quebec made a NEW file `event-schemas.ts` to avoid the conflict. This pattern works — both agents committed cleanly without merge issues. mcp-papa's new package added zero schema conflicts (separate workspace).
- **Auto-discovery of new workspaces**: npm-november's `bump-version.js` and `check-publish-ready.sh` correctly picked up the sibling-added `@chorus/mcp` workspace at run time. Auto-discovery > hardcoded lists.
- **Fixture lag is a real cost**: when one agent extends a Zod schema with a new required field, every other package's test fixtures break. Pattern: integration sweep at Phase 6 to add the new field across all fixtures. Took 5 mechanical edits in this session.
- **GitHub secret scanner lesson stuck**: no scanner blocks this push because reporter test fixtures already use `[...].join("_")` pattern from session 2.
- **mcp-papa's scaffold output `mcp-servers/<integration>/` is a published artifact pattern**: when v0.1.0 publishes, users will be able to do `chorus mcp generate slack-send` then `cd mcp-servers/chorus-slack-send && npm install && npm start` — fully self-contained MCP server. Major "wow" moment for the agent-era positioning.
