import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeCredentialService } from "../credential-service.js";
import type { EventDispatcher } from "../triggers/event.js";

/**
 * OAuth callback HTTP surface per docs/CREDENTIALS_ANALYSIS.md §7.
 *
 *   GET /api/oauth/callback?code=<>&state=<>
 *
 * This is the URL the OAuth provider redirects the user's browser to after
 * they click "Authorize" on the provider's consent page. The endpoint:
 *
 *   1. Parses `code` + `state` from the query string.
 *   2. Looks up the oauth_pending row by state. Rejects expired + consumed.
 *   3. Asks the RuntimeCredentialService to exchange code → tokens at the
 *      catalog's `oauth.tokenUrl`, encrypt, persist as a credential, mark
 *      pending consumed.
 *   4. Fires the `oauth.callback.<state>` event via the EventDispatcher.
 *      This is how the __authenticate MCP tool (which is blocked in a
 *      step.waitForEvent) knows the flow completed.
 *   5. Returns a tiny HTML page — "you can close this window" — so the
 *      user's browser doesn't look broken. HTML (not JSON) because this
 *      URL is opened by a browser, not an API client.
 *
 * Safety:
 *   - state must be a 16..1024-char URL-safe token (loose: we don't
 *     re-derive, but we enforce bounds so a malicious redirect can't DoS).
 *   - code must be a string; we don't log or echo it in the response.
 *   - On ANY error the response is 400 + a user-friendly page; we mark
 *     the pending row consumed with an error and fire the event with
 *     `{ok: false}` so the MCP tool unblocks.
 *   - NO PII in the redirect query — we trust the state token alone.
 *   - Rate-limit via Fastify's built-in body limit (no body) + optional
 *     bearer auth on the /api/* prefix.
 */

export const OAuthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(16).max(1024).regex(/^[A-Za-z0-9_\-.~]+$/),
});

export interface RegisterOAuthRoutesOptions {
  /** The credential service — same instance wired into MCP. */
  credentialService: RuntimeCredentialService;
  /**
   * Event dispatcher — when the callback resolves (success OR failure),
   * we fire `oauth.callback.<state>` with `{ok, credentialId?, error?}`.
   * The __authenticate MCP tool's step.waitForEvent wakes on this event.
   */
  eventDispatcher?: EventDispatcher;
  /**
   * Override fetch for tests — primarily passed through to
   * RuntimeCredentialService.completeOAuthCallback.
   */
  fetchFn?: typeof fetch;
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  opts: RegisterOAuthRoutesOptions,
): void {
  app.get("/api/oauth/callback", async (req, reply) => {
    const parsed = OAuthCallbackQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400).type("text/html");
      return renderErrorPage(
        "Invalid OAuth callback",
        "The code/state query parameters are missing or malformed.",
      );
    }
    const { code, state } = parsed.data;

    try {
      const { credentialId, credentialTypeName } =
        await opts.credentialService.completeOAuthCallback({
          state,
          code,
          fetchFn: opts.fetchFn,
        });

      // Fire the event so a blocked __authenticate MCP tool can resume.
      // We use an event type of `oauth.callback.<state>` so each waiting
      // tool only wakes on its own flow, without pattern-matching logic
      // on the consumer side.
      if (opts.eventDispatcher) {
        try {
          opts.eventDispatcher.emit({
            type: `oauth.callback.${state}`,
            payload: { ok: true, credentialId, credentialTypeName, state },
            source: "api/oauth",
            correlationId: state,
          });
        } catch {
          // Event emission failure must not break the callback path —
          // the credential is already persisted.
        }
      }

      reply.code(200).type("text/html");
      return renderSuccessPage(credentialTypeName);
    } catch (err) {
      const message = (err as Error).message;
      if (opts.eventDispatcher) {
        try {
          opts.eventDispatcher.emit({
            type: `oauth.callback.${state}`,
            payload: { ok: false, error: message, state },
            source: "api/oauth",
            correlationId: state,
          });
        } catch {
          // Same as above — ignore.
        }
      }
      reply.code(400).type("text/html");
      return renderErrorPage("OAuth callback failed", message);
    }
  });
}

// ── HTML renderers (kept minimal; no external templates) ─────────────────

function renderSuccessPage(credentialTypeName: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title>
<style>
  body { font: 15px/1.5 ui-sans-serif,system-ui,sans-serif; padding: 3rem; max-width: 32rem; margin: auto; color: #222; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
</style></head>
<body>
<h1>Connected</h1>
<p>The <code>${escapeHtml(credentialTypeName)}</code> credential was stored successfully.</p>
<p>You can close this window and return to your terminal.</p>
</body></html>`;
}

function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>OAuth error</title>
<style>
  body { font: 15px/1.5 ui-sans-serif,system-ui,sans-serif; padding: 3rem; max-width: 32rem; margin: auto; color: #222; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #a40000; }
  pre { background: #f2f2f2; padding: 1rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
<pre>${escapeHtml(detail)}</pre>
<p>You can close this window and try again from your terminal.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
