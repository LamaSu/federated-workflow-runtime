import type {
  CredentialTypeDefinition,
  IntegrationManifest,
} from "@chorus/core";
import type { DatabaseType, CredentialRow } from "./db.js";
import { QueryHelpers } from "./db.js";
import {
  decryptCredential,
  encryptCredential,
} from "./credentials.js";

/**
 * OAuth token refresher per ARCHITECTURE §4.8.
 *
 * Scheduled background job — NOT failure-driven. Runs every `intervalMs`
 * (default 5 min) and looks for credentials whose access token expires
 * within `leadTimeMs` (default 10 min). For each credential, the
 * refresher picks a strategy (docs/CREDENTIALS_ANALYSIS.md §4.5):
 *
 *   1. A caller-supplied `refresh` callable wins (override point for
 *      integrations with a bespoke refresh shape, e.g. Shopify session-
 *      token renewal).
 *   2. Otherwise the refresher resolves the integration's
 *      CredentialTypeDefinition via `manifestLookup` and calls
 *      `defaultOAuth2Refresh` against `oauth.tokenUrl`. This is the
 *      standard RFC 6749 §6 refresh-token grant.
 *
 * Successful refreshes update the DB; failures mark the credential
 * invalid and surface via the optional `onError` hook.
 */

export const DEFAULT_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_LEAD_TIME_MS = 10 * 60_000;

export interface RefreshedToken {
  /** Fresh plaintext credential payload (JSON) to re-encrypt. */
  newPayload: string;
  /** ISO timestamp of new access token expiry, or null if unknown. */
  accessTokenExpiresAt: string | null;
}

export type RefreshFn = (cred: CredentialRow) => Promise<RefreshedToken>;

/**
 * Resolver: given a credential row's integration name, return the
 * matching IntegrationManifest (or undefined). Supplied by the caller;
 * typically backed by the runtime's IntegrationLoader. See
 * docs/CREDENTIALS_ANALYSIS.md §4.5.
 */
export type ManifestLookup = (
  integration: string,
) => IntegrationManifest | undefined;

export interface OAuthRefresherOptions {
  db: DatabaseType;
  /** 32-byte encryption key (see credentials.ts). */
  key: Buffer;
  /**
   * Per-integration refresh implementation. Runtime provides the WHEN;
   * you provide the HOW. When omitted, the refresher uses
   * `defaultOAuth2Refresh` against the matching
   * `CredentialTypeDefinition.oauth` metadata resolved via
   * `manifestLookup`. Bespoke integrations (e.g. Shopify's session-token
   * renewal) can override with a custom function.
   */
  refresh?: RefreshFn;
  /**
   * Resolve the integration manifest for a credential row. Required
   * when `refresh` is omitted so the default refresher can find the
   * OAuth `tokenUrl`. See docs/CREDENTIALS_ANALYSIS.md §4.5.
   */
  manifestLookup?: ManifestLookup;
  /**
   * Override the default HTTP transport used by `defaultOAuth2Refresh`.
   * Primarily for tests — production callers should leave this unset.
   */
  fetchFn?: typeof fetch;
  /** How often to scan for expiring credentials. Default 5 min. */
  intervalMs?: number;
  /** How far ahead of expiry to proactively refresh. Default 10 min. */
  leadTimeMs?: number;
  /** Override Date.now() — used by tests. */
  now?: () => Date;
  /** Override setInterval — used by tests. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Override clearInterval — used by tests. */
  clearIntervalFn?: (handle: unknown) => void;
  /** Optional callback invoked on refresh failures (for alerting hooks). */
  onError?: (cred: CredentialRow, err: Error) => void;
}

export class OAuthRefresher {
  private readonly helpers: QueryHelpers;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly leadTimeMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private handle: unknown | null = null;

  constructor(private readonly opts: OAuthRefresherOptions) {
    this.helpers = new QueryHelpers(opts.db);
    this.now = opts.now ?? (() => new Date());
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.leadTimeMs = opts.leadTimeMs ?? DEFAULT_LEAD_TIME_MS;
    this.setIntervalFn =
      opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn =
      opts.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }

  /**
   * Start the recurring job. Call once at server boot.
   */
  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalFn(() => {
      void this.tick().catch(() => {
        // Already logged per-cred in tick(); swallow here to keep loop alive.
      });
    }, this.intervalMs);
    // setInterval unref if possible so we don't keep Node alive.
    if (this.handle && typeof (this.handle as NodeJS.Timeout).unref === "function") {
      (this.handle as NodeJS.Timeout).unref();
    }
  }

  /**
   * Stop the recurring job. Idempotent.
   */
  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /**
   * One manual tick. Processes every credential expiring within the lead
   * time. Exposed so tests (and the CLI `chorus oauth refresh`) can trigger
   * a refresh without waiting for the next interval.
   *
   * Resolution order when refreshing one credential
   * (docs/CREDENTIALS_ANALYSIS.md §4.5):
   *   1. If `OAuthRefresherOptions.refresh` was provided, call it.
   *   2. Else, use `manifestLookup` to resolve the integration's
   *      CredentialTypeDefinition via `credential_type_name`, and hand
   *      off to `defaultOAuth2Refresh` against `oauth.tokenUrl`.
   *   3. Else throw — the credential is marked invalid with the error
   *      "no refresh strategy available".
   */
  async tick(): Promise<{ refreshed: number; failed: number }> {
    const now = this.now();
    const cutoff = new Date(now.getTime() + this.leadTimeMs).toISOString();
    const expiring = this.helpers.listExpiringOAuthCredentials(cutoff);
    let refreshed = 0;
    let failed = 0;
    for (const cred of expiring) {
      try {
        const result = await this.refreshOne(cred);
        const newBlob = encryptCredential(result.newPayload, this.opts.key);
        this.helpers.updateCredentialPayload(
          cred.id,
          newBlob,
          result.accessTokenExpiresAt,
          now.toISOString(),
        );
        refreshed++;
      } catch (err) {
        const e = err as Error;
        this.helpers.markCredentialInvalid(cred.id, e.message, now.toISOString());
        this.opts.onError?.(cred, e);
        failed++;
      }
    }
    return { refreshed, failed };
  }

  /**
   * Resolve the right refresh strategy for one credential row.
   * See the resolution order in `tick` docstring.
   */
  private async refreshOne(cred: CredentialRow): Promise<RefreshedToken> {
    if (this.opts.refresh) {
      return this.opts.refresh(cred);
    }
    if (!this.opts.manifestLookup) {
      throw new Error(
        "no refresh strategy: supply OAuthRefresherOptions.refresh or manifestLookup",
      );
    }
    const manifest = this.opts.manifestLookup(cred.integration);
    if (!manifest) {
      throw new Error(
        `no integration manifest for "${cred.integration}" — cannot refresh`,
      );
    }
    const type = resolveCatalogEntry(manifest, cred);
    if (!type) {
      throw new Error(
        `no credentialType matching "${cred.credential_type_name}" in ${cred.integration} manifest`,
      );
    }
    if (!type.oauth) {
      throw new Error(
        `credentialType "${type.name}" in ${cred.integration} has no oauth metadata`,
      );
    }
    const plaintext = decryptCredential(cred.encrypted_payload, this.opts.key);
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    return defaultOAuth2Refresh(cred, type, parsed, {
      fetchFn: this.opts.fetchFn,
    });
  }
}

/**
 * Convenience to start a refresher. Returns the (started) instance.
 */
export function startOAuthRefresher(
  opts: OAuthRefresherOptions,
): OAuthRefresher {
  const r = new OAuthRefresher(opts);
  r.start();
  return r;
}

// ── Catalog-driven default refresh (docs/CREDENTIALS_ANALYSIS.md §4.5) ──────

/**
 * Match a credential row against its integration's credentialTypes
 * catalog. Exact match on `credential_type_name` first; authType
 * fallback for legacy rows. Mirrors credential-catalog.resolveCredentialType
 * but takes the manifest directly (no array extraction needed).
 */
function resolveCatalogEntry(
  manifest: IntegrationManifest,
  cred: CredentialRow,
): CredentialTypeDefinition | undefined {
  const catalog = manifest.credentialTypes ?? [];
  if (catalog.length === 0) return undefined;
  const exact = catalog.find((c) => c.name === cred.credential_type_name);
  if (exact) return exact;
  // Legacy fallback: match authType. Both the DB `type` column and the
  // CredentialTypeDefinition.authType field use the same vocabulary.
  const authType = cred.type as CredentialTypeDefinition["authType"];
  return catalog.find((c) => c.authType === authType);
}

export interface DefaultOAuth2RefreshOptions {
  /** Override fetch — primarily for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Generic OAuth 2.0 refresh-token grant (RFC 6749 §6). Works for any
 * provider whose `oauth.tokenUrl` accepts `grant_type=refresh_token`
 * and returns a JSON body shaped
 * `{access_token, refresh_token?, expires_in?}`.
 *
 * Payload semantics:
 *  - Reads `refreshToken` (primary) or `refresh_token` (secondary) from
 *    the decrypted payload.
 *  - Reads `clientId` / `clientSecret` from the decrypted payload;
 *    callers can alternatively populate them via the credential-type
 *    `fields[]` when collecting credentials in the CLI.
 *  - Returns a fresh payload JSON string merging the new access_token /
 *    refresh_token / tokenExpiresAt into the previous payload,
 *    preserving other fields (teamId, botUserId, etc.).
 *
 * The returned `accessTokenExpiresAt` is an ISO timestamp. When the
 * provider omits `expires_in`, we return `null` and rely on the next
 * tick firing opportunistically when the credential expires again.
 */
export async function defaultOAuth2Refresh(
  cred: CredentialRow,
  type: CredentialTypeDefinition,
  decryptedPayload: Record<string, unknown>,
  opts: DefaultOAuth2RefreshOptions = {},
): Promise<RefreshedToken> {
  if (!type.oauth) {
    throw new Error(
      `defaultOAuth2Refresh: credentialType "${type.name}" has no oauth metadata`,
    );
  }
  const refreshUrl = type.oauth.refreshUrl ?? type.oauth.tokenUrl;
  const refreshToken =
    (decryptedPayload.refreshToken as string | undefined) ??
    (decryptedPayload.refresh_token as string | undefined);
  if (!refreshToken) {
    throw new Error(
      `credential ${cred.id} has no refreshToken in its decrypted payload`,
    );
  }
  const clientId = decryptedPayload.clientId as string | undefined;
  const clientSecret = decryptedPayload.clientSecret as string | undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);

  // RFC 6749: clients authenticate to the token endpoint either via
  // HTTP Basic (header) or by including credentials in the body. We
  // follow `type.oauth.clientAuthStyle` or default to header.
  const style = type.oauth.clientAuthStyle ?? "header";
  if (style === "header" && clientId && clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else if (clientId) {
    form.set("client_id", clientId);
    if (clientSecret) form.set("client_secret", clientSecret);
  }

  const fetchImpl = opts.fetchFn ?? fetch;
  const res = await fetchImpl(refreshUrl, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(
      `OAuth refresh failed (${res.status}) at ${refreshUrl}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error(
      `OAuth refresh ${refreshUrl}: response missing access_token`,
    );
  }
  // Compute expires_at from expires_in if provided.
  let accessTokenExpiresAt: string | null = null;
  if (typeof body.expires_in === "number" && body.expires_in > 0) {
    accessTokenExpiresAt = new Date(
      Date.now() + body.expires_in * 1000,
    ).toISOString();
  }
  const newPayload: Record<string, unknown> = {
    ...decryptedPayload,
    accessToken: body.access_token,
  };
  if (body.refresh_token) newPayload.refreshToken = body.refresh_token;
  if (accessTokenExpiresAt) newPayload.tokenExpiresAt = accessTokenExpiresAt;
  if (body.scope) newPayload.scope = body.scope;
  return {
    newPayload: JSON.stringify(newPayload),
    accessTokenExpiresAt,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
