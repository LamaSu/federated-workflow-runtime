/**
 * Credential Catalog — typed credential-type definitions per integration.
 *
 * Design reference: `docs/CREDENTIALS_ANALYSIS.md` §4.
 *
 * These schemas let an integration declare, for each kind of credential it
 * accepts, exactly what fields to collect, how to validate them, where to
 * get docs, and (for OAuth 2.0) what the authorize/token endpoints are. The
 * CLI reads this metadata to prompt the user; `mcp-papa` reads it to render
 * MCP tool input schemas; the OAuth refresher reads it to know WHERE to
 * refresh.
 *
 * Nothing here changes the AES-256-GCM encryption envelope — it only changes
 * the shape of the plaintext JSON inside the envelope, and gives every piece
 * of the pipeline a structured description of that shape.
 *
 * IMPORTANT: `credentials-oscar` owns the canonical credential schema. The
 * `mcp-papa` and `events-quebec` agents MUST import credential types from
 * `@chorus/core` rather than redeclaring them.
 */
import { z } from "zod";

// ── Field (§4.1) ────────────────────────────────────────────────────────────

/**
 * A single credential field — e.g. "API Key", "Workspace URL", "Client ID".
 * Integration authors declare an array of these per credential type. The
 * CLI reads this list to prompt the user; `mcp-papa` reads it to render MCP
 * tool input schemas.
 */
export const CredentialFieldSchema = z.object({
  /** Machine-readable field name. Becomes the key in the encrypted payload JSON. */
  name: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid JS identifier"),

  /** Human-readable label shown in CLI prompts and MCP tool descriptions. */
  displayName: z.string().min(1).max(80),

  /** Type drives prompt masking (password/url), validation, and render hints. */
  type: z.enum([
    "string", // plain text, echoed
    "password", // masked in CLI, marked sensitive in MCP schemas
    "url", // validated as URL
    "number",
    "boolean",
    "select", // enum; must set `options`
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
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
      }),
    )
    .optional(),

  /** Regex validator. Applied as `new RegExp(pattern)` against the string form. */
  pattern: z.string().optional(),

  /** Character-length bounds (strings only). */
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),

  /**
   * OAuth-only: this field is populated by the OAuth callback, not by the
   * user. `oauthManaged: true` tells the CLI "don't ask; the OAuth flow
   * fills this in."
   */
  oauthManaged: z.boolean().default(false),
});

export type CredentialField = z.infer<typeof CredentialFieldSchema>;

// ── OAuth 2.0 flow metadata (§4.2) ──────────────────────────────────────────

/**
 * OAuth 2.0 authorize/token endpoints + the PKCE/scope policy for one
 * credential type. The runtime's refresher reads `tokenUrl` / `refreshUrl`
 * to know WHERE to refresh; the CLI reads `authorizeUrl` + `scopes` to
 * drive the browser authorize step.
 */
export const CredentialOAuth2FlowSchema = z.object({
  /** Provider authorize URL; users are redirected here to grant consent. */
  authorizeUrl: z.string().url(),

  /** Token exchange endpoint. Used by both initial code-for-token and refresh. */
  tokenUrl: z.string().url(),

  /** Optional: separate refresh URL if provider differs (rare). */
  refreshUrl: z.string().url().optional(),

  /** Scopes to request. Joined with spaces per RFC 6749. */
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

export type CredentialOAuth2Flow = z.infer<typeof CredentialOAuth2FlowSchema>;

// ── Test hook (§4.2) ────────────────────────────────────────────────────────

/**
 * How to validate a credential. Either names an existing integration
 * operation the runtime should invoke with safe inputs, OR leaves it to the
 * integration module's `testCredential` callable (see §4.4 / `types.ts`).
 */
export const CredentialTestDefinitionSchema = z.object({
  /**
   * Name of an operation in this integration's `operations` array that the
   * runtime should invoke (with fixed, safe inputs) to validate the
   * credential. Alternatively, the integration may export a separate
   * `testCredential()` function on its IntegrationModule — see §4.4.
   */
  viaOperation: z.string().optional(),

  /**
   * Human-readable description shown before the test runs
   * ("This will call GET /api/user on Slack — no messages will be sent.").
   */
  description: z.string().max(200).optional(),
});

export type CredentialTestDefinition = z.infer<
  typeof CredentialTestDefinitionSchema
>;

// ── Test result (§4.4) ──────────────────────────────────────────────────────

/**
 * Output of `IntegrationModule.testCredential` and/or the runtime's
 * operation-driven test path. The CLI renders this verbatim; `mcp-papa`
 * passes it straight through as the `__test_auth` tool's return value.
 *
 * Zod schema provided so agents (and mcp-papa) can validate the shape.
 */
export const CredentialTestResultSchema = z.object({
  ok: z.boolean(),
  /** Wall-clock duration of the test call. */
  latencyMs: z.number().nonnegative(),
  /**
   * Optional identity echo — "you authenticated as workspace foo, user @bar".
   * Displayed by the CLI so the user can sanity-check the token.
   */
  identity: z
    .object({
      userId: z.string().optional(),
      userName: z.string().optional(),
      workspaceName: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
  /** Human-readable failure message. Only present when ok === false. */
  error: z.string().optional(),
  /**
   * Machine-readable failure code. Uses the same vocabulary as
   * IntegrationError — examples: "AUTH_INVALID", "AUTH_EXPIRED",
   * "SCOPE_INSUFFICIENT", "NETWORK_ERROR".
   */
  errorCode: z.string().optional(),
});

export type CredentialTestResult = z.infer<typeof CredentialTestResultSchema>;

// ── Credential type definition (§4.2) ───────────────────────────────────────

/**
 * A full credential-type declaration. One integration may declare several
 * (e.g., Slack: bot token OAuth vs legacy user token).
 *
 * Consumers:
 * - CLI: uses `fields` for prompts, `documentationUrl` for the `pat-help`
 *   subcommand, `test` to validate.
 * - `mcp-papa`: emits `<integration>__configure_<typeName>` tools whose
 *   input JSON-schema comes from `fields[]`.
 * - Runtime: the OAuthRefresher uses `oauth.tokenUrl` to know where to
 *   refresh; the credential resolver uses this to normalize decrypted
 *   blobs before handing them to operation handlers.
 */
export const CredentialTypeDefinitionSchema = z
  .object({
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

    /**
     * Validation hook: either invoke an existing operation, or use
     * IntegrationModule.testCredential.
     */
    test: CredentialTestDefinitionSchema.optional(),
  })
  .refine(
    (def) => def.authType !== "oauth2" || def.oauth !== undefined,
    { message: "oauth metadata is required when authType === 'oauth2'" },
  );

export type CredentialTypeDefinition = z.infer<
  typeof CredentialTypeDefinitionSchema
>;

// ── Resolution helpers ──────────────────────────────────────────────────────

/**
 * Synthesize the default credential-type name used in DB backfill during
 * migration. Rows written before the catalog existed use
 * `<integration>:legacy` so the runtime can still resolve them.
 */
export function legacyCredentialTypeName(integration: string): string {
  return `${integration}:legacy`;
}

/**
 * Given an integration's credentialTypes catalog and a credential row's
 * (credentialTypeName, authType), return the matching CredentialTypeDefinition.
 *
 * Resolution per §5.2:
 *   1. Exact match on `name` → return it.
 *   2. Legacy row (`name` is blank or the synthesized legacy name) → return
 *      the first entry whose `authType` matches.
 *   3. No match → undefined (caller decides whether to throw).
 */
export function resolveCredentialType(
  catalog: readonly CredentialTypeDefinition[],
  rowCredentialTypeName: string,
  rowAuthType: "none" | "apiKey" | "oauth2" | "basic" | "bearer",
): CredentialTypeDefinition | undefined {
  if (catalog.length === 0) return undefined;
  // (1) exact match
  const exact = catalog.find((c) => c.name === rowCredentialTypeName);
  if (exact) return exact;
  // (2) legacy fallback: empty name or `<integration>:legacy` pattern →
  //     match by authType. The legacy-name convention is defensive — any
  //     name that doesn't exist in the catalog falls through the same way.
  const byAuth = catalog.find((c) => c.authType === rowAuthType);
  return byAuth;
}
