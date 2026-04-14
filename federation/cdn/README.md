# Federation CDN — revocation fast-path tooling

Scripts + a standalone validator for the revocation list that Chorus clients poll every 5 minutes.

This is the ops tooling for ARCHITECTURE.md §5.6 — **the revocation fast-path**.

---

## Mental model

```
t=0       Maintainer merges a change to revoked.json on main.
t+1s      publish-revocation.yml runs: signs + uploads to CDN.
t+60s     CDN edge caches refresh (max-age=60).
t+5min    Every polling client has the new list in the worst case
          (clients poll revoked.json every 5 minutes).
t+5min+   Clients uninstall revoked patches, roll back to pre-patch versions.
```

The CDN stores exactly two files:

```
/revoked.json        — the signed revocation list (canonical JSON)
/revoked.sig.json    — the signature bundle (payload SHA-256 + Ed25519 signature + signer ID)
```

Both files ship with `Cache-Control: public, max-age=60, must-revalidate`. That's an intentional trade-off: 60s of edge staleness is fine vs a 5-min polling cadence, and it keeps the origin requests down to O(10/minute) per region.

A **Sigstore bundle** (`revoked.sigstore.json`) is also uploaded by `publish-revocation.yml` for clients that prefer keyless verification over the Ed25519 fallback. Either signature alone is sufficient.

---

## Files

| File | Purpose |
|---|---|
| `publish-revocation.sh` | Signs `revoked.json` with Ed25519 + uploads to a configured CDN bucket. Bash, portable macOS/Linux. |
| `validate-revocation.ts` | Standalone client-side verifier — downloads, schema-checks, hash-verifies, signature-verifies, freshness-checks. |
| `README.md` | This file. |

---

## `publish-revocation.sh`

### Typical invocation

```bash
# Env-driven (CI-friendly)
export CHORUS_REVOCATION_SIGNING_KEY="<base64-encoded 32-byte seed>"
export CDN_BUCKET="s3://my-chorus-patches"
export CDN_PUBLIC_URL="https://patches.mychorus.dev"
./publish-revocation.sh

# Explicit flags (manual invocation)
./publish-revocation.sh \
  --file revoked.json \
  --key-file ~/.chorus/revocation-key.json \
  --bucket s3://my-chorus-patches \
  --public-url https://patches.mychorus.dev

# Dry-run (no upload, produces signature bundle only)
./publish-revocation.sh --key-file ~/.chorus/revocation-key.json --dry-run
```

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--file <path>` | `revoked.json` | Input revocation list |
| `--bucket <uri>` | `$CDN_BUCKET` | Target bucket (S3 URI) |
| `--endpoint <url>` | `$CDN_ENDPOINT_URL` | S3-compatible endpoint override (R2, B2, MinIO, Wasabi) |
| `--public-url <url>` | `$CDN_PUBLIC_URL` | Public base URL used for post-upload curl verification |
| `--key-file <path>` | (none) | Ed25519 keypair JSON — see format below |
| `--out <path>` | `revoked.sig.json` | Local signature-bundle output path |
| `--dry-run` | off | Skip the upload step |

### Exit codes

- `0` — success
- `2` — usage / file-not-found / preflight failure
- non-zero from `aws s3 cp` / `curl` — upload or verification failed

### Keypair JSON format (matches `packages/registry/src/keys.ts`)

```json
{
  "id": "revocation-signer-alpha",
  "publicKey": "<base64 32-byte Ed25519 public key>",
  "privateKey": "<base64 32-byte Ed25519 seed>"
}
```

Generate a fresh keypair with the helper in `@chorus/registry`:

```bash
node -e "(async () => {
  const { generateKeypair, saveKeypair } = await import('@chorus/registry');
  const kp = await generateKeypair();
  await saveKeypair('./revocation-key.json', kp);
  console.log('publicKey', kp.publicKey);
})();"
```

Then commit ONLY the `publicKey` into `trusted-signers.json` under an entry of type `ed25519`. The private half stays on the maintainer's machine or in the org secret store.

### Canonicalization

The script signs the canonical JSON of `revoked.json` MINUS the `signature` field itself (avoids a chicken-and-egg dependency on self-reference). Canonical = recursively sorted keys, compact JSON. The SHA-256 of this canonical form is what ends up in `payloadSha256`.

**The client uses the same canonicalization** — `validate-revocation.ts` and `packages/registry/src/manifest.ts:canonicalJson` produce byte-identical output for the same input. That is the invariant that makes signature verification portable.

---

## `validate-revocation.ts`

Works the way a Chorus client would on every poll:

```bash
# Using tsx (recommended — handles TS and native fetch)
npx tsx federation/cdn/validate-revocation.ts \
  --url https://patches.mychorus.dev/revoked.json \
  --sig-url https://patches.mychorus.dev/revoked.sig.json \
  --public-key "<base64 32-byte Ed25519 pubkey>" \
  --max-age-seconds 900

# Using node 24+ (--experimental-strip-types available)
node --experimental-strip-types federation/cdn/validate-revocation.ts ...
```

### Flags

| Flag | Required | Default | Purpose |
|---|---|---|---|
| `--url` | yes | — | URL of `revoked.json` |
| `--sig-url` | yes | — | URL of `revoked.sig.json` |
| `--public-key` | yes | — | Base64-encoded 32-byte Ed25519 public key |
| `--max-age-seconds` | no | 900 | Refuse if `asOf` is older than this |
| `--allow-stale` | no | off | Ignore freshness check (use for debugging) |

### Exit codes

- `0` — verified and fresh (prints a JSON summary to stdout)
- `1` — any verification failure (schema, hash, signature, freshness, network)
- `2` — argument error

### Example output

```json
{
  "ok": true,
  "asOf": "2026-04-13T12:34:56Z",
  "revokedCount": 3,
  "signerId": "revocation-signer-alpha",
  "payloadSha256": "a1b2c3d4e5f6...",
  "ageSeconds": 42
}
```

---

## Signing-key rotation

The revocation signing key is the highest-value key in the entire federation — if it leaks, an attacker can forge arbitrary revocations (denial-of-service against legitimate patches).

### Normal rotation (planned)

1. Generate a new keypair. Add the new `publicKey` to `trusted-signers.json` under a new `id` (e.g., `revocation-signer-beta`). Two-maintainer PR approval required.
2. Publish a revocation list signed with the NEW key. Verify it — `validate-revocation.ts --public-key <new>`.
3. Keep BOTH entries in `trusted-signers.json` for a deprecation window (at least 24 hours — longer than the max client cache TTL).
4. Remove the OLD entry. Destroy the OLD private key.

### Emergency rotation (key compromise)

The signing key itself can be revoked by revoking its `trusted-signers.json` entry and simultaneously publishing a revocation list that revokes everything the compromised key ever signed. Order matters:

1. Publish a signed-with-NEW-key revocation list that revokes every patch signed after the suspected compromise window. Yes, this is potentially a big list — false positives are cheaper than leaving a backdoor open.
2. Commit the `trusted-signers.json` removal of the OLD entry in the SAME PR as the new revocation list (atomic merge).
3. Notify users via the out-of-band announcement channel — they will need to reload the trust set (client auto-does this on next poll, but operators may also push a client-side update via the client's own update mechanism).
4. Post-mortem within 72 hours.

### What the client does

Clients fetch `trusted-signers.json` on startup and re-fetch every 5 minutes alongside `revoked.json`. On signer removal, any patch signed by the removed signer is treated as unsigned and will NOT be applied — so revocation of the signer is itself the revocation of every one of their patches. That's the "revoke the signer itself" story referenced in ARCHITECTURE.md §10.4.

---

## Picking a CDN

Any S3-compatible object store works. Ranked by cost for small payloads (< 10 MB/mo):

| Option | Egress cost (rough) | Notes |
|---|---|---|
| Cloudflare R2 | $0 egress | Needs `--endpoint-url https://<account>.r2.cloudflarestorage.com` |
| Backblaze B2 | $0.01/GB | Free cache via Cloudflare proxy |
| AWS S3 + CloudFront | $0.085/GB (S3) + $0.085/GB (CloudFront) | Most portable, most expensive |
| Bunny.net | $0.01/GB | Simple, not S3-compatible — modify the script |

R2 is the default recommendation for greenfield Chorus deployments: zero egress, trivially set up, fronted by Cloudflare for global caching out of the box.

---

## Observability

Both scripts emit structured output:

- `publish-revocation.sh` logs each major step to stderr and writes the signature bundle to `--out`.
- `validate-revocation.ts` prints a JSON summary on success (pipe to `jq` or a logging pipeline).

In CI, log these to your observability system of choice (PostHog, Axiom, Honeycomb). The key metrics:

- `revocation.publish.duration_ms`
- `revocation.publish.size_bytes`
- `revocation.validate.freshness_seconds` — alert if this rises above your max-age threshold for any deployed client

---

## Testing the full path locally

```bash
# 1. Generate a throwaway keypair (not for production).
node -e "(async () => {
  const { generateKeypair, saveKeypair } = await import('@chorus/registry');
  const kp = await generateKeypair();
  await saveKeypair('./test-key.json', kp);
  console.log('pub', kp.publicKey);
})();"

# 2. Sign the template revoked.json.
./federation/cdn/publish-revocation.sh \
  --file ./federation/registry-template/revoked.json \
  --key-file ./test-key.json \
  --dry-run \
  --out /tmp/test-revoked.sig.json

cat /tmp/test-revoked.sig.json

# 3. Serve the pair locally and validate.
(cd /tmp && python -m http.server 8765) &
cp federation/registry-template/revoked.json /tmp/revoked.json
cp /tmp/test-revoked.sig.json /tmp/revoked.sig.json
PUB=$(jq -r .publicKey test-key.json)
npx tsx federation/cdn/validate-revocation.ts \
  --url http://localhost:8765/revoked.json \
  --sig-url http://localhost:8765/revoked.sig.json \
  --public-key "$PUB" \
  --allow-stale   # the template has asOf=epoch
```

You should see `{"ok": true, ...}`. That round-trip is the single best sanity check before going live.
