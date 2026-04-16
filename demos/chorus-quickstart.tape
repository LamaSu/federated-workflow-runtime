# Chorus — Zero to running in 90 seconds
#
# A VHS tape (https://github.com/charmbracelet/vhs) that records a clean
# terminal demo of Chorus: install → scaffold → explore CLI → show the
# agent-generated UI prompt. Terminal-only, no faked UI, no mocked data.
#
# Record with:
#   brew install vhs          # or: go install github.com/charmbracelet/vhs@latest
#   cd demos && vhs chorus-quickstart.tape
#
# Produces: demos/chorus-quickstart.gif + .mp4 + .webm
#
# ~90 seconds runtime. Designed for README embedding + social posting.

Output demos/chorus-quickstart.gif
Output demos/chorus-quickstart.mp4
Output demos/chorus-quickstart.webm

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 720
Set TypingSpeed 40ms
Set Theme "Dracula"
Set FrameRate 30
Set PlaybackSpeed 1.0

# ── Hidden setup: clean tmpdir, pre-set encryption key so init is non-interactive ──
Hide
Type "mkdir -p /tmp/chorus-demo && cd /tmp/chorus-demo && rm -rf chorus .chorus"
Enter
Sleep 200ms
Type "export CHORUS_ENCRYPTION_KEY=$(openssl rand -base64 32)"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 300ms
Show

# ── Scene 1: Intro (3s) ───────────────────────────────────────────────────────
Type "# Chorus — federated workflow runtime for the agent era"
Enter
Sleep 800ms
Type "# self-hosted · AI-repaired · signed patches propagate across the fleet"
Enter
Sleep 1500ms
Enter
Sleep 500ms

# ── Scene 2: Install + Init (10s) ─────────────────────────────────────────────
Type "# 1. One command installs. Scaffolds a project in seconds."
Enter
Sleep 800ms
Type "npx --yes @delightfulchorus/cli@latest init"
Enter
Sleep 8s

# ── Scene 3: What was scaffolded (8s) ─────────────────────────────────────────
Type "ls -la chorus/"
Enter
Sleep 2500ms
Enter
Type "cat chorus/config.yaml"
Enter
Sleep 3500ms

# ── Scene 4: Install an integration (6s) ──────────────────────────────────────
Type "clear"
Enter
Sleep 300ms
Type "# 2. Integrations are npm packages. Install what you need."
Enter
Sleep 800ms
Type "npm install @delightfulchorus/integration-slack-send --silent 2>/dev/null"
Enter
Sleep 5s

# ── Scene 5: MCP — the agent-era differentiator (8s) ──────────────────────────
Type "clear"
Enter
Sleep 300ms
Type "# 3. Every integration is auto-MCP. Expose to any agent."
Enter
Sleep 1s
Type "chorus mcp list"
Enter
Sleep 4s

# ── Scene 6: The genui story — agent-generated UI (14s) ───────────────────────
Type "clear"
Enter
Sleep 300ms
Type "# 4. The UI is agent-generated. Chorus ships a prompt, not a dashboard."
Enter
Sleep 1200ms
Type "# Paste this into Claude / Cursor / ChatGPT — get a custom dashboard."
Enter
Sleep 1200ms
Type "chorus ui --prompt | head -30"
Enter
Sleep 8s

# ── Scene 7: Call to action (6s) ──────────────────────────────────────────────
Type "clear"
Enter
Sleep 300ms
Type "# That's the whole story in 90 seconds."
Enter
Sleep 800ms
Enter
Type "#   npm install -g @delightfulchorus/cli"
Enter
Type "#   chorus init"
Enter
Type "#   chorus run"
Enter
Enter
Type "# github.com/LamaSu/federated-workflow-runtime"
Enter
Type "# npmjs.com/~lamasu"
Enter
Sleep 4s
