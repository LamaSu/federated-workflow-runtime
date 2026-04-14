# Research 02: Patch Registry + Supply Chain Security
Agent: scout-bravo
Started: 2026-04-13T00:00:00Z
Completed: 2026-04-13T01:30:00Z
Project: Chorus — federated workflow runtime
Wave 1 parallel with scout-alpha (workflow engines), scout-charlie (error sigs + testing)

## Problem Statement
When Chorus's repair agent proposes a fix for a broken integration, users need to safely
adopt the fix without MITM/supply-chain attacks. We need a signed patch registry with
safe rollout to a fleet of user machines.

## Progress Tracker
- [x] Sigstore / Cosign / SLSA provenance
- [x] npm provenance feature (sigstore-backed)
- [x] Homebrew formula distribution model
- [x] Chrome component updater architecture
- [x] CrowdStrike content delivery
- [x] Staged rollout / canary patterns (iOS, Kubernetes, feature flags)
- [x] Reputation systems (npm, PGP web of trust, Stack Overflow)
- [x] Threat model: malicious patches
- [x] Rollback strategies
- [x] Synthesis for Chorus

---

## Sigstore / Cosign — Keyless Signing via OIDC + Rekor

### How Keyless Signing Works
Source: https://docs.sigstore.dev/cosign/signing/overview/, OpenSSF blog Feb 2024

The breakthrough insight: **identities, not keys**, are associated with artifact signatures.
This eliminates the "how do I store a private key securely" problem that made classic
PGP/Ed25519 signing painful.

Flow:
1. Signing client generates an **ephemeral** public/private keypair in memory.
2. Signing client obtains an **OIDC identity token** from a supported provider
   (Microsoft, Google, GitHub; also GitLab CI, CircleCI via workload identity).
3. Client sends (token + ephemeral public key) to **Fulcio**, Sigstore's CA.
4. Fulcio validates the OIDC token and issues a **short-lived X.509 certificate**
   (valid ~10 min) that binds the ephemeral public key to the OIDC identity
   (e.g., `alice@example.com` or `github.com/lamasu/chorus@refs/heads/main`).
5. Client signs the artifact hash with the ephemeral private key.
6. Client submits a transparency log entry to **Rekor**: (artifact hash, public key,
   signature, timestamp).
7. Rekor returns a **Signed Entry Timestamp (SET)** — proof that the entry is in the log.
8. Client **destroys the private key**. The certificate expires in minutes.

### Verification Commands (Concrete)

Identity-based verification (keyless):
```bash
cosign verify-blob \
  --bundle patch.sigstore.json \
  --certificate-identity="chorus-bot@chorus.dev" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  patch.tar.gz
```

Offline verification (no Rekor call) using a bundle containing the SET:
```bash
cosign verify-blob \
  --bundle patch.sigstore.json \
  --offline=true \
  --certificate-identity-regexp="^chorus-bot@.*$" \
  patch.tar.gz
```

### Sigstore Bundle Format v0.3
Source: https://docs.sigstore.dev/about/bundle/

A single bundle file (`.sigstore.json`) contains EVERYTHING needed to verify:
- DSSE-wrapped in-toto attestation (the SLSA provenance)
- X.509 certificate from Fulcio
- Rekor Signed Entry Timestamp (SET) for offline verification
- Signed timestamp from a TSA (tamper-proof time attestation)

This is the format Chorus should use. Single file, self-contained, offline-verifiable.

### Why This Matters for Chorus
- **No private key management** for human contributors. They sign with their GitHub/Google identity.
- **Revocation is easy**: remove the OIDC identity from the allow-list.
- **Public transparency**: any malicious signing of a chorus patch would be visible in Rekor,
  and the real contributor would notice their identity being used.
- **Can sign anything**: OCI images, files, git commits, blobs.
- **Offline verification possible** via the Rekor SET in the bundle — critical for air-gapped
  or field-deployed Chorus nodes that can't reach Rekor on every verification.

---

## SLSA (Supply-chain Levels for Software Artifacts) — Levels 1-4

Source: https://slsa.dev/spec/v1.0/levels, Wiz SLSA Academy, Google SLSA spec

### Level 0 — No SLSA. Informal trust only.
### Level 1 — Provenance Exists
- Producer generates & distributes **provenance** describing build platform, process, inputs.
- Not tamper-proof. Enables debugging and vuln identification.
### Level 2 — Hosted Build + Signed Provenance
- Build runs on **dedicated hosted infrastructure** (not a laptop).
- Provenance is **digitally signed** by the build platform. (GitHub Actions + sigstore = L2.)
### Level 3 — Hardened Build Platform
- L2 + **run-to-run isolation** + **signing keys inaccessible to build scripts**.
- The key distinction vs L2: tampering DURING the build is prevented, not just AFTER.
### Level 4 — Deferred in v1.0 (two-person review + hermetic + reproducible).

### Key Insight for Chorus
- **Target L2 for MVP**: sign with sigstore from GitHub Actions. "Good enough."
- **L3 would require** our own hardened build platform — probably not worth it initially.
- **Provenance JSON** should include: patch source repo, commit SHA, build steps,
  dependencies, and the human/bot identity that triggered it.

---

## npm Provenance (Sigstore-Backed) — GA since April 2023

Source: https://blog.sigstore.dev/npm-provenance-ga/, https://docs.npmjs.com/generating-provenance-statements/,
https://docs.npmjs.com/trusted-publishers/

### How It Works
1. Developer runs `npm publish --provenance` in a CI environment (GitHub Actions, GitLab CI).
2. npm CLI detects the OIDC provider and uses **workload identity federation** — no secrets.
3. CLI gets OIDC token from CI system → sends to Fulcio → gets short-lived cert binding the
   public key to `github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main`.
4. CLI signs a **SLSA provenance attestation** (JSON):
   - `subject`: package name@version + tarball SHA-512
   - `predicate`: builder, invocation (workflow run URL), materials (source commit)
5. Attestation sent to Rekor for transparency logging.
6. Bundle uploaded to npm registry alongside the tarball.
7. Registry verifies signature + checks identity matches a "trusted publisher" config.

### Trusted Publishers (Key Security Win)
Configuration:
- **GitHub Actions**: org/user + repo name + workflow filename + optional environment name
- **GitLab CI**: namespace + project + CI file path + optional environment
- **CircleCI**: org ID + project ID + pipeline definition ID + VCS origin URL

All fields are **case-sensitive and exact**. Any drift and the publish is rejected.

### What Trusted Publishing Prevents
- **Stolen npm token attacks**: tokens are now short-lived, cryptographically signed per-workflow,
  and cannot be extracted from CI logs or reused.
- **Compromised maintainer laptop**: the laptop no longer has publish rights, only the CI system does.
- **Accidentally-leaked tokens**: impossible — there's no long-lived token to leak.

### Verification (Consumer Side)
- `npm audit signatures` verifies provenance for installed packages.
- npmjs.com shows a "Provenance" badge linking to the transparency log.

### Key Insight for Chorus
- **Emulate npm's trusted-publisher model**: register a specific workflow file path that signs patches.
- Use **SLSA provenance JSON** as our attestation format.
- The pattern is now the de facto standard; don't invent a new one.
- Binding to workflow FILE PATH (not just repo) means an attacker who can push to the repo
  still can't publish — they'd need to get their malicious workflow approved too.

---

## Homebrew Formula Distribution Model

Source: https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request, Formula-Cookbook

### Model: Pure Git + Human Review + Checksum
- **No per-user signing.** Full stop.
- Formulas in **GitHub "taps"**: `Homebrew/homebrew-core`, plus user/org taps.
- A formula is a **Ruby file** with source URL, SHA-256, deps, build steps, test.
- `brew install foo`:
  1. Clone/pull the tap's git repo via HTTPS.
  2. Read the formula.
  3. Download the source tarball.
  4. **Verify SHA-256** matches the formula.
  5. Build locally (or use pre-built "bottle" from CDN).

### Review Process
- Fork `Homebrew/homebrew-core`, add formula, open PR.
- **BrewTestBot**: `brew audit --new --formula foo` validates naming/format/license + builds on macOS+Linux.
- **Human maintainer review**: popularity, open source, conventions.
- Once merged, available on next `brew update`.

### Why No Signing?
1. Trust is in **GitHub HTTPS + git content-addressable hashes**. Tarball tampering caught by checksum.
2. Formulas are **public Ruby code, human-reviewed** before merge. The review IS the signature.
3. Per-user signing was tried; unmaintainable at their update volume.

### Key Insight for Chorus
- Homebrew works **because** of full-time maintainers reviewing every submission.
  Chorus cannot copy this 1:1.
- BUT: **"fetch, verify hash, execute"** is sound. Just need the hash+signature from trusted source.
- **Tap model (decentralized)** is attractive: let each team host their own patch registry as a git repo.
- **Checksum-in-manifest** is a good hedge: even if sigstore fails, SHA-256 catches tarball tampering.

---

## Chrome Component Updater + CRX3 Format

Source: https://chromium.googlesource.com/chromium/src/+/lkgr/components/component_updater/README.md,
Chromium Updater Functional Specification

### Architecture
- Component Updater is a **piece of Chrome that updates other pieces of Chrome** without
  requiring a full browser update. Examples: SafeBrowsing lists, Widevine DRM, Origin Trials.
- Components are delivered as **CRX3 files** (signed ZIP archives).
- Registers components at browser startup; starts checking for updates **6 minutes later**,
  with substantial pauses between successive updates (rate-limited to avoid thundering herd).

### CRX3 Signing — The Self-Certifying ID Pattern
- Developer creates an RSA key pair.
- Component ID = **first 128 bits of SHA-256(public key)**, rendered as hex in a-p charset.
  This makes the ID self-certifying: **the ID IS the hash of the trusted key.**
- The CRX3 archive is signed with that RSA private key.
- Chrome verifies the signature against the known public key before installing.
- Invalid signatures → **rejected, not installed**.

### Omaha Update Protocol
- Chrome polls Google-operated Omaha servers for update manifests.
- Server responds with: new version, download URL, SHA-256 of the CRX3.
- Chrome can perform **differential updates** (transparent version patching).

### Why This Pattern Matters for Chorus
- **Self-certifying IDs**: encoding the public key hash INTO the component ID means
  an attacker can't spoof a component unless they compromise both the registry AND the
  hardcoded pubkey-hash in the client. Chorus should use this: patch IDs derived from
  the hash of the signer's OIDC identity + content hash.
- **Rate-limiting update checks** (6min pause, then dwell) prevents thundering herd.
- **Differential updates** are efficient — only download the diff from current version.
- **Update on scheduled interval, not on-demand**: gives Google time to detect bad components
  and pull them before mass deployment.

---

## CrowdStrike Channel Files — The Cautionary Tale

Source: https://www.crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf,
https://overmind.tech/blog/inside-crowdstrikes-deployment-process

### Architecture (Pre-Outage)
- Falcon sensor is a **modular service** with behavior controlled by "channel files" (config files).
- Channel files contain "Template Instances" — instantiations of Template Types, each mapping
  to specific sensor behaviors.
- **Rapid Response Content** was pushed **immediately to the entire fleet** to respond to
  new threats quickly.
- The sensor read Template Instances from disk and executed them in the kernel driver.

### What Went Wrong (July 19, 2024)
- A **content validation bug** let a malformed Channel File 291 pass testing.
- When deployed **instantly to ~8.5 million machines worldwide**, it caused Windows kernel
  crashes (BSOD) as the sensor tried to read an out-of-bounds memory region.
- Recovery required **manual boot-to-safe-mode** on every affected machine. Estimated
  damages: $5.4B+ to Fortune 500 alone.

### Post-Incident Changes
- **Staggered deployment** — "updates gradually deployed to larger portions of the sensor
  base, starting with a **canary deployment**."
- **Canary ring → deployment rings → full rollout** — new Template Instances must pass
  canary before wider promotion, OR be rolled back if problems detected.
- **Customer-controlled delays**: admins can now choose update cadence.
- **Content schema validation** added before acceptance into the pipeline.

### Key Insight for Chorus — This Is Our Worst Case
- A patch registry that pushes updates **instantly to all users** is one bug away from mass outage.
- **MUST have canary rollout**. Not optional.
- **MUST have content validation** BEFORE accepting patches into the registry —
  not just signature verification. Schema + sanity checks + smoke tests.
- **MUST have rollback/kill switch** that can be triggered faster than the rollout wave moves.
- **Customer control** over update timing is table stakes for enterprise use.

---

## Canary Deployment + Staged Rollout Patterns

Source: https://www.getunleash.io/blog/canary-deployment-what-is-it,
https://launchdarkly.com/blog/four-common-deployment-strategies/,
https://configcat.com/blog/2024/01/16/using-configcat-for-staged-rollouts-and-canary-releases/

### The Canary Pattern
Named after "canary in a coal mine" — a small sacrificial cohort gets the change first.
If the canary "dies" (errors spike, perf degrades), rollback before wider damage.

### Typical Stages
Iterative ladder, with each stage dwelling long enough to collect signal:
- **Dev/internal**: 100% of dev team, ~1 day dwell
- **Canary 1%**: smallest external cohort, ~2-24 hours dwell, watch error rate + perf
- **Canary 5-10%**: broader cohort, ~1-3 days
- **Rollout 25-50%**: majority, dwell based on risk (hours for hotfix, days for feature)
- **Full 100%**: complete rollout

### Cohort Selection
- **Hash-based**: `hash(user_id + feature_name) % 100 < rollout_pct` — stable per user,
  so once a user is in a canary they stay in it.
- **Geo/environment**: roll out to non-production or secondary regions first.
- **Self-selection**: opt-in "beta" or "early access" rings.

### Kill Switch
- Feature flag service (Unleash, LaunchDarkly, ConfigCat, PostHog) lets you flip a boolean
  to disable a feature across the fleet in seconds, without a code deploy.
- Critical: kill switch state **evaluated client-side**, with a cache-bust mechanism so
  clients poll often enough to pick up the kill.

---

## iOS App Store Phased Release

Source: https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/

The canonical "fixed ladder" model: **7-day rollout, fixed percentages**, no customization.

### Day-by-Day Schedule
| Day | % Receiving Update |
|-----|-------------------|
| 1   | 1%                |
| 2   | 2%                |
| 3   | 5%                |
| 4   | 10%               |
| 5   | 20%               |
| 6   | 50%               |
| 7+  | 100%              |

### Properties
- Applies only to **automatic updates** — users who manually download get the latest always.
- Developer can **pause for up to 30 days**, unlimited times.
- Cannot customize percentages. Apple forces this ladder.
- Random cohort selection.

### Why This Pattern is Good
- **Simple mental model**: users know "7 days to fleet." No surprises.
- **Fixed ladder reduces ops burden**: no per-release percentage tuning.
- **Pause capability**: stop rollout at any point if issues detected, retain past cohorts.
- **Manual override escape hatch**: paranoid users can force-update today if they want.

### Key Insight for Chorus
Adopt iOS's fixed ladder as our DEFAULT, customizable only for urgent security patches:
- `1% → 2% → 5% → 10% → 20% → 50% → 100%` over 7 days
- For critical security patches, a faster ladder: `1% → 10% → 50% → 100%` over 4 hours

---

## Reputation Systems — Comparative Analysis

### PGP Web of Trust
Source: https://en.wikipedia.org/wiki/Web_of_trust, https://www.gnupg.org/gph/en/manual/x547.html

**Model**: Decentralized signing; anyone can sign anyone's key.
- Users assign trust levels to other users (full, marginal, none).
- A key is considered "valid" if signed by one fully-trusted user OR three marginally-trusted users.
- Transitive trust chains: Alice trusts Blake → Blake signs Chloe's key → Alice trusts Chloe.
- **Key signing parties**: in-person meetups where people verify ID, sign each other's keys.

**Weaknesses**:
- Requires a critical mass of users actively signing.
- New contributors have no reputation; hard to bootstrap.
- Centralized keyservers in practice (SKS, Ubuntu keyserver) = single points of failure.
- UX is notoriously bad.

### Stack Overflow Reputation
Source: https://internal.stackoverflow.help/en/articles/8775594-reputation-and-voting

**Model**: Points for contributions, unlocking privileges at thresholds.
- +10 for upvote on answer; +5 for upvote on question; +15 for accepted answer.
- **Daily cap of 200 rep** from up/downvotes (bounties + accepted answers uncapped).
- Downvoting an answer costs 1 rep to discourage griefing.

**Privilege Ladder**:
| Rep | Privilege |
|-----|-----------|
| 15  | Upvote |
| 100 | Downvote |
| 1k+ | Edit others' posts |
| 2k+ | Edit without review |
| 10k+ | Access to delete, close/reopen, etc |
| 20k+ | Protect questions, trusted user |

**Badge System**: 3 tiers (bronze/silver/gold) marking specific achievements — orthogonal
to rep, but drives engagement.

**Why It Works**:
- **Reputation = delegated responsibility**: high-rep users can moderate, lowering burden on official mods.
- **Gradual trust**: you don't get power all at once.
- **Visible, transparent scoring**: anyone can see why someone has high rep.

### Bug Bounty Programs (HackerOne, Bugcrowd)
**Model**: Curated onboarding, reputation from validated reports.
- Initial report → triaged by program → accepted/rejected/duplicate.
- Accepted = reputation points + $$ payout.
- Rejection repeatedly = throttling or banning.
- **Level gating**: some programs only allow "Veteran" or "MVH" hackers to test.

### Key Insight for Chorus
**Hybrid model recommended:**
1. **Patches submitted** earn reputation when merged & verified working in production.
2. **Contributors unlock privileges** at thresholds:
   - 0 rep: submit patches (goes to review queue)
   - 100 rep: submit patches (auto-approved to dev ring)
   - 1000 rep: submit patches (auto-approved to 1% canary)
   - 5000 rep + maintainer approval: can push directly to fleet
3. **Reputation decays** if a patch causes a production incident (like Stack Overflow rep loss).
4. **Badges**: "First Patch", "100 Patches", "0 Incidents", "First Kernel Patch" drive engagement.
5. **Do NOT copy PGP WoT**: UX is bad, bootstrapping is worse. OIDC identity is enough.

---

## Threat Model — Specific to Chorus

### Threat 1: Malicious Fix Replacing Token Refresh with Token Exfiltration
**Scenario**: Repair agent proposes a "fix" for OAuth token refresh. The patch looks innocuous
but replaces the refresh endpoint URL with an attacker-controlled server, exfiltrating every
user's access tokens.

**Real-world precedent**: The plain-crypto-js attack on axios (March 31, 2026) did exactly this —
a malicious dependency masquerading as a crypto utility exfiltrated credentials to
`packages.npm.org/product{0,1,2}` (a typosquat of `packages.npmjs.org`).

**Defenses**:
- **Code review gate** — every patch touching auth code requires human review before signing.
- **Static analysis** — deny-list patterns: network calls to unknown hosts in auth modules,
  string literals that look like exfil endpoints.
- **Canary rollout** — even if malicious code is signed, only 1% sees it first. Outbound
  traffic analysis on canary cohort would catch the exfil attempts.
- **Capability-based sandboxing** — patches to auth modules can't introduce new network hosts.

### Threat 2: Supply Chain via Dependency Addition
**Scenario**: Patch adds a new dependency (`"plain-crypto-js": "^1.0.0"`) that looks legitimate
but is actually malware. This is the Shai-Hulud 2.0 attack (Nov 2025, 25,000+ repos compromised).

**Defenses**:
- **Deny-list checks**: known malicious packages.
- **Dependency pinning** — exact versions only, no `^` or `~` ranges.
- **Sub-dependency attestation** — require signed SLSA provenance for every transitive dep,
  recursively.
- **New-dep cooldown**: any patch adding a NEW dependency (never seen before) gets extra
  human review. No exceptions.
- **SBOM diff**: compare SBOM before/after; flag unexpected additions.

### Threat 3: Targeted Attack (Different Patch for Specific Fingerprints)
**Scenario**: Attacker compromises the signing infrastructure and pushes different patches
to different users based on system fingerprint (username, MAC, geo-IP). Benign patch to
security researchers; malicious patch to target org.

**Real-world precedent**: SILKBELL payload in plain-crypto-js did this — different binaries
per OS (`/product0` for macOS, `/product1` for Windows, `/product2` for Linux). Could
easily be per-user instead of per-OS.

**Defenses**:
- **Content-addressed distribution**: every user requesting a specific patch ID gets the
  same bytes. The patch ID IS the hash of the content.
- **Rekor public log**: all signatures are logged publicly. Anyone can compare: "the patch
  I got claims to be `chorus/oauth-fix@v1.2.3`, but the Rekor log for that version shows
  a different hash." Discrepancy = attack detected.
- **CDN integrity**: serve from CDN with immutable content hashes; clients verify hashes
  match the signed manifest.
- **Multi-witness verification**: clients optionally check with N geographically-diverse
  mirrors and diff responses.

### Threat 4: Compromised Signing Key / OIDC Identity
**Scenario**: Attacker gains access to the CI workflow that signs patches (perhaps via
compromised GitHub Actions secret or stolen OIDC token in transit).

**Defenses**:
- **Short-lived certs** (10 min window) limit blast radius.
- **OIDC identity binding to specific workflow file + branch** — attacker needs to modify
  the workflow definition itself, which requires merging a PR.
- **2-person PR review** for any changes to signing workflow.
- **Rekor monitoring**: alert when chorus-bot signs anything from an unexpected branch/path.
- **Identity revocation**: remove the compromised identity from the allow-list; all
  post-compromise patches fail verification.

### Threat 5: Rollback Attack (Downgrade)
**Scenario**: Attacker can prevent the client from receiving the LATEST patch (MITM on
network) and instead replays an OLDER signed patch that had a known vulnerability.

**Defenses**:
- **Monotonic version numbers** enforced by client: never accept a version lower than what's
  already installed.
- **Signed manifest with freshness**: the registry manifest includes a signed "current version
  as of time T." Clients reject manifests older than their last-known manifest.
- **Certificate Transparency-style witness**: multiple clients share "latest version seen"
  gossip to detect split-view attacks.

### Threat 6: Malicious Insider Publishing Patch
**Scenario**: A contributor with legitimate signing privileges pushes a backdoored patch.

**Defenses**:
- **2-person review** on any patch that touches security-sensitive modules.
- **Canary + staged rollout** — even a trusted insider's patch goes through 1%→10%→100%.
- **Reputation system** — new contributors have lower auto-approve limits.
- **Post-hoc audit** — all signed patches are in Rekor; can be reviewed and revoked after merge.

### Out of Scope (Threats We Don't Try to Defend Against)
- **Compromise of the user's local machine** (if the client is owned, game over).
- **Compromise of GitHub / Google OIDC** (systemic failure of the entire software ecosystem).
- **Compromise of Sigstore Fulcio/Rekor** (Sigstore has its own security track — we inherit their threat model).
- **Zero-day in the Chorus client itself** (addressed by auto-update of the client binary, not the patch registry).
- **Physical coercion of maintainers** — we assume humans act in good faith.

---

## Rollback Strategies

Source: https://learnkube.com/kubernetes-rollbacks, https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates,
https://elhacker.info/Cursos/DevOps%20for%20Developers/5.%20A%20Practical%20Guide%20to%20Kubernetes/6.%20Deployments/7.%20Rolling%20Back%20or%20Rolling%20Forward_.html

### Rollback vs Forward-Fix — Which When?

**Roll Back (revert to previous version) when**:
- The bug is clear and severe (crash, data loss, security hole).
- The previous version is known-good.
- No migrations happened (schema, config) that can't be reversed.
- Speed matters more than correctness — rollback in seconds, fix at leisure.

**Roll Forward (ship a fix forward) when**:
- Small scope of changes; fix is obvious and fast.
- Previous version also had issues (not truly "known-good").
- Database schema/migration was part of the bad release.
- High-frequency release culture — shipping forward is muscle memory.

**Kubernetes precedent**: `kubectl rollout undo` keeps history of all rollouts, trivial to revert.
But if a bad release ran DB migrations, you can't just rollback the app — you're stuck forward-fixing.

### Kill Switch Design
- **Publishable revocation list**: a signed JSON like `{"revoked": ["patch-id-abc", "patch-id-def"], "as_of": "2026-04-13T..."}`
- **Clients poll the revocation list frequently** — every integration run, plus every 5 min.
- **Revocation propagates faster than new patches**: dedicated endpoint, high CDN TTL override.
- **Revoked patches are uninstalled** from clients if they're currently active (rollback to previous).

### Dependabot's Model (Incremental Forward-Fix)
- Dependabot opens a PR to **upgrade the vulnerable dep to minimum-fixed version**.
- Doesn't rollback; it rolls FORWARD to a patched version.
- Links PR to the original alert for audit trail.
- User can auto-merge if tests pass.

### Key Insight for Chorus
- **Default strategy: rollback on canary failure**. Low-risk, fast, safe.
- **Forward-fix only when**: rollback would strand a user in a broken state (e.g., API already
  deprecated server-side, old patch won't work anymore).
- **Kill switch via revocation list**: signed, polled frequently, immediate effect.
- **Keep last 3 patch versions** on every client so rollback doesn't require a redownload.

---

## Synthesis for Chorus

### Registry Architecture: Git Repo vs. Dedicated Server?

**Recommendation: Git repo as source of truth + CDN for distribution.**

| Aspect | Git Repo | Dedicated Server |
|--------|----------|------------------|
| Transparency | All patches visible, history auditable | Opaque without API |
| Trust surface | Trust GitHub HTTPS + git hashes | Trust our server |
| Cost | Free (GitHub public) | Hosting costs |
| Decentralization | Anyone can host a "tap" (Homebrew model) | Centralized |
| Discovery | `git clone` = everything | Need API + pagination |
| Speed | Slow first time, fast updates | Fast |
| Rollout control | Harder (manifests must list percentages) | Easy (API decides) |

**Hybrid**: Patches live in git (source of truth, reviewable). A **distribution service**
reads from git and:
1. Signs each patch with sigstore (via GitHub Actions workflow).
2. Uploads bundles to a CDN.
3. Serves a **signed manifest** listing (patch_id, version, hash, rollout_percentage, revoked_status).
4. Clients poll the manifest, verify signatures, fetch bundles.

This gives us Homebrew's git-first transparency PLUS Chrome's CDN-scale distribution
PLUS npm's sigstore provenance.

### Signing Scheme: Cosign Keyless + Ed25519 Fallback

**Primary**: **Sigstore keyless** via GitHub Actions.
- All patches signed by `chorus-bot@chorus.dev` via OIDC.
- Certificate identity pinned to specific workflow file path:
  `github.com/chorus/chorus/.github/workflows/publish-patch.yml@refs/heads/main`
- Bundle format v0.3 (self-contained, offline-verifiable).

**Fallback**: **Ed25519 per-contributor keys** for developers who can't use GitHub Actions
(e.g., self-hosted enterprise deployments, air-gapped environments).
- Key management via `age` (simple, mature, Filippo Valsorda endorsed).
- Each enterprise runs their own "tap" with their own root key.
- Clients configured with allow-list of trusted Ed25519 pubkeys at deploy time.

**Do NOT**: invent our own signing scheme, use classic PGP, or ignore signing.

### Patch Manifest Schema (JSON)

Every patch in the registry has a manifest like this:

```json
{
  "$schema": "https://chorus.dev/schemas/patch-manifest-v1.json",
  "id": "oauth-token-refresh-fix-a1b2c3d4",
  "version": "1.2.3",
  "content_hash": "sha512-base64encoded...",
  "size_bytes": 4821,
  "subject": {
    "integration": "google-workspace",
    "module": "oauth-refresh",
    "issue_ref": "https://github.com/chorus/chorus/issues/1234"
  },
  "metadata": {
    "title": "Fix OAuth token refresh race condition",
    "description": "When two concurrent requests both trigger token refresh...",
    "author_oidc_identity": "alice@chorus.dev",
    "author_reputation": 2450,
    "created_at": "2026-04-13T00:15:00Z",
    "source_commit": "abc123def456...",
    "source_repo": "github.com/chorus/chorus",
    "dependencies_added": [],
    "dependencies_removed": [],
    "dependencies_changed": []
  },
  "rollout": {
    "phase": "canary",
    "current_percentage": 1.0,
    "ladder": [1, 2, 5, 10, 20, 50, 100],
    "ladder_dwell_hours": [4, 8, 12, 24, 24, 24],
    "started_at": "2026-04-13T01:00:00Z",
    "paused": false,
    "revoked": false,
    "revocation_reason": null
  },
  "provenance": {
    "slsa_level": 2,
    "builder": "github.com/actions/runner",
    "attestation_url": "https://chorus.dev/attestations/oauth-token-refresh-fix-a1b2c3d4.sigstore.json",
    "rekor_log_index": 49384827
  },
  "verification": {
    "download_url": "https://patches.chorus.dev/v1/oauth-token-refresh-fix-a1b2c3d4.tar.gz",
    "bundle_url": "https://patches.chorus.dev/v1/oauth-token-refresh-fix-a1b2c3d4.sigstore.json",
    "cert_identity": "chorus-bot@chorus.dev",
    "cert_oidc_issuer": "https://token.actions.githubusercontent.com",
    "signer_workflow_path": "github.com/chorus/chorus/.github/workflows/publish-patch.yml@refs/heads/main"
  }
}
```

### Canary Ladder: Exact Percentages + Thresholds + Dwell Times

**Default (normal patches)** — based on iOS 7-day ladder, slightly tuned:
| Stage | % | Dwell | Abort threshold |
|-------|---|-------|----------------|
| 1 | 1% | 4 hours | Error rate > 2× baseline |
| 2 | 2% | 8 hours | Error rate > 1.5× baseline |
| 3 | 5% | 12 hours | Error rate > 1.3× baseline |
| 4 | 10% | 24 hours | Error rate > 1.2× baseline |
| 5 | 20% | 24 hours | Error rate > 1.2× baseline |
| 6 | 50% | 24 hours | Error rate > 1.1× baseline |
| 7 | 100% | N/A | Monitoring ongoing |

Total time to fleet: ~5 days.

**Expedited (critical security)**:
| Stage | % | Dwell |
|-------|---|-------|
| 1 | 1% | 30 min |
| 2 | 10% | 1 hour |
| 3 | 50% | 2 hours |
| 4 | 100% | N/A |

Total time to fleet: ~4 hours.

**Cohort assignment**: `hash(machine_id + patch_id) % 10000 < rollout_pct * 100`.
Stable per machine — once in canary, always in canary for that patch.

**Abort signals**:
- Error rate: use scout-charlie's error-signatures subsystem to detect post-patch error spikes.
- User explicit revoke: `chorus patch revoke <patch-id>` on any client triggers local rollback
  AND reports telemetry.
- Cross-machine correlation: if 5+ machines report "patch made things worse" within an hour,
  auto-pause rollout.

### Reputation Formula: How Contributors Earn Trust

Starting rep: 0. Patches go to human review queue.

| Event | Rep change |
|-------|-----------|
| Patch merged after review | +50 |
| Patch survives canary phase without issues | +100 |
| Patch reaches 100% without revocation | +100 |
| Patch revoked for non-safety reason (e.g., improved version) | 0 |
| Patch revoked for bug | -50 |
| Patch revoked for security issue | -500 |
| Patch caused production incident | -1000 |
| Community upvote on patch (integration community signal) | +5 (cap 50/day) |

**Thresholds / Privileges**:
| Rep | Privilege |
|-----|-----------|
| 0 | Submit patches (human review required) |
| 100 | Auto-approve to dev ring |
| 1000 | Auto-approve to 1% canary |
| 5000 + 2-maintainer approval | Auto-approve to 10% canary |
| 10000 + 2-maintainer approval | Direct publish (still canary, faster review) |

**Decay**: -10 rep per month inactive (prevents dormant accounts with old rep).

**Badges** (not rep-granting, just status): "First Patch", "Patcher of 100", "Incident-Free 90 Days", "First Auth Patch", "Critical Security Contributor".

### Kill Switch: Rapid Revocation Design

1. **Revocation list** = signed JSON published every 5 min:
   ```json
   {
     "as_of": "2026-04-13T12:34:56Z",
     "revoked_patches": [
       {"id": "oauth-token-refresh-fix-a1b2c3d4", "reason": "token_exfil_detected", "revoked_at": "..."}
     ],
     "signature": "..."
   }
   ```
2. **Clients poll** this list **on every integration run** + every 5 min regardless.
3. **Client response to revocation**:
   - Immediately uninstall the revoked patch.
   - Rollback to previous version if the revoked patch was active.
   - Show user a notification: "Patch X was revoked: {reason}."
   - Emit telemetry: "acknowledged revocation at T+{delay}s."
4. **Publishing a revocation is a signing event** — must go through the same trusted workflow.
   Prevents attackers from using the kill switch for DoS.

### What Threats We Do NOT Try to Defend Against

Out of scope, explicitly:
- **Compromised local machine** (client owned = game over, this is a general assumption).
- **Compromise of GitHub / Google / underlying OIDC providers** (systemic, we inherit their risks).
- **Compromise of Sigstore Fulcio/Rekor** (Sigstore's threat model, not ours).
- **Zero-day in the Chorus client itself** (handled by client auto-update, orthogonal).
- **Physical coercion** of maintainers.
- **Side-channel attacks** on the signing infrastructure (timing, power).
- **Quantum attacks on Ed25519/RSA** (assume pre-quantum for now; plan post-quantum migration separately).
- **Integration provider changes API** (that's a workflow/engine concern, scout-alpha's domain).

---

## Top 3 Design Recommendations for Chorus

### 1. Sigstore keyless signing via GitHub Actions + npm-style trusted publisher model
Use cosign keyless signing bound to a specific workflow file path. Emulate npm's trusted
publisher pattern so the attack surface is "get a PR merged into the signing workflow"
rather than "steal a token." Publish patches as a git-first registry (tap-like) with
CDN distribution and signed manifests. Bundle format v0.3 gives us offline verification.

### 2. iOS-style fixed canary ladder with error-signature abort + kill switch
Default 7-day ladder: 1% → 2% → 5% → 10% → 20% → 50% → 100%. Expedited 4-hour ladder
for security. Use scout-charlie's error signatures to auto-abort on error rate spikes.
Revocation list published every 5 min, polled by all clients, immediate uninstall on revoke.
No "push to 100% instantly" option exists — even security hotfixes go through the 1% ring,
just with shorter dwells.

### 3. Reputation-gated auto-approval + mandatory human review on sensitive modules
Contributors earn reputation through merged-and-survived patches. 0 rep = full human review;
1000 rep = auto-approve to 1% canary; 10000 rep = faster review for direct publish. ALL
patches touching auth/secrets/network code require 2-maintainer approval regardless of
reputation. Reputation decays on incidents, especially security incidents (-500 to -1000).
This maps the npm/CrowdStrike threat model onto a Stack Overflow-style privilege ladder
without PGP WoT's UX nightmare.

---

## Sources

- [Sigstore Cosign Signing Overview](https://docs.sigstore.dev/cosign/signing/overview/)
- [Sigstore Cosign Verifying Signatures](https://docs.sigstore.dev/cosign/verifying/verify/)
- [Sigstore Bundle Format v0.3](https://docs.sigstore.dev/about/bundle/)
- [SLSA v1.0 Security Levels](https://slsa.dev/spec/v1.0/levels)
- [SLSA v1.0 Provenance](https://slsa.dev/spec/v1.0/provenance)
- [npm Provenance GA announcement](https://blog.sigstore.dev/npm-provenance-ga/)
- [npm Generating Provenance Statements](https://docs.npmjs.com/generating-provenance-statements/)
- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Blog: Introducing npm package provenance](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/)
- [Homebrew How to Open a Pull Request](https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request)
- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [Homebrew Adding Software](https://docs.brew.sh/Adding-Software-to-Homebrew)
- [Chrome Component Updater](https://chromium.googlesource.com/chromium/src/+/lkgr/components/component_updater/README.md)
- [Chromium Updater Functional Spec](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/updater/functional_spec.md)
- [CrowdStrike Channel File 291 Root Cause Analysis (Aug 2024)](https://www.crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf)
- [Inside CrowdStrike's Deployment Process](https://overmind.tech/blog/inside-crowdstrikes-deployment-process)
- [iOS Phased Release Documentation](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)
- [Canary releases with feature flags (Unleash)](https://www.getunleash.io/blog/canary-deployment-what-is-it)
- [Four Common Deployment Strategies (LaunchDarkly)](https://launchdarkly.com/blog/four-common-deployment-strategies/)
- [Staged Rollouts with ConfigCat](https://configcat.com/blog/2024/01/16/using-configcat-for-staged-rollouts-and-canary-releases/)
- [PGP Web of Trust (Wikipedia)](https://en.wikipedia.org/wiki/Web_of_trust)
- [GnuPG Building Your Web of Trust](https://www.gnupg.org/gph/en/manual/x547.html)
- [Stack Overflow Reputation and Voting](https://internal.stackoverflow.help/en/articles/8775594-reputation-and-voting)
- [Shai-Hulud 2.0 npm Supply Chain Attack (Wiz)](https://www.wiz.io/blog/shai-hulud-2-0-ongoing-supply-chain-attack)
- [Shai-Hulud npm Ecosystem Compromise (Unit 42)](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/)
- [Axios npm Supply Chain Attack (Google Cloud)](https://cloud.google.com/blog/topics/threat-intelligence/north-korea-threat-actor-targets-axios-npm-package)
- [Kubernetes Deployment Rollback](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Rolling Back vs Rolling Forward](https://elhacker.info/Cursos/DevOps%20for%20Developers/5.%20A%20Practical%20Guide%20to%20Kubernetes/6.%20Deployments/7.%20Rolling%20Back%20or%20Rolling%20Forward_.html)
- [Dependabot Security Updates](https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates)
