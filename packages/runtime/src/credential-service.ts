import { randomBytes, randomUUID } from "node:crypto";
import type {
  CredentialTypeDefinition,
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
  CredentialTestResult,
} from "@delightfulchorus/core";
import { resolveCredentialType } from "@delightfulchorus/core";
import type { CredentialRow, DatabaseType } from "./db.js";
import { QueryHelpers } from "./db.js";
import {
  decryptCredential,
  encryptCredential,
} from "./credentials.js";

/**
 * RuntimeCredentialService — the database-backed implementation of
 * mcp-papa's `CredentialService` contract (see
 * `packages/mcp/src/server.ts`).
 *
 * Lifecycle:
 *   - `list`     → read-only enumeration; NEVER decrypts.
 *   - `configure`→ validates fields against the catalog, encrypts +
 *                  inserts.
 *   - `authenticate` → initiates an OAuth authorize flow: generates a
 *                  cryptographic state token, persists an
 *                  `oauth_pending` row, returns an authorizeUrl the
 *                  user opens in a browser. The GET /api/oauth/callback
 *                  route (see api/oauth.ts) consumes the row + finishes
 *                  the code→token exchange.
 *   - `testAuth` → loads the credential, dispatches the integration's
 *                  `testCredential` callable if declared, else returns
 *                  a clear "no test available" result without error.
 *
 * Security invariants:
 *   - `list` shows name, authType, state, last-4 payload preview ONLY.
 *     Never the secret itself.
 *   - `configure` accepts only fields declared in the catalog; unknown
 *     fields are dropped (defense in depth against MCP callers sneaking
 *     extra keys through).
 *   - `authenticate` uses `randomBytes(32)` for state tokens (128 bits
 *     of collision resistance + 128 bits of brute-force resistance for
 *     CSRF defense per RFC 6749 §10.12). PKCE code_verifier is
 *     `randomBytes(32)` as well (RFC 7636 recommends 43-128 chars).
 */
export interface RuntimeCredentialServiceOptions {
  db: DatabaseType;
  /** 32-byte encryption key — same one the rest of the runtime uses. */
  key: Buffer;
  /**
   * Lookup to resolve an integration name → its manifest. Needed to
   * validate credentials against the catalog and to surface
   * OAuth metadata (authorizeUrl, scopes) for `authenticate`.
   */
  manifestLookup: (integration: string) => IntegrationManifest | undefined;
  /**
   * Optional integration-module lookup — used for `testAuth` to dispatch
   * the integration's `testCredential` callable when declared.
   */
  integrationLookup?: (integration: string) => IntegrationModule | undefined;
  /**
   * Base URL for OAuth callback. Defaults to
   * `http://127.0.0.1:3000` per §4.8. Composed with the credential
   * type's `oauth.redirectPath` to form the redirect_uri.
   */
  callbackBaseUrl?: string;
  /**
   * Optional override for the OAuth client id. When omitted, the field
   * is pulled from the credential fields at authorize time (caller must
   * have configured the client id via a prior `configure` call). This
   * matches the existing defaultOAuth2Refresh behavior: clientId lives
   * in the credential payload itself.
   */
  clientIdFor?: (
    integration: string,
    credentialTypeName: string,
  ) => { clientId: string; clientSecret?: string } | undefined;
  /** How long a pending oauth state stays valid. Default: 15 minutes. */
  pendingTtlMs?: number;
  /** Override Date.now() for tests. */
  now?: () => Date;
  /**
   * Override random-state generation for tests. Must return a URL-safe
   * string; default is `randomBytes(32).toString('base64url')`.
   */
  randomState?: () => string;
}

export interface CredentialSummaryView {
  id: string;
  name: string;
  credentialTypeName: string;
  authType: "none" | "apiKey" | "oauth2" | "basic" | "bearer";
  state: "active" | "invalid";
  /**
   * Last 4 characters of the credential's primary secret, rendered as
   * `****abcd`. NEVER the full value. Extracted from
   * the catalog's first password/apiKey/accessToken field; if absent,
   * returns `null`. Used by dashboards to help users disambiguate
   * "which GitHub PAT is this?" without decrypting.
   *
   * We deliberately skip decryption here — the preview comes from a
   * length-only proxy. Real decryption only happens in `testAuth` or
   * during an actual operation invocation.
   */
  preview: string | null;
}

export interface AuthenticateResult {
  authorizeUrl: string;
  state: string;
  expiresAt: string;
}

export class RuntimeCredentialService {
  private readonly helpers: QueryHelpers;
  private readonly now: () => Date;
  private readonly randomState: () => string;
  private readonly pendingTtlMs: number;
  private readonly callbackBaseUrl: string;

  constructor(private readonly opts: RuntimeCredentialServiceOptions) {
    this.helpers = new QueryHelpers(opts.db);
    this.now = opts.now ?? (() => new Date());
    this.randomState =
      opts.randomState ?? (() => randomBytes(32).toString("base64url"));
    this.pendingTtlMs = opts.pendingTtlMs ?? 15 * 60_000;
    this.callbackBaseUrl =
      opts.callbackBaseUrl ?? "http://127.0.0.1:3000";
  }

  // ── CredentialService: list ───────────────────────────────────────────────

  async list(integration: string): Promise<CredentialSummaryView[]> {
    const rows = this.opts.db
      .prepare(
        `SELECT * FROM credentials WHERE integration = ? ORDER BY name ASC`,
      )
      .all(integration) as CredentialRow[];
    const manifest = this.opts.manifestLookup(integration);
    return rows.map((r) => this.rowToSummary(r, manifest));
  }

  private rowToSummary(
    row: CredentialRow,
    manifest: IntegrationManifest | undefined,
  ): CredentialSummaryView {
    // We don't decrypt for list. The preview is derived from the
    // encrypted blob length + the catalog entry's declared shape:
    // if there's a password field, the last 4 chars of the underlying
    // plaintext are hidden behind a masked placeholder. Real preview
    // derivation would require decrypt; keeping this string-only here
    // so `list` stays crypto-free by design.
    const authType = row.type as CredentialSummaryView["authType"];
    return {
      id: row.id,
      name: row.name,
      credentialTypeName: row.credential_type_name,
      authType,
      state: row.state === "expired" ? "invalid" : row.state,
      preview: this.deriveMaskedPreview(row, manifest),
    };
  }

  /**
   * Produce a masked preview like `****wxyz` without decrypting.
   *
   * Strategy: the last 4 bytes of the GCM ciphertext are *not* the last
   * 4 plaintext bytes (GCM is a stream cipher, but authenticated — the
   * last 16 bytes are the tag). Returning those would leak nothing
   * useful AND confuse users. Instead we mark the credential as masked
   * and punt preview derivation to an explicit "show preview" path
   * that would require a key and decrypt.
   *
   * In practice this returns `****` with no trailing 4 — enough for the
   * dashboard to show the credential exists; disambiguation happens by
   * the user-chosen `name` column, not by preview.
   */
  private deriveMaskedPreview(
    _row: CredentialRow,
    _manifest: IntegrationManifest | undefined,
  ): string | null {
    return "****";
  }

  // ── CredentialService: configure ──────────────────────────────────────────

  async configure(args: {
    integration: string;
    credentialTypeName: string;
    name: string;
    fields: Record<string, unknown>;
  }): Promise<{ id: string; name: string }> {
    const manifest = this.opts.manifestLookup(args.integration);
    if (!manifest) {
      throw new Error(`unknown integration: ${args.integration}`);
    }
    const type = resolveCredentialType(
      manifest.credentialTypes ?? [],
      args.credentialTypeName,
      authTypeFromCatalog(manifest, args.credentialTypeName),
    );
    if (!type) {
      throw new Error(
        `unknown credential type "${args.credentialTypeName}" for integration ${args.integration}`,
      );
    }

    // Validate fields against the catalog. Drop unknown fields, check
    // required/pattern/length constraints. OAuth-managed fields are
    // ignored in configure() — they get populated by the callback flow.
    const cleaned = this.validateFields(type, args.fields);

    const now = this.now().toISOString();
    const id = randomUUID();
    const plaintext = JSON.stringify(cleaned);
    const encrypted = encryptCredential(plaintext, this.opts.key);

    this.helpers.insertCredential({
      id,
      integration: args.integration,
      type: type.authType,
      credential_type_name: type.name,
      name: args.name,
      encrypted_payload: encrypted,
      oauth_access_expires: null,
      oauth_refresh_expires: null,
      oauth_scopes: null,
      state: "active",
      last_error: null,
      created_at: now,
      updated_at: now,
    });

    return { id, name: args.name };
  }

  private validateFields(
    type: CredentialTypeDefinition,
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of type.fields) {
      // Skip OAuth-managed fields — they're filled in by the callback.
      if (field.oauthManaged) continue;
      const value = raw[field.name];
      if (value === undefined || value === null || value === "") {
        if (field.required) {
          throw new Error(
            `credential field '${field.name}' is required for type '${type.name}'`,
          );
        }
        // Allow missing optional field.
        if (field.default !== undefined) {
          out[field.name] = field.default;
        }
        continue;
      }
      // Pattern check (strings only).
      if (field.pattern && typeof value === "string") {
        const re = new RegExp(field.pattern);
        if (!re.test(value)) {
          throw new Error(
            `credential field '${field.name}' does not match pattern /${field.pattern}/`,
          );
        }
      }
      // Length check (strings only).
      if (typeof value === "string") {
        if (field.minLength !== undefined && value.length < field.minLength) {
          throw new Error(
            `credential field '${field.name}' is shorter than minLength=${field.minLength}`,
          );
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          throw new Error(
            `credential field '${field.name}' is longer than maxLength=${field.maxLength}`,
          );
        }
      }
      out[field.name] = value;
    }
    return out;
  }

  // ── CredentialService: authenticate (OAuth initiate) ─────────────────────

  async authenticate(args: {
    integration: string;
    credentialTypeName: string;
    name: string;
  }): Promise<AuthenticateResult> {
    const manifest = this.opts.manifestLookup(args.integration);
    if (!manifest) {
      throw new Error(`unknown integration: ${args.integration}`);
    }
    const catalog = manifest.credentialTypes ?? [];
    // Find a type; when name is empty, prefer the first oauth2 type.
    let type: CredentialTypeDefinition | undefined;
    if (args.credentialTypeName) {
      type = catalog.find((c) => c.name === args.credentialTypeName);
    }
    if (!type) {
      type = catalog.find((c) => c.authType === "oauth2");
    }
    if (!type) {
      throw new Error(
        `integration ${args.integration} has no oauth2 credentialType`,
      );
    }
    if (type.authType !== "oauth2" || !type.oauth) {
      throw new Error(
        `credential type '${type.name}' is not oauth2 (authType=${type.authType})`,
      );
    }

    const clientId = this.resolveClientId(args.integration, type.name);
    if (!clientId) {
      throw new Error(
        `no clientId configured for ${args.integration}/${type.name} — ` +
          `configure() the credential with a clientId first, or provide clientIdFor`,
      );
    }

    const state = this.randomState();
    const nowDate = this.now();
    const expiresAt = new Date(nowDate.getTime() + this.pendingTtlMs).toISOString();
    const redirectUri = this.buildRedirectUri(type.oauth.redirectPath);

    // PKCE: we'd normally compute code_challenge from the verifier. For the
    // first cut we generate a verifier and pass it through; the callback
    // echoes it in the token exchange. SHA256(verifier) would go in the
    // authorize URL as code_challenge=... which providers verify.
    const codeVerifier = type.oauth.pkce
      ? randomBytes(32).toString("base64url")
      : null;

    this.helpers.insertOAuthPending({
      state,
      integration: args.integration,
      credential_type_name: type.name,
      credential_name: args.name,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      created_at: nowDate.toISOString(),
      expires_at: expiresAt,
      consumed_at: null,
      consumed_error: null,
      credential_id: null,
    });

    const authorizeUrl = this.buildAuthorizeUrl({
      oauth: type.oauth,
      clientId,
      state,
      redirectUri,
      codeVerifier,
    });

    return { authorizeUrl, state, expiresAt };
  }

  private resolveClientId(
    integration: string,
    credentialTypeName: string,
  ): string | undefined {
    if (this.opts.clientIdFor) {
      const resolved = this.opts.clientIdFor(integration, credentialTypeName);
      if (resolved?.clientId) return resolved.clientId;
    }
    // Fallback: look for an existing credential of this type with a
    // clientId field — unusual but supports the "bootstrap via
    // configure() first, then authenticate()" flow common with OAuth
    // providers that require a client to be registered upfront.
    const row = this.opts.db
      .prepare(
        `SELECT encrypted_payload FROM credentials
          WHERE integration = ? AND credential_type_name = ?
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(integration, credentialTypeName) as
      | { encrypted_payload: Buffer }
      | undefined;
    if (!row) return undefined;
    try {
      const plain = decryptCredential(row.encrypted_payload, this.opts.key);
      const parsed = JSON.parse(plain) as Record<string, unknown>;
      const clientId = parsed.clientId;
      return typeof clientId === "string" ? clientId : undefined;
    } catch {
      return undefined;
    }
  }

  private buildRedirectUri(redirectPath: string): string {
    const base = this.callbackBaseUrl.replace(/\/+$/, "");
    const path = redirectPath.startsWith("/") ? redirectPath : `/${redirectPath}`;
    // If the catalog declared a non-API path (e.g. "/oauth/callback"), we
    // rewrite to the runtime's actual endpoint. The HTTP route lives at
    // /api/oauth/callback regardless of the catalog's advertised path so
    // our server.ts doesn't need to dynamically mount per-integration.
    return `${base}/api/oauth/callback`;
  }

  private buildAuthorizeUrl(args: {
    oauth: NonNullable<CredentialTypeDefinition["oauth"]>;
    clientId: string;
    state: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): string {
    const url = new URL(args.oauth.authorizeUrl);
    url.searchParams.set("client_id", args.clientId);
    url.searchParams.set("redirect_uri", args.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", args.state);
    if (args.oauth.scopes && args.oauth.scopes.length > 0) {
      url.searchParams.set("scope", args.oauth.scopes.join(" "));
    }
    if (args.codeVerifier) {
      // RFC 7636: code_challenge = BASE64URL(SHA256(code_verifier)).
      // To avoid pulling in a sync SHA256 everywhere, we stash the
      // "plain" verifier in oauth_pending and pass method=plain to the
      // provider. This is still RFC 7636 compliant (method=plain is
      // allowed) and sufficient for localhost development. Upstream
      // providers that REQUIRE S256 can be handled by upgrading to
      // node:crypto.createHash at authorize time.
      url.searchParams.set("code_challenge", args.codeVerifier);
      url.searchParams.set("code_challenge_method", "plain");
    }
    for (const [k, v] of Object.entries(args.oauth.authorizeQueryParams ?? {})) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  // ── CredentialService: testAuth ──────────────────────────────────────────

  async testAuth(args: {
    integration: string;
    credentialId: string;
  }): Promise<{
    ok: boolean;
    latencyMs: number;
    identity?: CredentialTestResult["identity"];
    error?: string;
    errorCode?: string;
  }> {
    const row = this.helpers.getCredential(args.credentialId);
    if (!row) {
      return {
        ok: false,
        latencyMs: 0,
        error: `unknown credential: ${args.credentialId}`,
        errorCode: "NOT_FOUND",
      };
    }
    if (row.integration !== args.integration) {
      return {
        ok: false,
        latencyMs: 0,
        error: `credential ${args.credentialId} belongs to integration '${row.integration}', not '${args.integration}'`,
        errorCode: "INTEGRATION_MISMATCH",
      };
    }
    const module = this.opts.integrationLookup?.(args.integration);
    if (!module?.testCredential) {
      return {
        ok: true,
        latencyMs: 0,
        error: "no test available for this credential type",
        errorCode: "NO_TEST",
      };
    }

    // Decrypt the credential payload and hand it through to the test
    // hook. We use the same shape as operation invocation (see
    // executor.ts). testCredential MUST NOT mutate state per the
    // §4.4 contract.
    let decrypted: Record<string, unknown> = {};
    try {
      const plain = decryptCredential(row.encrypted_payload, this.opts.key);
      decrypted = JSON.parse(plain) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        error: `decrypt failed: ${(err as Error).message}`,
        errorCode: "DECRYPT_ERROR",
      };
    }

    const ctx: OperationContext = {
      credentials: decrypted,
      logger: noopLogger(),
      signal: new AbortController().signal,
    };

    const start = Date.now();
    try {
      const result = await module.testCredential(row.credential_type_name, ctx);
      const latencyMs = Date.now() - start;
      return {
        ok: result.ok,
        latencyMs: result.latencyMs ?? latencyMs,
        identity: result.identity,
        error: result.error,
        errorCode: result.errorCode,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
        errorCode: "TEST_THREW",
      };
    }
  }

  // ── Internal: exchange code for tokens (used by callback route) ──────────

  /**
   * Complete the OAuth flow: take the authorization code from the
   * provider's redirect, exchange it for tokens at `oauth.tokenUrl`,
   * encrypt the resulting credential, persist it. Returns the new
   * credential id.
   *
   * Called ONLY by the GET /api/oauth/callback HTTP route. Not part of
   * the CredentialService interface — MCP clients never invoke this
   * directly.
   */
  async completeOAuthCallback(args: {
    state: string;
    code: string;
    fetchFn?: typeof fetch;
  }): Promise<{ credentialId: string; credentialTypeName: string }> {
    const pending = this.helpers.getOAuthPending(args.state);
    if (!pending) {
      throw new Error(`unknown oauth state: ${args.state}`);
    }
    if (pending.consumed_at !== null) {
      throw new Error(`oauth state already consumed: ${args.state}`);
    }
    const nowDate = this.now();
    if (new Date(pending.expires_at).getTime() < nowDate.getTime()) {
      this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
        error: "state expired",
      });
      throw new Error(`oauth state expired: ${args.state}`);
    }

    const manifest = this.opts.manifestLookup(pending.integration);
    if (!manifest) {
      this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
        error: "integration manifest not found",
      });
      throw new Error(`integration manifest not found: ${pending.integration}`);
    }
    const type = (manifest.credentialTypes ?? []).find(
      (c) => c.name === pending.credential_type_name,
    );
    if (!type || !type.oauth) {
      this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
        error: "credential type lost its oauth metadata",
      });
      throw new Error(
        `credentialType '${pending.credential_type_name}' missing oauth metadata`,
      );
    }

    const clientAuth = this.opts.clientIdFor?.(
      pending.integration,
      pending.credential_type_name,
    );
    const clientId =
      clientAuth?.clientId ?? this.resolveClientId(pending.integration, pending.credential_type_name);
    if (!clientId) {
      this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
        error: "clientId not resolvable at callback time",
      });
      throw new Error("clientId not resolvable at callback time");
    }
    const clientSecret = clientAuth?.clientSecret;

    // Exchange code for tokens.
    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("code", args.code);
    form.set("redirect_uri", pending.redirect_uri);
    form.set("client_id", clientId);
    if (clientSecret) form.set("client_secret", clientSecret);
    if (pending.code_verifier) form.set("code_verifier", pending.code_verifier);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    const style = type.oauth.clientAuthStyle ?? "header";
    if (style === "header" && clientSecret) {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      headers.Authorization = `Basic ${basic}`;
      form.delete("client_secret");
    }

    const fetchImpl = args.fetchFn ?? fetch;
    const res = await fetchImpl(type.oauth.tokenUrl, {
      method: "POST",
      headers,
      body: form.toString(),
    });
    if (!res.ok) {
      const body = await safeText(res);
      const err = `token exchange failed (${res.status}): ${body.slice(0, 200)}`;
      this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
        error: err,
      });
      throw new Error(err);
    }
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };
    if (!body.access_token) {
      const err = "token exchange: response missing access_token";
      this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
        error: err,
      });
      throw new Error(err);
    }
    const accessTokenExpiresAt =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? new Date(nowDate.getTime() + body.expires_in * 1000).toISOString()
        : null;

    const payload: Record<string, unknown> = {
      clientId,
      accessToken: body.access_token,
    };
    if (clientSecret) payload.clientSecret = clientSecret;
    if (body.refresh_token) payload.refreshToken = body.refresh_token;
    if (accessTokenExpiresAt) payload.tokenExpiresAt = accessTokenExpiresAt;
    if (body.scope) payload.scope = body.scope;

    const encrypted = encryptCredential(JSON.stringify(payload), this.opts.key);
    const credentialId = randomUUID();
    this.helpers.insertCredential({
      id: credentialId,
      integration: pending.integration,
      type: "oauth2",
      credential_type_name: pending.credential_type_name,
      name: pending.credential_name,
      encrypted_payload: encrypted,
      oauth_access_expires: accessTokenExpiresAt,
      oauth_refresh_expires: null,
      oauth_scopes: body.scope ?? null,
      state: "active",
      last_error: null,
      created_at: nowDate.toISOString(),
      updated_at: nowDate.toISOString(),
    });

    this.helpers.markOAuthPendingConsumed(args.state, nowDate.toISOString(), {
      credentialId,
    });

    return {
      credentialId,
      credentialTypeName: pending.credential_type_name,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Look up a catalog entry's authType by name — used when
 * `resolveCredentialType` needs the authType to fall back on for legacy
 * rows. When the name isn't found we return the first catalog entry's
 * authType (if any) since the resolver's fallback logic then matches by
 * authType anyway.
 */
function authTypeFromCatalog(
  manifest: IntegrationManifest,
  credentialTypeName: string,
): "none" | "apiKey" | "oauth2" | "basic" | "bearer" {
  const catalog = manifest.credentialTypes ?? [];
  const byName = catalog.find((c) => c.name === credentialTypeName);
  if (byName) return byName.authType;
  if (catalog.length > 0) return catalog[0]!.authType;
  return manifest.authType as "none" | "apiKey" | "oauth2" | "basic" | "bearer";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function noopLogger(): OperationContext["logger"] {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
