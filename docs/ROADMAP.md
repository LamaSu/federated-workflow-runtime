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
