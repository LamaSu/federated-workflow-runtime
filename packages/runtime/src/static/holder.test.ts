import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  setDashboard,
  resetDashboard,
  getDashboardHtml,
  getDashboardEtag,
} from "./holder.js";
import { MINIMAL_HTML } from "./index.js";

describe("dashboard holder", () => {
  beforeEach(() => {
    resetDashboard();
  });

  it("starts with the bundled minimal dashboard", () => {
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
    expect(getDashboardHtml().toLowerCase()).toContain("<!doctype html>");
  });

  it("emits a weak ETag on the current body", () => {
    const etag = getDashboardEtag();
    expect(etag.startsWith('W/"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it("setDashboard swaps in a new body + new etag", () => {
    const oldEtag = getDashboardEtag();
    const custom = "<!doctype html>\n<html><body>custom</body></html>";
    setDashboard(custom);
    expect(getDashboardHtml()).toBe(custom);
    expect(getDashboardEtag()).not.toBe(oldEtag);
  });

  it("setDashboard ignores empty/non-string input (defensive)", () => {
    const etag = getDashboardEtag();
    setDashboard("");
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
    setDashboard(null as unknown as string);
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
    expect(getDashboardEtag()).toBe(etag);
  });

  it("resetDashboard restores the bundled html", () => {
    setDashboard("<!doctype html><html><body>x</body></html>");
    expect(getDashboardHtml()).not.toBe(MINIMAL_HTML);
    resetDashboard();
    expect(getDashboardHtml()).toBe(MINIMAL_HTML);
  });

  it("minimal html is under 15KB (task constraint)", () => {
    expect(MINIMAL_HTML.length).toBeLessThan(15 * 1024);
  });

  it("minimal html references the api endpoints it will poll", () => {
    expect(MINIMAL_HTML).toContain("/api/manifest");
    expect(MINIMAL_HTML).toContain("/api/workflows");
    expect(MINIMAL_HTML).toContain("/api/runs");
    expect(MINIMAL_HTML).toContain("/api/errors");
  });

  it("minimal html has a 2s polling interval per the task", () => {
    // POLL_MS is declared as 2000 in the inline script
    expect(MINIMAL_HTML).toMatch(/POLL_MS\s*=\s*2000/);
  });

  it("minimal html contains no external script/style/font references", () => {
    // Catch accidental CDN links. We look for explicit src/href to external
    // origins, not any occurrence of the word "http" (the JS talks to /api).
    expect(MINIMAL_HTML).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
    expect(MINIMAL_HTML).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
    expect(MINIMAL_HTML).not.toMatch(/@import\s+url\(["']?https?:\/\//i);
  });

  it("MINIMAL_HTML constant matches the canonical minimal.html file", async () => {
    // Prevents drift: edit the HTML, update the constant, ship both.
    const hereFile = fileURLToPath(import.meta.url);
    const htmlPath = path.join(path.dirname(hereFile), "minimal.html");
    const onDisk = await readFile(htmlPath, "utf8");
    // Normalize line endings — the source file may use LF while the TS
    // literal is whatever the editor produced. Compare after \r stripping.
    const norm = (s: string): string => s.replace(/\r\n/g, "\n").trimEnd();
    expect(norm(MINIMAL_HTML)).toBe(norm(onDisk));
  });
});
