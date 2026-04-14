/**
 * Git-backed patch store using simple-git.
 *
 * Layout mirrors ARCHITECTURE.md §5.1:
 *   <root>/
 *     revoked.json
 *     integrations/
 *       <integration>/
 *         patches/
 *           <manifestFilename>.json
 *         cassettes/
 *           <signature-hash>.cassette.json
 *
 * Write semantics: `writePatch` writes the file + `git add`s it but does NOT commit.
 * The caller (CLI, CI, or scripted maintainer) picks the commit moment — this is
 * because real use often batches multiple patches per PR, and forced auto-commits
 * would make that impossible.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Patch, PatchMetadata } from "@chorus/core";
import { manifestFilename, validateManifest } from "./manifest.js";

export interface GitStoreOptions {
  /** Optional: override the simple-git instance (tests use this to stub). */
  git?: SimpleGit;
}

/** Clone a registry into `localPath`. Creates parent dirs as needed. */
export async function cloneRegistry(
  url: string,
  localPath: string,
  opts: GitStoreOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  const git = opts.git ?? simpleGit();
  await git.clone(url, localPath);
}

/** `git pull` on the given local clone. */
export async function pullLatest(localPath: string, opts: GitStoreOptions = {}): Promise<void> {
  const git = opts.git ?? simpleGit(localPath);
  await git.pull();
}

/**
 * Read a single patch by integration + patch id.
 *
 * We do not require the caller to know the exact manifest filename — we glob the
 * `patches/` dir and pick the file whose `metadata.id` matches. On-disk filename is
 * deterministic (see manifestFilename) but includes a content hash that the caller
 * typically does not have.
 */
export async function readPatch(
  localPath: string,
  integration: string,
  patchId: string,
): Promise<Patch> {
  const dir = patchesDir(localPath, integration);
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(dir, entry), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const patch = validateManifest(parsed);
    if (patch instanceof Error) continue; // skip broken manifests on read
    if (patch.metadata.id === patchId) return patch;
  }
  throw new Error(`patch not found: ${integration}/${patchId}`);
}

/**
 * List patches — for the whole registry or one integration.
 *
 * Returns metadata only (the diff is the heavy part and callers iterating for a
 * picker/UI don't need it). Broken manifests are skipped, not thrown — this is a
 * poll path, a single bad patch shouldn't blow up the caller.
 */
export async function listPatches(
  localPath: string,
  integration?: string,
): Promise<PatchMetadata[]> {
  const integrations = integration
    ? [integration]
    : await listIntegrations(localPath);
  const out: PatchMetadata[] = [];
  for (const i of integrations) {
    const dir = patchesDir(localPath, i);
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const patch = validateManifest(parsed);
      if (patch instanceof Error) continue;
      out.push(patch.metadata);
    }
  }
  return out;
}

/**
 * Write a patch to its canonical location, then `git add` it.
 *
 * Callers MUST commit (`git commit`) separately. We deliberately don't commit because:
 *   - Multiple patches land in one PR.
 *   - Tests control their own commit boundaries.
 *   - Commit authorship must match the signing identity; we don't know the caller's git config.
 */
export async function writePatch(
  localPath: string,
  patch: Patch,
  opts: GitStoreOptions = {},
): Promise<void> {
  const dir = patchesDir(localPath, patch.metadata.integration);
  await fs.mkdir(dir, { recursive: true });
  const filename = manifestFilename(patch);
  const filePath = path.join(dir, filename);
  const payload = JSON.stringify(patch, null, 2) + "\n";
  await fs.writeFile(filePath, payload, "utf8");

  const git = opts.git ?? simpleGit(localPath);
  // Path must be relative to the repo root for `git add`.
  const rel = path.relative(localPath, filePath);
  await git.add(rel);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────

function patchesDir(localPath: string, integration: string): string {
  return path.join(localPath, "integrations", integration, "patches");
}

async function listIntegrations(localPath: string): Promise<string[]> {
  const root = path.join(localPath, "integrations");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
