# Research 02: Patch Registry + Supply Chain Security
Agent: scout-bravo
Started: 2026-04-13T00:00:00Z
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
- [ ] Reputation systems (npm, PGP web of trust, Stack Overflow)
- [ ] Threat model: malicious patches
- [ ] Rollback strategies
- [ ] Synthesis for Chorus

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

### Verification Flow
- Verifier fetches the signature + certificate + SET (the "bundle").
- Verifier checks:
  - The certificate chains to Fulcio's root (public CT log).
  - The OIDC identity in the cert matches the expected signer
    (e.g., `--certificate-identity=...@chorus.dev`).
  - The signature matches the artifact hash.
  - The Rekor SET is valid (entry was logged).
  - The signing timestamp is during the cert's validity window.

### Why This Matters for Chorus
- **No private key management** for human contributors. They sign with their GitHub/Google identity.
- **Revocation is easy**: remove the OIDC identity from the allow-list.
- **Public transparency**: any malicious signing of a chorus patch would be visible in Rekor,
  and the real contributor would notice their identity being used.
- **Can sign anything**: OCI images, files, git commits, blobs.

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
### Level 4 — Deferred in v1.0 (two-person review + hermetic + reproducible).

### Key Insight for Chorus
- **Target L2 for MVP**: sign with sigstore from GitHub Actions. "Good enough."
- **Provenance JSON** should include: patch source repo, commit SHA, build steps,
  dependencies, and the human/bot identity that triggered it.

---

## npm Provenance (Sigstore-Backed) — GA since April 2023

Source: https://blog.sigstore.dev/npm-provenance-ga/, https://docs.npmjs.com/generating-provenance-statements/

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
- Maintainer registers a trusted GitHub Actions / GitLab workflow.
- Only that workflow can publish — **eliminates stolen-npm-token attack** entirely.

### Verification (Consumer Side)
- `npm audit signatures` verifies provenance for installed packages.
- npmjs.com shows a "Provenance" badge linking to the transparency log.

### Key Insight for Chorus
- **Emulate npm's trusted-publisher model**: register a workflow that signs patches.
- Use **SLSA provenance JSON** as our attestation format.
- The pattern is now the de facto standard; don't invent a new one.

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

### CRX3 Signing
- Developer creates an RSA key pair.
- Component ID = **first 128 bits of SHA-256(public key)**, rendered as hex in a-p charset.
  This makes the ID self-certifying: the ID IS the hash of the trusted key.
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
  hardcoded pubkey-hash in the client. This is a really strong pattern.
- **Rate-limiting update checks** (6min pause, then dwell) prevents thundering herd.
- **Differential updates** are efficient — only download the diff from current version.
- **Update on browser restart, not on-demand**: gives time for Google to detect bad components
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

### Signal Collection
- Error rate (per-cohort, not aggregate!)
- Latency p50/p95/p99
- Business metrics (conversion, retention)
- Explicit user feedback (for long-dwell rollouts)
- **Automated rollback**: if error rate > threshold for N minutes, auto-revert.

### Key Insight for Chorus
- **Recommended canary ladder**:
  - 0.1% (~1 in 1000 users) for 1 hour
  - 1% for 4 hours
  - 10% for 24 hours
  - 50% for 48 hours
  - 100%
- **Dwell times** should be tuned per-patch risk level (security vs feature vs cosmetic).
- **Cohort assignment** via `hash(machine_id + patch_id)` — deterministic + spreads load.
- **Error signal**: use the error signatures from scout-charlie's work to detect "patch made it worse."
- **Kill switch**: a publish-subscribe "revoke" channel that clients check on every integration run.

---

## Progress Tracker
- [x] Sigstore / Cosign / SLSA provenance
- [x] npm provenance feature (sigstore-backed)
- [x] Homebrew formula distribution model
- [x] Chrome component updater architecture
- [x] CrowdStrike content delivery
- [x] Staged rollout / canary patterns (iOS, Kubernetes, feature flags)
- [ ] Reputation systems (npm, PGP web of trust, Stack Overflow)
- [ ] Threat model: malicious patches
- [ ] Rollback strategies
- [ ] Synthesis for Chorus
