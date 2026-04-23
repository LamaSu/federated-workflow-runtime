import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseYaml } from "../yaml.js";
import type { Workflow } from "@delightfulchorus/core";
import { WorkflowSchema } from "@delightfulchorus/core";
import { generateSkill, renderSkill } from "./skill.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-skill-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeWorkflow(content: string): Promise<string> {
  const p = path.join(tmpDir, "wf.yaml");
  await writeFile(p, content);
  return p;
}

function validWorkflow(
  overrides: Partial<Record<string, unknown>> = {},
): Workflow {
  const now = "2026-04-23T00:00:00Z";
  const raw = {
    id: "weekly-review",
    name: "Weekly Pipeline Review",
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes: [
      { id: "n1", integration: "github", operation: "listPullRequests" },
      { id: "n2", integration: "slack-send", operation: "postMessage" },
    ],
    connections: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return WorkflowSchema.parse(raw);
}

describe("renderSkill", () => {
  it("produces YAML frontmatter with name + description", () => {
    const content = renderSkill(validWorkflow(), "chorus-weekly-review");
    expect(content.startsWith("---\n")).toBe(true);
    const second = content.indexOf("\n---", 4);
    expect(second).toBeGreaterThan(0);
    const frontmatter = content.slice(4, second);
    const parsed = parseYaml(frontmatter) as Record<string, unknown>;
    expect(parsed.name).toBe("chorus-weekly-review");
    expect(typeof parsed.description).toBe("string");
    expect(String(parsed.description)).toMatch(/Weekly Pipeline Review/);
  });

  it("embeds the `chorus run <id>` invocation in the body", () => {
    const content = renderSkill(validWorkflow(), "chorus-weekly-review");
    expect(content).toContain("chorus run weekly-review");
  });

  it("lists each node with integration + operation", () => {
    const content = renderSkill(validWorkflow(), "chorus-weekly-review");
    expect(content).toContain("github.listPullRequests");
    expect(content).toContain("slack-send.postMessage");
  });

  it("describes a manual trigger correctly", () => {
    const content = renderSkill(validWorkflow(), "chorus-weekly-review");
    expect(content).toMatch(/manual/i);
  });

  it("describes a webhook trigger with method + path", () => {
    const wf = validWorkflow({
      trigger: { type: "webhook", method: "POST", path: "/hooks/x" },
    });
    const content = renderSkill(wf, "chorus-wf");
    expect(content).toContain("POST /hooks/x");
  });

  it("quotes description if it contains YAML-risky chars", () => {
    const wf = validWorkflow({ name: "build: system (main)" });
    const content = renderSkill(wf, "chorus-build");
    const fm = content.slice(4, content.indexOf("\n---", 4));
    const parsed = parseYaml(fm) as Record<string, unknown>;
    // Must round-trip through YAML cleanly
    expect(String(parsed.description)).toMatch(/build: system/);
  });
});

describe("generateSkill (I/O)", () => {
  it("writes SKILL.md to ./.claude/skills/chorus-<slug>/", async () => {
    const yaml = [
      "id: wf-1",
      "name: test-wf",
      "trigger:",
      "  type: manual",
      "nodes:",
      "  - id: n1",
      "    integration: http-generic",
      "    operation: request",
      "createdAt: 2026-04-23T00:00:00Z",
      "updatedAt: 2026-04-23T00:00:00Z",
      "",
    ].join("\n");
    const p = await writeWorkflow(yaml);
    const result = await generateSkill(p, { outDir: tmpDir });
    expect(result.skillName).toBe("chorus-wf-1");
    expect(result.path).toBe(
      path.join(tmpDir, "chorus-wf-1", "SKILL.md"),
    );
    const written = await readFile(result.path!, "utf8");
    expect(written).toContain("chorus run wf-1");
  });

  it("respects --name override", async () => {
    const yaml = [
      "id: wf-1",
      "name: test-wf",
      "trigger:",
      "  type: manual",
      "nodes:",
      "  - id: n1",
      "    integration: http-generic",
      "    operation: request",
      "createdAt: 2026-04-23T00:00:00Z",
      "updatedAt: 2026-04-23T00:00:00Z",
      "",
    ].join("\n");
    const p = await writeWorkflow(yaml);
    const result = await generateSkill(p, { outDir: tmpDir, name: "my-skill" });
    expect(result.skillName).toBe("my-skill");
    expect(result.path).toBe(path.join(tmpDir, "my-skill", "SKILL.md"));
  });

  it("stdout mode does not write a file", async () => {
    const yaml = [
      "id: wf-1",
      "name: test-wf",
      "trigger:",
      "  type: manual",
      "nodes: []",
      "createdAt: 2026-04-23T00:00:00Z",
      "updatedAt: 2026-04-23T00:00:00Z",
      "",
    ].join("\n");
    const p = await writeWorkflow(yaml);
    const result = await generateSkill(p, { stdout: true });
    expect(result.path).toBeNull();
    expect(result.content).toContain("chorus run wf-1");
  });

  it("throws on invalid workflow YAML", async () => {
    const p = await writeWorkflow("id: broken\n");
    await expect(generateSkill(p, { outDir: tmpDir })).rejects.toThrow(
      /invalid workflow/,
    );
  });

  it("overwrites existing SKILL.md on regeneration", async () => {
    const yaml = [
      "id: wf-1",
      "name: test-wf",
      "trigger:",
      "  type: manual",
      "nodes:",
      "  - id: n1",
      "    integration: http-generic",
      "    operation: request",
      "createdAt: 2026-04-23T00:00:00Z",
      "updatedAt: 2026-04-23T00:00:00Z",
      "",
    ].join("\n");
    const p = await writeWorkflow(yaml);
    const first = await generateSkill(p, { outDir: tmpDir });
    await writeFile(first.path!, "stale content", "utf8");
    const second = await generateSkill(p, { outDir: tmpDir });
    const written = await readFile(second.path!, "utf8");
    expect(written).toContain("chorus run wf-1");
    expect(written).not.toBe("stale content");
  });
});
