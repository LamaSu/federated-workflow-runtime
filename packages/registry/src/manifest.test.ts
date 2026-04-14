import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  computeContentHash,
  manifestFilename,
  validateManifest,
} from "./manifest.js";
import type { Patch } from "@chorus/core";

function sampleMetadata() {
  return {
    id: "slack-send_oauth_a1b2c3d4",
    integration: "slack-send",
    errorSignatureHash: "abc123",
    description: "Fix OAuth refresh race",
    author: {
      id: "alice",
      publicKey: "dGVzdC1wdWJrZXk=",
      reputation: 250,
    },
    beforeVersion: "1.4.2",
    afterVersion: "1.4.3",
    testsAdded: ["test-refresh-race"],
    canaryStage: "proposed" as const,
    createdAt: "2026-04-13T00:15:00Z",
    advancedAt: { proposed: "2026-04-13T00:15:00Z" },
  };
}

function samplePatch(): Patch {
  return {
    metadata: sampleMetadata(),
    diff: "--- a/client.ts\n+++ b/client.ts\n@@ -1 +1 @@\n-old\n+new",
    snapshotUpdates: [],
    signature: "",
    signatureAlgorithm: "ed25519" as const,
  };
}

describe("validateManifest", () => {
  it("accepts a well-formed patch", () => {
    const result = validateManifest(samplePatch());
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    expect(result.metadata.id).toBe("slack-send_oauth_a1b2c3d4");
  });

  it("rejects a patch missing required fields", () => {
    const bad = { metadata: { id: "x" }, diff: "..." };
    const result = validateManifest(bad);
    expect(result).toBeInstanceOf(Error);
  });

  it("rejects a patch with an unknown canaryStage", () => {
    const patch = samplePatch() as unknown as { metadata: { canaryStage: string } };
    patch.metadata.canaryStage = "not-a-stage";
    const result = validateManifest(patch);
    expect(result).toBeInstanceOf(Error);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("handles arrays in order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives + null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
  });
});

describe("computeContentHash", () => {
  it("is stable across key-order permutations of metadata", () => {
    const p1 = samplePatch();
    const p2: Patch = {
      ...p1,
      metadata: { ...sampleMetadata() },
    };
    expect(computeContentHash(p1)).toBe(computeContentHash(p2));
  });

  it("ignores the signature field", () => {
    const p1 = samplePatch();
    const p2: Patch = { ...p1, signature: "something-else" };
    expect(computeContentHash(p1)).toBe(computeContentHash(p2));
  });

  it("changes when the diff changes", () => {
    const p1 = samplePatch();
    const p2: Patch = { ...p1, diff: "different diff" };
    expect(computeContentHash(p1)).not.toBe(computeContentHash(p2));
  });
});

describe("manifestFilename", () => {
  it("embeds date + slug + short hash", () => {
    const name = manifestFilename(samplePatch());
    expect(name).toMatch(/^2026-04-13_.+_[0-9a-f]{8}\.json$/);
    expect(name).toContain("slack-send_oauth");
  });

  it("is deterministic for identical content", () => {
    const p = samplePatch();
    expect(manifestFilename(p)).toBe(manifestFilename(p));
  });
});
