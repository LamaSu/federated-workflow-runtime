---
name: Patch proposal
about: Propose a fix to a broken Chorus integration
title: "[patch] <integration>: <short description>"
labels: ["patch-proposal", "triage"]
assignees: []
---

## Integration affected

<!-- e.g., slack-send, http-generic -->

- [ ] `<integration-name>`

## Current failing behavior

<!--
What specifically breaks? Paste the redacted error signature + a one-line summary.
Reference the Chorus failure-report file if you have one (~/.chorus/runs/<run-id>/report.json).
-->

- **Error signature hash:** `sha256:...`
- **Observed:** `...`
- **Expected:** `...`

## Root cause (as you understand it)

<!--
1-3 sentences. What's actually wrong? Vendor API change? Race condition? Rate-limit header?
-->

## Proposed fix

<!--
Describe the change in plain English. Attach the unified diff below (or paste inline).
-->

```diff
<!-- paste diff here -->
```

## Scope

<!--
Check all that apply. "Sensitive" scopes require 2-maintainer approval regardless of your reputation.
See CONTRIBUTING.md#review-routing.
-->

- [ ] `docs`
- [ ] `retry-policy`
- [ ] `transform`
- [ ] `schema`
- [ ] **`auth`** — sensitive, 2 maintainers required
- [ ] **`secrets`** — sensitive, 2 maintainers required
- [ ] **`network`** — sensitive, 2 maintainers required

## Evidence

- [ ] I have a cassette showing the pre-fix failure: `cassettes/sig-<hash>.cassette.json`
- [ ] I have a regression test that fails without the patch and passes with it
- [ ] My diff applies cleanly against the currently-published `beforeVersion`
- [ ] I have not introduced new dependencies
- [ ] I have not introduced `eval` / `Function` / new network hosts in auth modules

## Rollout preference

- [ ] Standard 7-day canary (default)
- [ ] Expedited 4-hour canary (security hotfix only — justify below)

**Justification (if expedited):**

<!-- Leave blank for standard rollout. -->

## Author

- **GitHub handle:** @
- **Reputation (if known):** `0`
- **Signing identity:** Sigstore via GitHub Actions / Ed25519 key `<id>` / both

## Checklist before opening PR

- [ ] I've read [CONTRIBUTING.md](../../CONTRIBUTING.md)
- [ ] I've read [`patches/README.md`](../../patches/README.md) for the schema
- [ ] My signing identity is in `trusted-signers.json` (or I will add it in a separate PR first)
