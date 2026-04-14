# Chorus Roadmap

*Last updated: 2026-04-14. Author: roadmap-lima (session 2). Supersedes `ARCHITECTURE.md` §11.2/§11.3 where this doc is more specific.*

## What this doc is

Seven things we deliberately left out of v1.0 so MVP could ship. For each one: **when** the work should start, **what** the first concrete steps look like, **how long** it costs, **what** breaks if we wait too long, and **what** breaks if we rush. Triggers are specific — a metric, a user complaint, a failure rate — not "when we feel ready."

## What this doc is not

- Not a product spec. Each item links back to the existing code or architecture section that would be extended.
- Not a wishlist. Every item here has a concrete trigger and we don't start until that trigger fires.
- Not versioned against calendar months (e.g., "Q3 2026"). The agent era makes calendar planning meaningless; we ship when signals fire.
- Not a substitute for `docs/ARCHITECTURE.md`. Read that for the thesis; read this to know what happens *after* v1.0.

The seven items: (1) auto-MCP surface, (2) Postgres migration path, (3) nsjail sandbox, (4) differential testing gate, (5) npm package + installer, (6) event triggers + `step.waitForEvent`, (7) the UI question (reframed — Chorus will not ship a hardcoded UI, ever).

Two decision frameworks close the doc: *auto-MCP vs. skills+CLI* (the user asked for this explicitly), and *when to migrate to Postgres* (with metrics).

## At a glance

| # | Item | Trigger | Priority | Effort | Build now vs wait? |
|---|------|---------|----------|--------|---------------------|
| 1 | Auto-MCP surface per integration | First 10 users on Claude Desktop/Cursor ask "how do I expose this to my agent?" | **1** | 3 agent-days for scaffolding + 0.5/integration ongoing | **Wait** for signal, then 2 weeks turnaround |
| 2 | Postgres migration path | First user hits 100k rows in `runs` or 50+ concurrent runs | **4** | 5 engineer-days (schema + migrator + tests) | **Wait.** Over-engineered if built early. |
| 3 | nsjail / hardened sandbox | First malicious-patch report or first enterprise security review | **5** | 4 engineer-days Linux + 3 for audit | **Wait.** Subprocess is sufficient through v1.x. |
| 4 | Differential testing as gate | Month 6 post-launch **OR** first regression leak past canary | **3** | 4 engineer-days (harness exists, gate flip is small) | **Soon.** Build in v1.1 as informational, flip to gate on trigger. |
| 5 | npm publish + installers | Day 1 — this is packaging, not product | **2** | 2 agent-days for npm + 3 for Homebrew/MSI | **Now.** Zero risk; required for `npx chorus init` to work. |
| 6 | Event triggers + `step.waitForEvent` | First integration author blocked by inability to wait for async webhook | **3** | 3 agent-days (runtime extension) | **Soon.** Natural v1.1 feature. |
| 7 | UI (reframed) | Never as "drag-drop." Never as hardcoded dashboard. Reference UI *maybe* if agent-less users show up. | **6** | 0 for default (JSON API + prompt template) | **Ship prompt template now. Dashboard: wait for demand.** |

Priorities: 1 = ship first after MVP, 6 = last. Rationale for each ranking is in the section body.

---
