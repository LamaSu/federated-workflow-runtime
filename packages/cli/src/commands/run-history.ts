/**
 * `chorus run history <runId>` — list per-step rows for a run.
 * `chorus run replay <runId> --from <stepName> [--mutate p=v ...]` — fork a
 * new run starting from a given step.
 *
 * Both commands read (and `replay` also writes) the local SQLite DB. The DB
 * is opened via `@delightfulchorus/runtime`'s `openDatabase` so we share the
 * exact migration code path the runtime uses; this is a hard import (not the
 * `tryImportRuntime` softness used in `chorus run`) because `forkRun` and
 * `getRunHistory` are runtime exports we cannot stub.
 *
 * Output modes:
 *   - human-readable table (default, ANSI-colored)
 *   - `--json` — pretty-printed JSON for agents and scripting
 *
 * Memoization invariant (mirrors fork-run.ts §step.run):
 *   When forkRun is called with `fromStep=X`, all steps DECLARED BEFORE X
 *   in the workflow definition that have status='success' on the source
 *   run are copied into the new run. The next dispatch pass sees these
 *   memoized rows and short-circuits — only X and downstream nodes
 *   actually execute. The CLI does NOT drive the executor; tests must
 *   manually invoke it (or the user starts the runtime via `chorus run`)
 *   to observe the replay in motion. This command's job is to enqueue
 *   the fork; the runtime's normal dispatch loop picks it up.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import {
  forkRun,
  getRunHistory,
  getRunOverview,
  openDatabase,
  parsePath,
} from "@delightfulchorus/runtime";
import { loadConfig } from "../config.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface RunHistoryOptions {
  cwd?: string;
  /** Run id to inspect. Required positional arg from commander. */
  runId: string;
  /** Emit JSON instead of the human table. */
  json?: boolean;
  /**
   * Capture stream for tests — bypasses process.stdout. When provided, the
   * function appends each chunk to this array AND skips writing to stdout.
   * (Allows snapshotting output without monkey-patching globals.)
   */
  captureStdout?: string[];
  /** Override DB path (tests). When set, skips loadConfig entirely. */
  dbPathOverride?: string;
}

export interface RunReplayOptions {
  cwd?: string;
  /** Source run id to fork. */
  runId: string;
  /** Step to start re-execution from. Required by forkRun. */
  fromStep: string;
  /**
   * Raw `--mutate` strings as supplied on the command line. Each is
   * `<jsonpath>=<value>` where `<value>` is JSON-decoded if possible
   * (numbers, bools, quoted strings, objects, arrays) or treated as a
   * raw string otherwise. A leading `@` on the value reads it from a
   * file. Multiple `--mutate` flags accumulate.
   */
  mutates?: string[];
  /** Emit JSON instead of human output. */
  json?: boolean;
  /** See RunHistoryOptions.captureStdout. */
  captureStdout?: string[];
  /** Override DB path (tests). */
  dbPathOverride?: string;
}

// ── DB resolution ────────────────────────────────────────────────────────────

/**
 * Compute the absolute path to the local Chorus SQLite database. Mirrors the
 * resolution in commands/report.ts: relative paths in config.database.path
 * are anchored at the chorusDir's parent (i.e., the project root).
 *
 * Pulled out so tests can fully bypass it via opts.dbPathOverride.
 */
export async function resolveDbPath(cwd: string): Promise<string> {
  const { config, chorusDir } = await loadConfig(cwd);
  return path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);
}

// Static ESM imports above bind us to @delightfulchorus/runtime at module
// load time. tsup keeps the import external (see packages/cli/package.json
// build script) so the actual resolution happens when the CLI runs. If the
// runtime is missing/unbuilt, Node's loader throws on first import — the
// process never reaches command execution. That's the right behavior for
// these commands: forkRun and getRunHistory have no degraded mode.
//
// (Compare with `chorus run`, which uses tryImportRuntime to soft-fail
// when the runtime isn't built yet — the user gets a clear "build first"
// message instead of an opaque ESM resolution error. We could mirror that
// for history/replay if the developer-experience win matters; for now the
// CLI is shipped together with the runtime so the soft path is dead code.)

// ── Mutation parsing ────────────────────────────────────────────────────────

/**
 * Parse a single `--mutate` arg of the form `<jsonpath>=<value>`. The value
 * is JSON-decoded when it parses as JSON; otherwise it's treated as a raw
 * string (so `--mutate 'name=alice'` works without quoting). A leading `@`
 * on the value reads it from a file path.
 *
 * Examples:
 *   "count=5"           → { path: "count", value: 5 }
 *   'name="alice"'      → { path: "name", value: "alice" }
 *   "name=alice"        → { path: "name", value: "alice" } (string fallback)
 *   "items[0]=true"     → { path: "items[0]", value: true }
 *   "user=@./user.json" → reads file, JSON.parse
 *
 * Exposed for tests.
 */
export async function parseMutate(arg: string): Promise<{ path: string; value: unknown }> {
  const eq = arg.indexOf("=");
  if (eq < 0) {
    throw new Error(
      `--mutate must be of the form <jsonpath>=<value>, got: ${arg}`,
    );
  }
  const pathPart = arg.slice(0, eq).trim();
  const valuePart = arg.slice(eq + 1);
  if (pathPart.length === 0) {
    throw new Error(`--mutate has empty path in: ${arg}`);
  }

  let value: unknown;
  if (valuePart.startsWith("@")) {
    const filePath = valuePart.slice(1);
    const text = await readFile(filePath, "utf8");
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `--mutate file ${filePath} is not valid JSON: ${(err as Error).message}`,
      );
    }
  } else {
    // Try JSON first; fall back to raw string (so `name=alice` works).
    try {
      value = JSON.parse(valuePart);
    } catch {
      value = valuePart;
    }
  }
  return { path: pathPart, value };
}

/** Compose a Mutations record from a list of `path=value` strings. */
export async function buildMutations(
  args: string[] | undefined,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (!args || args.length === 0) return out;
  for (const a of args) {
    const { path, value } = await parseMutate(a);
    out[path] = value;
  }
  return out;
}

// ── chorus run history ──────────────────────────────────────────────────────

/**
 * Run the `chorus run history <runId>` command. Returns the process exit
 * code (0 on success, 1 on failure such as unknown run, 2 on environment
 * errors like a missing runtime build).
 */
export async function runRunHistory(opts: RunHistoryOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const writeOut = makeWriter(opts.captureStdout);
  const writeErr = makeErrWriter();

  let dbPath: string;
  try {
    dbPath = opts.dbPathOverride ?? (await resolveDbPath(cwd));
  } catch (err) {
    writeErr(pc.red(`✗ cannot resolve database path: ${(err as Error).message}\n`));
    return 2;
  }

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(dbPath);
  } catch (err) {
    writeErr(pc.red(`✗ cannot open database at ${dbPath}: ${(err as Error).message}\n`));
    return 2;
  }
  try {
    const overview = getRunOverview(db, opts.runId);
    if (!overview) {
      writeErr(pc.red(`✗ unknown run: ${opts.runId}\n`));
      return 1;
    }
    const history = getRunHistory(db, opts.runId);

    if (opts.json) {
      writeOut(
        JSON.stringify(
          {
            run: {
              id: overview.id,
              workflowId: overview.workflow_id,
              workflowVersion: overview.workflow_version,
              status: overview.status,
              triggeredBy: overview.triggered_by,
              startedAt: overview.started_at,
              finishedAt: overview.finished_at,
              error: overview.error,
              attempt: overview.attempt,
              priority: overview.priority,
            },
            steps: history,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    // Human-readable mode -----------------------------------------------------
    writeOut(
      `${pc.bold("Run")} ${pc.cyan(overview.id)}  ${pc.dim(
        overview.workflow_id,
      )}@v${overview.workflow_version}  ${formatStatus(overview.status)}\n`,
    );
    writeOut(
      `   ${pc.dim("started:")}  ${overview.started_at}` +
        (overview.finished_at ? `   ${pc.dim("finished:")} ${overview.finished_at}` : "") +
        `   ${pc.dim("trigger:")} ${overview.triggered_by}\n`,
    );
    if (overview.error) {
      writeOut(`   ${pc.red("→")} ${truncate(overview.error, 240)}\n`);
    }

    writeOut(
      `\n${pc.bold("Steps")}${pc.dim(` (${history.length})`)}\n`,
    );
    if (history.length === 0) {
      writeOut(`   ${pc.dim("(no steps recorded)")}\n`);
      return 0;
    }
    for (const s of history) {
      const status = formatStatus(s.status);
      const dur = s.durationMs === null ? pc.dim("—") : pc.dim(`${s.durationMs}ms`);
      writeOut(
        `   ${status} ${pc.bold(pad(s.stepName, 24))}  ` +
          `${pc.dim(s.startedAt ?? "—")}  ${dur}  ` +
          `${pc.dim("input#")}${s.inputHash || pc.dim("·")}\n`,
      );
      if (s.output !== null && s.output !== undefined) {
        writeOut(
          `      ${pc.dim("→")} ${truncate(stringifyOutput(s.output), 200)}\n`,
        );
      }
      if (s.error) {
        writeOut(`      ${pc.red("✗")} ${truncate(s.error, 200)}\n`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── chorus run replay ───────────────────────────────────────────────────────

/**
 * Run the `chorus run replay <runId> --from <stepName>` command. Returns the
 * process exit code (0 on success, 1 on user errors, 2 on environment errors).
 */
export async function runRunReplay(opts: RunReplayOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const writeOut = makeWriter(opts.captureStdout);
  const writeErr = makeErrWriter();

  if (!opts.fromStep || opts.fromStep.length === 0) {
    writeErr(pc.red(`✗ --from <stepName> is required\n`));
    return 1;
  }

  // Pre-validate every mutate path so we surface bad syntax BEFORE opening
  // the DB or hitting the runtime. parsePath is a runtime export, so this
  // belongs after loadRuntime — but we can build the value map first.
  let mutations: Record<string, unknown>;
  try {
    mutations = await buildMutations(opts.mutates);
  } catch (err) {
    writeErr(pc.red(`✗ ${(err as Error).message}\n`));
    return 1;
  }

  // Validate mutation paths against the parser before touching the DB.
  // parsePath is a pure function that throws ForkRunError on syntax errors.
  for (const p of Object.keys(mutations)) {
    try {
      parsePath(p);
    } catch (err) {
      writeErr(pc.red(`✗ invalid --mutate path "${p}": ${(err as Error).message}\n`));
      return 1;
    }
  }

  let dbPath: string;
  try {
    dbPath = opts.dbPathOverride ?? (await resolveDbPath(cwd));
  } catch (err) {
    writeErr(pc.red(`✗ cannot resolve database path: ${(err as Error).message}\n`));
    return 2;
  }

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(dbPath);
  } catch (err) {
    writeErr(pc.red(`✗ cannot open database at ${dbPath}: ${(err as Error).message}\n`));
    return 2;
  }
  try {
    let result;
    try {
      result = forkRun(db, opts.runId, opts.fromStep, mutations);
    } catch (err) {
      // ForkRunError carries a code we can surface to the user.
      const e = err as { code?: string; message: string };
      const code = e.code ?? "UNKNOWN";
      writeErr(pc.red(`✗ replay failed (${code}): ${e.message}\n`));
      // Map the runtime's error codes to exit codes:
      // - UNKNOWN_RUN, UNKNOWN_STEP, UNKNOWN_WORKFLOW, BAD_MUTATION_PATH
      //   → user error → 1
      // - anything else → 2 (environment / unexpected)
      const userErrCodes = new Set([
        "UNKNOWN_RUN",
        "UNKNOWN_STEP",
        "UNKNOWN_WORKFLOW",
        "BAD_MUTATION_PATH",
      ]);
      return userErrCodes.has(code) ? 1 : 2;
    }

    if (opts.json) {
      writeOut(
        JSON.stringify(
          {
            sourceRunId: opts.runId,
            newRunId: result.newRunId,
            fromStep: opts.fromStep,
            mutationsApplied: Object.keys(mutations).length,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    writeOut(
      `${pc.green("✓")} forked run ${pc.cyan(opts.runId)} → ${pc.cyan(result.newRunId)}\n`,
    );
    writeOut(
      `   ${pc.dim("from step:")}        ${pc.bold(opts.fromStep)}\n` +
        `   ${pc.dim("mutations:")}        ${Object.keys(mutations).length}\n` +
        `   ${pc.dim("status:")}           pending (start the runtime to dispatch)\n`,
    );
    if (Object.keys(mutations).length > 0) {
      writeOut(`   ${pc.dim("mutated paths:")}\n`);
      for (const p of Object.keys(mutations)) {
        writeOut(`     - ${p}\n`);
      }
    }
    writeOut(
      `\n   ${pc.dim("next:")} \`chorus run history ${result.newRunId}\` to inspect once dispatched\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

// ── Output helpers ──────────────────────────────────────────────────────────

/**
 * Build a write function that appends to the capture buffer (for tests) or
 * writes through to process.stdout (for live use).
 */
function makeWriter(capture?: string[]): (s: string) => void {
  if (capture) {
    return (s) => {
      capture.push(s);
    };
  }
  const w = process.stdout.write.bind(process.stdout);
  return (s) => {
    w(s);
  };
}

function makeErrWriter(): (s: string) => void {
  const w = process.stderr.write.bind(process.stderr);
  return (s) => {
    w(s);
  };
}

function formatStatus(status: string): string {
  switch (status) {
    case "success":
      return pc.green(pad(status, 9));
    case "failed":
      return pc.red(pad(status, 9));
    case "running":
      return pc.cyan(pad(status, 9));
    case "pending":
      return pc.yellow(pad(status, 9));
    case "cancelled":
      return pc.dim(pad(status, 9));
    default:
      return pc.dim(pad(status, 9));
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function stringifyOutput(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
