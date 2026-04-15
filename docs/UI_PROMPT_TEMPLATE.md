# Chorus UI Prompt Template

Paste everything between the `--- PROMPT START ---` and `--- PROMPT END ---`
lines into your agent (Claude, ChatGPT, Cursor, Gemini, or your own). Replace
`{{STYLE}}` with what you want (e.g., `solarpunk terminal` or
`minimalist notion-style` or `dense ops dashboard like Datadog`).

Skip straight to copy-paste: run `chorus ui --prompt` and pipe it into your
clipboard (`chorus ui --prompt | pbcopy` on macOS, `chorus ui --prompt | clip`
on Windows).

--- PROMPT START ---

You are generating a single-file HTML dashboard for Chorus, a local workflow
runtime. Chorus runs on the user's own machine, catches integration failures,
and coordinates signed patches across users. You are building a READ-ONLY
viewer on top of its JSON API.

STEP 1 — DISCOVER THE API

Fetch `http://localhost:3710/api/manifest` first. The response lists every
endpoint, their query parameters, and the exact JSON shape each returns. Do
not assume any endpoint — always verify against the manifest. If bearer auth
is required, the manifest's `authMode` field will say `"bearer"`; include
`Authorization: Bearer <token>` on every request in that case. The token is
whatever was set in `CHORUS_API_TOKEN` when the runtime started.

STEP 2 — ASK THE USER WHAT THEY WANT

Before generating anything, ask ONE short question: "What do you want to see
at a glance? Runs, errors, patches, integrations, or all four?" Default to
all four if the user says "whatever" or "you decide."

STEP 3 — GENERATE ONE HTML FILE

Output a single `dashboard.html` file. NO build step, NO npm, NO external
CDN (not even Tailwind's CDN, not even Google Fonts). Must work offline.
Inline CSS and JS. Vanilla `fetch` + DOM manipulation. No frameworks. Under
500 lines. Should open in a browser via `file://` or be served by any static
server.

DATA TO SHOW

Use whichever of these endpoints the user asked for:

- `GET /api/runs?limit=50` — recent runs (id, workflowId, status, duration, error)
- `GET /api/errors?limit=50` — error signatures (fingerprint hash, occurrences, integration, operation)
- `GET /api/patches?limit=50` — known patches (integration, version, state, applied time)
- `GET /api/integrations` — installed integrations (run count, error count, patch count, last used)
- `GET /api/workflows` — all workflows (name, active, version, updated)

For a selected run's detail, use `GET /api/runs/:id` (returns `nodeResults[]`
with per-step output/error/duration).

UX HINTS (NOT NEGOTIABLE)

- Timestamps: show as "5 min ago" / "2 hours ago" / "Apr 14" — never raw ISO8601.
  Include the ISO as a `title=` tooltip so power users can hover.
- Status colors: success = green, failed = red, running = amber/pulsing,
  pending = muted gray, cancelled = strikethrough gray. Use these colors
  consistently everywhere status appears.
- Signature hashes + run ids: monospace, truncate to 12 chars with ellipsis,
  full hash in `title=`.
- Error messages: truncate to 140 chars with ellipsis + expand-on-click.
- Empty states: every table needs a friendly empty message, never a blank
  panel.
- Loading states: show a lightweight spinner or "Loading..." the first time;
  after that, silently swap data on refresh (don't blank the UI).
- Errors: if a fetch fails, show a small banner at the top with "Lost
  connection to Chorus runtime — is it running?" and a retry button.

REFRESH STRATEGY

Auto-refresh every 15 seconds by default. Add a visible pause/resume button
and a "Last updated: 8s ago" indicator. When the tab is hidden
(`document.hidden`), pause polling to save cycles; resume on focus.

FORBIDDEN

- External CDNs (works offline, preserves privacy).
- Tracking/analytics scripts (Google Analytics, Plausible, etc.).
- API keys in URLs (always use the `Authorization` header).
- Anything that writes back to the server — this API is read-only.
- Relative URLs that assume a specific mount path. Always use absolute
  `http://localhost:3710/api/...` unless the user is serving the HTML from
  the same origin.
- "Loading spinners" that block the whole viewport. Per-section loading only.

STYLE

Render the whole thing in this aesthetic: {{STYLE}}

If that placeholder is empty or the user said "default," use a clean,
information-dense design: system font stack, monospace for ids/hashes, subtle
cool-gray background, high-contrast foreground, no rounded-corner chrome,
no shadows. Think "inspector panel," not "marketing site."

OUTPUT FORMAT

Return exactly one code block containing the full HTML file, nothing else.
No explanation before or after. The user will save that file and open it.

--- PROMPT END ---

## Style Examples

These are complete `{{STYLE}}` replacements. Feel free to mix and match.

### 1. Solarpunk Terminal

> Warm green on cream background (`#5c6b3d` text on `#f5f0e1`), monospace
> throughout (IBM Plex Mono or system mono fallback), no icons (use text
> glyphs like `[!]` `[OK]` `[..]`), section headers in ALL CAPS, box-drawing
> characters for table borders (`├` `─` `│`), gentle gradients of moss green
> for status indicators.

### 2. Minimalist Notion

> Pure white background, near-black text (`#1a1a1a`), one accent color
> (`#2e7d32` green for success). San-serif (Inter / system font). Generous
> padding (24px gutters). Table zebra striping at 3% opacity gray. Status
> chips as tiny pill badges with 4px border-radius. No borders between
> sections — separate by whitespace only.

### 3. Ops Dashboard (Datadog-like)

> Dark navy background (`#0b1221`), bright cyan and lime accents for status,
> high information density, condensed rows (24px line-height), sparklines
> next to each integration showing occurrence count over time, sticky column
> headers, ctrl+f-friendly plain-text everywhere.

### 4. Zine / Punk

> Black-and-white, heavy grain texture (CSS `background-image` with
> `data:` URI of a 64x64 noise pattern), handwritten-style font, caps-lock
> headers with rotated negative margin, inverted rows for failed runs, DIY
> newspaper vibe.

## Example user turns

**User**: "all four, minimalist notion style"
**Agent**: fetches manifest → generates single HTML with 4 tables, pure-white
aesthetic, 15s polling.

**User**: "just errors, dense, show me the last 200"
**Agent**: fetches manifest → spots `/api/errors?limit=200` → generates one
full-bleed table with monospace hashes, occurrences, and integration breakdown
sidebar.

**User**: "I don't care, surprise me"
**Agent**: picks a sensible default (all four, minimal style), notes its
choice in a banner at the top, offers "regenerate in a different style" as
a footer link.

## Prompt engineering notes

The template above is deliberately:

- **Structured in numbered steps** so the agent doesn't skip the manifest fetch.
- **Explicit about "one file, no CDN"** — without this constraint, LLMs default
  to importing React and Tailwind, which breaks offline usage.
- **Constraining on UX** (timestamp formatting, color coding, truncation) —
  not because the agent couldn't figure these out, but because they vary
  wildly without guidance and the result looks inconsistent.
- **Clear on forbidden behaviors** — especially the read-only guarantee. The
  API doesn't even accept POST/PATCH/DELETE, but some agents will still try
  to build write flows; heading that off saves a regeneration round.
- **Placeholder-based for style** — so users can swap aesthetics without
  re-reading the whole prompt.
