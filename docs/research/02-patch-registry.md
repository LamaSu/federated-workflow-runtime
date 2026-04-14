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
- [ ] Chrome component updater architecture
- [ ] CrowdStrike content delivery
- [ ] Staged rollout / canary patterns (iOS, Kubernetes, feature flags)
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

Pronounced "salsa." Proposed by Google 2021, now a CNCF incubation project.
SLSA v1.0 focuses on the **build track**; source-track and dependency-track are future.

### Level 0 — No SLSA
No provenance, no signing. Informal trust only.

### Level 1 — Provenance Exists
- The software producer must generate and distribute **provenance** describing
  how the artifact was built: build platform, build process, top-level inputs.
- No tamper-protection yet. Provenance can be forged.
- **Value**: enables debugging, identification of vulnerable deps.

### Level 2 — Hosted Build + Signed Provenance
- Build must run on **dedicated hosted infrastructure** (not a laptop).
- Provenance is **digitally signed** by the build platform.
- Prevents unsophisticated tampering with provenance or artifacts in transit.
- Example: GitHub Actions with OIDC + sigstore.

### Level 3 — Hardened Build Platform
- All L2 requirements plus:
  - Build platform enforces **run-to-run isolation** (one build cannot influence another).
  - Signing keys / auth credentials are not accessible to build scripts.
- Protects against sophisticated threats like supply-chain worms.
- This is the practical "high-water mark" for most projects.

### Level 4 — Deferred in v1.0
- Originally: two-person review + hermetic + reproducible builds.
- Deferred to a future version due to cost/complexity.

### Key Insight for Chorus
- **Target L2 for MVP**: sign with sigstore from GitHub Actions. "Good enough."
- **L3 would require** our own hardened build platform — probably not worth it initially.
- **Provenance JSON** should include: patch source repo, commit SHA, build steps,
  dependencies pulled, and the human/bot identity that triggered it.

---

## npm Provenance (Sigstore-Backed) — GA since April 2023

Source: https://blog.sigstore.dev/npm-provenance-ga/, https://docs.npmjs.com/generating-provenance-statements/,
https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/

npm was the first major package registry to integrate Sigstore natively. Millions of
packages have published with provenance by April 2026.

### How It Works
1. Developer runs `npm publish --provenance` in a CI environment (GitHub Actions, GitLab CI).
2. The npm CLI detects the OIDC provider and uses **workload identity federation** —
   no secrets, no API keys stored in the repo.
3. CLI asks the CI system for an OIDC token scoped to the workflow.
4. CLI sends this token to Sigstore Fulcio → gets short-lived cert binding the public
   key to `github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main`.
5. CLI signs a **SLSA provenance attestation** (JSON following the SLSA spec):
   - `subject`: package name@version + tarball SHA-512
   - `predicate`: builder (GitHub Actions), invocation (workflow run URL), materials (source commit)
6. Attestation is sent to Rekor for transparency logging.
7. Attestation bundle (cert + signature + SET) is uploaded to npm registry alongside tarball.
8. Registry verifies the signature + checks the identity matches a "trusted publisher"
   configured on the package.

### Trusted Publishers
- Package maintainer registers a trusted GitHub Actions / GitLab workflow.
- Only that workflow can publish new versions — removes stolen-npm-token attack.
- This is the key security win: **no long-lived npm tokens in CI**.

### Verification (Consumer Side)
- `npm audit signatures` verifies provenance attestations for all installed packages.
- You can also view on npmjs.com: a badge shows "Provenance" with a link to the transparency log.

### Key Insight for Chorus
- We should **emulate npm's trusted-publisher model**: register a workflow that publishes
  patches, and no one else can sign on behalf of that package.
- The provenance attestation format (SLSA v1.0 JSON) is a good template for our patch manifest.
- **npm's model is the de facto standard now**; users will expect this or stronger.

---

## Homebrew Formula Distribution Model

Source: https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request, Formula-Cookbook,
https://docs.brew.sh/Adding-Software-to-Homebrew

Homebrew is the "no signing, pure git + review + checksum" model — fundamentally
different from npm/sigstore.

### The Distribution Model
- **No per-user signing**. Full stop.
- Formulas live in **GitHub repos called "taps"**: `Homebrew/homebrew-core`,
  `Homebrew/homebrew-cask`, and user/org taps like `hashicorp/tap`.
- A formula is a **Ruby file** describing: source URL (usually a tarball), SHA-256 checksum,
  dependencies, build instructions, test command.
- `brew install foo` does:
  1. Clone or pull the tap's git repo (HTTPS to github.com).
  2. Read the formula.
  3. Download the source tarball.
  4. **Verify SHA-256 checksum** matches the one in the formula.
  5. Build locally (or download a pre-built bottle from Homebrew's CDN).

### The Review Process
- You fork `Homebrew/homebrew-core`, add a formula file, and open a PR.
- Automated checks run (BrewTestBot): `brew audit --new --formula foo` checks naming,
  format, license, known-bad URLs, and builds on macOS + Linux.
- A Homebrew maintainer manually reviews: Is the software popular enough? Open source?
  Does the formula follow conventions?
- Once merged, the formula is available to all users on their next `brew update`.

### Why No Signing?
Three reasons, explicit in Homebrew's threat model:
1. **Trust is placed in GitHub**: HTTPS + git's content-addressable hashes = tamper-evident.
   An attacker would need to compromise GitHub OR the tarball host (checksum catches that).
2. **Formulas themselves are public code, reviewed by humans** before merge. The review IS
   the signing.
3. **Per-user signing was tried** (homebrew-bundle had some experiments) and was
   unmaintainable — formula updates happen thousands of times per week.

### Key Insight for Chorus
- Homebrew is viable at scale **because** they have a full-time maintainer team reviewing
  every submission. Chorus does not. We cannot copy this model 1:1.
- BUT: the **pattern of "fetch, verify hash, execute"** is still sound. We just need the
  hash+signature to come from someone we trust.
- Homebrew's **tap model** (decentralized — any GitHub user can host their own tap) is
  attractive for Chorus: let each team host their own patch registry as a git repo.
- The **checksum-in-formula pattern** is a good hedge: even if sigstore fails, a good
  old-fashioned SHA-256 lets us detect tarball tampering.

---

## Progress Tracker
- [x] Sigstore / Cosign / SLSA provenance
- [x] npm provenance feature (sigstore-backed)
- [x] Homebrew formula distribution model
- [ ] Chrome component updater architecture
- [ ] CrowdStrike content delivery
- [ ] Staged rollout / canary patterns (iOS, Kubernetes, feature flags)
- [ ] Reputation systems (npm, PGP web of trust, Stack Overflow)
- [ ] Threat model: malicious patches
- [ ] Rollback strategies
- [ ] Synthesis for Chorus
