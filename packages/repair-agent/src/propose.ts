import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { PatchConfidence, PatchProposal, RepairContext } from "./types.js";

/**
 * The EXACT system prompt sent to Claude. Intentionally strict: the model must
 * emit JSON inside `<proposal>` tags, with `diff` being a pure unified diff.
 * Any prose outside the proposal tag is discarded. Any prose mixed INTO the
 * diff block is rejected by `parseProposal` — this is a hard failure, not a warning.
 */
export const SYSTEM_PROMPT = `You are the Chorus Repair Agent.

Your job: given a failing integration's error signature, source code, recent HTTP cassettes, and (optionally) vendor documentation, propose a minimal unified-diff patch that fixes the failure.

STRICT OUTPUT FORMAT

You MUST respond with exactly one <proposal>...</proposal> block. No prose before it, no prose after it. Inside the block, emit a single JSON object with these fields and no others:

{
  "diff": "<unified diff text>",
  "explanation": "<2-4 sentences: what you changed and why>",
  "confidence": "low" | "medium" | "high",
  "testsRecommended": ["<cassette or scenario name>", ...]
}

Rules for the "diff" field:

1. It MUST be a valid unified diff, applyable with \`git apply\`.
2. It MUST begin with \`--- a/<path>\` and \`+++ b/<path>\` headers.
3. Each hunk MUST start with \`@@ -X,Y +X,Y @@\`.
4. File paths MUST be relative to the integration root, forward-slash separated.
5. NO prose in the diff field. NO markdown fences. NO "here is the patch:" preamble. Just the raw diff text.
6. If you cannot propose a patch, set "confidence" to "low", put the reason in "explanation", and leave "diff" as an empty string "".

Rules for "confidence":
- "high": you have strong evidence from cassettes + docs that this patch fixes the signature
- "medium": the fix matches the symptom but you could not confirm with a cassette
- "low": speculative or you lack enough context

Violations (prose leaking into diff, malformed diff, missing headers, JSON outside the tag) are rejected and you do not get a retry. Be precise.`;

const PatchProposalSchema = z.object({
  diff: z.string(),
  explanation: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  testsRecommended: z.array(z.string()).default([]),
});

export interface ProposeOptions {
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  /** Inject a pre-constructed Anthropic client (tests use this to stub). */
  client?: Anthropic;
  /** Max retries on 429 rate-limit. Default 2. */
  maxRateLimitRetries?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Ask Claude for a patch proposal. Strict parse — prose contamination throws.
 */
export async function proposePatch(
  context: RepairContext,
  options: ProposeOptions = {},
): Promise<PatchProposal> {
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];

  // No API key: return a stub so tests / dry-runs don't burn tokens.
  if (!apiKey && !options.client) {
    return {
      diff: "",
      explanation:
        "ANTHROPIC_API_KEY not set \u2014 run `chorus init` to configure",
      confidence: "low",
      testsRecommended: [],
      stub: true,
    };
  }

  const client =
    options.client ??
    new Anthropic({
      apiKey: apiKey ?? undefined,
    });

  const userPrompt = renderUserPrompt(context);

  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxRetries = options.maxRateLimitRetries ?? 2;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          // Static portion — cache-eligible. Vendor docs & integration source are static
          // between repairs for the same signature, so we cache them up front.
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ] as unknown as string, // Anthropic SDK accepts blocks as system via beta; cast for compat
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      });

      const text = extractText(response);
      return parseProposal(text);
    } catch (err) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        const delayMs = backoffMs(attempt, err);
        attempt += 1;
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Extract the first text block from a Messages API response.
 * The Anthropic SDK returns content as an array of blocks; we want `text`.
 */
function extractText(response: unknown): string {
  const r = response as { content?: Array<{ type?: string; text?: string }> };
  const blocks = r.content ?? [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") return b.text;
  }
  throw new Error("Claude response had no text block");
}

/**
 * Strict parse. Rejects any of:
 *  - No <proposal>...</proposal> wrapper
 *  - Prose between the tag and the JSON object
 *  - Non-JSON inside the tag
 *  - `diff` field not matching unified-diff shape (has headers + hunks)
 *  - `diff` field containing non-diff prose (markdown fences, sentences before ---)
 */
export function parseProposal(text: string): PatchProposal {
  const match = text.match(/<proposal>([\s\S]*?)<\/proposal>/);
  if (!match) {
    throw new ProposalParseError(
      "response missing <proposal>...</proposal> wrapper",
    );
  }
  const inner = match[1]?.trim() ?? "";
  if (!inner.startsWith("{") || !inner.endsWith("}")) {
    throw new ProposalParseError(
      "proposal tag must contain a single JSON object with no surrounding prose",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(inner);
  } catch (err) {
    throw new ProposalParseError(
      `invalid JSON inside <proposal>: ${(err as Error).message}`,
    );
  }

  const parsed = PatchProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProposalParseError(
      `proposal JSON did not match schema: ${parsed.error.message}`,
    );
  }

  const { diff, explanation, confidence, testsRecommended } = parsed.data;

  if (diff.length > 0) {
    validateUnifiedDiff(diff);
  }

  return {
    diff,
    explanation,
    confidence: confidence as PatchConfidence,
    testsRecommended,
  };
}

/**
 * Validate that `diff` is a clean unified diff with no prose contamination.
 *
 * Accepts:
 *   --- a/path
 *   +++ b/path
 *   @@ -X,Y +X,Y @@
 *   [context, +added, -removed lines]
 *
 * Rejects:
 *   Lines before the first `---` header that aren't blank
 *   Markdown fences (```)
 *   Lines inside a hunk that don't start with ' ', '+', '-', or '\' (backslash for "no newline")
 */
export function validateUnifiedDiff(diff: string): void {
  if (diff.includes("```")) {
    throw new ProposalParseError(
      "diff contains markdown code fence — prose contamination",
    );
  }

  const lines = diff.split("\n");
  let sawHeader = false;
  let inHunk = false;
  let sawHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (!sawHeader) {
      if (line.startsWith("--- ")) {
        sawHeader = true;
        const next = lines[i + 1] ?? "";
        if (!next.startsWith("+++ ")) {
          throw new ProposalParseError(
            `expected '+++' line after '---' at line ${i + 1}`,
          );
        }
        continue;
      }
      // Before first header: only blank lines or `diff --git` preamble are OK.
      if (line.trim() === "") continue;
      if (line.startsWith("diff --git ") || line.startsWith("index ")) continue;
      throw new ProposalParseError(
        `unexpected prose before diff header at line ${i + 1}: ${JSON.stringify(line.slice(0, 80))}`,
      );
    }

    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("index ")) continue;

    if (line.startsWith("@@ ")) {
      // Hunk header — must match @@ -a,b +c,d @@ OR @@ -a +c @@
      if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) {
        throw new ProposalParseError(
          `malformed hunk header at line ${i + 1}: ${JSON.stringify(line.slice(0, 80))}`,
        );
      }
      inHunk = true;
      sawHunk = true;
      continue;
    }

    if (inHunk) {
      if (line === "") {
        // Trailing blank lines are allowed as part of context/transition.
        continue;
      }
      const c = line[0];
      if (c === " " || c === "+" || c === "-" || c === "\\") continue;
      throw new ProposalParseError(
        `prose line inside hunk at line ${i + 1}: ${JSON.stringify(line.slice(0, 80))}`,
      );
    }

    // Outside a hunk, between files, only the above header markers are OK.
    if (line.trim() === "") continue;
    throw new ProposalParseError(
      `unexpected line between hunks at line ${i + 1}: ${JSON.stringify(line.slice(0, 80))}`,
    );
  }

  if (!sawHeader || !sawHunk) {
    throw new ProposalParseError(
      "diff missing required '--- a/' header or '@@' hunk",
    );
  }
}

export class ProposalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalParseError";
  }
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number };
  return e.status === 429;
}

function backoffMs(attempt: number, err: unknown): number {
  const e = err as { headers?: Record<string, string | undefined> } | undefined;
  const retryAfter = e?.headers?.["retry-after"];
  if (retryAfter) {
    const n = Number(retryAfter);
    if (!Number.isNaN(n)) return Math.max(100, n * 1000);
  }
  return 500 * Math.pow(2, attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the user-turn prompt. Kept deterministic so prompt caching works.
 */
export function renderUserPrompt(ctx: RepairContext): string {
  const parts: string[] = [];

  parts.push("## Error signature");
  parts.push("```json");
  parts.push(JSON.stringify(ctx.error, null, 2));
  parts.push("```");
  parts.push("");

  if (ctx.manifest) {
    parts.push("## Integration manifest");
    parts.push("```json");
    parts.push(JSON.stringify(ctx.manifest, null, 2));
    parts.push("```");
    parts.push("");
  }

  parts.push(`## Integration source (root: ${toPosix(ctx.integrationDir)})`);
  for (const f of ctx.sourceFiles) {
    parts.push(`### ${f.relPath}`);
    parts.push("```");
    parts.push(f.contents);
    parts.push("```");
    parts.push("");
  }

  if (ctx.cassettes.length > 0) {
    parts.push(`## Recent cassettes (${ctx.cassettes.length})`);
    for (const c of ctx.cassettes) {
      parts.push(
        `### ${c.id} (${c.succeeded ? "OK" : "FAIL"}, status=${c.interaction.response.status})`,
      );
      parts.push("```json");
      parts.push(JSON.stringify(c.interaction, null, 2));
      parts.push("```");
      parts.push("");
    }
  }

  if (ctx.vendorDocs) {
    parts.push("## Vendor documentation");
    parts.push(ctx.vendorDocs);
    parts.push("");
  }

  parts.push("Respond now with <proposal>...</proposal>.");

  return parts.join("\n");
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
