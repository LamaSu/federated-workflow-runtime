/**
 * `chorus run [workflow]` — start the runtime and execute workflows.
 *
 * With no argument, starts the full runtime in the foreground: loads config,
 * registers every workflow in the workflows dir, opens the SQLite DB,
 * and waits for triggers (webhook, cron, manual).
 *
 * With a workflow ID or file path, kicks off a one-shot manual run of that
 * single workflow and tails its output. The runtime still boots, but exits
 * once the run terminates.
 *
 * SIGINT/SIGTERM triggers a clean shutdown: active runs are allowed to
 * complete their current step, then the subprocess is joined.
 */
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import pc from "picocolors";
import { loadConfig, type ChorusConfig } from "../config.js";
import { validateWorkflowFile, type ValidateResult } from "./validate.js";

export interface RunOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Single workflow id or path to target. */
  target?: string;
  /** If true, do not actually start the runtime loop; return after bootstrap. */
  dryRun?: boolean;
  /** Tail mode: pretty-print step output. Default true when attached to TTY. */
  follow?: boolean;
}

export interface RunBootstrap {
  config: ChorusConfig;
  workflowFiles: string[];
  /** Workflow files that failed validation — reported but not halted on. */
  invalidWorkflows: ValidateResult[];
}

/**
 * Bootstrap: load config, discover workflow files, validate them, open
 * the DB. Kept separate from `runForever` so tests can exercise it without
 * spinning up the executor loop.
 */
export async function bootstrap(opts: RunOptions = {}): Promise<RunBootstrap> {
  const cwd = opts.cwd ?? process.cwd();
  const { config, chorusDir } = await loadConfig(cwd);
  const workflowsDir = path.isAbsolute(config.workflowsDir)
    ? config.workflowsDir
    : path.join(chorusDir, config.workflowsDir);

  const entries = await readdir(workflowsDir).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw err;
  });
  const files = entries
    .filter((n) => /\.(ya?ml|json)$/i.test(n))
    .map((n) => path.join(workflowsDir, n));

  const validated = await Promise.all(files.map((f) => validateWorkflowFile(f)));
  const valid = validated.filter((v) => v.valid);
  const invalid = validated.filter((v) => !v.valid);
  const workflowFiles = valid.map((v) => v.path);

  return { config, workflowFiles, invalidWorkflows: invalid };
}

/**
 * Run the CLI command. Does the bootstrap, prints status, and — unless
 * `dryRun` — hands control to the runtime's server loop. The runtime is
 * imported dynamically because sibling packages might not yet be built
 * when the CLI is being developed in parallel.
 */
export async function runRun(opts: RunOptions = {}): Promise<number> {
  const bs = await bootstrap(opts);
  const p = process.stdout.write.bind(process.stdout);

  p(`${pc.bold("Chorus")} starting — project: ${pc.cyan(bs.config.name)}\n`);
  p(
    `   ${pc.dim("database:")}  ${bs.config.database.path}\n` +
      `   ${pc.dim("server:")}    http://${bs.config.server.host}:${bs.config.server.port}\n`,
  );

  if (bs.workflowFiles.length === 0) {
    p(`${pc.yellow("!")} no valid workflows found — add a file under chorus/workflows/\n`);
  } else {
    p(`${pc.dim("workflows:")}\n`);
    for (const f of bs.workflowFiles) {
      p(`   ${pc.green("✓")} ${f}\n`);
    }
  }
  if (bs.invalidWorkflows.length > 0) {
    p(`${pc.red("invalid workflows:")}\n`);
    for (const f of bs.invalidWorkflows) {
      p(`   ${pc.red("✗")} ${f.path}\n`);
      for (const e of f.errors) p(`      ${pc.red("•")} ${e}\n`);
    }
  }

  if (opts.dryRun) {
    p(`${pc.dim("(dry run — not starting executor)")}\n`);
    return bs.invalidWorkflows.length > 0 ? 1 : 0;
  }

  const runtime = await tryImportRuntime();
  if (!runtime) {
    p(
      `${pc.yellow("!")} @delightfulchorus/runtime is not built yet — cannot start the executor.\n` +
        `   Once the runtime package ships a dist/, re-run this command.\n`,
    );
    return 2;
  }

  // Wire SIGINT/SIGTERM → graceful shutdown.
  const abort = new AbortController();
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    p(`\n${pc.yellow("◆")} received ${sig}, shutting down cleanly…\n`);
    abort.abort(sig);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  /**
   * `onListen` callback — fired once by the runtime after app.listen()
   * resolves. We print the dashboard URL and, unless CHORUS_NO_OPEN is
   * set, spawn the platform-appropriate browser. Errors are swallowed
   * because the server must continue running either way.
   */
  const onListen = (url: string): void => {
    p(`${pc.bold("Dashboard")}: ${pc.cyan(url)}\n`);
    if (process.env.CHORUS_NO_OPEN === "1") {
      p(pc.dim("   (CHORUS_NO_OPEN=1 — skipping browser auto-open)\n"));
      return;
    }
    try {
      openBrowser(url);
    } catch (err) {
      p(pc.dim(`   (browser auto-open failed: ${(err as Error).message})\n`));
    }
  };

  try {
    if (runtime.startServer) {
      await runtime.startServer({
        config: bs.config,
        workflowFiles: bs.workflowFiles,
        targetWorkflow: opts.target,
        signal: abort.signal,
        onListen,
      });
    } else if (runtime.startRuntime) {
      await runtime.startRuntime({
        config: bs.config,
        workflowFiles: bs.workflowFiles,
        targetWorkflow: opts.target,
        signal: abort.signal,
        onListen,
      });
    } else {
      p(`${pc.red("✗")} @delightfulchorus/runtime exports neither startServer nor startRuntime\n`);
      return 3;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}

/**
 * Cross-platform browser-open: picks `start` on win32, `open` on darwin,
 * `xdg-open` elsewhere. Detached + unref()'d so the CLI process isn't
 * coupled to the browser's lifetime. Honors CHORUS_BROWSER as an override
 * (the value is used as the argv[0] to spawn, passed the URL as the sole
 * arg).
 */
export function openBrowser(url: string): void {
  const override = process.env.CHORUS_BROWSER;
  let cmd: string;
  let args: string[];
  if (override && override.length > 0) {
    cmd = override;
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd.exe builtin; spawning cmd with /c start "<title>"
    // "<url>" is the canonical pattern. The empty "" is the window title
    // slot — start treats the first quoted arg as the title.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    shell: false,
    windowsHide: true,
  });
  child.on("error", () => {
    /* swallow — caller already logged the URL */
  });
  child.unref();
}

interface RuntimeModule {
  startServer?: (opts: {
    config: ChorusConfig;
    workflowFiles: string[];
    targetWorkflow?: string;
    signal: AbortSignal;
    onListen?: (url: string) => void;
  }) => Promise<void>;
  startRuntime?: (opts: {
    config: ChorusConfig;
    workflowFiles: string[];
    targetWorkflow?: string;
    signal: AbortSignal;
    onListen?: (url: string) => void;
  }) => Promise<void>;
}

async function tryImportRuntime(): Promise<RuntimeModule | null> {
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
  try {
    return (await dynamicImport("@delightfulchorus/runtime")) as RuntimeModule;
  } catch {
    return null;
  }
}
