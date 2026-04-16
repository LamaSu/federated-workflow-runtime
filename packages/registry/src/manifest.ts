/**
 * Patch manifest helpers per ARCHITECTURE.md §5.2.
 *
 * Validation is delegated to @delightfulchorus/core PatchSchema (the wire format).
 * This module adds:
 *   - validateManifest(): parse + narrow + return typed Patch (or Error, never throws)
 *   - computeContentHash(): deterministic SHA-256 of canonical JSON (signature excluded)
 *   - manifestFilename(): deterministic on-disk name used by git-store
 */

import { createHash } from "node:crypto";
import {
  PatchMetadataSchema,
  PatchSchema,
  type Patch,
  type PatchMetadata,
} from "@delightfulchorus/core";

export { PatchSchema, PatchMetadataSchema };
export type { Patch, PatchMetadata };

/**
 * Parse + validate an unknown object into a Patch.
 *
 * Returns a ZodError-wrapping `Error` on failure so callers never need a try/catch.
 * Using `safeParse` keeps this side-effect-free — important for registry ingest where
 * a single malformed manifest must not throw from deep inside a loop.
 */
export function validateManifest(obj: unknown): Patch | Error {
  const result = PatchSchema.safeParse(obj);
  if (result.success) return result.data;
  return new Error(`invalid patch manifest: ${result.error.message}`);
}

export function validateMetadata(obj: unknown): PatchMetadata | Error {
  const result = PatchMetadataSchema.safeParse(obj);
  if (result.success) return result.data;
  return new Error(`invalid patch metadata: ${result.error.message}`);
}

/**
 * Canonical JSON serialization: keys sorted recursively, no whitespace.
 *
 * This is the only serialization that MUST round-trip identically across implementations
 * — it's the input to both the signature and the content hash, so drift = tamper signal.
 * We intentionally do NOT use JSON.stringify(_, _, 0) because JSON.stringify preserves
 * insertion order, not a canonical order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * Content hash = SHA-256 of canonical JSON of the patch body (everything except the
 * signature itself). Signature covers this hash, so by definition the signature cannot
 * be part of the hash input.
 */
export function computeContentHash(patch: Patch): string {
  const { signature: _signature, ...body } = patch;
  const canonical = canonicalJson(body);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Deterministic on-disk filename for a patch manifest.
 *
 * Shape: `<YYYY-MM-DD>_<integration>_<id-slug>_<hash8>.json`
 * Matches the pattern shown in ARCHITECTURE.md §5.1 tree example.
 */
export function manifestFilename(patch: Patch): string {
  const date = patch.metadata.createdAt.slice(0, 10);
  const slug = slugify(patch.metadata.id);
  const hash8 = computeContentHash(patch).slice(0, 8);
  return `${date}_${slug}_${hash8}.json`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
