# Changelog

All notable changes to Chorus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While Chorus is in `0.x`, **minor versions may include breaking changes**. Once we
hit `1.0.0`, semver applies strictly. Patch releases (`0.x.Y`) are always
backwards-compatible bug fixes.

## [Unreleased]

Nothing yet — `0.1.0` is the current edge.

## [0.1.0] — 2026-04-14

The first publishable cut. End-to-end MVP: workflow runtime, signed patch
registry client, failure reporter with PII redaction, Claude-powered repair
agent, CLI, two reference integrations, agent-built UI substrate, federation
ops layer, typed credential catalog, auto-MCP per integration, event triggers
with durable replay, and npm publication scaffolding.

### Added

#### Workflow runtime (`@chorus/runtime`)

- SQLite-backed workflow execution engine with replay-based durable execution
  (Inngest-pattern); completed steps never re-execute after a process restart
- Subprocess sandbox per step (`child_process.fork` + IPC) — Windows-compatible
  for MVP; nsjail upgrade tracked in `docs/ROADMAP.md`
- Cron, webhook (Fastify routes with HMAC signature support), manual, and event
  triggers
- `step.waitForEvent` durable wait primitive — survives process restart
- Retry with exponential backoff + jitter; per-node `onError` policy
  (`fail | continue | retry`)
- AES-256-GCM credential storage; key from `CHORUS_ENCRYPTION_KEY`
- Proactive OAuth 2.0 refresh cron (5-min tick, refreshes 10 min before
  expiry — never on failure to avoid race conditions with retries)
- Read-only JSON API (`/api/manifest`, `/api/workflows`, `/api/runs`,
  `/api/errors`, `/api/patches`, `/api/integrations`) bound to 127.0.0.1 by
  default; bearer-token auth via `CHORUS_API_TOKEN`
- Write API: `POST /api/events` (event firing), and after wire-romeo's pass
  also OAuth callback + write-side credential CRUD

#### Typed credential catalog (`@chorus/core` + `@chorus/runtime`)

- New `CredentialTypeDefinition` schema declares per-integration credential
  types with fields, OAuth flow metadata, deep-link URLs to creation pages,
  and optional `test()` operation
- `IntegrationManifest.credentialTypes[]` (default `[]`, backwards-compatible
  with legacy single-`authType` integrations via the resolver)
- `IntegrationModule.testCredential?(typeName, ctx): Promise<CredentialTestResult>`
  — `chorus credentials test <id>` validates a credential by pinging the
  service (e.g., `auth.test` for Slack)
- `defaultOAuth2Refresh` implements RFC 6749 §6 token-refresh using each
  catalog entry's `oauth.tokenUrl`, replacing per-integration refresh logic
- `ExpiryAlarm` cron emits `credential.expiring` events 7 days before the
  rotation deadline for non-OAuth tokens (PATs, API keys); idempotent across
  ticks via `<id>@<updated_at>` cache

#### Signed patch registry (`@chorus/registry`)

- Ed25519 sign/verify (primary, ships in MVP)
- Sigstore keyless signing path documented; CI workflow lives in
  `federation/github-actions/sign-patch.yml`
- Canary ladder: 1% → 2% → 5% → 10% → 20% → 50% → 100% over 7 days
  (4-hour expedited path for security patches; both still go through 1%)
- Reputation-gated auto-approval; sensitive scopes (auth/secrets/network)
  always require human review regardless of reputation
- Revocation list polled every 5 min (signed JSON, CDN-cached for 60s)
- `git-store` reads/writes patches against a Homebrew-style git registry

#### Failure reporter (`@chorus/reporter`)

- Stable error signature extraction (Sentry-style fingerprinting + stack
  pattern + HTTP status + integration version)
- 9 PII redaction patterns (email, credit card, phone, JWT, API keys,
  Bearer tokens, IPv4, SSN, AWS keys) with end-to-end leak test asserting
  no PII reaches the wire body even from deeply nested errors
- Multi-stage redaction: SDK → registry → storage; allowlist-based,
  fail-closed
- Config fingerprinting (shape, not values); cassette index by `signatureHash`
  for O(1) lookup

#### Repair agent (`@chorus/repair-agent`)

- Claude-powered patch proposer with strict unified-diff parsing (8 dedicated
  rejection tests for prose contamination)
- Cassette replay validation: real `git apply` + `node` subprocess, not
  mocked — known-good and known-bad patches both exercised
- Reputation floor on community submissions (default 100); private mode
  writes to `~/.chorus/patches/pending/` for local-only fixes
- Stub mode when `ANTHROPIC_API_KEY` unset (lets you test without burning
  tokens)

#### Auto-MCP per integration (`@chorus/mcp`)

- `@modelcontextprotocol/sdk@1.29.0` low-level Server with stdio transport
- `chorus mcp <list | generate | serve | config>` CLI
- 4 MCP tools generated per integration: `<integration>__<operation>` plus
  `__list_credentials`, `__configure_<typeName>`, `__test_auth`. OAuth-typed
  credentials get an additional `__authenticate` tool.
- `chorus mcp generate slack-send` produces a self-contained scaffold under
  `mcp-servers/chorus-slack-send/` ready to drop into Claude Desktop /
  Cursor / Zed via `.mcp.json`
- `chorus mcp serve <integration>` starts an MCP server in the current
  process for fast iteration

#### Agent-built UI

- No hardcoded dashboard. The runtime exposes a self-describing JSON API
  (`/api/manifest`) and ships a polished prompt template via
  `chorus ui --prompt`. Users paste it into Claude / ChatGPT / Cursor
  with their style preference and the agent generates a single-file HTML
  dashboard tailored to their workflow
- `examples/ui/minimal.html` — 5KB vanilla-JS reference dashboard for
  users without an agent

#### Federation ops layer (`federation/`)

- Drop-in registry git-repo template (LICENSE, CONTRIBUTING, CODEOWNERS,
  patches/, signed `revoked.json` skeleton, trusted-signers stubs)
- 4 GitHub Actions workflows: `sign-patch`, `canary-promote`,
  `publish-revocation`, `abort-on-spike`. All use OIDC trusted-publisher
  pattern (no static secrets)
- CDN tooling: `publish-revocation.sh` + `validate-revocation.ts` with
  signature chain verification
- `RUNBOOK.md` — 1,989 words covering one-time setup, incident playbook
  (5-min revoke), maintainer rotation, cost model (free at 10k users on
  Cloudflare R2)

#### Reference integrations (`@chorus/integration-*`)

- `http-generic` — credential-less HTTP client with timeout + cassette
  recording; 16 tests
- `slack-send` — `chat.postMessage` via bot token; declares
  `slackUserToken` credential type with `test()` calling `auth.test`;
  proper rate-limit + auth error mapping; 27 tests

#### CLI (`@chorus/cli`)

- `chorus init` — scaffolds project + generates encryption key + Ed25519
  keypair
- `chorus run` — starts the runtime; SIGTERM/SIGINT-safe
- `chorus report` — recent runs, error signatures, known patches
- `chorus validate <workflow.yaml>` — schema-check
- `chorus patch <list|apply|propose|revoke>` — patch lifecycle
- `chorus credentials <add|list|remove|test|pat-help|types|migrate>` — secure
  credential management; `pat-help` opens deep-link to creation page
- `chorus mcp <list|generate|serve|config>` — auto-MCP per integration
- `chorus event <fire|watch|list-waiting>` — event triggers + waitForEvent
  introspection
- `chorus ui [--prompt|--example|--serve]` — the agent-built UI bridge
- Inline YAML subset parser (no `js-yaml` dependency)

#### npm publication scaffolding

- All 9 publishable packages: `publishConfig` with `provenance: true`,
  `repository` block, `keywords`, `author`, `license`, `bugs`, `homepage`,
  `prepublishOnly` script
- OIDC Trusted-Publisher CI workflow
  (`.github/workflows/publish-npm.yml`) — no static `NODE_AUTH_TOKEN`
- `scripts/bump-version.js` — atomic lockstep version bumps via
  `npm version --workspaces` (auto-discovers new workspaces)
- `scripts/check-publish-ready.sh` — 113-check smoke test
- `docs/NPM_PUBLISH.md` — 1,624-word runbook (one-time setup, release flow,
  manual fallback, rollback, semver, troubleshooting)

#### Documentation

- `docs/ARCHITECTURE.md` — 8,286 words, 12 sections, 18 code blocks, 3 ASCII
  diagrams (the implementer's bible)
- `docs/ROADMAP.md` — 5,197 words covering 7 deferred items with explicit
  triggers, first-3-steps, effort estimates, and risks-if-delayed/risks-if-rushed
- `docs/CREDENTIALS_ANALYSIS.md` — 4,996 words on the n8n typed-catalog
  pattern and how Chorus extends it
- `docs/MCP_GUIDE.md` — auto-MCP user-facing guide
- `docs/EVENT_TRIGGERS.md` — event triggers + `step.waitForEvent`
- `docs/UI_GENERATOR.md` + `docs/UI_PROMPT_TEMPLATE.md` — the agent-built UI
  story
- `federation/RUNBOOK.md` — federation ops standup
- 3 research docs in `docs/research/` (~2,072 lines) covering workflow
  engines, patch registries, and error-signature/redaction/snapshot-testing
  prior art

### Test totals

- 9 packages
- 49 test files
- **627 tests, 0 failures** (all verified on DGX Spark — local 16GB OOMs
  on the full suite)

### Known limitations & deferred work

- First publish must be **manual** (`npm publish --access public --provenance`
  for each `@chorus/*` package). npm Trusted
  Publisher binding requires the package name to exist before configuration.
  Once `0.1.0` is on the registry, all subsequent versions ship via CI.
- Fine-grained canary percentages (1/2/5/10/20/50) are coarse-binned to
  `canary-1`/`canary-10`/`canary-100` in the patch metadata enum;
  expanding the enum is a v1.x core-schema change
- Differential testing gate (Gate C in the threat model) deferred to
  month 6 — see `docs/ROADMAP.md` §4
- nsjail / hardened sandbox is Linux-only opt-in; deferred behind a flag
  per `docs/ROADMAP.md` §3
- Postgres queue migration triggered only by multi-node operation —
  `docs/ROADMAP.md` §2

[Unreleased]: https://github.com/LamaSu/federated-workflow-runtime/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LamaSu/federated-workflow-runtime/releases/tag/v0.1.0
