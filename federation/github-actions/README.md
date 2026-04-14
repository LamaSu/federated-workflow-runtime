# Federation GitHub Actions

Drop-in workflows for a Chorus patch-registry repository.

## Install

```bash
mkdir -p .github/workflows
cp federation/github-actions/sign-patch.yml        .github/workflows/
cp federation/github-actions/canary-promote.yml    .github/workflows/
cp federation/github-actions/publish-revocation.yml .github/workflows/
cp federation/github-actions/abort-on-spike.yml    .github/workflows/
```

## Workflows at a glance

| Workflow | Trigger | Purpose |
|---|---|---|
| `sign-patch.yml` | PR touching `patches/**` | Validate manifest schema + Sigstore keyless sign. Posts check-run. |
| `canary-promote.yml` | cron `7 * * * *` (hourly) | Advance patches through canary ladder when dwell time elapses. |
| `publish-revocation.yml` | push to main touching `revoked.json` | Sign + upload revocation list to CDN. |
| `abort-on-spike.yml` | cron `*/15 * * * *` | Query telemetry → auto-abort patches with error-rate spikes. |

## Required configuration

Set these at the **repo** or **org** level (Settings → Secrets and variables → Actions):

### Secrets

| Name | Required by | Purpose |
|---|---|---|
| `CDN_BUCKET` | publish-revocation | S3-style URI (e.g., `s3://my-patches-cdn`) |
| `CDN_ACCESS_KEY_ID` | publish-revocation | S3-compatible access key |
| `CDN_SECRET_ACCESS_KEY` | publish-revocation | S3-compatible secret |
| `CDN_ENDPOINT_URL` | publish-revocation (R2, B2, Wasabi) | Non-AWS endpoint override |
| `CDN_REGION` | publish-revocation | Defaults to `us-east-1` |
| `CDN_PUBLIC_URL` | publish-revocation | Public base URL for post-upload verify (optional) |
| `CHORUS_REVOCATION_SIGNING_KEY` | publish-revocation | Ed25519 private key (base64) for fallback signature. Optional — Sigstore keyless is primary. |
| `TELEMETRY_TOKEN` | abort-on-spike | Bearer token for your telemetry endpoint (optional) |

### Variables

| Name | Required by | Purpose |
|---|---|---|
| `TELEMETRY_ENDPOINT` | abort-on-spike | HTTPS URL returning the documented telemetry JSON |

## Vendor portability

All four workflows are vendor-agnostic:

- **CDN**: `aws s3 cp` works for AWS S3, Cloudflare R2 (with `--endpoint-url`), Backblaze B2, MinIO, and Wasabi unchanged.
- **Signing**: Sigstore keyless requires only GitHub's OIDC token — no external secret store.
- **Telemetry**: the endpoint shape is documented in `abort-on-spike.yml`; any PostHog-style or Chorus-aggregator endpoint can satisfy it.

## Validating the YAML

```bash
python -c "import yaml, sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" \
  sign-patch.yml canary-promote.yml publish-revocation.yml abort-on-spike.yml
```

## Permissions

Each workflow declares its own `permissions:` block. None request more than necessary:

- `sign-patch.yml` — `id-token: write` (OIDC for Sigstore), `checks: write`, `pull-requests: write`.
- `canary-promote.yml` — `contents: write` (to push stage advances).
- `publish-revocation.yml` — `contents: read`, `id-token: write`.
- `abort-on-spike.yml` — `contents: write`.

If you fork the registry template, GitHub's default workflow permissions must allow write access to `contents` for the scheduler jobs. Settings → Actions → General → Workflow permissions → "Read and write permissions".

## Debugging

- `canary-promote` log lines: grep for `ADVANCE`, `hold`, `skip`.
- `abort-on-spike` log lines: grep for `ABORT`.
- `publish-revocation`: verify the CDN responded — `curl -I $CDN_PUBLIC_URL/revoked.json | grep -i cache-control`.
- `sign-patch`: the check-run on the PR links to the bundle artifact.

If a workflow repeatedly no-ops, check:

1. Secrets / variables are set at the correct scope (repo vs org vs environment).
2. Branch-protection rules don't block the bot from pushing (add the bot to exceptions).
3. For `canary-promote`: patches need `metadata.advancedAt[<currentStage>]` populated. The workflow won't advance a stage that has no entry timestamp — that would be arbitrary.
