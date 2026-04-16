import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ErrorSignature, IntegrationManifest } from "@delightfulchorus/core";
import type { Cassette, RepairContext, SourceFile } from "./types.js";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  "coverage",
  "__cassettes__",
]);

/** Hard cap on source file content we feed Claude: ~80k chars (~20k tokens). */
const MAX_SOURCE_CHARS = 80_000;
/** Max per-file size before we truncate with a marker. */
const MAX_FILE_CHARS = 30_000;
/** Max cassettes to include. */
const MAX_CASSETTES = 5;
/** Max vendor-doc length. */
const MAX_VENDOR_DOC_CHARS = 50_000;

export interface AssembleContextOptions {
  integrationDir: string;
  cassetteDir: string;
  vendorDocsCache?: string;
  /** Override defaults. */
  maxSourceChars?: number;
  maxCassettes?: number;
}

/**
 * Gather the full repair context for one error signature.
 *
 * - Reads integration source files from `integrationDir`
 * - Tries to read the integration manifest (package.json)
 * - Loads recent cassettes from `cassetteDir` (most recent first, cap at N)
 * - Optionally loads a cached vendor-docs text file
 *
 * Missing vendor docs / missing manifest degrade gracefully (return null for that field).
 */
export async function assembleRepairContext(
  sig: ErrorSignature,
  opts: AssembleContextOptions,
): Promise<RepairContext> {
  const integrationDir = opts.integrationDir;
  const maxSourceChars = opts.maxSourceChars ?? MAX_SOURCE_CHARS;
  const maxCassettes = opts.maxCassettes ?? MAX_CASSETTES;

  const [sourceFiles, manifest, cassettes, vendorDocs] = await Promise.all([
    collectSourceFiles(integrationDir, maxSourceChars),
    loadManifest(integrationDir),
    loadRecentCassettes(opts.cassetteDir, sig.integration, maxCassettes),
    opts.vendorDocsCache ? loadVendorDocs(opts.vendorDocsCache) : Promise.resolve(null),
  ]);

  return {
    error: sig,
    manifest,
    sourceFiles,
    integrationDir,
    cassettes,
    vendorDocs,
  };
}

async function collectSourceFiles(
  root: string,
  budget: number,
): Promise<SourceFile[]> {
  const files: string[] = [];
  await walk(root, root, files);
  // Deterministic ordering so repeated context assembly produces the same prompt
  // (matters for prompt caching).
  files.sort();

  const out: SourceFile[] = [];
  let used = 0;
  for (const abs of files) {
    if (used >= budget) break;
    let contents: string;
    try {
      contents = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (contents.length > MAX_FILE_CHARS) {
      contents =
        contents.slice(0, MAX_FILE_CHARS) +
        `\n/* ... truncated (${contents.length - MAX_FILE_CHARS} chars) ... */`;
    }
    if (used + contents.length > budget) {
      const remaining = budget - used;
      if (remaining < 500) break;
      contents = contents.slice(0, remaining) + "\n/* ... truncated (budget) ... */";
    }
    const relPath = toPosix(relative(root, abs));
    out.push({ relPath, contents });
    used += contents.length;
  }
  return out;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walk(root, abs, out);
    } else if (ent.isFile()) {
      const dot = ent.name.lastIndexOf(".");
      const ext = dot < 0 ? "" : ent.name.slice(dot);
      if (SOURCE_EXTS.has(ext)) out.push(abs);
    }
  }
}

async function loadManifest(integrationDir: string): Promise<IntegrationManifest | null> {
  // Try Chorus integration manifest pattern: package.json + src/index.ts exports
  // For repair purposes we read package.json metadata; the integration's defineIntegration()
  // call lives in source but parsing it fully is a job for @delightfulchorus/sdk — out of scope here.
  const candidate = join(integrationDir, "package.json");
  try {
    const raw = await readFile(candidate, "utf8");
    const pkg = JSON.parse(raw) as {
      name?: string;
      version?: string;
      description?: string;
      chorus?: Partial<IntegrationManifest>;
    };
    // If the package.json carries a `chorus` block, prefer that.
    if (pkg.chorus && pkg.chorus.name && pkg.chorus.version) {
      return pkg.chorus as IntegrationManifest;
    }
    if (!pkg.name || !pkg.version) return null;
    // Best-effort synthetic manifest from package metadata.
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description ?? "",
      authType: "none",
      credentialTypes: [],
      operations: [],
    } satisfies IntegrationManifest;
  } catch {
    return null;
  }
}

async function loadRecentCassettes(
  cassetteDir: string,
  integration: string,
  max: number,
): Promise<Cassette[]> {
  let entries;
  try {
    entries = await readdir(cassetteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(cassetteDir, e.name));

  // Stat + sort by mtime desc
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(f);
        return { file: f, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const sorted = stats
    .filter((s): s is { file: string; mtime: number } => s !== null)
    .sort((a, b) => b.mtime - a.mtime);

  const out: Cassette[] = [];
  for (const { file } of sorted) {
    if (out.length >= max) break;
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      const cas = normalizeCassette(parsed, file);
      if (!cas) continue;
      if (cas.integration && cas.integration !== integration) continue;
      out.push(cas);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function normalizeCassette(raw: unknown, sourcePath: string): Cassette | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const interaction = r.interaction as Record<string, unknown> | undefined;
  if (!interaction) return null;
  const request = interaction.request as Record<string, unknown> | undefined;
  const response = interaction.response as Record<string, unknown> | undefined;
  if (!request || !response) return null;

  const method = (request.method as string | undefined) ?? "GET";
  const urlTemplate = (request.urlTemplate as string | undefined) ?? "";
  const status = typeof response.status === "number" ? response.status : 0;
  if (!urlTemplate || status === 0) return null;

  const id = (r.id as string | undefined) ?? deriveCassetteId(sourcePath);
  const integration = (r.integration as string | undefined) ?? "";
  const signatureHash = r.signatureHash as string | undefined;
  const timestamp = (r.timestamp as string | undefined) ?? new Date(0).toISOString();
  const durationMs = typeof r.durationMs === "number" ? r.durationMs : 0;
  const succeeded = status >= 200 && status < 400;

  return {
    id,
    integration,
    signatureHash,
    interaction: {
      request: {
        method: method as Cassette["interaction"]["request"]["method"],
        urlTemplate,
        headerNames: (request.headerNames as string[] | undefined) ?? [],
        bodyShape: request.bodyShape,
      },
      response: {
        status,
        headerNames: (response.headerNames as string[] | undefined) ?? [],
        bodyShape: response.bodyShape,
        bodySnippet: response.bodySnippet as string | undefined,
      },
    },
    timestamp,
    durationMs,
    succeeded,
  };
}

function deriveCassetteId(path: string): string {
  const sepIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep));
  const base = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;
  return base.replace(/\.json$/, "");
}

async function loadVendorDocs(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.length > MAX_VENDOR_DOC_CHARS) {
      return raw.slice(0, MAX_VENDOR_DOC_CHARS) + "\n... [truncated]";
    }
    return raw;
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}
