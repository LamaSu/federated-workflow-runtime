import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Cassette, ValidationResult } from "./types.js";

export interface ApplyOptions {
  /** Optional override for temp dir root. Default: os.tmpdir(). */
  tmpRoot?: string;
}

export interface ReplayOptions {
  /**
   * Command to invoke the patched integration. Receives a single cassette JSON
   * on stdin; must exit 0 on match, non-zero on mismatch. If not provided, the
   * default replay script is used which simply re-parses the cassette shape
   * (used in tests with synthetic "good" and "bad" patches that change a shape
   * file that the default script reads).
   */
  command?: { cmd: string; args: string[] };
  /** How long to wait per replay before killing. Default 10s. */
  timeoutMs?: number;
}

/**
 * Copy the integration source to a temp directory, initialize a git repo,
 * then apply the patch with `git apply`.
 *
 * Returns the temp dir on success. Caller is responsible for cleanup unless
 * something throws, in which case we clean up the temp dir ourselves.
 */
export async function applyPatchToTempDir(
  patchDiff: string,
  srcDir: string,
  opts: ApplyOptions = {},
): Promise<string> {
  const root = opts.tmpRoot ?? tmpdir();
  const tempDir = await mkdtemp(join(root, "chorus-repair-"));
  try {
    // Copy integration source (excluding node_modules, dist).
    await cp(srcDir, tempDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(srcDir.length).replace(/^[\\/]+/, "");
        if (rel === "") return true;
        const first = rel.split(/[\\/]/)[0] ?? "";
        if (first === "node_modules" || first === "dist" || first === ".git") {
          return false;
        }
        return true;
      },
    });

    // Initialize a git repo so `git apply` has context. Commit everything.
    await runBash("git", ["init", "-q"], tempDir);
    await runBash("git", ["config", "user.email", "repair@chorus.dev"], tempDir);
    await runBash("git", ["config", "user.name", "chorus-repair"], tempDir);
    await runBash("git", ["add", "-A"], tempDir);
    await runBash("git", ["commit", "-q", "-m", "baseline"], tempDir);

    // Write the diff to a file (avoid stdin quoting issues on Windows).
    const patchFile = join(tempDir, ".chorus-patch.diff");
    await writeFile(patchFile, patchDiff, "utf8");

    const { code, stdout, stderr } = await runBashCollect(
      "git",
      ["apply", "--whitespace=nowarn", ".chorus-patch.diff"],
      tempDir,
    );
    if (code !== 0) {
      throw new PatchApplyError(
        `git apply failed (exit ${code})\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }

    return tempDir;
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

/**
 * Replay cassettes against a patched integration living in `tempDir`.
 *
 * Default replay: invokes `node <tempDir>/replay.js` once per cassette. The
 * replay script is auto-generated if missing. In production an integration
 * will ship its own replay harness; we shell out to keep the repair agent
 * decoupled from the integration SDK.
 */
export async function replayCassettes(
  tempDir: string,
  cassettes: Cassette[],
  opts: ReplayOptions = {},
): Promise<ValidationResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Ensure a replay script exists in the temp dir. If the integration didn't
  // ship one, we drop a default that reads the cassette and imports
  // `./replay.shape.json` — the patch is expected to modify that file to
  // make cassettes pass. This is deliberately simple so the validator itself
  // has no integration-specific knowledge.
  const replayPath = opts.command
    ? null
    : await ensureDefaultReplayScript(tempDir);

  const command = opts.command ?? {
    cmd: "node",
    args: [replayPath ?? join(tempDir, ".chorus-replay.mjs")],
  };

  let passed = 0;
  let failed = 0;
  const errors: Array<{ cassetteId: string; message: string }> = [];

  for (const cas of cassettes) {
    const input = JSON.stringify(cas);
    try {
      const { code, stdout, stderr } = await runCollectStdin(
        command.cmd,
        command.args,
        tempDir,
        input,
        timeoutMs,
      );
      if (code === 0) {
        passed += 1;
      } else {
        failed += 1;
        errors.push({
          cassetteId: cas.id,
          message: `exit ${code}; stderr=${stderr.slice(0, 500)}; stdout=${stdout.slice(0, 500)}`,
        });
      }
    } catch (err) {
      failed += 1;
      errors.push({
        cassetteId: cas.id,
        message: (err as Error).message,
      });
    }
  }

  return {
    passed,
    failed,
    errors,
    tempDir,
    ok: failed === 0 && passed === cassettes.length,
  };
}

/** Cleanup helper. Safe to call multiple times. */
export async function cleanupTempDir(tempDir: string | null): Promise<void> {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

// ── internals ─────────────────────────────────────────────────────────────

async function ensureDefaultReplayScript(tempDir: string): Promise<string> {
  const scriptPath = join(tempDir, ".chorus-replay.mjs");
  const script = `
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read cassette from stdin
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const cassette = JSON.parse(input);

// Default validator: the patched integration is expected to have a
// replay.shape.json file whose contents dictate whether a cassette passes.
// The file is { "match": { "<cassetteId>": true|false } }.
let shape;
try {
  shape = JSON.parse(readFileSync(join(__dirname, 'replay.shape.json'), 'utf8'));
} catch (err) {
  process.stderr.write('missing replay.shape.json: ' + err.message + '\\n');
  process.exit(2);
}

const decision = shape?.match?.[cassette.id];
if (decision === true) {
  process.stdout.write('ok\\n');
  process.exit(0);
} else {
  process.stderr.write('mismatch for ' + cassette.id + '\\n');
  process.exit(1);
}
`;
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

function runBash(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "ignore", shell: false });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

function runBashCollect(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function runCollectStdin(
  cmd: string,
  args: string[],
  cwd: string,
  stdinData: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`replay timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    p.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    p.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    p.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    try {
      p.stdin.write(stdinData);
      p.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

export { sep as pathSep };
