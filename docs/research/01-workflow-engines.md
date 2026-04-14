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

## Activepieces Pieces Registry - WebSearch + docs synthesis
Sources:
- https://www.activepieces.com/docs/developers/building-pieces/create-trigger
- https://www.mintlify.com/activepieces/activepieces/pieces/create-action
- https://github.com/activepieces/activepieces
- https://dev.activepieces.com/quickstart.html

Key facts:
- **~440 pieces**, 60% community-contributed, MIT license.
- **Each piece is an independent npm package** implementing the framework API. Hot-reload in dev.
- **Two primitives**: Trigger (event source) and Action (step).
- **Trigger techniques**: polling or webhook — explicit field, not inferred.
- **Actions are pure functions**: inputs (props) → logic → outputs. Framework enforces this contract.
- **Engine operations** (6 types): Extract Piece Metadata, Execute Step, Execute Flow, Execute Property, Execute Trigger Hook, Execute Auth Validation. These are the only RPCs sandbox-engine supports.
- **Engine APIs to pieces**: Storage (k/v), File service (local/DB), Fetch project metadata.
- **MCP bonus**: contributed pieces auto-appear as MCP servers for Claude/Cursor/Windsurf. Big for agent-era positioning.
- **Verification**: community pieces go through PR review in the monorepo. There's no separate NPM-based registry — it's all in the `packages/pieces` directory of the monorepo.

Design takeaway: The "pieces-as-npm-packages" model is cleaner than n8n's mixed bag. Chorus should adopt this + also mirror the automatic MCP-surfacing for every integration (huge force multiplier for AI agents).

---

## Windmill Execution Model - WebSearch synthesis
Sources:
- https://github.com/windmill-labs/windmill
- https://www.windmill.dev/blog/launch-week-1/fastest-workflow-engine
- https://github.com/windmill-labs/windmill/blob/main/backend/windmill-worker/src/worker.rs
- https://www.windmill.dev/docs/intro

Key facts:
- **Rust backend**, single binary, runs as either API server or worker (mode = env var).
- **Postgres-as-queue**: no Redis, no Kafka. Uses `UPDATE ... SKIP LOCKED` to atomically claim jobs. This is the Windmill superpower.
- **ACID state**: every state transition is one transacted SQL statement. Crash-safety is free.
- **Pipelined ack**: completed-job processing runs in a tokio background task via channel, so workers don't wait for ack before pulling the next job. Massive throughput win.
- **Stateless everything**: API and workers only talk to Postgres, never to each other. Horizontal scale is trivial.
- **Sandboxing**: nsjail for filesystem/resource isolation + PID namespace so a script can't see worker process memory. Enabled by default.
- **Runtimes**: Deno, Python, Go, Bash, TypeScript (via Bun), PowerShell, SQL, Rust, Ansible, PHP. Multi-language from day one — that's the killer feature.
- **Benchmark claim**: 13x faster than Airflow. Validated via dedicated "fastest workflow engine" blog post.
- **Once a job starts**, zero overhead vs running the script directly — the runner is transparent.

## Windmill Flow Definition (OpenFlow) - WebSearch synthesis
Sources:
- https://www.windmill.dev/docs/openflow
- https://github.com/windmill-labs/windmill/blob/main/openflow.openapi.yaml
- https://www.windmill.dev/docs/flows/architecture
- https://www.windmill.dev/docs/advanced/cli/flow

Key facts:
- **OpenFlow**: Windmill-designed open standard, published as an OpenAPI/Swagger spec. JSON-serializable. Explicitly positioned as a standard others could adopt.
- **FlowValue shape**:
  - `input` (spec, like script inputs)
  - `modules[]` (ordered steps)
  - `failure_module` (error handler)
  - `preprocessor` (optional pre-step)
- **Step types**: script, subflow, loop (for-each), branch (if/switch).
- **DAG representation**: state machine rendered as DAG in UI. Steps run in sequence; branches fork explicitly.
- **File layout**: Flow = folder with `flow.yaml` + inline script files. Inline scripts stored as separate files so editors give syntax highlighting and git diffs are readable.
- **CLI support**: `wmill flow push`, `wmill flow pull` for GitOps.
- **Trade-off**: higher learning curve than n8n's drag-drop; reward is GitOps-friendly, diffable, forkable flows.

Design takeaway: Postgres-as-queue is the single biggest architectural insight. Nothing about Redis/Bull is actually better — Postgres gives you stronger ACID with SKIP LOCKED. Chorus should consider this seriously. Also: an "OpenFlow"-like public spec for Chorus flows lets third parties build editors, validators, and runners without touching the core.

---

## Pipedream AI Integration Generation - WebSearch synthesis
Sources:
- https://pipedream.com/docs/components/api
- https://pipedream.com/docs/connect/components
- https://pipedream.com/blog/build-workflows-faster-with-ai/
- https://pipedream.com/connect

Key facts:
- **Components = unified primitive**: triggers + actions are both "components" — self-contained executable units. End users configure inputs → output available to downstream steps.
- **2500+ integrations**. AI code generation understands the Pipedream Component API and reads target-app API docs.
- **AI generation workflow**: user describes intent → LLM generates component code → runs in sandbox → iterates. Code generation service has a schema-aware prompt template + access to a corpus of existing components for few-shot examples.
- **Runtime**: serverless, isolated per workflow. Up to 10GB memory, 750s execution time. Supports Node.js (primary), Python, Go, Bash. npm's 400k packages usable.
- **Isolation per workflow execution**: can't confirm V8 isolates specifically from public docs, but the language is "isolated environment per instance" — almost certainly Firecracker or similar microVM given resource envelope.
- **Connect + MCP architecture**: credentials isolated from LLMs and client code. Pipedream Connect = white-label embedded OAuth; MCP surface exposes actions to AI agents without leaking creds.
- **Component registry**: public GitHub repo `PipedreamHQ/pipedream`, but the AI-gen lives inside the Pipedream platform (closed source).

Design takeaway: Pipedream's unified "component" concept is cleaner than Trigger/Action split. Also: AI-generated integrations are table stakes for 2026 — Chorus should ship an AI Forge that reads an OpenAPI spec or docs URL and generates an integration. (Mirrors the existing `/forge` in the user's harness.)

---

## Inngest Durable Execution - WebSearch synthesis
Sources:
- https://www.inngest.com/docs/learn/how-functions-are-executed
- https://www.inngest.com/blog/how-durable-workflow-engines-work
- https://github.com/inngest/inngest
- https://www.inngest.com/docs/features/inngest-functions/steps-workflows

Key facts:
- **Event-driven**: everything starts from an event. Functions register as consumers with pattern-matching subscription. No cron-first mental model; cron = "scheduled event".
- **Architecture**:
  - **Event API** (HTTP): auth via Event Keys, publishes to event stream.
  - **Event Stream**: buffer (Redpanda/Kafka-esque).
  - **Runner**: schedules function runs, maintains state, handles flow control (rate limits, debounce, throttle), manages waitForEvent pauses.
  - **Executor**: runs function invocations + step-by-step execution; retries; writes incremental state.
  - **State Store**: persists event(s), step outputs, step errors for every in-flight run.
- **Durable execution via steps**: `step.run("name", fn)` / `step.sleep` / `step.waitForEvent` / `step.invoke`. Each step:
  - Runs as an isolated unit.
  - Its output is memoized by step name.
  - Re-invoking the function re-plays memoized steps (cheap); only unrun steps execute.
  - Failures retry the specific step, not the whole function.
- **Execution model**: "Function as replayable state machine." Function body is executed repeatedly — each time advances one more step. Function body is pure code (TS, Go, Python, Elixir SDKs). SDK exports `step` object as the primary API.
- **Long-running**: `step.sleep("7d", ...)` is free — the function is unloaded, Runner schedules resume after wall-clock elapses.
- **Flow control built-in**: rate limit, debounce, throttle, concurrency — all declarative on the function definition.

Design takeaway: Inngest's step-based durable execution is a LEAP over n8n's monolithic workflow runs. For AI-agent workflows that may wait for human approval, poll external APIs for hours, or retry flaky LLM calls, this is the ONLY sane model. Chorus's runtime should adopt:
1. Step memoization via deterministic step names.
2. Replay-based resumption.
3. `step.sleep` + `step.waitForEvent` primitives.
4. Per-step retry policy, not per-workflow.

---

## Inngest - Durable Engine Deep Dive
Source: https://www.inngest.com/blog/how-durable-workflow-engines-work

Key facts:
- **Durable engines = memoization engines**. That's the whole trick: steps are replayable because their outputs are recorded.
- **Execution loop**:
  1. Workflow init → enqueue job with event data.
  2. Executor reads queue, invokes workflow body (user code).
  3. SDK checks state map: previously completed steps return cached output (skip).
  4. New step runs → state atomically updated → next iteration enqueues.
- **Step primitives**:
  - `step.run(name, fn)` — single transaction, runs once on success, retries on failure.
  - `step.sleep(name, duration)` / `step.sleepUntil(name, date)` — function suspends; Runner schedules resume. No compute cost while sleeping.
  - `step.waitForEvent(name, { event, match, timeout })` — pause on external event; timeout resolves to null.
- **Queue architecture**: Inngest creates TWO queues per deployed function (likely primary + retry). Workers are shared-nothing. Guarantees oldest-first.
- **State is per-run, per-step**: each step's output stored by deterministic step name hash.
- **SDK is the clever part**: user-facing API is synchronous-looking `await step.run(...)` but under the hood each `step.*` call is a yield point that may throw a "StepFlowControlError" causing the function body to unwind. The worker re-invokes the function with updated state map; the SDK replays execution up to the next unrun step.

This is equivalent to Temporal's durable execution model, but with much smaller SDK surface.

---

## Trigger.dev v3 - WebSearch synthesis
Sources:
- https://trigger.dev/docs/how-it-works
- https://trigger.dev/blog/v3-announcement
- https://github.com/triggerdotdev/trigger.dev
- https://vadim.blog/trigger-dev-deep-dive

Key facts:
- **Container + CRIU**: v3's BIG change vs v2 is "no-timeout" durable execution via **CRIU** (Checkpoint/Restore In Userspace) on Linux. Running containers get frozen to disk mid-task and restored later — possibly on different machines. This is how `step.sleep("7d")` costs nothing.
- **Architecture**: task queue + scheduler + worker pool + logging.
- **Task definition**: code lives in `/trigger` folders in user's codebase; SDK exports `task({ id, run: async ({ payload, io }) => {...} })`. Deployed from user's repo via the Trigger.dev CLI.
- **Task types**: regular + scheduled. Scheduled = cron.
- **Durability via checkpoint-resume + idempotency keys**: 
  - Workflows decomposed into subtasks, each with an idempotency key.
  - Output cached by idempotency key.
  - On failure, only failed subtask and descendants retry.
- **Multi-tenant queue** with concurrency rules: sequential/parallel, concurrency keys for per-user/per-tier isolation.
- **Key differentiator vs Inngest**: Trigger.dev checkpoints PROCESS state (via CRIU), Inngest REPLAYS function body. CRIU is more "magical" but has platform constraints (Linux containers only, no Deno/Bun without extra work). Inngest replay is more portable but requires deterministic-ish function bodies.

Design takeaway: CRIU is overkill for Chorus's MVP. Replay-based durable execution (Inngest model) is simpler and language-portable. Adopt step memoization + keep the CRIU option for later as an optimization for workflows with large in-memory state that's expensive to rehydrate.

---
