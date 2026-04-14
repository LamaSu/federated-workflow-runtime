import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import type { Patch } from "@chorus/core";
import {
  cloneRegistry,
  listPatches,
  pullLatest,
  readPatch,
  writePatch,
} from "./git-store.js";

/**
 * Test strategy: create a bare git repo locally, clone it, write patches into the clone,
 * commit them, push — then re-clone into a second working tree and read back. This mirrors
 * the production flow (central repo ↔ user clone) without needing network.
 */

let tmpRoot: string;
let bareRepo: string;
let workTree: string;

function mkPatch(id: string, integration = "slack-send"): Patch {
  return {
    metadata: {
      id,
      integration,
      errorSignatureHash: "sig-" + id,
      description: "test patch " + id,
      author: { id: "a", publicKey: "pk", reputation: 0 },
      beforeVersion: "1.0.0",
      afterVersion: "1.0.1",
      testsAdded: [],
      canaryStage: "proposed",
      createdAt: "2026-04-13T00:00:00Z",
      advancedAt: {},
    },
    diff: "diff for " + id,
    snapshotUpdates: [],
    signature: "",
    signatureAlgorithm: "ed25519",
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chorus-registry-git-"));
  bareRepo = path.join(tmpRoot, "remote.git");
  workTree = path.join(tmpRoot, "work");

  // Create a bare repo to act as the "remote".
  await fs.mkdir(bareRepo);
  await simpleGit(bareRepo).init(true);

  // Clone it as a working tree with an initial commit (bare repos need one before push).
  const seed = path.join(tmpRoot, "seed");
  await fs.mkdir(seed);
  const seedGit = simpleGit(seed);
  await seedGit.init();
  await seedGit.addConfig("user.email", "test@chorus.local");
  await seedGit.addConfig("user.name", "chorus-test");
  // Default branch name should be consistent — seed creates a branch on first commit.
  await fs.writeFile(path.join(seed, "README.md"), "# registry\n", "utf8");
  await seedGit.add("README.md");
  await seedGit.commit("init");
  // Find the branch name the commit created and push under that name.
  const branch = (await seedGit.branch()).current || "master";
  await seedGit.addRemote("origin", bareRepo);
  await seedGit.push(["origin", branch]);

  // Now clone from the bare repo into our real working tree.
  await cloneRegistry(bareRepo, workTree);
  const workGit = simpleGit(workTree);
  await workGit.addConfig("user.email", "test@chorus.local");
  await workGit.addConfig("user.name", "chorus-test");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("cloneRegistry + pullLatest", () => {
  it("clones into the target directory and leaves a working tree", async () => {
    const readme = await fs.readFile(path.join(workTree, "README.md"), "utf8");
    expect(readme).toContain("# registry");
  });

  it("pullLatest is a no-op against an unchanged remote", async () => {
    await expect(pullLatest(workTree)).resolves.not.toThrow();
  });
});

describe("writePatch + readPatch", () => {
  it("writes a patch, stages it, and reads it back by id", async () => {
    const patch = mkPatch("alpha");
    await writePatch(workTree, patch);
    const got = await readPatch(workTree, "slack-send", "alpha");
    expect(got.metadata.id).toBe("alpha");
    expect(got.diff).toBe("diff for alpha");
  });

  it("writes to the integrations/<integration>/patches/ tree", async () => {
    await writePatch(workTree, mkPatch("beta"));
    const dir = path.join(workTree, "integrations", "slack-send", "patches");
    const entries = await fs.readdir(dir);
    expect(entries.some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("stages files via git add — git status shows them in index", async () => {
    await writePatch(workTree, mkPatch("gamma"));
    const status = await simpleGit(workTree).status();
    // Newly staged files land in `staged` or `created`; simple-git groups them as created.
    const staged = [...status.created, ...status.staged];
    expect(staged.length).toBeGreaterThan(0);
  });

  it("throws when reading a patch id that does not exist", async () => {
    await expect(readPatch(workTree, "slack-send", "nope")).rejects.toThrow(/not found/);
  });
});

describe("listPatches", () => {
  it("returns metadata for every patch under an integration", async () => {
    await writePatch(workTree, mkPatch("alpha"));
    await writePatch(workTree, mkPatch("beta"));
    const list = await listPatches(workTree, "slack-send");
    const ids = list.map((p) => p.id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });

  it("without integration filter, returns every patch in every integration", async () => {
    await writePatch(workTree, mkPatch("alpha", "slack-send"));
    await writePatch(workTree, mkPatch("x", "http-generic"));
    const list = await listPatches(workTree);
    expect(list.length).toBe(2);
  });

  it("skips malformed manifests instead of throwing", async () => {
    // Write a good one.
    await writePatch(workTree, mkPatch("alpha"));
    // Drop a malformed JSON file alongside it.
    const dir = path.join(workTree, "integrations", "slack-send", "patches");
    await fs.writeFile(path.join(dir, "broken.json"), "{not-json", "utf8");
    const list = await listPatches(workTree, "slack-send");
    // The good patch still shows up; the broken file is silently skipped.
    expect(list.map((p) => p.id)).toContain("alpha");
  });

  it("returns empty list for an unknown integration", async () => {
    const list = await listPatches(workTree, "does-not-exist");
    expect(list).toEqual([]);
  });
});
