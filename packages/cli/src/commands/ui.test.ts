import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runUi,
  FALLBACK_PROMPT,
  EMBEDDED_MINIMAL_HTML,
} from "./ui.js";

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

describe("chorus ui", () => {
  it("--prompt emits the template text (non-empty, within size budget)", async () => {
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    const code = await runUi({ prompt: true, stdout: out, forceNoColor: true });
    expect(code).toBe(0);
    const text = (out as unknown as BufferStream).text();
    expect(text.length).toBeGreaterThan(1000);
    expect(text.length).toBeLessThan(3500);
    // Prompt must mention manifest + single-file + no-CDN contract — these
    // are the load-bearing constraints that agents drop otherwise.
    expect(text).toContain("/api/manifest");
    expect(text).toContain("single");
    // Rules the prompt must convey clearly.
    expect(text.toLowerCase()).toContain("cdn");
    expect(text.toLowerCase()).toContain("offline");
    expect(text).toContain("{{STYLE}}");
  });

  it("--prompt output carries no ANSI color codes (pipe-friendly)", async () => {
    const out = new BufferStream() as unknown as NodeJS.WriteStream;
    await runUi({ prompt: true, stdout: out, forceNoColor: true });
    const text = (out as unknown as BufferStream).text();
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[\d+m/);
  });

  it("default output prints API URL + example commands", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chorus-ui-"));
    try {
      const out = new BufferStream() as unknown as NodeJS.WriteStream;
      const code = await runUi({ stdout: out, cwd: dir, forceNoColor: true });
      expect(code).toBe(0);
      const text = (out as unknown as BufferStream).text();
      // Falls back to default port when there's no config.
      expect(text).toContain("http://127.0.0.1:3710/api/manifest");
      expect(text).toContain("chorus ui --prompt");
      expect(text).toContain("chorus ui --example");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--example writes the reference HTML into examples/ui/minimal.html", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chorus-ui-example-"));
    try {
      const out = new BufferStream() as unknown as NodeJS.WriteStream;
      const code = await runUi({ example: true, stdout: out, cwd: dir, forceNoColor: true });
      expect(code).toBe(0);
      const dest = path.join(dir, "examples", "ui", "minimal.html");
      const st = await stat(dest);
      expect(st.isFile()).toBe(true);
      const content = await readFile(dest, "utf8");
      expect(content).toContain("<!doctype html>");
      expect(content).toContain("/api/runs");
      expect(content).toContain("/api/errors");
      expect(content).toContain("/api/patches");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("FALLBACK_PROMPT is non-empty and in the 1k..3k char window", () => {
    expect(FALLBACK_PROMPT.length).toBeGreaterThan(1000);
    expect(FALLBACK_PROMPT.length).toBeLessThan(3500);
    expect(FALLBACK_PROMPT).toContain("/api/manifest");
    expect(FALLBACK_PROMPT).toContain("{{STYLE}}");
  });

  it("EMBEDDED_MINIMAL_HTML parses as plausible HTML and references the three endpoints", () => {
    expect(EMBEDDED_MINIMAL_HTML).toContain("<!doctype html>");
    expect(EMBEDDED_MINIMAL_HTML).toContain("/api/runs");
    expect(EMBEDDED_MINIMAL_HTML).toContain("/api/errors");
    expect(EMBEDDED_MINIMAL_HTML).toContain("/api/patches");
    expect(EMBEDDED_MINIMAL_HTML.length).toBeLessThan(6000);
  });
});
