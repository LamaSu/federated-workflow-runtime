# Chorus Registry — Standup Runbook

**Audience:** the operator who will publish the federated patch registry at `LamaSu/chorus-registry`.

**Scope:** everything from "I just cloned chorus" to "clients worldwide can pull signed patches from my CDN." Every command is copy-paste ready; every assumption is spelled out.

**Time budget:** ~45 minutes of hands-on work, excluding CDN sign-up.

---

## 0. What you're about to build

You're going to publish a **single GitHub repo** (`LamaSu/chorus-registry`) that hosts:

- Signed patch manifests under `patches/<integration>/<id>.json`
- A signed `revoked.json` kill list
- A `trusted-signers.json` allow-list of signer identities
- Four GitHub Actions workflows that automate signing, canary promotion, revocation publishing, and error-spike auto-abort

Clients poll a CDN mirror (R2 / S3) of this repo every 5 minutes and apply patches according to their local trust policy. The repo itself is the source of truth; the CDN is the distribution surface.

Full design: [`docs/ARCHITECTURE.md §5`](../docs/ARCHITECTURE.md#5-registry-chorusregistry). This doc is the ops view.

---

## 1. Prerequisites checklist

Tick each before continuing:

- [ ] `gh` CLI v2.60+ installed and authenticated as `LamaSu` (check with `gh auth status`).
- [ ] `git` installed.
- [ ] `openssl` installed (used for the Ed25519 keypair).
- [ ] `wrangler` installed if you're using Cloudflare R2 (`npm i -g wrangler`); skip if you're using S3.
- [ ] You can push to the `LamaSu` GitHub org.
- [ ] You've read this doc end-to-end before running anything.

If `gh auth status` shows multiple accounts, switch the active one:

```bash
gh auth switch -u LamaSu
gh api user --jq .login   # Must print: LamaSu
```

---

## 2. Verify the founder signing key exists

The registry refuses patches that aren't signed by a recognized identity. A keypair was seeded during this session at `C:\Users\globa\.chorus\keys\ed25519.key` (private, 0600) and its public half was committed to `federation/registry-template/trusted-signers.json` under the handle `lamasu`.

Re-verify before standup:

```bash
# Private key present?
ls -la C:/Users/globa/.chorus/keys/ed25519.key

# Pubkey matches what's in trusted-signers.json?
openssl pkey -in C:/Users/globa/.chorus/keys/ed25519.key -pubout -outform DER \
  | python -c "import sys, base64; d=sys.stdin.buffer.read(); print(base64.b64encode(d[-32:]).decode())"

python -c "import json; print(json.load(open('C:/Users/globa/chorus/federation/registry-template/trusted-signers.json'))['signers'][0]['publicKey'])"
```

The two base64 strings must match. If they don't, regenerate the trusted-signers entry before proceeding — do NOT push a mismatched key to a public repo.

**Back this key up.** Losing it means losing the founder identity. Suggested:

```bash
# Encrypt and copy to your password manager or a hardware key.
openssl pkey -in C:/Users/globa/.chorus/keys/ed25519.key -out ~/chorus-ed25519.encrypted.pem -aes256
```

---

## 3. Dry-run the standup script

The script is **non-executing by default**. Running it without `CONFIRM=1` does the preflight checks and prints a summary, then exits with code 4. This is on purpose.

```bash
cd C:/Users/globa/chorus
bash scripts/standup-registry.sh
```

Expected: a summary of what would happen, and the exit message:

```
Re-run with CONFIRM=1 to proceed.
```

**If preflight fails**, fix the reported issue before continuing. Common failures:

| Error | Fix |
|---|---|
| `gh CLI not authenticated as LamaSu` | `gh auth switch -u LamaSu` |
| `workflow missing: …abort-on-spike.yml` | `cp federation/github-actions/*.yml federation/registry-template/.github/workflows/` |
| `trusted-signers.json has 0 signers` | Re-seed with your pubkey (see section 2) |
| `repo LamaSu/chorus-registry already exists` | Either use a different name or delete the existing repo first |

---

## 4. Execute the standup

Once the dry-run is clean:

```bash
CONFIRM=1 bash scripts/standup-registry.sh
```

The script:

1. Copies `federation/registry-template/` into a temp dir.
2. `git init` + initial commit as `LamaSu <lamasu@chorus.dev>`.
3. `gh repo create LamaSu/chorus-registry --public --push`.
4. Enables Actions on the new repo with read+write workflow permissions (required by `canary-promote.yml` and `abort-on-spike.yml`, which push stage advances back to `main`).

On success you'll see a summary box with the repo URL and the 4 workflow URLs.

Sanity check:

```bash
gh repo view LamaSu/chorus-registry --json name,isPrivate,hasWikiEnabled
gh run list --repo LamaSu/chorus-registry --limit 5
```

---

## 5. Stand up the CDN bucket (Cloudflare R2)

R2 is recommended for greenfield deployments — no egress fees. If you're using plain S3, skip to section 5b.

### 5a. R2 path

```bash
# First-time wrangler setup (you'll be redirected to a browser for OAuth).
wrangler login

# Create the bucket for revocation list + signed patches.
wrangler r2 bucket create chorus-revocation

# Create API credentials the workflows will use.
# Dashboard → R2 → Manage R2 API tokens → Create API token
#   Permissions: "Object Read & Write"
#   Specify bucket: chorus-revocation
# Save the resulting ACCESS_KEY_ID and SECRET_ACCESS_KEY.
```

Grab your account's R2 S3 endpoint from the dashboard (format:
`https://<account-id>.r2.cloudflarestorage.com`).

Optional but recommended: connect a custom domain (`patches.chorus.dev` →
R2 bucket) so you can switch CDN providers later without breaking clients.

### 5b. S3 path

```bash
aws s3 mb s3://chorus-revocation --region us-east-1
# Create IAM user with s3:PutObject + s3:GetObject on this bucket only.
# Save the access key ID + secret.
```

---

## 6. Wire the secrets into the registry repo

```bash
REPO=LamaSu/chorus-registry

# CDN bucket (R2 or S3)
gh secret set CDN_BUCKET             --repo "$REPO" --body "s3://chorus-revocation"
gh secret set CDN_ACCESS_KEY_ID      --repo "$REPO" --body "<your access key>"
gh secret set CDN_SECRET_ACCESS_KEY  --repo "$REPO" --body "<your secret>"

# R2 only — override the AWS endpoint
gh secret set CDN_ENDPOINT_URL       --repo "$REPO" --body "https://<account-id>.r2.cloudflarestorage.com"

# Optional — public base URL for the post-upload verify step
gh secret set CDN_PUBLIC_URL         --repo "$REPO" --body "https://patches.chorus.dev"

# Optional — Ed25519 fallback key for revocation signing (base64 of private seed).
# ONLY needed if you want a non-Sigstore revocation signature too.
gh secret set CHORUS_REVOCATION_SIGNING_KEY --repo "$REPO" --body "<base64 ed25519 seed>"
```

You do NOT need to add the bucket as a *binding* in the YAML — the workflows
read the bucket URI from `secrets.CDN_BUCKET` and talk to it via the standard
AWS SDK, which works with R2, B2, MinIO, Wasabi, and S3 verbatim.

If you later want to add telemetry-driven auto-abort:

```bash
gh variable set TELEMETRY_ENDPOINT --repo "$REPO" --body "https://telemetry.chorus.dev/patches"
gh secret   set TELEMETRY_TOKEN    --repo "$REPO" --body "<bearer>"
```

Without these, `abort-on-spike.yml` becomes a no-op (it logs a notice and exits zero).

---

## 7. Enable branch protection on `main`

The scheduled workflows (`canary-promote.yml`, `abort-on-spike.yml`) push to `main`. They need permission; humans should NOT:

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/LamaSu/chorus-registry/branches/main/protection" \
  -f required_status_checks='{"strict":true,"contexts":["sign-patch"]}' \
  -f enforce_admins=false \
  -f required_pull_request_reviews='{"required_approving_review_count":1,"require_code_owner_reviews":true}' \
  -f restrictions=null \
  -f allow_force_pushes=false \
  -f allow_deletions=false
```

Then, **Settings → Branches → main → Edit rule** and in "Restrict who can push":

- Add `github-actions[bot]` (so the scheduled workflows can push).
- Add yourself (so you can emergency-push if automation breaks).

Nobody else.

Update `CODEOWNERS` in the new repo to replace the placeholder `@YOUR_ORG/chorus-maintainers` and `@YOUR_ORG/chorus-security` with real teams (create them in the `LamaSu` org first — **Teams → New team**).

---

## 8. Verify everything works

```bash
# Actions enabled?
gh api "/repos/LamaSu/chorus-registry/actions/permissions" --jq '.enabled'
# → true

# Workflows discovered?
gh workflow list --repo LamaSu/chorus-registry
# → sign-patch, canary-promote, publish-revocation, abort-on-spike

# Scheduled runs triggered?
gh run list --repo LamaSu/chorus-registry --workflow=abort-on-spike.yml --limit 3
# → should show runs every 15 min (or "no runs yet" if just-created)

# Smoke-test publish-revocation manually
gh workflow run publish-revocation.yml --repo LamaSu/chorus-registry
sleep 10
gh run list --repo LamaSu/chorus-registry --workflow=publish-revocation.yml --limit 1

# CDN delivered?
curl -sI "https://patches.chorus.dev/revoked.json" | grep -i cache-control
# → cache-control: public, max-age=60, must-revalidate
```

If `publish-revocation` failed, open the run log (`gh run view <id> --repo LamaSu/chorus-registry --log`) and check the "Upload to CDN" step. Nine times out of ten the issue is a wrong endpoint URL or an IAM token without write permission.

---

## 9. Point the Chorus runtime at the registry

Once the CDN is live, update the Chorus client default (`packages/cli/src/commands/init.ts`) or set per-user via:

```bash
# In any chorus project
chorus config set registry.url https://patches.chorus.dev
# Or via env var for one-off:
export CHORUS_REGISTRY_URL=https://patches.chorus.dev
```

The runtime polls `${registry.url}/revoked.json` every 5 minutes and pulls patches on demand.

---

## 10. Post-standup: first-patch dry-run

Before declaring victory, walk a dummy patch through the pipeline:

```bash
git clone git@github.com:LamaSu/chorus-registry.git
cd chorus-registry
git checkout -b patch/smoke-test/hello

mkdir -p patches/smoke-test
cat > patches/smoke-test/2026-04-17_hello_00000000.json <<'JSON'
{
  "metadata": {
    "id": "smoke-test_hello_00000000",
    "integration": "smoke-test",
    "errorSignatureHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "description": "Smoke test — verifies sign-patch.yml picks up a new patch",
    "author": {"id": "lamasu", "publicKey": "9A4feupK2M9kSyysucS3wrhPFKr0z6XoL60TFwFzXNE=", "reputation": 0},
    "beforeVersion": "0.0.0",
    "afterVersion": "0.0.1",
    "testsAdded": [],
    "canaryStage": "proposed",
    "createdAt": "2026-04-17T00:00:00Z",
    "advancedAt": {}
  },
  "diff": "",
  "snapshotUpdates": [],
  "signature": "",
  "signatureAlgorithm": "ed25519"
}
JSON

git add patches/smoke-test/
git commit -m "test: smoke patch — verify sign-patch.yml runs"
git push origin patch/smoke-test/hello
gh pr create --title "test: smoke patch" --body "Delete after confirming sign-patch runs."
```

`sign-patch.yml` should fire within seconds. Open the PR, confirm the check-run posts back with a Sigstore bundle artifact. Close the PR without merging (this is a smoke test, not a real patch). Delete the branch.

---

## 11. Rollback plan

If anything goes sideways after public launch, you have three tools (in increasing order of nuclear):

1. **Revoke a single patch** — add an entry to `revoked.json`, commit to `main`, `publish-revocation.yml` propagates in ~60s.
2. **Disable a workflow** — `gh workflow disable <id> --repo LamaSu/chorus-registry` (e.g., if `canary-promote` is misbehaving).
3. **Take the CDN offline** — delete the R2 bucket or revoke the API token. Clients will fall back to their last-good `revoked.json` on disk and stop applying new patches until the CDN recovers.

You cannot break clients by deleting the repo — the CDN has the file; even that has 60s of edge cache. But coordinate a takedown with the Chorus core team; users expect the registry to be up.

---

## 12. Summary — one-pager checklist

```text
[ ] gh authenticated as LamaSu                      (gh api user --jq .login)
[ ] Founder Ed25519 key present + backed up         (~/.chorus/keys/ed25519.key)
[ ] Dry-run passes                                  (bash scripts/standup-registry.sh)
[ ] Repo created                                    (CONFIRM=1 bash scripts/standup-registry.sh)
[ ] R2 (or S3) bucket exists                        (wrangler r2 bucket create chorus-revocation)
[ ] Secrets set on repo                             (gh secret list --repo LamaSu/chorus-registry)
[ ] Branch protection active                        (gh api .../branches/main/protection)
[ ] Workflows discovered                            (gh workflow list --repo ...)
[ ] First smoke-test PR succeeds                    (sign-patch posts a bundle)
[ ] Runtime pointed at registry                     (chorus config set registry.url ...)
```

When all 9 lines are ticked, federation is live.

---

## Appendix: file index

| Path | Purpose |
|---|---|
| `federation/registry-template/` | Canonical template — what gets pushed to the new repo |
| `federation/github-actions/` | Source-of-truth for the 4 workflows; duplicated into the template's `.github/workflows/` |
| `scripts/standup-registry.sh` | Bootstrapper. Dry-runs by default. `CONFIRM=1` to execute. |
| `federation/RUNBOOK.md` | Day-2 operations (incident response, signer rotation, dwell tuning) |
| `federation/cdn/README.md` | CDN vendor comparison + rate-limit tuning |
| `federation/cdn/publish-revocation.sh` | Manual publish path (same logic as `publish-revocation.yml`) |
| `~/.chorus/keys/ed25519.key` | **Private**. Keep off-repo. |
| `~/.chorus/keys/ed25519.pub` | Public in PEM form (raw bytes are in `trusted-signers.json`). |
