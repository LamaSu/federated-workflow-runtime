/**
 * `chorus ui --editor` — emit a single-file Drawflow-based workflow editor.
 *
 * This command generates a standalone HTML file from a workflow source
 * (TypeScript file, JSON template, or a live runtime `/api/workflows/:id`).
 * The output embeds Drawflow via jsDelivr CDN and inlines the
 * Chorus <-> Drawflow transform so the browser can round-trip workflows
 * without any build step.
 *
 * Design decisions:
 *   - Offline-first: if the runtime isn't running, we parse a local .ts
 *     or .json file and scan `integrations/` for the palette. Live API is
 *     a convenience, not a dependency.
 *   - Template-based by default: placeholders in
 *     packages/cli/static/editor-template.html are substituted with the
 *     concrete workflow + integrations + style. An optional --prompt flag
 *     routes through an LLM (via the same Vercel AI SDK path as
 *     `chorus compose`) to customize aesthetics.
 *   - Transform parity: the browser copy of drawflow-transform is literally
 *     INLINED_TRANSFORM_JS — we don't re-derive it from the TS source. The
 *     drawflow-transform tests pin parity with the Node-side copy.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pc from "picocolors";
import { WorkflowSchema, type Workflow } from "@delightfulchorus/core";
import { INLINED_TRANSFORM_JS } from "../lib/drawflow-transform.js";

export interface UiEditorOptions {
  /**
   * Source for the workflow to edit. Accepts either:
   *   - a path to a .ts or .json file in the project's chorus/ directory,
   *   - a workflow id (resolved against the running runtime via /api/workflows),
   *   - a full http(s):// URL to any JSON endpoint returning a Workflow.
   */
  workflow: string;
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Output file path. Defaults to ./editor-<slug>.html. */
  out?: string;
  /** Override API base for runtime fetches. */
  apiBase?: string;
  /** CSS-ready aesthetic description. Substituted into {{STYLE}}. */
  style?: string;
  /**
   * Optional natural-language tweak. When present, the HTML is generated
   * via the LLM using ui-editor-system.ts instead of the static template.
   * Deferred to when the model is required; non-tests can hit the same
   * lazy-loader `chorus compose` uses.
   */
  prompt?: string;
  /** Suppress writes to stdout (tests). */
  silent?: boolean;
  /** Skip filesystem side effects and return the rendered HTML (tests). */
  dryRun?: boolean;
  /** Allow tests to inject an integration list. */
  integrations?: Array<{ name: string; operations: string[] }>;
  /** Allow tests to stub the runtime fetch. */
  fetch?: typeof fetch;
}

export interface UiEditorResult {
  /** Absolute path of the generated HTML file (when dryRun is false). */
  filePath: string | null;
  /** The fully rendered HTML. */
  html: string;
  /** The workflow that was loaded into the editor. */
  workflow: Workflow;
  /** Integrations discovered for the sidebar palette. */
  integrations: Array<{ name: string; operations: string[] }>;
}

const TEMPLATE_ENV_VAR = "CHORUS_EDITOR_TEMPLATE_PATH";

/**
 * Resolve the base template on disk. Mirrors `ui.ts`'s dual-path approach
 * (dev src/ layout + bundled dist/ layout) so `npm install -g` works and
 * tests (running via tsx) work.
 */
function bundledTemplatePath(): string {
  const override = process.env[TEMPLATE_ENV_VAR];
  if (override && override.length > 0) return override;
  const thisFile = fileURLToPath(import.meta.url);
  const hereDir = path.dirname(thisFile);
  // dev:     packages/cli/src/commands/ui-editor.ts -> packages/cli/static/editor-template.html
  // bundled: packages/cli/dist/cli.js               -> packages/cli/static/editor-template.html
  const devCandidate = path.resolve(hereDir, "../../static/editor-template.html");
  const distCandidate = path.resolve(hereDir, "../static/editor-template.html");
  if (existsSync(devCandidate)) return devCandidate;
  if (existsSync(distCandidate)) return distCandidate;
  return devCandidate;
}

/** Run the editor generator. Deterministic given inputs. */
export async function runUiEditor(options: UiEditorOptions): Promise<UiEditorResult> {
  const cwd = options.cwd ?? process.cwd();
  const apiBase = options.apiBase ?? "http://127.0.0.1:3710";

  // 1. Resolve the workflow source -> parsed Workflow.
  const workflow = await loadWorkflow(options.workflow, { cwd, apiBase, fetchFn: options.fetch });

  // 2. Integrations palette: inject > live API > scan.
  const integrations = options.integrations
    ?? (await discoverIntegrations({ cwd, apiBase, fetchFn: options.fetch }));

  // 3. Render HTML from template (or LLM if --prompt provided).
  const html = options.prompt
    ? await renderViaLlm({ workflow, integrations, style: options.style ?? "", apiBase, prompt: options.prompt })
    : await renderViaTemplate({ workflow, integrations, style: options.style ?? "", apiBase });

  // 4. Write output (or return for tests).
  if (options.dryRun) {
    return { filePath: null, html, workflow, integrations };
  }
  const outPath = options.out ?? path.join(cwd, `editor-${workflow.id}.html`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  if (!options.silent) {
    process.stdout.write(
      `${pc.green("✓")} Wrote ${outPath} (${workflow.nodes.length} node${
        workflow.nodes.length === 1 ? "" : "s"
      })\n   ${pc.dim(`Open in a browser: file://${outPath.replace(/\\/g, "/")}`)}\n`,
    );
  }
  return { filePath: outPath, html, workflow, integrations };
}

/**
 * Commander-facing entrypoint. Returns an exit code.
 */
export async function uiEditorCommand(options: UiEditorOptions): Promise<number> {
  try {
    await runUiEditor(options);
    return 0;
  } catch (err) {
    process.stderr.write(pc.red(`ui --editor: ${(err as Error).message}\n`));
    return 1;
  }
}

// ── Workflow loading ────────────────────────────────────────────────────────

interface LoadCtx {
  cwd: string;
  apiBase: string;
  fetchFn?: typeof fetch;
}

async function loadWorkflow(source: string, ctx: LoadCtx): Promise<Workflow> {
  // HTTP/HTTPS URL: fetch directly.
  if (/^https?:\/\//i.test(source)) {
    return fetchWorkflow(source, ctx.fetchFn);
  }
  // Absolute or relative .ts file.
  if (source.endsWith(".ts") || source.endsWith(".js") || source.endsWith(".mjs")) {
    const abs = path.isAbsolute(source) ? source : path.resolve(ctx.cwd, source);
    return loadWorkflowFromTs(abs);
  }
  // .json file (either Chorus template or a raw workflow export).
  if (source.endsWith(".json")) {
    const abs = path.isAbsolute(source) ? source : path.resolve(ctx.cwd, source);
    const raw = await readFile(abs, "utf8");
    return parseWorkflowJson(raw);
  }
  // Bare identifier: first try chorus/<id>.ts locally, then the runtime API.
  const localTs = path.join(ctx.cwd, "chorus", `${source}.ts`);
  if (existsSync(localTs)) {
    return loadWorkflowFromTs(localTs);
  }
  const localJson = path.join(ctx.cwd, "chorus", `${source}.json`);
  if (existsSync(localJson)) {
    const raw = await readFile(localJson, "utf8");
    return parseWorkflowJson(raw);
  }
  const url = `${ctx.apiBase}/api/workflows/${encodeURIComponent(source)}`;
  try {
    return await fetchWorkflow(url, ctx.fetchFn);
  } catch (err) {
    throw new Error(
      `could not resolve workflow '${source}' — not found at chorus/${source}.ts, chorus/${source}.json, or ${url} (${(err as Error).message})`,
    );
  }
}

async function fetchWorkflow(url: string, fetchFn?: typeof fetch): Promise<Workflow> {
  const f = fetchFn ?? fetch;
  const res = await f(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const body = (await res.json()) as { workflow?: { definition?: unknown } } & Record<string, unknown>;
  // Two shapes: { workflow: { definition: Workflow } } from /api/workflows/:id,
  // or a bare Workflow from a shared template / user JSON.
  if (body.workflow && typeof body.workflow === "object") {
    const def = (body.workflow as { definition?: unknown }).definition ?? body.workflow;
    return WorkflowSchema.parse(def);
  }
  return WorkflowSchema.parse(body);
}

async function loadWorkflowFromTs(absPath: string): Promise<Workflow> {
  // tsx is already in the CLI's transitive dev deps; we reuse the same
  // pattern as chorus compose's test harness — dynamic import via
  // file:// URL. Works for both .ts (when tsx is the loader) and .js.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  const mod = (await dynamicImport(pathToFileURL(absPath).href)) as {
    default?: unknown;
  };
  const raw = mod.default ?? mod;
  return WorkflowSchema.parse(raw);
}

function parseWorkflowJson(raw: string): Workflow {
  const obj = JSON.parse(raw) as { workflow?: unknown };
  // Template format from `chorus share`: { workflow: {...}, template: true }.
  const body = obj.workflow && typeof obj.workflow === "object" ? obj.workflow : obj;
  return WorkflowSchema.parse(body);
}

// ── Integration discovery ───────────────────────────────────────────────────

async function discoverIntegrations(ctx: LoadCtx): Promise<Array<{ name: string; operations: string[] }>> {
  // First try the live runtime: it knows what's actually installed and
  // their usage counts, even if no package.json is on disk.
  try {
    const f = ctx.fetchFn ?? fetch;
    const res = await f(`${ctx.apiBase}/api/integrations`);
    if (res.ok) {
      const body = (await res.json()) as { integrations?: Array<{ name: string }> };
      const names = (body.integrations ?? []).map((i) => i.name);
      // /api/integrations doesn't surface operation names (it'd be a schema
      // change). We pair the live names with whatever operations we can
      // still glean from the local integrations/ directory (if present).
      const scanned = await scanLocalIntegrations(ctx.cwd);
      const opsByName = new Map(scanned.map((s) => [s.name, s.operations]));
      return names.map((name) => ({
        name,
        operations: opsByName.get(name) ?? DEFAULT_OPERATIONS[name] ?? ["run"],
      }));
    }
  } catch {
    // fall through
  }
  return scanLocalIntegrations(ctx.cwd);
}

/**
 * Map of last-resort operation names for integrations whose package.json
 * doesn't declare them via a readable manifest (because the manifest is
 * TypeScript code, not plain JSON). Keeps the sidebar populated even when
 * the runtime isn't up and we can't parse the integration packages.
 */
const DEFAULT_OPERATIONS: Record<string, string[]> = {
  "http-generic": ["request"],
  "slack-send": ["postMessage"],
  "gmail-send": ["sendMessage"],
  "llm-anthropic": ["generate", "generateObject"],
  "llm-openai": ["generate", "generateObject"],
  "llm-gemini": ["generate", "generateObject"],
  "postgres-query": ["query"],
  "stripe-charge": ["createCharge"],
  "mcp-proxy": ["call"],
  "universal-http": ["request"],
  agent: ["run"],
};

async function scanLocalIntegrations(cwd: string): Promise<Array<{ name: string; operations: string[] }>> {
  const integrationsDir = path.join(cwd, "integrations");
  if (!existsSync(integrationsDir)) {
    // Fallback: return the DEFAULT_OPERATIONS set so the palette is
    // still populated when run against a scaffolded project with no
    // integrations/ directory (common in fresh installs).
    return Object.entries(DEFAULT_OPERATIONS).map(([name, operations]) => ({
      name,
      operations,
    }));
  }
  const entries = await readdir(integrationsDir, { withFileTypes: true });
  const out: Array<{ name: string; operations: string[] }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgPath = path.join(integrationsDir, e.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        name?: string;
        description?: string;
      };
      // Convention: integration packages name themselves
      // @delightfulchorus/integration-<slug>. Prefer the directory name
      // (matches the `integration` field on a Node).
      const integrationName = e.name;
      // Operations: prefer the static DEFAULT_OPERATIONS map; that matches
      // the compose-system prompt's expectations and avoids asking us to
      // parse TS.
      const operations = DEFAULT_OPERATIONS[integrationName] ?? ["run"];
      out.push({ name: integrationName, operations });
      void pkg; // pkg.description can become a tooltip later
    } catch {
      // skip unreadable package.json
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Rendering ───────────────────────────────────────────────────────────────

interface RenderCtx {
  workflow: Workflow;
  integrations: Array<{ name: string; operations: string[] }>;
  style: string;
  apiBase: string;
}

async function renderViaTemplate(ctx: RenderCtx): Promise<string> {
  const templatePath = bundledTemplatePath();
  const template = await readFile(templatePath, "utf8");
  return applyTemplate(template, ctx);
}

/**
 * Apply placeholders to the template. Kept as its own export so tests
 * can pin the exact placeholder contract.
 */
export function applyTemplate(template: string, ctx: RenderCtx): string {
  const integrationsHtml = renderIntegrationsHtml(ctx.integrations);
  const styleText = ctx.style && ctx.style.trim().length > 0
    ? ctx.style.trim()
    : "clean inspector-panel look";
  const workflowJson = JSON.stringify(ctx.workflow);
  const substitutions: Record<string, string> = {
    "{{WORKFLOW_NAME}}": escapeForHtmlText(ctx.workflow.name),
    "{{WORKFLOW_ID}}": escapeForHtmlText(ctx.workflow.id),
    // Embedded in <script type="application/json">, so < must be escaped
    // to prevent the browser from interpreting </script>.
    "{{WORKFLOW_JSON}}": workflowJson.replace(/</g, "\\u003c"),
    "{{INTEGRATIONS_HTML}}": integrationsHtml,
    "{{STYLE}}": escapeForHtmlText(styleText),
    "{{API_BASE}}": ctx.apiBase,
    "{{TRANSFORM_JS}}": INLINED_TRANSFORM_JS,
  };
  let out = template;
  for (const [key, value] of Object.entries(substitutions)) {
    // Global replace without regex DoS risk — the keys are literal.
    out = out.split(key).join(value);
  }
  return out;
}

function renderIntegrationsHtml(integrations: Array<{ name: string; operations: string[] }>): string {
  const items: string[] = [];
  for (const i of integrations) {
    for (const op of i.operations) {
      items.push(
        `<li draggable="true" data-integration="${escapeForHtmlAttr(i.name)}" data-operation="${escapeForHtmlAttr(op)}">${escapeForHtmlText(i.name)}<span style="color:var(--muted);font-weight:400">.${escapeForHtmlText(op)}</span></li>`,
      );
    }
  }
  if (items.length === 0) return '<li class="hint">No integrations found.</li>';
  return items.join("\n      ");
}

function escapeForHtmlText(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}
function escapeForHtmlAttr(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── Optional LLM rendering ──────────────────────────────────────────────────

/**
 * When the user supplies --prompt, we delegate to an LLM via the same
 * Vercel AI SDK plumbing as `chorus compose`. The LLM receives
 * UI_EDITOR_SYSTEM_PROMPT + the user's tweak and returns a complete
 * single-file HTML.
 *
 * Lazy-imported so tests that never pass --prompt don't load the SDK.
 */
async function renderViaLlm(args: {
  workflow: Workflow;
  integrations: Array<{ name: string; operations: string[] }>;
  style: string;
  apiBase: string;
  prompt: string;
}): Promise<string> {
  const [systemPromptMod, sdk, anthropic] = await Promise.all([
    import("../prompts/ui-editor-system.js"),
    loadAiSdk(),
    loadAnthropic(),
  ]);
  const systemPrompt = systemPromptMod.UI_EDITOR_SYSTEM_PROMPT.replace(
    /\{\{STYLE\}\}/g,
    args.style && args.style.trim().length > 0 ? args.style.trim() : "clean inspector-panel look",
  );
  const userMessage = [
    args.prompt,
    "",
    "Workflow to embed (already valid Chorus JSON):",
    JSON.stringify(args.workflow, null, 2),
    "",
    "Integrations for the sidebar (JSON):",
    JSON.stringify(args.integrations),
    "",
    "API base URL:",
    args.apiBase,
    "",
    "INLINED_TRANSFORM_JS (copy verbatim into a <script>):",
    "---",
    INLINED_TRANSFORM_JS,
    "---",
  ].join("\n");
  const result = await sdk.generateText({
    model: anthropic("claude-opus-4-7"),
    system: systemPrompt,
    prompt: userMessage,
  });
  const text = (result as { text: string }).text;
  // Strip a leading code fence if the model wrapped the HTML in one.
  const html = stripCodeFence(text);
  return html;
}

function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! : trimmed;
}

async function loadAiSdk(): Promise<{ generateText: (args: unknown) => Promise<unknown> }> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  const mod = (await dynamicImport("ai")) as {
    generateText?: (args: unknown) => Promise<unknown>;
  };
  if (!mod.generateText) {
    throw new Error("ui-editor: 'ai' package did not export generateText");
  }
  return { generateText: mod.generateText };
}

async function loadAnthropic(): Promise<(id: string) => unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  const mod = (await dynamicImport("@ai-sdk/anthropic")) as {
    anthropic?: (id: string) => unknown;
  };
  if (!mod.anthropic) throw new Error("ui-editor: '@ai-sdk/anthropic' missing anthropic()");
  return mod.anthropic;
}
