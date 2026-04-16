/**
 * @delightfulchorus/service-catalog — schemas
 *
 * Zod schemas defining a ServiceDefinition: one JSON blob per supported
 * REST API (docs/research/04-integration-architecture.md §"Top-40").
 *
 * A service definition names:
 *   - How to authenticate (`authTypes`, one per credential shape the service supports)
 *   - The canonical base URL and doc URL
 *   - A curated list of `commonOperations` — the handful of endpoints users
 *     actually want, with method + path template
 *
 * The `universal-http` integration consumes these at runtime: given a
 * `serviceId + operationId + credential`, it builds and dispatches the call.
 *
 * Field names (`accessToken`, `apiKey`, etc.) are re-used from
 * `@delightfulchorus/core`'s CredentialField catalog so that a single
 * configure flow in the CLI/MCP works across every service.
 */
import { z } from "zod";
import {
  CredentialFieldSchema,
  CredentialOAuth2FlowSchema,
} from "@delightfulchorus/core";

// ── Auth header format ──────────────────────────────────────────────────────

/**
 * How to inject the credential into an outgoing HTTP request.
 *
 * `format` is a template string with `{fieldName}` placeholders that resolve
 * against the decrypted credential. Examples:
 *   - `{ name: "Authorization", format: "Bearer {accessToken}" }` — GitHub PAT
 *   - `{ name: "x-api-key",    format: "{apiKey}" }`              — Anthropic
 *   - `{ name: "Authorization", format: "Basic {base64:username:password}" }` — Basic auth
 *
 * The `{base64:a:b}` pseudo-placeholder is a magic helper for Basic auth —
 * universal-http detects this form and base64-encodes the colon-joined pair.
 */
export const AuthHeaderSchema = z.object({
  /** Header name (case-insensitive, preserved). E.g. "Authorization". */
  name: z.string().min(1).max(64),
  /**
   * Template string. `{fieldName}` is replaced with the matching credential
   * field. Leaving `{}` empty (no braces) means "use this string verbatim".
   */
  format: z.string().min(1).max(256),
});

export type AuthHeader = z.infer<typeof AuthHeaderSchema>;

// ── Auth-type entry (one per credential shape the service accepts) ──────────

/**
 * A single way to authenticate with a service. Most services ship two:
 *   - A quick-start PAT / API key (bearer or x-api-key header)
 *   - A full OAuth2 flow for end-user apps
 *
 * Re-uses `CredentialFieldSchema` + `CredentialOAuth2FlowSchema` from core
 * so the CLI's credential-add flow works identically whether the credential
 * lives in a native integration (slack-send) or a catalog entry (notion).
 */
export const AuthTypeEntrySchema = z
  .object({
    /**
     * Globally unique credential-type ID, kebab-case-ish. This shows up in
     * the CLI credential picker ("pick your auth type for github: githubPAT |
     * githubOAuth").
     */
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).min(2).max(48),

    /** Human label: "GitHub Personal Access Token" / "GitHub OAuth 2.0 App" */
    displayName: z.string().min(1).max(80),

    /** Which of the 4 underlying auth envelopes this is. */
    authType: z.enum(["apiKey", "oauth2", "basic", "bearer"]),

    /**
     * Field list the user fills in (or OAuth populates). For OAuth2 at least
     * `accessToken` + `refreshToken` should be marked oauthManaged:true so the
     * CLI knows not to prompt.
     */
    fields: z.array(CredentialFieldSchema).default([]),

    /**
     * How to inject this credential into requests. Omit ONLY for OAuth2
     * types where the universal-http runtime defaults to
     * `Authorization: Bearer {accessToken}` — any service with a different
     * header shape (e.g. x-api-key) MUST declare this explicitly.
     */
    authHeader: AuthHeaderSchema.optional(),

    /** OAuth flow metadata. REQUIRED when authType === "oauth2". */
    oauth: CredentialOAuth2FlowSchema.optional(),

    /** Where the user goes to get this credential (PAT creation, app registration, etc.) */
    documentationUrl: z.string().url(),

    /**
     * Deep-link to the specific page to create THIS credential
     * (e.g. "https://github.com/settings/tokens/new"). Rendered inline by the
     * CLI prompt.
     */
    deepLink: z.string().url().optional(),

    /**
     * A known-read-only endpoint the runtime can call to validate the
     * credential. E.g. GitHub `/user`, Notion `/v1/users/me`.
     */
    test: z
      .object({
        method: z.enum(["GET", "HEAD"]).default("GET"),
        path: z.string().startsWith("/"),
      })
      .optional(),
  })
  .refine(
    (entry) => entry.authType !== "oauth2" || entry.oauth !== undefined,
    { message: "oauth metadata is required when authType === 'oauth2'" },
  )
  .refine(
    (entry) => entry.authType !== "oauth2" || entry.authHeader !== undefined ||
      entry.fields.some((f) => f.name === "accessToken"),
    {
      message:
        "oauth2 entries must either declare an authHeader or provide an 'accessToken' field so universal-http can emit Authorization: Bearer {accessToken}",
    },
  );

export type AuthTypeEntry = z.infer<typeof AuthTypeEntrySchema>;

// ── Operation entry (per-endpoint declaration) ──────────────────────────────

/**
 * An operation is one endpoint + method + content-type. Path templates use
 * `{param}` placeholders that the universal-http handler fills in from the
 * caller's `pathParams` input map.
 */
export const HttpMethodEnum = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const OperationEntrySchema = z.object({
  /**
   * Kebab-case operation ID ("create-issue", "list-messages"). Stable
   * across catalog revisions — renaming breaks existing workflows.
   */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).min(2).max(64),

  /** Human label: "Create Issue", "List Messages". */
  displayName: z.string().min(1).max(80),

  /** HTTP method. Only the five meaningful ones — no OPTIONS / HEAD / TRACE. */
  method: HttpMethodEnum,

  /**
   * Path template, either (a) relative to the service's `baseUrl` (must
   * start with "/"), or (b) an absolute URL ("https://..."). Absolute URLs
   * are useful when a single service has endpoints on multiple hosts —
   * e.g. Basecamp's /authorization.json lives on launchpad.37signals.com
   * while everything else lives on 3.basecampapi.com.
   * Supports `{name}` placeholders resolved from the caller's `pathParams` input.
   */
  path: z.string().refine(
    (p) => p.startsWith("/") || /^https?:\/\//.test(p),
    { message: "path must start with '/' or be an absolute http(s):// URL" },
  ),

  /** What this op does. Shown in the workflow-builder picker. */
  description: z.string().min(1).max(500),

  /**
   * If the body is form-encoded rather than JSON. Defaults to
   * `application/json` when omitted.
   */
  bodyContentType: z
    .enum(["application/json", "application/x-www-form-urlencoded"])
    .optional(),

  /**
   * JSON Schema describing the expected `body` input. Informational —
   * the handler doesn't validate against this yet (just passes through).
   */
  inputSchema: z.record(z.unknown()).optional(),

  /** JSON Schema describing the expected response body. */
  outputSchema: z.record(z.unknown()).optional(),
});

export type OperationEntry = z.infer<typeof OperationEntrySchema>;

// ── Service definition (the root shape) ─────────────────────────────────────

export const ServiceDefinitionSchema = z.object({
  /**
   * Kebab-case stable ID. Globally unique within the catalog. "github",
   * "google-sheets", "google-drive". This is the ID users reference in
   * workflows and `universal-http.call` calls.
   */
  serviceId: z.string().regex(/^[a-z][a-z0-9-]*$/).min(2).max(64),

  /** Human-readable display name: "GitHub", "Google Sheets". */
  displayName: z.string().min(1).max(80),

  /** Link to the service's canonical API reference. */
  docsUrl: z.string().url(),

  /**
   * Base URL — prepended to every operation's path. Trailing slash is
   * optional; the handler normalizes.
   */
  baseUrl: z.string().url(),

  /**
   * Supported credential shapes. At least one entry required. Services with
   * both a PAT flow AND a full OAuth2 app ship TWO entries — the CLI lets
   * the user pick.
   */
  authTypes: z.array(AuthTypeEntrySchema).min(1),

  /**
   * Curated list of the most-used operations. Not exhaustive — users can
   * always fall back to universal-http's ad-hoc mode (method + path).
   * scout-november's brief: ≥3 operations per service.
   */
  commonOperations: z.array(OperationEntrySchema).min(1),
});

export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;

// Re-export core credential field schema for convenience.
export { CredentialFieldSchema, CredentialOAuth2FlowSchema };
