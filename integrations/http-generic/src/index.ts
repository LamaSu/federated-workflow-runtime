/**
 * @delightfulchorus/integration-http-generic
 *
 * The world's simplest integration: make any HTTP request. Serves two
 * purposes in the Chorus ecosystem:
 *
 *   1. A direct tool — "call this URL, parse the body, hand me the result."
 *   2. A reference integration — minimal surface area, easy to read,
 *      demonstrates the SDK shape (manifest + operations + OperationHandler).
 *
 * This integration has no auth of its own (authType: "none"). A workflow can
 * still pass secrets through the `headers` input, but the value of "generic"
 * is that it is credential-less — the runtime treats each call as anonymous.
 */
import {
  IntegrationError,
  RateLimitError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationHandler,
} from "@delightfulchorus/core";
import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────────────

const HttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export const HttpRequestInputSchema = z.object({
  url: z.string().url(),
  method: HttpMethodSchema.default("GET"),
  headers: z.record(z.string()).optional(),
  /**
   * Body may be a string (sent as-is) or an object (JSON-encoded with
   * Content-Type application/json if the user has not already set one).
   */
  body: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export const HttpRequestOutputSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()),
  body: z.unknown(),
});

export type HttpRequestInput = z.input<typeof HttpRequestInputSchema>;
export type HttpRequestParsed = z.output<typeof HttpRequestInputSchema>;
export type HttpRequestOutput = z.infer<typeof HttpRequestOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "http-generic",
  version: "0.1.0",
  description: "Make any HTTP request. Credential-less, timeout-aware, records snapshots.",
  authType: "none",
  /**
   * Credential catalog (docs/CREDENTIALS_ANALYSIS.md §4.3): this
   * integration is credential-less, so the catalog is empty. If a user
   * needs to send an Authorization header they pass it through `headers`
   * in the operation input — no credential type is declared.
   */
  credentialTypes: [],
  operations: [
    {
      name: "request",
      description:
        "Perform an HTTP request. Accepts method/url/headers/body; returns status/headers/body.",
      // HTTP is not idempotent by default; retries are the caller's call to make.
      idempotent: false,
      // These schemas are informational — the handler re-validates via Zod.
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: ["string", "object", "array"] },
          timeoutMs: { type: "number", minimum: 1, maximum: 600000 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["status", "headers", "body"],
        properties: {
          status: { type: "number" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: {},
        },
      },
    },
  ],
};

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * Normalize a Headers object (from fetch) into a flat lowercase-key record.
 * fetch's Headers are iterable but not JSON-friendly; this makes them so.
 */
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Parse a response body intelligently: try JSON if Content-Type says so,
 * otherwise return text. Never throws on parse failure — just returns text.
 */
async function readBody(res: Response, headers: Record<string, string>): Promise<unknown> {
  const contentType = headers["content-type"] ?? "";
  if (!contentType) {
    // Unknown content type — return raw text; callers can parse if needed.
    return res.text();
  }
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.startsWith("text/")) {
    return res.text();
  }
  // Binary / unknown — return a base64 snapshot so cassettes remain diffable.
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString("base64");
}

export const request: OperationHandler<HttpRequestInput, HttpRequestOutput> = async (
  input,
  ctx,
) => {
  const parsed = HttpRequestInputSchema.parse(input);

  // Merge the caller's signal with our timeout. AbortSignal.any isn't universal
  // in Node 20, so we wire them together manually.
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(new Error("timeout")), parsed.timeoutMs);
  const onUpstreamAbort = (): void => {
    timeoutController.abort(ctx.signal.reason);
  };
  if (ctx.signal.aborted) {
    clearTimeout(timeoutHandle);
    throw new IntegrationError({
      message: "request cancelled before dispatch",
      integration: "http-generic",
      operation: "request",
      code: "CANCELLED",
    });
  }
  ctx.signal.addEventListener("abort", onUpstreamAbort, { once: true });

  // Encode body + set content-type if the caller didn't.
  const headers: Record<string, string> = { ...(parsed.headers ?? {}) };
  let body: string | undefined;
  if (parsed.body !== undefined) {
    if (typeof parsed.body === "string") {
      body = parsed.body;
    } else {
      body = JSON.stringify(parsed.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json; charset=utf-8";
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(parsed.url, {
      method: parsed.method,
      headers,
      body,
      signal: timeoutController.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    ctx.signal.removeEventListener("abort", onUpstreamAbort);
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish timeout from network errors where possible.
    const timedOut = message === "timeout" || /abort/i.test(message);
    throw new IntegrationError({
      message: timedOut ? `request timed out after ${parsed.timeoutMs}ms` : message,
      integration: "http-generic",
      operation: "request",
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      retryable: true,
      cause: err,
    });
  }
  clearTimeout(timeoutHandle);
  ctx.signal.removeEventListener("abort", onUpstreamAbort);

  const responseHeaders = headersToObject(response.headers);
  const responseBody = await readBody(response, responseHeaders);

  // Rate limit gets special treatment so the runtime's retry scheduler can
  // read Retry-After and stall correctly (see ARCHITECTURE.md §4.7).
  if (response.status === 429) {
    const retryAfterHeader = responseHeaders["retry-after"];
    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    // Still record the cassette — rate-limit responses are evidence too.
    await ctx.snapshot?.record(
      `http-generic.request.${response.status}`,
      { url: parsed.url, method: parsed.method },
      { status: response.status, headers: responseHeaders },
    );
    throw new RateLimitError({
      message: `HTTP ${response.status} from ${parsed.url}`,
      integration: "http-generic",
      operation: "request",
      httpStatus: response.status,
      retryAfterMs,
    });
  }

  // Any other 4xx/5xx is an IntegrationError — caller decides retry via code.
  if (response.status >= 400) {
    await ctx.snapshot?.record(
      `http-generic.request.${response.status}`,
      { url: parsed.url, method: parsed.method },
      { status: response.status, headers: responseHeaders, bodyShape: typeof responseBody },
    );
    throw new IntegrationError({
      message: `HTTP ${response.status} from ${parsed.url}`,
      integration: "http-generic",
      operation: "request",
      code: response.status >= 500 ? "SERVER_ERROR" : "CLIENT_ERROR",
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 408,
    });
  }

  // Success: record the cassette so future patch validation has shape data.
  await ctx.snapshot?.record(
    `http-generic.request.${response.status}`,
    { url: parsed.url, method: parsed.method, headerNames: Object.keys(headers) },
    { status: response.status, headers: responseHeaders, bodyShape: typeof responseBody },
  );

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
};

/**
 * Parse an RFC 7231 Retry-After header. Handles both
 *   - delta-seconds (integer): "120"
 *   - HTTP-date: "Wed, 21 Oct 2015 07:28:00 GMT"
 *
 * Returns undefined when unparseable rather than guessing — the runtime
 * will fall back to exponential backoff.
 */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, asDate - Date.now());
}

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    request: request as OperationHandler,
  },
};

export default integration;
