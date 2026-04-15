/**
 * `chorus event` subcommand — fire, watch, and list-waiting for the internal
 * event bus (ROADMAP §6).
 *
 *   chorus event fire <type> [--payload <json>] [--correlation <id>] [--source <s>]
 *   chorus event watch [<type>] [--limit <n>] [--json]
 *   chorus event list-waiting [--json]
 *
 * All subcommands talk to the runtime's HTTP API (/api/events). The CLI does
 * not open the SQLite DB directly for this feature — events are the one
 * write path on /api/*, and we want the same code path as external callers.
 */
import path from "node:path";
import pc from "picocolors";
import { loadConfig, type ChorusConfig } from "../config.js";

export interface EventFireOptions {
  cwd?: string;
  type: string;
  payload?: string;
  correlationId?: string;
  source?: string;
  /** Override the base URL; used by tests. */
  baseUrl?: string;
  /** Bearer token for /api/. Falls back to CHORUS_API_TOKEN env. */
  apiToken?: string | null;
}

export interface EventWatchOptions {
  cwd?: string;
  type?: string;
  limit?: number;
  json?: boolean;
  baseUrl?: string;
  apiToken?: string | null;
}

export interface EventListWaitingOptions {
  cwd?: string;
  json?: boolean;
  baseUrl?: string;
  apiToken?: string | null;
}

interface EventApiSummary {
  id: string;
  type: string;
  payload: unknown;
  source: string | null;
  emittedAt: string;
  correlationId: string | null;
  consumedByRun: string | null;
}

interface WaitingApiSummary {
  id: string;
  runId: string;
  stepName: string;
  eventType: string;
  matchCorrelationId: string | null;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedEventId: string | null;
}

async function resolveBaseUrl(
  cwd: string | undefined,
  override: string | undefined,
): Promise<string> {
  if (override) return override;
  const res = await loadConfig(cwd ?? process.cwd());
  return baseUrlFromConfig(res.config);
}

export function baseUrlFromConfig(cfg: ChorusConfig): string {
  const host = cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host;
  return `http://${host}:${cfg.server.port}`;
}

function makeHeaders(token: string | null | undefined): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const t = token ?? process.env.CHORUS_API_TOKEN ?? null;
  if (t && t.length > 0) h["authorization"] = `Bearer ${t}`;
  return h;
}

/**
 * Parse a user-supplied `--payload` string. Accepts raw JSON or a file path
 * prefixed with `@` (like curl). Empty → empty object.
 */
export async function parsePayload(raw: string | undefined): Promise<unknown> {
  if (!raw || raw.length === 0) return {};
  if (raw.startsWith("@")) {
    const { readFile } = await import("node:fs/promises");
    const p = raw.slice(1);
    const text = await readFile(p, "utf8");
    return JSON.parse(text);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--payload is not valid JSON: ${(err as Error).message}`);
  }
}

// ── fire ─────────────────────────────────────────────────────────────────

export async function fireEvent(opts: EventFireOptions): Promise<number> {
  try {
    const baseUrl = await resolveBaseUrl(opts.cwd, opts.baseUrl);
    const payload = await parsePayload(opts.payload);
    const body = {
      type: opts.type,
      payload,
      source: opts.source,
      correlationId: opts.correlationId,
    };
    const res = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: makeHeaders(opts.apiToken),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = safeParseJson(text);
    if (res.status !== 202) {
      process.stderr.write(
        pc.red(`✗ event fire failed (${res.status}): ${text || "no body"}\n`),
      );
      return 1;
    }
    const r = json as {
      id: string;
      type: string;
      emittedAt: string;
      triggeredRunIds: string[];
      resolvedWaitingSteps: number;
    };
    const p = process.stdout.write.bind(process.stdout);
    p(`${pc.green("✓")} fired ${pc.bold(r.type)}\n`);
    p(`   ${pc.dim("id:")}         ${r.id}\n`);
    p(`   ${pc.dim("emittedAt:")}  ${r.emittedAt}\n`);
    if (r.triggeredRunIds.length > 0) {
      p(`   ${pc.dim("triggered:")}  ${r.triggeredRunIds.length} run(s)\n`);
      for (const id of r.triggeredRunIds) p(`     ${pc.cyan(id)}\n`);
    }
    if (r.resolvedWaitingSteps > 0) {
      p(`   ${pc.dim("resolved:")}   ${r.resolvedWaitingSteps} waiting step(s)\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(pc.red(`✗ ${(err as Error).message}\n`));
    return 1;
  }
}

// ── watch (list recent) ──────────────────────────────────────────────────

export async function watchEvents(opts: EventWatchOptions): Promise<number> {
  try {
    const baseUrl = await resolveBaseUrl(opts.cwd, opts.baseUrl);
    const url = new URL(`${baseUrl}/api/events`);
    if (opts.type) url.searchParams.set("type", opts.type);
    if (opts.limit) url.searchParams.set("limit", String(opts.limit));
    const res = await fetch(url, { headers: makeHeaders(opts.apiToken) });
    const text = await res.text();
    if (res.status !== 200) {
      process.stderr.write(
        pc.red(`✗ /api/events returned ${res.status}: ${text}\n`),
      );
      return 1;
    }
    const body = safeParseJson(text) as { events: EventApiSummary[] };
    if (opts.json) {
      process.stdout.write(JSON.stringify(body, null, 2) + "\n");
      return 0;
    }
    const p = process.stdout.write.bind(process.stdout);
    p(
      `${pc.bold("Events")}${opts.type ? pc.dim(` (type=${opts.type})`) : ""} ${pc.dim(`(${body.events.length})`)}\n`,
    );
    if (body.events.length === 0) {
      p(`   ${pc.dim("(none)")}\n`);
      return 0;
    }
    for (const e of body.events) {
      const badge = e.consumedByRun ? pc.dim("consumed") : pc.green("new");
      p(
        `   ${badge} ${pc.dim(e.emittedAt)}  ${pc.bold(e.type)}  ${pc.dim(`id=${e.id.slice(0, 8)}…`)}${e.correlationId ? pc.dim(`  corr=${e.correlationId}`) : ""}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(pc.red(`✗ ${(err as Error).message}\n`));
    return 1;
  }
}

// ── list-waiting ─────────────────────────────────────────────────────────

export async function listWaiting(opts: EventListWaitingOptions): Promise<number> {
  try {
    const baseUrl = await resolveBaseUrl(opts.cwd, opts.baseUrl);
    const res = await fetch(`${baseUrl}/api/events/waiting`, {
      headers: makeHeaders(opts.apiToken),
    });
    const text = await res.text();
    if (res.status !== 200) {
      process.stderr.write(
        pc.red(`✗ /api/events/waiting returned ${res.status}: ${text}\n`),
      );
      return 1;
    }
    const body = safeParseJson(text) as { waiting: WaitingApiSummary[] };
    if (opts.json) {
      process.stdout.write(JSON.stringify(body, null, 2) + "\n");
      return 0;
    }
    const p = process.stdout.write.bind(process.stdout);
    p(`${pc.bold("Waiting runs")} ${pc.dim(`(${body.waiting.length})`)}\n`);
    if (body.waiting.length === 0) {
      p(`   ${pc.dim("(none)")}\n`);
      return 0;
    }
    for (const w of body.waiting) {
      p(
        `   ${pc.cyan(w.runId.slice(0, 8))}…  step=${pc.bold(w.stepName)}  eventType=${pc.yellow(w.eventType)}  ${pc.dim(`expires ${w.expiresAt}`)}${w.matchCorrelationId ? pc.dim(`  corr=${w.matchCorrelationId}`) : ""}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(pc.red(`✗ ${(err as Error).message}\n`));
    return 1;
  }
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Ensure we have an absolute path (used when loading config relative to cwd).
 * Exported so tests can share logic.
 */
export function resolveAbsoluteFromCwd(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}
