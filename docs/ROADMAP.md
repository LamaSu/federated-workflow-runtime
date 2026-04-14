# Chorus Roadmap

*Last updated: 2026-04-14. Author: roadmap-lima (session 2). Supersedes `docs/ARCHITECTURE.md` §11.2/§11.3 where this doc is more specific.*

## What this doc is

Seven things we deliberately left out of v1.0 so MVP could ship. For each: **when** the work should start (a concrete trigger, not a calendar date), **what** the first steps look like, **how long** it costs, and **what** breaks if we wait or rush.

## What this doc is not

- Not a product spec — each item points back to existing code and architecture sections.
- Not a wishlist — every item has a trigger, and we do not start until it fires.
- Not calendar-versioned (no "Q3 2026"). The agent era makes calendar planning meaningless.
- Not a substitute for `docs/ARCHITECTURE.md`. Read that for the thesis; read this for what happens after v1.0.

Seven items: (1) auto-MCP surface, (2) Postgres migration, (3) nsjail sandbox, (4) differential-testing gate, (5) npm publication, (6) event triggers + `step.waitForEvent`, (7) UI (reframed — Chorus will not ship a hardcoded UI, ever).

Two decision frameworks close the doc: *auto-MCP vs. skills+CLI* and *when to migrate to Postgres*.

## At a glance

| # | Item | Trigger | Priority | Effort | Build now vs wait? |
|---|------|---------|----------|--------|---------------------|
| 1 | Auto-MCP surface per integration | 10+ users ask "how do I expose this to my agent?" | **1** | 3 agent-days scaffold + 0.5/integration | **Wait** for signal, then 2-week turnaround |
| 2 | Postgres migration path | 100k+ rows in `runs`, or 50+ concurrent runs | **4** | 5 engineer-days | **Wait.** Over-engineered if built early. |
| 3 | nsjail / hardened sandbox | Malicious-patch report or enterprise security review | **5** | 4 engineer-days + 3 for audit | **Wait.** Subprocess is sufficient through v1.x. |
| 4 | Differential testing as gate | Month 6 post-launch OR first regression past canary | **3** | 4 engineer-days | **Soon.** Ship informational in v1.1, flip to gate on trigger. |
| 5 | npm publish + installers | Day 1 — this is packaging, not product | **2** | 2 agent-days npm + 3 Homebrew | **Now.** Required for `npx chorus init`. |
| 6 | Event triggers + `step.waitForEvent` | First integration author blocked on async webhook | **3** | 3 agent-days | **Soon.** Natural v1.1 feature. |
| 7 | UI (reframed) | Never as drag-drop. Reference dashboard only if agent-less users appear. | **6** | 0 for default | **JSON API now. Dashboard: wait for demand.** |

Priorities: 1 = ship first after MVP, 6 = last. Rationale in each section.

---

## 1. Auto-MCP surface per integration

**Priority: 1.** The feature most likely to decide whether Chorus becomes agent-era infrastructure or stays a niche n8n alternative. Ranked first because when its trigger fires, response time matters. The user's own words: *"let's ship core then get auto-mcp per integration."*

### What it is

Every integration in a user's `chorus/` directory is auto-exposed as an MCP tool. An integration manifest like `defineIntegration({ id: "slack-send", operations: { "send-message": {...} } })` becomes an MCP tool `slack-send.send-message`, with JSONSchema derived from the existing Zod schema. Reachable from Claude Desktop, Cursor, Zed, or any MCP-compatible client. No extra config.

This turns Chorus from "a workflow runtime" into "the runtime your agent calls to do work."

### Trigger

Build when any one fires:
- **10+ users on the registry ask** (Discord/issues) "how do I expose my Chorus integrations to my agent?"
- **First public write-up** (blog, HN, tweet) describing Chorus as "a workflow runtime with MCP as a side door."
- **User explicitly asks** for auto-MCP (this user already has; counts as 1/10).
- **Competitor ships first.** n8n, Activepieces, or Windmill ships agent-facing MCP exposure.

Signal in the wild: *"I already have Chorus installed for my cron webhooks, can my Claude agent reuse these integrations?"* That's proof-of-pull.

### First 3-5 concrete steps

1. **`@chorus/mcp` package scaffold** — peer dep on `@modelcontextprotocol/sdk`, mirror `packages/runtime/` layout.
2. **`IntegrationManifest → MCP.Tool` transform** — lives in `packages/mcp/src/transform.ts`. Zod JSONSchema conversion already exists. Test against 3 integrations (http-generic, slack-send, one synthetic with complex unions).
3. **`chorus mcp` CLI entrypoint** — scans `chorus/integrations/**`, serves MCP over stdio. Delegates execution to `@chorus/runtime` (same executor as `step.run`; no duplicate logic).
4. **Credential wiring** — MCP calls need the runtime's encrypted credential store. v1.1: `CHORUS_PROFILE=prod chorus mcp`. v1.2: credential-selection tool-call in MCP itself.
5. **Ship** — test with Claude Desktop + Cursor + Zed. Add `ARCHITECTURE.md` §8.4 "Auto-MCP exposure." Update `QUICKSTART.md` with a 3-line example.

### Estimated effort

**3 agent-days scaffold + 0.5 day/integration** to verify edge cases. Most integrations are free because the transform is automatic. If we collapse related operations into single tools (per `ARCHITECTURE.md` §12 Q3), add 1 week; **don't collapse** — 1:1 is LLM-friendly and honest.

### Risk if delayed

Competitor ships first. Chorus becomes "the pre-agent version of X." The `ARCHITECTURE.md` §1.4 bullet "Not an MCP surface — yet" becomes a permanent liability; the cassette-library moat doesn't save us if the front door is closed.

### Risk if rushed

1. **No real feedback on Zod→MCP transform.** Zod has edge cases (recursive schemas, refinements, discriminated unions) with no obvious MCP representation. Ship early and we pick the wrong default, then break downstream agents when we fix it.
2. **Credential UX is guesswork** without production users to say whether profile-based or tool-call-based selection works.
3. **Maintenance for no users.** Every integration now has to keep MCP shape stable.

**Bottom line:** Build a 1-day scaffold **now** (sitting in `packages/mcp/` unpublished) so we're not scrambling when the trigger fires. Don't publish until triggered.

### References

- `docs/ARCHITECTURE.md` §1.4 (the "NOT an MCP surface" bullet to flip)
- `docs/ARCHITECTURE.md` §8 (Integration SDK — Zod manifests feed the transform)
- `docs/ARCHITECTURE.md` §12 Q3 (MCP surface shape — 1:1 vs. collapsed)

---

## 2. Postgres migration path

**Priority: 4.** Low because SQLite's ceiling is genuinely high and the trigger is quantifiable. We win by waiting.

### What it is

`@chorus/runtime` persists to SQLite via `better-sqlite3` (`docs/ARCHITECTURE.md` §4.5). Queue claim uses `UPDATE ... LIMIT 1 RETURNING` (§4.1). Postgres migration is a one-way CLI:

```
chorus migrate --to postgres --url postgres://user:pass@host/chorus
```

Creates schema, copies rows in order (credentials → workflows → runs → steps → events), flips backend, sanity-checks that pending runs are re-queryable. **No reverse migration**; users pick a direction.

### Trigger

Real user (not hypothetical) hits any one:
- **100k+ rows in `runs`** on a single node (SQLite WAL fsync limits bite around here).
- **50+ concurrent in-flight runs** (tail latency climbs past ~30).
- **User asks** because they want HA across two nodes (implies shared queue).
- **SQLite file > 5 GB** (backup/restore becomes painful).

Free action item for v1.1: add `warn_on_scale_threshold` to surface approaching thresholds in `chorus status`. ~20 lines.

### First 3-5 concrete steps

1. **`packages/runtime/src/db/postgres/schema.sql`** — translated from the SQLite schema (`INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`, `TEXT` stays, `JSON` → `jsonb`).
2. **Driver abstraction** — `packages/runtime/src/db/driver.ts` with `query`/`queryOne`/`exec`/`transaction`. Implement `SqliteDriver` and `PostgresDriver`. Swap call sites; no behavior change.
3. **Rewrite queue claim** — SQLite's `UPDATE ... LIMIT 1 RETURNING` vs. Postgres's `SELECT ... FOR UPDATE SKIP LOCKED`. Driver-specific SQL templates.
4. **`packages/cli/src/commands/migrate.ts`** — order-aware, chunked (1k runs, 10k steps), resume-safe via checkpoint table.
5. **Dual-backend test suite** — all 81 existing runtime tests must pass on Postgres in Docker before shipping.

### Estimated effort

**5 engineer-days.** Driver abstraction is the hard part; schema port is trivial. Test-on-both-backends discipline is non-negotiable.

### Risk if delayed

Low. SQLite is genuinely fast. The sophisticated user who hits the trigger can fork a custom driver for a month while we build it right. One real risk: a team tries Chorus on shared infrastructure (GitOps, CI-triggered flows, multiple deploys → same state) and hits SQLite's single-writer wall. Doc note in §11 already warns about this.

### Risk if rushed

High. If we ship Postgres mode in v1.1 without a real user pushing traffic through it, we'll find out about row-order bugs, deadlocks on the queue claim, and WAL-vs-replication surprises in someone's production.

**Hottest diff:** the queue claim. `SKIP LOCKED` fairness differs from SQLite's `UPDATE ... LIMIT 1`. A workflow with 200 parallel retries can starve the queue if `FOR UPDATE` placement is wrong. Test against a synthetic 10k-run fixture before any real user sees it.

### References

- `docs/ARCHITECTURE.md` §4.1 (queue claim — the riskiest query)
- `docs/ARCHITECTURE.md` §4.5 (SQLite schema)
- `docs/ARCHITECTURE.md` §11.3 (Postgres as v2)
- `docs/ARCHITECTURE.md` §12 Q1 (migration path shape)

---

## 3. nsjail / proper sandbox

**Priority: 5.** Lowest of the real-work items because subprocess is genuinely sufficient for MVP users, and every sandbox hardening step adds cross-platform pain.

### What it is

Today (`ARCHITECTURE.md` §4.4), each Run is a fresh Node subprocess — no shared memory, no shared FS beyond `PATH`, one-shot credentials, stdin/stdout JSON communication.

nsjail wraps that in a Linux namespace jail: FS namespace (curated `/`), PID namespace (no sibling signals), network namespace (configurable egress), cgroup (RAM/CPU caps). Same subprocess, hardened shell. **Linux-only**; behind a flag: `CHORUS_SANDBOX=nsjail`, silently ignored elsewhere.

### Trigger

Any one fires:
- **First malicious-patch report.** A user says "a registry patch tried to read my `.ssh/`" — even if the static AST gate blocked it, the attempt is the signal.
- **First enterprise security review.** Procurement says "we need defense-in-depth for the integration layer" and subprocess-only doesn't check the box.
- **CVE or exploit** in `better-sqlite3`, `pg`, `node`, or a reference integration that lets malicious code exfiltrate from the subprocess.
- **Hostile cassette in the wild** — a replay cassette attempting filesystem or DNS side-channels.

Until one fires, we are fighting shadows. Subprocess already blocks the 90% case (accidental credential leak in patch code).

### First 3-5 concrete steps

1. **`packages/runtime/src/sandbox/nsjail.ts`** — thin wrapper around `nsjail -C /etc/chorus-nsjail.cfg -- node run-step.js`. Config enumerates mounts, PID limits, CPU time, `/tmp` isolation per-run.
2. **`Sandbox` interface extension** — today just subprocess. Add `NsjailSandbox` driver. Read `CHORUS_SANDBOX=subprocess|nsjail`; default subprocess.
3. **Reference Docker image** `chorus:latest-hardened` — nsjail + Node 20 + Chorus CLI, the deployment target for Linux hardening users.
4. **Test suite on `ubuntu-latest` CI** — nsjail-wrapped runs must fail to open `/etc/passwd`, fail to fork > N children, respect RAM cap, still allow allowlisted egress.
5. **External audit** — hire a pentest firm for one day ($5-10k). **Do not skip.**

### Estimated effort

**4 engineer-days Linux implementation + 3 audit days.** Without audit, we ship "this hardens things" as documentation and hope the config is right.

### Risk if delayed

Low for MVP users, high if enterprise adoption takes off. Each enterprise security review between now and shipping is a deal in slow motion. One bad review kills a 6-month sales cycle.

The canary ladder + revocation + signed patches stack assumes sandbox is *one layer*. If someone finds a subprocess escape first, the cascade (revoke → rotate → audit → apology post) is recoverable but painful.

### Risk if rushed

High. nsjail config is finicky. Too lax → false security. Too strict → legitimate integrations break (a patch that reads a local CSV). Ship too-strict in v1.1 and spend three months weakening it, each patch needing threat review.

**Serious alternative to consider:** if the trigger is enterprise-driven, the right answer may be *"Chorus is not for your threat model"* rather than half-baked hardening. Single-user single-tenant is an honest positioning.

### References

- `docs/ARCHITECTURE.md` §4.4 (current subprocess model)
- `docs/ARCHITECTURE.md` §10 + §10.4 (threat model, nsjail deferred)
- `docs/ARCHITECTURE.md` §12 Q2 (nsjail vs. gVisor)

---

## 4. Differential testing as gate

**Priority: 3** (tied with event triggers). Critical for registry health at scale; not urgent for the first 100 patches. Prevents year-two pain.

### What it is

Today (`ARCHITECTURE.md` §10.4, Gate 4), differential testing is **informational**. Proposed patches are run against the cassette library; regressions are logged, but the canary rolls out anyway. Real-user error rate is the only hard gate.

Flipping to a gate: **reject patches that fail cassettes the current integration passes.** Pre-canary, automatic rejection. Scout-charlie's research (`docs/research/03-error-signatures-and-testing.md`) validated this pattern (Pact, VCR-Polly, MSW). Infrastructure exists — we're just not pulling the trigger.

### Trigger

Any one fires:
- **Month 6 post-launch** (hard cutoff per `ARCHITECTURE.md` §10.4).
- **First regression past canary.** A patch passes canary → ships → a secondary bug surfaces that the cassette library would have caught. Flip the gate immediately.
- **Cassette library hits 1,000+ entries.** Signal/noise ratio for differential testing is good enough that false rejections become rare.
- **First malicious patch detected** — subtle semantic change (exfiltrates, still returns normal-looking result). Differential testing catches it because a cassette asserts on side-effect shape.

### First 3-5 concrete steps

1. **Walk `packages/repair-agent/src/validate.ts`** — snapshot validation already runs cassettes against proposed patches. Count pass/fail per cassette.
2. **Extract policy** — `shouldGate(results: CassetteResult[]): GateDecision` at `packages/registry/src/gate/differential.ts`. Configurable threshold; default = reject if the patch fails any cassette the current integration passed.
3. **Wire into registry submission** — pre-canary. Rejected patches go to `rejected/` with reason. Link from `ARCHITECTURE.md` §5.4.
4. **UX: `chorus patch status <patch-id>`** shows failed cassettes with expected-vs-actual diff. A rejected patch is a teaching moment.
5. **Telemetry: rejection rate over time.** Alert if >20% of submissions in `chorus status --registry` — either cassettes unstable or repair-agent degrading.

### Estimated effort

**4 engineer-days.** Infrastructure exists; work is gate placement, UX polish, telemetry.

### Risk if delayed

Medium. Other gates (static AST, signing, canary, revocation) catch most failures. The unique value of differential testing: *semantic regressions that compile and lint fine*. Example: a `slack-send` patch changes attachment handling, still returns 200, silently drops attachments. Static AST misses it. Canary misses it (users don't error on silent drops). Only differential testing catches it — **if the cassette asserts on attachment pass-through**. Gate value compounds with library size.

### Risk if rushed

Medium. Flip the gate before cassette coverage is good and we reject legitimate patches — a contributor fixes a real bug, but the new code path has a cassette recorded under the buggy behavior, so the patch "fails" for being right.

Mitigation: **cassette staleness signal.** Cassettes older than the patch's base version are soft-evidence; newer are hard-evidence. One extra day of work, kills the class of false-positive.

Tuning knob: start gate at "fail > 5%" in v1.1, tighten to "fail any" in v1.2 as the library stabilizes. **Config, not code.**

### References

- `docs/research/03-error-signatures-and-testing.md` (scout-charlie's research)
- `docs/ARCHITECTURE.md` §5.4 (canary ladder — gate runs before)
- `docs/ARCHITECTURE.md` §10.4 (Gate 4 deferred)
- `packages/repair-agent/src/validate.ts` (existing base)

---

## 5. npm package publication + installer

**Priority: 2.** Packaging, not engineering. Ranked this high because `QUICKSTART.md` already promises `npx chorus init` and nothing in the repo delivers that promise. Every day we don't publish, the install story is a lie.

### What it is

All 7 packages (`@chorus/core`, `@chorus/runtime`, `@chorus/registry`, `@chorus/reporter`, `@chorus/repair-agent`, `@chorus/cli`, two integrations) are private. Nothing on npmjs.com. `npx chorus init` 404s.

Three shipping prongs:
1. **npm** (primary) — `npm install -g chorus` or `npx chorus init`.
2. **Homebrew** — `brew install chorus` for users who prefer brew.
3. **Windows MSI** (optional) — only if enterprise asks (`ARCHITECTURE.md` §12 Q9).

### Trigger

**Ship npm day 1** after this roadmap merges. No trigger to wait for — packaging hygiene. The only delay reasons are (a) bikeshedding the CLI name (we're not — it's `chorus`), or (b) delaying public exposure (we're not — exposure is the point).

Homebrew: ship at >100 npm installs (maintainers prefer mild traction). MSI: only on enterprise demand.

### First 3-5 concrete steps

1. **Audit all 7 `package.json`s.** Claim `@chorus` on npmjs.com (verify unclaimed first). Set `version: 0.1.0`, `publishConfig.access: public` for scoped packages, explicit `files` allowlist (no `.ts` source in the tarball), verify `main`/`types`/`exports`.
2. **`pnpm publish --filter @chorus/*` with `--access public`.** Dry-run first; eyeball tarball contents.
3. **CLI binary** — `@chorus/cli`'s `bin` field exists; verify the tarball includes compiled `dist/bin.js`. Run `npx @chorus/cli@0.1.0 --help` from a clean tmpdir.
4. **`chorus init` bootstrapping** — already works per `cli-india`'s build. Verify: `mkdir foo && cd foo && npx chorus init && chorus run` lands on a working dev server.
5. **Docs + first public release** — `QUICKSTART.md` uses the real `npx chorus init`. `README.md` has npm + Homebrew (coming soon) sections. Push to GitHub.

### Estimated effort

**2 agent-days npm + 3 Homebrew + 3-5 MSI (only if demanded).** Mostly mechanical — version bumps, tarball verification, CI. Low intellect load, high attention load.

### Risk if delayed

High. Every week someone could claim `chorus` on npm or the `chorus.dev` domain or the GitHub org. `ARCHITECTURE.md` §11 already assumes `github.com/chorus/chorus`. Land-grab is real.

Auto-MCP (§1) depends on users having Chorus installed. If MCP ships before npm, we're stuck with "clone this git repo and run from source" onboarding — which kills adoption.

### Risk if rushed

Low. Unlike every other item, rushed npm publication is almost never a problem. Publish `0.1.0`, find a bug, ship `0.1.1` tomorrow. That's how all packages start.

**Two gotchas:**
- `pnpm workspace:*` protocol: must resolve to concrete versions in the tarball. `pnpm publish` does this automatically, but verify. No `workspace:*` in published `dependencies`.
- Integrations in `integrations/`, not `packages/`. Decide: bundled inside `@chorus/cli`, or their own namespace? **Recommendation: `@chorus-integrations/*`** so community integrations follow the same publish pattern.

### References

- `QUICKSTART.md` (currently references `chorus init`)
- `README.md` (install section needs update)
- `packages/cli/package.json` (bin entry)
- `docs/ARCHITECTURE.md` §12 Q9 (MSI vs. npm)

---

## 6. Event triggers + `step.waitForEvent`

**Priority: 3** (tied with differential testing). Unlocks the async-workflow use case every webhook-driven or async-job-polling integration needs.

### What it is

MVP ships three trigger types (`ARCHITECTURE.md` §4.2): `webhook`, `cron`, `manual`. Missing:

1. **`event` trigger** — workflow wakes on a named event. Other workflows or external systems emit via runtime API.
2. **`step.waitForEvent`** — inside a workflow, pause until a matching event arrives. Respects replay semantics like `step.run`.

Use case: async integrations. Stripe 3DS posts a webhook back when the user finishes; without `step.waitForEvent`, the workflow has to poll. Inngest has it. Trigger.dev has it. n8n has "Wait for webhook." MVP skipped it. v1.1 cannot.

### Trigger

Any one fires:
- **First integration author says "I can't express my flow without this."** Likely: Stripe 3DS, OAuth callbacks, long-running external jobs.
- **First community patch is a polling hack.** Smoke signal.
- **Internal dogfooding** — we write integration #6 and 3 of them have async hacks.
- **2 months post-launch,** whichever comes first (soft time trigger).

### First 3-5 concrete steps

1. **Add `event` to the trigger enum** in `packages/core/src/types.ts`. Runtime trigger routing in `packages/runtime/src/triggers.ts`; event triggers register a subscription.
2. **SQLite schema: `events` table** — `(id, name, payload_json, fired_at, consumed_by_run_id)`. Durable until matched or TTL (default 7d). Emit via new `runtime.emit(name, payload)` API.
3. **`step.waitForEvent` in executor** — on `waitForEvent(name, matchFn, timeoutMs)`, write a `waiting` checkpoint and stop. Event listener queries `steps` for `waiting` + matching name, applies `matchFn`, resumes.
4. **Timeout + replay semantics** — if no event within `timeoutMs`, resume with timeout error. On replay, either the stored payload (if arrived) or the deterministic timeout. **No wall-clock peeking.**
5. **Test matrix** — event arrives before step / during wait / timeout fires. Plus replay: kill process mid-wait, restart, verify no double-fired side effects.

### Estimated effort

**3 agent-days.** Primitives exist — the executor already has pause/resume for `step.sleep`. Event-triggered resume is a variant, not a new subsystem.

### Risk if delayed

Medium. Every month, a would-be contributor abandons their integration because they can't express async flows. The first real Stripe integration shipping as a polling loop is a reputation hit — "Chorus integrations feel clunky because the runtime is underpowered" is a hard narrative to escape.

### Risk if rushed

Low. Design space is narrow — Inngest, Trigger.dev, n8n, Temporal all have the same shape. We're implementing a known pattern.

**Subtle gotcha 1: match function determinism.** Match runs in the executor against each candidate. If it closes over external state or does async work, replay breaks. Make match functions **pure**. Document loudly.

**Subtle gotcha 2: fan-out.** If 500 workflows wait for `job.done`, we wake them all. Single-node: query `steps`, resume each. Cross-node is v2 (real pub/sub, `ARCHITECTURE.md` §11.3). Defer.

### References

- `docs/ARCHITECTURE.md` §4.2 (trigger types — add `event`)
- `docs/ARCHITECTURE.md` §4.3 (durable execution — waitForEvent variant)
- `docs/ARCHITECTURE.md` §11.2 (v1.1 feature)
- `docs/research/01-workflow-engines.md` (scout-alpha on Inngest/Trigger.dev wait primitives)

---

## 7. UI — reframed (we are not building a dashboard)

**Priority: 6.** Last because the answer is "the user's agent builds the UI, not us."

### The reframe

User's exact words: *"we want the UI to be dynamic and built by the users agent, perhaps asking them how they want to see it and for any style they want things."*

This is not "defer the UI." It's *the concept of a fixed UI is obsolete*. Chorus is backend infrastructure for the agent era. Agents are the front-end. The `ARCHITECTURE.md` §1.4 stance "CLI ships first, UI later" becomes "CLI ships first; JSON API ships alongside; agents generate the UI." Hardcoded dashboard is **permanently struck from the roadmap**.

### What was deferred (the old plan)

The original roadmap had a drag-drop visual flow builder at `ARCHITECTURE.md` §11.3 (v2). Dead:

1. **Agents don't need drag-drop.** An agent generates a workflow from a prompt. Drag-drop is UX for humans who can't program; in the agent era, the human describes intent, the agent writes `chorus/` TypeScript.
2. **Hardcoded dashboards are outdated by definition.** A 2026 dashboard doesn't fit a 2027 user who wants cost-per-run, latency-per-integration, patch-adoption metrics. Their agent builds exactly what they want on demand.
3. **Every dashboard we ship is one we maintain** — routes, components, ARIA, dark mode, i18n. Sibling agent `ui-kilo` is building the JSON API that any dashboard could use. That's our layer.

### What ships instead

`ui-kilo`'s parallel deliverables (not in roadmap-lima's scope to detail):

1. **JSON API** — `@chorus/runtime` exposes `/api/runs`, `/api/patches`, `/api/credentials` (redacted), `/api/workflows`, `/api/integrations`. OpenAPI 3.1 spec. Accessible locally at `http://localhost:$PORT/api/*`.
2. **`chorus ui --prompt`** — emits a prompt template. User copies to their agent with "give me a dashboard with dark mode and a focus on failed runs." Agent generates React/Svelte/HTMX/whatever, fetches the JSON API, renders the user's dream dashboard.
3. **OpenAPI spec as a static artifact** — pointable from Postman/Bruno/Insomnia.

### Three possible v1.x+ extensions (only if signaled)

**Extension A — reference dashboard (minimal, static):**
- Trigger: 5+ users say "I don't have an agent set up yet; can I see my first run in a browser?"
- Onboarding UI, not production UI. One HTML page, no build step, fetches JSON API, shows runs + patches.
- Effort: 1 agent-day.

**Extension B — OpenAI-compatible endpoint (adapter):**
- Trigger: users with existing dashboard tools (Retool, Superblocks) ask "can I point my tool at Chorus's data?"
- Adapt JSON API to conventional BI/dashboard tool conventions.
- Effort: 2 agent-days.

**Extension C — hosted reference dashboard (explicit rejection):**
- No. `ARCHITECTURE.md` §1.4: "Not a hosted SaaS." Users who want hosting run it on their own infra.

### First concrete steps (for roadmap-lima)

Not a build list — these are decisions to propagate to `ARCHITECTURE.md`:

- §1.4 bullet 1: change "UI comes later; CLI ships first" to "Chorus is the backend; agents generate the UI. CLI ships first; JSON API ships alongside."
- §11.2: remove "Web UI (read-only dashboard)"; note the reference dashboard is ~1 day if triggered.
- §11.3: remove "Flow visual editor (drag-drop)." Replace with "OpenAPI-spec'd JSON API + agent-generated dashboards."

### Estimated effort

- **Core decision: 0 agent-days** (positioning change).
- **Extension A: 1 agent-day** if triggered.
- **Extension B: 2 agent-days** if triggered.

### Risk if delayed

**No risk in "delaying" a thing we're not building.** The risk is forgetting the decision — someone in 6 months starts a hardcoded dashboard. This section exists to prevent that.

Real risk: `ui-kilo`'s JSON API slips. Without the JSON API, agents can't generate dashboards. Monitor.

### Risk if rushed

Panic-shipping a hardcoded dashboard on a "users want a dashboard" signal creates maintenance debt for a feature outdated on arrival. The agent-era positioning is strongest when Chorus is unapologetically backend.

**Self-discipline:** when a user says "I want a dashboard," first answer is "run `chorus ui --prompt` and paste to your agent." Second answer, if agent-less, is "here's the reference dashboard (Extension A)." Third answer — "we'll build it for you" — is **never** given.

### References

- `docs/ARCHITECTURE.md` §1.4 (changes per this section)
- `docs/ARCHITECTURE.md` §11.2 (UI bullet to remove)
- `docs/ARCHITECTURE.md` §11.3 (drag-drop flow editor to remove)
- `ui-kilo`'s output (parallel agent)

---

## Decision frameworks

### Framework 1: Auto-MCP vs. "just use the CLI from an agent"

The user's question: *"lets ship core then get auto-mcp per integration, but lets also consider we might just want skills or cli and have agents run things."*

Real tension. Both paths reach the same goal — "my agent can use Chorus to do work." Different tradeoffs.

#### The two options

- **Option A — Auto-MCP.** Each operation becomes a first-class MCP tool. Typed schemas, descriptions, examples, native in Claude Desktop/Cursor/Zed.
- **Option B — CLI + agent.** Agent invokes `chorus run my-workflow --input '{...}'` via subprocess. No MCP server. Agent reads CLI docs.

#### When each wins

| Factor | MCP | CLI+agent |
|---|---|---|
| First impression | Tools appear in the agent's palette | Needs prompt + example |
| Schema fidelity | Zod → JSONSchema → MCP tool | String args, agent parses |
| Discovery | Agent lists tools | Agent must know to run `chorus list-integrations` |
| Credential injection | Server-side, transparent | Env vars, agent handles |
| Maintenance burden | New schema layer per integration | Zero new per integration |
| Streaming results | MCP tool can stream | stdout line-by-line |
| Non-MCP agents | No | Yes (any agent with shell) |
| Cross-machine | stdio or remote SSE | SSH + env vars |

#### Recommendation: ship both. Not as fallback — as strategy.

MCP is *premium UX* for MCP-compatible clients. It isn't universal. An open-source local agent, a Jupyter notebook with a custom LLM harness, or `bash + claude -p` — none speak MCP.

The CLI must be excellent regardless. Auto-MCP is a *superset*: it wraps the CLI's capability in an MCP surface. Every MCP tool is implemented as *"run this CLI command under the hood."*

Benefits:
1. Both surfaces exist; users pick.
2. Shared implementation — one runtime core, two surfaces.
3. If MCP loses to OpenAI's tool-use spec or something else, CLI is still excellent. No sunk cost.
4. If MCP wins, CLI still useful for scripting and non-agent automation.

#### Implementation guidance (for when §1 ships)

- MCP tool `slack-send.send-message` internally runs `chorus run --integration slack-send --operation send-message --input '{...}'`.
- Zod schema drives both MCP JSONSchema and CLI `--input` validation.
- `chorus mcp` is a thin MCP server wrapper over the CLI, inheriting credentials from the same profile.

This is the "skills+CLI" path the user asked about, structurally realized, with MCP as a first-class surface on top. Not either/or. Both/and.

#### When to deprecate the CLI (never)

Even if auto-MCP succeeds wildly, CLI stays. It's documentation-friendly, reproducible, scriptable, audit-trail friendly ("the agent ran this exact command, logged"). MCP without an underlying CLI is an opaque black box. Refuse.

---

### Framework 2: When to migrate to Postgres

Section 2 covers triggers. This framework is the decision logic *inside* the trigger.

#### Decision tree

```
Scale trigger fires.
  ↓
READ-heavy or WRITE-heavy?
  ↓
  READ-heavy  →  Try SQLite read replicas (litestream, rqlite) FIRST.
                 Migrate to Postgres only if replicas don't solve it.
  WRITE-heavy →  Migrate to Postgres.
                 Don't try to tune SQLite past 500 writes/sec.
```

#### Concrete thresholds

From `chorus status --verbose`:

- **`run_rate_per_sec` > 50 sustained** → migrate soon.
- **`db_write_lag_p99_ms` > 200** → migrate.
- **`concurrent_runs_active` > 30 sustained** → migrate soon.
- **`db_file_size_mb` > 5000 (5 GB)** → migrate for ops reasons.
- **`queue_claim_contention_count` > 0 consistently** (new metric in v1.1) → migrate.

None are hard cutoffs; they're smoke signals. **Hard cutoff: multi-node → Postgres immediately.** SQLite's single-writer constraint is non-negotiable.

#### What migration actually looks like

1. `chorus status` surfaces a threshold warn.
2. Docs link a scaling page.
3. User spins up Postgres (Docker, RDS, wherever).
4. `chorus migrate --to postgres --url ...` (15-30 min for 2 GB SQLite).
5. `chorus switch-backend postgres` flips config.
6. `chorus run` uses Postgres.
7. SQLite file preserved as backup; delete when confident.

**No rollback.** A user who dislikes Postgres starts fresh on SQLite and re-imports workflows manually. Half-migrated states are worse than re-import.

---

## Out-of-scope for v1.x (deferred to v2 or beyond)

Things that could plausibly appear but are deliberately not here:

1. **Hosted Chorus cloud** — inherited from §1.4. Self-host only. Public patch registry is the only centralized piece.
2. **Drag-drop visual workflow builder** — killed per §7. Agents generate flows from prompts.
3. **Turing-complete flow expression language** — Windmill's JSONnet, Zapier's Code — no. Flows stay declarative. `ARCHITECTURE.md` §11.4.
4. **Self-hosted LLMs for repair agent** — Claude stays hardcoded. Revisit only on major pricing shift or genuinely comparable local model.
5. **Cryptographic PGP Web of Trust** — scout-bravo concluded OIDC + reputation is sufficient. PGP is UX-toxic.
6. **Kubernetes-native deployment** (operators, CRDs, Helm charts) — we ship a single binary + SQLite/Postgres. K8s is an option for operators, not something we deliver.
7. **CRIU process checkpointing** — Linux-specific, conflicts with cross-platform priority.
8. **Multi-tenant registry** — public registry is one namespace. Enterprise private namespaces = fork the server. The "federated topology" open question (§12 Q4) is v2+.
9. **Workflow marketplace / paid integrations** — all integrations open-source, registry free. Monetization if any = support contracts or hosted infra. Not gated integrations.
10. **Non-MCP agent frameworks natively supported** — LangChain, CrewAI, AutoGen can call the CLI (or a REST adapter). No framework-specific SDKs.

---

## How to update this doc

### When a trigger fires

1. Find the section. Add dated note: `**2026-09-12:** Trigger fired — 12 users asked in Discord. Starting work.`
2. Change the at-a-glance row's "Build now vs. wait?" to "Building."
3. Create a GitHub issue.
4. When complete, mark "Shipped in v1.X" and move detail to `CHANGELOG.md`.

### When priorities shift

Priority numbers (1-6) are advisory. A real signal bumps them. Log in the section: `**Priority bumped 2026-07-01:** CVE-2026-1234 security incident; previously rank 5.`

### When an item becomes obsolete

Delete it, but **record the deletion** in `CHANGELOG.md` with rationale. Future sessions must be able to answer "why isn't X in the roadmap?" from the changelog.

### When a new item appears

Add a "Scope change" entry at the top:

```
**2026-06-15 — Added item 8: multi-region registry replication.**
Trigger: enterprise asked for geo-local reads. Priority 4. Effort: 2 weeks.
```

Never silently change the 7-item structure. The roadmap is a covenant with future sessions and with the user.

### When a section changes a referenced `ARCHITECTURE.md` line

Edit `ARCHITECTURE.md` in the same commit. Roadmap is the plan; architecture is the truth. They must stay synchronized.

---

*End of roadmap. Next review: when the first of the seven triggers fires, or 90 days from the last update, whichever comes first. Signed by roadmap-lima, session 2, 2026-04-14.*
