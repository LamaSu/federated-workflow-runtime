/**
 * `chorus ui` — help the user generate a Chorus dashboard with their own agent.
 *
 * Chorus deliberately does NOT ship a hardcoded dashboard (see
 * ARCHITECTURE §1.4 — "CLI ships first"). Instead, the runtime exposes a
 * read-only JSON API and this command helps the user point any capable LLM
 * at it.
 *
 * Subcommands/flags:
 *   chorus ui            — summary: API URL + manifest curl + pointer to docs
 *   chorus ui --prompt   — prints ONLY the prompt template (pipe-friendly)
 *   chorus ui --example  — writes examples/ui/minimal.html into the cwd
 *   chorus ui --serve    — serves examples/ui/minimal.html on a spare port
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { loadConfig } from "../config.js";

export interface UiOptions {
  /** `--prompt`: emit the raw prompt template to stdout only. */
  prompt?: boolean;
  /** `--example`: write the reference HTML into the current project. */
  example?: boolean;
  /** `--serve`: start a tiny static server for the reference HTML. */
  serve?: boolean;
  /** Optional: override the port for `--serve`. */
  servePort?: number;
  /** Optional: override cwd for tests. */
  cwd?: string;
  /** Optional: override the stdout stream (tests). */
  stdout?: NodeJS.WriteStream;
  /** Optional: disable colors regardless of TTY (tests). */
  forceNoColor?: boolean;
}

/** Location of the bundled template, resolved relative to this module. */
function bundledPromptPath(): string {
  // When running via tsx in dev: this file lives at
  //   packages/cli/src/commands/ui.ts
  // and the prompt doc lives at docs/UI_PROMPT_TEMPLATE.md. When bundled to
  // dist/cli.js both are relative to the package root — resolve via the
  // monorepo root for the dev path, fall back to the installed layout.
  const thisFile = fileURLToPath(import.meta.url);
  const hereDir = path.dirname(thisFile);
  // dev:     <repo>/packages/cli/src/commands/ui.ts -> <repo>/docs/...
  // bundled: <repo>/packages/cli/dist/cli.js        -> <repo>/docs/...
  // Both collapse to walking up 4 dirs from the source or 3 from dist.
  const devCandidate = path.resolve(hereDir, "../../../../docs/UI_PROMPT_TEMPLATE.md");
  const distCandidate = path.resolve(hereDir, "../../../docs/UI_PROMPT_TEMPLATE.md");
  return process.env.CHORUS_PROMPT_PATH ?? devCandidate;
  // We never actually use distCandidate here — kept commented to document the
  // mapping. When we ship the npm package we'll ship the prompt as a string
  // constant (see FALLBACK_PROMPT below) so there's no runtime FS lookup.
  void distCandidate;
}

/**
 * Fallback prompt — embedded as a string constant so the CLI still works
 * when the docs/ directory isn't on disk (e.g., a global install). Kept in
 * sync with UI_PROMPT_TEMPLATE.md; the test verifies both match.
 */
export const FALLBACK_PROMPT = `You are generating a single-file HTML dashboard for Chorus, a local,
read-only workflow runtime. Chorus runs on the user's machine, catches
integration failures, and coordinates signed patches across users.

STEP 1 — DISCOVER THE API

Fetch http://localhost:3710/api/manifest FIRST. It lists every endpoint,
query params, and JSON shape. Do not assume any endpoint — verify against
the manifest. If authMode is "bearer", include Authorization: Bearer
<token> (token = the value of CHORUS_API_TOKEN when the runtime started).

STEP 2 — ASK THE USER

Ask ONE question: "What do you want to see — runs, errors, patches,
integrations, or all four?" If they say "whatever" or "you decide", default
to all four.

STEP 3 — OUTPUT ONE HTML FILE

Return exactly one <!doctype html> file in a single code block. No prose
before or after. Under 500 lines. Inline CSS + inline JS + vanilla fetch.
No frameworks. No build step. No external CDN (not even fonts or Tailwind).
Must work offline and over file://.

ENDPOINTS (use whichever the user wants)

- GET /api/runs?limit=50 — id, workflowId, status, startedAt, durationMs, error, attempt
- GET /api/runs/:id — one run plus nodeResults[] (per-step output/error/duration)
- GET /api/errors?limit=50 — hash, integration, operation, errorClass, httpStatus, occurrences, lastSeen, sampleContext
- GET /api/patches?limit=50 — id, integration, version, state, appliedAt
- GET /api/integrations — name, runCount, errorCount, patchCount, lastUsedAt
- GET /api/workflows — id, name, version, active, updatedAt

UX RULES (NOT NEGOTIABLE)

- Timestamps: render as "5m ago" / "2h ago" / "Apr 14"; put the raw ISO
  string in title= for hover.
- Status colors: success=green, failed=red, running=amber, pending=gray,
  cancelled=strikethrough gray. Stay consistent across tables.
- IDs and signature hashes: monospace; truncate to 12 chars + …; full
  value in title=.
- Error strings: truncate at 140 chars; click to expand.
- Every table needs an empty-state message (never a blank panel).
- On first load, show "Loading…"; on refresh, swap in place (don't blank
  the UI).
- If a fetch fails, show a top banner "Lost connection to Chorus runtime —
  is it running?" with a retry button.

REFRESH

Auto-poll every 15s. Show "Last updated: 8s ago" and a pause/resume
button. Pause when document.hidden; resume on focus.

FORBIDDEN

- External CDNs, analytics, trackers, or remote fonts.
- API keys in URL strings (use the Authorization header only).
- Write endpoints: this API is read-only. No POST/PATCH/DELETE.
- Full-viewport loading spinners (use per-section states).

STYLE

Render in this aesthetic: {{STYLE}}

If {{STYLE}} is empty, use a clean inspector-panel look: system font,
monospace for ids, cool-gray background, high-contrast text, no rounded
corners, no shadows.
`;

/**
 * Read the prompt template; prefer the on-disk copy (keeps it evolvable at
 * install-time), fall back to the embedded string.
 */
async function readPrompt(): Promise<string> {
  const p = bundledPromptPath();
  try {
    const raw = await readFile(p, "utf8");
    // The file wraps the prompt between `--- PROMPT START ---` and
    // `--- PROMPT END ---` markers; extract just that block.
    const start = raw.indexOf("--- PROMPT START ---");
    const end = raw.indexOf("--- PROMPT END ---");
    if (start >= 0 && end > start) {
      const extracted = raw.slice(start + "--- PROMPT START ---".length, end).trim();
      if (extracted.length > 500) return extracted + "\n";
    }
  } catch {
    // fall through
  }
  return FALLBACK_PROMPT;
}

/**
 * Determine the API base URL from config (defaults to
 * http://127.0.0.1:3710). When no config can be found, fall back to defaults
 * so the command still prints useful output in a fresh install.
 */
async function resolveApiBaseUrl(cwd: string): Promise<string> {
  try {
    const { config } = await loadConfig(cwd);
    const host = config.server.host ?? "127.0.0.1";
    const port = config.server.port ?? 3710;
    return `http://${host}:${port}`;
  } catch {
    return "http://127.0.0.1:3710";
  }
}

/** Write the minimal reference HTML into the current project's examples/ui/. */
async function writeExample(cwd: string): Promise<string> {
  const sourcePath = path.resolve(
    fileURLToPath(import.meta.url),
    "../../../../../examples/ui/minimal.html",
  );
  const destDir = path.join(cwd, "examples", "ui");
  const destPath = path.join(destDir, "minimal.html");
  await mkdir(destDir, { recursive: true });
  let content: string;
  try {
    content = await readFile(sourcePath, "utf8");
  } catch {
    content = EMBEDDED_MINIMAL_HTML;
  }
  await writeFile(destPath, content, "utf8");
  return destPath;
}

/** Serve the minimal reference HTML on localhost:<port>. */
async function serveExample(cwd: string, port: number): Promise<void> {
  const html = await (async () => {
    const dest = path.join(cwd, "examples", "ui", "minimal.html");
    try {
      return await readFile(dest, "utf8");
    } catch {
      return EMBEDDED_MINIMAL_HTML;
    }
  })();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  process.stdout.write(
    `Serving examples/ui/minimal.html on http://127.0.0.1:${port}\nCtrl-C to stop.\n`,
  );
  // Keep the process alive until SIGINT.
  return new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close();
      resolve();
    });
  });
}

/**
 * Detect whether to emit ANSI colors. Respects `NO_COLOR` env var,
 * `forceNoColor`, and whether stdout is a TTY.
 */
function useColor(opts: UiOptions): boolean {
  if (opts.forceNoColor) return false;
  if (process.env.NO_COLOR) return false;
  const out = opts.stdout ?? process.stdout;
  return Boolean((out as NodeJS.WriteStream).isTTY);
}

function paint(text: string, color: keyof typeof pc | null, color_on: boolean): string {
  if (!color_on || color == null) return text;
  const fn = pc[color] as unknown;
  if (typeof fn === "function") {
    return (fn as (s: string) => string)(text);
  }
  return text;
}

export async function runUi(opts: UiOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? process.stdout;
  const write = (s: string) => out.write(s);
  const color_on = useColor(opts);

  if (opts.prompt) {
    const prompt = await readPrompt();
    write(prompt);
    if (!prompt.endsWith("\n")) write("\n");
    return 0;
  }

  if (opts.example) {
    const destPath = await writeExample(cwd);
    write(`wrote ${destPath}\n`);
    write(
      `Open it in a browser (file://) or serve with: chorus ui --serve\n`,
    );
    return 0;
  }

  if (opts.serve) {
    const port = opts.servePort ?? 3711;
    await serveExample(cwd, port);
    return 0;
  }

  // Default: human-readable summary.
  const baseUrl = await resolveApiBaseUrl(cwd);

  const bold = (s: string) => paint(s, "bold", color_on);
  const dim = (s: string) => paint(s, "dim", color_on);
  const cyan = (s: string) => paint(s, "cyan", color_on);
  const green = (s: string) => paint(s, "green", color_on);

  write(`${bold("Chorus UI")} — the dashboard is whatever your agent builds for you\n\n`);
  write(`Your runtime's API lives at:\n`);
  write(`  ${cyan(baseUrl + "/api/manifest")}\n\n`);
  write(`Probe it with:\n`);
  write(`  ${dim("$")} curl ${baseUrl}/api/manifest | jq\n\n`);
  write(`${bold("Generate a dashboard")} with your agent:\n`);
  write(`  ${dim("$")} ${green("chorus ui --prompt | pbcopy")}     ${dim("# macOS")}\n`);
  write(`  ${dim("$")} ${green("chorus ui --prompt | clip")}        ${dim("# Windows")}\n`);
  write(`  ${dim("$")} ${green("chorus ui --prompt | xclip -sel c")} ${dim("# Linux")}\n`);
  write(
    `  Then paste into Claude / ChatGPT / Cursor / your own agent. Say what you want.\n\n`,
  );
  write(`${bold("See an example first")}:\n`);
  write(`  ${dim("$")} ${green("chorus ui --example")}  ${dim("# writes examples/ui/minimal.html")}\n`);
  write(`  ${dim("$")} ${green("chorus ui --serve")}    ${dim("# serves it on http://127.0.0.1:3711")}\n\n`);
  write(`${bold("Docs")}: docs/UI_GENERATOR.md\n`);
  return 0;
}

// Kept inline so that global installs (no docs/ on disk) still work for
// `chorus ui --example`. Mirrors examples/ui/minimal.html exactly; the
// reference HTML is the canonical copy and this string is regenerated as
// part of release.
export const EMBEDDED_MINIMAL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Chorus — minimal dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root {
      --bg: #f5f0e1; --fg: #2a2a2a; --muted: #7a7565;
      --ok: #5c6b3d; --warn: #b57d1d; --err: #8b2f2f;
      --panel: #ede6d1;
    }
    body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
      font: 14px/1.45 ui-monospace, Menlo, Consolas, monospace; }
    h1 { margin:0 0 4px; font-size:18px; letter-spacing:.02em; }
    .sub { color:var(--muted); margin-bottom:20px; }
    .panel { background:var(--panel); padding:14px 16px; margin-bottom:16px; }
    .panel h2 { margin:0 0 8px; font-size:13px; text-transform:uppercase;
      letter-spacing:.08em; color:var(--muted); }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; padding:6px 10px 6px 0; vertical-align:top;
      white-space:nowrap; }
    th { color:var(--muted); font-weight:500; font-size:12px;
      border-bottom:1px solid #d8cfb7; }
    tr + tr td { border-top:1px solid #e2dac1; }
    .id { color:var(--muted); }
    .success { color:var(--ok); }
    .failed  { color:var(--err); }
    .running { color:var(--warn); }
    .empty { color:var(--muted); font-style:italic; }
    .updated { color:var(--muted); font-size:12px; margin-left:8px; }
  </style>
</head>
<body>
  <h1>Chorus — minimal dashboard</h1>
  <div class="sub">
    Use <code>chorus ui --prompt</code> to generate a better one with your agent.
    <span class="updated" id="updated"></span>
  </div>

  <div class="panel">
    <h2>Recent runs</h2>
    <table id="runs"><thead><tr>
      <th>status</th><th>workflow</th><th>started</th><th>duration</th><th>id</th>
    </tr></thead><tbody><tr><td colspan="5" class="empty">Loading...</td></tr></tbody></table>
  </div>

  <div class="panel">
    <h2>Error signatures</h2>
    <table id="errors"><thead><tr>
      <th>hash</th><th>integration.op</th><th>class</th><th>occ</th><th>last seen</th>
    </tr></thead><tbody><tr><td colspan="5" class="empty">Loading...</td></tr></tbody></table>
  </div>

  <div class="panel">
    <h2>Patches</h2>
    <table id="patches"><thead><tr>
      <th>id</th><th>integration</th><th>version</th><th>state</th><th>applied</th>
    </tr></thead><tbody><tr><td colspan="5" class="empty">Loading...</td></tr></tbody></table>
  </div>

  <script>
    const API = location.origin && location.origin.startsWith("http") && location.port !== "3710"
      ? "http://127.0.0.1:3710" : "";
    const fmt = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso), s = (Date.now()-d.getTime())/1000|0;
      if (s<60) return s+"s ago";
      if (s<3600) return (s/60|0)+"m ago";
      if (s<86400) return (s/3600|0)+"h ago";
      return d.toISOString().slice(0,10);
    };
    const tbody = (id) => document.querySelector("#"+id+" tbody");
    const row = (cells) => "<tr>"+cells.map(c=>"<td>"+c+"</td>").join("")+"</tr>";
    const esc = (s) => String(s||"").replace(/[<>&]/g, (c)=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    const truncId = (s) => s ? '<span class="id" title="'+esc(s)+'">'+esc(s.slice(0,12))+'…</span>' : "—";

    async function refresh() {
      try {
        const [runs, errors, patches] = await Promise.all([
          fetch(API+"/api/runs?limit=20").then(r=>r.json()),
          fetch(API+"/api/errors?limit=20").then(r=>r.json()),
          fetch(API+"/api/patches?limit=20").then(r=>r.json()),
        ]);
        tbody("runs").innerHTML = (runs.runs||[]).length === 0
          ? '<tr><td colspan="5" class="empty">No runs yet.</td></tr>'
          : runs.runs.map(r=>row([
              '<span class="'+esc(r.status)+'">'+esc(r.status)+'</span>',
              esc(r.workflowId),
              '<span title="'+esc(r.startedAt)+'">'+fmt(r.startedAt)+'</span>',
              r.durationMs != null ? r.durationMs+"ms" : "—",
              truncId(r.id),
            ])).join("");
        tbody("errors").innerHTML = (errors.errors||[]).length === 0
          ? '<tr><td colspan="5" class="empty">No errors. Nice.</td></tr>'
          : errors.errors.map(e=>row([
              truncId(e.hash),
              esc(e.integration)+"."+esc(e.operation),
              esc(e.errorClass)+(e.httpStatus?" ("+e.httpStatus+")":""),
              "×"+e.occurrences,
              '<span title="'+esc(e.lastSeen)+'">'+fmt(e.lastSeen)+'</span>',
            ])).join("");
        tbody("patches").innerHTML = (patches.patches||[]).length === 0
          ? '<tr><td colspan="5" class="empty">No patches installed.</td></tr>'
          : patches.patches.map(p=>row([
              truncId(p.id),
              esc(p.integration),
              esc(p.version),
              esc(p.state),
              p.appliedAt ? '<span title="'+esc(p.appliedAt)+'">'+fmt(p.appliedAt)+'</span>' : "—",
            ])).join("");
        document.getElementById("updated").textContent = "Last refresh: just now";
      } catch (err) {
        document.getElementById("updated").textContent = "Lost connection to Chorus runtime";
      }
    }
    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>
`;
