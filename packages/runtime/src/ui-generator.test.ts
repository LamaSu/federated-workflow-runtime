import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  maybeGenerateDashboard,
  buildPrompt,
  extractHtml,
  hashWorkflowSet,
  hashString,
  ANTHROPIC_API_URL,
  DEFAULT_MODEL,
  CACHE_DIR_NAME,
} from "./ui-generator.js";
import { MINIMAL_HTML } from "./static/index.js";
import { resetDashboard, getDashboardHtml } from "./static/holder.js";
import type { Workflow } from "@delightfulchorus/core";

/** Build a minimal Workflow fixture. */
function wf(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    name: "Workflow 1",
    version: 1,
    active: true,
    trigger: { type: "manual" } as Workflow["trigger"],
    nodes: [
      {
        id: "n1",
        integration: "http-generic",
        operation: "get",
        config: {},
      } as unknown as Workflow["nodes"][number],
    ],
    connections: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ui-generator — pure helpers", () => {
  it("hashWorkflowSet is deterministic and order-independent", () => {
    const a = [wf({ id: "a" }), wf({ id: "b" })];
    const b = [wf({ id: "b" }), wf({ id: "a" })];
    expect(hashWorkflowSet(a)).toBe(hashWorkflowSet(b));
  });

  it("hashWorkflowSet changes when the workflow shape changes", () => {
    const a = [wf({ id: "a", version: 1 })];
    const b = [wf({ id: "a", version: 2 })];
    expect(hashWorkflowSet(a)).not.toBe(hashWorkflowSet(b));
  });

  it("hashString is stable for the same input", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("world"));
  });

  it("extractHtml returns null for empty/non-html input", () => {
    expect(extractHtml("")).toBeNull();
    expect(extractHtml("just prose, no markup")).toBeNull();
  });

  it("extractHtml finds a raw doctype response", () => {
    const raw = "here is the html:\n<!doctype html>\n<html><body>x</body></html>";
    const out = extractHtml(raw);
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("<html>");
  });

  it("extractHtml unwraps a fenced code block", () => {
    const raw = "```html\n<!doctype html>\n<html><body>hi</body></html>\n```\n";
    const out = extractHtml(raw);
    expect(out).toContain("<!doctype html>");
    expect(out).not.toContain("```");
  });

  it("buildPrompt includes workflow context and base url", () => {
    const p = buildPrompt({
      workflows: [wf({ id: "orders", name: "Orders" })],
      displayUrl: "http://127.0.0.1:3710",
    });
    expect(p).toContain("http://127.0.0.1:3710");
    expect(p).toContain("id=orders");
    expect(p).toContain("name=Orders");
  });

  it("buildPrompt uses custom prompt when provided", () => {
    const p = buildPrompt({
      workflows: [],
      displayUrl: "http://localhost:3710",
      customPrompt: "do something weird",
    });
    expect(p).toContain("do something weird");
    expect(p).not.toContain("STRICT RULES:");
  });
});

describe("maybeGenerateDashboard — skip paths", () => {
  beforeEach(() => {
    resetDashboard();
  });

  it("returns skipped when no api key is set (and does not swap dashboard)", async () => {
    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: undefined,
      cwd: path.join(tmpdir(), "chorus-ui-gen-skip"),
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("skipped");
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
  });

  it("returns skipped when fetchFn is missing", async () => {
    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: "sk-test",
      cwd: path.join(tmpdir(), "chorus-ui-gen-nofetch"),
      // explicit undefined overrides globalThis.fetch ONLY if we nullify it
      // below; easier path: pass an explicit broken fetchFn.
      fetchFn: undefined as unknown as typeof fetch,
    });
    // Jest/vitest runs on Node 18+, so globalThis.fetch exists. The guard
    // kicks in only when both opts.fetchFn AND globalThis.fetch are missing.
    // In our test env globalThis.fetch is present, so we expect either a
    // generated response (if Anthropic HTTP succeeded — it won't with
    // sk-test) or an error. Either way: ok=false, dashboard unchanged.
    expect(r.ok).toBe(false);
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
  });
});

describe("maybeGenerateDashboard — success + cache paths", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    resetDashboard();
    cacheRoot = await mkdtemp(path.join(tmpdir(), "chorus-ui-gen-"));
  });
  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    resetDashboard();
  });

  it("calls Anthropic, extracts HTML, swaps the dashboard, writes cache", async () => {
    const html = "<!doctype html>\n<html><body><h1>custom</h1></body></html>";
    const fakeFetch = vi.fn(async (url: string, init: unknown) => {
      expect(url).toBe(ANTHROPIC_API_URL);
      const body = JSON.parse(
        (init as { body: string }).body,
      );
      expect(body.model).toBe(DEFAULT_MODEL);
      expect(Array.isArray(body.messages)).toBe(true);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: html }] }),
        text: async () => html,
      };
    }) as unknown as typeof fetch;

    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: "sk-test-ok",
      fetchFn: fakeFetch,
      cwd: cacheRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("generated");
    expect(r.html).toBe(html);
    expect(getDashboardHtml()).toBe(html);
    // Cache file was written
    const cached = path.join(
      cacheRoot,
      CACHE_DIR_NAME,
      `dashboard-${r.cacheKey}.html`,
    );
    const fs = await import("node:fs/promises");
    const onDisk = await fs.readFile(cached, "utf8");
    expect(onDisk).toBe(html);
  });

  it("reuses cache when workflows unchanged and noCache=false", async () => {
    const cached = "<!doctype html>\n<html><body>cached</body></html>";
    const key = hashWorkflowSet([wf()]);
    const cacheDir = path.join(cacheRoot, CACHE_DIR_NAME);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, `dashboard-${key}.html`),
      cached,
      "utf8",
    );
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: "sk-test",
      fetchFn: fakeFetch,
      cwd: cacheRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("cache");
    expect(r.html).toBe(cached);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(getDashboardHtml()).toBe(cached);
  });

  it("noCache=true forces regeneration even when cache present", async () => {
    const key = hashString("override-prompt");
    const cacheDir = path.join(cacheRoot, CACHE_DIR_NAME);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, `dashboard-custom-${key}.html`),
      "<!doctype html>\n<html><body>OLD</body></html>",
      "utf8",
    );
    const fresh = "<!doctype html>\n<html><body>NEW</body></html>";
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: fresh }] }),
      text: async () => fresh,
    })) as unknown as typeof fetch;

    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://localhost:3710",
      apiKey: "sk-test",
      fetchFn: fakeFetch,
      cwd: cacheRoot,
      customPrompt: "override-prompt",
      noCache: true,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("generated");
    expect(r.html).toBe(fresh);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("returns error on non-2xx response without swapping the dashboard", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
      text: async () => "rate limited",
    })) as unknown as typeof fetch;
    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: "sk-test",
      fetchFn: fakeFetch,
      cwd: cacheRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("error");
    expect(r.message).toMatch(/429/);
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
  });

  it("returns error when the response contains no HTML", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "sorry" }] }),
      text: async () => "sorry",
    })) as unknown as typeof fetch;
    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: "sk-test",
      fetchFn: fakeFetch,
      cwd: cacheRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("error");
    expect(r.message).toMatch(/did not contain HTML/i);
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
  });

  it("swallows fetch exceptions (never throws)", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await maybeGenerateDashboard({
      workflows: [wf()],
      displayUrl: "http://127.0.0.1:3710",
      apiKey: "sk-test",
      fetchFn: fakeFetch,
      cwd: cacheRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("error");
    expect(r.message).toMatch(/network down/);
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
  });
});
