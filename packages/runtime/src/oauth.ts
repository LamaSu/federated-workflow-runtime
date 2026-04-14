import type { DatabaseType, CredentialRow } from "./db.js";
import { QueryHelpers } from "./db.js";
import { encryptCredential } from "./credentials.js";

/**
 * OAuth token refresher per ARCHITECTURE §4.8.
 *
 * Scheduled background job — NOT failure-driven. Runs every `intervalMs`
 * (default 5 min) and looks for credentials whose access token expires
 * within `leadTimeMs` (default 10 min). For each, invokes the provided
 * `refresh` function. Successful refreshes update the DB; failures mark
 * the credential invalid.
 *
 * The `refresh` function is injected because each integration has its own
 * OAuth endpoint. The runtime is generic; it just knows WHEN to refresh,
 * not HOW.
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

export interface OAuthRefresherOptions {
  db: DatabaseType;
  /** 32-byte encryption key (see credentials.ts). */
  key: Buffer;
  /** Refresh implementation. Runtime provides the WHEN; you provide the HOW. */
  refresh: RefreshFn;
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
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
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
   */
  async tick(): Promise<{ refreshed: number; failed: number }> {
    const now = this.now();
    const cutoff = new Date(now.getTime() + this.leadTimeMs).toISOString();
    const expiring = this.helpers.listExpiringOAuthCredentials(cutoff);
    let refreshed = 0;
    let failed = 0;
    for (const cred of expiring) {
      try {
        const result = await this.opts.refresh(cred);
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
