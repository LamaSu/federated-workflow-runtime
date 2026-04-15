# The Chorus UI is whatever your agent builds

Chorus deliberately does not ship a hardcoded dashboard. You already have
Claude, ChatGPT, Cursor, or your own custom agent — any of them can generate
a dashboard that fits your workflow better than any one-size-fits-all UI.

What Chorus ships instead is the **substrate** for UI generation:

1. A small, stable, read-only JSON API.
2. A self-describing manifest your agent can fetch once to learn every
   endpoint.
3. A polished prompt template that turns a capable LLM into a Chorus
   dashboard generator.
4. One reference HTML dashboard (`examples/ui/minimal.html`) proving the
   API is sufficient.

## Quickstart

```bash
# 1. Start the runtime (binds to 127.0.0.1:3710 by default).
chorus run

# 2. Copy the prompt.
chorus ui --prompt | pbcopy          # macOS
chorus ui --prompt | clip            # Windows
chorus ui --prompt | xclip -sel c    # Linux

# 3. Paste it into Claude (or your agent of choice). Say:
#    "dashboard for my Chorus runtime, minimalist terminal style"
#
#    The agent fetches /api/manifest, asks what you want, outputs one HTML
#    file.

# 4. Save its output as dashboard.html and open it:
open dashboard.html                  # macOS
start dashboard.html                 # Windows
xdg-open dashboard.html              # Linux
```

## The API manifest

The manifest lives at `http://127.0.0.1:3710/api/manifest`. Fetch it once at
boot; it lists every endpoint your runtime supports, the exact query params
each accepts, and the response shape. Example response (abbreviated):

```json
{
  "chorusApiVersion": "1",
  "readOnly": true,
  "authMode": "localhost",
  "endpoints": [
    { "path": "/api/runs", "method": "GET", "description": "...", "responseShape": "{ runs: RunSummary[], total: number }" },
    { "path": "/api/errors", "method": "GET", "description": "...", "responseShape": "{ errors: ErrorSignatureSummary[] }" }
  ],
  "dataModel": {
    "RunSummary": "{ id: string, workflowId: string, status: ..., durationMs: number|null, ... }"
  },
  "capabilities": ["runs.list", "runs.get", "errors.list", ...]
}
```

Your agent can regenerate its dashboard any time the manifest changes —
schema drift is observable, not silent.

## All endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/manifest` | Self-description (fetch this FIRST). |
| `GET /api/workflows` | List workflows. |
| `GET /api/workflows/:id` | Workflow detail + definition. |
| `GET /api/runs?limit=N&status=X&workflowId=Y` | Filterable run list. |
| `GET /api/runs/:id` | Run detail with per-node results. |
| `GET /api/errors?limit=N&integration=X` | Error signatures, aggregated by fingerprint. |
| `GET /api/patches?limit=N&integration=X&stage=Y` | Known patches (canary states). |
| `GET /api/patches/:id` | Patch detail + signature metadata. |
| `GET /api/integrations` | Installed integrations with usage stats. |

All responses send `Cache-Control: no-store` and
`X-Chorus-API-Version: 1`. All responses are JSON. Everything is read-only
— no POST/PATCH/DELETE.

## Customizing the style

The prompt template in `docs/UI_PROMPT_TEMPLATE.md` ends with:

> STYLE
>
> Render the whole thing in this aesthetic: {{STYLE}}

Your agent will swap `{{STYLE}}` for whatever you say. Examples that work
well:

- `"solarpunk terminal, warm green on cream, monospace, text glyphs instead of icons"`
- `"minimalist notion-style, pure white, one green accent, generous padding"`
- `"ops dashboard like Datadog, dark navy, dense rows, sparklines"`
- `"1990s newspaper, serif headlines, grayscale, black borders"`
- `"hand-drawn zine, caps-lock, CSS grain texture, punk energy"`
- `"screen-reader-first, high contrast, no color, generous focus rings"`

If you want to iterate, just ask the agent: "same thing, but more dense /
darker / with icons." The agent has the manifest cached from its first
fetch; it won't re-fetch unless schemas change.

## Example generated dashboards (asciified)

### User prompt: "just errors, dense, monospace, last 100"

```
CHORUS ERRORS                                  Last refresh: 3s ago  [pause]

hash           integration.op         class        occ  last
a3f21c9e0d8b   slack-send.postMessage HTTPError    42   8s ago
7bde3f09a112   http-generic.request   TimeoutError 13   44s ago
55ff30a8e9cc   stripe.createCharge    AuthError    9    2m ago
1c22e3a4d10f   gmail.send             RateLimit    2    17m ago
```

### User prompt: "dashboard like Notion, runs and integrations"

```
┌─────────────────────────────────────────────────────────────────┐
│  Chorus                                                         │
│                                                                 │
│  Recent runs (42 shown of 184)                                 │
│                                                                 │
│  ✓  gmail-sync              2 min ago          1.4 s           │
│  ✓  stripe-notification     5 min ago          342 ms          │
│  ✗  slack-daily-digest      14 min ago         —   retry →     │
│                                                                 │
│  Integrations                                                   │
│                                                                 │
│  http-generic       used 120x today   3 errors    1 patch       │
│  slack-send         used 42x today    12 errors   2 patches     │
│  gmail              used 8x today     0 errors    0 patches     │
└─────────────────────────────────────────────────────────────────┘
```

### User prompt: "everything, solarpunk"

```
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░                    C H O R U S                        ░
░                 federated runtime                     ░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

[OK] recent runs (3)
     ├─ 2m │ gmail-sync        │ 1.4s  │ a3f21c
     ├─ 5m │ stripe-notify     │ 342ms │ 7bde3f
     └─14m │ slack-daily       │ FAIL  │ 1c22e3

[!!] error signatures (2)
     ├─ a3f2…  slack.post       × 42  │  8s
     └─ 7bde…  http.request     × 13  │ 44s

[->] patches (1 fleet)
     └─ p-slack-retry   slack-send @ 0.2.1   ⇒ applied 3h
```

## Security

- **Default mode**: Chorus binds to `127.0.0.1`. The API is reachable from
  your machine, nothing else.
- **Team mode**: Set `CHORUS_API_TOKEN=<long-random-string>` when starting
  the runtime. Every `/api/*` request must then carry
  `Authorization: Bearer <token>`. The manifest's `authMode` field will
  report `"bearer"` so agents know to include the header.
- **Remote access**: Don't expose the API publicly. Tunnel through SSH:
  ```bash
  ssh -L 3710:127.0.0.1:3710 your-server
  # Now http://localhost:3710 on your laptop → the remote runtime.
  ```
- **Never**: expose Chorus behind a reverse proxy on the public internet
  without a token AND a known-good reverse proxy config (rate limiting,
  TLS). The read-only API doesn't leak secrets, but error contexts and
  workflow names may be sensitive.

## FAQ

**Why no hardcoded UI?** Every hardcoded UI is wrong for somebody. The one
you generate yourself is right for you. The ARCHITECTURE calls this out
in §1.4: "Chorus is code-and-config-first. Flows live in a `chorus/`
directory. The UI comes later; CLI ships first." A generator that turns
any capable LLM into a dashboard writer is the UI that comes later.

**Can I build a React / Vue / Svelte dashboard?** Yes — the prompt
deliberately pushes agents toward vanilla JS + a single HTML file (simpler,
offline, no build step), but nothing in the API requires that. If you want
a React app, swap `chorus ui --prompt` for your own prompt.

**Can I mutate state via the API?** No. The API is read-only by design.
Run `chorus run <workflow>` from the CLI to trigger workflows, and
`chorus credentials add` to manage credentials. Those are write paths; the
API lives in a separate security domain.

**What happens when I upgrade Chorus?** The manifest's `chorusApiVersion`
will bump. Regenerate your dashboard with the same prompt — your agent
will see the new endpoints automatically.
