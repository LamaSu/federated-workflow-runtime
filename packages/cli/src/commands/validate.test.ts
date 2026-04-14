import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateWorkflowFile } from "./validate.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-validate-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Helper to write a workflow file. Returns its absolute path.
 */
async function writeWorkflow(filename: string, content: string): Promise<string> {
  const p = path.join(tmpDir, filename);
  await writeFile(p, content);
  return p;
}

describe("validateWorkflowFile", () => {
  it("accepts a valid minimal workflow", async () => {
    const now = new Date().toISOString();
    const yaml = [
      "id: wf-1",
      "name: test-workflow",
      "version: 1",
      "active: true",
      "trigger:",
      "  type: manual",
      "nodes:",
      "  - id: n1",
      "    integration: http-generic",
      "    operation: request",
      "    config:",
      "      url: https://example.test/a",
      `createdAt: ${now}`,
      `updatedAt: ${now}`,
      "",
    ].join("\n");
    const p = await writeWorkflow("wf.yaml", yaml);
    const result = await validateWorkflowFile(p);
    if (!result.valid) {
      console.error(result.errors);
    }
    expect(result.valid).toBe(true);
    expect(result.workflow?.name).toBe("test-workflow");
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid webhook trigger", async () => {
    const yaml = [
      "id: wf-2",
      "name: webhook-wf",
      "trigger:",
      "  type: webhook",
      "  path: /hooks/test",
      "  method: POST",
      "nodes:",
      "  - id: n1",
      "    integration: slack-send",
      "    operation: postMessage",
      "createdAt: 2026-04-13T00:00:00Z",
      "updatedAt: 2026-04-13T00:00:00Z",
      "",
    ].join("\n");
    const p = await writeWorkflow("wf.yaml", yaml);
    const result = await validateWorkflowFile(p);
    expect(result.valid).toBe(true);
  });

  it("rejects a workflow missing required fields", async () => {
    const yaml = "id: broken\n"; // no name, trigger, nodes, dates
    const p = await writeWorkflow("bad.yaml", yaml);
    const result = await validateWorkflowFile(p);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // Should mention the missing fields with path
    const joined = result.errors.join("\n");
    expect(joined).toMatch(/name/);
  });

  it("rejects a workflow with an invalid trigger type", async () => {
    const yaml = [
      "id: wf-3",
      "name: bad-trigger",
      "trigger:",
      "  type: bogus",
      "nodes: []",
      "createdAt: 2026-04-13T00:00:00Z",
      "updatedAt: 2026-04-13T00:00:00Z",
      "",
    ].join("\n");
    const p = await writeWorkflow("bad.yaml", yaml);
    const result = await validateWorkflowFile(p);
    expect(result.valid).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toMatch(/trigger/);
  });

  it("reports file-not-found with a clear message", async () => {
    const result = await validateWorkflowFile(path.join(tmpDir, "nope.yaml"));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/cannot read file/);
  });

  it("accepts JSON workflows (same schema)", async () => {
    const obj = {
      id: "wf-json",
      name: "json-wf",
      version: 1,
      trigger: { type: "manual" },
      nodes: [
        {
          id: "n1",
          integration: "http-generic",
          operation: "request",
        },
      ],
      createdAt: "2026-04-13T00:00:00Z",
      updatedAt: "2026-04-13T00:00:00Z",
    };
    const p = await writeWorkflow("wf.json", JSON.stringify(obj));
    const result = await validateWorkflowFile(p);
    expect(result.valid).toBe(true);
  });
});
