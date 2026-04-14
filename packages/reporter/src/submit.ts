import type { RedactedErrorReport } from "@chorus/core";

/**
 * Result of a submission attempt.
 */
export interface SubmitResult {
  accepted: boolean;
  /** Registry-assigned report id, when accepted. */
  id?: string;
  /** Reason for rejection / local short-circuit, when not accepted. */
  reason?: string;
  /**
   * Existing patch metadata returned by the registry, if the registry
   * already has a canary/fleet patch for this signature hash. Kept loose
   * on purpose — callers do their own validation.
   */
  existingPatch?: Record<string, unknown>;
  /** Final HTTP status code from the registry, if we got one. */
  statusCode?: number;
}

/**
 * Caller-configurable options for a single submission.
 */
export interface SubmitOptions {
  /**
   * Optional Ed25519 signing helper. Receives the JSON-stringified body and
   * returns a detached signature string. If omitted, no signature header is
   * attached. The registry MVP accepts unsigned reports; signed support is
   * opt-in until `@chorus/registry` ships signing helpers.
   */
  signingKey?: (body: string) => string | Promise<string>;
  /** Per-request timeout in milliseconds. Default 10_000. */
  timeout?: number;
  /** Max retry attempts on 5xx / transient errors. Default 3. */
  maxRetries?: number;
  /** Initial backoff in milliseconds. Default 200ms, doubles each retry. */
  backoffMs?: number;
  /** Custom fetch. Defaults to `globalThis.fetch`. Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Short-circuit: if true, skip the network and return `accepted:true`. */
  localMode?: boolean;
  /** User-Agent header. Defaults to `chorus-reporter/<version>`. */
  userAgent?: string;
  /**
   * Rate limiter state. If omitted, uses a module-level default. Pass a
   * dedicated instance in tests / multi-tenant scenarios.
   */
  rateLimiter?: RateLimiter;
}

/**
 * Token-bucket rate limiter: up to `maxPerMinute` calls allowed in any
 * rolling 60-second window. Simple, in-process, no external deps.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  constructor(private readonly maxPerMinute: number = 10) {}

  /**
   * Register an intent to submit. Returns `true` if allowed, `false` if the
   * call would exceed `maxPerMinute`.
   */
  tryAcquire(now: number = Date.now()): boolean {
    const cutoff = now - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  /** How many slots are currently available. */
  remaining(now: number = Date.now()): number {
    const cutoff = now - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    return Math.max(0, this.maxPerMinute - this.timestamps.length);
  }
}

/** Default shared limiter: 10 reports/minute, matching @chorus/reporter docs. */
const DEFAULT_RATE_LIMITER = new RateLimiter(10);

/**
 * Submit a redacted error report to the registry.
 *
 * Behavior matrix:
 *
 *   - rate-limited:        returns { accepted:false, reason:"rate-limited" }.
 *   - localMode / no URL:  returns { accepted:true, reason:"local-mode" }.
 *   - network error:       retried with exponential backoff up to maxRetries.
 *   - 5xx:                 retried.
 *   - 4xx:                 NOT retried (client bug, not transient).
 *   - 2xx:                 accepted, body parsed if JSON.
 */
export async function submitReport(
  report: RedactedErrorReport,
  registryUrl: string | undefined,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const limiter = options.rateLimiter ?? DEFAULT_RATE_LIMITER;
  if (!limiter.tryAcquire()) {
    return { accepted: false, reason: "rate-limited" };
  }

  if (options.localMode || !registryUrl) {
    return { accepted: true, reason: "local-mode" };
  }

  const body = JSON.stringify({
    schemaVersion: "1.0.0",
    report,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": options.userAgent ?? "chorus-reporter/0.1.0",
  };

  if (options.signingKey) {
    try {
      const signature = await options.signingKey(body);
      headers["x-chorus-signature"] = signature;
    } catch (err) {
      return {
        accepted: false,
        reason: `signing-failed: ${errorMessage(err)}`,
      };
    }
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { accepted: false, reason: "fetch-unavailable" };
  }

  const timeout = options.timeout ?? 10_000;
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const baseBackoff = options.backoffMs ?? 200;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseBackoff * Math.pow(2, attempt - 1);
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetchImpl(registryUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;

      if (res.status >= 200 && res.status < 300) {
        const parsed = await safeJson(res);
        return {
          accepted: true,
          id:
            typeof parsed?.id === "string"
              ? parsed.id
              : typeof parsed?.signatureHash === "string"
                ? (parsed.signatureHash as string)
                : undefined,
          existingPatch:
            parsed && typeof parsed.existingPatch === "object"
              ? (parsed.existingPatch as Record<string, unknown>)
              : undefined,
          statusCode: res.status,
        };
      }

      // 4xx -> do NOT retry. The payload is bad and retrying won't fix it.
      if (res.status >= 400 && res.status < 500) {
        const detail = await safeText(res);
        return {
          accepted: false,
          reason: `client-error-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          statusCode: res.status,
        };
      }

      // 5xx or other -> retry.
      lastError = `server-error-${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastError = `network-error: ${errorMessage(err)}`;
    }
  }

  return {
    accepted: false,
    reason: lastError ?? "unknown-error",
    statusCode: lastStatus,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function safeJson(
  res: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
