# Chorus Federation — Operator Runbook

**Audience:** whoever operates a Chorus patch registry for a user base. Could be the Chorus core team, an enterprise running a private registry, or a community fork.

**Goal of this doc:** make it possible to stand up federation from cold in a single afternoon, and to respond to a bad patch in under five minutes without thinking.

This runbook points at **exact files in this repo** rather than speaking in abstractions.

---

## Prerequisites

A new Chorus registry needs four things. Everything except the CDN account is free.

1. **A GitHub organization** (free tier is fine). This repo will be forked into it. The org must have Actions enabled with write permissions for workflows.
2. **A CDN account** — S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, or any S3-compatible object store. See [`cdn/README.md#picking-a-cdn`](cdn/README.md#picking-a-cdn) for cost comparison. R2 is recommended for greenfield deployments.
3. **A domain** for the public CDN URL — e.g., `patches.mychorus.dev`. You'll point a CNAME at the CDN distribution. Not strictly required (clients can poll the raw CDN URL), but operational hygiene demands a domain you control so you can swap CDN providers later without breaking clients.
4. **Sigstore access** — automatic for public GitHub repos (public Rekor instance). For air-gapped or private deployments, you'll need a private Sigstore deployment; that's out of scope for v1.

Optional but recommended:

- A separate GitHub team (e.g., `@YOUR_ORG/chorus-security`) for sensitive-scope reviews.
- A PostHog or similar telemetry endpoint, for `abort-on-spike.yml` to auto-revoke on error spikes.
- A pager / on-call rotation. This is infrastructure users depend on; 2am is a real possibility.

---

## Standup, step by step

### 1. Fork the registry template

```bash
gh repo create YOUR_ORG/chorus-patches \
  --template lamasu/chorus \
  --public

git clone git@github.com:YOUR_ORG/chorus-patches.git
cd chorus-patches
```

Copy the template contents in:

```bash
# Assuming the chorus repo is cloned alongside:
cp -r ../chorus/federation/registry-template/. .
cp -r ../chorus/federation/github-actions/. .github/workflows/
git add . && git commit -m "initial: import registry template"
```

Edit `CODEOWNERS` to replace `@YOUR_ORG/chorus-maintainers` and `@YOUR_ORG/chorus-security` with real handles.

### 2. Enable branch protection

**Settings → Branches → Add rule** for `main`:

- Require pull request reviews before merging: ON (at least 1)
- Require review from Code Owners: ON
- Require status checks: `sign-patch` must pass
- Restrict who can push to matching branches: only `chorus-bot` service account + admins
- Allow force pushes: OFF
- Allow deletions: OFF

The canary-promote and abort-on-spike jobs push directly to `main` as `chorus-bot`; they must be in the exception list.

### 3. Create the CDN bucket

Example for Cloudflare R2:

```bash
# wrangler CLI, or use the dashboard
wrangler r2 bucket create my-chorus-patches

# Get the S3-compatible credentials + endpoint
# Dashboard: R2 → Manage R2 API tokens → Create
# Save: CDN_ACCESS_KEY_ID, CDN_SECRET_ACCESS_KEY, CDN_ENDPOINT_URL
```

Point `patches.mychorus.dev` at the public R2 bucket (or connect a Cloudflare custom domain). Test with:

```bash
curl -I https://patches.mychorus.dev/  # 404 is fine; we're just checking the DNS
```

### 4. Set repo secrets

**Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `CDN_BUCKET` | `s3://my-chorus-patches` |
| `CDN_ACCESS_KEY_ID` | from R2 credentials |
| `CDN_SECRET_ACCESS_KEY` | from R2 credentials |
| `CDN_ENDPOINT_URL` | `https://<account>.r2.cloudflarestorage.com` |
| `CDN_PUBLIC_URL` | `https://patches.mychorus.dev` |
| `CHORUS_REVOCATION_SIGNING_KEY` | base64 Ed25519 seed (see below) |

Generate the revocation signing key ONCE, offline:

```bash
node -e "(async () => {
  const { generateKeypair } = await import('@chorus/registry');
  const kp = await generateKeypair();
  console.log('publicKey:  ' + kp.publicKey);
  console.log('privateKey: ' + kp.privateKey);
})();"
```

- Put the **privateKey** into the `CHORUS_REVOCATION_SIGNING_KEY` secret.
- Put the **publicKey** into `trusted-signers.json` as a `type: "ed25519"` entry.

**Do NOT commit the private key.** Treat this like an SSH deploy key — it belongs in your org's secret store and nothing else.

### 5. Variables (not secrets)

**Settings → Secrets and variables → Actions → Variables → New repository variable**:

| Name | Value |
|---|---|
| `TELEMETRY_ENDPOINT` | e.g. `https://stats.mychorus.dev/aggregates/patches` |

If you don't have telemetry yet, leave this blank; `abort-on-spike.yml` will no-op gracefully.

### 6. Seed `trusted-signers.json`

Open a PR that adds yourself (or your CI identity):

```bash
jq '.updatedAt = "'"$(date -u +%FT%TZ)"'"
    | .signers += [{
        "id": "ci-sigstore-primary",
        "type": "sigstore",
        "identity": "https://github.com/YOUR_ORG/chorus-patches/.github/workflows/sign-patch.yml@refs/heads/main",
        "oidcIssuer": "https://token.actions.githubusercontent.com",
        "addedAt": "'"$(date -u +%FT%TZ)"'",
        "addedBy": "@your-handle"
      }, {
        "id": "revocation-signer-alpha",
        "type": "ed25519",
        "publicKey": "<base64 pubkey from step 4>",
        "addedAt": "'"$(date -u +%FT%TZ)"'",
        "addedBy": "@your-handle"
      }]' trusted-signers.json > tmp && mv tmp trusted-signers.json

git commit -am "initial: seed trusted signers"
gh pr create --fill
```

Until this PR merges, the registry cannot accept any patches.

### 7. Publish the first revocation list

Even an empty list needs to be signed and on the CDN — that's what clients will poll. The moment you merge the first `trusted-signers.json` change, `publish-revocation.yml` will NOT fire (it only triggers on `revoked.json` changes). Kick it manually:

```bash
# From the repo web UI: Actions → publish-revocation → Run workflow → main

# Or via CLI:
gh workflow run publish-revocation.yml --ref main
```

Verify:

```bash
curl -fsSL "https://patches.mychorus.dev/revoked.json" | jq
curl -fsSL "https://patches.mychorus.dev/revoked.sig.json" | jq
```

Both should come back with `Cache-Control: public, max-age=60, must-revalidate` in the headers.

### 8. Validate the round-trip

Run the client-side validator against your own CDN — this is the exact check Chorus clients will run on every poll:

```bash
npx tsx federation/cdn/validate-revocation.ts \
  --url https://patches.mychorus.dev/revoked.json \
  --sig-url https://patches.mychorus.dev/revoked.sig.json \
  --public-key "<base64 pubkey from step 4>" \
  --max-age-seconds 900
```

Expected output:

```json
{
  "ok": true,
  "asOf": "2026-04-13T12:34:56Z",
  "revokedCount": 0,
  "signerId": "revocation-signer-alpha",
  "payloadSha256": "...",
  "ageSeconds": 42
}
```

**If this fails**, stop and fix it before going further. Do not point any clients at a registry whose first revocation list doesn't verify — clients will enter a degraded state that's painful to recover from.

### 9. Point clients

Your clients' `~/.chorus/config.json` needs:

```json
{
  "registry": {
    "cdnBaseUrl": "https://patches.mychorus.dev",
    "gitUrl": "https://github.com/YOUR_ORG/chorus-patches.git",
    "trustedSigners": [
      {
        "id": "ci-sigstore-primary",
        "type": "sigstore",
        "identity": "https://github.com/YOUR_ORG/chorus-patches/.github/workflows/sign-patch.yml@refs/heads/main",
        "oidcIssuer": "https://token.actions.githubusercontent.com"
      },
      {
        "id": "revocation-signer-alpha",
        "type": "ed25519",
        "publicKey": "<base64 pubkey>"
      }
    ]
  }
}
```

The client's first poll will fetch `trusted-signers.json` and `revoked.json` and confirm both match. From here on, federation is live.

---

## Incident playbook — revoke a bad patch in under 5 minutes

This is the drill. Run through it at least once before you need to use it in anger.

### T+0: Signal arrives

Could be any of:

- An automated alert from `abort-on-spike.yml` (it already revoked — you're just confirming)
- A manual report from a user ("everyone's Slack integration is broken as of 10 min ago")
- A security disclosure (someone signed a malicious patch)

### T+30s: Confirm the target

```bash
# Find the patch file
ls patches/*/  | grep <patch-id-or-slug>

# Read its metadata
jq '.metadata' patches/slack-send/2026-04-13_bad-fix_abc12345.json
```

Confirm the `id` — you want to revoke exactly one thing. The full `id` is what goes into `revoked.json`.

### T+60s: Add the revocation entry

```bash
git pull origin main
jq '.asOf = "'"$(date -u +%FT%TZ)"'"
    | .revoked += [{
        "patchId": "<exact patch id>",
        "reason": "<one sentence, honest>",
        "severity": "high",
        "revokedAt": "'"$(date -u +%FT%TZ)"'"
      }]' revoked.json > tmp && mv tmp revoked.json
```

`severity`:

- `"critical"` — exfiltration, malicious code, security compromise
- `"high"` — wrong fix, causing cascading failures, bricked integration
- `"medium"` — sub-optimal but not actively harmful
- `"low"` — cosmetic or lint-level issues

### T+90s: Commit + push

```bash
git add revoked.json
git commit -m "revoke: <patch-id> (<reason>)"
git push origin main
```

Yes, direct push. Branch protection allows `chorus-bot` and admins; maintainers performing an incident response qualify. Normal patch submissions go through PR; revocations during an incident go direct.

### T+2min: CI runs

`publish-revocation.yml` fires on the push. It takes ~90 seconds to complete:

- Signs `revoked.json` with Sigstore keyless + Ed25519
- Uploads both to the CDN with `max-age=60`
- Verifies the post-upload download

Watch it: `gh run watch`.

### T+3min: Verify clients see it

```bash
npx tsx federation/cdn/validate-revocation.ts \
  --url https://patches.mychorus.dev/revoked.json \
  --sig-url https://patches.mychorus.dev/revoked.sig.json \
  --public-key "<pubkey>" \
  --max-age-seconds 300
```

`revokedCount` should include the new entry. `ageSeconds` should be very small.

### T+5min: Announce

Post to your incident channel (Discord, Slack, status page):

> **REVOKED:** `<patch-id>`  
> Reason: `<reason>`  
> Affected integrations: `<integration-name>` versions `<before>` through `<after>`  
> User action: none required — your Chorus client will roll back on next poll (worst case 5 min).

Open a GitHub issue on the registry repo tagged `incident` linking to the commit. Even for small incidents. Keeps the paper trail.

### T+30min: Post-mortem stub

Create `docs/incidents/YYYY-MM-DD-<short-slug>.md` capturing:

- What happened
- Timeline
- What the canary ladder caught (or didn't)
- What changes to gates/review prevent repeats

Don't skip this step. The failures that slip the canary are the high-signal ones.

---

## Maintainer rotation

### Adding a maintainer

1. Open a PR adding the GitHub handle to `CODEOWNERS`.
2. Open a PR adding the team member to the GitHub team (`@YOUR_ORG/chorus-maintainers` and/or `@YOUR_ORG/chorus-security`).
3. If the new maintainer will sign patches with their own Ed25519 key, add the public key to `trusted-signers.json`. Two-maintainer approval required for trust-set changes.

### Removing a maintainer

1. Remove from GitHub team.
2. Remove from `CODEOWNERS`.
3. Remove their entry from `trusted-signers.json` — two-maintainer approval.
4. If they signed patches recently and there's any doubt about their key hygiene, revoke patches signed by them in the suspect window (revocation list fast-path). Conservative is cheap, retroactive cleanup is expensive.

Neither step requires any client-side change — clients re-read `trusted-signers.json` on every 5-min poll.

---

## Cost model

Rough monthly cost estimates for a revocation-list + patch-distribution setup. Assumes ~5 KB per patch, ~500 B per revocation-list entry, clients polling every 5 minutes.

### 100 users

- CDN egress: ~1.5 GB/mo (revocation list polls only, patches are rare)
- R2: **$0** (zero-egress tier)
- GitHub Actions: free tier (well under 2000 min/mo)
- **Total: $0**

### 1,000 users

- CDN egress: ~15 GB/mo
- R2: **$0**
- B2 alternative: ~$0.15
- GitHub Actions: still free for public repos
- **Total: $0 on R2, ~$0.15 on B2**

### 10,000 users

- CDN egress: ~150 GB/mo
- R2: **$0**
- B2 alternative: ~$1.50
- CloudFront alternative: ~$13
- GitHub Actions: ~2-3k minutes/mo (canary-promote + abort-on-spike). Still under private repo free tier.
- **Total: $0 on R2, ~$1.50 on B2, ~$13 on CloudFront**

Conclusion: the hard cost is essentially $0 until you hit operational scale. The real cost is maintainer time — budget for a 20% FTE for the first six months.

---

## Threat-model reminders

See ARCHITECTURE.md §10 for the full threat model. The short reminders for operators:

### What federation DEFENDS against

- **T1 malicious patch content** — static deny-list + canary ladder + 2-maintainer review for sensitive scopes
- **T2 supply-chain via deps** — new-dep cooldown, pinned deps, SBOM diff
- **T3 targeted attack** — content-addressed distribution; every user gets the same bytes
- **T4 compromised signing key** — short-lived Sigstore certs + Rekor monitoring
- **T5 rollback attack** — monotonic version enforcement on clients
- **T6 malicious insider** — 2-person review + canary + Rekor audit

### What federation does NOT defend against

- **User machine compromise** — Chorus is not a TEE. A user whose box is owned has already lost.
- **GitHub / OIDC provider compromise** — we inherit their threat model.
- **Sigstore Fulcio / Rekor compromise** — ditto.
- **Zero-days in the Chorus client itself** — orthogonal; handled by client auto-update.
- **Physical maintainer coercion.**
- **Quantum attacks on Ed25519 / RSA** — pre-quantum; v3 migration later.

If you find yourself designing mitigations for anything in the "does NOT defend" list, stop and ask: is this actually my registry's job, or is it an issue for the client, for GitHub, or for Sigstore upstream?

---

## Links

- Architecture: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §5 (Registry), §10 (Threat Model)
- Research synthesis: [`docs/research/02-patch-registry.md`](../docs/research/02-patch-registry.md)
- Client-side code: [`packages/registry/src/`](../packages/registry/src/) — especially `revocation.ts`, `canary.ts`, `sign.ts`, `manifest.ts`
- Registry template: [`federation/registry-template/`](registry-template/)
- GH Actions: [`federation/github-actions/`](github-actions/)
- CDN tooling: [`federation/cdn/`](cdn/)
