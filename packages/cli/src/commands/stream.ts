/**
 * `chorus stream <runId> --mode {values,updates,messages,tasks}` — tail the
 * SSE stream of a live run.
 *
 * The runtime exposes `GET /api/run/:runId/stream?mode=...` (Wave 4 item 12);
 * this command opens that stream and prints each frame to stdout as the
 * server emits it. Default output is one JSON object per line (line-
 * delimited JSON / JSONL) so downstream tools (`jq`, etc.) can pipe; a
 * `--pretty` flag switches to a colored human view.
 *
 * Connecting requires a running `chorus run` server in the same project
 * (we read host+port from `loadConfig`). If the server isn't up the
 * connection refuses with a friendly message — this command does NOT
 * spawn the server itself, by design.
 *
 * Multiple modes can be CSV-joined: `--mode values,tasks` subscribes to
 * both. The wire format is exactly what the SSE endpoint produces; we
 * parse `data: <json>` lines and emit each parsed object.
 *
 * Lifecycle / SIGINT: ^C cancels the read stream cleanly. The fetch
 * abort signal triggers the SSE endpoint's close hook, which unsubscribes
 * server-side. There's no "follow vs not follow" mode — the stream
 * simply runs until the user breaks or the run terminates.
 */
import pc from "picocolors";
import { loadConfig } from "../config.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type StreamMode = "values" | "updates" | "messages" | "tasks";

const VALID_MODES = new Set<StreamMode>(["values", "updates", "messages", "tasks"]);

export interface RunStreamOptions {
  cwd?: string;
  runId: string;
  /** CSV: "values" or "values,tasks". Defaults to "updates". */
  mode?: string;
  /** Pretty-print colored output instead of line-delimited JSON. */
  pretty?: boolean;
  /**
   * Capture stream for tests — bypasses process.stdout. When provided,
   * the function appends each line to this array AND skips writing to
   * stdout. (Allows snapshotting output without monkey-patching globals.)
   */
  captureStdout?: string[];
  /** Override host:port (tests). When set, skips loadConfig entirely. */
  baseUrlOverride?: string;
  /** Inject a fetch implementation (tests). */
  fetchFn?: typeof fetch;
  /** Inject a stop signal (tests). */
  abortSignal?: AbortSignal;
  /** Maximum frames to read before returning — tests use this to avoid hang. */
  maxFrames?: number;
}

// ── Mode parsing ────────────────────────────────────────────────────────────

/**
 * Parse + validate the --mode CSV. Returns the mode list as a comma-joined
 * string suitable for the URL, OR throws with a friendly message.
 */
export function parseModes(raw: string | undefined): string {
  // Default = "updates" because that's the most useful single mode for
  // a tail-the-run experience: it backfills the existing rows AND
  // streams future ones. The brief calls out values vs updates as
  // "current snapshot" vs "delta stream"; tail-style uses want delta
  // with backfill.
  const value = raw && raw.length > 0 ? raw : "updates";
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`--mode is empty`);
  }
  for (const p of parts) {
    if (!VALID_MODES.has(p as StreamMode)) {
      throw new Error(
        `unknown stream mode "${p}"; valid: ${Array.from(VALID_MODES).join(", ")}`,
      );
    }
  }
  return parts.join(",");
}

// ── chorus stream ───────────────────────────────────────────────────────────

/**
 * Run the `chorus stream <runId> --mode <m>` command. Returns the process
 * exit code (0 on clean termination, 1 on user errors, 2 on environment).
 */
export async function runStream(opts: RunStreamOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const writeOut = makeWriter(opts.captureStdout);
  const writeErr = makeErrWriter();
  const fetchImpl = opts.fetchFn ?? fetch;

  let modeCsv: string;
  try {
    modeCsv = parseModes(opts.mode);
  } catch (err) {
    writeErr(pc.red(`✗ ${(err as Error).message}\n`));
    return 1;
  }

  let baseUrl: string;
  if (opts.baseUrlOverride) {
    baseUrl = opts.baseUrlOverride.replace(/\/$/, "");
  } else {
    try {
      const { config } = await loadConfig(cwd);
      baseUrl = `http://${config.server.host}:${config.server.port}`;
    } catch (err) {
      writeErr(
        pc.red(`✗ cannot resolve server config: ${(err as Error).message}\n`),
      );
      return 2;
    }
  }

  const url = `${baseUrl}/api/run/${encodeURIComponent(opts.runId)}/stream?mode=${encodeURIComponent(modeCsv)}`;

  // Compose abort: caller may pass one (tests); otherwise we listen for
  // SIGINT to cleanly cancel.
  const internalAbort = new AbortController();
  const onSigint = (): void => {
    internalAbort.abort();
  };
  if (!opts.abortSignal) {
    process.on("SIGINT", onSigint);
  }
  const signal = opts.abortSignal ?? internalAbort.signal;

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return 0;
    }
    writeErr(
      pc.red(
        `✗ cannot connect to ${baseUrl}: ${(err as Error).message}\n` +
          pc.dim(`   (is the runtime running? try: chorus run\n)`),
      ),
    );
    return 2;
  } finally {
    if (!opts.abortSignal) process.off("SIGINT", onSigint);
  }

  if (resp.status === 404) {
    writeErr(pc.red(`✗ unknown run: ${opts.runId}\n`));
    return 1;
  }
  if (resp.status === 400) {
    let detail = "";
    try {
      detail = ` — ${((await resp.json()) as { message?: string }).message ?? ""}`;
    } catch {
      // ignore parse failure
    }
    writeErr(pc.red(`✗ bad request${detail}\n`));
    return 1;
  }
  if (resp.status !== 200) {
    writeErr(pc.red(`✗ server returned ${resp.status}\n`));
    return 2;
  }
  if (!resp.body) {
    writeErr(pc.red(`✗ server returned empty body\n`));
    return 2;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let framesEmitted = 0;
  const maxFrames = opts.maxFrames ?? Infinity;

  try {
    while (framesEmitted < maxFrames) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on blank line = SSE frame boundary.
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = frame.split("\n");
        for (const line of lines) {
          if (line.length === 0) continue;
          if (line.startsWith(":")) continue; // SSE comment / heartbeat
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice("data: ".length);
          if (opts.pretty) {
            try {
              const obj = JSON.parse(payload);
              writeOut(formatPretty(obj) + "\n");
            } catch {
              writeOut(payload + "\n");
            }
          } else {
            // Default: pass the raw payload through. It's already JSON,
            // so `chorus stream | jq` works.
            writeOut(payload + "\n");
          }
          framesEmitted++;
          if (framesEmitted >= maxFrames) break;
        }
        if (framesEmitted >= maxFrames) break;
        sep = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return 0;
    }
    writeErr(pc.red(`✗ stream interrupted: ${(err as Error).message}\n`));
    return 2;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore — connection already closed
    }
  }

  return 0;
}

// ── Output helpers ──────────────────────────────────────────────────────────

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

/**
 * Friendly one-line representation of an event for `--pretty` output.
 * Per-mode formatting; falls back to JSON.stringify for unknown shapes.
 */
function formatPretty(obj: unknown): string {
  if (!obj || typeof obj !== "object") return JSON.stringify(obj);
  const e = obj as { mode?: string };
  switch (e.mode) {
    case "values":
    case "updates": {
      const v = e as {
        mode: string;
        step: { stepName: string; status: string; durationMs: number | null };
      };
      const status = formatStatus(v.step.status);
      const dur = v.step.durationMs === null ? pc.dim("—") : pc.dim(`${v.step.durationMs}ms`);
      return `${pc.dim(`[${v.mode}]`)} ${status} ${pc.bold(v.step.stepName)} ${dur}`;
    }
    case "messages": {
      const m = e as { mode: string; stepName: string; chunk: unknown };
      const chunkStr =
        typeof m.chunk === "string" ? m.chunk : JSON.stringify(m.chunk);
      return `${pc.dim(`[messages]`)} ${pc.bold(m.stepName)} ${chunkStr}`;
    }
    case "tasks": {
      const t = e as {
        mode: string;
        phase: string;
        stepName: string;
        status?: string;
      };
      const phaseColor = t.phase === "step:start" ? pc.cyan : t.status === "failed" ? pc.red : pc.green;
      const tail = t.status ? ` ${formatStatus(t.status)}` : "";
      return `${pc.dim(`[tasks]`)} ${phaseColor(t.phase)} ${pc.bold(t.stepName)}${tail}`;
    }
    default:
      return JSON.stringify(obj);
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "success":
      return pc.green(status);
    case "failed":
      return pc.red(status);
    case "running":
      return pc.cyan(status);
    case "pending":
      return pc.yellow(status);
    default:
      return pc.dim(status);
  }
}
