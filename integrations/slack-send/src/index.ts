/**
 * @chorus-integrations/slack-send
 *
 * Reference integration: send a message to Slack via chat.postMessage.
 * Tracks the worked example in ARCHITECTURE.md §8.2.
 *
 * Auth: bearer token (Slack-issued OAuth bot token). The runtime decrypts
 * and hands the token in ctx.credentials.accessToken for each call.
 *
 * Chorus contract notes:
 *   - 429 Retry-After → RateLimitError with retryAfterMs so the runtime's
 *     retry scheduler can sleep exactly as long as Slack requested.
 *   - 401 → AuthError (non-retryable; the credential needs user action).
 *   - Slack's "ok: false" body surfaces as IntegrationError with code
 *     SLACK_<ERROR>, preserving Slack's own error vocabulary.
 *   - Every call records a cassette (success AND failure) so the repair
 *     agent has shape data to validate future patches against.
 */
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationHandler,
} from "@chorus/core";
import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const PostMessageInputSchema = z.object({
  channel: z.string().min(1),
  text: z.string().max(40_000),
  blocks: z.array(z.unknown()).optional(),
  /**
   * Slack uses `thread_ts` (snake_case) in the API. Chorus workflows prefer
   * camelCase (`threadTs`); we accept either on input and serialize to the
   * Slack shape on the wire.
   */
  threadTs: z.string().optional(),
  thread_ts: z.string().optional(),
});

export const PostMessageOutputSchema = z.object({
  ts: z.string(),
  channel: z.string(),
});

export type PostMessageInput = z.infer<typeof PostMessageInputSchema>;
export type PostMessageOutput = z.infer<typeof PostMessageOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "slack-send",
  version: "0.1.0",
  description: "Send messages to Slack via chat.postMessage (bot token).",
  authType: "bearer",
  baseUrl: "https://slack.com/api",
  docsUrl: "https://api.slack.com/methods/chat.postMessage",
  operations: [
    {
      name: "postMessage",
      description: "Post a message to a Slack channel. Supports blocks and threading.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["channel", "text"],
        properties: {
          channel: { type: "string" },
          text: { type: "string", maxLength: 40_000 },
          blocks: { type: "array" },
          threadTs: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        required: ["ts", "channel"],
        properties: {
          ts: { type: "string" },
          channel: { type: "string" },
        },
      },
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pull a bearer token out of the OperationContext. We accept two common
 * shapes — a plain string credential, or an object with `token`/`accessToken`.
 */
export function extractBearerToken(credentials: OperationContextCreds): string | undefined {
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
 * Convert an RFC 7231 Retry-After value into milliseconds. Slack always uses
 * delta-seconds in practice, but we tolerate a date form for robustness.
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
 * Slack returns 200 + `{ok: false, error: "..."}` on most application-level
 * errors. This function decides which ones are retryable (infra blips) vs
 * terminal (bad token, missing scope, bad channel ID, etc.).
 */
export function isSlackRetryable(slackError: string): boolean {
  return new Set([
    "internal_error",
    "ratelimited",
    "service_unavailable",
    "request_timeout",
  ]).has(slackError);
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const postMessage: OperationHandler<PostMessageInput, PostMessageOutput> = async (
  input,
  ctx,
) => {
  const parsed = PostMessageInputSchema.parse(input);
  const token = extractBearerToken(ctx.credentials);
  if (!token) {
    throw new AuthError({
      message: "slack-send.postMessage requires a bearer token in ctx.credentials",
      integration: "slack-send",
      operation: "postMessage",
    });
  }

  // Build the wire body in Slack's snake_case shape.
  const wireBody: Record<string, unknown> = {
    channel: parsed.channel,
    text: parsed.text,
  };
  if (parsed.blocks !== undefined) wireBody.blocks = parsed.blocks;
  const threadTs = parsed.thread_ts ?? parsed.threadTs;
  if (threadTs !== undefined) wireBody.thread_ts = threadTs;

  let response: Response;
  try {
    response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(wireBody),
      signal: ctx.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new IntegrationError({
      message: `slack-send network error: ${message}`,
      integration: "slack-send",
      operation: "postMessage",
      code: "NETWORK_ERROR",
      retryable: true,
      cause: err,
    });
  }

  // 429 — use Slack's Retry-After (in seconds) literally.
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after") ?? undefined) ?? 30_000;
    await ctx.snapshot?.record(
      "slack-send.postMessage.429",
      { channel: parsed.channel, hasBlocks: parsed.blocks !== undefined },
      { status: 429, retryAfterMs },
    );
    throw new RateLimitError({
      message: "Slack rate limit exceeded",
      integration: "slack-send",
      operation: "postMessage",
      httpStatus: 429,
      retryAfterMs,
    });
  }

  // 401 — bad/expired/revoked token.
  if (response.status === 401) {
    await ctx.snapshot?.record(
      "slack-send.postMessage.401",
      { channel: parsed.channel },
      { status: 401 },
    );
    throw new AuthError({
      message: "Slack 401 — token invalid or revoked; user must reauthorize",
      integration: "slack-send",
      operation: "postMessage",
      httpStatus: 401,
    });
  }

  // Any remaining transport error (5xx, 403, etc.)
  type SlackBody = { ok?: boolean; error?: string; ts?: string; channel?: string };
  let rawBody: SlackBody | null = null;
  try {
    rawBody = (await response.json()) as SlackBody;
  } catch {
    // Slack normally always returns JSON, but if it doesn't we still have to
    // surface something sensible rather than letting a parse error bubble.
    rawBody = null;
  }

  if (response.status >= 400 || rawBody === null) {
    await ctx.snapshot?.record(
      `slack-send.postMessage.${response.status}`,
      { channel: parsed.channel },
      { status: response.status, bodyShape: rawBody ? Object.keys(rawBody) : null },
    );
    throw new IntegrationError({
      message: `Slack HTTP ${response.status}`,
      integration: "slack-send",
      operation: "postMessage",
      code: response.status >= 500 ? "SLACK_SERVER_ERROR" : "SLACK_HTTP_ERROR",
      httpStatus: response.status,
      retryable: response.status >= 500,
    });
  }

  const body: SlackBody = rawBody;
  if (!body.ok) {
    const slackError = body.error ?? "unknown_error";
    await ctx.snapshot?.record(
      `slack-send.postMessage.error.${slackError}`,
      { channel: parsed.channel },
      { status: response.status, slackError },
    );
    // A handful of Slack errors are auth-shaped — split those off.
    const authShaped = new Set([
      "invalid_auth",
      "token_revoked",
      "token_expired",
      "not_authed",
      "account_inactive",
    ]);
    if (authShaped.has(slackError)) {
      throw new AuthError({
        message: `Slack auth error: ${slackError}`,
        integration: "slack-send",
        operation: "postMessage",
        httpStatus: response.status,
      });
    }
    if (slackError === "ratelimited") {
      throw new RateLimitError({
        message: "Slack returned ok:false with ratelimited",
        integration: "slack-send",
        operation: "postMessage",
        httpStatus: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after") ?? undefined) ?? 30_000,
      });
    }
    throw new IntegrationError({
      message: `Slack API error: ${slackError}`,
      integration: "slack-send",
      operation: "postMessage",
      code: `SLACK_${slackError.toUpperCase()}`,
      httpStatus: response.status,
      retryable: isSlackRetryable(slackError),
    });
  }

  // Success.
  const ts = body.ts;
  const channel = body.channel;
  if (typeof ts !== "string" || typeof channel !== "string") {
    throw new IntegrationError({
      message: "Slack success body missing ts/channel",
      integration: "slack-send",
      operation: "postMessage",
      code: "SLACK_MALFORMED_RESPONSE",
      httpStatus: response.status,
      retryable: false,
    });
  }

  await ctx.snapshot?.record(
    "slack-send.postMessage.200",
    {
      channel: parsed.channel,
      hasBlocks: parsed.blocks !== undefined,
      isThreadedReply: threadTs !== undefined,
    },
    { status: 200, ok: true },
  );

  return { ts, channel };
};

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    postMessage: postMessage as OperationHandler,
  },
};

export default integration;
