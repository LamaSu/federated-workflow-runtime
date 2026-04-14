import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPatchToTempDir,
  cleanupTempDir,
  PatchApplyError,
  replayCassettes,
} from "../src/validate.js";
import type { Cassette } from "../src/types.js";

/**
 * Make a cassette with a given id and success state. The default replay
 * script checks replay.shape.json's `match[id]` → true/false.
 */
function cas(id: string, succeeded = true): Cassette {
  return {
    id,
    integration: "test-integration",
    interaction: {
      request: { method: "POST", urlTemplate: "/api/x", headerNames: [] },
      response: { status: succeeded ? 200 : 500, headerNames: [] },
    },
    timestamp: new Date().toISOString(),
    durationMs: 0,
    succeeded,
  };
}

describe("applyPatchToTempDir + replayCassettes — real subprocess", () => {
  let srcDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), "chorus-src-"));
    // Integration starts with a shape file saying NOTHING matches.
    await writeFile(
      join(srcDir, "replay.shape.json"),
      JSON.stringify({ match: { "cassette-a": false, "cassette-b": false } }, null, 2) + "\n",
      "utf8",
    );
    await mkdir(join(srcDir, "src"), { recursive: true });
    await writeFile(
      join(srcDir, "src", "client.ts"),
      "export const version = 1;\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
  });

  it("applies a known-good patch; cassettes replay green", async () => {
    // Good patch: flip both matches to true.
    const goodPatch = [
      "--- a/replay.shape.json",
      "+++ b/replay.shape.json",
      "@@ -1,6 +1,6 @@",
      " {",
      '   "match": {',
      '-    "cassette-a": false,',
      '-    "cassette-b": false',
      '+    "cassette-a": true,',
      '+    "cassette-b": true',
      "   }",
      " }",
      "",
    ].join("\n");

    const tempDir = await applyPatchToTempDir(goodPatch, srcDir);
    try {
      // Sanity — the patched file should now have true.
      const patched = await readFile(join(tempDir, "replay.shape.json"), "utf8");
      expect(patched).toContain('"cassette-a": true');

      const result = await replayCassettes(tempDir, [cas("cassette-a"), cas("cassette-b")]);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("applies a known-bad patch; replay fails", async () => {
    // Bad patch: only flip cassette-a; cassette-b remains false → should fail.
    const badPatch = [
      "--- a/replay.shape.json",
      "+++ b/replay.shape.json",
      "@@ -1,6 +1,6 @@",
      " {",
      '   "match": {',
      '-    "cassette-a": false,',
      '+    "cassette-a": true,',
      '     "cassette-b": false',
      "   }",
      " }",
      "",
    ].join("\n");

    const tempDir = await applyPatchToTempDir(badPatch, srcDir);
    try {
      const result = await replayCassettes(tempDir, [cas("cassette-a"), cas("cassette-b")]);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.cassetteId).toBe("cassette-b");
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("throws PatchApplyError on malformed diff", async () => {
    const garbage =
      "--- a/replay.shape.json\n+++ b/replay.shape.json\n@@ -999,1 +999,1 @@\n-does not exist\n+nope\n";
    await expect(applyPatchToTempDir(garbage, srcDir)).rejects.toBeInstanceOf(
      PatchApplyError,
    );
  });

  it("excludes node_modules when copying integration source to temp dir", async () => {
    await mkdir(join(srcDir, "node_modules", "junk"), { recursive: true });
    await writeFile(
      join(srcDir, "node_modules", "junk", "index.js"),
      "module.exports = 1;",
      "utf8",
    );
    // No-op patch that only touches the shape file.
    const patch = [
      "--- a/replay.shape.json",
      "+++ b/replay.shape.json",
      "@@ -1,6 +1,6 @@",
      " {",
      '   "match": {',
      '-    "cassette-a": false,',
      '+    "cassette-a": true,',
      '     "cassette-b": false',
      "   }",
      " }",
      "",
    ].join("\n");

    const tempDir = await applyPatchToTempDir(patch, srcDir);
    try {
      // The temp dir should NOT have node_modules copied over.
      await expect(readFile(join(tempDir, "node_modules", "junk", "index.js"))).rejects.toThrow();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("cleanupTempDir is idempotent (safe to call twice)", async () => {
    const patch = [
      "--- a/replay.shape.json",
      "+++ b/replay.shape.json",
      "@@ -1,6 +1,6 @@",
      " {",
      '   "match": {',
      '-    "cassette-a": false,',
      '+    "cassette-a": true,',
      '     "cassette-b": false',
      "   }",
      " }",
      "",
    ].join("\n");

    const tempDir = await applyPatchToTempDir(patch, srcDir);
    await cleanupTempDir(tempDir);
    // Second call on the same dir should not throw.
    await expect(cleanupTempDir(tempDir)).resolves.toBeUndefined();
  });
}, 30_000);
