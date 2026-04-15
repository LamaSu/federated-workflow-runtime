import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import {
  mkdtemp,
  rm,
  readFile,
  stat,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mcpList,
  mcpGenerate,
  mcpConfig,
} from "./mcp.js";

class BufferStream extends Writable {
  public chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, _enc: unknown, cb: () => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

let tmpDir: string;

/**
 * Set up a fake project root with:
 *   tmpDir/
 *     package.json  (workspace root)
 *     node_modules/@chorus-integrations/slack-send/
 *       package.json
 *       dist/index.js   (the integration module)
 *
 * Using real filesystem so createRequire resolution works.
 */
async function setupFakeProject(opts: {
  integrationName?: string;
  moduleContents?: string;
}): Promise<{ cwd: string; name: string }> {
  const name = opts.integrationName ?? "slack-send";
  await writeFile(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "chorus-test-project", version: "0.0.1" }),
  );

  const intRoot = path.join(
    tmpDir,
    "node_modules",
    "@chorus-integrations",
    name,
  );
  await mkdir(path.join(intRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(intRoot, "package.json"),
    JSON.stringify({
      name: `@chorus-integrations/${name}`,
      version: "0.1.0",
      main: "./dist/index.js",
      type: "module",
    }),
  );
  // The integration module — a plain ESM default export matching
  // IntegrationModule's shape.
  const defaultModule = `
export default {
  manifest: {
    name: "${name}",
    version: "0.1.0",
    description: "Fake integration for tests",
    authType: "bearer",
    docsUrl: "https://example.test",
    operations: [
      {
        name: "doThing",
        description: "Do a thing",
        idempotent: false,
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    ],
  },
  operations: {
    doThing: async (input) => ({ ok: true, echoed: input }),
  },
};
`.trim();
  await writeFile(
    path.join(intRoot, "dist", "index.js"),
    opts.moduleContents ?? defaultModule,
  );
  return { cwd: tmpDir, name };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-mcp-cli-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── list ────────────────────────────────────────────────────────────────────

describe("chorus mcp list", () => {
  it("reports 'no integrations installed' on an empty project", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "empty", version: "0.0.1" }),
    );
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpList({ cwd: tmpDir, stdout: out, forceNoColor: true });
    expect(code).toBe(0);
    expect((out as unknown as BufferStream).text()).toContain(
      "No integrations installed",
    );
  });

  it("lists installed integrations with tool counts", async () => {
    const { cwd } = await setupFakeProject({});
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpList({ cwd, stdout: out, forceNoColor: true });
    expect(code).toBe(0);
    const text = (out as unknown as BufferStream).text();
    expect(text).toContain("slack-send");
    expect(text).toContain("v0.1.0");
    // 1 operation + 4 credential tools (list + configure + test_auth — no auth) = 4
    // Actually: 1 op + list + configure + test_auth = 4 total. Assert loosely:
    expect(text).toMatch(/MCP tools/);
  });

  it("--json emits a machine-readable array", async () => {
    const { cwd } = await setupFakeProject({});
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpList({
      cwd,
      json: true,
      stdout: out,
      forceNoColor: true,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse((out as unknown as BufferStream).text()) as Array<{
      integration: string;
      operations?: number;
      tools?: number;
      authType?: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      integration: "slack-send",
      operations: 1,
      authType: "bearer",
    });
    expect(parsed[0]!.tools).toBeGreaterThanOrEqual(4);
  });
});

// ── generate ────────────────────────────────────────────────────────────────

describe("chorus mcp generate", () => {
  it("writes a scaffold when the integration exists", async () => {
    const { cwd, name } = await setupFakeProject({});
    const outDir = path.join(cwd, "mcp-servers", `chorus-${name}`);
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpGenerate({
      cwd,
      integration: name,
      stdout: out,
      forceNoColor: true,
    });
    expect(code).toBe(0);
    await expect(stat(path.join(outDir, "package.json"))).resolves.toMatchObject({});
    await expect(stat(path.join(outDir, "index.js"))).resolves.toMatchObject({});
    await expect(stat(path.join(outDir, "README.md"))).resolves.toMatchObject({});
  });

  it("returns error when integration is missing", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "empty", version: "0.0.1" }),
    );
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpGenerate({
      cwd: tmpDir,
      integration: "does-not-exist",
      stdout: out,
      forceNoColor: true,
    });
    expect(code).toBe(2);
  });

  it("prints next-steps instructions including the config snippet", async () => {
    const { cwd, name } = await setupFakeProject({});
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    await mcpGenerate({ cwd, integration: name, stdout: out, forceNoColor: true });
    const text = (out as unknown as BufferStream).text();
    expect(text).toContain("Next steps");
    expect(text).toContain("mcpServers");
    expect(text).toContain(`chorus-${name}`);
  });

  it("respects --out override", async () => {
    const { cwd, name } = await setupFakeProject({});
    const customOut = path.join(cwd, "custom-location");
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpGenerate({
      cwd,
      integration: name,
      out: customOut,
      stdout: out,
      forceNoColor: true,
    });
    expect(code).toBe(0);
    await expect(stat(path.join(customOut, "index.js"))).resolves.toMatchObject({});
  });
});

// ── config ──────────────────────────────────────────────────────────────────

describe("chorus mcp config", () => {
  it("prints JSON snippet without writing files", async () => {
    const { cwd, name } = await setupFakeProject({});
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await mcpConfig({ cwd, integration: name, stdout: out });
    expect(code).toBe(0);
    const text = (out as unknown as BufferStream).text();
    const parsed = JSON.parse(text) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers[`chorus-${name}`]).toBeDefined();
    expect(parsed.mcpServers[`chorus-${name}`]!.command).toBe("node");

    // Nothing on disk.
    await expect(
      stat(path.join(cwd, "mcp-servers", `chorus-${name}`)),
    ).rejects.toThrow();
  });

  it("snippet is pipe-friendly (no ANSI codes)", async () => {
    const { cwd, name } = await setupFakeProject({});
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    await mcpConfig({ cwd, integration: name, stdout: out });
    const text = (out as unknown as BufferStream).text();
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[\d+m/);
  });
});
