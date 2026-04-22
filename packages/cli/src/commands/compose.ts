/**
 * `chorus compose "<prompt>"` — NL → TypeScript workflow file.
 *
 * Implements Task 2 of the Chorus expansion landscape
 * (ai/research/landscape-chorus-expansion-2026-04-22.md). The LLM is the
 * parser; Zod validation via `generateObject` catches drift; TypeScript is
 * the output format because n8n-as-code shows LLMs hallucinate less in TS
 * than raw JSON.
 *
 * Flow:
 *   1. Call generateObject({ schema: WorkflowSchema, system, prompt }).
 *   2. Zod validates (the SDK does this for us).
 *   3. If validation fails, retry up to 3 times, feeding the diagnostic back
 *      into the prompt so the model can self-correct.
 *   4. Emit TypeScript at ./chorus/<slug>.ts that imports Workflow from
 *      @delightfulchorus/core and exports a default Workflow.
 *
 * Tests inject a mock LanguageModel via the `model` override so no real API
 * is contacted. The production binary defaults to anthropic("claude-opus-4-7").
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowSchema, type Workflow } from "@delightfulchorus/core";
import pc from "picocolors";
import type { z } from "zod";
import { COMPOSE_SYSTEM_PROMPT } from "../prompts/compose-system.js";

/**
 * Minimal shape of the Vercel AI SDK `generateObject` return we actually
 * consume. Declared locally so the command module's type surface doesn't
 * leak the SDK's full API into @delightfulchorus/cli consumers.
 */
export interface GenerateObjectResult<T> {
  object: T;
}

/**
 * Shape of a model handle we accept. In production this is the result of
 * `anthropic("claude-opus-4-7")`; in tests it's a `MockLanguageModelV1`.
 * We do not constrain the type further here — the Vercel AI SDK changes
 * its internal model surface often enough that a structural type is
 * friendlier than a nominal import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LanguageModelLike = any;

/**
 * Injectable generateObject. Defaults to the real Vercel AI SDK function.
 * Tests override this so we never make a network call.
 */
export type GenerateObjectFn = <T>(args: {
  model: LanguageModelLike;
  schema: z.ZodTypeAny;
  system: string;
  prompt: string;
}) => Promise<GenerateObjectResult<T>>;

export interface ComposeOptions {
  /** The user's natural-language description of the workflow. */
  prompt: string;
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Override the LanguageModel handle. Required for tests (pass a
   * MockLanguageModelV1). If absent, the command loads
   * `@ai-sdk/anthropic` lazily and uses `anthropic("claude-opus-4-7")`.
   */
  model?: LanguageModelLike;
  /**
   * Override the generateObject function. Required for tests (pass a stub
   * that returns a fixture). If absent, the command loads `ai` lazily.
   */
  generateObject?: GenerateObjectFn;
  /**
   * Maximum Ralph-loop retries on Zod validation failure. Defaults to 3 —
   * the landscape brief specifies "retry up to 3 times with diagnostic".
   */
  maxAttempts?: number;
  /** Suppress user-visible logging. Tests set this to true. */
  silent?: boolean;
  /**
   * Override the output slug. When not provided, the slug is derived from
   * the composed workflow's `name` (or the first line of the prompt).
   */
  slug?: string;
}

export interface ComposeResult {
  /** Absolute path of the generated TS file. */
  filePath: string;
  /** The validated workflow that was written. */
  workflow: Workflow;
  /** Number of generateObject calls made (1 + retries). */
  attempts: number;
  /**
   * Collected validation errors from failed attempts, in order. Empty if
   * the first attempt succeeded.
   */
  validationHistory: string[][];
}

export class ComposeFailedError extends Error {
  constructor(
    public attempts: number,
    public validationHistory: string[][],
  ) {
    const lastErrors = validationHistory[validationHistory.length - 1] ?? [];
    super(
      `compose: failed after ${attempts} attempts. Last errors:\n  ${lastErrors.join(
        "\n  ",
      )}`,
    );
    this.name = "ComposeFailedError";
  }
}

/**
 * Programmatic entry point. Deterministic given injected model +
 * generateObject. Returns the full result; does NOT exit the process.
 */
export async function runCompose(options: ComposeOptions): Promise<ComposeResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxAttempts = options.maxAttempts ?? 3;
  if (maxAttempts < 1) {
    throw new Error("compose: maxAttempts must be >= 1");
  }
  if (!options.prompt || options.prompt.trim().length === 0) {
    throw new Error("compose: prompt must be a non-empty string");
  }

  const model = options.model ?? (await loadDefaultModel());
  const generateObject = options.generateObject ?? (await loadDefaultGenerateObject());

  const validationHistory: string[][] = [];
  let lastDiagnostic: string | null = null;
  let workflow: Workflow | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    const prompt = lastDiagnostic
      ? buildRetryPrompt(options.prompt, lastDiagnostic)
      : options.prompt;

    let candidate: unknown;
    try {
      const result = await generateObject<unknown>({
        model,
        schema: WorkflowSchema,
        system: COMPOSE_SYSTEM_PROMPT,
        prompt,
      });
      candidate = result.object;
    } catch (err) {
      // Network/model errors: bubble up. If this was a validation error from
      // the SDK, we still want to retry based on the message body.
      const message = err instanceof Error ? err.message : String(err);
      validationHistory.push([`model call failed: ${message}`]);
      lastDiagnostic = message;
      continue;
    }

    // Defense-in-depth: re-parse here in case the SDK returned an untyped
    // object (e.g., older SDK versions that do not validate). The Zod
    // schema is the source of truth — a second parse is cheap.
    const parsed = WorkflowSchema.safeParse(candidate);
    if (parsed.success) {
      workflow = parsed.data;
      break;
    }
    const formatted = formatZodErrors(parsed.error);
    validationHistory.push(formatted);
    lastDiagnostic = formatted.join("\n");
  }

  if (!workflow) {
    throw new ComposeFailedError(attempts, validationHistory);
  }

  const slug = options.slug ?? deriveSlug(workflow.name, options.prompt);
  const outDir = path.join(cwd, "chorus");
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${slug}.ts`);

  const body = renderTypeScriptWorkflow(workflow);
  await writeFile(filePath, body, "utf8");

  if (!options.silent) {
    const p = process.stdout.write.bind(process.stdout);
    p(
      `${pc.green("✓")} Wrote chorus/${slug}.ts (${workflow.nodes.length} node${
        workflow.nodes.length === 1 ? "" : "s"
      }, trigger: ${pc.cyan(workflow.trigger.type)})\n`,
    );
    if (attempts > 1) {
      p(`   ${pc.dim(`recovered after ${attempts - 1} validation retry(ies)`)}\n`);
    }
  }

  return { filePath, workflow, attempts, validationHistory };
}

/**
 * Commander entry point. Wraps runCompose with process.exit behavior and
 * human-formatted errors.
 */
export async function composeCommand(
  prompt: string,
  opts: { maxAttempts?: number; slug?: string } = {},
): Promise<number> {
  try {
    await runCompose({
      prompt,
      maxAttempts: opts.maxAttempts,
      slug: opts.slug,
    });
    return 0;
  } catch (err) {
    if (err instanceof ComposeFailedError) {
      process.stderr.write(
        pc.red(
          `compose: model output never validated after ${err.attempts} attempts.\n`,
        ),
      );
      for (const [i, errors] of err.validationHistory.entries()) {
        process.stderr.write(pc.dim(`  attempt ${i + 1}:\n`));
        for (const e of errors) {
          process.stderr.write(`    ${pc.red("•")} ${e}\n`);
        }
      }
      return 1;
    }
    process.stderr.write(pc.red(`compose: ${(err as Error).message}\n`));
    return 1;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Slugify a string: lowercase, alphanumerics + hyphens, trim, dedupe
 * hyphens, cap length. Used for the output filename when the caller has
 * not supplied one.
 */
export function slugify(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const alnum = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  const stripped = alnum.replace(/^-+|-+$/g, "");
  const capped = stripped.slice(0, 40).replace(/-+$/g, "");
  return capped || "workflow";
}

/**
 * Derive a file slug: prefer the workflow's declared id, else its name,
 * else the first line of the user's prompt. Always returns a non-empty
 * string.
 */
export function deriveSlug(workflowName: string, userPrompt: string): string {
  const fromName = slugify(workflowName);
  if (fromName && fromName !== "workflow") return fromName;
  const firstLine = userPrompt.split(/\r?\n/)[0] ?? userPrompt;
  return slugify(firstLine);
}

/**
 * Build the retry prompt — the original user prompt plus an attached
 * diagnostic describing exactly which fields failed Zod validation.
 * Mirrors the Ralph-loop pattern: failures are data; feed them back.
 */
function buildRetryPrompt(userPrompt: string, diagnostic: string): string {
  return [
    userPrompt,
    "",
    "---",
    "Your previous response failed schema validation with the following errors:",
    diagnostic,
    "",
    "Fix these specific issues and return a valid Workflow object.",
  ].join("\n");
}

/**
 * Format a ZodError into one short diagnostic per issue. Mirrors the style
 * used by `chorus validate` so users see consistent messages across
 * compose-time and run-time validation.
 */
function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const location = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${location}: ${issue.message}`;
  });
}

/**
 * Stable JSON stringify — two-space indent, sorted keys where the emitted
 * shape benefits from determinism (so two runs of compose with the same
 * seed produce the same output file). Zod's parse preserves insertion
 * order; we leave the core shape alone and only re-serialize.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Emit the TypeScript file contents. The output imports Workflow from
 * @delightfulchorus/core and exports a default. We intentionally do NOT
 * emit `as const` — the Workflow type erases the narrowed literal types,
 * and `as const` would force readonly arrays which the runtime doesn't
 * expect.
 *
 * The generated file is self-contained: it can be loaded by
 * `chorus run <file>.ts` via the existing TypeScript loader (tsx/ts-node)
 * that the runtime already wires up.
 */
export function renderTypeScriptWorkflow(workflow: Workflow): string {
  const header = [
    "/**",
    " * Generated by `chorus compose`.",
    " * Edit freely — re-running compose will NOT overwrite (errors if file exists).",
    " */",
    'import type { Workflow } from "@delightfulchorus/core";',
    "",
  ].join("\n");

  const body = [
    "const workflow: Workflow = ",
    stableJson(workflow),
    ";",
    "",
    "export default workflow;",
    "",
  ].join("\n");

  return header + "\n" + body;
}

/**
 * Lazy-load the real Vercel AI SDK. We use dynamic import so tests (which
 * always pass `generateObject`/`model`) never incur the cost of loading the
 * SDK, and so the command file still compiles when the SDK isn't installed
 * yet (the error surfaces at runtime with a clear message).
 */
async function loadDefaultGenerateObject(): Promise<GenerateObjectFn> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<unknown>;
    const mod = (await dynamicImport("ai")) as {
      generateObject?: GenerateObjectFn;
    };
    if (!mod.generateObject) {
      throw new Error("the 'ai' package did not export generateObject");
    }
    return mod.generateObject;
  } catch (err) {
    throw new Error(
      `compose: could not load the 'ai' package — ${
        (err as Error).message
      }. Install it with: npm install ai @ai-sdk/anthropic`,
    );
  }
}

async function loadDefaultModel(): Promise<LanguageModelLike> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<unknown>;
    const mod = (await dynamicImport("@ai-sdk/anthropic")) as {
      anthropic?: (id: string) => LanguageModelLike;
    };
    if (!mod.anthropic) {
      throw new Error("the '@ai-sdk/anthropic' package did not export anthropic()");
    }
    // claude-opus-4-7 — per user's CLAUDE.md directive for opus pins.
    return mod.anthropic("claude-opus-4-7");
  } catch (err) {
    throw new Error(
      `compose: could not load '@ai-sdk/anthropic' — ${
        (err as Error).message
      }. Install it with: npm install ai @ai-sdk/anthropic, and set ANTHROPIC_API_KEY.`,
    );
  }
}
