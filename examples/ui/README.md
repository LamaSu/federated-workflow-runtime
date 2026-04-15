# examples/ui — Chorus dashboards

This directory ships with exactly ONE dashboard: `minimal.html`. It's a vanilla
HTML + JS file (no build, no CDN, no framework) that hits the Chorus runtime's
read-only JSON API and renders three tables — runs, errors, patches.

The intent isn't for you to use this as your dashboard. It's for you to see
the minimum that works, then ask your own agent to build something tuned to
YOU.

## Quickstart

```bash
# 1. Make sure a Chorus runtime is running (defaults to http://127.0.0.1:3710).
chorus run

# 2. In another terminal, either open the file directly...
open examples/ui/minimal.html          # macOS
start examples/ui/minimal.html         # Windows
xdg-open examples/ui/minimal.html      # Linux

# ...or serve it (recommended; avoids CORS edge cases on file://):
chorus ui --serve                      # serves on http://127.0.0.1:3711
```

## Build your own

```bash
chorus ui --prompt | pbcopy            # macOS
chorus ui --prompt | clip              # Windows
chorus ui --prompt | xclip -sel c      # Linux
```

Then paste the prompt into Claude / ChatGPT / Cursor / your own agent, and
describe what you want. The prompt teaches the agent to fetch the manifest
first, so every dashboard it generates stays in sync with what your runtime
actually supports.

## What the minimal dashboard does

- Fetches `/api/runs?limit=20`, `/api/errors?limit=20`, `/api/patches?limit=20`
  in parallel every 15 seconds.
- Renders three tables with monospace ids, status color coding, and "N min
  ago" timestamps.
- Falls back to "Lost connection" if the runtime isn't reachable.
- Zero external dependencies — works over `file://` and offline.

## What it doesn't do

- Run-detail view (click a row to see per-node results). The endpoint
  (`/api/runs/:id`) exists; the UI is intentionally minimal.
- Filtering / search.
- Dark mode / theme switching.
- Any style more opinionated than "warm green on cream paper."

For any of that, `chorus ui --prompt` into your agent is the answer. The API
already supports it.
