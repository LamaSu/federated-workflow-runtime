import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateMcpServer } from "./generate.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-mcp-gen-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generateMcpServer", () => {
  it("writes a scaffold to the requested outDir", async () => {
    const outDir = path.join(tmpDir, "mcp-servers", "chorus-slack-send");
    const result = await generateMcpServer({
      integration: "slack-send",
      outDir,
    });
    expect(result.path).toBe(outDir);
    const pkgPath = path.join(outDir, "package.json");
    const idxPath = path.join(outDir, "index.js");
    const readmePath = path.join(outDir, "README.md");
    await expect(stat(pkgPath)).resolves.toMatchObject({});
    await expect(stat(idxPath)).resolves.toMatchObject({});
    await expect(stat(readmePath)).resolves.toMatchObject({});
  });

  it("package.json has @delightfulchorus/mcp + the integration as dependencies", async () => {
    const outDir = path.join(tmpDir, "out");
    await generateMcpServer({ integration: "slack-send", outDir });
    const raw = await readFile(path.join(outDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      name: string;
      type: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe("chorus-mcp-slack-send");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@delightfulchorus/mcp"]).toBeDefined();
    expect(pkg.dependencies["@delightfulchorus/integration-slack-send"]).toBeDefined();
    expect(pkg.scripts.start).toBe("node index.js");
  });

  it("index.js imports serveIntegration and the integration module", async () => {
    const outDir = path.join(tmpDir, "out");
    await generateMcpServer({ integration: "slack-send", outDir });
    const idx = await readFile(path.join(outDir, "index.js"), "utf8");
    expect(idx).toContain('import { serveIntegration } from "@delightfulchorus/mcp/serve"');
    expect(idx).toContain(
      'import integration from "@delightfulchorus/integration-slack-send"',
    );
    // Scaffold now passes a credentialService (optional) alongside.
    expect(idx).toContain("serveIntegration({ integration, credentialService })");
  });

  it("index.js wires HttpCredentialServiceClient when CHORUS_RUNTIME_URL is set", async () => {
    const outDir = path.join(tmpDir, "out");
    await generateMcpServer({ integration: "slack-send", outDir });
    const idx = await readFile(path.join(outDir, "index.js"), "utf8");
    expect(idx).toContain("CHORUS_RUNTIME_URL");
    expect(idx).toContain("CHORUS_API_TOKEN");
    expect(idx).toContain("HttpCredentialServiceClient");
    expect(idx).toContain('@delightfulchorus/mcp/credential-client');
    // Should NOT statically import — dynamic import keeps the scaffold
    // working without the client module present in tool-exposure-only mode.
    expect(idx).toContain("await import");
  });

  it("README documents Claude Desktop / Cursor / Zed registration", async () => {
    const outDir = path.join(tmpDir, "out");
    await generateMcpServer({ integration: "http-generic", outDir });
    const readme = await readFile(path.join(outDir, "README.md"), "utf8");
    expect(readme).toContain("Claude Desktop");
    expect(readme).toContain("Cursor");
    expect(readme).toContain("Zed");
    expect(readme).toContain("mcpServers");
    expect(readme).toContain("http-generic__list_credentials");
  });

  it("returns a configSnippet suitable for pasting into .mcp.json", async () => {
    const outDir = path.join(tmpDir, "out");
    const result = await generateMcpServer({
      integration: "slack-send",
      outDir,
    });
    const snippet = JSON.parse(result.configSnippet) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(snippet.mcpServers["chorus-slack-send"]).toBeDefined();
    expect(snippet.mcpServers["chorus-slack-send"]!.command).toBe("node");
    expect(snippet.mcpServers["chorus-slack-send"]!.args[0]).toContain(
      "index.js",
    );
  });

  it("dryRun returns file contents without touching the filesystem", async () => {
    const outDir = path.join(tmpDir, "would-not-exist");
    const result = await generateMcpServer({
      integration: "slack-send",
      outDir,
      dryRun: true,
    });
    expect(result.files).toHaveLength(3);
    // Assert the output directory was NOT created.
    await expect(stat(outDir)).rejects.toThrow();
    // The contents should still be well-formed.
    const pkgFile = result.files.find((f) => f.path.endsWith("package.json"))!;
    expect(() => JSON.parse(pkgFile.content)).not.toThrow();
    const readmeFile = result.files.find((f) => f.path.endsWith("README.md"))!;
    expect(readmeFile.content.length).toBeGreaterThan(500);
  });

  it("rejects an invalid integration name", async () => {
    await expect(
      generateMcpServer({ integration: "UpperCase", outDir: tmpDir }),
    ).rejects.toThrow(/invalid integration name/);
    await expect(
      generateMcpServer({ integration: "with/slash", outDir: tmpDir }),
    ).rejects.toThrow(/invalid integration name/);
    await expect(
      generateMcpServer({ integration: "../escape", outDir: tmpDir }),
    ).rejects.toThrow(/invalid integration name/);
  });

  it("integrationPackage override is reflected in scaffold", async () => {
    const outDir = path.join(tmpDir, "out");
    await generateMcpServer({
      integration: "custom-integration",
      outDir,
      integrationPackage: "@my-org/chorus-custom",
    });
    const pkg = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@my-org/chorus-custom"]).toBeDefined();
    expect(pkg.dependencies["@delightfulchorus/integration-custom-integration"]).toBeUndefined();
    const idx = await readFile(path.join(outDir, "index.js"), "utf8");
    expect(idx).toContain('import integration from "@my-org/chorus-custom"');
  });

  it("package.json is valid JSON (no trailing commas, well-formed)", async () => {
    const result = await generateMcpServer({
      integration: "slack-send",
      outDir: path.join(tmpDir, "out"),
      dryRun: true,
    });
    const pkgFile = result.files.find((f) => f.path.endsWith("package.json"))!;
    expect(() => JSON.parse(pkgFile.content)).not.toThrow();
  });

  it("generates a runnable bin entry", async () => {
    const result = await generateMcpServer({
      integration: "slack-send",
      outDir: path.join(tmpDir, "out"),
      dryRun: true,
    });
    const pkgFile = result.files.find((f) => f.path.endsWith("package.json"))!;
    const pkg = JSON.parse(pkgFile.content) as { bin?: Record<string, string> };
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin!["chorus-mcp-slack-send"]).toBe("./index.js");
  });
});
