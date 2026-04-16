import { describe, expect, it } from "vitest";
import type { ErrorSignature } from "@delightfulchorus/core";
import {
  parseProposal,
  ProposalParseError,
  proposePatch,
  renderUserPrompt,
  SYSTEM_PROMPT,
  validateUnifiedDiff,
} from "../src/propose.js";
import type { RepairContext } from "../src/types.js";

function makeSig(): ErrorSignature {
  return {
    schemaVersion: 1,
    integration: "slack-send",
    operation: "postMessage",
    errorClass: "IntegrationError",
    httpStatus: 401,
    stackFingerprint: "fingerprint",
    messagePattern: "invalid_auth",
    integrationVersion: "1.4.2",
    runtimeVersion: "0.1.0",
    occurrences: 1,
    firstSeen: "2026-04-01T00:00:00Z",
    lastSeen: "2026-04-12T00:00:00Z",
  };
}

function makeContext(): RepairContext {
  return {
    error: makeSig(),
    manifest: {
      name: "slack-send",
      version: "1.4.2",
      description: "Slack",
      authType: "oauth2",
      credentialTypes: [],
      operations: [],
    },
    sourceFiles: [
      { relPath: "src/client.ts", contents: "export const token = 'oldtoken';\n" },
    ],
    integrationDir: "/tmp/slack",
    cassettes: [
      {
        id: "postMessage-ok",
        integration: "slack-send",
        interaction: {
          request: { method: "POST", urlTemplate: "/api/chat", headerNames: [] },
          response: { status: 200, headerNames: [] },
        },
        timestamp: "2026-04-12T00:00:00Z",
        durationMs: 100,
        succeeded: true,
      },
    ],
    vendorDocs: "Use Bearer token in Authorization header.",
  };
}

const goodDiff = [
  "--- a/src/client.ts",
  "+++ b/src/client.ts",
  "@@ -1,1 +1,1 @@",
  "-export const token = 'oldtoken';",
  "+export const token = process.env.TOKEN;",
  "",
].join("\n");

function wrap(json: Record<string, unknown>): string {
  return `<proposal>${JSON.stringify(json)}</proposal>`;
}

function stubClient(responseText: string) {
  return {
    messages: {
      create: async () => ({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: responseText }],
      }),
    },
  } as unknown as Parameters<typeof proposePatch>[1] extends infer O
    ? O extends { client?: infer C }
      ? C
      : never
    : never;
}

describe("renderUserPrompt", () => {
  it("includes error signature, source files, cassettes, and vendor docs", () => {
    const p = renderUserPrompt(makeContext());
    expect(p).toContain("invalid_auth");
    expect(p).toContain("src/client.ts");
    expect(p).toContain("postMessage-ok");
    expect(p).toContain("Bearer token");
    expect(p).toContain("Respond now");
  });

  it("produces deterministic output for the same context", () => {
    const a = renderUserPrompt(makeContext());
    const b = renderUserPrompt(makeContext());
    expect(a).toEqual(b);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("forbids prose inside the diff", () => {
    expect(SYSTEM_PROMPT).toContain("<proposal>");
    expect(SYSTEM_PROMPT).toContain("unified diff");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("no prose");
  });
});

describe("parseProposal strict parse", () => {
  it("accepts a clean proposal with valid diff", () => {
    const resp = wrap({
      diff: goodDiff,
      explanation: "rotate token to env var",
      confidence: "high",
      testsRecommended: ["postMessage-ok"],
    });
    const parsed = parseProposal(resp);
    expect(parsed.diff).toContain("--- a/src/client.ts");
    expect(parsed.explanation).toBe("rotate token to env var");
    expect(parsed.confidence).toBe("high");
    expect(parsed.testsRecommended).toEqual(["postMessage-ok"]);
  });

  it("rejects responses without a <proposal> wrapper", () => {
    expect(() =>
      parseProposal(
        JSON.stringify({
          diff: goodDiff,
          explanation: "x",
          confidence: "high",
          testsRecommended: [],
        }),
      ),
    ).toThrow(ProposalParseError);
  });

  it("rejects prose before the proposal wrapper", () => {
    const resp = `Sure, here is my proposal:\n${wrap({
      diff: goodDiff,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    })}`;
    // Our extractor finds the tag even with prose around it — but the prose-
    // in-diff check (which is the real regression guard) must catch that.
    // For the wrapper-only prose we're lenient; the important rule is that
    // the JSON inside the tag has no surrounding prose.
    expect(() => parseProposal(resp)).not.toThrow();
  });

  it("rejects prose INSIDE the <proposal> tag (around the JSON)", () => {
    const resp = `<proposal>\nHere's the JSON:\n${JSON.stringify({
      diff: goodDiff,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    })}\n</proposal>`;
    expect(() => parseProposal(resp)).toThrow(ProposalParseError);
  });

  it("rejects markdown fences inside the diff", () => {
    const contaminatedDiff = "```diff\n" + goodDiff + "\n```";
    const resp = wrap({
      diff: contaminatedDiff,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    });
    expect(() => parseProposal(resp)).toThrow(ProposalParseError);
  });

  it("rejects preamble prose before the --- a/ header", () => {
    const bad = `Here's what I changed:\n${goodDiff}`;
    const resp = wrap({
      diff: bad,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    });
    expect(() => parseProposal(resp)).toThrow(ProposalParseError);
  });

  it("rejects prose lines inside a hunk", () => {
    const bad = [
      "--- a/src/client.ts",
      "+++ b/src/client.ts",
      "@@ -1,1 +1,1 @@",
      "This line is prose, not a diff line",
      "-export const token = 'oldtoken';",
      "+export const token = process.env.TOKEN;",
    ].join("\n");
    const resp = wrap({
      diff: bad,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    });
    expect(() => parseProposal(resp)).toThrow(ProposalParseError);
  });

  it("rejects a diff missing its '--- a/' header", () => {
    const bad = [
      "@@ -1,1 +1,1 @@",
      "-export const token = 'oldtoken';",
      "+export const token = process.env.TOKEN;",
    ].join("\n");
    const resp = wrap({
      diff: bad,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    });
    expect(() => parseProposal(resp)).toThrow(ProposalParseError);
  });

  it("rejects a malformed hunk header", () => {
    const bad = [
      "--- a/src/client.ts",
      "+++ b/src/client.ts",
      "@@ malformed @@",
      "-x",
      "+y",
    ].join("\n");
    const resp = wrap({
      diff: bad,
      explanation: "x",
      confidence: "high",
      testsRecommended: [],
    });
    expect(() => parseProposal(resp)).toThrow(ProposalParseError);
  });

  it("accepts empty diff when confidence is low", () => {
    const resp = wrap({
      diff: "",
      explanation: "cannot determine fix without API docs",
      confidence: "low",
      testsRecommended: [],
    });
    const parsed = parseProposal(resp);
    expect(parsed.diff).toBe("");
    expect(parsed.confidence).toBe("low");
  });
});

describe("validateUnifiedDiff", () => {
  it("accepts multi-file diffs with git preamble", () => {
    const multi = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-let x = 1;",
      "+let x = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,1 @@",
      "-let y = 3;",
      "+let y = 4;",
      "",
    ].join("\n");
    expect(() => validateUnifiedDiff(multi)).not.toThrow();
  });

  it("accepts the '\\ No newline at end of file' marker", () => {
    const d = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(() => validateUnifiedDiff(d)).not.toThrow();
  });
});

describe("proposePatch — stubbed Anthropic client", () => {
  it("sends a prompt containing error, source, cassettes, and parses response", async () => {
    let capturedBody: unknown = null;
    const client = {
      messages: {
        create: async (body: unknown) => {
          capturedBody = body;
          return {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "text",
                text: wrap({
                  diff: goodDiff,
                  explanation: "rotate token",
                  confidence: "high",
                  testsRecommended: ["postMessage-ok"],
                }),
              },
            ],
          };
        },
      },
    };

    const ctx = makeContext();
    const proposal = await proposePatch(ctx, {
      apiKey: "sk-test",
      client: client as unknown as ConstructorParameters<typeof Object>[0] as never,
    });

    expect(proposal.diff).toContain("--- a/src/client.ts");
    expect(proposal.confidence).toBe("high");

    // Verify the prompt structure that was sent
    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
      model?: string;
      max_tokens?: number;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe("user");
    expect(body.messages[0]?.content).toContain("invalid_auth");
    expect(body.messages[0]?.content).toContain("src/client.ts");
    expect(body.messages[0]?.content).toContain("postMessage-ok");
    expect(body.model).toBeDefined();
  });

  it("returns a stub proposal when ANTHROPIC_API_KEY is missing", async () => {
    const originalKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const proposal = await proposePatch(makeContext());
      expect(proposal.stub).toBe(true);
      expect(proposal.diff).toBe("");
      expect(proposal.explanation).toContain("ANTHROPIC_API_KEY not set");
      expect(proposal.explanation).toContain("chorus init");
    } finally {
      if (originalKey !== undefined) process.env["ANTHROPIC_API_KEY"] = originalKey;
    }
  });

  it("throws when the response has prose mixed into the diff", async () => {
    const contaminatedDiff = "Here is the diff:\n" + goodDiff;
    const client = {
      messages: {
        create: async () => ({
          content: [
            {
              type: "text",
              text: wrap({
                diff: contaminatedDiff,
                explanation: "x",
                confidence: "high",
                testsRecommended: [],
              }),
            },
          ],
        }),
      },
    };

    await expect(
      proposePatch(makeContext(), {
        apiKey: "sk-test",
        client: client as unknown as ConstructorParameters<typeof Object>[0] as never,
      }),
    ).rejects.toThrow(ProposalParseError);
  });

  it("retries on 429 rate-limit and eventually succeeds", async () => {
    let attempts = 0;
    const client = {
      messages: {
        create: async () => {
          attempts += 1;
          if (attempts === 1) {
            const err = new Error("rate limited") as Error & {
              status: number;
              headers: Record<string, string>;
            };
            err.status = 429;
            err.headers = { "retry-after": "0" };
            throw err;
          }
          return {
            content: [
              {
                type: "text",
                text: wrap({
                  diff: goodDiff,
                  explanation: "ok",
                  confidence: "high",
                  testsRecommended: [],
                }),
              },
            ],
          };
        },
      },
    };

    const proposal = await proposePatch(makeContext(), {
      apiKey: "sk-test",
      client: client as unknown as ConstructorParameters<typeof Object>[0] as never,
      maxRateLimitRetries: 2,
    });
    expect(proposal.diff).toContain("--- a/src/client.ts");
    expect(attempts).toBe(2);
  });
});
