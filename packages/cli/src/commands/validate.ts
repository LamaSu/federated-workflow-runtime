/**
 * `chorus validate <workflow.yaml>` — schema-check a workflow file without
 * executing it. Useful in CI + pre-commit.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowSchema, type Workflow } from "@chorus/core";
import pc from "picocolors";
import { z } from "zod";
import { parseYaml } from "../yaml.js";

export interface ValidateResult {
  valid: boolean;
  workflow?: Workflow;
  errors: string[];
  /** Absolute path of the file that was validated. */
  path: string;
}

/**
 * Validate a single workflow file. Does NOT throw; returns a result object
 * so the caller can format for the terminal or for `--json`.
 */
export async function validateWorkflowFile(filePath: string): Promise<ValidateResult> {
  const abs = path.resolve(filePath);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    return {
      valid: false,
      errors: [`cannot read file: ${(err as Error).message}`],
      path: abs,
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      valid: false,
      errors: [`yaml parse: ${(err as Error).message}`],
      path: abs,
    };
  }

  const result = WorkflowSchema.safeParse(raw);
  if (!result.success) {
    return {
      valid: false,
      errors: formatZodErrors(result.error),
      path: abs,
    };
  }
  return { valid: true, workflow: result.data, errors: [], path: abs };
}

function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const location = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${location}: ${issue.message}`;
  });
}

/**
 * CLI entry point. Returns exit code (0 on success, 1 on failure).
 */
export async function runValidate(
  files: string[],
  opts: { json?: boolean } = {},
): Promise<number> {
  if (files.length === 0) {
    process.stderr.write(pc.red("error: provide at least one workflow file\n"));
    return 1;
  }

  const results = await Promise.all(files.map((f) => validateWorkflowFile(f)));

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return results.every((r) => r.valid) ? 0 : 1;
  }

  let exitCode = 0;
  for (const r of results) {
    if (r.valid) {
      process.stdout.write(
        `${pc.green("OK")} ${r.path} — ${pc.dim(`workflow '${r.workflow!.name}' v${r.workflow!.version}`)}\n`,
      );
    } else {
      exitCode = 1;
      process.stdout.write(`${pc.red("FAIL")} ${r.path}\n`);
      for (const e of r.errors) {
        process.stdout.write(`   ${pc.red("•")} ${e}\n`);
      }
    }
  }
  return exitCode;
}
