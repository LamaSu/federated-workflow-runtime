/**
 * Generate ai/research/sample-composed-workflow.ts — the Phase 7 smoke-test
 * fixture.
 *
 * This script runs `runCompose` with a stubbed `generateObject` that returns
 * the exact fixture Task 2 specifies (the Linear-bugs → Slack digest), so
 * the sample is deterministic and reviewable without a real API call. It's
 * the same output an LLM would produce if it followed the system prompt;
 * the value is the emitted TS file shape, not the LLM's nondeterminism.
 *
 * Run with:  tsx scripts/generate-sample-composed.ts
 */
import { mkdir, copyFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCompose } from "../packages/cli/src/commands/compose.js";

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "chorus-sample-"));
  try {
    const fixture = {
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
            headers: { "Content-Type": "application/json" },
            body: {
              query:
                "query BugIssues { issues(filter: { labels: { name: { eq: \"bug\" } } }, orderBy: createdAt) { nodes { id title url createdAt } } }",
            },
          },
          onError: "retry" as const,
        },
        {
          id: "summarize",
          integration: "llm-anthropic",
          operation: "generate",
          config: { model: "claude-opus-4-7" },
          inputs: {
            prompt:
              "Summarize these Linear bug issues in 3 bullets:\n{{fetch-issues.body}}",
          },
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

    const result = await runCompose({
      prompt:
        "every morning at 9am pull new Linear issues labeled bug and post a summary to #team on Slack",
      cwd: tmp,
      model: { id: "stub" },
      generateObject: async () => ({ object: fixture }),
      silent: true,
      slug: "sample-composed-workflow",
    });

    const target = path.join(
      process.cwd(),
      "ai",
      "research",
      "sample-composed-workflow.ts",
    );
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(result.filePath, target);
    process.stdout.write(`Wrote ${target}\n`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`sample-composed-workflow: ${(err as Error).message}\n`);
  process.exit(1);
});
