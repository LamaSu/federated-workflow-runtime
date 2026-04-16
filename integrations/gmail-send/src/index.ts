/**
 * @delightfulchorus/integration-gmail-send
 *
 * Send an email via Gmail's REST API (users.messages.send). This is the
 * first Chorus integration whose canonical credential type is OAuth 2.0 —
 * it demonstrates the §4.3 `credentialTypes[...].oauth` metadata in
 * production (authorize URL, token URL, scopes, PKCE policy).
 *
 * Auth: an OAuth 2.0 access token minted by Google with at least the
 * `https://www.googleapis.com/auth/gmail.send` scope. The runtime's OAuth
 * pipeline mints it, refreshes it, and hands it over in
 * `ctx.credentials.accessToken` — the handler below is deliberately
 * ignorant of the flow mechanics.
 *
 * Chorus contract notes:
 *   - 429 Retry-After → RateLimitError with retryAfterMs so the runtime's
 *     retry scheduler can sleep exactly as long as Gmail requested. Google
 *     uses delta-seconds in practice.
 *   - 401 → AuthError (non-retryable; the OAuth layer will try to refresh
 *     the access token out-of-band before the next attempt).
 *   - 403 / 400 → IntegrationError(retryable:false) — quota denied, scope
 *     missing, malformed raw body, recipient disallowed, etc. User action
 *     required.
 *   - 5xx → IntegrationError(retryable:true).
 *   - Every call records a cassette (success AND failure) so the repair
 *     agent has shape data to validate future patches against.
 */
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type CredentialTestResult,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const SendMessageInputSchema = z.object({
  /** Recipient address. Accepts bare `user@host` or `"Name" <user@host>`. */
  to: z.string().min(1),
  /**
   * Optional sender override. Gmail will reject a `from` that isn't the
   * authenticated account or one of its configured send-as aliases, so most
   * workflows omit this and let Gmail fill it in.
   */
  from: z.string().optional(),
  subject: z.string().max(998),
  /**
   * Message body. Interpreted as `text/plain; charset=utf-8` by default;
   * set `bodyType: "html"` to send `text/html`.
   */
  body: z.string(),
  bodyType: z.enum(["text", "html"]).default("text"),
});

export const SendMessageOutputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
});

export type SendMessageInput = z.input<typeof SendMessageInputSchema>;
export type SendMessageParsed = z.output<typeof SendMessageInputSchema>;
export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "gmail-send",
  version: "0.1.1",
  description: "Send emails via Gmail's users.messages.send endpoint (OAuth 2.0).",
  authType: "oauth2",
  baseUrl: "https://gmail.googleapis.com",
  docsUrl: "https://developers.google.com/gmail/api/guides/sending",
  /**
   * Credential catalog (docs/CREDENTIALS_ANALYSIS.md §4.3). gmail-send
   * ships ONE credential type — a Google OAuth 2.0 access token with the
   * `gmail.send` scope. The field list is a single `accessToken` with
   * `oauthManaged: true`, so the CLI does not prompt the user for it;
   * instead the runtime's OAuth flow populates it from the authorize →
   * code → token exchange. Refresh is also runtime-driven via `tokenUrl`.
   */
  credentialTypes: [
    {
      name: "gmailOAuth2",
      displayName: "Gmail OAuth2",
      authType: "oauth2",
      description:
        "Google OAuth 2.0 access token with the gmail.send scope. Issued via the standard Google authorize → code → token flow; the runtime's OAuth refresher keeps the access token fresh.",
      documentationUrl: "https://developers.google.com/gmail/api/quickstart",
      fields: [
        {
          name: "accessToken",
          displayName: "Access Token",
          type: "password",
          required: true,
          description:
            "Populated by the OAuth 2.0 authorize → token exchange. Not entered by hand — the runtime fills this in after you consent at accounts.google.com.",
          oauthManaged: true,
        },
      ],
      oauth: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        pkce: true,
        clientAuthStyle: "body",
        redirectPath: "/oauth/callback",
        authorizeQueryParams: {
          // Google requires `access_type=offline` + `prompt=consent` to
          // reliably receive a refresh_token on re-authorize. These are
          // safe defaults; advanced users may override via their own
          // credential config.
          access_type: "offline",
          prompt: "consent",
        },
      },
      test: {
        description:
          "Calls GET https://gmail.googleapis.com/gmail/v1/users/me/profile (read-only).",
      },
    },
  ],
  operations: [
    {
      name: "sendMessage",
      description:
        "Send an RFC 2822 email via Gmail. Accepts plain-text or HTML body. Returns the Gmail message id and thread id.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["to", "subject", "body"],
        properties: {
          to: { type: "string" },
          from: { type: "string" },
          subject: { type: "string", maxLength: 998 },
          body: { type: "string" },
          bodyType: { type: "string", enum: ["text", "html"] },
        },
      },
      outputSchema: {
        type: "object",
        required: ["id", "threadId"],
        properties: {
          id: { type: "string" },
          threadId: { type: "string" },
          labelIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pull a bearer / access token out of the OperationContext. Gmail's OAuth
 * flow populates `ctx.credentials.accessToken` — we also accept `token` /
 * `bearer` / a bare string for symmetry with slack-send and to keep unit
 * tests legible.
 */
export function extractAccessToken(credentials: OperationContextCreds): string | undefined {
  if (!credentials) return undefined;
  if (typeof credentials === "string") return credentials;
  const candidate =
    (credentials as { accessToken?: unknown }).accessToken ??
    (credentials as { token?: unknown }).token ??
    (credentials as { bearer?: unknown }).bearer;
  return typeof candidate === "string" ? candidate : undefined;
}

type OperationContextCreds = Record<string, unknown> | string | null | undefined;

/**
 * Convert an RFC 7231 Retry-After value into milliseconds. Google usually
 * emits delta-seconds, but HTTP-Date form is legal so we handle both.
 */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/**
 * Encode a string using RFC 4648 §5 base64url (Gmail's required encoding
 * for `raw`): the base64 alphabet with `-` / `_` instead of `+` / `/`, and
 * NO trailing `=` padding. Node ≥ 16 ships this as a native Buffer
 * encoding; we wrap it so tests can assert the alphabet constraint
 * independently of the caller.
 */
export function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/**
 * Build an RFC 2822 email from the operation input. Keeps the wire format
 * isolated so tests can assert on header presence and body framing without
 * mocking fetch.
 *
 * Output format:
 *   From: <from>            (optional — omitted when caller didn't set it)
 *   To: <to>
 *   Subject: <subject>
 *   MIME-Version: 1.0
 *   Content-Type: text/plain; charset="UTF-8"  (or text/html when bodyType === "html")
 *   Content-Transfer-Encoding: 7bit
 *
 *   <body>
 */
export function buildRfc2822Email(parsed: SendMessageParsed): string {
  const contentType =
    parsed.bodyType === "html"
      ? 'text/html; charset="UTF-8"'
      : 'text/plain; charset="UTF-8"';

  const headers: string[] = [];
  if (parsed.from !== undefined) headers.push(`From: ${parsed.from}`);
  headers.push(`To: ${parsed.to}`);
  headers.push(`Subject: ${parsed.subject}`);
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: ${contentType}`);
  headers.push("Content-Transfer-Encoding: 7bit");

  // RFC 2822 — CRLF-terminated headers, blank line, then body.
  return `${headers.join("\r\n")}\r\n\r\n${parsed.body}`;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const sendMessage: OperationHandler<SendMessageInput, SendMessageOutput> = async (
  input,
  ctx,
) => {
  const parsed = SendMessageInputSchema.parse(input);
  const token = extractAccessToken(ctx.credentials);
  if (!token) {
    throw new AuthError({
      message: "gmail-send.sendMessage requires an access token in ctx.credentials",
      integration: "gmail-send",
      operation: "sendMessage",
    });
  }

  const rfc2822 = buildRfc2822Email(parsed);
  const raw = base64UrlEncode(rfc2822);

  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ raw }),
        signal: ctx.signal,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new IntegrationError({
      message: `gmail-send network error: ${message}`,
      integration: "gmail-send",
      operation: "sendMessage",
      code: "NETWORK_ERROR",
      retryable: true,
      cause: err,
    });
  }

  // 429 — honor Google's Retry-After literally.
  if (response.status === 429) {
    const retryAfterMs =
      parseRetryAfter(response.headers.get("retry-after") ?? undefined) ?? 30_000;
    await ctx.snapshot?.record(
      "gmail-send.sendMessage.429",
      { to: parsed.to, subjectLength: parsed.subject.length, bodyType: parsed.bodyType },
      { status: 429, retryAfterMs },
    );
    throw new RateLimitError({
      message: "Gmail rate limit exceeded",
      integration: "gmail-send",
      operation: "sendMessage",
      httpStatus: 429,
      retryAfterMs,
    });
  }

  // 401 — bad/expired/revoked token. Non-retryable at this layer; the
  // OAuth refresher will re-mint before the next attempt.
  if (response.status === 401) {
    await ctx.snapshot?.record(
      "gmail-send.sendMessage.401",
      { to: parsed.to },
      { status: 401 },
    );
    throw new AuthError({
      message: "Gmail 401 — access token invalid or revoked; refresh or reauthorize",
      integration: "gmail-send",
      operation: "sendMessage",
      httpStatus: 401,
    });
  }

  // Gmail always returns JSON for both success and error bodies. We tolerate
  // a malformed body by falling back to `null` and surfacing an
  // IntegrationError rather than letting a parse exception bubble.
  type GmailError = {
    error?: {
      code?: number;
      status?: string;
      message?: string;
      errors?: Array<{ reason?: string; message?: string }>;
    };
  };
  type GmailSuccess = { id?: string; threadId?: string; labelIds?: string[] };
  type GmailBody = GmailError & GmailSuccess;

  let rawBody: GmailBody | null = null;
  try {
    rawBody = (await response.json()) as GmailBody;
  } catch {
    rawBody = null;
  }

  // 403 / 400 — terminal client-side problem. Gmail error body tells us
  // what went wrong; we preserve the Google status code in the Chorus
  // IntegrationError.code namespace so downstream repair agents can match.
  if (response.status === 403 || response.status === 400) {
    const gmailStatus =
      rawBody?.error?.status?.toUpperCase().replace(/[^A-Z0-9_]/g, "_") ?? "CLIENT_ERROR";
    const gmailMessage = rawBody?.error?.message ?? `HTTP ${response.status}`;
    await ctx.snapshot?.record(
      `gmail-send.sendMessage.${response.status}`,
      { to: parsed.to },
      { status: response.status, gmailStatus, gmailMessage },
    );
    throw new IntegrationError({
      message: `Gmail API error: ${gmailMessage}`,
      integration: "gmail-send",
      operation: "sendMessage",
      code: `GMAIL_${gmailStatus}`,
      httpStatus: response.status,
      retryable: false,
    });
  }

  // 5xx — retryable server error.
  if (response.status >= 500) {
    const gmailMessage = rawBody?.error?.message ?? `HTTP ${response.status}`;
    await ctx.snapshot?.record(
      `gmail-send.sendMessage.${response.status}`,
      { to: parsed.to },
      { status: response.status, gmailMessage },
    );
    throw new IntegrationError({
      message: `Gmail server error: ${gmailMessage}`,
      integration: "gmail-send",
      operation: "sendMessage",
      code: "GMAIL_SERVER_ERROR",
      httpStatus: response.status,
      retryable: true,
    });
  }

  // Any other non-2xx or a malformed body.
  if (response.status >= 400 || rawBody === null) {
    await ctx.snapshot?.record(
      `gmail-send.sendMessage.${response.status}`,
      { to: parsed.to },
      { status: response.status, bodyShape: rawBody ? Object.keys(rawBody) : null },
    );
    throw new IntegrationError({
      message: `Gmail HTTP ${response.status}`,
      integration: "gmail-send",
      operation: "sendMessage",
      code: "GMAIL_HTTP_ERROR",
      httpStatus: response.status,
      retryable: false,
    });
  }

  // 2xx — but Gmail may still nest an error under `error`. Defensive check.
  if (rawBody.error !== undefined) {
    const gmailStatus =
      rawBody.error.status?.toUpperCase().replace(/[^A-Z0-9_]/g, "_") ?? "UNKNOWN";
    const gmailMessage = rawBody.error.message ?? "unknown_error";
    await ctx.snapshot?.record(
      "gmail-send.sendMessage.error",
      { to: parsed.to },
      { status: response.status, gmailStatus, gmailMessage },
    );
    throw new IntegrationError({
      message: `Gmail API error: ${gmailMessage}`,
      integration: "gmail-send",
      operation: "sendMessage",
      code: `GMAIL_${gmailStatus}`,
      httpStatus: response.status,
      retryable: false,
    });
  }

  const id = rawBody.id;
  const threadId = rawBody.threadId;
  if (typeof id !== "string" || typeof threadId !== "string") {
    throw new IntegrationError({
      message: "Gmail success body missing id/threadId",
      integration: "gmail-send",
      operation: "sendMessage",
      code: "GMAIL_MALFORMED_RESPONSE",
      httpStatus: response.status,
      retryable: false,
    });
  }

  await ctx.snapshot?.record(
    "gmail-send.sendMessage.200",
    {
      to: parsed.to,
      hasFrom: parsed.from !== undefined,
      subjectLength: parsed.subject.length,
      bodyType: parsed.bodyType,
    },
    { status: 200, labelCount: rawBody.labelIds?.length ?? 0 },
  );

  const out: SendMessageOutput = { id, threadId };
  if (rawBody.labelIds !== undefined) out.labelIds = rawBody.labelIds;
  return out;
};

// ── testCredential (docs/CREDENTIALS_ANALYSIS.md §4.4) ─────────────────────

/**
 * Validate a Gmail OAuth 2.0 access token by calling `users.getProfile` —
 * a read-only endpoint that confirms (a) the token authenticates, and
 * (b) the user has a Gmail mailbox. The response also gives us the
 * authenticated email address, which the CLI echoes back so the user can
 * sanity-check which account they granted consent for.
 *
 * We deliberately do NOT call `messages.send` with a dry-run flag — Gmail
 * doesn't offer one, and any call that could change mailbox state is too
 * dangerous for a credential-validation path.
 */
export async function testCredential(
  _credentialTypeName: string,
  ctx: OperationContext,
): Promise<CredentialTestResult> {
  const startedAt = Date.now();
  const token = extractAccessToken(ctx.credentials);
  if (!token) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: "gmail-send.testCredential: no access token in ctx.credentials",
      errorCode: "AUTH_INVALID",
    };
  }
  try {
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: ctx.signal,
      },
    );
    const latencyMs = Date.now() - startedAt;
    if (res.status === 401) {
      // Try to extract Google's token-expired signal from the response
      // body so the CLI can distinguish "revoke the credential" from
      // "just refresh it out of band".
      let errCode = "AUTH_INVALID";
      try {
        const body = (await res.json()) as {
          error?: { message?: string; status?: string };
        };
        const msg = body?.error?.message?.toLowerCase() ?? "";
        const status = body?.error?.status?.toLowerCase() ?? "";
        if (msg.includes("expired") || status.includes("expired")) {
          errCode = "AUTH_EXPIRED";
        }
      } catch {
        // Fall through with AUTH_INVALID.
      }
      return {
        ok: false,
        latencyMs,
        error: "Gmail 401 — access token invalid or revoked",
        errorCode: errCode,
      };
    }
    if (res.status === 403) {
      // Google uses 403 + `error.status: PERMISSION_DENIED` for missing-scope.
      let errCode = "SCOPE_INSUFFICIENT";
      let errMsg = "Gmail 403 — scope insufficient or access denied";
      try {
        const body = (await res.json()) as {
          error?: { message?: string; status?: string };
        };
        if (body?.error?.message) errMsg = body.error.message;
        if (body?.error?.status === "PERMISSION_DENIED") {
          errCode = "SCOPE_INSUFFICIENT";
        }
      } catch {
        // Fall through with defaults.
      }
      return {
        ok: false,
        latencyMs,
        error: errMsg,
        errorCode: errCode,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        error: `Gmail HTTP ${res.status}`,
        errorCode: res.status >= 500 ? "NETWORK_ERROR" : "AUTH_INVALID",
      };
    }
    type GmailProfile = {
      emailAddress?: string;
      messagesTotal?: number;
      threadsTotal?: number;
      historyId?: string;
    };
    let body: GmailProfile;
    try {
      body = (await res.json()) as GmailProfile;
    } catch (err) {
      return {
        ok: false,
        latencyMs,
        error: `Gmail users.getProfile: malformed response (${(err as Error).message})`,
        errorCode: "NETWORK_ERROR",
      };
    }
    if (!body.emailAddress) {
      return {
        ok: false,
        latencyMs,
        error: "Gmail users.getProfile: response missing emailAddress",
        errorCode: "AUTH_INVALID",
      };
    }
    return {
      ok: true,
      latencyMs,
      identity: {
        userName: body.emailAddress,
      },
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: `network error: ${(err as Error).message}`,
      errorCode: "NETWORK_ERROR",
    };
  }
}

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    sendMessage: sendMessage as OperationHandler,
  },
  testCredential,
};

export default integration;
