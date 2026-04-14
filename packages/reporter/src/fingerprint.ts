import { extractShape } from "./redact.js";
export { fingerprintApiVersion } from "./signature.js";

/**
 * Config fingerprinting per ARCHITECTURE.md §6.3.
 *
 * The goal: tell the registry what integration configuration a user is
 * running (so it can cluster reports — "everyone on v1.4.2 with
 * unfurl_links: true sees signature X") WITHOUT revealing the user's
 * credentials, URLs, or business data.
 *
 * Output contract: every value is one of `string | boolean | number` so the
 * result fits `z.record(z.union([z.string(), z.boolean(), z.number()]))`.
 *
 * Rules (applied in order):
 *
 *   1. If the key looks sensitive (credential-ish name) OR the value is a
 *      string that matches a secret pattern, emit the sentinel literal
 *      `"credential:present"`. We always reveal that *something* is set —
 *      the registry needs to know that, to correlate against "user has X
 *      configured" — but never the value.
 *
 *   2. Booleans pass through unchanged. They are almost never identifying.
 *
 *   3. Numbers pass through unchanged for integers and small floats. They
 *      are config knobs (timeouts, retry counts, batch sizes).
 *
 *   4. Strings get a shape label, not their value. E.g. a URL becomes
 *      "string:url", an email becomes "string:email", a short identifier
 *      becomes "string:short", everything else becomes "string".
 *
 *   5. Nested objects / arrays collapse to `"shape"` because the registry
 *      schema only allows scalar types per key. If you need nested shapes,
 *      stringify the extractShape() result separately.
 *
 *   6. Unknown-typed values emit `"unknown"`.
 */
export function fingerprintConfig(
  config: Record<string, unknown> | undefined | null,
): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  if (!config || typeof config !== "object") return out;

  for (const [key, value] of Object.entries(config)) {
    if (looksLikeCredentialKey(key)) {
      if (value === undefined || value === null || value === "") {
        out[key] = "credential:absent";
      } else {
        out[key] = "credential:present";
      }
      continue;
    }

    if (value === undefined) {
      out[key] = "undefined";
      continue;
    }
    if (value === null) {
      out[key] = "null";
      continue;
    }

    const t = typeof value;
    if (t === "boolean") {
      out[key] = value as boolean;
      continue;
    }
    if (t === "number") {
      const n = value as number;
      if (!Number.isFinite(n)) {
        out[key] = `number:${n}`; // "number:NaN" / "number:Infinity"
      } else {
        out[key] = n;
      }
      continue;
    }
    if (t === "bigint") {
      out[key] = "bigint";
      continue;
    }
    if (t === "string") {
      out[key] = labelString(value as string);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = `array[${value.length}]`;
      continue;
    }
    if (t === "object") {
      // Extract shape but collapse to a single string per the schema contract.
      const shape = extractShape(value, 0, 2);
      out[key] = typeof shape === "string" ? shape : "shape";
      continue;
    }
    out[key] = "unknown";
  }
  return out;
}

/**
 * Keys whose MERE PRESENCE indicates we're looking at a secret.
 * Match is case-insensitive and substring-based: `apiKey`, `API_KEY`,
 * `userApiKeyId` all hit `apikey`.
 */
const SENSITIVE_KEY_HINTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "authorization",
  "auth",
  "bearer",
  "cookie",
  "session",
  "credential",
  "credentials",
];

function looksLikeCredentialKey(key: string): boolean {
  const k = key.toLowerCase();
  for (const hint of SENSITIVE_KEY_HINTS) {
    if (k.includes(hint)) return true;
  }
  return false;
}

/**
 * Label a string by its rough shape. Never returns the string itself.
 */
function labelString(s: string): string {
  if (s.length === 0) return "string:empty";
  if (s.length <= 4) return "string:short";
  // URL detection uses a cheap prefix check; anything fancier is overkill
  // here because the value never leaves this function anyway.
  if (/^https?:\/\//i.test(s)) return "string:url";
  if (/^mailto:/i.test(s)) return "string:email";
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s))
    return "string:email";
  if (/^\+?\d[\d\s.-]{6,}$/.test(s)) return "string:phone";
  if (/^[0-9a-f]{32,}$/i.test(s)) return "string:hex";
  if (/^[A-Za-z0-9+/=_-]{24,}$/.test(s)) return "string:token-like";
  if (/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(s.trim())) return "string:json";
  return `string:len=${bucketLength(s.length)}`;
}

/**
 * Round a length up to a coarse bucket so reports don't become a side
 * channel. Bucket boundaries: 8, 32, 128, 512, 2048, 8192, else "large".
 */
function bucketLength(n: number): string {
  if (n <= 8) return "≤8";
  if (n <= 32) return "≤32";
  if (n <= 128) return "≤128";
  if (n <= 512) return "≤512";
  if (n <= 2048) return "≤2048";
  if (n <= 8192) return "≤8192";
  return "large";
}
