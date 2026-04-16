import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorSignature } from "@delightfulchorus/core";
import { assembleRepairContext } from "../src/context.js";

function makeSig(): ErrorSignature {
  return {
    schemaVersion: 1,
    integration: "slack-send",
    operation: "postMessage",
    errorClass: "IntegrationError",
    httpStatus: 401,
    stackFingerprint: "a1b2c3d4e5f67890",
    messagePattern: "invalid_auth",
    integrationVersion: "1.4.2",
    runtimeVersion: "0.1.0",
    occurrences: 3,
    firstSeen: "2026-04-01T00:00:00Z",
    lastSeen: "2026-04-12T00:00:00Z",
  };
}

describe("assembleRepairContext", () => {
  let root: string;
  let integrationDir: string;
  let cassetteDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chorus-ctx-"));
    integrationDir = join(root, "integration");
    cassetteDir = join(root, "cassettes");
    await mkdir(integrationDir, { recursive: true });
    await mkdir(join(integrationDir, "src"), { recursive: true });
    await mkdir(cassetteDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("assembles context from a fixture integration directory", async () => {
    await writeFile(
      join(integrationDir, "package.json"),
      JSON.stringify({
        name: "@delightfulchorus/integration-slack-send",
        version: "1.4.2",
        description: "Slack integration",
      }),
      "utf8",
    );
    await writeFile(
      join(integrationDir, "src", "client.ts"),
      "export const url = 'https://slack.com/api';\n",
      "utf8",
    );
    await writeFile(
      join(integrationDir, "src", "index.ts"),
      "export { url } from './client.js';\n",
      "utf8",
    );

    // Two cassettes — the older one should appear AFTER the newer in output.
    const casA = {
      id: "postMessage-ok",
      integration: "slack-send",
      interaction: {
        request: { method: "POST", urlTemplate: "/api/chat.postMessage", headerNames: [] },
        response: { status: 200, headerNames: [], bodyShape: { ok: "boolean" } },
      },
      timestamp: "2026-04-12T00:00:00Z",
      durationMs: 120,
    };
    const casB = {
      id: "postMessage-fail",
      integration: "slack-send",
      signatureHash: "a1b2c3d4e5f67890",
      interaction: {
        request: { method: "POST", urlTemplate: "/api/chat.postMessage", headerNames: [] },
        response: { status: 401, headerNames: [], bodySnippet: "invalid_auth" },
      },
      timestamp: "2026-04-10T00:00:00Z",
      durationMs: 89,
    };
    await writeFile(join(cassetteDir, "a.json"), JSON.stringify(casA), "utf8");
    // Wait a beat to ensure distinct mtimes, then write the more recent one last.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(cassetteDir, "b.json"), JSON.stringify(casB), "utf8");

    const sig = makeSig();
    const ctx = await assembleRepairContext(sig, {
      integrationDir,
      cassetteDir,
    });

    expect(ctx.error.integration).toBe("slack-send");
    expect(ctx.manifest?.name).toBe("@delightfulchorus/integration-slack-send");
    expect(ctx.manifest?.version).toBe("1.4.2");
    expect(ctx.integrationDir).toBe(integrationDir);
    const paths = ctx.sourceFiles.map((f) => f.relPath).sort();
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/client.ts");
    expect(paths).toContain("src/index.ts");
    // Cassettes are sorted newest-first (b.json was written after a.json)
    expect(ctx.cassettes[0]?.id).toBe("postMessage-fail");
    expect(ctx.cassettes[0]?.succeeded).toBe(false);
    expect(ctx.cassettes[1]?.succeeded).toBe(true);
    // No vendor docs provided → null
    expect(ctx.vendorDocs).toBeNull();
  });

  it("handles missing vendor docs gracefully", async () => {
    await writeFile(
      join(integrationDir, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" }),
      "utf8",
    );
    await writeFile(join(integrationDir, "a.ts"), "export const x = 1;\n", "utf8");

    const sig = makeSig();
    const ctx = await assembleRepairContext(sig, {
      integrationDir,
      cassetteDir,
      vendorDocsCache: join(root, "missing-docs.txt"),
    });

    expect(ctx.vendorDocs).toBeNull();
    expect(ctx.sourceFiles.length).toBeGreaterThan(0);
  });

  it("loads vendor docs when the cache file exists", async () => {
    await writeFile(
      join(integrationDir, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" }),
      "utf8",
    );
    const docsPath = join(root, "docs.txt");
    await writeFile(docsPath, "Hello from Slack API docs.", "utf8");

    const sig = makeSig();
    const ctx = await assembleRepairContext(sig, {
      integrationDir,
      cassetteDir,
      vendorDocsCache: docsPath,
    });

    expect(ctx.vendorDocs).toContain("Slack API docs");
  });

  it("skips node_modules and dist directories", async () => {
    await writeFile(
      join(integrationDir, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" }),
      "utf8",
    );
    await mkdir(join(integrationDir, "node_modules", "foo"), { recursive: true });
    await mkdir(join(integrationDir, "dist"), { recursive: true });
    await writeFile(
      join(integrationDir, "node_modules", "foo", "index.js"),
      "module.exports = 1;",
      "utf8",
    );
    await writeFile(join(integrationDir, "dist", "compiled.js"), "module.exports = 1;", "utf8");
    await writeFile(join(integrationDir, "real.ts"), "export const r = 1;\n", "utf8");

    const sig = makeSig();
    const ctx = await assembleRepairContext(sig, {
      integrationDir,
      cassetteDir,
    });

    const paths = ctx.sourceFiles.map((f) => f.relPath);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
    expect(paths).toContain("real.ts");
  });

  it("returns empty cassettes array when cassetteDir is missing", async () => {
    await writeFile(
      join(integrationDir, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" }),
      "utf8",
    );
    const sig = makeSig();
    const ctx = await assembleRepairContext(sig, {
      integrationDir,
      cassetteDir: join(root, "nope"),
    });
    expect(ctx.cassettes).toEqual([]);
  });

  it("returns null manifest when package.json is missing", async () => {
    await writeFile(join(integrationDir, "index.ts"), "export const x = 1;\n", "utf8");
    const sig = makeSig();
    const ctx = await assembleRepairContext(sig, {
      integrationDir,
      cassetteDir,
    });
    expect(ctx.manifest).toBeNull();
  });
});
