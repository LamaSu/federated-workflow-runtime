# Research 01: Workflow Engine Internals
Agent: scout-alpha
Started: 2026-04-13T00:00:00Z

## Progress Tracker
- [x] n8n execution engine (overview)
- [ ] n8n trigger patterns
- [x] n8n node SDK (overview)
- [ ] Activepieces architecture
- [ ] Activepieces pieces registry
- [ ] Windmill execution model
- [ ] Windmill flow definition
- [ ] Pipedream AI integration generation
- [ ] Inngest durable execution
- [ ] Trigger.dev patterns
- [ ] Synthesis: patterns to adopt for Chorus

---

## n8n Execution Engine (Queue Mode) - WebSearch synthesis
Sources:
- https://docs.n8n.io/hosting/scaling/queue-mode/
- https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine
- https://deepwiki.com/n8n-io/n8n/2.1-execution-management
- https://deepwiki.com/n8n-io/n8n-docs/2.1-workflow-engine

Key facts:
- **Two run modes**: single-instance (default) and queue mode (Redis + workers) for horizontal scale.
- **Main instance** handles webhooks, cron triggers, UI. It does NOT execute workflows in queue mode; it only *enqueues* them.
- **Worker pool** picks up jobs from a Redis-backed Bull queue. Each worker is its own Node.js process.
- **Job lifecycle**: `WorkflowRunner.enqueueExecution()` pushes job { executionId } → Bull → `JobProcessor.processJob()` in worker → instantiates `WorkflowExecute` class.
- **Execution model**: stack-based sequential node execution. The engine walks the DAG, stacking downstream nodes as their predecessors complete. It's NOT a task-queue-per-node model; it's one workflow execution per job.
- **State**: Postgres (or SQLite default) persists execution data, status, and output for every node. Enables "show execution history" and restart-from-failure.
- **Concurrency**: Each worker can run multiple workflows in parallel (concurrency-per-worker setting). Scale out by adding workers.
- **Scaling knobs**: `N8N_CONCURRENCY_PRODUCTION_LIMIT` per worker; queue depth is Redis-native.

## n8n Node SDK - WebSearch synthesis
Sources:
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/
- https://github.com/n8n-io/n8n-nodes-starter
- https://docs.n8n.io/integrations/creating-nodes/build/declarative-style-node/

Key facts:
- **Scaffold**: `npm create @n8n/node` generates a package.
- **Two styles**:
  - **Declarative** (recommended for HTTP APIs): JSON-like config, no `execute()` function; n8n's core handles requests/responses from a declared routing object.
  - **Programmatic**: Full `execute()` function, total control. Needed for: non-HTTP APIs, binary data processing, complex pagination, custom trigger nodes.
- **Required exports**: `INodeType` interface with a `description` (display name, props, credentials) + either `routing` (declarative) or `execute` (programmatic).
- **Property system**: fields in `description.properties` render in the UI. Supports `displayOptions` for conditional visibility (e.g., "show field X when operation = create").
- **Credentials**: separate `INodeCredentialType` classes; can be referenced by multiple nodes.
- **Distribution**: npm packages with `n8n` metadata block pointing to node entries. Installed via UI (verified community nodes) or file system.
- **Icon**: SVG preferred, 60x60 PNG fallback.
- **Testing**: `npm link` into n8n dev install; Jest for unit tests on helpers; integration via execute method.

Implication for Chorus: the declarative/programmatic duality is a proven ergonomic split. Most integrations are REST CRUD → declarative config. Complex ones still need imperative escape hatch.

---

## n8n Trigger Patterns - WebSearch synthesis
Sources:
- https://blog.n8n.io/creating-triggers-for-n8n-workflows-using-polling/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/
- https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gmailtrigger/poll-mode-options/

Key facts:
- **Three trigger classes**:
  1. **Webhook**: registers an HTTP endpoint. n8n's main instance holds the HTTP server. Production webhooks persist; test webhooks are ephemeral ("Listen for test event").
  2. **Schedule/Cron**: cron expression evaluated on main instance; enqueues a workflow execution.
  3. **Polling**: node's `webhookMethods.default.checkExists` isn't used; instead, the node has a periodic check function that runs on a schedule. State tracked in workflow "static data" (per-workflow persistent JSON blob) to remember last-seen ID/timestamp.
- **Webhook node config**: IP allowlist, authentication (basic/header/JWT/OAuth), response modes (immediate, wait for last node, custom response), raw body support, binary body support.
- **Critical architectural choice**: webhooks stay bound to the main instance HTTP server in default queue mode. n8n allows dedicated "webhook" process types in very-large deployments, but 99% run webhooks on main.
- **Triggers vs regular nodes**: Implemented as `INodeType` subclass with a `trigger()` or `webhook()` method instead of `execute()`. Trigger returns a "cleanup" function for deregistration (e.g., stop polling interval).
- **Two URLs per webhook**: test URL (manual activation, captures next event for dev) and production URL (always-on after workflow is "Active").

Design takeaway: Chorus should copy n8n's test-URL/production-URL split — it's a UX cornerstone of node authoring. Also: polling should use per-workflow persistent state, not a global event bus, so triggers are self-contained.

---

## n8n Credentials & OAuth - WebSearch synthesis
Sources:
- https://docs.n8n.io/credentials/
- https://n8n.io/legal/security/
- https://medium.com/@duckweave/locking-down-your-workflows-oauth2-credentials-in-n8n-37fba8759da4
- https://n8n.news/n8n-oauth-token-rotation-best-practices-for-enhanced-security/

Key facts:
- **Credentials are first-class**: stored separately from workflows, referenced by ID. Decoupling allows credential reuse + rotation without touching the workflow.
- **Encryption**: AES via `N8N_ENCRYPTION_KEY` (env var, must be stable across restarts). Encrypted BEFORE writing to DB. Losing the key = all credentials unreadable (you can detach, not recover).
- **Cloud adds defense-in-depth**: disk-at-rest encryption (AES256, FIPS-140-2) on top of app-level encryption.
- **OAuth token lifecycle**:
  - Initial flow: n8n hosts redirect URI (`/rest/oauth2-credential/callback`).
  - Tokens stored encrypted; refresh tokens persisted.
  - On expiry, n8n auto-refreshes using the refresh_token grant; updates the stored credential record.
  - If refresh fails (user revoked or token rotated out), credential is marked invalid and workflows fail loudly.
- **Key rotation**: breaking — you must decrypt then re-encrypt. Ops teams treat the encryption key as the single-point-of-failure secret.
- **Access control**: credential-level sharing (team/instance editions). Per-credential ACL.
- **Anti-pattern avoided**: no secrets in workflow JSON. This is a hard n8n rule — the UI enforces it.

Design takeaway: Chorus MUST follow this model from day one. Separate credential store, env-driven encryption key, ID-based reference in flow JSON, automatic refresh, and a "credential health" signal visible in the UI.

---

## Activepieces Architecture - WebSearch synthesis
Sources:
- https://www.activepieces.com/docs/install/architecture/overview
- https://www.activepieces.com/docs/install/architecture/engine
- https://deepwiki.com/activepieces/activepieces
- https://github.com/activepieces/activepieces

Key facts:
- **Monorepo**: Nx-based TypeScript. Core packages:
  - `api` — Fastify backend, REST endpoints, scheduling.
  - `worker` — polls a job queue, allocates a sandbox from a pool, runs the engine.
  - `engine` — single compiled JS file that parses the flow JSON and executes it INSIDE the sandbox.
  - `server-sandbox` — process isolation + pool management + WebSocket between worker and engine.
  - `pieces` — the integration plugin archive; each piece is a TS package.
  - `shared` — common types/helpers.
- **Execution isolation**: Every flow execution runs in a sandbox process separate from the worker. Worker ↔ Engine communicates via WebSocket. This is the key differentiator from n8n.
- **Engine capabilities**: provides an API to pieces at runtime — notably a **Storage Service** (key/value per-piece persistence), token-scoped API access back to the app.
- **Job protocol**: worker polls, picks up flow run, spawns engine in sandbox, engine calls back via WebSocket for DB/state/log operations. Sandbox is pooled for latency (warm processes).
- **Scaling**: horizontal worker scaling; sandbox pool per worker; engine is stateless (all state via worker RPC).
- **WebAssembly aspiration**: community has requested WASM-based pieces for multi-language; currently TS-only.

Design takeaway: Activepieces' isolated-engine + WebSocket RPC is MUCH safer than n8n's "nodes run in worker process" model. A malicious piece can't mutate worker state. Chorus should adopt per-execution isolation — but WebSocket RPC is complex; we might use HTTP loopback or a simpler IPC.

---
