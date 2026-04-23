/**
 * `chorus skill <workflow-file>` — convert a Chorus workflow into a Claude
 * Code skill. Writes a `SKILL.md` with YAML frontmatter that, when invoked
 * by the agent, instructs it to run `chorus run <workflow-id>`.
 *
 * Output layout:
 *   <out-dir>/chorus-<slug>/SKILL.md
 *
 * Default `<out-dir>` is `./.claude/skills` (project-local). `--global`
 * writes to `~/.claude/skills` (user-global).
 *
 * Why this exists: users who live in Claude Code want to trigger workflows
 * by typing `/chorus-my-workflow` instead of remembering the `chorus run`
 * invocation. This command produces a skill file that the agent loads
 * natively — the skill body becomes the agent's instruction set, and a
 * single `chorus run` tool call carries out the work.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import pc from "picocolors";
import { WorkflowSchema, type Workflow } from "@delightfulchorus/core";
import { parseYaml } from "../yaml.js";
import { slugify } from "./compose.js";

export interface SkillOptions {
  /** Override output directory. Default: `./.claude/skills`. */
  outDir?: string;
  /** Write to `~/.claude/skills` instead of the project-local dir. */
  global?: boolean;
  /** Override the skill name (default: `chorus-<slug>`). */
  name?: string;
  /** Print to stdout instead of writing to disk. */
  stdout?: boolean;
  /** Overwrite an existing SKILL.md without prompting. */
  force?: boolean;
}

export interface SkillResult {
  /** Skill name written to frontmatter (e.g. `chorus-weekly-review`). */
  skillName: string;
  /** Absolute path of the written SKILL.md, or `null` if `--stdout`. */
  path: string | null;
  /** Rendered SKILL.md content. */
  content: string;
}

/**
 * Pure function: turn a validated `Workflow` into SKILL.md content.
 * Separate from I/O so tests can assert on the rendered string directly.
 */
export function renderSkill(workflow: Workflow, skillName: string): string {
  const description = buildDescription(workflow);
  const nodeLines = workflow.nodes
    .map((n, i) => `${i + 1}. \`${n.id}\` — ${n.integration}.${n.operation}`)
    .join("\n");
  const trigger = workflow.trigger;
  const triggerDescription =
    trigger.type === "manual"
      ? "Run on demand (`manual` trigger). The agent invokes it directly."
      : trigger.type === "webhook"
        ? `Originally a webhook trigger (\`${
            (trigger as { method?: string; path?: string }).method ?? "POST"
          } ${(trigger as { path?: string }).path ?? "/"}\`). When invoked as a skill, the agent runs it manually.`
        : trigger.type === "schedule"
          ? `Originally a scheduled trigger. When invoked as a skill, the agent runs it immediately.`
          : `Trigger type: \`${trigger.type}\`.`;

  return [
    "---",
    `name: ${skillName}`,
    `description: ${escapeYamlOneLine(description)}`,
    "---",
    "",
    `# ${skillName}`,
    "",
    `Generated from Chorus workflow \`${workflow.name}\` (id \`${workflow.id}\`, v${workflow.version}).`,
    "",
    "## What this does",
    "",
    triggerDescription,
    "",
    "### Steps",
    "",
    nodeLines || "_(no nodes defined)_",
    "",
    "## How to run",
    "",
    "Invoke the Chorus runtime with the workflow id. The workflow file itself",
    "lives in the project's `chorus/workflows/` directory — this skill is a",
    "thin pointer, not a copy.",
    "",
    "```bash",
    `chorus run ${workflow.id}`,
    "```",
    "",
    "If the workflow expects input, pass it via `--input`:",
    "",
    "```bash",
    `chorus run ${workflow.id} --input '{"key":"value"}'`,
    "```",
    "",
    "## Notes",
    "",
    "- This skill is a **shortcut**, not a replacement for the workflow file.",
    "  Editing it here does not change what runs.",
    "- The source of truth is `chorus/workflows/" + workflow.id + ".yaml` (or",
    "  wherever the workflow lives in the current project).",
    "- Regenerate after changes: `chorus skill <workflow-file> --force`.",
    "",
  ].join("\n");
}

/**
 * Validate + render + optionally write. Returns a result object so the CLI
 * wrapper can format output and honor `--json`.
 */
export async function generateSkill(
  workflowPath: string,
  opts: SkillOptions = {},
): Promise<SkillResult> {
  const abs = path.resolve(workflowPath);
  const text = await readFile(abs, "utf8");
  const raw = parseYaml(text);
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid workflow (${abs}): ${issues}`);
  }
  const workflow = parsed.data;

  const slug = slugify(workflow.id) || slugify(workflow.name) || "workflow";
  const skillName = opts.name ?? `chorus-${slug}`;
  const content = renderSkill(workflow, skillName);

  if (opts.stdout) {
    return { skillName, path: null, content };
  }

  const baseDir = opts.outDir
    ? path.resolve(opts.outDir)
    : opts.global
      ? path.join(homedir(), ".claude", "skills")
      : path.resolve(".claude", "skills");
  const skillDir = path.join(baseDir, skillName);
  const skillFile = path.join(skillDir, "SKILL.md");

  await mkdir(skillDir, { recursive: true });
  // Overwrite is the default — skills are regenerated from workflows, not
  // hand-edited. `--force` exists for parity with other commands but is a
  // no-op today.
  await writeFile(skillFile, content, "utf8");

  return { skillName, path: skillFile, content };
}

function buildDescription(workflow: Workflow): string {
  // Frontmatter description drives skill discovery. Keep it short + specific.
  const head = `Run the Chorus workflow '${workflow.name}'`;
  const nodeCount = workflow.nodes.length;
  const detail =
    nodeCount === 0
      ? "(no steps defined)"
      : nodeCount === 1
        ? `(1 step: ${workflow.nodes[0].integration}.${workflow.nodes[0].operation})`
        : `(${nodeCount} steps across ${uniqueIntegrations(workflow).join(", ")})`;
  return `${head} ${detail}.`;
}

function uniqueIntegrations(workflow: Workflow): string[] {
  const set = new Set<string>();
  for (const n of workflow.nodes) set.add(n.integration);
  return Array.from(set);
}

function escapeYamlOneLine(s: string): string {
  // Single-quote if contains `:` or `#` or starts with a YAML indicator.
  // Otherwise leave plain. Double any single quotes inside.
  if (/[:#]|^[!&*>|%@`]/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

/**
 * CLI entry point. Returns exit code (0 ok, 1 fail).
 */
export async function runSkill(
  workflowFile: string | undefined,
  opts: SkillOptions & { json?: boolean } = {},
): Promise<number> {
  if (!workflowFile) {
    process.stderr.write(pc.red("error: provide a workflow file path\n"));
    return 1;
  }
  try {
    const result = await generateSkill(workflowFile, opts);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { skillName: result.skillName, path: result.path },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    if (opts.stdout) {
      process.stdout.write(result.content);
      return 0;
    }
    process.stdout.write(
      `${pc.green("OK")} wrote ${pc.bold(result.skillName)} → ${pc.dim(result.path ?? "(stdout)")}\n`,
    );
    process.stdout.write(
      pc.dim(
        `   invoke in Claude Code: /${result.skillName} — runs \`chorus run <id>\`\n`,
      ),
    );
    return 0;
  } catch (err) {
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}
