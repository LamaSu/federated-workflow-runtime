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

## 2. Postgres migration path

**Priority: 4.** Lower than you'd expect for a "scale" feature — because the trigger is quantifiable and SQLite's ceiling is genuinely high. We win by waiting.

### What it is

Today, `@chorus/runtime` persists state to SQLite via `better-sqlite3` (see `docs/ARCHITECTURE.md` §4.5). The schema lives in `packages/runtime/src/db/schema.sql`. Queue semantics rely on `UPDATE ... LIMIT 1 RETURNING` for single-node claim (§4.1).

The migration path is a one-way CLI:

```
chorus migrate --to postgres --url postgres://user:pass@host/chorus
```

It creates the Postgres schema, copies rows in a defined order (credentials → workflows → runs → steps → events), switches the backend config, and runs a sanity check (every pending run is re-queryable). Reverse migration is **not supported**; users pick a direction and commit.

### Trigger

Build when **the first real user hits one of these** (not hypothetical, actual):
- **100k+ rows in the `runs` table** on a single node (empirically where SQLite write contention starts to matter for this access pattern; sustained WAL fsync ≈ 400/s on commodity SSD).
- **50+ concurrent in-flight runs** (SQLite handles this but tail latency starts to climb past ~30).
- **A user asks** because they want HA across two nodes (MVP is single-node; HA implies a shared queue, which implies Postgres per §4.1).
- **SQLite file size > 5 GB** (technically fine, but backup/restore starts to feel painful for ops teams).

These are measurable. The runtime should surface these metrics in `chorus status` so users and operators see the thresholds approaching. **Action item (free):** add a `warn_on_scale_threshold` config flag that logs when any of the above is breached. One commit, ~20 lines. Do this in v1.1.

### Priority rank: 4

Below auto-MCP (1), npm publication (2), event triggers (3), differential testing (3). Postgres migration is *infrastructure polish*, not a user-visible feature. The user who hits the trigger is already successful — they're a good problem to have, not an urgent one. No churn risk while we wait, because SQLite is fast enough that users who haven't hit the trigger haven't noticed anything.

### First 3-5 concrete steps

**Day 1** — Write `packages/runtime/src/db/postgres/schema.sql`. It's `schema.sql` translated: `INTEGER PRIMARY KEY AUTOINCREMENT` becomes `SERIAL PRIMARY KEY`, `TEXT` stays, `JSON` stays (Postgres `jsonb`). Foreign keys already correct in the SQLite version.

**Day 2** — Abstract the DB layer. Today the code calls `better-sqlite3` directly. Introduce `packages/runtime/src/db/driver.ts` with a minimal interface (`query`, `queryOne`, `exec`, `transaction`). Implement `SqliteDriver` and `PostgresDriver` (using `pg` or `postgres.js`). No behavior change in this diff; swap the call sites.

**Day 3** — Rewrite the queue claim query. SQLite uses `UPDATE ... LIMIT 1 RETURNING`; Postgres uses `SELECT ... FOR UPDATE SKIP LOCKED`. Both are in `packages/runtime/src/queue.ts`. Keep the SQL as a driver-specific template.

**Day 4** — Write `packages/cli/src/commands/migrate.ts`. Order: credentials (blocking), workflows (blocking), runs (chunked 1000 at a time), steps (chunked 10000 at a time), events. Resume-safe (checkpoint table on the target).

**Day 5** — Integration test. Spin up Postgres in Docker, migrate a known SQLite fixture, run the full `@chorus/runtime` test suite against the Postgres backend. **All 81 existing runtime tests must pass on Postgres** before we ship this.

### Estimated effort

**5 engineer-days.** Schema port is trivial. The driver abstraction is where the work is. The test-on-both-backends discipline is non-negotiable — any regression in SQLite mode because of a Postgres-driven change is a worse outcome than the feature itself.

### Risk if delayed

Low. SQLite is genuinely fast enough; the user who needs Postgres is also the user sophisticated enough to run their own workaround (custom driver in their fork) for a month while we build it properly.

**One concrete risk:** if someone tries to run Chorus on their team's shared infrastructure (GitOps-deployed, CI pipeline triggering flows, multiple deployments pointing at the same state) — they hit a wall at SQLite's single-writer limit. Mitigation: clear doc note in `ARCHITECTURE.md` §11 (already there) saying "multi-writer is v2."

### Risk if rushed

High. Postgres migrations are the class of feature where "built but untested at scale" is worse than "not built." If we ship this in v1.1 without a real user pushing data through it, we'll find out about row-order bugs, deadlocks on the queue claim query, and WAL vs. replication weirdness in production. We burn trust.

More specifically: the queue claim query is the riskiest diff. `SKIP LOCKED` in Postgres has different fairness semantics than SQLite's `UPDATE ... LIMIT 1`. A workflow with 200 parallel retries could starve the queue if we get the `FOR UPDATE` placement wrong. **Write this against a synthetic 10k-run fixture before a real user sees it.**

### References

- `docs/ARCHITECTURE.md` §4.1 (queue & executor — the claim query)
- `docs/ARCHITECTURE.md` §4.5 (SQLite schema — the translation input)
- `docs/ARCHITECTURE.md` §11.3 (Postgres marked as v2)
- `docs/ARCHITECTURE.md` §12 open question #1 (migration path shape)

---

## 3. nsjail / proper sandbox

**Priority: 5.** Lowest ranked of the "real work" items, because the current subprocess model is genuinely sufficient for the MVP target user, and every sandbox hardening step creates cross-platform pain.

### What it is

Today, per `docs/ARCHITECTURE.md` §4.4, each Run executes in a fresh Node subprocess (`child_process.fork`). The subprocess has no access to the main runtime's memory, no shared filesystem other than what it inherits via `PATH`, and no persistent credential handle. Communication is stdin/stdout JSON lines.

nsjail would wrap that subprocess in a Linux namespace jail: filesystem namespace (sees only a curated subset of `/`), PID namespace (can't see or signal sibling runs), network namespace (configurable egress), cgroup (RAM + CPU cap). Same subprocess code, hardened shell.

**Platform asymmetry is the whole story here.** nsjail is Linux-only. The MVP priority is cross-platform (Windows + macOS + Linux), so nsjail is deliberately behind a flag: `CHORUS_SANDBOX=nsjail` on Linux hosts, silently ignored elsewhere.

### Trigger

Build when **any one** of these fires:
- First malicious-patch report. A user says "a patch from the registry tried to read my `.ssh/`" — even if blocked by our static AST gate, the fact of the attempt is the signal.
- First enterprise security review. Someone in procurement says "we need defense-in-depth for the integration layer" and subprocess-only doesn't check their box.
- CVE or exploit in `better-sqlite3`, `pg`, `node` itself, or one of our reference integrations that lets a malicious patch exfiltrate data from the subprocess.
- **Hostile cassette discovered in the wild.** A patch's replay cassette that tries to side-channel via DNS or filesystem.

Until one of these fires, we are fighting shadows. The subprocess model already prevents the 90% case (accidental credential leak into patch code).

### Priority rank: 5

Below Postgres (4) because Postgres has a measurable trigger; sandbox hardening has a *reactive* trigger. Above UI (6) because when the trigger fires it fires urgently — enterprise security reviews are not "wait 6 months" affairs.

### First 3-5 concrete steps

**Day 1** — Write `packages/runtime/src/sandbox/nsjail.ts`. Thin wrapper around `nsjail -C /etc/chorus-nsjail.cfg -- node run-step.js`. The config file (`nsjail.cfg`) lists allowed mounts, PID limit, CPU time limit, and `/tmp` isolation per-run.

**Day 2** — Extend the `Sandbox` interface in `packages/runtime/src/sandbox/index.ts` (currently just subprocess). Add `NsjailSandbox` as a driver. Runtime config reads `CHORUS_SANDBOX=subprocess|nsjail` env var; defaults to subprocess.

**Day 3** — Build a Docker image that includes nsjail + Node 20 + Chorus CLI. This is the reference deployment target for Linux users who want the hardening. Tag as `chorus:latest-hardened` on the registry.

**Day 4** — Write the test suite. Real nsjail-wrapped runs on a Linux CI runner (GitHub Actions `ubuntu-latest`). Verify: subprocess can't open `/etc/passwd`, can't fork more than N children, can't exceed RAM cap, can still make HTTP requests to allowlisted hosts.

**Day 5** — Write a threat-model update to `ARCHITECTURE.md` §10. What new defenses does nsjail add? What does it NOT defend against (e.g., it doesn't protect against a patch calling `process.exit(0)` to skip steps — still need the static AST gate).

**Day 6-7** — Security audit. Ideally external (hire a pentest firm for one day). Minimum: have a second implementer read the config and try to escape.

### Estimated effort

**4 engineer-days for Linux implementation + 3 for audit = 7 engineer-days.** External audit is $5-10k if we hire. Without the audit, we ship a feature with "this hardens things" as documentation and hope we got the config right. **Do not skip the audit.**

### Risk if delayed

Medium-to-low for MVP users; high if enterprise adoption takes off. Every enterprise security review that comes in between now and this shipping is a deal in slow motion. One bad review can kill a 6-month sales cycle.

**Concrete risk:** the canary ladder (§5.4) + revocation fast-path (§5.6) + signed patches (§5.3) stack assumes the sandbox is *one layer* of defense. If someone finds a sandbox escape in the subprocess model before we ship nsjail, the cascade is: revoke the patch → rotate credentials → audit logs → apology post. All recoverable, but painful.

### Risk if rushed

High. nsjail config is notoriously finicky. A too-lax config gives a false sense of security; a too-strict config breaks legitimate integrations that need filesystem access (e.g., a patch that reads a local CSV). Ship a too-strict config in v1.1 and we spend the next three months weakening it in patches, each of which needs its own threat review.

More subtly: we have the option of *not building this* by choosing to mark nsjail out of scope and document the subprocess model as "sufficient for single-user single-tenant use." That's an honest positioning. **If the trigger fires and it's enterprise-procurement-driven, we should seriously consider if the right answer is "Chorus is not for your threat model" rather than shipping half-baked hardening.**

### References

- `docs/ARCHITECTURE.md` §4.4 (current sandbox model)
- `docs/ARCHITECTURE.md` §10 (threat model — enumerate what nsjail adds)
- `docs/ARCHITECTURE.md` §10.4 (currently lists nsjail as deferred)
- `docs/ARCHITECTURE.md` §12 open question #2 (is nsjail enough, or do we need gVisor?)

---

## 4. Differential testing as gate

**Priority: 3** (tied with event triggers). Critical for registry health at scale; not urgent for the first 100 patches. This is the feature that prevents the second year from being painful.

### What it is

Today (see `docs/ARCHITECTURE.md` §10.4, Gate 4), differential testing is **informational, not a gate.** When a proposed patch is submitted, the repair agent runs it against the cassette library. Regression counts are logged. The canary ladder rolls out the patch anyway; rollout is halted only by error-rate telemetry from real users.

Flipping to a gate means: **if the patched integration fails N% of cassettes that the current integration passes, reject the patch automatically.** No canary, no human review, no rollout. It's an up-front correctness check.

The scout-charlie research (`docs/research/03-error-signatures-and-testing.md`) established differential testing as a known-good pattern (taken from Pact, VCR-Polly, MSW). The infrastructure is built — we're just not pulling the trigger.

### Trigger

Build when **any one** of these fires:
- **Month 6 post-launch** (per `ARCHITECTURE.md` §10.4 — hard cutoff regardless of data).
- **First regression leak past canary.** A patch passes canary (error-rate stays green), ships to 100% of users, and then a secondary bug surfaces that the cassette library would have caught. This is the "I told you so" moment — flip the gate immediately.
- **Cassette library hits 1,000+ entries.** At that scale, the signal/noise ratio for differential testing is high enough that false rejections become rare.
- **First malicious patch detected.** A patch that subtly changes semantics (e.g., exfiltrates then still returns normal-looking result). Differential testing detects it because one of the cassettes catches the side-effect change.

### Priority rank: 3

Above Postgres (4) and sandbox (5) because it's a registry-health feature and the registry is the moat. Below auto-MCP (1) and npm packaging (2) because users don't directly feel differential testing; they feel its absence only when a bad patch ships.

Tied with event triggers (3) because both are v1.1 features with similar effort. Either one can ship first — we ship whichever has a signal first.

### First 3-5 concrete steps

**Day 1** — Walk through `packages/repair-agent/src/validate.ts`. The snapshot validation logic is there; it already runs cassettes against the proposed patch. Count pass/fail per cassette.

**Day 2** — Extract a policy function: `shouldGate(results: CassetteResult[]): GateDecision`. Configurable threshold (default: reject if the patch fails any cassette the current integration passes). Lives in `packages/registry/src/gate/differential.ts`.

**Day 3** — Wire it into the registry submission path. When a patch is submitted, run differential testing before the canary decision. If the gate says REJECT, the patch goes to `rejected/` with the rejection reason. Link from `docs/ARCHITECTURE.md` §5.4.

**Day 4** — UX. CLI `chorus patch status <patch-id>` should show gate results for patches that got rejected: which cassettes failed, expected vs. actual output diff, whether this is a regression or a fix. A rejected patch is a teaching moment for the contributor.

**Day 5** — Telemetry. Track gate rejection rate over time. If it drifts above 20% of submissions, something is wrong (either the cassette library is unstable or repair-agent quality is degrading). Alert at `chorus status --registry` output.

### Estimated effort

**4 engineer-days.** Infrastructure exists. The work is gate-placement, UX polish, and telemetry. No new subsystems.

### Risk if delayed

Medium. Every month we wait, more bad patches can theoretically ship. In practice, we have other gates (static AST, signing, canary, revocation) that catch most failure modes. The unique value of differential testing is catching *semantic regressions that compile and pass linting*. That's a narrow wedge but an important one.

**Concrete risk:** a patch to `slack-send` changes the attachment-handling logic in a way that still returns 200 OK but drops attachments silently. Static AST doesn't catch it. Canary doesn't catch it (users don't get error-rate feedback for "my attachments went missing"). Only differential testing, running a cassette that specifically asserts on attachment pass-through, catches this. **We'd need this test to exist in the cassette library** — which is why the gate is more valuable once cassette count is high.

### Risk if rushed

Medium. If we flip the gate before the cassette library is comprehensive, we reject legitimate patches because cassette coverage is uneven. A contributor fixes a real bug, but the new code path has a cassette that was recorded under the buggy behavior — the patch "fails" differential testing by doing the right thing.

Mitigation: introduce a "cassette staleness" signal. Cassettes older than the patch they were recorded against are soft-evidence only. Cassettes newer than the integration version they target are hard-evidence. This is 1 more day of work but saves the class of false-positive described above.

**Real-world tuning knob:** gate threshold should probably be "fail > 5% of cassettes" in v1.1, tightening to "fail any cassette" by v1.2 as the library stabilizes. Make this config, not code.

### References

- `docs/research/03-error-signatures-and-testing.md` (scout-charlie's differential-testing research)
- `docs/ARCHITECTURE.md` §5.4 (canary ladder — gate fits before canary)
- `docs/ARCHITECTURE.md` §10.4 (Gate 4 currently deferred)
- `packages/repair-agent/src/validate.ts` (existing snapshot validation — the base)

---

## 5. npm package publication + installer

**Priority: 2.** This is packaging, not engineering. It's ranked this high because `QUICKSTART.md` already promises `npx chorus init` and nothing about our repo delivers that promise. Every day we don't publish is a day the install story is a lie.

### What it is

Right now, `@chorus/core`, `@chorus/runtime`, `@chorus/registry`, `@chorus/reporter`, `@chorus/repair-agent`, `@chorus/cli`, plus two integrations are private packages in a pnpm monorepo. Nothing is on npmjs.com. `npx chorus init` 404s.

The shipping story has three prongs:
1. **npm** — primary. `npm install -g chorus` or `npx chorus init`.
2. **Homebrew** — `brew install chorus` for macOS / Linux users who prefer brew.
3. **Windows MSI** — optional, only if enterprise users demand it (per `ARCHITECTURE.md` §12 open question #9).

Each prong has a different packaging philosophy. npm is the one that must ship first.

### Trigger

**Ship the npm package day 1** after this roadmap is merged. There is no trigger worth waiting for; this is pure packaging hygiene. The *only* reasons to delay are (a) we want to bikeshed the CLI name (we don't — it's `chorus`), or (b) we want to delay public exposure for strategic reasons (we don't — public exposure is the point).

Homebrew: ship when we have >100 npm installs. Signal: Homebrew formula maintainers appreciate mild traction before accepting a new formula.

MSI: ship when an enterprise asks. Don't preemptively build for a user that doesn't exist.

### Priority rank: 2

Second only to auto-MCP because packaging is table-stakes. You can ship the best workflow engine on the planet, but if people can't `npm install` it, you have zero users.

Ranked below auto-MCP only because auto-MCP is the *feature* that makes Chorus interesting; npm is the *distribution* that makes it usable. In practice we ship them in parallel: one agent on each, different week 1 deliverables.

### First 3-5 concrete steps

**Day 1** — Audit `package.json` files across all 7 workspaces. Fix:
- `name`: `@chorus/core` is fine for scope-private; public publish needs either npm scope registration (`@chorus` on npmjs.com) or rename to unscoped (`chorus-core`, `chorus-runtime`, etc.). **Recommendation: claim `@chorus` on npmjs.com.** It's unclaimed as of 2026-04-14 (verify before committing).
- `version`: all at `0.1.0`. Correct for an initial public release.
- `publishConfig`: set `access: public` for scoped packages.
- `files`: explicit allowlist so we don't publish `.ts` source accidentally, only `dist/`.
- `main`, `types`, `exports`: verified per package.

**Day 2** — Set up publishing. `pnpm publish --filter @chorus/*` with `--access public`. Dry-run first. Use `pnpm publish --dry-run` and eyeball the tarball contents.

**Day 3** — CLI binary. The `chorus` command needs to be in `@chorus/cli`'s `bin` field. Currently it's there (`packages/cli/src/bin.ts`), but the tarball needs to include the compiled `dist/bin.js`. Verify with `npx @chorus/cli@0.1.0 --help` from a clean tmpdir.

**Day 4** — `chorus init` bootstrapping. This command should scaffold a working project (already does per `cli-india`'s work). Test: `mkdir foo && cd foo && npx chorus init && chorus run` should land on a working dev server with a sample workflow.

**Day 5** — Documentation. Update `QUICKSTART.md` with the real `npx chorus init` flow. Add `README.md` sections for "Install via npm" and "Install via Homebrew" (Homebrew is `coming soon`). Push to GitHub — first public release.

### Estimated effort

**2 agent-days for npm publish + 3 for Homebrew + 3-5 for MSI (only if demanded).** The agent-days reflect this being mostly mechanical work — version bumps, tarball verification, CI setup. Low intellectual load, high attention-to-detail load.

### Risk if delayed

High. Every week we don't ship is a week someone else could claim `chorus` on npm or the domain `chorus.dev` or the GitHub org. We already assume `github.com/chorus/chorus` in `ARCHITECTURE.md` §11 — need to secure that. Land-grab is a real concern.

**Specific risk:** auto-MCP (section 1) depends on users having Chorus installed. If auto-MCP ships before npm publish, we're forced into "clone this git repo and run it from source" onboarding. That kills adoption.

### Risk if rushed

Low. Unlike every other item on this list, rushed npm publication is almost never a problem. Worst case, we publish `0.1.0`, find a bug, ship `0.1.1` the next day. That's how all npm packages start.

**One gotcha to watch:** the monorepo's `pnpm workspace:*` protocol. When publishing, those internal refs must be resolved to concrete versions. `pnpm publish` does this automatically but verify in the tarball. Published packages should NOT contain `workspace:*` in their `dependencies`.

Another gotcha: the 2 reference integrations (`http-generic`, `slack-send`) live in `integrations/` not `packages/`. Decide: do these get their own npm namespace (`@chorus-integrations/slack-send`) or live inside `@chorus/cli` as bundled? **Recommendation: separate namespace `@chorus-integrations/*`** so community integrations can follow the same publish pattern.

### References

- `QUICKSTART.md` (currently references `chorus init` which requires this to exist)
- `README.md` (installation section needs update)
- `packages/cli/package.json` (`bin` field for CLI entry)
- `docs/ARCHITECTURE.md` §12 open question #9 (Windows MSI vs npm)

---

## 6. Event triggers + `step.waitForEvent`

**Priority: 3** (tied with differential testing). This is the feature that unlocks the "async workflow" use case which every integration with webhooks or async job polling needs.

### What it is

MVP ships three trigger types per `ARCHITECTURE.md` §4.2: `webhook`, `cron`, `manual`. What's missing:

1. **`event` trigger.** A workflow wakes up when an arbitrary named event fires. Other workflows or external systems can emit these events via the runtime API.
2. **`step.waitForEvent`.** Inside a workflow, pause until a matching event arrives. This is the dual — triggers start workflows; waitForEvent resumes paused workflows.

The use case both solve: async integrations. Example — a workflow calls Stripe to initiate a 3DS card challenge, which is an async flow (Stripe posts a webhook back when the user completes 3DS). Today, the workflow author has to poll. With `step.waitForEvent`, the workflow pauses on the event and resumes durably when it arrives, respecting the same replay semantics as `step.run`.

Inngest has this (`step.waitForEvent`). Trigger.dev has this (`wait.forEvent`). n8n has this via "Wait for webhook" node. Chorus MVP skips it. v1.1 cannot.

### Trigger

Build when **any one** of these fires:
- **First integration author says "I can't express my flow without this."** Likely candidates: Stripe 3DS, OAuth callback flows, long-running external job triggers (video transcoding, ML inference).
- **First community patch is a hacky polling workaround.** That's the smoke signal that the primitive is missing.
- **We write integration #6 (out of the first 5 planned + 1 more) and realize 3 of them have hacks for async.** This is an internal trigger — our own dogfooding.
- **2 months post-launch,** whichever comes first. This is a soft time-based trigger reflecting "probably needed by then."

### Priority rank: 3

Tied with differential testing (4). Different audiences — this is user-facing (workflow authors feel the absence), differential testing is registry-facing (only registry maintainers feel the absence). Order of shipping: whichever hits its trigger first. Likely event triggers hit first because they block real workflows; differential testing degrades slowly.

Above Postgres (4) and sandbox (5) because it's a capability missing from v1 that competitors have. It's the kind of missing feature a reviewer or potential user notices immediately.

### First 3-5 concrete steps

**Day 1** — Add `event` to the trigger type enum in `packages/core/src/types.ts`. The runtime already has trigger routing in `packages/runtime/src/triggers.ts`. Event triggers register a subscription; the executor polls a new `events` table (or subscribes to a pub/sub channel).

**Day 2** — SQLite schema change: `events` table with `(id, name, payload_json, fired_at, consumed_by_run_id)`. Events are durable until a matching workflow picks them up or they TTL out (default 7 days). Emit via new runtime API `runtime.emit(name, payload)`.

**Day 3** — `step.waitForEvent` in the runtime's executor. The executor, when it encounters a `waitForEvent(name, matchFn, timeoutMs)` call, writes a checkpoint to the `steps` table with status `waiting` and stops. The event-listener side queries `steps` for `waiting` status and a matching event name, applies `matchFn`, resumes the run on hit.

**Day 4** — Timeout semantics. If an event doesn't arrive within `timeoutMs`, the workflow resumes with a timeout error. Replay semantics must hold: on replay, if the event already arrived, we deterministically use the stored payload; if the timeout fired, we deterministically error. No wall-clock peeking.

**Day 5** — Test matrix. Three scenarios: (1) event arrives before the step; runtime should pick it up immediately. (2) event arrives during the step's wait; resume within 1s. (3) timeout fires; error path. Plus replay: kill the process mid-wait, restart, verify the wait resumes without double-firing side effects.

### Estimated effort

**3 agent-days.** The primitives exist — the executor already has pause/resume for `step.sleep`. Adding event-triggered resume is a variant of sleep, not a new subsystem.

### Risk if delayed

Medium. Every month without this is a month where integration authors either hack it with polling (wasted retries) or skip building the integration. The third scenario — a would-be community contributor abandons their Stripe integration because they can't express the 3DS flow — is the killer.

**Concrete risk:** the first real Stripe integration ships as a polling loop. It works but feels dumb. Reputation hit. First impressions set the bar for the ecosystem — "Chorus integrations feel clunky because the runtime is underpowered" is a hard narrative to escape once it sticks.

### Risk if rushed

Low. The design space is narrow — Inngest, Trigger.dev, n8n, Temporal all have essentially the same shape. We're implementing a known pattern.

**One subtle gotcha:** event matching. A workflow says `waitForEvent("payment.completed", event => event.session_id === sessionId)`. The match function runs inside the executor on each candidate event. If the match function is slow or non-deterministic, replay breaks. Make match functions **pure** — no closures over external state, no async. Document this loudly.

**Another gotcha:** event fan-out. If a workflow emits `runtime.emit("job.done", {...})` and 500 workflows are waiting for it, we need to wake them all. Single-node is fine (query the `steps` table, resume each). Multi-node (v2, §11.3 cross-node event bus) needs a real pub/sub. Defer that concern; single-node event triggers are v1.1, cross-node is v2.

### References

- `docs/ARCHITECTURE.md` §4.2 (trigger types — adds `event`)
- `docs/ARCHITECTURE.md` §4.3 (durable execution — waitForEvent is a variant)
- `docs/ARCHITECTURE.md` §11.2 (listed as v1.1 feature)
- `docs/research/01-workflow-engines.md` (scout-alpha's notes on Inngest/Trigger.dev wait primitives)

---

## 7. UI — reframed (we are not building a dashboard)

**Priority: 6.** Last because the answer is "the user's agent builds the UI, not us."

### The reframe

The user's exact words: *"we want the UI to be dynamic and built by the users agent, perhaps asking them how they want to see it and for any style they want things."*

Read that carefully. It's not "defer the UI." It's "the concept of a fixed UI is obsolete." Chorus is backend infrastructure for the agent era. Agents are the front-end.

This changes `ARCHITECTURE.md` §1.4's stance from "CLI ships first, UI later" to "CLI and JSON API ship — agents generate the UI." Hardcoded dashboard is **explicitly struck from the roadmap**, permanently.

### What was deferred (the old plan)

The original roadmap had a drag-drop visual flow builder at §11.3 (v2). That feature is dead. Here's why:

1. **Agents don't need drag-drop.** An agent generates a workflow from a prompt. Drag-drop is a UX affordance for humans who can't program. In an agent-era product, the human describes intent to the agent; the agent writes the `chorus/` TypeScript.
2. **Hardcoded dashboards are outdated by definition.** A `runs` dashboard we design in 2026 is a 2026 dashboard. A user in 2027 wants their dashboard to also include cost-per-run, latency breakdowns per integration, and patch-adoption telemetry. Their agent builds that dashboard on demand, from the JSON API, in whatever visual language they prefer.
3. **Every dashboard we ship is a dashboard we maintain.** Routes, components, ARIA, dark mode, i18n. Sibling agent `ui-kilo` is building the *JSON API that any dashboard could use*. That's the right layer for us.

### What ships instead

**`ui-kilo` is building this in parallel.** Expected deliverables (not in roadmap-lima's scope to detail):

1. **JSON API**: `@chorus/runtime` exposes `/api/runs`, `/api/patches`, `/api/credentials` (redacted), `/api/workflows`, `/api/integrations`. Documented via OpenAPI 3.1 spec. Accessible at `http://localhost:$PORT/api/*` from any HTTP client.
2. **`chorus ui --prompt`**: a CLI command that prints a prompt template. The user copies it into their agent (Claude, Cursor, GPT-5, whatever) and says "here's the API, give me a dashboard with dark mode and a focus on failed runs." The agent generates React/Svelte/HTMX/whatever, fetches the JSON API, renders the user's dream dashboard.
3. **OpenAPI spec shipped as a static artifact** for any existing "point-and-click API explorer" tool (Postman, Bruno, Insomnia).

roadmap-lima's role here is to clarify what comes *after* ui-kilo's work lands.

### Trigger (for anything beyond the JSON API + prompt template)

There are three possible v1.x+ UI extensions. Each has its own trigger:

**Extension A — "reference dashboard" (static, minimal):**
- Trigger: 5+ users say "I don't have an agent set up yet; can you ship something I can open in a browser for my first 30 minutes with Chorus?"
- This is *onboarding UI*, not *production UI*. It exists to let agent-less users see their first run in a browser.
- Scope: one HTML page, no build step, fetches the JSON API, shows runs + patches.
- Effort: 1 agent-day.

**Extension B — "OpenAI-compatible endpoint" (adapter):**
- Trigger: users with existing dashboard tools (Retool, Superblocks, n8n's own UI) ask "can I point my existing tool at Chorus's data?"
- Adapt the JSON API to speak OpenAPI in a way that conventional BI/dashboard tools understand.
- Effort: 2 agent-days, mostly API-shape decisions.

**Extension C — "hosted version of the reference dashboard" (nope):**
- Trigger: would be some form of "users want a shared web UI to see team workflows."
- **Explicit rejection.** `ARCHITECTURE.md` §1.4: "Not a hosted SaaS." We don't host dashboards.
- Users who want a hosted dashboard run the reference dashboard on their own infra. If they want a multi-tenant hosted version, they're outside Chorus's target.

### Priority rank: 6

Last. The JSON API (ui-kilo's work) is the only UI-layer work we're committed to. Everything else on this section is optional, demand-driven, and built as extensions only if users ask.

### First concrete steps (for the team reading this later)

**Not roadmap-lima's build list — ui-kilo's is.** This roadmap documents the decision, not the implementation.

What roadmap-lima commits to:
- Update `ARCHITECTURE.md` §1.4 bullet 1 to change "UI comes later; CLI ships first" to "Chorus is the backend; agents generate the UI. CLI ships first, JSON API ships alongside."
- Remove "Flow visual editor (drag-drop)" from `ARCHITECTURE.md` §11.3 v2 roadmap. Replace with "OpenAPI-spec'd JSON API + agent-generated dashboards."
- Remove "Web UI (read-only dashboard)" from `ARCHITECTURE.md` §11.2 v1.1 roadmap (except note: the reference dashboard in Extension A is ~1 day if needed).

### Estimated effort

**0 agent-days for the core decision** (it's a positioning change, not a build).
**1 agent-day** for Extension A (reference dashboard) if triggered.
**2 agent-days** for Extension B (OpenAPI adapter) if triggered.

### Risk if delayed

**No risk if we "delay" the dashboard — because we're not building it.** The risk is if we forget the decision and someone in 6 months starts building a hardcoded dashboard. This roadmap section exists to prevent that.

**Real risk:** ui-kilo's JSON API delivery slips. Without the JSON API, agents can't generate dashboards. Monitor that; the JSON API is the fulcrum.

### Risk if rushed

If we hear "users want a dashboard" and panic-ship a hardcoded one, we create maintenance debt for a feature that's outdated the day it lands. The agent-era positioning is strongest when Chorus is unapologetically backend. Shipping a dashboard dilutes that.

**Self-discipline:** when a user says "I want a dashboard," the correct first answer is "run `chorus ui --prompt` and paste that into your agent." If they don't have an agent, the second answer is "here's the reference dashboard" (Extension A). The third answer, "we'll build it for you," is *never* given.

### References

- `docs/ARCHITECTURE.md` §1.4 (will change per this section's decisions)
- `docs/ARCHITECTURE.md` §11.2 (v1.1 — UI bullet will be removed)
- `docs/ARCHITECTURE.md` §11.3 (v2 — "drag-drop flow editor" removed entirely)
- `ui-kilo`'s output (parallel agent, not yet merged as of this writing)

---

## Decision frameworks

### Framework 1: Auto-MCP vs. "just use the CLI from an agent"

The user's exact question: *"lets ship core then get auto-mcp per integration, but lets also consider we might just want skills or cli and have agents run things."*

This is a real tension. Both paths reach the same goal — "my agent can use Chorus integrations to do work." Different tradeoffs. Here's the framework and a concrete recommendation.

#### The two options

**Option A — Auto-MCP.** Each integration's operations become first-class MCP tools. Agents see them with typed schemas, descriptions, examples. Native in Claude Desktop, Cursor, Zed.

**Option B — CLI + agent.** Agents invoke `chorus run my-workflow --input '{...}'` via subprocess. No MCP server. Agent knows how to call the CLI because it reads the CLI docs.

#### When each wins

| Factor | MCP wins | CLI+agent wins |
|---|---|---|
| **First impression** | MCP (tools appear in the agent's native palette) | CLI (needs a prompt + example) |
| **Schema fidelity** | MCP (Zod → JSONSchema → MCP tool) | CLI (string args, agent parses) |
| **Discovery** | MCP (agent lists available tools) | CLI (agent must know to run `chorus list-integrations`) |
| **Credential injection** | MCP (server-side, transparent) | CLI (env vars, agent handles) |
| **Maintenance burden** | MCP (a new schema layer per integration) | CLI (nothing new per integration) |
| **Streaming results** | MCP (tool can return incremental data) | CLI (stdout, agent parses line-by-line) |
| **Works with non-MCP agents** | No | Yes (any agent that can run shell) |
| **Cross-machine usage** | MCP (stdio or remote via SSE) | CLI (SSH + env vars) |
| **Agents that already use CLI well** | Tied | CLI |

#### The recommendation

**Ship both. Not as a fallback — as a strategy.**

Here's the reasoning. MCP is the *premium UX* for MCP-compatible clients. But MCP isn't universal. A user running an open-source local agent, or a user inside a Jupyter notebook with a custom LLM harness, or a user whose agent is just `bash + claude -p`, doesn't speak MCP.

The CLI must be excellent regardless. Auto-MCP is a *superset* — it wraps the CLI's capability in an MCP surface. Every MCP tool is implemented as *"run this CLI command under the hood."* That way:

1. Both surfaces exist. Users pick.
2. Maintenance is shared — one underlying implementation, two surfaces.
3. If we later decide MCP was the wrong bet (say, OpenAI's tool-use spec dominates and MCP fades), the CLI is still excellent. No sunk cost.
4. If MCP wins (likely), the CLI is still useful for scripting and automation that isn't agent-driven.

#### Concrete implementation guidance

When shipping auto-MCP (section 1):
- The MCP tool `slack-send.send-message` internally runs `chorus run --integration slack-send --operation send-message --input '{...}'`.
- The Zod schema drives both the MCP JSONSchema and the CLI's `--input` validation.
- `chorus mcp` starts an MCP server that is literally a thin wrapper over the CLI, inheriting credentials from the same profile.

This is the "skills+CLI" path the user asked about, structurally realized, with MCP as a first-class surface on top. Not either/or. Both/and.

#### When to deprecate the CLI (never)

Even if auto-MCP succeeds wildly, the CLI stays. It's documentation-friendly, reproducible, scriptable, and gives us an audit trail ("the agent ran this exact command, logged in `~/.chorus/history.log`"). MCP without an underlying CLI is an opaque black box. Refuse to go there.

---

### Framework 2: When to migrate to Postgres

Section 2 already covers the triggers. This framework gives the decision logic *inside* the trigger.

#### The decision tree

```
User's runtime sees one of the scale triggers fire.
  ↓
Is the user's workload READ-heavy or WRITE-heavy?
  ↓
  READ-heavy  →  Try SQLite read replicas (litestream, rqlite) FIRST.
                 Only migrate to Postgres if read replicas don't solve it.
  ↓
  WRITE-heavy →  Migrate to Postgres.
                 Don't try to tune SQLite past 500 writes/sec.
```

#### The metric thresholds (concrete)

Run `chorus status --verbose`. Look for:

- **`run_rate_per_sec`** — if sustained > 50, migrate soon (Postgres).
- **`db_write_lag_p99_ms`** — if > 200ms sustained, migrate (Postgres).
- **`concurrent_runs_active`** — if > 30 sustained, migrate soon (Postgres).
- **`db_file_size_mb`** — if > 5000 (5 GB), consider migrating for ops reasons (backup/restore cost).
- **`queue_claim_contention_count`** — new metric (add in v1.1); if non-zero consistently, migrate.

None of these are hard cutoffs. They're smoke signals. The only hard cutoff: **if the user is running multi-node**, migrate to Postgres immediately. SQLite's single-writer constraint is non-negotiable.

#### What "migration" actually looks like

1. User runs `chorus status` and sees a warn on one of the thresholds.
2. Documentation links them to a "scaling" page.
3. They decide to migrate. They spin up Postgres (docker, RDS, whatever).
4. `chorus migrate --to postgres --url postgres://...` runs (15-30 min for a 2GB SQLite).
5. `chorus switch-backend postgres` flips config.
6. `chorus run` now uses Postgres.
7. SQLite file is preserved as backup. User deletes when confident.

**Rollback is not supported.** A user who finds Postgres annoying goes back to a fresh SQLite + re-imports workflows manually. We don't pretend to support downgrades because the failure modes of a half-migrated state are worse than re-import.

---

## Out-of-scope for v1.x (deferred to v2 or beyond)

These are things that could plausibly be on the v1.x roadmap but are *deliberately not here*. Listed so a future session doesn't wonder why.

1. **Hosted Chorus cloud.** Inherited from `ARCHITECTURE.md` §1.4. We do not host anything. The public patch registry is the only centralized thing we run. Users self-host everything else.

2. **Drag-drop visual workflow builder.** Killed per §7 of this document. Agents generate flows from prompts now; drag-drop is a 2018 UX that doesn't fit the 2026 agent era.

3. **Turing-complete flow expression language.** Windmill's advanced JSONnet, zapier's Code by Zapier, n8n's expressions — all fine within their scope, but Chorus flows stay declarative TypeScript/JSON. `ARCHITECTURE.md` §11.4.

4. **Self-hosted LLMs for repair agent.** Claude is the repair backend. If Anthropic pricing shifts drastically or a genuinely comparable local model appears, revisit. Until then, heterogeneity of LLM backends is complexity we don't need. `ARCHITECTURE.md` §11.4.

5. **Cryptographic PGP Web of Trust.** Scout-bravo's research concluded OIDC + reputation is sufficient for the trust model we need. PGP is UX-toxic for non-developers. `ARCHITECTURE.md` §11.4.

6. **Kubernetes-native deployment (operator, CRDs, etc.).** Chorus is a single binary + SQLite or Postgres. K8s is an option for ops teams who want it, but we don't ship operators or Helm charts. `ARCHITECTURE.md` §11.4.

7. **CRIU-based process checkpointing.** Trigger.dev does this; it's Linux-specific and conflicts with our cross-platform priority. `ARCHITECTURE.md` §11.4.

8. **Multi-tenant registry.** Public registry is one namespace. Enterprises who want private namespaces run their own fork of the registry server. The "federated registry topology" open question in `ARCHITECTURE.md` §12 is a v2+ question.

9. **Workflow marketplace / paid integrations.** No. Every integration is open-source. The patch registry is free. Monetization path, if any, is support contracts or hosted infrastructure — not gated integrations. Not roadmap material because it's against the fundamental positioning.

10. **Non-MCP agent frameworks natively supported.** LangChain, CrewAI, AutoGen — they can call the CLI (or a REST adapter over it). We don't ship framework-specific SDKs. The CLI + JSON API surface is enough.

---

## How to update this doc

### When a trigger fires

1. Find the section (e.g., §1 auto-MCP).
2. Update the section with a dated note: `**2026-09-12:** Trigger fired — 12 users asked in Discord. Starting work.`
3. Change the at-a-glance table entry's "Build now vs. wait?" to "Building."
4. Create a GitHub issue tracking the work.
5. When complete, mark the section as "Shipped in v1.X" and move its detail to `CHANGELOG.md`.

### When priorities shift

The at-a-glance table's priority numbers (1-6) are advisory, not law. If a real-world signal makes §3 (sandbox) urgent (say, a major security incident), bump it up and document why.

Add a "Revision log" bullet at the bottom of the modified section: `**Priority bumped 2026-07-01:** security incident CVE-2026-1234; previously rank 5.`

### When an item becomes obsolete

Delete it. Don't leave cruft. But **record the deletion** in the `CHANGELOG.md` with rationale. Future sessions should be able to answer "why isn't X in the roadmap?" by reading the changelog.

### When a new item appears

Section 0 — "Scope change." At the top of this document, log any new roadmap items since the original 7. Format:

```
**2026-06-15 — Added item 8: multi-region registry replication.**
Trigger: enterprise asked for geo-local reads. Priority 4. Effort: 2 weeks.
```

Never silently change the 7-item structure; the roadmap is a covenant with future sessions and with the user.

### When a section changes a referenced `ARCHITECTURE.md` line

Edit `ARCHITECTURE.md` in the same commit. Roadmap is the plan; architecture is the truth. They must be synchronized.

---

*End of roadmap. Next review: when the first of the seven triggers fires, or 90 days from the last update, whichever comes first. Signed by roadmap-lima, session 2, 2026-04-14.*
