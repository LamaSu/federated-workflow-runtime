/**
 * Tests for `chorus ui --editor`.
 *
 * The template lives at packages/cli/static/editor-template.html and is
 * loaded via readFile from bundledTemplatePath(). Since vitest resolves
 * relative to src/commands/, the dev path in the command resolves to the
 * real template on disk — no test-specific fixture needed.
 *
 * We cover:
 *   - Basic generation from an in-memory workflow.
 *   - Placeholder substitution (all 7 placeholders replaced).
 *   - Drawflow CDN scripts present.
 *   - Transform JS inlined.
 *   - Style override via --style flag.
 *   - Integration discovery fallback when runtime isn't up.
 *   - Rendered HTML is plausibly well-formed (balanced tags).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Workflow } from "@delightfulchorus/core";
import { runUiEditor, applyTemplate } from "./ui-editor.js";

function sampleWorkflow(): Workflow {
  return {
    id: "sample-flow",
    name: "Sample Flow",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes: [
      {
        id: "fetch",
        integration: "http-generic",
        operation: "request",
        config: { url: "https://example.com", method: "GET" },
        onError: "retry",
      },
      {
        id: "notify",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#alerts" },
        onError: "retry",
      },
    ],
    connections: [{ from: "fetch", to: "notify" }],
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  };
}

/**
 * Build a tiny chorus project directory with the given workflow.ts. Returns
 * the project's absolute cwd so the test can pass it into runUiEditor.
 */
async function makeProject(wf: Workflow): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chorus-ui-editor-"));
  const chorusDir = path.join(dir, "chorus");
  await mkdir(chorusDir, { recursive: true });
  const body = [
    'import type { Workflow } from "@delightfulchorus/core";',
    "",
    "const workflow: Workflow = ",
    JSON.stringify(wf, null, 2),
    ";",
    "",
    "export default workflow;",
    "",
  ].join("\n");
  await writeFile(path.join(chorusDir, `${wf.id}.ts`), body, "utf8");
  // Also write a copy as JSON so the tests that expect a JSON path work.
  await writeFile(path.join(chorusDir, `${wf.id}.json`), JSON.stringify(wf), "utf8");
  return dir;
}

describe("ui-editor — applyTemplate", () => {
  const template = [
    "name={{WORKFLOW_NAME}}",
    "id={{WORKFLOW_ID}}",
    "json=<script>{{WORKFLOW_JSON}}</script>",
    "integrations={{INTEGRATIONS_HTML}}",
    "style={{STYLE}}",
    "api={{API_BASE}}",
    "transform=<script>{{TRANSFORM_JS}}</script>",
  ].join("\n");

  it("substitutes every placeholder in one pass", () => {
    const wf = sampleWorkflow();
    const out = applyTemplate(template, {
      workflow: wf,
      integrations: [{ name: "slack-send", operations: ["postMessage"] }],
      style: "solarpunk terminal",
      apiBase: "http://127.0.0.1:3710",
    });
    expect(out).not.toContain("{{WORKFLOW_NAME}}");
    expect(out).not.toContain("{{WORKFLOW_ID}}");
    expect(out).not.toContain("{{WORKFLOW_JSON}}");
    expect(out).not.toContain("{{INTEGRATIONS_HTML}}");
    expect(out).not.toContain("{{STYLE}}");
    expect(out).not.toContain("{{API_BASE}}");
    expect(out).not.toContain("{{TRANSFORM_JS}}");
    expect(out).toContain("name=Sample Flow");
    expect(out).toContain("id=sample-flow");
    expect(out).toContain("style=solarpunk terminal");
    expect(out).toContain("api=http://127.0.0.1:3710");
    // Palette has the draggable element for slack-send.postMessage.
    expect(out).toContain('data-integration="slack-send"');
    expect(out).toContain('data-operation="postMessage"');
  });

  it("escapes < in workflow JSON to prevent </script> breakout", () => {
    const wf = sampleWorkflow();
    // Synthesize a "< in a string" scenario.
    wf.nodes[0]!.config!.note = "<script>alert(1)</script>";
    const out = applyTemplate(template, {
      workflow: wf,
      integrations: [],
      style: "",
      apiBase: "http://x",
    });
    // The workflow JSON block must not contain a literal </script>.
    expect(out).not.toContain("</script>alert");
    // It should contain the safe < encoding instead.
    expect(out).toContain("\\u003c");
  });

  it("falls back to a default style description when style is blank", () => {
    const wf = sampleWorkflow();
    const out = applyTemplate(template, {
      workflow: wf,
      integrations: [],
      style: "",
      apiBase: "http://x",
    });
    expect(out).toContain("clean inspector-panel look");
  });
});

describe("ui-editor — runUiEditor", () => {
  it("generates editor HTML from a chorus/<slug>.ts workflow (dry run)", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        integrations: [{ name: "slack-send", operations: ["postMessage"] }],
        silent: true,
      });
      expect(result.workflow.id).toBe(wf.id);
      expect(result.html).toContain("<!doctype html>");
      // Template includes the two required Drawflow CDN lines.
      expect(result.html).toContain("cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.css");
      expect(result.html).toContain("cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.js");
      // Inlined transform is present.
      expect(result.html).toContain("chorusTransform");
      expect(result.html).toContain("chorusToDrawflow");
      expect(result.html).toContain("drawflowToChorus");
      // Workflow JSON embedded in a tagged <script>.
      expect(result.html).toContain('<script id="workflow-json" type="application/json">');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes editor-<slug>.html when dryRun is false", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        integrations: [],
        silent: true,
      });
      expect(result.filePath).toBeTruthy();
      const st = await stat(result.filePath!);
      expect(st.isFile()).toBe(true);
      const content = await readFile(result.filePath!, "utf8");
      expect(content).toContain("<!doctype html>");
      expect(content).toContain(wf.name);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("honors --style override and substitutes into the template", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        style: "solarpunk terminal, warm green on cream",
        dryRun: true,
        integrations: [],
        silent: true,
      });
      expect(result.html).toContain("solarpunk terminal, warm green on cream");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads from a .json file path when source ends with .json", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const jsonPath = path.join(cwd, "chorus", `${wf.id}.json`);
      const result = await runUiEditor({
        workflow: jsonPath,
        cwd,
        dryRun: true,
        integrations: [],
        silent: true,
      });
      expect(result.workflow.id).toBe(wf.id);
      expect(result.html).toContain("Sample Flow");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to local integration scan when runtime is down", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    // Populate a fake integrations/ tree.
    const intDir = path.join(cwd, "integrations");
    for (const name of ["http-generic", "slack-send", "llm-anthropic"]) {
      await mkdir(path.join(intDir, name), { recursive: true });
      await writeFile(
        path.join(intDir, name, "package.json"),
        JSON.stringify({ name: `@delightfulchorus/integration-${name}`, version: "0.0.1" }),
        "utf8",
      );
    }
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        silent: true,
        fetch: (async () => {
          // Simulate an unreachable runtime.
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
      });
      // All three integrations appear in the rendered HTML.
      expect(result.html).toContain('data-integration="http-generic"');
      expect(result.html).toContain('data-integration="slack-send"');
      expect(result.html).toContain('data-integration="llm-anthropic"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("pulls integrations from /api/integrations when the runtime is up", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        silent: true,
        fetch: (async (url: string) => {
          if (url.endsWith("/api/integrations")) {
            return new Response(
              JSON.stringify({
                integrations: [
                  { name: "http-generic", runCount: 10, errorCount: 0, patchCount: 0, credentialCount: 0, lastUsedAt: null },
                  { name: "slack-send", runCount: 5, errorCount: 0, patchCount: 0, credentialCount: 1, lastUsedAt: null },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("not found", { status: 404 });
        }) as unknown as typeof fetch,
      });
      expect(result.html).toContain('data-integration="http-generic"');
      expect(result.html).toContain('data-integration="slack-send"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads a workflow by id from the runtime when no local file exists", async () => {
    const wf = sampleWorkflow();
    // Intentionally DON'T write a local chorus/<id>.ts.
    const cwd = await mkdtemp(path.join(tmpdir(), "chorus-ui-editor-runtime-"));
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        integrations: [],
        silent: true,
        fetch: (async (url: string) => {
          if (url.endsWith(`/api/workflows/${wf.id}`)) {
            return new Response(
              JSON.stringify({ workflow: { ...wf, definition: wf } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("not found", { status: 404 });
        }) as unknown as typeof fetch,
      });
      expect(result.workflow.id).toBe(wf.id);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rendered HTML has balanced <script> / </script> pairs", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        integrations: [],
        silent: true,
      });
      const opens = (result.html.match(/<script\b/gi) ?? []).length;
      const closes = (result.html.match(/<\/script>/gi) ?? []).length;
      expect(opens).toBe(closes);
      expect(opens).toBeGreaterThanOrEqual(3); // cdn + json + body + transform
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rendered HTML embeds the Workflow JSON such that JSON.parse recovers it", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        integrations: [],
        silent: true,
      });
      // Extract the <script id="workflow-json"> contents and JSON.parse them.
      const m = result.html.match(/<script id="workflow-json"[^>]*>([\s\S]*?)<\/script>/);
      expect(m).toBeTruthy();
      const jsonText = m![1]!.replace(/\\u003c/g, "<");
      const parsed = JSON.parse(jsonText);
      expect(parsed.id).toBe(wf.id);
      expect(parsed.nodes.length).toBe(wf.nodes.length);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("template includes the required Drawflow CDN lines", async () => {
    const wf = sampleWorkflow();
    const cwd = await makeProject(wf);
    try {
      const result = await runUiEditor({
        workflow: wf.id,
        cwd,
        dryRun: true,
        integrations: [],
        silent: true,
      });
      expect(result.html).toMatch(
        /href="https:\/\/cdn\.jsdelivr\.net\/gh\/jerosoler\/Drawflow\/dist\/drawflow\.min\.css"/,
      );
      expect(result.html).toMatch(
        /src="https:\/\/cdn\.jsdelivr\.net\/gh\/jerosoler\/Drawflow\/dist\/drawflow\.min\.js"/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
