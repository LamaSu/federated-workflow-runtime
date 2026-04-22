# Sigstore Trusted Publisher Binding — Chorus Walkthrough

**Purpose:** Bind each `@delightfulchorus/*` npm package to this repo's GitHub Actions workflow so future CI publishes carry Sigstore provenance attestations (the little "provenance" badge on npm, verifiable with `npm audit signatures`).

**One-time task.** After this, every `publish-npm.yml` run signs tarballs with a short-lived OIDC identity from GitHub — no long-lived npm tokens needed, nothing to rotate.

---

## Prerequisites (verify before clicking)

- [ ] You are signed in to npmjs.com as **`lamasu`** (the `delightfulchorus` org owner). Confirm at https://www.npmjs.com/~lamasu — should show your avatar top-right.
- [ ] 2FA is enabled on the npm account. (Required for Trusted Publisher.)
- [ ] The GitHub repo exists: https://github.com/LamaSu/federated-workflow-runtime
- [ ] A workflow file named exactly `publish-npm.yml` lives in `.github/workflows/` on the default branch. (If it's named differently on disk, the binding *must* use the on-disk name — npm compares exact filename.)

If any of the above fail, stop and fix before clicking.

---

## The binding form (identical for every package)

On each package's `/access` page you'll find the **"Trusted Publisher"** section. Click **"GitHub Actions"** and fill:

| Field | Value |
|-------|-------|
| Organization or user | `LamaSu` |
| Repository | `federated-workflow-runtime` |
| Workflow filename | `publish-npm.yml` |
| Environment | *(leave blank)* |

Click **"Enable"**. You'll see a green "Trusted Publisher configured" banner. Done for that package.

**Gotchas:**
- The Organization field is case-sensitive on GitHub's side but npm normalizes — `LamaSu` and `lamasu` both work. Use `LamaSu` to match the GitHub canonical form.
- Environment MUST be blank unless you've actually configured a GH Actions environment with that name. A typo'd environment silently rejects every publish.
- If npm shows "Publisher mismatch" on the next publish, the workflow filename is wrong — re-check it exactly matches what's in `.github/workflows/`.

---

## Per-package checklist (15 packages)

Click each link, apply the binding above, tick the box.

### Core packages (8)

- [ ] **@delightfulchorus/core** — https://www.npmjs.com/package/@delightfulchorus/core/access
- [ ] **@delightfulchorus/runtime** — https://www.npmjs.com/package/@delightfulchorus/runtime/access
- [ ] **@delightfulchorus/cli** — https://www.npmjs.com/package/@delightfulchorus/cli/access
- [ ] **@delightfulchorus/mcp** — https://www.npmjs.com/package/@delightfulchorus/mcp/access
- [ ] **@delightfulchorus/registry** — https://www.npmjs.com/package/@delightfulchorus/registry/access
- [ ] **@delightfulchorus/repair-agent** — https://www.npmjs.com/package/@delightfulchorus/repair-agent/access
- [ ] **@delightfulchorus/reporter** — https://www.npmjs.com/package/@delightfulchorus/reporter/access
- [ ] **@delightfulchorus/service-catalog** — https://www.npmjs.com/package/@delightfulchorus/service-catalog/access

### Integration packages (7)

- [ ] **@delightfulchorus/integration-gmail-send** — https://www.npmjs.com/package/@delightfulchorus/integration-gmail-send/access
- [ ] **@delightfulchorus/integration-http-generic** — https://www.npmjs.com/package/@delightfulchorus/integration-http-generic/access
- [ ] **@delightfulchorus/integration-mcp-proxy** — https://www.npmjs.com/package/@delightfulchorus/integration-mcp-proxy/access
- [ ] **@delightfulchorus/integration-postgres-query** — https://www.npmjs.com/package/@delightfulchorus/integration-postgres-query/access
- [ ] **@delightfulchorus/integration-slack-send** — https://www.npmjs.com/package/@delightfulchorus/integration-slack-send/access
- [ ] **@delightfulchorus/integration-stripe-charge** — https://www.npmjs.com/package/@delightfulchorus/integration-stripe-charge/access
- [ ] **@delightfulchorus/integration-universal-http** — https://www.npmjs.com/package/@delightfulchorus/integration-universal-http/access

---

## After binding: verify on next publish

Once every box is checked, the next `publish-npm.yml` run will sign each tarball automatically. Verify:

```bash
# After CI publishes a new version:
npm audit signatures @delightfulchorus/cli

# Expected output includes a line like:
#   audited 1 package with signatures and provenance
#   1 package has a verified attestation
```

If you see "missing attestation", the binding didn't take for that package — re-open its `/access` page and check the Trusted Publisher section shows a green banner.

## Also visible on the package page

Once bound + published via CI, the npm package page (e.g., https://www.npmjs.com/package/@delightfulchorus/cli) shows a **"Provenance"** badge with:
- Source commit SHA
- Build workflow link
- Signed by: GitHub Actions OIDC

That's the public proof that the tarball came from this repo's CI, not from a dev laptop with a stolen token.

---

## Why this matters for federation

Federation signs *patches* with Ed25519 keys we control. Sigstore signs *packages* with npm's infrastructure. Two different trust roots, both required:

1. **Package provenance** (this walkthrough) — user installed the real `@delightfulchorus/runtime`, not a typosquat.
2. **Patch provenance** (federation registry) — the runtime applied a real Chorus-signed patch, not a poisoned diff.

Without #1, #2 doesn't mean anything — an attacker could publish a malicious runtime that ignores federation signatures entirely. Bind every package.
