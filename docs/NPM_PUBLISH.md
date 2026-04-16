# npm publication runbook

*Author: npm-november (session 3). Trigger-owner for ROADMAP §5. Supersedes the placeholder "coming soon" text in `README.md` whenever it appears.*

## Who this is for

Anyone releasing a new version of `@chorus/*` (including the `@chorus/integration-*` packages) to npmjs.com. That's two audiences:

1. **Release managers** — you bump the version, tag, and let CI publish.
2. **Anyone debugging a broken publish** — you need to know the manual fallback.

Most days, you only read §3. §1 is one-time setup. §2, §4, §5, §6 are for edge cases.

---

## 1. One-time setup (do this once per org)

### 1.1 Claim the npm scopes

`@chorus` is a single npm org (scope) covering all 9 packages. Integrations live under `@chorus/integration-<name>` to stay inside the one scope. The org must be claimed on npmjs.com before any publish.

```bash
# Log in to npm with the account that will own the orgs.
npm login --auth-type web

# Create the first scope (it doubles as the org).
# npmjs.com UI: https://www.npmjs.com/org/create
#   Org name: chorus              (free tier: public packages only — that's what we want)
#   Org name: chorus-integrations
```

Add maintainers via the web UI once the org exists: `https://www.npmjs.com/settings/chorus/members`.

**Do NOT publish the first version from a personal token.** Go straight to the Trusted Publisher flow below — even the first `0.1.0` should have provenance.

### 1.2 Configure Trusted Publisher (per package)

npm's Trusted Publisher feature binds a package name to a GitHub repo + workflow. When the bound workflow asks for an OIDC token, npm accepts the publish with no static `NODE_AUTH_TOKEN`. This is how we get provenance attestations without long-lived secrets.

For each published package: go to `https://www.npmjs.com/package/<name>/access`, scroll to **"Trusted Publisher"**, click **"GitHub Actions"**, and fill in:
- Organization: `LamaSu`
- Repository: `federated-workflow-runtime`
- Workflow filename: `publish-npm.yml`
- Environment: *(leave blank)*

Packages to configure (nine total):

All under the single `chorus` scope: `@chorus/core`, `@chorus/runtime`, `@chorus/registry`, `@chorus/reporter`, `@chorus/repair-agent`, `@chorus/cli`, `@chorus/mcp`, `@chorus/integration-http-generic`, `@chorus/integration-slack-send`.

**Chicken-and-egg.** Trusted Publisher requires the name to exist on npm first. For the `0.1.0` release, manually publish once with a personal token, then bind Trusted Publisher. Every later release is CI-driven.

### 1.3 Verify the GitHub workflow permissions

`.github/workflows/publish-npm.yml` already declares `permissions: { contents: read, id-token: write }`. That's all CI needs — no secrets. If publish ever errors `E403: Authentication failed`, suspect (in order): Trusted Publisher not configured for that package, workflow filename changed, repo name changed.

---

## 2. Architecture decisions

Three choices you will be tempted to second-guess:

- **Workspace deps stay as `"*"`.** `npm publish --workspaces` rewrites `*` to the actual version at publish time (npm 7+). We do NOT pre-rewrite via a script — that would introduce drift and complicate prereleases. If `check-publish-ready.sh` ever catches a broken tarball, the gate did its job.
- **OIDC provenance, not static `NODE_AUTH_TOKEN`.** Every tarball is signed by Sigstore, linked to this repo + commit + workflow. Users verify with `npm audit signatures @chorus/cli`. Same trust model as `federation/github-actions/sign-patch.yml`. Rotating tokens is a distraction; being compromised is worse.
- **Version lockstep.** All nine packages bump together, enforced by `scripts/bump-version.js --check` in CI. Cost: a single-package bugfix still bumps the patch version of the others. Benefit: `@chorus/cli@X.Y.Z` always expects `@chorus/runtime@X.Y.Z`. Through v1.x the cost is trivial; revisit post-1.0 if it hurts.

---

## 3. Per-release process (the happy path)

Day-to-day flow. Six steps; memorize the order.

```bash
# 1. Bump all nine package.json versions in lockstep.
node scripts/bump-version.js 0.2.0
node scripts/bump-version.js --show          # confirm every row shows 0.2.0

# 2. Local smoke: install, build, test, publish-readiness.
npm ci && npm run build && npm test
bash scripts/check-publish-ready.sh          # must exit 0; fix any FAIL

# 3. Commit + tag + push (ALWAYS to `lamasu`, never `origin`).
git add -u
git commit -m "chore(release): v0.2.0"
git tag release/v0.2.0
git push lamasu HEAD release/v0.2.0

# 4. Watch CI (~5-8 min) at
#    https://github.com/LamaSu/federated-workflow-runtime/actions
#    Workflow phases: ci → check-publish-ready → version-sync → build → test → publish.

# 5. Verify on npm.
npm view @chorus/cli@0.2.0
npm audit signatures @chorus/cli@0.2.0       # must say "verified"
# Confirm the "Provenance" badge at https://www.npmjs.com/package/@chorus/cli

# 6. Smoke-test from a clean tmpdir.
cd /tmp && mkdir chorus-smoke && cd chorus-smoke
npx @chorus/cli@0.2.0 --version              # prints 0.2.0
npx @chorus/cli@0.2.0 init                   # scaffolds ./chorus/
```

If `npx chorus init` 404s, the `bin` field didn't package correctly — roll back per §5 and investigate.

---

## 4. Manual publish fallback (when CI is broken)

Only do this if §3 is blocked (GH Actions outage, Trusted Publisher misconfigured). Manual publishes do NOT carry a provenance attestation — document that fact in the PR and `ai/memory/WORKING_MEMORY.md`, and re-establish provenance on the next CI-driven release.

```bash
# 1. Auth
npm login --auth-type web && npm whoami

# 2. Verify clean state
git status                           # must be clean
git describe                         # must match release/vX.Y.Z
bash scripts/check-publish-ready.sh  # must exit 0
npm run build && npm test

# 3. Dry-run — eyeball tarball contents for each package
npm publish --workspaces --access public --dry-run
# Confirm: dist/*.js + dist/*.d.ts present, sandbox-worker.cjs for runtime,
# shebang on dist/cli.js, no .ts sources, no node_modules, no .env*.

# 4. Publish (no --provenance; OIDC unavailable outside CI)
npm publish --workspaces --access public

# 5. Verify — see §3.5
```

---

## 5. Rollback

**npm does not support `npm unpublish` on packages with dependents, more than 72 hours after publish.** This constraint is not negotiable.

So the *only* safe rollback is: **publish a higher patch version that fixes or reverts the bad change.**

### 5.1 Ship a patch

```bash
# Make the revert on a branch.
git revert <bad-commit-sha>
# Or roll forward with a hotfix commit.
node scripts/bump-version.js 0.2.1
git add -u && git commit -m "chore(release): v0.2.1 — revert <thing>"
git tag release/v0.2.1
git push lamasu HEAD release/v0.2.1
```

CI will publish `0.2.1`. Users who `npm install @chorus/cli@latest` immediately pick it up. Users pinned to `0.2.0` stay pinned until they re-install.

### 5.2 Last-resort: deprecation

If the bad version is actively harmful (data loss, security issue), add a deprecation message:

```bash
npm deprecate @chorus/cli@0.2.0 "Critical bug — upgrade to 0.2.1 or later."
```

Deprecation is not removal. The tarball stays available. But `npm install` prints a loud warning.

### 5.3 Write a postmortem

Within 24 hours, add an entry to `docs/INCIDENTS.md` (create it if it doesn't exist yet). Sections:
- Symptom (what users saw)
- Root cause (why it shipped)
- Why it passed CI (what gate missed it)
- Fix version
- Gate change (what we're doing so this class of bug can't ship again)

---

## 6. Versioning policy

- **Semver.** `MAJOR.MINOR.PATCH`.
- **v0.x.** Any release is allowed to break any API. Use `^0.1.0` in consumer `package.json` files ONLY if you accept breakage on `0.2.0`. Most consumers should pin `0.1.0` exactly during v0.x.
- **v1.0 is the compatibility promise.** After v1.0:
  - MAJOR bumps (1 → 2) may break public API. Changelog must list breaks.
  - MINOR bumps (1.0 → 1.1) add functionality only.
  - PATCH bumps (1.0.0 → 1.0.1) fix bugs only.
- **No unreleased `-dev` builds on npm.** For prerelease testing, use `-rc.N` tags: `0.3.0-rc.1`, `0.3.0-rc.2`.
- **All packages bump together.** See §2.3.

---

## 7. Pre-flight checklist

Before every release, tick every box:

- [ ] `node scripts/bump-version.js --check` passes (all 9 packages in lockstep).
- [ ] `bash scripts/check-publish-ready.sh` exits 0 with 0 FAILs.
- [ ] `npm run build` succeeds.
- [ ] `npm test` shows 395+ tests passing (no regressions from baseline).
- [ ] `node packages/cli/dist/cli.js --version` prints the new version.
- [ ] `QUICKSTART.md` install instructions still reference the published scope names.
- [ ] `CHANGELOG.md` has an entry for the new version (create it on the first published release).
- [ ] Commit is signed (optional but recommended).
- [ ] Tag matches `release/vX.Y.Z` format exactly.

Push the tag only after every box is ticked.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `E403 Forbidden` on publish | Trusted Publisher not configured for that package / workflow renamed / repo renamed | Re-verify §1.2 for the failing package |
| `E402 Payment Required` | Scoped package defaulted to private; `publishConfig.access` missing or `restricted` | Set `"access": "public"` in `publishConfig`. `check-publish-ready.sh` catches this |
| `ENEEDAUTH` in CI | Missing `permissions: { id-token: write }` OR Trusted Publisher unconfigured | Compare to `.github/workflows/publish-npm.yml` |
| Provenance missing from tarball | Published outside CI, or `--provenance` omitted | Publish from CI. Manual publishes never carry provenance |
| Version drift | Someone edited one `package.json` directly | `node scripts/bump-version.js <version>` to re-sync |
| `npx chorus init` → "cannot find module" | `dist/cli.js` missing from tarball or shebang stripped | `check-publish-ready.sh` validates both. tsup preserves shebang by default; never pass `--no-preserve-shebang` |

### Prerelease publishes

Use explicit prerelease versions. CI tags them under `next` dist-tag instead of `latest`:

```bash
node scripts/bump-version.js 0.3.0-rc.1
git tag release/v0.3.0-rc.1 && git push lamasu release/v0.3.0-rc.1
npm install @chorus/cli@next    # users opt in
```

Promote to `latest` manually when ready: `npm dist-tag add @chorus/cli@0.3.0-rc.1 latest` (or just release `0.3.0`).

---

## 9. References

- `docs/ROADMAP.md` §5 — the trigger and rationale for this work.
- `QUICKSTART.md` — promises `npx chorus init`. This runbook makes that promise real.
- `federation/github-actions/sign-patch.yml` — the sister OIDC pattern for patch signing. Same trust model, different surface.
- `docs/ARCHITECTURE.md` §12 Q9 — npm vs. Homebrew vs. MSI installer comparison.
- `scripts/check-publish-ready.sh` — the gate. Runs locally, runs in CI, blocks broken publishes.
- `scripts/bump-version.js` — the one tool that edits all 9 package.json files atomically.
- `.github/workflows/publish-npm.yml` — the CI workflow. Read it end-to-end once; it's short.

---

*Signed by npm-november, session 3. Next review: when we cut v1.0 (expect major additions to §6 versioning policy) or when npm changes its Trusted Publisher flow (expect §1.2 rewrite).*
