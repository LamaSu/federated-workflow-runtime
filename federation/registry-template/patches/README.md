# Patches

Per-integration patches live under `patches/<integration>/` as individual JSON files.

## Layout

```
patches/
├── README.md
├── .gitkeep
└── <integration>/
    ├── manifest.json                         # optional integration-level metadata
    └── <YYYY-MM-DD>_<slug>_<hash8>.json      # per-patch manifests
```

Example — once populated:

```
patches/
└── slack-send/
    ├── manifest.json
    ├── 2026-04-10_oauth-refresh-race_a1b2c3d4.json
    └── 2026-04-12_rate-limit-header_e5f6g7h8.json
```

## Filename convention

Filename shape is deterministic and is produced by `manifestFilename()` in
[`packages/registry/src/manifest.ts`](https://github.com/lamasu/chorus/blob/master/packages/registry/src/manifest.ts).

Shape: `<YYYY-MM-DD>_<id-slug>_<content-hash-8>.json`

- `<YYYY-MM-DD>`: the `metadata.createdAt` day
- `<id-slug>`: slugified `metadata.id` (lowercase, alphanumerics + `-_` only, ≤80 chars)
- `<content-hash-8>`: first 8 hex chars of SHA-256 over canonical JSON of the patch body (signature excluded)

If you rename a file, CI will reject the PR. Let the workflow compute it for you.

## Per-patch manifest schema

Authoritative: `PatchSchema` in [`@chorus/core/src/schemas.ts`](https://github.com/lamasu/chorus/blob/master/packages/core/src/schemas.ts). Required fields:

- `metadata.id` — stable unique ID, usually `<integration>_<descriptive-slug>_<random8>`
- `metadata.integration` — must match the parent directory name
- `metadata.errorSignatureHash` — SHA-256 hex of the error signature this patch addresses
- `metadata.description` — plain-text prose, 1-3 sentences
- `metadata.author` — `{ id, publicKey, reputation }`
- `metadata.beforeVersion` / `metadata.afterVersion` — integration semver
- `metadata.testsAdded` — file paths of regression tests added by this patch
- `metadata.canaryStage` — one of the canary-ladder enum values (see §5.4 + `canary.ts`)
- `metadata.createdAt` — ISO 8601 UTC
- `metadata.advancedAt` — map of `<stage> → <ISO timestamp>`
- `diff` — unified-diff string that applies cleanly to `beforeVersion`
- `snapshotUpdates` — `[{ path, contentHash }]` for each cassette the patch touches
- `signature` — base64 Ed25519 signature (populated by CI)
- `signatureAlgorithm` — always `"ed25519"` for the fallback path

CI runs `PatchSchema.safeParse(...)` on every PR — any missing or extra field rejects the PR with a schema error pointing at the offending path.

## Cassettes

If a patch changes how an integration talks to its upstream API, the PR must include the corresponding cassette update(s) in `cassettes/<signature-hash>.cassette.json`. The patch manifest's `snapshotUpdates[].contentHash` must match the new cassette's SHA-256. This is how the repair agent proves the fix is real against recorded traffic.
