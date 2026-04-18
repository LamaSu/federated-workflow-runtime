/**
 * LLM-generated dashboard HTML — optional enhancement.
 *
 * When `ANTHROPIC_API_KEY` is set, we make a single Haiku call after server
 * startup, ask the model to generate a custom dashboard tailored to the
 * loaded workflows, and swap `getDashboardHtml()` to serve that new HTML.
 *
 * Hard invariants:
 *
 *   1. Generation is fire-and-forget. NEVER blocks the server from
 *      listening. The minimal dashboard is the always-available fallback.
 *   2. We use built-in `fetch` (Node 18+) — no @anthropic-ai/sdk dep.
 *   3. Cache by a hash of the workflow set. A restart reuses the cached
 *      HTML unless the workflows changed. Cache dir:
 *      `<cwd>/.chorus-cache/dashboard-<hash>.html`.
 *   4. The prompt tells the model to return ONE self-contained HTML
 *      block (no CDN, no external fonts). We strip the code fence if
 *      present and verify it looks HTML-ish before swapping.
 *   5. Custom prompts (from the MCP `generate_dashboard` tool) override
 *      the default instructions but still go through the same pipeline.
 *
 * Why Haiku: fast + cheap. The task is explicit about `claude-haiku-4-5`.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Workflow } from "@delightfulchorus/core";
import { setDashboard } from "./static/holder.js";
import { MINIMAL_HTML } from "./static/index.js";

/** Haiku snapshot the task pins us to. */
export const DEFAULT_MODEL = "claude-haiku-4-5";
/** Where the Anthropic API call lands. */
export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
/** Anthropic API version header. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** Cache dir relative to cwd. */
export const CACHE_DIR_NAME = ".chorus-cache";

export interface GenerateDashboardOptions {
  /** Workflows currently loaded on this server — drives the cache key + prompt. */
  workflows: Workflow[];
  /**
   * Base URL the runtime is listening on. Embedded into the prompt so
   * the generated HTML can wire fetches to the correct origin. Example:
   * "http://127.0.0.1:3710".
   */
  displayUrl: string;
  /**
   * Optional override for the main instruction block. When supplied
   * (e.g. from the MCP `generate_dashboard` tool), it replaces the
   * default "build a workflow-tailored dashboard" prompt.
   */
  customPrompt?: string;
  /** Overridden for tests; defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Overridden for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Overridden for tests; defaults to process.cwd(). */
  cwd?: string;
  /**
   * Bypass the on-disk cache — the MCP tool sets this so each custom
   * prompt always produces fresh output. The default (false) prefers
   * cached HTML when the workflow set is unchanged.
   */
  noCache?: boolean;
  /**
   * Model override; defaults to DEFAULT_MODEL ("claude-haiku-4-5").
   */
  model?: string;
  /**
   * Max tokens in the response. The generated HTML is usually well under
   * 20k chars, so 8192 is a generous cap.
   */
  maxTokens?: number;
}

export interface GenerateDashboardResult {
  /** Whether a dashboard was actually produced. */
  ok: boolean;
  /** The HTML that was swapped in (or null if we fell back silently). */
  html: string | null;
  /** `cache` if reused, `generated` if fresh, `skipped` if no key/no-op. */
  source: "cache" | "generated" | "skipped" | "error";
  /** URL-safe hash of the workflow set (or `"custom"` if a prompt override was given). */
  cacheKey: string | null;
  /** Short human-readable message — surfaced in logs but never thrown. */
  message: string;
}

/**
 * Try to produce an LLM-tailored dashboard. Safe to `void`-call: never
 * throws, never blocks, always resolves. Swaps the active dashboard via
 * `setDashboard()` on success.
 */
export async function maybeGenerateDashboard(
  opts: GenerateDashboardOptions,
): Promise<GenerateDashboardResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      html: null,
      source: "skipped",
      cacheKey: null,
      message: "ANTHROPIC_API_KEY not set — minimal dashboard will be used",
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const cacheKey = opts.customPrompt
    ? `custom-${hashString(opts.customPrompt)}`
    : hashWorkflowSet(opts.workflows);
  const cacheDir = path.join(cwd, CACHE_DIR_NAME);
  const cachePath = path.join(cacheDir, `dashboard-${cacheKey}.html`);

  if (!opts.noCache) {
    const cached = await readCached(cachePath);
    if (cached) {
      setDashboard(cached);
      return {
        ok: true,
        html: cached,
        source: "cache",
        cacheKey,
        message: `reused cached dashboard (${cacheKey})`,
      };
    }
  }

  const prompt = buildPrompt(opts);
  try {
    const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
    if (!fetchFn) {
      return {
        ok: false,
        html: null,
        source: "skipped",
        cacheKey,
        message: "no fetch available (Node < 18 or polyfill missing)",
      };
    }
    const res = await fetchFn(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: opts.maxTokens ?? 8192,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await safeText(res);
      return {
        ok: false,
        html: null,
        source: "error",
        cacheKey,
        message: `anthropic http ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const raw = extractText(body);
    const html = extractHtml(raw);
    if (!html) {
      return {
        ok: false,
        html: null,
        source: "error",
        cacheKey,
        message: "response did not contain HTML",
      };
    }
    // Persist + swap atomically-ish.
    await mkdir(cacheDir, { recursive: true }).catch(() => {});
    await writeFile(cachePath, html, "utf8").catch(() => {});
    setDashboard(html);
    return {
      ok: true,
      html,
      source: "generated",
      cacheKey,
      message: `generated dashboard via ${opts.model ?? DEFAULT_MODEL}`,
    };
  } catch (err) {
    return {
      ok: false,
      html: null,
      source: "error",
      cacheKey,
      message: `generation failed: ${errorMessage(err)}`,
    };
  }
}

/**
 * Build the prompt we send to the model. The default is "look at these
 * workflows + the API manifest and build a dashboard tailored to them";
 * a `customPrompt` (from `generate_dashboard` MCP tool) replaces the
 * default instructions. We always append the workflow summary + base
 * URL so every prompt has the same context.
 */
export function buildPrompt(opts: GenerateDashboardOptions): string {
  const context = [
    `Base URL: ${opts.displayUrl}`,
    `Workflow count: ${opts.workflows.length}`,
    `Workflows:`,
    ...opts.workflows
      .slice(0, 20)
      .map(
        (w) =>
          `- id=${w.id} name=${w.name} trigger=${w.trigger.type} nodes=${w.nodes.length}`,
      ),
  ].join("\n");

  const defaultInstructions = `You are generating a single-file HTML dashboard for Chorus, a local
read-only workflow runtime. The dashboard will be served at the base
URL below; it should fetch that origin's /api/manifest, /api/workflows,
/api/runs, /api/errors, /api/patches, /api/integrations endpoints.

STRICT RULES:
- Return ONE <!doctype html> HTML document. No prose before or after.
- Inline CSS, inline JavaScript (vanilla fetch). NO external CDN, fonts, analytics.
- Must work offline and over file:// if the user opens it locally.
- Must remain under 30KB uncompressed.
- Poll /api/runs every 2 seconds, /api/errors every 10 seconds, pause on document.hidden.
- Show a "lost connection" banner when fetches fail; retry on click.
- Color palette: warm cream background (#f5f0e1), dark text (#2a2a2a), olive for success (#5c6b3d), amber for running (#b57d1d), red for failed (#8b2f2f).
- Monospace font stack: ui-monospace, Menlo, Consolas.
- The "ambient" target: user just opened this because chorus run auto-opened it. Surface the things they NEED right now — which workflows are loaded, what's running, what's failing, error signatures. Skip explanatory text; they see the dashboard every day.

TAILORING:
- If all workflows share a trigger type (e.g. all webhooks), prioritize that info.
- If there are fewer than 3 workflows, show them prominently with status per workflow.
- If there are many workflows, show a summary card + a runs feed.

Return only the HTML. No markdown fences.`;

  const instructions = opts.customPrompt?.trim() || defaultInstructions;
  return `${instructions}

--- CONTEXT ---
${context}
`;
}

/** Produce a deterministic cache key for the current workflow set. */
export function hashWorkflowSet(workflows: Workflow[]): string {
  const normalized = workflows
    .map((w) => `${w.id}@${w.version}:${w.trigger.type}:${w.nodes.length}`)
    .sort()
    .join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Shorter hash for arbitrary strings (used for custom-prompt cache keys). */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function readCached(p: string): Promise<string | null> {
  try {
    const body = await readFile(p, "utf8");
    if (body && body.trim().toLowerCase().startsWith("<!doctype")) return body;
    return null;
  } catch {
    return null;
  }
}

function extractText(body: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (!body || !Array.isArray(body.content)) return "";
  return body.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/**
 * Pull the HTML out of the model's response. Accept either a raw
 * doctype-prefixed response OR a fenced ```html block. Return null if
 * neither is present.
 */
export function extractHtml(raw: string): string | null {
  if (!raw) return null;
  const fenceMatch = raw.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.toLowerCase().startsWith("<!doctype")) return inner;
  }
  const lower = raw.toLowerCase();
  const start = lower.indexOf("<!doctype");
  if (start < 0) return null;
  const tail = raw.slice(start).trim();
  return tail || null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-export the minimal HTML as the canonical fallback (for tests). */
export { MINIMAL_HTML };
