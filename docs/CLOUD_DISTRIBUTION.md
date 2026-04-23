# Cloud Distribution

*Last updated: 2026-04-22. Author: implementer-echo. Supersedes the "hosted
SaaS is never" absolutism of `docs/ARCHITECTURE.md` §1.4 **only** in
clarifying which specific shape of cloud distribution is compatible with
the local-first thesis and which is not.*

## 1. The question

The user asked: *"for cloud distribution... why not?"*

The naïve answer — "because Chorus is local-first" — is under-specified.
"Cloud distribution" is a family of three different shapes, and exactly
one of them is compatible with the local-first thesis today. This doc
names all three, picks the compatible one for v1.x, and documents the
conditions under which the other two could be revisited later.

## 2. The thesis under threat

`docs/ARCHITECTURE.md` §1.4 declares:

> **Not a hosted SaaS.** There is no Chorus cloud, only user machines + a
> public patch registry.

And §2.7:

> **Credentials NEVER leave the user's machine.** The reporter explicitly
> strips all credential material from error reports.

These two lines form the local-first contract. Any new feature claiming
"cloud" compatibility must pass a gate: *does it violate §1.4 or §2.7?*
If yes, it does not ship in this shape — it either ships in a different
shape (below), or it doesn't ship.

This doc exists so that a future session asked "why not add hosted
workflows?" can answer "because the thesis gate rejects it" without
relitigating the whole question. It is a covenant. Add to it the way
`docs/ROADMAP.md` instructs for new items: record the deletion or
softening of any part of this doc in `CHANGELOG.md` with rationale.

## 3. Three models for cloud distribution

### Model A — Template share (MVP; ships now)

**What travels over the wire:** the workflow graph (nodes, connections,
trigger definitions), credential *type hints* (e.g. "this node needs a
slack-send bearer token"), and input schemas. That's it.

**What stays local:** every credential *value*. The runtime binary. The
SQLite database. The repair agent. All execution.

**Transport:** a JSON file. Optionally hosted on a GitHub Gist, but no
Chorus-operated infrastructure is in the path. The Gist URL is just
shorthand for `curl | chorus import`.

**Fits the thesis?** Yes. Zero credentials leave the box. No hosted
runtime. The template is a neutral JSON blob the same way an OpenAPI
spec is a neutral JSON blob.

**Parallels in prior art:**
- Windmill's Hub and OpenFlow spec (workflows travel as JSON; resources
  stay local and are re-bound on import)
- Appsmith and Retool application export/import (apps travel; datasource
  credentials do not)

This is the model that ships in this PR. See §5.

### Model B — Hosted UI (design; deferred)

**What it would travel:** the same template-share payload from Model A,
*plus* some UI state (dashboard preferences, saved views, user
annotations).

**What would stay local:** credential values. The runtime. Everything
execution-related.

**Key constraint:** the hosted UI would be a rendering surface only. It
would never hold decrypted credentials, never make API calls on behalf
of users, and never run workflows. It would be a pure client for a
user's local runtime's JSON API — Chorus's own hosted version of the
"agent-generated dashboard" in `docs/ROADMAP.md` §7.

**Fits the thesis?** Conditionally yes, *if and only if* the hosted UI
never receives a decrypted credential and never proxies workflow
execution. The moment it does either, the thesis is violated.

**Why we defer this:** the user's existing guidance in ROADMAP §7 is
"the user's agent builds the UI." A Chorus-built hosted UI competes with
that thesis — it trades agent-generated flexibility for something we'd
have to maintain. It also introduces a new attack surface (a server that
knows which workflows a user has, even without knowing their credentials)
that is real even when it's narrow.

**Trigger to revisit:** 50+ users explicitly ask for a hosted read-only
dashboard, AND ROADMAP §7 Extension A (local reference dashboard) is
not enough. Until then: no.

### Model C — Hosted runtime (design; deferred with strong caveat)

**What it would travel:** the workflow graph *and* the credential
values, encrypted end-to-end.

**What would stay local:** the user's encryption key.

**The architecture this would require:** a user-held key model, similar
to 1Password's shared vaults or Proton's end-to-end-encrypted services.
The hosted runtime would hold encrypted cassettes indexed by workflow
ID; at execution time, the runtime would fetch the ciphertext, decrypt
it client-side (in a WASM sandbox or signed helper process) using the
user's locally-held key, run the workflow, and re-encrypt any output
before returning. No cleartext credential would ever live on the
hosted runtime's disk or RAM.

**Fits the thesis?** Conditionally yes, *but only if the user-held key
model is implemented correctly.* Every production deployment of
user-held-key crypto in the industry has caveats. 1Password's story
took a decade to settle. Proton's key-recovery flow is still
controversial. The complexity is high.

**Why we defer this:** the cost of getting it wrong is catastrophic
(leaked credentials for every user of the hosted runtime). The cost of
getting it right is enormous (months of work, a key-management UX that
users have to tolerate, dependence on a signed-helper process that
works on every platform). The benefit is marginal for our target user
(the person with 20 integrations and an n8n instance that breaks
monthly), who was already happy to self-host.

**Trigger to revisit:** a credible enterprise user (5-10 seats) says
"we'd pay for this and we understand the key-management UX." *Until*
that signal, no. Even then, the implementation path is a separate
project — it is not part of chorus core.

## 4. Decision matrix

| Dimension                                    | Model A (template share) | Model B (hosted UI) | Model C (hosted runtime) |
|----------------------------------------------|--------------------------|---------------------|--------------------------|
| Fits local-first thesis (§1.4 / §2.7)?       | Yes (trivially)          | Yes, *if* read-only | Yes, *if* user-held key  |
| Fits federated patch registry (§5)?          | Orthogonal (workflow-level, not patch-level) | Orthogonal | Orthogonal |
| Fits MCP surface (ROADMAP §1)?               | Additive (templates can suggest which MCP tools to enable) | Replaces UI layer | Replaces runtime layer |
| Credential boundary preserved?               | Yes — never on the wire  | Yes — if rendering-only | Yes — if E2E crypto works |
| Chorus-operated infra required?              | None                     | Yes (static hosting at minimum) | Yes (runtime servers) |
| Implementation cost (agent-days)             | 1                        | 10-20               | 60+                      |
| Risk if done wrong                            | Low (worst case: leaked API key in a shared file someone did manually) | Medium (attack surface, maintenance) | Catastrophic (credential leak) |
| Signal required to start                     | User is asking now       | 50+ users ask for hosted dashboard | Credible enterprise signal |

Model A is a near-trivial feature that is already implied by
"self-hosted + share your workflows." Models B and C each require a
design document of their own before they're ready to build; this doc
is the reminder that they exist and what the gates are.

## 5. MVP implementation (Model A)

Shipped in this PR. Two CLI commands plus a reusable credential-redaction
library.

### 5.1 `chorus share <workflow-id> [--gist] [--out FILE]`

Reads a workflow from the local SQLite database, strips credential
values, and emits a JSON template.

**Default:** writes `<slug>.chorus-template.json` in the current working
directory.

**With `--gist`:** POSTs the template to GitHub Gist via `@octokit/rest`
(optional dependency — only loaded when `--gist` is passed). Uses the
`GITHUB_TOKEN` environment variable, or `gh auth token`'s output, for
authentication. Prints the gist URL when done.

**With `--out <file>`:** writes to the specified path instead of the
default slug-based name.

The redaction transform (see §5.3) is the heart of this command. It
walks the workflow graph, looks up each integration's
`CredentialTypeDefinition` in `packages/core/src/credential-catalog.ts`,
identifies fields marked `type: "password"`, and replaces their values
with `{ __credentialRef: true, credentialType: "<type>", hint: "..." }`
stubs. The rest of the node config — non-sensitive fields like
channel names, URLs, schedule expressions — is preserved verbatim.

### 5.2 `chorus import <url|file> [--rename <new-slug>]`

Inverse of `share`. Accepts a file path or an `http(s)://` URL (gist
raw URLs are the expected form, but any HTTP(S) URL that returns valid
template JSON works). Validates against `WorkflowSchema` via Zod. For
each `__credentialRef` in the template, looks up the user's existing
credentials of the referenced type; if a match exists, offers to link
it; if not, prints the `chorus credentials add <type>` incantation the
user needs and exits with a non-zero status.

**With `--rename <new-slug>`:** replaces the template's workflow ID
with the provided slug. Useful when importing two variants of the same
template, or when the template's author used a name that conflicts
with something already local.

After import, the workflow is inserted into the local SQLite database
and the user can `chorus run <slug>` or `chorus validate` it. The
import command prints the next steps.

### 5.3 `packages/cli/src/lib/credential-redaction.ts`

The redaction transform is split out so it can be unit-tested in
isolation and reused by any future command (a hosted-UI export, a
backup command, a CI preview). Its contract:

```ts
redactCredentials(
  workflow: Workflow,
  catalogs: Record<integrationName, CredentialTypeDefinition[]>
): RedactedWorkflow
```

- `Workflow` is the canonical schema from `@delightfulchorus/core`.
- `catalogs` is the per-integration credential type catalog, looked up
  at share-time from `defaultIntegrationLoader` (same pattern as
  `chorus credentials test`).
- `RedactedWorkflow` is the input workflow with `node.config` scrubbed:
  any field whose `CredentialFieldSchema.type === "password"` is
  replaced with a `__credentialRef` stub; any non-sensitive field is
  preserved as-is.

Round-trip: `redactCredentials(w, c)` followed by an import that rebinds
credentials should produce a workflow whose *executable graph* is
identical to the original (node IDs, connections, triggers, non-sensitive
config). Only the credential values differ.

### 5.4 Optional dependency: `@octokit/rest`

`@octokit/rest` is declared as `optionalDependencies` in
`packages/cli/package.json` and is only `require()`'d inside the
`--gist` path of `chorus share`. If it's not installed, users can still
run `chorus share` (file mode) and `chorus import` (file + URL) without
any failure. This keeps the install footprint small for the 95% of
users who never touch the Gist integration.

## 6. Future triggers

The thesis gate is a set of preconditions, not a calendar. Revisit each
deferred model when *its own trigger* fires.

### Trigger for Model B (hosted UI)

- 50+ users explicitly ask for a hosted read-only dashboard,
  *and* ROADMAP §7 Extension A (local reference dashboard) has shipped
  and is not sufficient.
- Chorus has a distribution model that makes "hosted UI" meaningfully
  easier than "self-hosted UI + DNS."

Until both: no.

### Trigger for Model C (hosted runtime)

- Credible enterprise signal: 5-10 seats willing to pay and tolerate the
  key-management UX.
- A production-ready user-held-key crypto primitive exists that works on
  every target platform (Linux, macOS, Windows, browser).
- The hosted runtime is structured as a *separate product* that depends
  on chorus — not as a feature of chorus itself.

Until all three: no.

### Not a trigger: "competitor shipped one"

Windmill, n8n, Zapier, and Pipedream all have hosted offerings. None of
them are chorus's target — chorus's pitch is "local-first with
federated patch registry." Shipping a hosted runtime to match a
competitor replaces the thesis with table stakes; the moat is the
cassette library, not the hosting.

## 7. What this is NOT

To be explicit and to defend against future scope creep:

- **We are NOT building `chorus.cloud` as a SaaS.** The chorus project
  does not run hosted infrastructure for users. Patch registry is the
  sole centralized piece, and it is git-backed (not operated servers).
- **We are NOT adding phone-home telemetry.** The `share` and `import`
  commands do not call any chorus-operated service. `share --gist` calls
  GitHub; `import` calls whatever URL the user supplies.
- **We are NOT building a workflow marketplace.** Templates travel as
  JSON files or Gists. There is no chorus-operated directory, no
  ranking, no moderation. The federated patch registry is for
  integration *fixes*, not integration *configurations*.
- **We are NOT bundling `@octokit/rest`** in the default install.
  Optional dep, loaded only for `--gist`.
- **Third parties MAY host chorus on their own hardware** under its
  AGPL-style license (see `LICENSE`). That's their choice and their
  infrastructure, not our business model. The code does not discriminate
  between self-host-for-myself and self-host-for-paying-users.
- **Credential values NEVER appear in any shared payload,** not even
  encrypted, not even placeholdered with "user will fill in later."
  The redaction transform replaces them with explicit `__credentialRef`
  stubs that name the credential *type*, not any value.

## 8. References

- `docs/ARCHITECTURE.md` §1.4 (thesis: not a hosted SaaS)
- `docs/ARCHITECTURE.md` §2.7 (credentials never leave the box)
- `docs/ARCHITECTURE.md` §11 (deferred items)
- `docs/ROADMAP.md` §7 (UI reframed — agents generate UI)
- `docs/ROADMAP.md` out-of-scope item #1 (hosted chorus cloud)
- `docs/CREDENTIALS_ANALYSIS.md` (credential catalog schema)
- `packages/core/src/credential-catalog.ts` (CredentialTypeDefinition
  and `CredentialFieldSchema.type === "password"` — the source of truth
  for what the redaction transform strips)
- `packages/core/src/schemas.ts` (WorkflowSchema, the import gate)
- `ai/research/landscape-chorus-expansion-2026-04-22.md` Axis C
  (Windmill-pattern + Gist verdict; Nostr deferred)
- Windmill's Hub sharing documentation
  (https://www.windmill.dev/docs/misc/share_on_hub) — shape parallels
- Appsmith export/import
  (https://www.appsmith.com/blog/announcing-the-import-export-feature-for-appsmith-applications) —
  precedent for "apps travel, credentials do not"
- Retool export/import
  (https://docs.retool.com/apps/guides/app-management/import-export-apps) —
  same pattern in a different product
