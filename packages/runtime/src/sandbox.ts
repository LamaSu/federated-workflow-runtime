import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Subprocess isolation per docs/ARCHITECTURE.md §4.4.
 *
 * MVP: `child_process.fork()` per step. The child loads a thin worker shim
 * (`sandbox-worker.js`), dynamically imports the handler module, calls the
 * named export with the provided input, and replies over IPC. A timeout
 * forcibly kills the child; a crash (non-zero exit) surfaces as a rejected
 * promise in the parent.
 *
 * Security properties achieved:
 *  - parent memory is unreachable (new V8 heap)
 *  - parent file descriptors are unreachable (default pipes only)
 *  - env is an explicit allowlist; everything else is dropped
 *  - a crash of the child DOES NOT take down the parent
 */

export interface RunIsolatedOptions {
  /** Absolute path to the handler module (an ESM or CJS .js/.mjs/.cjs file). */
  handlerPath: string;
  /** Named export on the handler module to invoke. Default: `"default"`. */
  exportName?: string;
  /** Argument to pass to the handler. Must be JSON-serializable. */
  input: unknown;
  /** Max wall time before the child is killed. Default 30s. */
  timeoutMs?: number;
  /** Environment allowlist. `CHORUS_ENCRYPTION_KEY` is passed through automatically. */
  env?: Record<string, string>;
  /** Additional node args (e.g. `--enable-source-maps`). */
  execArgv?: string[];
  /** Optional AbortSignal to kill the child early. */
  signal?: AbortSignal;
}

export interface RunIsolatedResult<T = unknown> {
  output: T;
  durationMs: number;
}

export class SandboxError extends Error {
  readonly kind: "timeout" | "crash" | "runtime" | "ipc";
  readonly exitCode?: number | null;
  readonly childError?: string;
  constructor(opts: {
    kind: "timeout" | "crash" | "runtime" | "ipc";
    message: string;
    exitCode?: number | null;
    childError?: string;
  }) {
    super(opts.message);
    this.name = "SandboxError";
    this.kind = opts.kind;
    this.exitCode = opts.exitCode;
    this.childError = opts.childError;
  }
}

/**
 * Protocol between parent and worker shim.
 *
 *   parent -> child: { type: "invoke", handlerPath, exportName, input }
 *   child  -> parent: { type: "result", output }
 *                   | { type: "error",  message, stack?, code?, name? }
 */
export type ParentMsg = {
  type: "invoke";
  handlerPath: string;
  exportName: string;
  input: unknown;
};

export type ChildMsg =
  | { type: "result"; output: unknown }
  | { type: "error"; message: string; stack?: string; code?: string; name?: string };

/**
 * Resolve the path to the worker shim. The shim lives alongside this file in
 * `dist/` (after tsup build) and in `src/` during `vitest` (which runs via
 * tsx). We try both and prefer whichever exists.
 */
export function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Worker is a .cjs file (plain CommonJS, no transpile) so Node loads it as
  // CommonJS regardless of the package's `"type": "module"`.
  return resolve(here, "sandbox-worker.cjs");
}

export async function runIsolated<T = unknown>(
  opts: RunIsolatedOptions,
): Promise<RunIsolatedResult<T>> {
  const {
    handlerPath,
    exportName = "default",
    input,
    timeoutMs = 30_000,
    env = {},
    execArgv = [],
    signal,
  } = opts;

  const workerPath = resolveWorkerPath();

  return new Promise<RunIsolatedResult<T>>((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    let settled = false;

    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
      ...env,
    };
    if (process.env.CHORUS_ENCRYPTION_KEY !== undefined) {
      childEnv.CHORUS_ENCRYPTION_KEY = process.env.CHORUS_ENCRYPTION_KEY;
    }

    let child: ChildProcess;
    try {
      child = fork(workerPath, [], {
        env: childEnv,
        silent: true,
        execArgv,
        serialization: "advanced",
      });
    } catch (err) {
      rejectPromise(
        new SandboxError({
          kind: "crash",
          message: `Failed to fork worker: ${(err as Error).message}`,
        }),
      );
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(
        new SandboxError({
          kind: "timeout",
          message: `Sandbox timed out after ${timeoutMs}ms`,
        }),
      );
    }, timeoutMs);
    // Don't keep the event loop alive solely for this timer.
    timer.unref?.();

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectPromise(
        new SandboxError({
          kind: "runtime",
          message: "Sandbox aborted by caller",
        }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("message", (rawMsg: unknown) => {
      if (settled) return;
      const msg = rawMsg as ChildMsg;
      if (msg && msg.type === "result") {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill(); // graceful
        resolvePromise({
          output: msg.output as T,
          durationMs: Date.now() - startedAt,
        });
      } else if (msg && msg.type === "error") {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill();
        rejectPromise(
          new SandboxError({
            kind: "runtime",
            message: msg.message,
            childError: msg.stack,
          }),
        );
      } else {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill();
        rejectPromise(
          new SandboxError({
            kind: "ipc",
            message: "Sandbox worker sent an unrecognized message",
          }),
        );
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(
        new SandboxError({
          kind: "crash",
          message: `Sandbox child errored: ${err.message}`,
        }),
      );
    });

    child.on("exit", (code, sigStr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(
        new SandboxError({
          kind: "crash",
          message: `Sandbox child exited before producing a result (code=${code}, signal=${sigStr})`,
          exitCode: code,
        }),
      );
    });

    const parentMsg: ParentMsg = {
      type: "invoke",
      handlerPath,
      exportName,
      input,
    };
    child.send(parentMsg, (err) => {
      if (err && !settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        rejectPromise(
          new SandboxError({
            kind: "ipc",
            message: `Failed to send invocation to child: ${err.message}`,
          }),
        );
      }
    });
  });
}
