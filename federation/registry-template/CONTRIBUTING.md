# Contributing to the Chorus patch registry

Thank you for proposing a fix. This registry federates integration patches across every Chorus user; your patch may reach thousands of machines within hours, so we're careful about what gets in.

---

## Quick path

1. Fork this repo.
2. Open an issue using the ["Patch proposal"](.github/ISSUE_TEMPLATE/patch-proposal.md) template.
3. Create a branch named `patch/<integration>/<short-slug>`.
4. Add your patch manifest under `patches/<integration>/`. Follow the schema in [`patches/README.md`](patches/README.md).
5. Open a PR against `main`.
6. `sign-patch.yml` will sign the manifest via Sigstore keyless and post back a check.
7. A maintainer (or two for sensitive scopes) reviews and merges.
8. On merge, the patch begins the canary ladder (§5.4 of Chorus's ARCHITECTURE.md).

---

## What you need

- A GitHub account (for Sigstore keyless signing via OIDC). Non-GitHub contributors: see "Ed25519 fallback" below.
- Reproducible evidence the patch fixes a real failure:
  - The Chorus failure report the patch addresses (error signature hash goes in `metadata.errorSignatureHash`).
  - An updated cassette under `cassettes/<sig-hash>.cassette.json` showing the patched behavior.
  - At least one regression test in the integration package (listed in `metadata.testsAdded`).
- Diff that applies cleanly to the `beforeVersion` of the integration.

---

## Review checklist

Before requesting review, self-check:

- [ ] `metadata.integration` matches the parent directory name.
- [ ] `metadata.errorSignatureHash` matches a real failure signature you've observed.
- [ ] `metadata.beforeVersion` is the currently-published integration version.
- [ ] `metadata.afterVersion` bumps appropriately (patch/minor — never major).
- [ ] `metadata.canaryStage` is `"proposed"` (let CI advance it).
- [ ] `diff` applies cleanly against `beforeVersion` (CI will reject otherwise).
- [ ] `snapshotUpdates` entries exist for every cassette the patch touches, with correct `contentHash`.
- [ ] At least one test is listed in `testsAdded` and actually exists in the integration repo.
- [ ] No new dependencies (Shai-Hulud class defense — new deps require a separate, slower review).
- [ ] No `eval` / `Function()` / unrestricted `new Function(...)` anywhere in the diff.
- [ ] No new network hosts introduced in an auth-touching module (hard block).

---

## Review routing

See [CODEOWNERS](CODEOWNERS). The short version:

| Patch scope (touches…)                         | Reviewers required           |
|-------------------------------------------------|------------------------------|
| `docs`, `retry-policy`                          | 1 maintainer                 |
| `transform`, `schema`                           | 1 maintainer                 |
| `auth`, `secrets`, `network`                    | **2 maintainers (mandatory)** |

This routing mirrors the policy in `packages/registry/src/reputation.ts:SENSITIVE_SCOPES`. It is NON-NEGOTIABLE: any PR touching a sensitive scope is auto-blocked from merge until two maintainer approvals are recorded.

---

## Signing

### Sigstore keyless (primary)

If your PR is opened from a GitHub fork, `sign-patch.yml` handles signing automatically. You don't need to run `cosign` locally. The workflow:

1. Verifies the manifest's schema.
2. Computes canonical JSON → SHA-256 → blob to sign.
3. Requests an OIDC token from GitHub's token service.
4. Calls `cosign sign-blob` which talks to Fulcio + Rekor.
5. Attaches the `.sigstore.json` bundle as a PR artifact and adds it to the commit on merge.

The cert identity is bound to this workflow file + ref + repo. Clients verify that exact identity is in `trusted-signers.json`.

### Ed25519 fallback

Non-GitHub contributors (GitLab, self-hosted, air-gapped) can sign locally:

```bash
# 1. Generate your keypair once.
#    Use packages/registry/src/keys.ts generateKeypair(), or:
node -e "(async () => {
  const { generateKeypair, saveKeypair } = await import('@chorus/registry');
  await saveKeypair('./my-key.json', await generateKeypair());
})();"

# 2. Publish the public half into trusted-signers.json via a separate PR
#    (see "Add a trusted signer" below). That PR needs 2 maintainer approvals.

# 3. Sign your patch:
node -e "(async () => {
  const fs = await import('node:fs/promises');
  const { signPatch, loadKeypair } = await import('@chorus/registry');
  const patch = JSON.parse(await fs.readFile('./patches/slack-send/...json', 'utf8'));
  const key = await loadKeypair('./my-key.json');
  const signed = signPatch(patch, key.privateKey);
  await fs.writeFile('./patches/slack-send/...json', JSON.stringify(signed, null, 2));
})();"

# 4. Open PR. Sigstore still runs in CI — either path alone is accepted by clients.
```

Keep your private key OFF this repo. Anything committed under `**/private*.json`, `**/*.key`, or matching secret-leak patterns is blocked by a `gitleaks` pre-commit hook you should install locally.

---

## Add a trusted signer

To register a new Sigstore identity or Ed25519 public key:

1. Open a PR that edits ONLY `trusted-signers.json`.
2. Add an entry of the form:

   ```json
   {
     "id": "alice@example.com",
     "type": "sigstore",
     "identity": "alice@example.com",
     "oidcIssuer": "https://accounts.google.com",
     "addedAt": "2026-04-13T12:00:00Z",
     "addedBy": "@maintainer-handle"
   }
   ```

   Or for Ed25519:

   ```json
   {
     "id": "alice",
     "type": "ed25519",
     "publicKey": "base64-encoded-32-byte-public-key",
     "addedAt": "2026-04-13T12:00:00Z",
     "addedBy": "@maintainer-handle"
   }
   ```

3. Two maintainers must approve. Sensitive; one maintainer cannot grow the trust set alone.
4. On merge, the next CDN publish (`publish-revocation.yml` also updates auxiliary indexes) will propagate the new allow-list.

Removal follows the same process — delete the entry, two approvals, merge.

---

## Rejection reasons (common)

- Filename doesn't match `manifestFilename()` output. → Let CI rename it; don't hand-edit.
- `metadata.author.publicKey` not in `trusted-signers.json` AND not a Sigstore-signed PR. → Register the signer first.
- Diff introduces new dep that's not on the pinned-deps allow-list. → Open a separate PR for the dep bump with its own review.
- Regression test is present but doesn't actually invoke the patched code path. → Add a test that exercises the fix.
- `canaryStage` is not `"proposed"`. → CI advances stage; contributors don't touch it.

---

## Code of conduct

Be kind; patches affect real people's production systems. When a reviewer pushes back, they're usually protecting the fleet from a subtle failure mode — help them help you.

---

## Questions

Open an issue with the "Question" label. Maintainers watch the queue.
