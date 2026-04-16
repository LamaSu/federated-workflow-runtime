/**
 * @delightfulchorus/integration-universal-http
 *
 * One integration to dispatch requests against any service in the
 * `@delightfulchorus/service-catalog`.
 *
 * How it works:
 *   1. Caller supplies `{ serviceId, operationId?, method?, path?, credentialId?, ... }`.
 *   2. We look up `serviceId` in the catalog (`getService`).
 *   3. If `operationId` was given, we resolve it to `{ method, path, bodyContentType }`
 *      from `service.commonOperations`. Otherwise the caller gives `method + path`
 *      directly (ad-hoc mode).
 *   4. We fill `{name}` placeholders in the path from `pathParams`.
 *   5. We pick a matching `AuthTypeEntry` and splice the credential into the
 *      configured `authHeader` — or for some services (Telegram) into the path
 *      itself via the same placeholder mechanism.
 *   6. We dispatch via `fetch`, mapping HTTP statuses to Chorus error classes
 *      exactly the way http-generic and slack-send do (429 → RateLimitError with
 *      Retry-After; 401 → AuthError; 5xx → IntegrationError retryable:true).
 *   7. Every call records a cassette keyed by
 *      `universal-http.call.<serviceId>.<operationId|adhoc>.<status>`.
 *
 * What we intentionally don't do here:
 *   - Schema-validate the request body. The catalog's `inputSchema` is
 *     informational; adding JSON-Schema validation is a follow-up.
 *   - Implement OAuth2 refresh. That lives in the runtime's OAuthRefresher —
 *     when refresh is needed, this handler just throws AuthError and the
 *     runtime re-drives us after a refresh.
 */
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationHandler,
} from "@delightfulchorus/core";
import {
  getService,
  type AuthTypeEntry,
  type OperationEntry,
  type ServiceDefinition,
} from "@delightfulchorus/service-catalog";
import { z } from "zod";

// ── Input schema ────────────────────────────────────────────────────────────

const HttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Input accepted by `universal-http.call`. Two modes:
 *   1. Catalog mode: supply `operationId`. method/path are pulled from the
 *      catalog; pathParams fills in `{param}` placeholders.
 *   2. Ad-hoc mode: supply `method + path` directly (relative to the service's
 *      baseUrl, or absolute if starting with http(s)).
 *
 * Both modes share the rest of the knobs (query, headers, body, credentialId).
 */
export const CallInputSchema = z
  .object({
    serviceId: z.string().min(1),

    /** Pick one: operationId OR (method+path). Both absent → error. */
    operationId: z.string().optional(),
    method: HttpMethodSchema.optional(),
    path: z.string().optional(),

    /**
     * Which auth type to use. Omit to pick the first entry in the service's
     * `authTypes`. Required when the service declares multiple.
     */
    authTypeId: z.string().optional(),

    /** Map of path placeholder → value. Supports nested {name} substitution. */
    pathParams: z.record(z.string()).optional(),

    /** Query-string params. Merged as-is; values coerced to string. */
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),

    /** Extra request headers. Merge on top of the generated auth header. */
    headers: z.record(z.string()).optional(),

    /**
     * Request body. Strings are sent as-is; objects/arrays are JSON-encoded
     * for application/json, or form-encoded for
     * application/x-www-form-urlencoded (driven by the operation's
     * bodyContentType or the caller's explicit Content-Type header).
     */
    body: z.union([
      z.string(),
      z.record(z.unknown()),
      z.array(z.unknown()),
    ]).optional(),

    /**
     * Per-call credential override. In practice this is set by the runtime
     * after it decrypts the credential — universal-http itself never reads
     * credential records off disk.
     */
    credentialId: z.string().optional(),

    timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  })
  .refine(
    (i) =>
      i.operationId !== undefined || (i.method !== undefined && i.path !== undefined),
    {
      message:
        "must supply either operationId (catalog mode) or method+path (ad-hoc mode)",
    },
  );

export type CallInput = z.input<typeof CallInputSchema>;
export type CallParsed = z.output<typeof CallInputSchema>;

export const CallOutputSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()),
  body: z.unknown(),
});

export type CallOutput = z.infer<typeof CallOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "universal-http",
  version: "0.1.2",
  description:
    "Catalog-driven HTTP integration. Dispatches to 40+ services via @delightfulchorus/service-catalog declarations.",
  /**
   * We default to "apiKey" in the manifest authType — the actual envelope is
   * per-call, dictated by the selected catalog entry. credentialTypes is
   * empty here because credentials are resolved at call-time from the
   * service-catalog rather than declared on the integration itself.
   */
  authType: "apiKey",
  credentialTypes: [],
  operations: [
    {
      name: "call",
      description:
        "Dispatch an HTTP request against any catalog service. Catalog mode: pass serviceId + operationId. Ad-hoc mode: pass serviceId + method + path.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["serviceId"],
        properties: {
          serviceId: { type: "string" },
          operationId: { type: "string" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          },
          path: { type: "string" },
          authTypeId: { type: "string" },
          pathParams: { type: "object", additionalProperties: { type: "string" } },
          query: { type: "object" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: ["string", "object", "array"] },
          credentialId: { type: "string" },
          timeoutMs: { type: "number" },
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fill `{name}` placeholders in a template string from a params object.
 * Missing params throw — catalog-declared paths must always be fully resolved.
 */
export function fillTemplate(
  template: string,
  params: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`missing path/credential param: ${name}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Resolve the auth header template against a credential object. Supports:
 *   - `Bearer {accessToken}`          → straight substitution
 *   - `{apiKey}`                      → raw value
 *   - `Basic {base64:username:password}` → base64-encoded "user:pass"
 */
export function renderAuthHeader(
  format: string,
  credential: Readonly<Record<string, unknown>>,
): string {
  // First, handle the {base64:a:b} pseudo-placeholder. It's special-cased
  // because Basic auth is the only auth envelope that requires encoding.
  let rendered = format.replace(
    /\{base64:([a-zA-Z_][a-zA-Z0-9_]*):([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (_match, userField, passField) => {
      const user = credential[userField];
      const pass = credential[passField];
      if (typeof user !== "string") {
        throw new Error(`base64 auth: credential field '${userField}' is missing or not a string`);
      }
      if (typeof pass !== "string") {
        throw new Error(`base64 auth: credential field '${passField}' is missing or not a string`);
      }
      return Buffer.from(`${user}:${pass}`).toString("base64");
    },
  );

  // Then plain {name} substitutions.
  rendered = rendered.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name) => {
    const value = credential[name];
    if (typeof value !== "string") {
      throw new Error(
        `auth header: credential field '${name}' is missing or not a string`,
      );
    }
    return value;
  });

  return rendered;
}

/**
 * Pick the AuthTypeEntry a caller meant. Matching order:
 *   1. Exact match by `authTypeId` if provided.
 *   2. First entry in service.authTypes otherwise.
 * Returns `null` when no entry matches (caller may send anonymous).
 */
export function pickAuthType(
  service: ServiceDefinition,
  authTypeId: string | undefined,
): AuthTypeEntry | null {
  if (authTypeId !== undefined) {
    const match = service.authTypes.find((a) => a.id === authTypeId);
    return match ?? null;
  }
  return service.authTypes[0] ?? null;
}

/**
 * Resolve the catalog operation from its id. Returns `null` when the id
 * doesn't exist — caller surfaces as an IntegrationError.
 */
export function pickOperation(
  service: ServiceDefinition,
  operationId: string,
): OperationEntry | null {
  return service.commonOperations.find((o) => o.id === operationId) ?? null;
}

/**
 * Parse an RFC 7231 Retry-After header into milliseconds. Same shape as
 * http-generic / slack-send; copied rather than imported because this package
 * can't yet depend on a utilities package that doesn't exist.
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

/** Flatten fetch's Headers iterable into a lowercase-keyed plain object. */
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Intelligent body read: JSON when Content-Type says so, text otherwise. */
async function readBody(
  res: Response,
  headers: Record<string, string>,
): Promise<unknown> {
  const contentType = headers["content-type"] ?? "";
  if (!contentType) return res.text();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.startsWith("text/")) return res.text();
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString("base64");
}

/**
 * Compose a URL from baseUrl + path + query. If `path` is already absolute
 * (http(s)://), we ignore baseUrl entirely. This supports catalog entries
 * that need to hit a different host for a specific endpoint (Basecamp's
 * /authorization.json lives on launchpad.37signals.com, not 3.basecampapi.com).
 */
export function composeUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  const fullUrl = /^https?:\/\//.test(path)
    ? path
    : baseUrl.replace(/\/$/, "") + path;

  if (!query || Object.keys(query).length === 0) return fullUrl;
  const url = new URL(fullUrl);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.append(k, String(v));
  }
  return url.toString();
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const call: OperationHandler<CallInput, CallOutput> = async (
  input,
  ctx,
) => {
  const parsed = CallInputSchema.parse(input);

  // 1. Resolve the service.
  const service = getService(parsed.serviceId);
  if (!service) {
    throw new IntegrationError({
      message: `universal-http: unknown serviceId '${parsed.serviceId}'. Use @delightfulchorus/service-catalog.listServiceIds() to enumerate.`,
      integration: "universal-http",
      operation: "call",
      code: "UNKNOWN_SERVICE",
      retryable: false,
    });
  }

  // 2. Resolve the operation (catalog mode) or accept ad-hoc method+path.
  let method: string;
  let pathTemplate: string;
  let opBodyContentType: "application/json" | "application/x-www-form-urlencoded" | undefined;
  let operationIdForCassette: string;

  if (parsed.operationId !== undefined) {
    const op = pickOperation(service, parsed.operationId);
    if (!op) {
      throw new IntegrationError({
        message: `universal-http: service '${parsed.serviceId}' has no operation '${parsed.operationId}'`,
        integration: "universal-http",
        operation: "call",
        code: "UNKNOWN_OPERATION",
        retryable: false,
      });
    }
    method = op.method;
    pathTemplate = op.path;
    opBodyContentType = op.bodyContentType;
    operationIdForCassette = op.id;
  } else {
    // Ad-hoc mode — Zod already enforced method+path are both present.
    method = parsed.method!;
    pathTemplate = parsed.path!;
    operationIdForCassette = "adhoc";
  }

  // 3. Pick auth type + credential. Credentials come from ctx.credentials
  //    (plaintext — decrypted by the runtime). When the credential is
  //    missing we still allow the call (some catalog entries have public
  //    endpoints), but we skip the auth header.
  const authEntry = pickAuthType(service, parsed.authTypeId);
  const credentials =
    (ctx.credentials && typeof ctx.credentials === "object"
      ? (ctx.credentials as Record<string, unknown>)
      : null) ?? null;

  // 4. Build the headers — start with caller's, inject auth.
  const outgoingHeaders: Record<string, string> = { ...(parsed.headers ?? {}) };

  // Merge path params with credential fields so auth-in-URL (Telegram) works.
  const pathParamsForTemplate: Record<string, string> = {
    ...(parsed.pathParams ?? {}),
  };
  if (credentials !== null) {
    for (const [k, v] of Object.entries(credentials)) {
      if (typeof v === "string" && !(k in pathParamsForTemplate)) {
        pathParamsForTemplate[k] = v;
      }
    }
  }

  if (authEntry !== null && authEntry.authHeader && credentials !== null) {
    try {
      const rendered = renderAuthHeader(authEntry.authHeader.format, credentials);
      // Case-insensitively avoid clobbering a caller-supplied auth header.
      const hasAuthHeader = Object.keys(outgoingHeaders).some(
        (k) => k.toLowerCase() === authEntry.authHeader!.name.toLowerCase(),
      );
      if (!hasAuthHeader) {
        outgoingHeaders[authEntry.authHeader.name] = rendered;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthError({
        message: `universal-http: failed to render auth header for service '${parsed.serviceId}' — ${message}`,
        integration: "universal-http",
        operation: "call",
      });
    }
  }

  // 5. Fill path placeholders (pathParams + credential fields, latter for
  //    auth-in-URL services like Telegram).
  let pathFilled: string;
  try {
    pathFilled = fillTemplate(pathTemplate, pathParamsForTemplate);
  } catch (err) {
    throw new IntegrationError({
      message: `universal-http: ${(err as Error).message}`,
      integration: "universal-http",
      operation: "call",
      code: "PATH_TEMPLATE_ERROR",
      retryable: false,
    });
  }

  // 6. Build the full URL (absolute path wins, otherwise baseUrl + path).
  const baseUrl =
    typeof credentials?.siteBaseUrl === "string"
      ? credentials.siteBaseUrl
      : service.baseUrl;

  const fullUrl = composeUrl(baseUrl, pathFilled, parsed.query);

  // 7. Encode the body + pick a Content-Type.
  let requestBody: string | undefined;
  if (parsed.body !== undefined) {
    const contentTypeHeader = Object.entries(outgoingHeaders).find(
      ([k]) => k.toLowerCase() === "content-type",
    );
    const effectiveContentType =
      contentTypeHeader?.[1] ?? opBodyContentType ?? "application/json";

    if (typeof parsed.body === "string") {
      requestBody = parsed.body;
    } else if (effectiveContentType.startsWith("application/x-www-form-urlencoded")) {
      // Flatten to URLSearchParams — only top-level strings/numbers/bools supported.
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(parsed.body as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        params.append(k, String(v));
      }
      requestBody = params.toString();
    } else {
      requestBody = JSON.stringify(parsed.body);
    }

    if (!contentTypeHeader) {
      outgoingHeaders["Content-Type"] = effectiveContentType;
    }
  }

  // 8. Set up timeout. Same pattern as http-generic.
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(new Error("timeout")),
    parsed.timeoutMs,
  );
  const onUpstreamAbort = (): void => {
    timeoutController.abort(ctx.signal.reason);
  };
  if (ctx.signal.aborted) {
    clearTimeout(timeoutHandle);
    throw new IntegrationError({
      message: "request cancelled before dispatch",
      integration: "universal-http",
      operation: "call",
      code: "CANCELLED",
    });
  }
  ctx.signal.addEventListener("abort", onUpstreamAbort, { once: true });

  // 9. Dispatch.
  let response: Response;
  try {
    response = await fetch(fullUrl, {
      method,
      headers: outgoingHeaders,
      body: requestBody,
      signal: timeoutController.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    ctx.signal.removeEventListener("abort", onUpstreamAbort);
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = message === "timeout" || /abort/i.test(message);
    throw new IntegrationError({
      message: timedOut
        ? `universal-http: request timed out after ${parsed.timeoutMs}ms`
        : `universal-http: network error: ${message}`,
      integration: "universal-http",
      operation: "call",
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      retryable: true,
      cause: err,
    });
  }
  clearTimeout(timeoutHandle);
  ctx.signal.removeEventListener("abort", onUpstreamAbort);

  const responseHeaders = headersToObject(response.headers);
  const responseBody = await readBody(response, responseHeaders);

  const cassetteKeyBase = `universal-http.call.${parsed.serviceId}.${operationIdForCassette}`;

  // 10. Map status → Chorus error class. Shared with http-generic patterns.
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(responseHeaders["retry-after"]);
    await ctx.snapshot?.record(
      `${cassetteKeyBase}.429`,
      { serviceId: parsed.serviceId, operationId: parsed.operationId },
      { status: 429, headers: responseHeaders },
    );
    throw new RateLimitError({
      message: `universal-http: ${parsed.serviceId} rate limit exceeded (HTTP 429)`,
      integration: "universal-http",
      operation: "call",
      httpStatus: 429,
      retryAfterMs,
    });
  }

  if (response.status === 401 || response.status === 403) {
    await ctx.snapshot?.record(
      `${cassetteKeyBase}.${response.status}`,
      { serviceId: parsed.serviceId, operationId: parsed.operationId },
      { status: response.status, headers: responseHeaders },
    );
    throw new AuthError({
      message: `universal-http: ${parsed.serviceId} HTTP ${response.status} — credential rejected`,
      integration: "universal-http",
      operation: "call",
      httpStatus: response.status,
    });
  }

  if (response.status >= 400) {
    await ctx.snapshot?.record(
      `${cassetteKeyBase}.${response.status}`,
      { serviceId: parsed.serviceId, operationId: parsed.operationId },
      { status: response.status, headers: responseHeaders, bodyShape: typeof responseBody },
    );
    throw new IntegrationError({
      message: `universal-http: ${parsed.serviceId} HTTP ${response.status}`,
      integration: "universal-http",
      operation: "call",
      code: response.status >= 500 ? "SERVER_ERROR" : "CLIENT_ERROR",
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 408,
    });
  }

  // Success — record the cassette and return.
  await ctx.snapshot?.record(
    `${cassetteKeyBase}.${response.status}`,
    { serviceId: parsed.serviceId, operationId: parsed.operationId, method },
    { status: response.status, headers: responseHeaders, bodyShape: typeof responseBody },
  );

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
};

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    call: call as OperationHandler,
  },
};

export default integration;
