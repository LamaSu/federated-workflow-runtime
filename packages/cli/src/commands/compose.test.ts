import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposeFailedError,
  deriveSlug,
  renderTypeScriptWorkflow,
  runCompose,
  slugify,
  type GenerateObjectFn,
} from "./compose.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-compose-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A valid minimal workflow — cron trigger, single http-generic node, no
 * connections. Passes WorkflowSchema.safeParse cleanly. The defaults on
 * version/active/connections/nodes[].config/nodes[].onError exercise the
 * Zod default paths (so we also assert the golden snapshot contains them).
 */
function validCronWorkflowFixture() {
  return {
    id: "morning-fetch",
    name: "Morning fetch",
    version: 1,
    active: true,
    trigger: {
      type: "cron" as const,
      expression: "0 9 * * *",
      timezone: "UTC",
    },
    nodes: [
      {
        id: "fetch",
        integration: "http-generic",
        operation: "request",
        config: { url: "https://example.com/ping", method: "GET" },
        onError: "retry" as const,
      },
    ],
    connections: [],
    createdAt: "2026-04-22T09:00:00Z",
    updatedAt: "2026-04-22T09:00:00Z",
  };
}

/** A valid 3-node workflow: cron → http → slack. */
function validLinearDigestFixture() {
  return {
    id: "linear-bug-digest",
    name: "Daily Linear bug digest",
    version: 1,
    active: true,
    trigger: {
      type: "cron" as const,
      expression: "0 9 * * *",
      timezone: "UTC",
    },
    nodes: [
      {
        id: "fetch-issues",
        integration: "http-generic",
        operation: "request",
        config: {
          url: "https://api.linear.app/graphql",
          method: "POST",
          body: { query: "query BugIssues { issues { nodes { id title } } }" },
        },
        onError: "retry" as const,
      },
      {
        id: "summarize",
        integration: "llm-anthropic",
        operation: "generate",
        config: { model: "claude-opus-4-7" },
        inputs: { prompt: "Summarize:\n{{fetch-issues.body}}" },
        onError: "retry" as const,
      },
      {
        id: "post",
        integration: "slack-send",
        operation: "postMessage",
        config: { channel: "#team" },
        inputs: { text: "{{summarize.text}}" },
        onError: "retry" as const,
      },
    ],
    connections: [
      { from: "fetch-issues", to: "summarize" },
      { from: "summarize", to: "post" },
    ],
    createdAt: "2026-04-22T09:00:00Z",
    updatedAt: "2026-04-22T09:00:00Z",
  };
}

/**
 * A deliberately broken workflow — missing `trigger` — so Zod validation
 * fails and the retry loop kicks in.
 */
function brokenWorkflowFixture() {
  return {
    id: "no-trigger",
    name: "Missing trigger",
    version: 1,
    nodes: [],
    connections: [],
    createdAt: "2026-04-22T09:00:00Z",
    updatedAt: "2026-04-22T09:00:00Z",
  };
}

/**
 * Build a deterministic generateObject stub that yields a sequence of
 * responses (one per attempt). If the queue is exhausted, throws — this
 * catches tests that expect fewer calls than they actually triggered.
 */
function queuedGenerateObject(queue: unknown[]): {
  fn: GenerateObjectFn;
  callCount: () => number;
} {
  const spy = vi.fn(
    (async (args: Parameters<GenerateObjectFn>[0]) => {
      if (queue.length === 0) {
        throw new Error("queuedGenerateObject: queue exhausted");
      }
      const next = queue.shift();
      // Sanity: every call must get the schema + system prompt.
      if (!args.schema) throw new Error("missing schema");
      if (!args.system || args.system.length < 100) {
        throw new Error("missing or tiny system prompt");
      }
      return { object: next };
    }) as GenerateObjectFn,
  );
  return {
    fn: spy as unknown as GenerateObjectFn,
    callCount: () => spy.mock.calls.length,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("slugify / deriveSlug", () => {
  it("converts sentences to hyphenated slugs", () => {
    expect(slugify("Every morning at 9am pull Linear bugs")).toBe(
      "every-morning-at-9am-pull-linear-bugs",
    );
  });

  it("handles non-alphanumerics", () => {
    expect(slugify("Hello, World! 🌍")).toBe("hello-world");
  });

  it("caps length at 40 chars", () => {
    const slug = slugify("a".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("returns 'workflow' for empty input", () => {
    expect(slugify("")).toBe("workflow");
    expect(slugify("!!!")).toBe("workflow");
  });

  it("prefers workflow.name, falls back to the prompt", () => {
    expect(deriveSlug("Morning fetch", "anything")).toBe("morning-fetch");
    expect(deriveSlug("", "First line goes here\nignored")).toBe("first-line-goes-here");
  });
});

describe("renderTypeScriptWorkflow", () => {
  it("emits a self-contained TS file importing from @delightfulchorus/core", () => {
    const body = renderTypeScriptWorkflow(
      validCronWorkflowFixture() as unknown as import("@delightfulchorus/core").Workflow,
    );
    expect(body).toMatch(/import type \{ Workflow \} from "@delightfulchorus\/core";/);
    expect(body).toMatch(/const workflow: Workflow =/);
    expect(body).toMatch(/export default workflow;/);
    expect(body).toMatch(/"morning-fetch"/);
    expect(body).toMatch(/"cron"/);
  });

  it("output matches a stable golden snapshot", () => {
    const body = renderTypeScriptWorkflow(
      validCronWorkflowFixture() as unknown as import("@delightfulchorus/core").Workflow,
    );
    // Snapshot the structurally important lines — not the whole file —
    // so minor whitespace churn doesn't force a test update every edit.
    expect(body).toContain('"id": "morning-fetch"');
    expect(body).toContain('"integration": "http-generic"');
    expect(body).toContain('"operation": "request"');
    expect(body).toContain('"expression": "0 9 * * *"');
    // Defaults that compose applies should also show up.
    expect(body).toContain('"active": true');
    expect(body).toContain('"version": 1');
  });
});

describe("runCompose — happy path", () => {
  it("writes a valid TS file on the first attempt", async () => {
    const { fn, callCount } = queuedGenerateObject([validCronWorkflowFixture()]);

    const result = await runCompose({
      prompt: "every morning at 9am fetch https://example.com/ping",
      cwd: tmpDir,
      model: { id: "stub" },
      generateObject: fn,
      silent: true,
    });

    expect(result.attempts).toBe(1);
    expect(callCount()).toBe(1);
    expect(result.validationHistory).toEqual([]);
    expect(result.workflow.id).toBe("morning-fetch");

    const written = await readFile(result.filePath, "utf8");
    expect(written).toMatch(/const workflow: Workflow =/);
    expect(written).toMatch(/"morning-fetch"/);
    expect(path.basename(result.filePath)).toBe("morning-fetch.ts");
  });

  it("generates a 3-node digest workflow end-to-end", async () => {
    const { fn } = queuedGenerateObject([validLinearDigestFixture()]);

    const result = await runCompose({
      prompt:
        "every morning at 9am pull new Linear issues labeled bug and post a summary to #team on Slack",
      cwd: tmpDir,
      model: { id: "stub" },
      generateObject: fn,
      silent: true,
    });

    expect(result.workflow.nodes).toHaveLength(3);
    expect(result.workflow.connections).toHaveLength(2);
    expect(result.workflow.trigger.type).toBe("cron");
    expect(path.basename(result.filePath)).toBe("linear-bug-digest.ts");

    const written = await readFile(result.filePath, "utf8");
    expect(written).toContain('"llm-anthropic"');
    expect(written).toContain('"slack-send"');
  });

  it("honors an explicit slug override", async () => {
    const { fn } = queuedGenerateObject([validCronWorkflowFixture()]);
    const result = await runCompose({
      prompt: "p",
      cwd: tmpDir,
      model: {},
      generateObject: fn,
      slug: "my-custom-name",
      silent: true,
    });
    expect(path.basename(result.filePath)).toBe("my-custom-name.ts");
  });

  it("creates chorus/ dir even when it doesn't exist yet", async () => {
    const freshDir = await mkdtemp(path.join(tmpdir(), "chorus-compose-fresh-"));
    try {
      const { fn } = queuedGenerateObject([validCronWorkflowFixture()]);
      const result = await runCompose({
        prompt: "a",
        cwd: freshDir,
        model: {},
        generateObject: fn,
        silent: true,
      });
      expect(result.filePath).toBe(path.join(freshDir, "chorus", "morning-fetch.ts"));
      // dir must exist and contain our file
      const written = await readFile(result.filePath, "utf8");
      expect(written.length).toBeGreaterThan(0);
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });
});

describe("runCompose — Ralph retry loop", () => {
  it("retries with diagnostic when first response fails validation", async () => {
    const { fn, callCount } = queuedGenerateObject([
      brokenWorkflowFixture(), // attempt 1 → invalid
      validCronWorkflowFixture(), // attempt 2 → valid
    ]);

    const result = await runCompose({
      prompt: "x",
      cwd: tmpDir,
      model: {},
      generateObject: fn,
      silent: true,
    });

    expect(callCount()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.validationHistory).toHaveLength(1);
    expect(result.validationHistory[0]!.join("\n")).toMatch(/trigger/);
  });

  it("passes the diagnostic back into the retry prompt", async () => {
    const calls: string[] = [];
    const generateObject: GenerateObjectFn = async (args) => {
      calls.push(args.prompt);
      if (calls.length === 1) return { object: brokenWorkflowFixture() };
      return { object: validCronWorkflowFixture() };
    };

    await runCompose({
      prompt: "original user text",
      cwd: tmpDir,
      model: {},
      generateObject,
      silent: true,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("original user text");
    // Retry prompt must contain the original + a diagnostic block.
    expect(calls[1]).toMatch(/original user text/);
    expect(calls[1]).toMatch(/schema validation/i);
    expect(calls[1]).toMatch(/trigger/);
  });

  it("throws ComposeFailedError after exhausting maxAttempts", async () => {
    const { fn, callCount } = queuedGenerateObject([
      brokenWorkflowFixture(),
      brokenWorkflowFixture(),
      brokenWorkflowFixture(),
    ]);

    await expect(
      runCompose({
        prompt: "x",
        cwd: tmpDir,
        model: {},
        generateObject: fn,
        silent: true,
      }),
    ).rejects.toBeInstanceOf(ComposeFailedError);
    expect(callCount()).toBe(3);
  });

  it("respects a custom maxAttempts", async () => {
    const { fn, callCount } = queuedGenerateObject([brokenWorkflowFixture()]);
    await expect(
      runCompose({
        prompt: "x",
        cwd: tmpDir,
        model: {},
        generateObject: fn,
        silent: true,
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(ComposeFailedError);
    expect(callCount()).toBe(1);
  });

  it("captures model-level exceptions as diagnostic input for the next retry", async () => {
    let attempt = 0;
    const generateObject: GenerateObjectFn = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient network blip");
      return { object: validCronWorkflowFixture() };
    };

    const result = await runCompose({
      prompt: "q",
      cwd: tmpDir,
      model: {},
      generateObject,
      silent: true,
    });

    expect(result.attempts).toBe(2);
    expect(result.validationHistory[0]![0]).toMatch(/transient network blip/);
  });
});

describe("runCompose — input validation", () => {
  it("rejects an empty prompt", async () => {
    await expect(
      runCompose({
        prompt: "   ",
        cwd: tmpDir,
        model: {},
        generateObject: async () => ({ object: {} }),
      }),
    ).rejects.toThrow(/non-empty string/);
  });

  it("rejects maxAttempts < 1", async () => {
    await expect(
      runCompose({
        prompt: "x",
        cwd: tmpDir,
        model: {},
        generateObject: async () => ({ object: {} }),
        maxAttempts: 0,
      }),
    ).rejects.toThrow(/maxAttempts/);
  });
});
