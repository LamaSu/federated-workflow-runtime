import { createHash } from "node:crypto";
import type { ErrorSignature } from "./types.js";

const PATH_NUMBER_PLACEHOLDER = "{n}";
const PATH_UUID_PLACEHOLDER = "{uuid}";
const PATH_HASH_PLACEHOLDER = "{hash}";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HASH_RE = /[0-9a-f]{24,}/gi;
const LONG_NUMBER_RE = /\d{4,}/g;
const QUOTED_VALUE_RE = /"[^"]{2,}"/g;

export function stabilizePath(path: string): string {
  return path
    .replace(UUID_RE, PATH_UUID_PLACEHOLDER)
    .replace(LONG_HASH_RE, PATH_HASH_PLACEHOLDER)
    .replace(LONG_NUMBER_RE, PATH_NUMBER_PLACEHOLDER);
}

export function stabilizeMessage(message: string): string {
  return message
    .replace(UUID_RE, "{uuid}")
    .replace(LONG_HASH_RE, "{hash}")
    .replace(QUOTED_VALUE_RE, '"{value}"')
    .replace(LONG_NUMBER_RE, "{n}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function fingerprintStack(stack: string | undefined): string {
  if (!stack) return "no-stack";
  const lines = stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .map((l) => l.replace(/\(.*?:\d+:\d+\)/, "").replace(/:\d+:\d+$/, ""))
    .slice(0, 5);
  return createHash("sha256").update(lines.join("|")).digest("hex").slice(0, 16);
}

export function hashSignature(sig: Omit<ErrorSignature, "firstSeen" | "lastSeen" | "occurrences">): string {
  const canonical = JSON.stringify({
    integration: sig.integration,
    operation: sig.operation,
    errorClass: sig.errorClass,
    httpStatus: sig.httpStatus ?? null,
    stackFingerprint: sig.stackFingerprint,
    messagePattern: sig.messagePattern,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
