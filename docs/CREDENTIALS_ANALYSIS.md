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

## 4. Upgrade design — concrete schema additions

All new types live in `packages\core\src\schemas.ts` alongside the existing schemas. `credentials-oscar`: copy these verbatim, then add the corresponding `z.infer` exports in `packages\core\src\types.ts`.

### 4.1 New: `CredentialFieldSchema` (field declarations)

A single credential field — "API Key", "Workspace URL", "Client ID", etc. Integration authors declare an array of these per credential type. The CLI reads this list to prompt the user; `mcp-papa` reads it to render MCP tool input schemas.

```typescript
export const CredentialFieldSchema = z.object({
  /** Machine-readable field name. Becomes the key in the encrypted payload JSON. */
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid JS identifier"),

  /** Human-readable label shown in CLI prompts and MCP tool descriptions. */
  displayName: z.string().min(1).max(80),

  /** Type drives prompt masking (password/url), validation, and render hints. */
  type: z.enum([
    "string",      // plain text, echoed
    "password",    // masked in CLI, marked sensitive in MCP schemas
    "url",         // validated as URL
    "number",
    "boolean",
    "select",      // enum; must set `options`
  ]),

  /** Required fields error out if not supplied. */
  required: z.boolean().default(true),

  /** CLI uses this for prompt subtitle and MCP uses it for tool description text. */
  description: z.string().max(500).optional(),

  /** Optional link rendered inline: "Get your token at <deepLink>". */
  deepLink: z.string().url().optional(),

  /** Default value (plaintext). Use sparingly; never for secrets. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),

  /** Enum members when type === "select". */
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),

  /** Regex validator. Applied as `new RegExp(pattern)` against the string form. */
  pattern: z.string().optional(),

  /** Character-length bounds (strings only). */
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),

  /** OAuth-only: this field is populated by the OAuth callback, not by the user. */
  oauthManaged: z.boolean().default(false),
});

export type CredentialField = z.infer<typeof CredentialFieldSchema>;
```

**`oauthManaged` note:** for OAuth 2.0 credential types, fields like `accessToken` / `refreshToken` / `tokenExpiresAt` are set by the authorize-code-exchange step, never prompted. `oauthManaged: true` tells the CLI "don't ask; the OAuth flow fills this in."

### 4.2 New: `CredentialTypeDefinitionSchema` (per-integration credential type)

A full credential-type declaration. One integration may declare several (e.g., Slack: bot token OAuth vs legacy user token).

```typescript
export const CredentialOAuth2FlowSchema = z.object({
  /** Provider authorize URL; users are redirected here to grant consent. */
  authorizeUrl: z.string().url(),

  /** Token exchange endpoint. Used by both initial code-for-token and refresh. */
  tokenUrl: z.string().url(),

  /** Optional: separate refresh URL if provider differs (rare). */
  refreshUrl: z.string().url().optional(),

  /** Space-separated or array scopes to request. */
  scopes: z.array(z.string()).default([]),

  /** OAuth 2.0 PKCE (RFC 7636). Recommended true for public clients. */
  pkce: z.boolean().default(true),

  /** How to send credentials to the token endpoint. */
  clientAuthStyle: z.enum(["header", "body"]).default("header"),

  /** Local redirect path. Composed with the runtime's configured base URL. */
  redirectPath: z.string().startsWith("/").default("/oauth/callback"),

  /**
   * Optional extra query params for the authorize URL (e.g., `access_type=offline`
   * for Google, `prompt=consent` for forcing refresh-token emission).
   */
  authorizeQueryParams: z.record(z.string()).default({}),
});

export const CredentialTestDefinitionSchema = z.object({
  /**
   * Name of an operation in this integration's `operations` array that the
   * runtime should invoke (with fixed, safe inputs) to validate the credential.
   * Alternatively, the integration may export a separate `testCredential()`
   * function on its IntegrationModule — see §4.4.
   */
  viaOperation: z.string().optional(),

  /**
   * Human-readable description shown before the test runs
   * ("This will call GET /api/user on Slack — no messages will be sent.").
   */
  description: z.string().max(200).optional(),
});

export const CredentialTypeDefinitionSchema = z.object({
  /**
   * Stable, machine-readable name. Globally unique within the integration.
   * Examples: "slackOAuth2Bot", "slackUserToken", "githubPAT", "githubOAuth".
   * Stored in the DB as `credential_type_name` (see §5 migration).
   */
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),

  /** Human-readable label. "Slack Bot (OAuth 2.0)" vs "Slack User Token". */
  displayName: z.string().min(1).max(80),

  /** Which of the 5 underlying auth envelopes this is. Maps to existing `authType`. */
  authType: z.enum(["none", "apiKey", "oauth2", "basic", "bearer"]),

  /** Field list. Users fill these in via CLI or OAuth flow populates them. */
  fields: z.array(CredentialFieldSchema).default([]),

  /**
   * OAuth flow metadata. Required iff authType === "oauth2".
   * The runtime's OAuthRefresher reads this to know WHERE to refresh.
   */
  oauth: CredentialOAuth2FlowSchema.optional(),

  /** Short description rendered in `chorus credentials add` picker. */
  description: z.string().max(500).optional(),

  /** Link to upstream docs ("how to create a PAT on this service"). */
  documentationUrl: z.string().url().optional(),

  /** Validation hook: either invoke an existing operation, or use IntegrationModule.testCredential. */
  test: CredentialTestDefinitionSchema.optional(),
}).refine(
  (def) => def.authType !== "oauth2" || def.oauth !== undefined,
  { message: "oauth metadata is required when authType === 'oauth2'" },
);

export type CredentialTypeDefinition = z.infer<typeof CredentialTypeDefinitionSchema>;
export type CredentialOAuth2Flow = z.infer<typeof CredentialOAuth2FlowSchema>;
```

**Design note:** `authType` stays a top-level field on `CredentialTypeDefinition` (rather than being inferred from `oauth` presence) because it's load-bearing for three downstream consumers: the OAuthRefresher (only scans `type='oauth2'` rows), `mcp-papa` (decides whether to expose an `__authenticate` tool), and the storage layer (the existing SQLite column). Keep it explicit.

### 4.3 Extend: `IntegrationManifestSchema`

Add `credentialTypes` — an optional list. Integrations that declare `authType: "none"` may omit it. Everyone else should ship at least one type definition.

```typescript
export const IntegrationManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  /**
   * @deprecated in favor of credentialTypes[0].authType. Kept for v1.x back-compat
   * — existing integrations won't recompile. New integrations should declare
   * credentialTypes and ignore the top-level authType (set it to match the first
   * credentialType's authType).
   */
  authType: z.enum(["none", "apiKey", "oauth2", "basic", "bearer"]),

  /**
   * Per-integration credential type catalog. Most integrations declare ONE;
   * Slack-like integrations with multiple auth options declare several.
   * When omitted, the runtime synthesizes a single anonymous type matching
   * the legacy `authType` so old integrations keep working.
   */
  credentialTypes: z.array(CredentialTypeDefinitionSchema).default([]),

  operations: z.array(OperationDefinitionSchema),
  baseUrl: z.string().optional(),
  docsUrl: z.string().optional(),
}).refine(
  (m) =>
    m.credentialTypes.length === 0 ||
    m.credentialTypes.every((ct) => ct.authType === "none") ||
    m.credentialTypes.some((ct) => ct.authType === m.authType),
  { message: "manifest.authType must match at least one declared credentialType" },
);
```

**The two new field names `credentials-oscar` ships on `IntegrationManifest`:** `credentialTypes` (plural, array). That's it. `authType` already exists and stays (deprecated, not removed).

### 4.4 New: `IntegrationModule.testCredential`

Integrations that want a test step that isn't a regular operation (e.g., they want to skip rate-limit accounting or use a dedicated `/me` endpoint) can implement `testCredential` directly on the module.

```typescript
// packages/core/src/types.ts

export interface CredentialTestResult {
  ok: boolean;
  /** Wall-clock duration of the test call. */
  latencyMs: number;
  /**
   * Optional identity echo — "you authenticated as workspace foo, user @bar".
   * Displayed by the CLI so the user can sanity-check the token.
   */
  identity?: {
    userId?: string;
    userName?: string;
    workspaceName?: string;
    scopes?: string[];
  };
  /** Human-readable failure message. Only present when ok === false. */
  error?: string;
  /**
   * Machine-readable failure code. Uses the same vocabulary as IntegrationError.
   * Examples: "AUTH_INVALID", "AUTH_EXPIRED", "SCOPE_INSUFFICIENT", "NETWORK_ERROR".
   */
  errorCode?: string;
}

export interface IntegrationModule {
  manifest: IntegrationManifest;
  operations: Record<string, OperationHandler>;

  /**
   * Validate that a stored credential still works. Called by
   * `chorus credentials test <id>` and by the CLI after `chorus credentials add`
   * when the credential type has a `test:` declaration.
   *
   * The runtime decrypts the credential and hands it through ctx.credentials
   * exactly as it does for operations. Implementations should NOT mutate state
   * on the target service — pick a GET/introspection endpoint.
   */
  testCredential?: (
    credentialTypeName: string,
    ctx: OperationContext,
  ) => Promise<CredentialTestResult>;
}
```

**Resolution precedence** (spelled out so `credentials-oscar` doesn't have to reverse-engineer it):
1. If the credential type has `test.viaOperation`, the runtime invokes that operation with empty or minimal input.
2. Else if `IntegrationModule.testCredential` exists, the runtime calls it.
3. Else the CLI prints "no test available for this credential type; credential saved unchecked" and exits 0.

### 4.5 New: OAuth flow metadata — plumbing into the refresher

`CredentialOAuth2FlowSchema` already declared in §4.2. Here is the refresher contract change.

Today `OAuthRefresher` takes a caller-supplied `refresh: RefreshFn`. After this upgrade, the refresher gains a **default** implementation that consults the integration's `oauth` metadata and does a standard RFC 6749 §6 refresh-token grant. Callers can still override with a bespoke `refresh` for integrations whose refresh deviates (e.g., Shopify's session-token renewal).

```typescript
// packages/runtime/src/oauth.ts — additions, not replacements

export interface OAuthRefreshContext {
  /** Decrypted payload (parsed JSON). Shape: { accessToken, refreshToken, ... }. */
  credentials: Record<string, unknown>;
  /** Resolved CredentialTypeDefinition for this credential row. */
  type: CredentialTypeDefinition;
  /** AbortSignal wired to the cron tick. */
  signal: AbortSignal;
}

/**
 * Generic OAuth 2.0 refresh-token grant. Works for any provider that follows
 * RFC 6749 §6 ("grant_type=refresh_token"). The runtime picks this when an
 * integration has not supplied a custom refresh function.
 */
export async function defaultOAuth2Refresh(
  cred: CredentialRow,
  type: CredentialTypeDefinition,
  decryptedPayload: Record<string, unknown>,
): Promise<RefreshedToken> {
  // reads type.oauth.tokenUrl + type.oauth.clientAuthStyle, posts grant_type=refresh_token,
  // returns { newPayload: JSON.stringify({...existing, accessToken, refreshToken?, ...}),
  //           accessTokenExpiresAt: ISO }
  // ... implementation in credentials-oscar's Wave 2 work
}
```

**What `credentials-oscar` must wire:**

1. `OAuthRefresher.tick()` (line 100 of `oauth.ts`) currently calls `this.opts.refresh(cred)`. Change to: look up the credential's `credential_type_name` column (new, see §5) → find the `CredentialTypeDefinition` in the loaded integration's manifest → if it has `oauth` metadata, call `defaultOAuth2Refresh` unless a custom `refresh` was supplied.
2. No change needed to `OAuthRefresherOptions.refresh` signature — it stays as an override point.

### 4.6 Reuse: Credential storage stays the same

The AES-256-GCM encryption envelope does not change. `encryptCredential` / `decryptCredential` / `rotateKey` in `packages\runtime\src\credentials.ts` need zero modification.

**What does change:** the plaintext JSON inside the encrypted blob now has a well-known shape driven by `CredentialTypeDefinition.fields`. Today `slack-send` might store `"xoxb-foo..."` (raw string) OR `{"token": "xoxb-foo..."}` (object) — `extractBearerToken` has a 3-way fallback to cope. After §4.1 every field gets a canonical name; a Slack bot-token credential stores:

```json
{
  "accessToken": "xoxb-...",
  "refreshToken": "xoxe-...",
  "tokenExpiresAt": "2026-04-15T20:00:00Z",
  "teamId": "T0123",
  "botUserId": "U0123"
}
```

…because `slackOAuth2Bot.fields` declares `accessToken`, `refreshToken`, `tokenExpiresAt`, `teamId`, `botUserId` as its five fields (some `oauthManaged`, some read-only echo-back from token response). Integration handlers can simplify from a fallback cascade to `ctx.credentials.accessToken`.

**New DB column — renaming for clarity:**

| Current column | After upgrade | Reason |
|---|---|---|
| `type` (DB) | `type` (kept) | Alias for `authType`, legacy. |
| *(new)* | `credential_type_name` | FK-in-name-only to `IntegrationManifest.credentialTypes[].name`. Defaults to `<integration>:default` for pre-upgrade rows. |

And in `CredentialSchema` (the TS type):

```typescript
export const CredentialSchema = z.object({
  id: z.string(),
  integration: z.string(),

  /** NEW: which CredentialTypeDefinition in the integration this row is an instance of. */
  credentialTypeName: z.string(),

  /** Retained for back-compat and as a fast filter ("refresher only looks at oauth2"). */
  authType: z.enum(["none", "apiKey", "oauth2", "basic", "bearer"]),

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

Field rename: `type` → `authType` in the TS schema (NOT in the DB — the DB column stays `type` to avoid migration churn; the `fromRow` helper maps one to the other). This clears up the overload where `type` could mean either "auth envelope" or "credential type definition." `credentials-oscar`: update the 3 existing uses of `.type` in `packages/cli/src/commands/credentials.ts` to `.authType` and add the new `.credentialTypeName` field.

---

## 5. Migration plan (existing credentials)

Chorus v0 users (~nobody beyond the dogfooders, since npm package publication is roadmap item #2 and hasn't happened) still have rows in their SQLite where `credential_type_name` is absent. We make the migration painless.

### 5.1 SQLite migration (ALTER TABLE)

`credentials-oscar` adds a one-shot migration in `packages\runtime\src\db.ts` bumping the schema version:

```sql
ALTER TABLE credentials
  ADD COLUMN credential_type_name TEXT NOT NULL DEFAULT '';

-- Backfill: rows with blank credential_type_name belong to the synthesized
-- "legacy" credential type. Integrations that adopt credentialTypes[] will
-- auto-match against the first entry whose authType matches.
UPDATE credentials
   SET credential_type_name = integration || ':legacy'
 WHERE credential_type_name = '';

-- Index for fast lookup when the refresher resolves which OAuth flow to run.
CREATE INDEX IF NOT EXISTS idx_credentials_type_name
  ON credentials(integration, credential_type_name);
```

No blob rewrite. Plaintext shape doesn't change — integrations that adopted credential types will just see the same blob they already wrote, and integrations that haven't adopted keep seeing the free-form blob their handlers already cope with.

### 5.2 Runtime resolution algorithm

When the runtime loads a credential row for injection into `ctx.credentials`:

1. Look up the integration manifest. If no `credentialTypes[]`, treat the row as-is (legacy path).
2. Else find the entry where `name === row.credential_type_name`. If found → use its field list to normalize the decrypted blob.
3. Else (legacy row with empty type name) → find the first entry where `authType === row.authType`, treat it as the canonical type. Log once at INFO: `"legacy credential mapped to <typeName>; upgrade with 'chorus credentials migrate <id>'"`.

### 5.3 Manual migration CLI

```
chorus credentials migrate <id> --to <credentialTypeName>
```

Reassigns the row's `credential_type_name`. Optional; safe to never run — the auto-resolution at step 3 above is good enough for v1.x.

### 5.4 Integration-side compatibility

Integrations that haven't been updated to declare `credentialTypes[]` keep working unchanged. `IntegrationManifestSchema.credentialTypes` defaults to `[]`, and the refiner in §4.3 permits empty. The only hard break would be adding a `CredentialTypeDefinition` whose `name` is already saved in an existing row with a *conflicting* `authType` — unlikely, and caught by the refiner.

---

## 6. CLI changes for `credentials-oscar` to implement

All commands land in `packages\cli\src\commands\credentials.ts`. Keep the existing three (`add`, `list`, `remove`) working with their old signatures; add new flags and subcommands additively.

### 6.1 `chorus credentials add <integration> [--type <typeName>] [--interactive]`

New behavior:
- Load the integration module → read `manifest.credentialTypes`.
- If zero types: fallback to legacy `--secret | --payload | --interactive` path (existing code).
- If one type: use it.
- If 2+: require `--type <typeName>` unless `--interactive`, in which case prompt to pick from a list.
- With a selected type, iterate `type.fields`:
  - Skip `oauthManaged: true` fields (the OAuth flow will fill them in).
  - Skip fields with `type === "boolean"` and a default that isn't required.
  - For every other field:
    - Type `password` → masked prompt (existing `promptSecret`).
    - Type `url` / `string` / `number` / `select` → echoed prompt.
    - Validate against `pattern`, `minLength`, `maxLength`, `options`.
  - Collect into a `Record<string, string | number | boolean>`; JSON-encode; encrypt; store with `credential_type_name = type.name`.
- If `type.authType === "oauth2"`: after collecting `clientId` / `clientSecret` (the user-supplied half), kick off the OAuth authorize flow — open browser to `oauth.authorizeUrl`, spin up a localhost listener on `oauth.redirectPath`, exchange the code at `oauth.tokenUrl`, merge `accessToken` + `refreshToken` + `tokenExpiresAt` into the payload before encryption.
- If `type.test` exists or `IntegrationModule.testCredential` exists → run it, print PASS/FAIL with `identity` echoed. On FAIL: prompt "keep anyway? y/N", default N.

### 6.2 `chorus credentials test <id-or-integration:name>`

New subcommand. Resolves the row, decrypts, runs the test per §4.4's resolution precedence, prints:

```
✓ slack-send:default (slackOAuth2Bot) — 142ms
  authenticated as: LamaSu workspace, @chorus-bot
  scopes: chat:write,channels:read
```

or:

```
✗ github:personal (githubPAT) — 89ms
  error: AUTH_EXPIRED — token expired 2026-04-03
  hint: rotate token at https://github.com/settings/tokens
```

Exit code 0 on pass, 1 on fail. CI can wire `chorus credentials test --all` into health checks.

### 6.3 `chorus credentials pat-help <integration> [--type <typeName>]`

Opens the credential-type's `documentationUrl` (or the first field's `deepLink` if no type-level URL) in the default browser. Solves the "where do I get this PAT?" 3 AM confusion.

Windows: `start ""`. macOS: `open`. Linux: `xdg-open`. Same pattern Chorus already uses for `chorus ui --serve`.

### 6.4 `chorus credentials types [--integration <name>]`

New subcommand. Lists all declared credential types across loaded integrations. Used by users and by `mcp-papa` for discovery. JSON mode for agents.

```
$ chorus credentials types
slack-send
  slackOAuth2Bot     (oauth2)   Bot token via OAuth 2.0 [default]
  slackUserToken     (bearer)   Legacy user token
github
  githubPAT          (apiKey)   Personal access token
  githubOAuth        (oauth2)   OAuth 2.0 app flow
```

### 6.5 `chorus credentials migrate <id> --to <typeName>`

Per §5.3. Low-priority; defer until users hit the case.

### 6.6 What does NOT change

- `chorus credentials list` — unchanged output, unchanged flags. Just learns about the new column (shows `credentialTypeName` in `--json` mode).
- `chorus credentials remove` — unchanged.

---

## 7. `mcp-papa` interface contract

`mcp-papa` (Wave 2 sibling) exposes Chorus integrations as MCP tools. The credential catalog gives it everything it needs — and exactly enough structure that tool descriptions can be generated without handwritten templates.

### 7.1 What `mcp-papa` reads from the credential catalog

From each loaded `IntegrationManifest`:

| Data | Used for |
|---|---|
| `credentialTypes[].name` | Tool names: `<integration>__configure_<typeName>` |
| `credentialTypes[].displayName` + `description` | Human-readable tool description |
| `credentialTypes[].authType === "oauth2"` | Whether to expose an `<integration>__authenticate` tool that returns an authorize URL the user pastes into a browser |
| `credentialTypes[].fields` (minus `oauthManaged`) | Input JSON-schema of the `__configure_` tool — `fields[].name`, `fields[].type` map directly to JSON-schema `type` / `format: "password"` |
| `credentialTypes[].documentationUrl` | Tool description footer: "Docs: <url>" |
| `credentialTypes[].fields[].deepLink` | Inline in description: "Get this value at <deepLink>" |
| `CredentialTestResult` shape | Schema of the `<integration>__test_auth` tool's return |

### 7.2 Tools `mcp-papa` exposes per integration

For every integration with at least one `credentialType`:

1. **`<integration>__list_credentials`** — read-only, returns `[{id, name, credentialTypeName, authType, state}]`. No secrets.
2. **`<integration>__configure_<typeName>`** — set up a new credential. Input schema = JSON-schema of the type's `fields[]` minus `oauthManaged`. Server-side flow invokes the same logic as `chorus credentials add`.
3. **`<integration>__authenticate`** (OAuth types only) — starts the OAuth flow, returns `{authorizeUrl: string}`. User opens it, consents, Chorus runtime receives the callback, credential is saved. MCP tool returns `{ok: true, credentialId}` when the callback fires (polling-based; MCP server holds the tool call open until callback or timeout).
4. **`<integration>__test_auth`** — runs `testCredential()` for a given credential id. Input: `{credentialId: string}`. Output: `CredentialTestResult` as-is.

### 7.3 Explicit non-contract

`mcp-papa` does **not**:
- Call `encryptCredential` / `decryptCredential` directly — it goes through the runtime's credential accessor (which handles the encryption boundary).
- Ever return or log the encrypted blob or plaintext payload. Only `identity` echoes from `CredentialTestResult` are user-visible.
- Invoke any operation that mutates external state during `__test_auth`. If the integration's `test.viaOperation` points to a non-idempotent operation, `mcp-papa` refuses with a descriptive error ("integration wired a mutating op for credential test; fix the manifest").

### 7.4 Two-line summary of the contract

> `mcp-papa` needs `IntegrationManifest.credentialTypes: CredentialTypeDefinition[]` — that's it. Every tool name, input schema, description, deep-link, and test endpoint is derived mechanically from that array plus `IntegrationModule.testCredential`.

---


