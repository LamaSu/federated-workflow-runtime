import type { DatabaseType } from "./db.js";

/**
 * OAuth callback listener — bridges the runtime's event bus to the MCP
 * server's `OAuthEventListener` interface.
 *
 * When MCP `__authenticate` is invoked inline (serveIntegration with a
 * runtime in the same process), the server calls
 * `waitForOAuthCallback(state, timeoutMs)` to block on
 * `oauth.callback.<state>`. This adapter does subscribe-and-resolve by
 * short-polling the events table — simple, durable, requires no
 * in-memory pub-sub. For standalone scaffolds (the MCP server lives in
 * a separate process from the runtime) there's no listener and
 * `__authenticate` returns the URL synchronously.
 *
 * Polling is acceptable here because:
 *   - The callback event is fired synchronously during an HTTP request
 *     to the same runtime, so the row is durable before the poll
 *     window closes.
 *   - Poll intervals default to 500 ms; at 5-minute timeout that's ~600
 *     queries worst case, trivial for SQLite WAL.
 *   - The alternative (in-memory pub-sub) would be a new dependency
 *     and would add complexity for cross-process scaffolds.
 */
export interface OAuthCallbackListenerOptions {
  /**
   * Database handle — the listener polls the events table directly.
   * Same DB the EventDispatcher writes to.
   */
  db: DatabaseType;
  /** How often to poll for the event. Default: 500ms. */
  pollIntervalMs?: number;
  /** Override sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Override Date.now() for tests. */
  now?: () => number;
}

export class OAuthCallbackListener {
  private readonly pollIntervalMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: OAuthCallbackListenerOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.sleepFn =
      opts.sleepFn ??
      ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Block until `oauth.callback.<state>` fires (or the timeout fires).
   *
   * Returns:
   *  - `{ok: true, credentialId, credentialTypeName}` on success
   *  - `{ok: false, error: "..."}` on provider rejection / exchange
   *    failure / timeout
   */
  async waitForOAuthCallback(
    state: string,
    timeoutMs: number,
  ): Promise<
    | { ok: true; credentialId: string; credentialTypeName: string }
    | { ok: false; error: string }
  > {
    const eventType = `oauth.callback.${state}`;
    const deadline = this.now() + timeoutMs;
    const startedAtIso = new Date(this.now()).toISOString();

    while (this.now() < deadline) {
      const row = this.opts.db
        .prepare(
          `SELECT payload FROM events WHERE type = ? AND emitted_at >= ? ORDER BY emitted_at ASC LIMIT 1`,
        )
        .get(eventType, startedAtIso) as { payload: string } | undefined;
      if (row) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload);
        } catch {
          return { ok: false, error: "oauth.callback event has malformed payload" };
        }
        const payload = parsed as {
          ok?: boolean;
          credentialId?: string;
          credentialTypeName?: string;
          error?: string;
        };
        if (payload.ok === true && payload.credentialId) {
          return {
            ok: true,
            credentialId: payload.credentialId,
            credentialTypeName: payload.credentialTypeName ?? "",
          };
        }
        return {
          ok: false,
          error: payload.error ?? "oauth callback reported failure",
        };
      }
      await this.sleepFn(this.pollIntervalMs);
    }
    return { ok: false, error: "timeout" };
  }
}
