# Credential Catalog — Analysis & Upgrade Design

> **Agent:** `compare-mike` (Wave 1, session 3, 2026-04-15)
> **Consumers:** `credentials-oscar` (implements this design) and `mcp-papa` (consumes the schema)
> **Scope:** Design, not code. Code blocks here are Zod schemas to be copied verbatim into `packages/core/src/schemas.ts`.

---

## 1. What Chorus has today

Inventory of the existing credential subsystem, with file references for `credentials-oscar` to double-check.

### 1.1 Encryption at rest

- **Algorithm:** AES-256-GCM, on-disk layout `IV(12B) || TAG(16B) || CIPHERTEXT(N)`.
  - Source: `C:\Users\globa\chorus\packages\runtime\src\credentials.ts` lines 13-16, 81-111.
- **Key source:** `process.env.CHORUS_ENCRYPTION_KEY` (base64, 32 bytes). Fail-fast at boot.
  - Source: `packages\runtime\src\credentials.ts` lines 38-47.
- **Key rotation helper exists:** `rotateKey(blob, oldKey, newKey)` — decrypt-then-re-encrypt. No caller persists this yet; it is a library primitive.
  - Source: `packages\runtime\src\credentials.ts` lines 117-120.
- **Plaintext discipline:** decryption happens only in the per-Run subprocess; plaintext never touches disk, command-line, or logs. Documented in `docs\ARCHITECTURE.md` §4.6 lines 656-658.

### 1.2 Storage schema

SQLite `credentials` table — source: `packages\runtime\src\db.ts` lines 115-133.

```sql
CREATE TABLE credentials (
  id                    TEXT PRIMARY KEY,
  integration           TEXT NOT NULL,
  type                  TEXT NOT NULL,        -- 'apiKey' | 'oauth2' | 'basic' | 'bearer'
  name                  TEXT NOT NULL,        -- user-supplied label, defaults to 'default'
  encrypted_payload     BLOB NOT NULL,        -- AES-GCM blob
  oauth_access_expires  TEXT,                 -- ISO 8601
  oauth_refresh_expires TEXT,
  oauth_scopes          TEXT,                 -- JSON array
  state                 TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'invalid'
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(integration, name)
);
CREATE INDEX idx_oauth_expiring ON credentials(oauth_access_expires) WHERE type='oauth2';
```

**Gap already visible:** no column tells us which credential *type definition* this row belongs to. We just know "integration=slack-send, auth=bearer" — not "slack-send uses a Bot OAuth2 token" vs "slack-send uses a legacy Slack App token". Implementers need to add a `credential_type_name` column. See §5.

### 1.3 OAuth refresh

- **Scheduler:** `OAuthRefresher` in `packages\runtime\src\oauth.ts`.
- **Cadence:** 5-minute interval (DEFAULT_INTERVAL_MS, line 19), refreshes any credential expiring within 10 minutes (DEFAULT_LEAD_TIME_MS, line 20).
- **Architecture:** proactive, not failure-driven. Prevents the concurrent-refresh race documented in `ARCHITECTURE.md` §4.8.
- **Refresh function is injected.** The runtime provides the WHEN; the caller provides the HOW — `RefreshFn = (cred) => Promise<{newPayload, accessTokenExpiresAt}>`. Source: lines 22-29.
- **Failure handling:** `helpers.markCredentialInvalid(id, message, timestamp)`. State flips to `invalid`; workflows fail loudly with "credential invalid: reauthorize".
- **What's missing:** nobody has written the per-integration refresh implementations yet. `RefreshFn` is a hole waiting for integrations to declare how to refresh. That hole is exactly what n8n's per-credential-type metadata fills. See §4.5.

### 1.4 Auth types enum (the only per-integration hint we have today)

Source: `packages\core\src\schemas.ts` line 105.

```typescript
authType: z.enum(["none", "apiKey", "oauth2", "basic", "bearer"]),
```

This is the **sole** declaration an integration makes about its credentials today. It tells the runtime:
- whether to inject anything into `ctx.credentials` at all (`none` → null),
- whether to run OAuth refresh (`oauth2` → yes),
- nothing else.

It does not tell anyone: what fields to collect, what the field is called, whether it's a URL or a secret, how to test it, where to get one, or what the OAuth flow endpoints are.

### 1.5 CredentialSchema (the DB-row shape)

Source: `packages\core\src\schemas.ts` lines 185-200.

```typescript
export const CredentialSchema = z.object({
  id: z.string(),
  integration: z.string(),
  type: z.enum(["apiKey", "oauth2", "basic", "bearer"]),
  name: z.string(),
  encryptedPayload: z.string(),
  oauth2: z.object({
    accessTokenExpiresAt: z.string().optional(),
    refreshTokenExpiresAt: z.string().optional(),
    scopes: z.array(z.string()).default([]),
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

Note `type` duplicates `authType` nomenclature — we'll keep the column named `type` for DB compat but rename the TS field `authType` in §4.6 for clarity. `name` is a user label ("personal", "work-bot"), not the credential-type name.

### 1.6 CLI surface

Source: `packages\cli\src\commands\credentials.ts`.

- `chorus credentials add <integration> --type <authType> [--secret X | --payload {...} | --interactive]`
- `chorus credentials list [--json]`
- `chorus credentials remove <integration> <name>`

No `test`, no discovery of required fields, no OAuth authorize flow, no deep-link helper. The user reads integration README, figures out the payload shape, pastes a JSON blob. Power-user-only UX.

### 1.7 What an integration module declares about credentials TODAY

Concrete audit of both shipped integrations.

**`http-generic`** (`integrations\http-generic\src\index.ts` lines 60-95):
```typescript
manifest: {
  name: "http-generic",
  authType: "none",
  // no credential fields declared, no testCredential, no OAuth metadata
}
```

**`slack-send`** (`integrations\slack-send\src\index.ts` lines 54-86):
```typescript
manifest: {
  name: "slack-send",
  authType: "bearer",
  docsUrl: "https://api.slack.com/methods/chat.postMessage",
  // no field schema, no test, no OAuth endpoints, no deep-link to token page
}
```

The bearer-token handler `extractBearerToken(ctx.credentials)` (lines 94-102) accepts three shapes — plain string, `{accessToken}`, `{token}`, `{bearer}` — because nobody knows what the credential SHOULD look like. **This is exactly the ambiguity the typed credential catalog fixes.**

### 1.8 Summary of today's state

| Dimension | State |
|---|---|
| Encryption | Solid (AES-256-GCM, documented, tested) |
| Storage | Adequate (SQLite, one row per credential, unique on integration+name) |
| OAuth refresh scheduler | Solid (proactive, tested) |
| OAuth refresh implementations | **Not written** — per-integration hole |
| Per-integration field schema | **None** — CLI accepts free-form JSON |
| Credential test ("does this actually work?") | **None** |
| OAuth authorize flow (browser round-trip) | **None** |
| Deep-link to "where do I get this PAT?" | **None** |
| Display names / descriptions for UX | **None** |
| Multiple credential types per integration | **Not modeled** (e.g., Slack bot vs user token) |

---

## 2. What n8n has that we don't

From the user's paste, cross-referenced against n8n's public code (`n8n-io/n8n` → `packages/nodes-base/credentials/`) and Wave 1's research budget. Concrete delta:

### 2.1 Typed field schema per credential type
Each n8n credential exports a `properties: INodeProperties[]` array declaring every field: name, displayName, type (string/password/url/number/boolean/options), description, default, required, regex, etc. The engine renders a form from this. Without this, Chorus's CLI has no idea what to prompt for.

### 2.2 Per-credential `test()` stub (credential test API)
Each credential ships with a `test: ICredentialTestRequest` that does a cheap canonical call (`/auth/test`, `GET /user`, etc.) and validates response. The n8n UI's "Test" button invokes it. Chorus has no equivalent; our users find out at 3 AM via a failing workflow.

### 2.3 OAuth 2.0 flow metadata (authorize + token URLs, scopes, PKCE)
n8n credentials declare `authUrl`, `accessTokenUrl`, `scope`, `authQueryParameters`, `authenticationMethod` ("header" | "body"). Its OAuth core reads these and runs the authorize dance without per-credential code. Our `RefreshFn` is injected per-runtime, not per-integration — we need metadata on the integration so the generic refresher knows *which* endpoint to hit.

### 2.4 Documentation URL & "where do I get this?" deep-link
Credentials have `documentationUrl` (n8n docs) plus the field-level `description` can include markdown links. n8n's cloud UI surfaces "Get your token here" buttons. We have one `docsUrl` at the integration level but no field-level "open https://github.com/settings/tokens to create a classic PAT" pointers.

### 2.5 Display name & description (per-field and per-type)
Every credential type has a `displayName`. Every field has a `displayName` and `description`. Powers UX. We carry `name` (an enum value) as the only label.

### 2.6 Field validation (regex, min/max length, format hints)
n8n uses `typeOptions: { password: true, rows: 4, ... }` plus field-level validators. Password fields render masked. URL fields validate. We have Zod on the *workflow* side but none on *credentials*.

### 2.7 Multiple credential types per service
n8n has `slackApi` (token) AND `slackOAuth2Api` (OAuth) — a Slack integration can accept either. We hard-code one `authType` per integration. Slack is literally the canonical example.

### 2.8 Credential sharing + RBAC (Cloud/Enterprise only)
Not relevant to local-first Chorus v1. Skip.

### 2.9 Expression evaluation inside credential field defaults
e.g. default `baseUrl = "https://{{ $credentials.workspace }}.slack.com"`. Powerful but deep-end. Defer.

### 2.10 generic `httpRequest` helper that consumes the credential
n8n has a `this.helpers.requestWithAuthentication(credType, options)` that applies the right auth header given a credential-type name. The mirror in Chorus would be: given a `CredentialTypeDefinition`, synthesize the `Authorization` header. Nice-to-have; defer.

---

## 3. What we adopt vs skip vs defer

Decision table. For each feature: **ADOPT-NOW** (Wave 2 implements), **DEFER-V2** (roadmap item), **SKIP-FOREVER** (wrong shape for Chorus), with justification.

| # | Feature | Decision | Why |
|---|---|---|---|
| 2.1 | Typed field schema per credential type | **ADOPT-NOW** | Without this `chorus credentials add` is useless as a UX primitive. This is the core of the whole upgrade. |
| 2.2 | `testCredential()` stub | **ADOPT-NOW** | User explicitly called this out ("catches rotation failures before a workflow breaks at 3am"). Cheap to add per-integration. |
| 2.3 | OAuth flow metadata | **ADOPT-NOW** | We already have an OAuth *scheduler* looking for a refresh impl; this fills the gap. Also enables the authorize flow. |
| 2.4 | `documentationUrl` at credential-type level + field-level deep-links | **ADOPT-NOW** | Near-zero cost. Solves the "UI-only PAT tail" by shortening the user's journey from 90 s to 10 s. |
| 2.5 | `displayName` + `description` | **ADOPT-NOW** | String metadata, trivial. mcp-papa needs these for tool descriptions. |
| 2.6 | Field validation (regex, min/max, format) | **ADOPT-NOW** | Comes free with Zod — we already use it for workflow nodes. Use the same vocabulary. |
| 2.7 | Multiple credential types per integration | **ADOPT-NOW** | `credentialTypes: CredentialTypeDefinition[]` is a list. Most integrations ship one; Slack-like ones ship two or three. |
| — | `inUseCallback` / `extendsType` (credential inheritance) | **DEFER-V2** | n8n has "oauth2Api" as a base that concrete credentials extend. Nice factoring but adds a resolution step; wait until we have 10+ credential types shipped. |
| 2.10 | `requestWithAuthentication` generic helper | **DEFER-V2** | Can be built on top of the field schema later. Not blocking anything in Wave 2. |
| 2.8 | Credential sharing / RBAC | **SKIP-FOREVER (v1 local-first)** | Chorus is single-user. If we ever ship cloud, this is a platform concern, not a credential concern. |
| 2.9 | Expression evaluation inside credential defaults | **SKIP-FOREVER** | Massive footgun surface (template injection vector). If someone needs a computed URL, they compute it in the operation handler. |

---
