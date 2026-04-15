# Chorus UI Prompt Template

Paste everything between the `--- PROMPT START ---` and `--- PROMPT END ---`
lines into your agent (Claude, ChatGPT, Cursor, Gemini, or your own). Replace
`{{STYLE}}` with what you want (e.g., `solarpunk terminal` or
`minimalist notion-style` or `dense ops dashboard like Datadog`).

Skip straight to copy-paste: run `chorus ui --prompt` and pipe it into your
clipboard (`chorus ui --prompt | pbcopy` on macOS, `chorus ui --prompt | clip`
on Windows).

--- PROMPT START ---

You are generating a single-file HTML dashboard for Chorus, a local,
read-only workflow runtime. Chorus runs on the user's machine, catches
integration failures, and coordinates signed patches across users.

STEP 1 — DISCOVER THE API

Fetch `http://localhost:3710/api/manifest` FIRST. It lists every endpoint,
query params, and JSON shape. Do not assume any endpoint — verify against
the manifest. If `authMode` is `"bearer"`, include `Authorization: Bearer
<token>` (token = the value of `CHORUS_API_TOKEN` when the runtime started).

STEP 2 — ASK THE USER

Ask ONE question: "What do you want to see — runs, errors, patches,
integrations, or all four?" If they say "whatever" or "you decide", default
to all four.

STEP 3 — OUTPUT ONE HTML FILE

Return exactly one `<!doctype html>` file in a single code block. No prose
before or after. Under 500 lines. Inline CSS + inline JS + vanilla `fetch`.
No frameworks. No build step. No external CDN (not even fonts or Tailwind).
Must work offline and over `file://`.

ENDPOINTS (use whichever the user wants)

- `GET /api/runs?limit=50` — id, workflowId, status, startedAt, durationMs, error, attempt
- `GET /api/runs/:id` — one run plus `nodeResults[]` (per-step output/error/duration)
- `GET /api/errors?limit=50` — hash, integration, operation, errorClass, httpStatus, occurrences, lastSeen, sampleContext
- `GET /api/patches?limit=50` — id, integration, version, state, appliedAt
- `GET /api/integrations` — name, runCount, errorCount, patchCount, lastUsedAt
- `GET /api/workflows` — id, name, version, active, updatedAt

UX RULES (NOT NEGOTIABLE)

- Timestamps: render as "5m ago" / "2h ago" / "Apr 14"; put the raw ISO
  string in `title=` for hover.
- Status colors: success=green, failed=red, running=amber, pending=gray,
  cancelled=strikethrough gray. Stay consistent across tables.
- IDs and signature hashes: monospace; truncate to 12 chars + `…`; full
  value in `title=`.
- Error strings: truncate at 140 chars; click to expand.
- Every table needs an empty-state message (never a blank panel).
- On first load, show "Loading…"; on refresh, swap in place (don't blank
  the UI).
- If a fetch fails, show a top banner "Lost connection to Chorus runtime —
  is it running?" with a retry button.

REFRESH

Auto-poll every 15s. Show "Last updated: 8s ago" and a pause/resume
button. Pause when `document.hidden`; resume on focus.

FORBIDDEN

- External CDNs, analytics, trackers, or remote fonts.
- API keys in URL strings (use the `Authorization` header only).
- Write endpoints: this API is read-only. No POST/PATCH/DELETE.
- Full-viewport loading spinners (use per-section states).

STYLE

Render in this aesthetic: {{STYLE}}

If `{{STYLE}}` is empty, use a clean inspector-panel look: system font,
monospace for ids, cool-gray background, high-contrast text, no rounded
corners, no shadows.

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
