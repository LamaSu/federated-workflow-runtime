# Chorus Patch Registry

This is a **federated patch registry** for the [Chorus](https://github.com/lamasu/chorus) workflow runtime. Anyone can stand one up; the client points at whichever registry (or registries) its operator trusts.

This repo is the **source of truth** for a set of integration patches. Its job is three things:

1. Host signed patch manifests under `patches/<integration>/<patch-id>.json`.
2. Publish a signed `revoked.json` kill list.
3. Declare the set of **trusted signer identities** (`trusted-signers.json`) whose patches clients will accept.

A CDN mirror (S3, Cloudflare R2, or equivalent — deployer's choice) distributes the signed payloads; clients poll that mirror every 5 minutes.

> Reference: [Chorus ARCHITECTURE.md §5 (Registry)](https://github.com/lamasu/chorus/blob/master/docs/ARCHITECTURE.md#5-registry-chorusregistry) — this README is ops-focused; the full design is in ARCHITECTURE.

---

## Directory layout

```
.
├── README.md                   # this file
├── LICENSE                     # MIT
├── CONTRIBUTING.md             # how to propose a patch
├── CODEOWNERS                  # sensitive-scope review routing
├── revoked.json                # signed kill list (§5.6)
├── trusted-signers.json        # initial allow-list of signer identities
├── patches/
│   ├── README.md               # per-integration layout
│   ├── .gitkeep
│   └── <integration>/
│       ├── manifest.json       # integration metadata (optional in v0)
│       └── <patch-id>.json     # per-patch manifest (see packages/registry/src/manifest.ts)
└── .github/
    ├── ISSUE_TEMPLATE/
    │   └── patch-proposal.md
    └── workflows/              # drop in the files from federation/github-actions/
```

The exact schema of `<patch-id>.json` is the Zod `PatchSchema` in [`packages/registry/src/manifest.ts`](https://github.com/lamasu/chorus/blob/master/packages/registry/src/manifest.ts) (re-exporting `PatchSchema` from `@chorus/core`). Do not improvise fields; the client rejects anything that fails `PatchSchema.safeParse`.

---

## How signing works (end-to-end)

Two signing paths run in parallel for every patch; clients prefer whichever they can verify.

### Path A — Sigstore keyless (primary, recommended)

1. Contributor opens a PR that adds `patches/<integration>/<patch-id>.json`.
2. `sign-patch.yml` runs in GitHub Actions (see `federation/github-actions/sign-patch.yml`).
3. The workflow requests an OIDC token from GitHub's token service.
4. `cosign sign-blob --bundle ...` exchanges the OIDC token for a short-lived (~10 min) Sigstore/Fulcio cert bound to the workflow identity.
5. Cosign signs the patch bytes, publishes the entry to the Rekor transparency log, and emits a `.sigstore.json` bundle.
6. The bundle is attached to the PR as an artifact and committed alongside the manifest on merge.
7. The signing key is destroyed at the end of the workflow run — there is no long-lived secret.

Clients verify with:

```bash
cosign verify-blob \
  --bundle <patch-id>.sigstore.json \
  --certificate-identity="${TRUSTED_IDENTITY}" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  <patch-id>.json
```

`TRUSTED_IDENTITY` comes from `trusted-signers.json`.

### Path B — Ed25519 per-contributor keys (fallback)

Used for self-hosted / air-gapped deployments or for contributors signing outside GitHub Actions. The contributor's public key is listed in `trusted-signers.json`; the patch manifest's `signature` field contains a base64 Ed25519 signature over the canonical JSON body (see `packages/registry/src/sign.ts:patchSigningPayload`).

Either path is sufficient for a client to accept a patch, but CI publishes both so that clients can choose either. Clients that only trust Sigstore ignore Ed25519 signatures and vice versa.

---

## Contributor flow

The canonical process (see `CONTRIBUTING.md` for the step-by-step):

1. Fork this repo.
2. Open an issue using the "Patch proposal" template (`.github/ISSUE_TEMPLATE/patch-proposal.md`).
3. Open a PR that adds `patches/<integration>/<YYYY-MM-DD>_<slug>_<hash8>.json`.
4. `sign-patch.yml` runs → attaches a Sigstore bundle + posts a GitHub check.
5. `CODEOWNERS` routes the PR to the right reviewers (two-maintainer approval required for patches touching `auth`, `secrets`, or `network` scopes).
6. Merge → `publish-revocation.yml` / `canary-promote.yml` start tracking this patch.
7. CDN serves the new patch + its bundle. Clients pick it up on their next 5-min poll.

---

## Maintainer responsibilities

- Review incoming PRs against the [patch-acceptance checklist](CONTRIBUTING.md#review-checklist).
- Rotate entries in `trusted-signers.json` when a maintainer joins or leaves.
- Respond to revocation requests within the SLA documented in [RUNBOOK.md](../RUNBOOK.md#incident-playbook).
- Do NOT commit directly to `master` / `main` — even maintainers go through PR + signing workflow.

---

## Running your own registry

You don't have to use this template — the Chorus client will follow any registry URL you point it at. If you're starting fresh:

```bash
# 1. Fork / clone this template
gh repo create my-org/chorus-patches --template lamasu/chorus-registry-template --public

# 2. Drop the Actions workflows in
cp federation/github-actions/*.yml .github/workflows/

# 3. Set the required secrets (see RUNBOOK.md §Prereqs):
#    - CDN_BUCKET                      (e.g., s3://my-patches-cdn)
#    - CDN_ACCESS_KEY / CDN_SECRET     (vendor-specific)
#    - TELEMETRY_ENDPOINT              (optional, for abort-on-spike)
#    - CHORUS_REVOCATION_SIGNING_KEY   (Ed25519 private key for revocation signing)

# 4. Add your first trusted signer
jq '.signers += [{...}]' trusted-signers.json > tmp && mv tmp trusted-signers.json

# 5. Push, enable Actions, point clients at https://<your-cdn>/
```

See [RUNBOOK.md](../RUNBOOK.md) in the Chorus repo for the full standup checklist.

---

## License

MIT — see [LICENSE](LICENSE).
