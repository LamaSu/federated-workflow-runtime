import { createHmac } from "node:crypto";

/**
 * PII / secret redaction utilities per ARCHITECTURE.md §6.2.
 *
 * Hard rules:
 *
 *   1. ALLOWLIST FIRST. Anything we are not explicitly sure is safe gets
 *      reduced to its shape. If you cannot describe why a value is safe in
 *      one sentence, it should be redacted.
 *
 *   2. FAIL CLOSED. On any ambiguity, emit `{redacted:*}` rather than risk
 *      shipping the literal value.
 *
 *   3. NO DATA FROM USER PAYLOADS SHOULD EVER APPEAR IN A REPORT. The registry
 *      receives shapes and types, never values.
 */

// Nine PII patterns from §6.2. Order matters for specificity: more specific
// patterns (JWTs, Bearer tokens) must run BEFORE generic patterns (long digit
// runs) so the specific replacement wins.
//
// Pattern numbering matches §6.2: 1.email, 2.cc, 3.phone, 4.jwt, 5.api-key,
// 6.bearer, 7.ipv4, 8.ssn, 9.aws-key — plus one bonus for long number runs
// that look like bank account / CC when the 16-digit rule misses.

/** 1. Email addresses (RFC 5322 subset). */
const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 2. Credit card numbers (13-19 digits, with or without separators). */
const CREDIT_CARD_RE =
  /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * 3. Phone numbers. Covers:
 *    - E.164 with country code:  `+1 555 123 4567`, `+44 20 7946 0958`
 *    - US 10-digit with separators: `(555) 123-4567`, `555-123-4567`, `555.123.4567`
 *    - International groupings of 2–4 digits separated by space/./- with country code.
 */
const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?\d{1,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/g;

/**
 * 4. JSON Web Tokens (three base64url segments separated by dots).
 * Header must be >= 10 chars so we don't match plain "a.b.c".
 */
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/**
 * 5. API keys. Covers the top-of-mind vendor prefixes plus a generic rule
 *    for anything resembling `<prefix>_<longpayload>` where prefix looks
 *    like a known key-marker:
 *
 *      - Stripe:    sk_live_, sk_test_, pk_live_, pk_test_, rk_live_, rk_test_
 *      - GitHub:    ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
 *      - OpenAI:    sk-
 *      - Slack:     xox[abprs]-
 *      - Google:    AIza
 *      - Anthropic: sk-ant-
 *      - Generic:   <prefix 2–12 chars>_<base62 ≥16 chars>
 */
const API_KEY_RE = new RegExp(
  [
    // Stripe / Plaid / Razorpay family
    "(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
    // OpenAI / Anthropic
    "sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
    // GitHub personal access tokens and fine-grained PATs
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{22,}",
    // Slack
    "xox[abprsu]-[A-Za-z0-9-]{10,}",
    // Google API keys
    "AIza[A-Za-z0-9_-]{20,}",
    // Generic `api_key=XXXX`, `secret=XXXX`, `token=XXXX`, `access_token=XXXX`
    "(?:api[_-]?key|secret|token|access[_-]?token|auth[_-]?token)[=:\\s][\"']?[A-Za-z0-9_-]{16,}",
  ].join("|"),
  "gi",
);

/** 6. Bearer tokens in Authorization headers or free text. */
const BEARER_RE =
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** 7. IPv4 addresses. */
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

/** 8. US Social Security numbers (NNN-NN-NNNN). */
const SSN_RE =
  /\b\d{3}-\d{2}-\d{4}\b/g;

/** 9. AWS access key IDs (begin AKIA or ASIA, 20 chars) and secret keys (40 base64). */
const AWS_KEY_ID_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const AWS_SECRET_RE = /\b[A-Za-z0-9/+=]{40}\b/g;

/**
 * Pattern pipeline. `label` is the string dropped into `{redacted:<label>}`.
 * Order is important — specific before generic.
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "email", re: EMAIL_RE },
  { label: "jwt", re: JWT_RE },
  { label: "bearer", re: BEARER_RE },
  { label: "aws-key-id", re: AWS_KEY_ID_RE },
  { label: "api-key", re: API_KEY_RE },
  { label: "ssn", re: SSN_RE },
  { label: "credit-card", re: CREDIT_CARD_RE },
  { label: "phone", re: PHONE_RE },
  { label: "ipv4", re: IPV4_RE },
  { label: "aws-secret", re: AWS_SECRET_RE },
];

/**
 * Replace every known PII / secret pattern in `s` with `{redacted:<label>}`.
 *
 * - Uses an allowlist of patterns by design; new pattern kinds should be
 *   added to `PATTERNS` with a unit test covering at least one real-world
 *   example.
 * - The returned string length is bounded by the same order of magnitude as
 *   the input (replacements are short).
 * - Idempotent: running this twice produces the same string.
 */
export function redactString(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;
  let out = s;
  for (const { label, re } of PATTERNS) {
    // Each regex already has the /g flag so String.replace handles all
    // occurrences in a single pass.
    out = out.replace(re, `{redacted:${label}}`);
  }
  return out;
}

/**
 * Return the shape (type names only) of an arbitrary value, never its value.
 *
 *   "hello"              -> "string"
 *   42                   -> "number"
 *   true                 -> "boolean"
 *   null                 -> "null"
 *   undefined            -> "undefined"
 *   [1, 2, 3]            -> "array[3]"
 *   { a: 1, b: "x" }     -> { a: "number", b: "string" }
 *   { nested: { x: 1 } } -> { nested: { x: "number" } }
 *
 * A bound maximum depth prevents runaway structures from exploding.
 */
export function extractShape(
  value: unknown,
  depth = 0,
  maxDepth = 8,
): string | Record<string, unknown> {
  if (depth > maxDepth) return "truncated";

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const t = typeof value;
  if (t === "string") return "string";
  if (t === "number") return Number.isInteger(value as number) ? "integer" : "number";
  if (t === "boolean") return "boolean";
  if (t === "bigint") return "bigint";
  if (t === "symbol") return "symbol";
  if (t === "function") return "function";

  if (Array.isArray(value)) {
    return `array[${value.length}]`;
  }

  // Handle common platform objects that shouldn't be recursed into.
  if (value instanceof Date) return "date";
  if (value instanceof RegExp) return "regexp";
  if (value instanceof Error) return "error";
  if (typeof Buffer !== "undefined" && value instanceof Buffer) return "buffer";
  if (value instanceof Map) return `map[${value.size}]`;
  if (value instanceof Set) return `set[${value.size}]`;

  // Plain objects (or class instances): recurse on own enumerable keys.
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      out[key] = extractShape(
        (value as Record<string, unknown>)[key],
        depth + 1,
        maxDepth,
      );
    }
    return out;
  }

  return "unknown";
}

/**
 * Safe HTTP headers — values are preserved because they carry operational
 * information (content type, body length, cacheability) and cannot plausibly
 * contain user secrets. Documented here so reviewers can audit the list.
 *
 * Rules for adding a header to this allowlist:
 *   1. The header MUST NOT carry authentication material in any IETF/vendor doc.
 *   2. The header MUST be useful for registry-side debugging.
 *   3. If in doubt, leave it off.
 */
const HEADER_ALLOWLIST = new Set(
  [
    // Content negotiation and size.
    "content-type",
    "content-length",
    "content-encoding",
    "content-language",
    "accept",
    "accept-encoding",
    "accept-language",
    // Cache / conditional.
    "cache-control",
    "etag",
    "last-modified",
    "vary",
    // Observability (trace IDs are not credentials).
    "x-request-id",
    "x-amzn-trace-id",
    "x-correlation-id",
    "x-trace-id",
    // Rate limit signals — the count is useful, not sensitive.
    "retry-after",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    // API version advertisement (values preserved deliberately — needed to
    // correlate errors to vendor API changes).
    "stripe-version",
    "api-version",
    "x-api-version",
    // Generic diagnostic / status
    "server",
    "date",
    "connection",
  ].map((h) => h.toLowerCase()),
);

/**
 * Redact HTTP header values.
 *
 * - Header NAMES are preserved (lowercased) — they describe what was sent,
 *   which is useful debugging context.
 * - Header VALUES are dropped for every header not in HEADER_ALLOWLIST.
 * - Allowlisted headers keep their values, but still run through the string
 *   redaction sweep (belt-and-braces — e.g. in case a trace ID contains an
 *   email by accident).
 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (typeof value !== "string") {
      out[name] = "<non-string>";
      continue;
    }
    if (HEADER_ALLOWLIST.has(name)) {
      out[name] = redactString(value);
    } else {
      out[name] = "<string>";
    }
  }
  return out;
}

/**
 * Deterministic, one-way pseudonym for a string.
 *
 * Used where we need the SAME identifier across two reports (e.g. "both of
 * these errors came from the same OAuth account, but we still don't want the
 * account id") without revealing the underlying value.
 *
 * HMAC-SHA256 with the caller-supplied `salt`, truncated to 16 hex chars.
 * 64 bits of output is plenty for the cohort-sizes we care about.
 */
export function pseudonymize(value: string, salt: string): string {
  if (typeof value !== "string") value = String(value);
  if (!salt || typeof salt !== "string") {
    throw new Error("pseudonymize requires a non-empty salt");
  }
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 16);
}
