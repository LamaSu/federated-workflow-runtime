import {
  type ErrorSignature,
  ErrorSignatureSchema,
  ChorusError,
  fingerprintStack,
  hashSignature,
  stabilizeMessage,
} from "@chorus/core";

/**
 * Context supplied by the caller when extracting a signature from an error.
 *
 * - integration / operation / integrationVersion / runtimeVersion come from the
 *   runtime that observed the failure.
 * - httpMeta carries headers/status text pulled off the failing HTTP response
 *   (if any) so we can read apiVersion without re-fetching.
 */
export interface ExtractSignatureContext {
  integration: string;
  operation: string;
  integrationVersion: string;
  runtimeVersion: string;
  httpMeta?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  };
  /** Pre-set timestamp. Mostly a test hook; defaults to `new Date().toISOString()`. */
  now?: string;
}

/** Headers that carry a vendor API version, roughly ordered by seen-frequency. */
const API_VERSION_HEADERS = [
  "stripe-version",
  "api-version",
  "x-api-version",
  "x-goog-api-client",
  "x-ms-version",
];

/**
 * Parse the api version out of common HTTP headers.
 *
 * Supports:
 *   - Dedicated headers (stripe-version, api-version, x-api-version, etc.)
 *   - Accept header with `application/vnd.<vendor>+json;version=X`
 *     or `application/vnd.<vendor>.v1+json`.
 */
export function fingerprintApiVersion(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  for (const name of API_VERSION_HEADERS) {
    const value = normalized[name];
    if (value && value.trim().length > 0) {
      return value.trim().slice(0, 64);
    }
  }
  const accept = normalized["accept"];
  if (accept) {
    // application/vnd.foo+json; version=2
    const m1 = /version\s*=\s*([A-Za-z0-9._-]+)/i.exec(accept);
    if (m1 && m1[1]) return m1[1].slice(0, 64);
    // application/vnd.foo.v3+json
    const m2 = /vnd\.[^;+]+\.v([0-9][A-Za-z0-9._-]*)/i.exec(accept);
    if (m2 && m2[1]) return `v${m2[1]}`.slice(0, 64);
  }
  return undefined;
}

/**
 * Build a normalized ErrorSignature describing `err` in `ctx`.
 *
 * Does NOT hash or submit; pair with `hashSignature` (from @chorus/core) to
 * obtain the 64-char signature hash used as the registry key.
 */
export function extractSignature(
  err: unknown,
  ctx: ExtractSignatureContext,
): ErrorSignature {
  const now = ctx.now ?? new Date().toISOString();

  // Error class: prefer the constructor name for real Error instances,
  // fall back to a string for non-Error throws (strings, numbers, objects).
  let errorClass = "UnknownError";
  let message = "";
  let stack: string | undefined;
  let httpStatus: number | undefined;

  if (err instanceof Error) {
    errorClass = err.constructor?.name || err.name || "Error";
    message = err.message ?? "";
    stack = err.stack;
  } else if (typeof err === "string") {
    errorClass = "StringThrow";
    message = err;
  } else if (err && typeof err === "object") {
    errorClass = "ObjectThrow";
    message = safeStringify(err);
  } else {
    message = String(err);
  }

  if (err instanceof ChorusError) {
    httpStatus = err.httpStatus;
  }
  if (httpStatus === undefined && ctx.httpMeta?.status !== undefined) {
    httpStatus = ctx.httpMeta.status;
  }

  const apiVersion = fingerprintApiVersion(ctx.httpMeta?.headers);
  const stackFingerprint = fingerprintStack(stack);
  const messagePattern = stabilizeMessage(message);

  const signature: ErrorSignature = {
    schemaVersion: 1,
    integration: ctx.integration,
    operation: ctx.operation,
    errorClass,
    httpStatus,
    httpStatusText: ctx.httpMeta?.statusText,
    apiVersion,
    stackFingerprint,
    messagePattern,
    integrationVersion: ctx.integrationVersion,
    runtimeVersion: ctx.runtimeVersion,
    occurrences: 1,
    firstSeen: now,
    lastSeen: now,
  };

  // Validate via the Zod schema from core. Anything invalid is a bug in
  // upstream code; surface immediately so we don't ship malformed reports.
  return ErrorSignatureSchema.parse(signature);
}

/**
 * Compute the registry key (64-char hex SHA-256) for a signature.
 *
 * Re-exported from @chorus/core for convenience: the reporter pipeline needs
 * both the signature object and its hash, so keep them reachable from the
 * same module.
 */
export { hashSignature };

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
