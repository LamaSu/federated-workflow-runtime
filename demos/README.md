# Demos

Terminal recordings of Chorus in action, scripted with [VHS](https://github.com/charmbracelet/vhs).

VHS is a scripted terminal recorder — you write a `.tape` file, run `vhs` on it, get back a `.gif` + `.mp4` + `.webm`. Zero timing skew, reproducible, easy to iterate.

## Prerequisites

```bash
# macOS
brew install vhs

# Linux / Windows / any Go env
go install github.com/charmbracelet/vhs@latest

# Ensure ffmpeg + ttyd are on PATH (VHS dependencies — brew/apt install)
```

## Recording

From this directory:

```bash
vhs chorus-quickstart.tape
```

Emits `chorus-quickstart.gif`, `.mp4`, `.webm` (all gitignored — only the `.tape` source is tracked).

## Available tapes

| Tape | Duration | What it shows |
|---|---|---|
| [`chorus-quickstart.tape`](./chorus-quickstart.tape) | ~90s | Install via `npx`, scaffold a project, install an integration, show auto-MCP exposure, show the agent-generated UI prompt. Terminal-only, no faked UI. |

## Design principles

- **No mocked output.** Every command runs for real against live code.
- **No screen caps.** Pure terminal is the most honest representation of what Chorus is (CLI-first by design).
- **Hidden setup only for env cleanup.** `VHS`'s `Hide`/`Show` blocks are used to clean `/tmp` and set the encryption key — everything the viewer sees is real output.
- **Timings are conservative.** Better too slow than unreadable.

## Editing / Iterating

Tape files are plain text. To slow down a scene:

```tape
Set TypingSpeed 40ms     # default type speed
Sleep 8s                 # pause after output
```

To inspect without recording:

```bash
vhs --live chorus-quickstart.tape   # opens a live preview at :7681
```

## Gitignore

The rendered `.gif` / `.mp4` / `.webm` are in `.gitignore` to keep the repo light. Host the artifacts on a CDN (e.g., a release asset or a docs subdomain) and link to them from the README.
