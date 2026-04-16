# Chorus

**Federated workflow runtime with crowd-sourced integration maintenance.**

n8n for the agent era — self-hosted, AI-repaired, signed patches propagate across the fleet.

## What it is

Chorus is a workflow engine you run on your own box. It fires workflows on webhooks, cron, or manual triggers, and calls out to the SaaS services you use (Slack, Stripe, Linear, Postgres, Gmail, etc.).

When an integration breaks — because a vendor changed their API, an auth scheme rotated, or a rate limit appeared — Chorus doesn't just surface the error. It tries to fix it:

1. A local repair agent reads the error, fetches the latest vendor docs, and proposes a patch.
2. The patch is validated against recorded HTTP snapshots before anything touches production.
3. If valid, the patch is signed and submitted to the shared registry.
4. Other users automatically pick up the fix — gated by a canary ladder so one bad patch doesn't brick the fleet.

**Every user's failure becomes a permanent regression test, forever. That's the moat.**

## Architecture

```
┌─ your machine ───────────────────────────────────────────┐
│                                                          │
│  runtime ─► integration ─► external API                  │
│     │           │                                        │
│     │           └──► (on failure)                        │
│     ▼                                                    │
│  reporter ──► signature + redaction                      │
│     │                                                    │
│     ▼                                                    │
│  repair-agent ──► fetches docs, proposes patch           │
│     │                                                    │
│     ▼                                                    │
│  snapshot-test ──► validates against recorded traffic   │
│     │                                                    │
└─────┼────────────────────────────────────────────────────┘
      │ (signed patch)
      ▼
┌─ shared registry (git repo + signatures) ────────────────┐
│                                                          │
│  canary ladder: 1 → 10 → 100 → fleet                    │
│  reputation weighted                                     │
│  kill switch per-patch                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
      │ (propagates fixes)
      ▼
   everyone else's runtime
```

## Packages

- `packages/core` — shared types, Zod schemas, error signature format
- `packages/runtime` — workflow execution engine (cron, webhooks, retries, SQLite state)
- `packages/registry` — signed patch registry client/server
- `packages/reporter` — failure capture + PII redaction + signature extraction
- `packages/repair-agent` — Claude-powered patch proposer + validator
- `packages/cli` — the `chorus` CLI

## Integrations

- `integrations/http-generic` — make any HTTP call
- `integrations/slack-send` — send a Slack message (reference integration)

More integrations are added as community patches via the registry.

## Design principles

1. **Self-hosted, credentials never leave your box.** The registry only receives redacted error signatures, never payloads.
2. **Fail loudly, fix automatically.** Silent failures are the enemy; Chorus assumes you want the incident surface, not hidden.
3. **One integration per user, not 400 per company.** Chorus maintains the ~20 integrations you actually use. The long tail is community-maintained.
4. **Bounded blast radius.** Every patch ships through static analysis, sandbox execution, differential testing, canary ladder. One bad patch hits 1 user, not 10k.
5. **AI is a tool, not a governor.** The repair agent proposes; the test suite + canary ladder + user approval decide.

## Status

Early. See `docs/ARCHITECTURE.md` for the full design and `docs/ROADMAP.md` for what's coming.

> **No demo video yet** — the author's laptop is currently OOM from 24 concurrent Claude Code instances running in terminal tabs. Once RAM is reclaimed, a proper walkthrough lands here.

## Install

```bash
npm install -g @delightfulchorus/cli
chorus init
```

That's it. `chorus init` scaffolds a `./chorus/` directory in the current folder, generates an Ed25519 keypair + AES encryption key, and creates an example workflow. Then `chorus run` starts the runtime.

### Other install shapes

**Zero-install one-liner** — runs once from npm's cache, nothing left on disk:
```bash
npx @delightfulchorus/cli init
```

**Per-project (pinned version, recommended for teams)**:
```bash
npm install --save-dev @delightfulchorus/cli
npx chorus init
```

The CLI binary is always `chorus`. The scoped npm name (`@delightfulchorus/cli`) is only the package identifier — you never type it after a global install.

## Running the federation side

The client-side packages in `packages/*` are half the story. Operators who want to host a patch registry (org-private or public) should start at [`federation/RUNBOOK.md`](federation/RUNBOOK.md) — it covers the registry repo template, GitHub Actions workflows, CDN revocation-list tooling, and the 5-minute incident playbook.

## Quickstart

See [QUICKSTART.md](QUICKSTART.md).

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data model, trust boundaries
- [ROADMAP.md](docs/ROADMAP.md) — what's coming, with triggers and concrete steps
- [CREDENTIALS_ANALYSIS.md](docs/CREDENTIALS_ANALYSIS.md) — typed credential catalog (n8n-inspired)
- [MCP_GUIDE.md](docs/MCP_GUIDE.md) — auto-MCP per integration for any agent
- [EVENT_TRIGGERS.md](docs/EVENT_TRIGGERS.md) — event triggers + `step.waitForEvent`
- [UI_GENERATOR.md](docs/UI_GENERATOR.md) — agent-generated dashboards
- [federation/RUNBOOK.md](federation/RUNBOOK.md) — operator standup for hosting a registry
- [CHANGELOG.md](CHANGELOG.md) — release notes

## License

MIT
