/**
 * `chorus mcp <list|generate|serve|config>` — auto-MCP per integration.
 *
 * Subcommands:
 *   chorus mcp list
 *     List installed integrations and their MCP-readiness (tool counts).
 *
 *   chorus mcp generate <integration> [--out <dir>]
 *     Emit a standalone MCP server scaffold under mcp-servers/chorus-<name>/
 *     that users can register with Claude Desktop / Cursor / Zed.
 *
 *   chorus mcp serve <integration>
 *     Start an inline MCP server on stdio. Used both interactively for
 *     quick experimentation and as the scaffold's actual runtime.
 *
 *   chorus mcp config <integration>
 *     Print the .mcp.json / claude_desktop_config.json snippet for a
 *     previously-generated (or would-be-generated) scaffold. Output is
 *     pipe-friendly JSON — no ANSI colors even on a TTY, so users can
 *     `chorus mcp config slack-send | jq`.
 *
 * All subcommands share the `resolveIntegration()` loader, which walks
 * the @delightfulchorus/integration-* workspace dependency set to find the user's
 * installed integration.
 */
import path from "node:path";
import { readFile, stat, readdir } from "node:fs/promises";
import pc from "picocolors";
import type { IntegrationModule } from "@delightfulchorus/core";

export interface McpListOptions {
  cwd?: string;
  json?: boolean;
  stdout?: NodeJS.WriteStream;
  forceNoColor?: boolean;
}

export interface McpGenerateOptions {
  cwd?: string;
  integration: string;
  out?: string;
  stdout?: NodeJS.WriteStream;
  forceNoColor?: boolean;
}

export interface McpServeOptions {
  cwd?: string;
  integration: string;
}

export interface McpConfigOptions {
  cwd?: string;
  integration: string;
  out?: string;
  stdout?: NodeJS.WriteStream;
}

// ── list ────────────────────────────────────────────────────────────────────

export async function mcpList(opts: McpListOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? process.stdout;
  const color_on = useColor(opts, out);

  const integrations = await discoverIntegrations(cwd);
  if (opts.json) {
    const summary = await Promise.all(
      integrations.map(async (i) => {
        try {
          const mod = await loadIntegration(cwd, i.name);
          const { manifestToMcpTools } = await import("@delightfulchorus/mcp");
          const tools = manifestToMcpTools(mod.manifest);
          return {
            integration: i.name,
            packageName: i.packageName,
            version: mod.manifest.version,
            operations: mod.manifest.operations.length,
            tools: tools.length,
            authType: mod.manifest.authType,
          };
        } catch (err) {
          return {
            integration: i.name,
            packageName: i.packageName,
            error: (err as Error).message,
          };
        }
      }),
    );
    out.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  if (integrations.length === 0) {
    out.write(
      paint("No integrations installed.", "dim", color_on) +
        `\n  Install one with: npm i @delightfulchorus/integration-slack-send\n`,
    );
    return 0;
  }

  out.write(paint("MCP-ready integrations:", "bold", color_on) + "\n");
  for (const i of integrations) {
    try {
      const mod = await loadIntegration(cwd, i.name);
      const { manifestToMcpTools } = await import("@delightfulchorus/mcp");
      const tools = manifestToMcpTools(mod.manifest);
      const opCount = mod.manifest.operations.length;
      const credCount = tools.length - opCount;
      out.write(
        `  ${paint(i.name, "cyan", color_on)} ${paint(
          `v${mod.manifest.version}`,
          "dim",
          color_on,
        )}  ${opCount} ops + ${credCount} credential tools = ${tools.length} MCP tools\n`,
      );
    } catch (err) {
      out.write(
        `  ${paint(i.name, "cyan", color_on)}  ${paint(
          `(failed to load: ${(err as Error).message})`,
          "red",
          color_on,
        )}\n`,
      );
    }
  }
  return 0;
}

// ── generate ────────────────────────────────────────────────────────────────

export async function mcpGenerate(opts: McpGenerateOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? process.stdout;
  const color_on = useColor(opts, out);

  // Validate the integration is loadable before we write files.
  try {
    await loadIntegration(cwd, opts.integration);
  } catch (err) {
    process.stderr.write(
      paint(
        `error: cannot load integration '${opts.integration}': ${(err as Error).message}\n`,
        "red",
        color_on,
      ),
    );
    return 2;
  }

  const outDir =
    opts.out ?? path.join(cwd, "mcp-servers", `chorus-${opts.integration}`);
  const { generateMcpServer } = await import("@delightfulchorus/mcp");
  const result = await generateMcpServer({
    integration: opts.integration,
    outDir,
  });

  out.write(
    `${paint("✓", "green", color_on)} generated ${paint(
      result.path,
      "cyan",
      color_on,
    )}\n\n`,
  );
  out.write(paint("Next steps:", "bold", color_on) + "\n");
  out.write(`  1. ${paint("cd", "dim", color_on)} ${result.path}\n`);
  out.write(`     ${paint("npm install", "dim", color_on)}\n\n`);
  out.write(`  2. Register with your MCP client. Paste this into the client's config:\n\n`);
  for (const line of result.configSnippet.trimEnd().split("\n")) {
    out.write(`     ${line}\n`);
  }
  out.write(
    `\n  3. ${paint("(optional)", "dim", color_on)} test the server locally: chorus mcp serve ${opts.integration}\n`,
  );
  return 0;
}

// ── serve ───────────────────────────────────────────────────────────────────

export async function mcpServe(opts: McpServeOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  let mod: IntegrationModule;
  try {
    mod = await loadIntegration(cwd, opts.integration);
  } catch (err) {
    process.stderr.write(
      `error: cannot load integration '${opts.integration}': ${(err as Error).message}\n`,
    );
    return 2;
  }
  const { serveIntegration } = await import("@delightfulchorus/mcp");
  // Write a single startup line to stderr so the MCP client's log shows
  // that we connected. Stdout is reserved for the JSON-RPC stream.
  process.stderr.write(
    `chorus-mcp: serving ${opts.integration}@${mod.manifest.version} over stdio\n`,
  );
  try {
    await serveIntegration({ integration: mod });
    return 0;
  } catch (err) {
    process.stderr.write(
      `chorus-mcp fatal: ${(err as Error).stack ?? (err as Error).message}\n`,
    );
    return 1;
  }
}

// ── config ──────────────────────────────────────────────────────────────────

export async function mcpConfig(opts: McpConfigOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? process.stdout;
  const outDir =
    opts.out ?? path.join(cwd, "mcp-servers", `chorus-${opts.integration}`);
  const { generateMcpServer } = await import("@delightfulchorus/mcp");
  // dryRun so we never write files — we only want the snippet.
  const result = await generateMcpServer({
    integration: opts.integration,
    outDir,
    dryRun: true,
  });
  out.write(result.configSnippet);
  return 0;
}

// ── Integration discovery / loading ─────────────────────────────────────────

interface InstalledIntegration {
  /** Short name: "slack-send", "http-generic". Used in tool names. */
  name: string;
  /** Full npm package name: "@delightfulchorus/integration-slack-send". */
  packageName: string;
}

const INTEGRATION_PREFIX = "integration-";

/**
 * Find installed Chorus integrations by walking `node_modules/@delightfulchorus/` and
 * filtering for packages whose short name starts with `integration-`.
 * This mirrors the pattern the runtime uses at cold-start — keep in sync.
 * Monorepo roots are preferred (walks up until it finds a node_modules with
 * @chorus inside).
 */
async function discoverIntegrations(
  cwd: string,
): Promise<InstalledIntegration[]> {
  const root = await findIntegrationsRoot(cwd);
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result: InstalledIntegration[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(INTEGRATION_PREFIX)) continue;
    // Each entry's package.json gives the full name.
    const pkgPath = path.join(root, entry.name, "package.json");
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        name?: string;
      };
      if (typeof pkg.name !== "string") continue;
      const short = entry.name.slice(INTEGRATION_PREFIX.length);
      result.push({ name: short, packageName: pkg.name });
    } catch {
      // Entry isn't a package; skip.
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

async function findIntegrationsRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, "node_modules", "@chorus");
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Load an installed integration's IntegrationModule. Tries, in order:
 *   1. `@delightfulchorus/integration-<name>` — the canonical shape
 *   2. `chorus-integration-<name>` — community convention
 *
 * Resolution strategy: walk up from `cwd` to find a `node_modules/<spec>/`
 * with a readable package.json. This works for workspace installs
 * (where the integration is a sibling workspace not declared in the root
 * package.json's deps), for deep installs, AND for the canonical
 * "user's project npm i @delightfulchorus/integration-*" case. `createRequire`
 * would fail the first case because npm workspaces don't hoist sibling
 * packages into the parent's dependency graph.
 */
async function loadIntegration(
  cwd: string,
  name: string,
): Promise<IntegrationModule> {
  const candidates = [
    `@delightfulchorus/integration-${name}`,
    `chorus-integration-${name}`,
  ];
  let lastErr: unknown;
  for (const spec of candidates) {
    try {
      const entry = await findIntegrationEntryPoint(cwd, spec);
      if (!entry) continue;
      const mod = (await import(pathToFileUrl(entry))) as {
        default?: IntegrationModule;
      } & IntegrationModule;
      const integration = (mod.default ?? mod) as IntegrationModule;
      if (!integration.manifest || !integration.operations) {
        throw new Error(
          `module '${spec}' does not export a valid IntegrationModule (missing manifest/operations)`,
        );
      }
      return integration;
    } catch (err) {
      lastErr = err;
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `no integration named '${name}' is installed. Tried: ${candidates.join(
      ", ",
    )}. Last error: ${message}`,
  );
}

/**
 * Walk up from `cwd` looking for `<current>/node_modules/<spec>/package.json`.
 * Returns the absolute path to the package's entry file (respecting `main`
 * or `exports['.']`) if found, else null.
 */
async function findIntegrationEntryPoint(
  cwd: string,
  spec: string,
): Promise<string | null> {
  let current = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const pkgJson = path.join(current, "node_modules", spec, "package.json");
    try {
      const raw = await readFile(pkgJson, "utf8");
      const pkg = JSON.parse(raw) as {
        main?: string;
        module?: string;
        exports?: unknown;
      };
      const entry = resolvePackageEntry(pkg);
      if (!entry) return null;
      return path.resolve(path.dirname(pkgJson), entry);
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Resolve a package entry file from its package.json. Handles three common
 * shapes: `main`, `exports['.']` (string), `exports['.'].import` (conditional).
 * Falls back to `module` then `./index.js`.
 */
function resolvePackageEntry(pkg: {
  main?: string;
  module?: string;
  exports?: unknown;
}): string | null {
  if (pkg.exports && typeof pkg.exports === "object") {
    const exp = pkg.exports as Record<string, unknown>;
    const dot = exp["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const conditional = dot as { import?: string; default?: string };
      if (typeof conditional.import === "string") return conditional.import;
      if (typeof conditional.default === "string") return conditional.default;
    }
  }
  if (typeof pkg.main === "string") return pkg.main;
  if (typeof pkg.module === "string") return pkg.module;
  return "./index.js";
}

/** Convert an absolute filesystem path to a file:// URL for `import()`. */
function pathToFileUrl(absPath: string): string {
  // On Windows, a path like C:\foo\bar needs to become file:///C:/foo/bar.
  const normalized = absPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) return `file:///${normalized}`;
  return `file://${normalized}`;
}

// ── Color utilities ─────────────────────────────────────────────────────────

function useColor(
  opts: { forceNoColor?: boolean },
  out: NodeJS.WriteStream,
): boolean {
  if (opts.forceNoColor) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(out.isTTY);
}

function paint(text: string, color: keyof typeof pc | null, color_on: boolean): string {
  if (!color_on || color == null) return text;
  const fn = pc[color] as unknown;
  if (typeof fn === "function") {
    return (fn as (s: string) => string)(text);
  }
  return text;
}
