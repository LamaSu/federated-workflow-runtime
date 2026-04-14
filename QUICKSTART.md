# Chorus Quickstart

**Goal:** zero to a working webhook → Slack workflow in about five minutes.

You will:

1. Install Chorus.
2. Run `chorus init` to scaffold a project.
3. Store a Slack bot token (encrypted, never in plaintext).
4. Define a workflow in `./chorus/workflows/hello.yaml`.
5. Start the runtime and hit your webhook with `curl`.
6. See what happens when it breaks, and how Chorus auto-fixes it.

If anything here doesn't work, jump to the [Troubleshooting](#8-troubleshooting) section at the bottom.

---

## 1. Prerequisites

- **Node.js 20 or newer.** Check with `node -v`. Chorus uses native `fetch`, which is stable from Node 20 onwards.
- **A Slack workspace** where you can install a bot. Any free workspace works.
- **A terminal** (any — bash, zsh, PowerShell, cmd all fine).

```bash
$ node -v
v20.17.0
```

If you do not have Node 20+, grab it from [nodejs.org](https://nodejs.org/) or use `nvm`/`fnm` to switch.

---

## 2. Install

Clone the repo and install dependencies:

```bash
git clone https://github.com/chorus/chorus.git
cd chorus
npm install
```

This pulls every workspace: core, runtime, registry, reporter, repair-agent, cli, and the two reference integrations (http-generic, slack-send).

Then link the CLI globally so you can type `chorus` from any directory:

```bash
npm install -g ./packages/cli
# or, without global install:
alias chorus="node $(pwd)/packages/cli/dist/cli.js"
```

Sanity check:

```bash
$ chorus --help
Usage: chorus [options] [command]

Chorus — federated workflow runtime with crowd-sourced integration maintenance

Commands:
  init               scaffold a ./chorus/ project directory
  run [workflow]     start the runtime (foreground)
  report             show recent runs, error signatures, and known patches
  validate <files>   schema-check workflow file(s) without executing
  patch              manage integration patches
  credentials        add/list/remove credentials
```

---

## 3. Initialize a project

Pick an empty directory and run:

```bash
$ mkdir hello-chorus
$ cd hello-chorus
$ chorus init
✓ Chorus initialized
   config:     /home/you/hello-chorus/chorus/config.yaml
   workflows:  /home/you/hello-chorus/chorus/workflows
   keys:       /home/you/hello-chorus/.chorus/keys.json

! A new encryption key was written to /home/you/hello-chorus/chorus/.env.example.
   Copy to .env and keep it safe — losing it = losing all credentials.

Next steps:
   chorus credentials add slack-send --type bearer
   chorus run
```

This creates:

```
./chorus/
   config.yaml              # project settings
   .env.example             # CHORUS_ENCRYPTION_KEY=<generated>
   .gitignore               # excludes secrets
   workflows/
      hello.example.yaml    # a starter webhook workflow
./.chorus/
   keys.json                # Ed25519 keypair (this machine's identity)
```

**Copy `.env.example` to `.env`** so the runtime can decrypt credentials:

```bash
cp chorus/.env.example .env
```

> The `CHORUS_ENCRYPTION_KEY` in `.env` is your AES-256-GCM key. It is generated randomly at init time. If you lose it, you cannot decrypt stored credentials — treat it like a root password.

---

## 4. Add a Slack token

Create a Slack bot token (Slack admin → "Create a new app" → "From scratch" → add the `chat:write` scope → install to workspace → copy the Bot User OAuth Token — starts with `xoxb-`).

Load the key into your shell and store the token:

```bash
$ export $(grep -v '^#' .env | xargs)
$ chorus credentials add slack-send --type bearer --interactive
enter bearer secret for slack-send: ****************************
✓ stored credential slack-send:default (bearer)
   (encrypted with CHORUS_ENCRYPTION_KEY; plaintext never written)
```

Chorus encrypts the token with AES-256-GCM using your `CHORUS_ENCRYPTION_KEY` before writing it to the SQLite DB in `.chorus/chorus.db`. The CLI never prints, logs, or echoes the plaintext after storage.

Verify it landed:

```bash
$ chorus credentials list
Credentials (1)
   slack-send:default  bearer  created 2026-04-13T23:45:00Z
```

---

## 5. Define a workflow

Open `chorus/workflows/hello.yaml` (or delete the example and start fresh):

```yaml
id: hello
name: Webhook-to-Slack demo
version: 1
active: true
trigger:
  type: webhook
  path: /hooks/hello
  method: POST
nodes:
  - id: post
    integration: slack-send
    operation: postMessage
    config:
      channel: "#general"
      text: "Hello from Chorus!"
createdAt: 2026-04-13T00:00:00Z
updatedAt: 2026-04-13T00:00:00Z
```

Validate it before running:

```bash
$ chorus validate chorus/workflows/hello.yaml
OK /home/you/hello-chorus/chorus/workflows/hello.yaml — workflow 'Webhook-to-Slack demo' v1
```

If you have a syntax error or a missing field, `validate` prints the exact path and reason:

```
FAIL chorus/workflows/hello.yaml
   • trigger.type: Invalid enum value. Expected 'cron' | 'webhook' | 'manual', received 'bogus'
```

---

## 6. Run it

Start the runtime in the foreground:

```bash
$ chorus run
Chorus starting — project: hello-chorus
   database:  .chorus/chorus.db
   server:    http://127.0.0.1:3710
workflows:
   ✓ /home/you/hello-chorus/chorus/workflows/hello.yaml
[info] Fastify listening on 127.0.0.1:3710
[info] registered webhook POST /hooks/hello
```

Leave it running. In another terminal, hit the webhook:

```bash
$ curl -X POST http://localhost:3710/hooks/hello -d '{"text":"hi there"}'
{"accepted":true,"runId":"018f2c4a-..."}
```

Flip over to your Slack workspace — you should see "Hello from Chorus!" in `#general`.

To stop the runtime, press **Ctrl-C**. The runtime waits for in-flight steps to finish before exiting.

---

## 7. What happens when it breaks

Most SaaS integrations break sooner or later — Slack shuffles error codes, Google renames OAuth scopes, Stripe bumps a required parameter. Chorus catches the failure, hashes it into a stable signature, and (if you enable the repair agent) asks Claude to propose a fix.

Simulate a break: rename your Slack channel to one that doesn't exist.

```yaml
config:
  channel: "#nonexistent-channel"
  text: "Hello from Chorus!"
```

Fire the webhook again. This time the run fails:

```bash
$ curl -X POST http://localhost:3710/hooks/hello -d '{"text":"hi"}'
{"accepted":true,"runId":"018f2c4b-..."}
```

Check the report:

```bash
$ chorus report
Chorus report — /home/you/hello-chorus/.chorus/chorus.db

Recent runs (2)
   success   2026-04-13T23:50:00Z  hello  018f2c4a-...
   failed    2026-04-13T23:51:12Z  hello  018f2c4b-...
      → Slack API error: channel_not_found

Error signatures (1)
   a1b2c3d4e5f6…  ×1  slack-send.postMessage  ChorusError (HTTP 200)  local

Patches (0)
   (none)
```

The `Error signatures` line shows Chorus has hashed this failure into a stable fingerprint. That same hash is what the federated registry uses as a lookup key — when another user hits this same error and a patch gets published, your runtime recognizes the hash and can auto-adopt.

### How the repair agent fits in

When you set `repair.autoAttempt: true` in `chorus/config.yaml` and configure `ANTHROPIC_API_KEY`:

1. A failure with a new signature kicks off a local Claude call.
2. Claude sees the integration source, the failing input, the error, and any related patches.
3. It proposes a patch (diff + test cassette) as a JSON object.
4. Chorus validates the patch locally — replays the failing cassette against the patched code; only accepts if the fix works AND all other cassettes still pass.
5. If valid, Chorus signs (Sigstore + Ed25519) and submits to the registry at `canary-1`.
6. Over ~5 days, the patch climbs the canary ladder: 1 → 2 → 5 → 10 → 20 → 50 → 100%.
7. Other users' runtimes poll the registry every 5 min, see the patch, verify signatures, check if they're in the rollout cohort for their machine, and auto-apply.

You never touched integration code. Your pain became the fleet's immune system.

For the full lifecycle see `docs/ARCHITECTURE.md` sections 5 (Registry), 6 (Reporter), and 7 (Repair Agent).

### How to apply a patch manually

If you want to try a pending patch without waiting for the canary ladder:

```bash
$ chorus patch list
Registered patches
   slack-send_channel-not-found-fix_a1b2c3d4  slack-send@0.1.1  sig: a1b2c3d4e5f6…  state=canary-10

$ chorus patch apply slack-send_channel-not-found-fix_a1b2c3d4 --force
✓ applied slack-send_channel-not-found-fix_a1b2c3d4
```

And to revoke (either because you rolled back or you distrust it):

```bash
$ chorus patch revoke slack-send_channel-not-found-fix_a1b2c3d4
✓ locally revoked slack-send_channel-not-found-fix_a1b2c3d4
```

---

## 8. Troubleshooting

### `error: CHORUS_ENCRYPTION_KEY not set`

Cause: the credentials command can't find your key in the environment.

Fix: `export $(grep -v '^#' .env | xargs)` (bash) or `Get-Content .env | ForEach-Object { if ($_ -notmatch '^#') { $k,$v = $_ -split '='; [Environment]::SetEnvironmentVariable($k,$v) } }` (PowerShell).

### `EADDRINUSE: port 3710`

Cause: something else (another chorus instance, an old zombie) is holding port 3710.

Fix: change `server.port` in `chorus/config.yaml`, or kill the process holding the port. Do **not** `kill -9 chrome` or similar — that's usually unrelated.

### `cannot find module '@chorus/runtime'`

Cause: you ran `chorus run` but the runtime package hasn't been built yet.

Fix: `npm run build` at the repo root. Or, for workspaces in dev: `npm run build -w @chorus/runtime`.

### `Slack API error: invalid_auth`

Cause: the bot token is wrong, revoked, or from the wrong workspace.

Fix: re-install the bot to your workspace to get a fresh token, then `chorus credentials add slack-send --type bearer --interactive` (overwrites the existing entry for `slack-send:default`).

### Workflow validation fails

Cause: most commonly a missing required field (`createdAt`, `updatedAt`, or a valid `trigger.type`).

Fix: `chorus validate chorus/workflows/your.yaml` — it prints the exact JSON path of each problem. The workflow schema is in `packages/core/src/schemas.ts` (`WorkflowSchema`).

### Tests fail on Windows with line-ending warnings

These are harmless. `git config core.autocrlf input` if you want them silenced.

### I lost my `CHORUS_ENCRYPTION_KEY`

Unfortunately, there's no recovery path — that was the point. Delete `.chorus/chorus.db`, re-`chorus init`, re-add credentials. The runtime and patch history are gone, but your workflows in `chorus/workflows/` are safe.

---

## Next steps

- **Explore the architecture.** `docs/ARCHITECTURE.md` is the implementer's bible — especially §2 (data model), §4 (runtime), and §8 (Integration SDK).
- **Write your own integration.** Copy `integrations/slack-send/` as a template. Export an `IntegrationModule` with a manifest and operations. All the heavy lifting is in the error-class choices (AuthError vs RateLimitError vs IntegrationError).
- **Turn on the repair agent.** Edit `chorus/config.yaml`, set `repair.autoAttempt: true`, and put `ANTHROPIC_API_KEY` in `.env`. Start with a small daily budget (10 invocations).
- **Contribute patches back.** When your repair agent proposes a fix that works for you, let it submit to the registry. Other users running the same integration adopt it through the canary ladder. See `docs/ARCHITECTURE.md` §5.

Questions, bugs, ideas: open an issue at `github.com/chorus/chorus`. Happy automating.
