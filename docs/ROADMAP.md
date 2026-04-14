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

## 1. Auto-MCP surface per integration

**Priority: 1.** This is the feature most likely to decide whether Chorus becomes agent-era infrastructure or stays a niche n8n alternative. Ranked first not because it's urgent on day 1, but because the trigger fires earlier than anything else on this list — and when it does, response time matters.

### What it is

Every deployed integration in a user's `chorus/` directory gets auto-exposed as an MCP tool. An integration defined as:

```ts
defineIntegration({
  id: "slack-send",
  operations: {
    "send-message": { input: z.object({...}), run: async (...) => ... }
  }
})
```

becomes an MCP tool `slack-send.send-message` with schema derived from Zod, reachable from Claude Desktop, Cursor, Zed, or any MCP-compatible client. No extra config.

The user's sentence that matters: *"let's ship core then get auto-mcp per integration."* This is the v1.1 headline feature; it is what turns Chorus from "a workflow runtime" into "the runtime your agent calls to do work."

### Trigger

Build when **any one** of these fires:
- 10+ users on the public registry ask (Discord/issues) "how do I expose my Chorus integrations to my agent?"
- First blog post / HN thread / tweet that describes Chorus as "a workflow runtime with MCP as a side door."
- User explicitly asks for "auto-MCP" (this user already has; counts as 1/10).
- Competitor (n8n, Activepieces, Windmill) ships agent-facing MCP exposure first.

Signal-fire in-the-wild: the moment a user says *"I already have Chorus installed for my cron webhooks, and I'd like my Claude agent to reuse the same integrations."* That's the proof-of-pull moment.

### Priority rank: 1

This outranks differential testing (which is more important for registry health) because auto-MCP is the *feature that convinces a person to install Chorus in the first place.* Registry health matters at scale; MCP matters for adoption. In 2026, "I ship workflows AND MCP tools from one config" is a single-sentence pitch that lands.

### First 3-5 concrete steps

**Day 1** — Write `@chorus/mcp` package scaffold. One directory, one `package.json` with `@modelcontextprotocol/sdk` as peer dep, mirroring the layout in `packages/runtime/`.

**Day 2** — Implement `IntegrationManifest → MCP.Tool` transform. Input: any integration's default export (already Zod-typed from the SDK per `ARCHITECTURE.md` §8.1). Output: one MCP tool per operation. Code lives in `packages/mcp/src/transform.ts`. Test cases: 3 integrations (http-generic, slack-send, a synthetic one with complex Zod unions).

**Day 3** — Wire the MCP server entrypoint. `chorus mcp` CLI command that scans `chorus/integrations/**`, transforms each manifest, and serves MCP over stdio. Reuses the existing `@chorus/runtime` to actually execute operations (not re-implemented; the MCP tool call flows into the same executor as a workflow `step.run`).

**Day 4** — Credentials. The hardest part. Workflows run with credentials from `@chorus/runtime`'s encrypted store. MCP calls need the same. Two paths: (a) require the user to alias a profile via `CHORUS_PROFILE=prod chorus mcp`, or (b) surface a credential-selection tool-call in MCP itself. Default: (a) in v1.1, (b) in v1.2.

**Day 5** — Ship. Test with Claude Desktop + Cursor + Zed. Document in `ARCHITECTURE.md` §8 as a new subsection "8.4 Auto-MCP exposure." Update `QUICKSTART.md` with a 3-line example.

### Estimated effort

**3 agent-days for the initial scaffolding**, + **0.5 day ongoing per new integration** to verify the Zod→MCP schema transform catches edge cases. Most integrations cost zero because the transform is automatic.

**Multiplicative caveat:** if we decide to collapse related operations into single tools (per `ARCHITECTURE.md` §12 open question #3), add 1 week for the collapse heuristic and bikeshedding. Recommendation: **don't collapse.** 1:1 operation→tool mapping is honest and LLM-friendly. Collapse heuristics are premature abstraction.

### Risk if delayed

Six months from now, a competitor ships auto-MCP for their workflow engine. Chorus gets positioned as "the pre-agent version of X." Users who want one-stop agent tooling bounce. The moat described in `ARCHITECTURE.md` §1.5 (cassette library) doesn't save us if the front door is closed.

**Concretely:** if n8n or Activepieces ships this before we do, our `1.4 What we are NOT` bullet #4 ("Not an MCP surface for agents — yet") becomes a permanent liability. Every agent-wielder defaults to the competitor's workflow engine because they saw the MCP tools first.

### Risk if rushed

Ship auto-MCP before the trigger fires and we have 3 problems:
1. **No real users means no real feedback on schema transforms.** We guess the Zod→MCP shape based on what feels clean. Zod has edge cases (recursive schemas, discriminated unions, refinements) where the "right" MCP representation is non-obvious. Without user pressure, we pick the wrong default.
2. **Credential-selection UX is guesswork.** Production users with 20 integrations will tell us whether profile-based or tool-call-based selection is right. Without them, we build both and own both.
3. **Ongoing maintenance burden for nothing.** Every integration we add to the reference set now has to keep its MCP shape stable. If the early schema is wrong, we break downstream agents when we fix it.

**Bottom line:** Build the `@chorus/mcp` scaffold as a 1-day sketch now (sitting in `packages/mcp/` unpublished) so we're not scrambling when the trigger fires. Don't publish until the trigger fires.

### References

- `docs/ARCHITECTURE.md` §1.4 (the current "NOT an MCP surface" bullet, which will flip when this ships)
- `docs/ARCHITECTURE.md` §8 (Integration SDK — Zod manifests are the input to the MCP transform)
- `docs/ARCHITECTURE.md` §12 open question #3 (MCP surface shape)

---
