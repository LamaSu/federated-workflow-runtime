import type { CredentialRow, DatabaseType } from "./db.js";
import { QueryHelpers } from "./db.js";
import type { EventDispatcher } from "./triggers/event.js";

/**
 * Non-OAuth credential expiry alarm per docs/CREDENTIALS_ANALYSIS.md §6 +
 * §8 (rotation reminders).
 *
 * OAuth credentials get refreshed automatically by `OAuthRefresher`.
 * PATs, API keys, bearer tokens, and basic-auth credentials don't — they
 * rely on manual rotation by the user. This alarm watches those and
 * emits a `credential.expiring` event a configurable number of days
 * before their manual rotation deadline.
 *
 * Deadline resolution:
 *   - If `oauth_access_expires` is set (some non-OAuth credentials
 *     carry an explicit expiry, e.g. GitHub fine-grained PATs), use it.
 *   - Else fall back to `created_at + defaultRotationDays` (90d default).
 *
 * The alarm is idempotent across ticks: once an event has fired for a
 * credential, the alarm remembers its id in-memory to avoid re-emitting
 * until the credential is rotated (which mutates `updated_at`).
 */

/** Default: warn 7 days before deadline. */
export const DEFAULT_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Default: non-OAuth credentials rotate every 90 days from creation. */
export const DEFAULT_ROTATION_DAYS = 90;
/** Default tick cadence: 6 hours (cheap, SQL-only). */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ExpiryAlarmOptions {
  db: DatabaseType;
  /**
   * Event dispatcher used to emit `credential.expiring` events. When
   * omitted, the alarm runs but only returns results from `tick()` — no
   * events are emitted. Useful for tests / CLI one-shots.
   */
  dispatcher?: EventDispatcher;
  /** How often to scan (default 6h). */
  intervalMs?: number;
  /** How far ahead of deadline to warn (default 7d). */
  warnWindowMs?: number;
  /** Rotation deadline horizon when credential has no explicit expiry. */
  defaultRotationDays?: number;
  /** Override Date.now() — used by tests. */
  now?: () => Date;
  /** Override setInterval — used by tests. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Override clearInterval — used by tests. */
  clearIntervalFn?: (handle: unknown) => void;
}

export interface ExpiryAlarmResult {
  /** Number of credentials scanned this tick. */
  scanned: number;
  /** Number of `credential.expiring` events emitted this tick. */
  emitted: number;
  /** Per-credential detail for diagnostics/tests. */
  entries: Array<{
    credentialId: string;
    integration: string;
    credentialTypeName: string;
    deadlineIso: string;
    daysUntilDeadline: number;
    emitted: boolean;
    reason?: string;
  }>;
}

/**
 * Compute the rotation deadline for a non-OAuth credential. Exported so
 * the CLI's `credentials list --json` can surface the same number.
 */
export function computeDeadline(
  cred: CredentialRow,
  defaultRotationDays: number,
): Date {
  if (cred.oauth_access_expires) {
    const explicit = Date.parse(cred.oauth_access_expires);
    if (!Number.isNaN(explicit)) return new Date(explicit);
  }
  const created = Date.parse(cred.created_at);
  const base = Number.isNaN(created) ? Date.now() : created;
  return new Date(base + defaultRotationDays * 24 * 60 * 60 * 1000);
}

export class ExpiryAlarm {
  private readonly helpers: QueryHelpers;
  private readonly warnWindowMs: number;
  private readonly defaultRotationDays: number;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private handle: unknown | null = null;
  /**
   * Remembers which credential id+updated_at combinations have already
   * fired an event. Keyed by `<id>@<updated_at>` so a rotation (which
   * bumps `updated_at`) naturally resets the warning.
   */
  private readonly fired = new Set<string>();

  constructor(private readonly opts: ExpiryAlarmOptions) {
    this.helpers = new QueryHelpers(opts.db);
    this.warnWindowMs = opts.warnWindowMs ?? DEFAULT_WARN_WINDOW_MS;
    this.defaultRotationDays =
      opts.defaultRotationDays ?? DEFAULT_ROTATION_DAYS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.setIntervalFn =
      opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn =
      opts.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalFn(() => {
      void this.tick().catch(() => {
        // Individual-credential failures are caught in tick; any uncaught
        // error here means a bug; log and keep going.
      });
    }, this.intervalMs);
    if (this.handle && typeof (this.handle as NodeJS.Timeout).unref === "function") {
      (this.handle as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /**
   * Run one scan. Returns the list of credentials examined + which ones
   * triggered an event. Safe to call directly from tests or a CLI
   * one-shot (`chorus credentials check-expiry`).
   */
  async tick(): Promise<ExpiryAlarmResult> {
    const now = this.now();
    const nowMs = now.getTime();
    const credentials = this.helpers.listActiveNonOAuthCredentials();
    const entries: ExpiryAlarmResult["entries"] = [];
    let emitted = 0;

    for (const cred of credentials) {
      const deadline = computeDeadline(cred, this.defaultRotationDays);
      const msUntil = deadline.getTime() - nowMs;
      const daysUntil = Math.round(msUntil / (24 * 60 * 60 * 1000));
      const inWindow = msUntil <= this.warnWindowMs;
      const cacheKey = `${cred.id}@${cred.updated_at}`;
      const alreadyFired = this.fired.has(cacheKey);

      const entry = {
        credentialId: cred.id,
        integration: cred.integration,
        credentialTypeName: cred.credential_type_name,
        deadlineIso: deadline.toISOString(),
        daysUntilDeadline: daysUntil,
        emitted: false as boolean,
        reason: undefined as string | undefined,
      };

      if (!inWindow) {
        entry.reason = "outside-warn-window";
        entries.push(entry);
        continue;
      }
      if (alreadyFired) {
        entry.reason = "already-fired";
        entries.push(entry);
        continue;
      }
      if (!this.opts.dispatcher) {
        entry.reason = "no-dispatcher";
        entries.push(entry);
        continue;
      }

      try {
        this.opts.dispatcher.emit({
          type: "credential.expiring",
          source: "expiry-alarm",
          correlationId: cred.id,
          payload: {
            credentialId: cred.id,
            integration: cred.integration,
            credentialTypeName: cred.credential_type_name,
            name: cred.name,
            deadlineIso: deadline.toISOString(),
            daysUntilDeadline: daysUntil,
            reason: cred.oauth_access_expires
              ? "explicit-expiry"
              : "default-rotation-horizon",
          },
        });
        this.fired.add(cacheKey);
        entry.emitted = true;
        emitted++;
      } catch (err) {
        entry.reason = `emit-failed:${(err as Error).message}`;
      }
      entries.push(entry);
    }

    return {
      scanned: credentials.length,
      emitted,
      entries,
    };
  }
}

/**
 * Convenience: construct + start an ExpiryAlarm in one call.
 */
export function startExpiryAlarm(opts: ExpiryAlarmOptions): ExpiryAlarm {
  const a = new ExpiryAlarm(opts);
  a.start();
  return a;
}
