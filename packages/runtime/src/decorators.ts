/**
 * Functional API decorators — `@chorusWorkflow` + `@chorusStep`.
 *
 * Wave 4 item 13. Authoring sugar over the existing Workflow JSON shape.
 * The runtime is unchanged: these decorators register workflow definitions
 * into a module-scoped side-table at module load, and the build-time helper
 * `chorusEmitWorkflows` (also exposed as `chorus emit-workflows` on the CLI)
 * walks the side-table and writes one `<id>.json` per workflow that the
 * existing executor can consume verbatim.
 *
 * ## Why this is implemented as HOFs (Higher-Order Functions), not literal
 * `@`-prefix decorators on function declarations
 *
 * The original spec example:
 *
 * ```ts
 * @chorusWorkflow({ id: "transcribe", trigger: "manual" })
 * async function transcribe(input: { audioUrl: string }) { ... }
 * ```
 *
 * is **not legal TypeScript** in either decorator flavor:
 *
 * - **TC39 Stage 3 decorators** (TypeScript 5.0+, no `experimentalDecorators`
 *   flag): per the proposal grammar, decorators may apply only to:
 *     - Class declarations
 *     - Class methods, fields, getters, setters, accessors
 *
 *   They explicitly do NOT apply to function declarations or top-level
 *   `async function`. See https://github.com/tc39/proposal-decorators §1.2.
 *
 * - **TypeScript experimental decorators** (legacy, behind
 *   `experimentalDecorators: true`): same restriction — decorators apply
 *   only to classes, methods, properties, accessors, and parameters. See
 *   https://www.typescriptlang.org/docs/handbook/decorators.html.
 *
 * Therefore we implement the API as a Higher-Order Function: the user calls
 * `chorusWorkflow(meta, builderFn)` to register a workflow. The visual `@`
 * decorator is provided as an alternative class-based form (see below)
 * for users who want the literal `@`-prefix authoring style.
 *
 * ### Decorator flavor decision
 *
 * For the class-based variant we use **TC39 Stage 3 decorators**. Rationale:
 *
 * - **TC39 is the future.** It's at Stage 3 of the formal standardization
 *   process and ships in TypeScript 5.0+ without the `experimentalDecorators`
 *   compiler flag. Any new TypeScript code we ship today should target
 *   Stage 3.
 * - **Forward compatibility.** TS experimental decorators will eventually
 *   be deprecated and removed. Stage 3 is what V8 / SpiderMonkey will ship
 *   natively.
 * - **No compiler flag pollution.** Stage 3 works with any modern tsconfig
 *   (target >= ES2022, no extra flags). Users adopting `@chorusWorkflow`
 *   don't need to mutate their tsconfig.json — opening adoption.
 *
 * The trade-off: TS experimental decorators are *currently* more widely
 * deployed in the ecosystem (NestJS, TypeORM, etc. still use them). Users
 * on those stacks pay a small learning-cost when they hit our class-based
 * variant. We accept that cost.
 *
 * ## Authoring API
 *
 * Primary form (HOF, recommended):
 *
 * ```ts
 * import { chorusWorkflow } from "@delightfulchorus/runtime";
 *
 * export const transcribe = chorusWorkflow(
 *   { id: "transcribe", trigger: { type: "manual" } },
 *   ($) => {
 *     const audio = $.step("fetch", {
 *       integration: "http-generic",
 *       operation: "request",
 *       config: { url: "{{trigger.audioUrl}}", method: "GET" },
 *     });
 *     const text = $.step("transcribe", {
 *       integration: "llm-openai",
 *       operation: "transcribe",
 *       inputs: { audio: audio.ref },
 *     });
 *     return text;
 *   },
 * );
 * ```
 *
 * Class-based form (TC39 Stage 3 `@`-decorators):
 *
 * ```ts
 * @chorusWorkflowClass({ id: "transcribe", trigger: { type: "manual" } })
 * class Transcribe {
 *   @chorusStepDecl({ integration: "http-generic", operation: "request",
 *                     config: { url: "{{trigger.audioUrl}}" } })
 *   accessor fetch!: StepRef;
 *
 *   @chorusStepDecl({ integration: "llm-openai", operation: "transcribe",
 *                     inputs: { audio: "{{fetch.output}}" } })
 *   accessor transcribe!: StepRef;
 * }
 * ```
 *
 * Both forms emit the *same* JSON shape. The HOF form is the primary
 * recommendation because (a) function declarations are more natural in
 * TypeScript than class declarations for this use-case, (b) it composes
 * cleanly with `await`/control flow at registration time, and (c) it
 * doesn't require classes-as-namespaces.
 *
 * ## Limitations
 *
 * The builder fn is invoked **synchronously at module load** with a builder
 * context. The output is a static Workflow JSON. This means:
 *
 * - **No runtime branching.** If/else inside the builder fn determines
 *   *which steps are emitted*, not *which steps run at runtime*. A workflow
 *   emitted by `chorusWorkflow` has a fixed node graph.
 * - **No I/O at registration time.** The builder runs at module load. If
 *   you do `fetch()` inside the builder, you'll be issuing HTTP calls
 *   during module import. Don't.
 * - **No closures over runtime data.** The builder fn does not receive
 *   trigger payloads. Use `{{trigger.someField}}` templating in
 *   `inputs` / `config` to reference runtime data.
 *
 * If your workflow needs runtime branching, use connections with `when`
 * predicates (which evaluate against the previous node's output) or model
 * the branch as `step.fanOut` with empty arrays in disabled paths.
 */
import type {
  Connection,
  Node as WorkflowNode,
  Trigger,
  Workflow,
} from "@delightfulchorus/core";
import { WorkflowSchema } from "@delightfulchorus/core";

// ── Side-table ───────────────────────────────────────────────────────────────

/**
 * Module-scoped registry of workflows registered via `chorusWorkflow` (HOF
 * form) or `chorusWorkflowClass` (class form). Keyed by workflow id.
 *
 * The registry is per-module-instance. In practice this means per-Node-process
 * for production CLI invocations; tests should call `clearRegistry()` in
 * `beforeEach` to ensure isolation across test cases.
 *
 * Why a Map, not an array: makes `chorusEmitWorkflows` deterministic on
 * insertion order while detecting duplicate-id registrations early. Two
 * workflows with the same id is almost always a bug — the second would
 * silently overwrite the first if we used insert-last semantics, so we
 * throw.
 */
const REGISTRY = new Map<string, Workflow>();

/**
 * Returns a snapshot of the current registry (insertion-ordered). Each
 * snapshot is a fresh array; mutating it does not affect the registry.
 */
export function getRegisteredWorkflows(): Workflow[] {
  return Array.from(REGISTRY.values());
}

/**
 * Clears the registry. Tests SHOULD call this in `beforeEach` so the
 * side-table doesn't leak workflows across cases.
 */
export function clearRegistry(): void {
  REGISTRY.clear();
}

/**
 * Internal: registers a single workflow. Throws on duplicate id (almost
 * always a bug). Validates with `WorkflowSchema` so a malformed registration
 * surfaces at module-load time (loud, deterministic), not at emit-time
 * (silent, action-at-a-distance).
 *
 * Exported only for the class-based variant — direct use from user code is
 * discouraged.
 */
export function registerWorkflow(workflow: Workflow): void {
  if (REGISTRY.has(workflow.id)) {
    throw new Error(
      `chorusWorkflow: duplicate workflow id "${workflow.id}" — two workflows registered with the same id. ` +
        `Each workflow needs a unique id; rename one of them or call clearRegistry() in test setup.`,
    );
  }
  // Defense in depth: parse with WorkflowSchema so a malformed registration
  // (missing trigger, malformed nodes) fails at registration time. The
  // builder always produces conforming JSON, but a bug in our code or a
  // user passing a hand-built Workflow object should fail loudly here.
  const parsed = WorkflowSchema.safeParse(workflow);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `chorusWorkflow: workflow "${workflow.id}" failed schema validation:\n${errors}`,
    );
  }
  REGISTRY.set(parsed.data.id, parsed.data);
}

// ── Step refs (input templating) ─────────────────────────────────────────────

/**
 * Returned by `$.step(...)`. Carries the step name and a `.ref` template
 * string that downstream steps can use to reference this step's output:
 *
 * ```ts
 * const a = $.step("fetch", { integration: "http-generic", ... });
 * const b = $.step("parse", {
 *   integration: "json", operation: "parse",
 *   inputs: { body: a.ref },   // ⇐ "{{fetch.output}}"
 * });
 * ```
 *
 * The template syntax matches chorus's existing input templating —
 * `{{<stepName>.<path>}}` is resolved by the executor against prior node
 * outputs. Default path is `output`. For more specific selection, build the
 * template string yourself: `\`{{${a.name}.body.items.0}}\``.
 */
export interface StepRef {
  /** The step name (also used as the JSON node id). */
  readonly name: string;
  /** Default output reference: `{{<name>.output}}`. */
  readonly ref: string;
}

// ── Builder context (`$`) ────────────────────────────────────────────────────

/**
 * Spec describing a single chorus Node. Mirrors `NodeSchema` but with
 * `id` derived from the step name (so users don't repeat themselves).
 */
export interface StepSpec {
  integration: string;
  operation: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    jitter?: boolean;
  };
  onError?: "fail" | "continue" | "retry";
  fallbacks?: Array<{
    integration: string;
    operation: string;
    config?: Record<string, unknown>;
  }>;
}

/**
 * The builder context passed to `chorusWorkflow`'s builder fn. Use `$.step`
 * to declare nodes; the order of calls becomes the workflow's node order
 * AND the connection order (each `$.step` after the first auto-connects
 * to the prior step). For non-linear DAGs, use `$.connect` to add edges
 * explicitly.
 */
export interface WorkflowBuilder {
  /**
   * Declare a step. Returns a `StepRef` whose `.ref` you can splice into
   * subsequent `inputs` to reference this step's output.
   *
   * Auto-connection: by default, each step after the first is connected
   * from the immediately-prior step. To suppress this, pass
   * `{ connect: false }` and use `$.connect` to wire explicitly.
   */
  step(name: string, spec: StepSpec, opts?: { connect?: boolean }): StepRef;

  /**
   * Add a connection between two declared steps. Use this for non-linear
   * DAGs (parallel branches, fan-in joins).
   *
   * The `when` argument is a Jexl expression evaluated against the source
   * step's output; an undefined `when` always traverses.
   */
  connect(from: string, to: string, when?: string): void;
}

class BuilderImpl implements WorkflowBuilder {
  readonly nodes: WorkflowNode[] = [];
  readonly connections: Connection[] = [];
  /** Last step name; for auto-chain on subsequent `step()` calls. */
  private lastStep: string | null = null;
  private readonly seenNames = new Set<string>();

  step(name: string, spec: StepSpec, opts?: { connect?: boolean }): StepRef {
    if (!name || typeof name !== "string") {
      throw new Error("chorusStep: step name must be a non-empty string");
    }
    if (this.seenNames.has(name)) {
      throw new Error(
        `chorusStep: duplicate step name "${name}" in this workflow — step names must be unique`,
      );
    }
    this.seenNames.add(name);

    const node: WorkflowNode = {
      id: name,
      integration: spec.integration,
      operation: spec.operation,
      config: spec.config ?? {},
      // inputs is optional in the schema; pass it through when present
      // (zod's preprocessor strips undefined keys, so `inputs: undefined`
      // becomes a missing key, which is exactly what we want).
      ...(spec.inputs !== undefined ? { inputs: spec.inputs } : {}),
      ...(spec.retry !== undefined
        ? {
            retry: {
              maxAttempts: spec.retry.maxAttempts,
              backoffMs: spec.retry.backoffMs,
              jitter: spec.retry.jitter ?? true,
            },
          }
        : {}),
      onError: spec.onError ?? "retry",
      ...(spec.fallbacks !== undefined
        ? {
            fallbacks: spec.fallbacks.map((fb) => ({
              integration: fb.integration,
              operation: fb.operation,
              config: fb.config ?? {},
            })),
          }
        : {}),
    };
    this.nodes.push(node);

    // Auto-chain unless the user opted out
    const shouldConnect = opts?.connect !== false;
    if (shouldConnect && this.lastStep !== null) {
      this.connections.push({ from: this.lastStep, to: name });
    }
    this.lastStep = name;

    return Object.freeze({
      name,
      ref: `{{${name}.output}}`,
    });
  }

  connect(from: string, to: string, when?: string): void {
    if (!this.seenNames.has(from)) {
      throw new Error(
        `chorusStep: $.connect called with unknown source step "${from}" — declare it with $.step first`,
      );
    }
    if (!this.seenNames.has(to)) {
      throw new Error(
        `chorusStep: $.connect called with unknown target step "${to}" — declare it with $.step first`,
      );
    }
    this.connections.push({ from, to, ...(when ? { when } : {}) });
  }
}

// ── Active-builder stack (for top-level chorusStep / chorusConnect) ──────────

const BUILDER_STACK: WorkflowBuilder[] = [];

function activeBuilder(): WorkflowBuilder {
  const top = BUILDER_STACK[BUILDER_STACK.length - 1];
  if (!top) {
    throw new Error(
      "chorusStep: no active workflow builder — call chorusStep only inside a chorusWorkflow(meta, builder) builder fn, or use $.step on the builder argument.",
    );
  }
  return top;
}

/**
 * Runs a builder fn with the given builder pushed as the active context.
 * Always pops in `finally` so a thrown error doesn't leak builder state
 * into subsequent calls.
 *
 * Internal helper — used to back `chorusWorkflow` and the class decorator.
 */
function runWithBuilder<T>(b: WorkflowBuilder, fn: () => T): T {
  BUILDER_STACK.push(b);
  try {
    return fn();
  } finally {
    BUILDER_STACK.pop();
  }
}

// ── Workflow metadata ────────────────────────────────────────────────────────

/**
 * Metadata for a workflow registration. The `trigger` accepts the full
 * Trigger discriminated union from `@delightfulchorus/core`, OR the string
 * shorthand `"manual"` for `{ type: "manual" }`.
 */
export interface ChorusWorkflowMeta {
  id: string;
  /** Optional human-readable name. Defaults to `id`. */
  name?: string;
  /** Optional version. Defaults to 1. */
  version?: number;
  /** Active flag — disabled workflows aren't picked up by the dispatcher. */
  active?: boolean;
  /**
   * Trigger spec. Accepts either the full Trigger object or the string
   * `"manual"` as shorthand. Cron + webhook always require the full
   * object form (they have required fields).
   */
  trigger: Trigger | "manual";
  /**
   * ISO timestamp for `createdAt`. Defaults to the current time when the
   * builder runs. Pinning this in source makes test fixtures stable.
   */
  createdAt?: string;
  /**
   * ISO timestamp for `updatedAt`. Defaults to `createdAt`.
   */
  updatedAt?: string;
}

function normalizeTrigger(t: Trigger | "manual"): Trigger {
  if (t === "manual") return { type: "manual" };
  return t;
}

// ── Primary HOF: chorusWorkflow ──────────────────────────────────────────────

/**
 * Register a chorus workflow into the module-scoped side-table.
 *
 * Returns the resulting Workflow JSON so callers can also use it inline
 * (e.g. for unit tests that don't go through `chorusEmitWorkflows`):
 *
 * ```ts
 * const transcribe = chorusWorkflow({ id: "transcribe", trigger: "manual" }, ($) => {
 *   const audio = $.step("fetch", { integration: "http-generic", operation: "request",
 *                                   config: { url: "{{trigger.audioUrl}}" } });
 *   const text = $.step("transcribe", { integration: "llm-openai", operation: "transcribe",
 *                                       inputs: { audio: audio.ref } });
 *   return text;
 * });
 * ```
 *
 * The builder is invoked synchronously at registration time. See the
 * "Limitations" section in this file's leading comment.
 */
export function chorusWorkflow(
  meta: ChorusWorkflowMeta,
  builder: (b: WorkflowBuilder) => StepRef | void,
): Workflow {
  const b = new BuilderImpl();
  // Push the builder onto the stack so top-level `chorusStep(...)` calls
  // resolve to it; pop in `finally` so a thrown error from user code
  // doesn't leave dangling state.
  runWithBuilder(b, () => {
    builder(b);
  });

  const now = new Date().toISOString();
  const workflow: Workflow = {
    id: meta.id,
    name: meta.name ?? meta.id,
    version: meta.version ?? 1,
    active: meta.active ?? true,
    trigger: normalizeTrigger(meta.trigger),
    nodes: b.nodes,
    connections: b.connections,
    createdAt: meta.createdAt ?? now,
    updatedAt: meta.updatedAt ?? meta.createdAt ?? now,
  };

  registerWorkflow(workflow);
  return workflow;
}

// ── Top-level helpers (alternative to $-based form) ──────────────────────────

/**
 * Top-level `chorusStep(name, spec)` for users who prefer the spec example's
 * top-level call style:
 *
 * ```ts
 * const transcribe = chorusWorkflow({ id: "transcribe", trigger: "manual" }, () => {
 *   const audio = chorusStep("fetch", { integration: "http-generic", operation: "request",
 *                                       config: { url: "{{trigger.audioUrl}}" } });
 *   const text = chorusStep("transcribe", { integration: "llm-openai", operation: "transcribe",
 *                                           inputs: { audio: audio.ref } });
 *   return text;
 * });
 * ```
 *
 * Internally this resolves the active builder context via a tiny module-level
 * stack — `chorusWorkflow` pushes onto the stack before invoking the builder,
 * pops in `finally`. Calls outside an active `chorusWorkflow` builder throw.
 *
 * Both styles (`$.step(...)` and `chorusStep(...)`) work identically; pick
 * whichever reads better in your codebase.
 */
export function chorusStep(
  name: string,
  spec: StepSpec,
  opts?: { connect?: boolean },
): StepRef {
  const active = activeBuilder();
  return active.step(name, spec, opts);
}

/**
 * Top-level `chorusConnect(from, to, when?)` — companion to top-level
 * `chorusStep`. Add explicit edges for non-linear DAGs.
 */
export function chorusConnect(from: string, to: string, when?: string): void {
  const active = activeBuilder();
  active.connect(from, to, when);
}

// ── Class-based decorator variant (TC39 Stage 3) ─────────────────────────────

/**
 * Internal augmentation: classes decorated with `@chorusStepDecl` accumulate
 * their step specs on the constructor as `__chorusSteps`.
 */
type ClassWithSteps = {
  __chorusSteps?: Array<[string, StepSpec]>;
};

/**
 * TC39 Stage 3 class decorator. Use this when you want literal `@`-prefix
 * authoring instead of the HOF form. The class is a namespace for steps
 * declared via `@chorusStepDecl` accessor decorators on its fields.
 *
 * Behavior: when the class definition is evaluated (at module load), the
 * decorator constructs a builder, walks each `@chorusStepDecl`-marked
 * field in declaration order, calls `$.step` for each, and registers the
 * resulting Workflow.
 *
 * The class IS instantiated once internally (at module-load time) so the
 * Stage 3 accessor initializers fire and populate `__chorusSteps`. Users
 * should not instantiate the class themselves.
 *
 * @example
 * ```ts
 * @chorusWorkflowClass({ id: "transcribe", trigger: { type: "manual" } })
 * class Transcribe {
 *   @chorusStepDecl({ integration: "http-generic", operation: "request",
 *                     config: { url: "{{trigger.audioUrl}}" } })
 *   accessor fetch!: StepRef;
 *
 *   @chorusStepDecl({ integration: "llm-openai", operation: "transcribe",
 *                     inputs: { audio: "{{fetch.output}}" } })
 *   accessor transcribe!: StepRef;
 * }
 * ```
 */
export function chorusWorkflowClass(meta: ChorusWorkflowMeta) {
  return function decorate<T extends abstract new (...args: never[]) => unknown>(
    target: T,
    _ctx: ClassDecoratorContext<T>,
  ): T {
    // Stage 3 accessor initializers fire when the class is instantiated.
    // We instantiate once with a no-op constructor argument list to drain
    // the initializers into __chorusSteps. The class's user-visible
    // constructor is otherwise never called at module-load time by the
    // decorator framework.
    //
    // If the class has a non-trivial constructor (e.g. requires args),
    // instantiation will throw — which is fine, because chorus workflow
    // classes are namespaces, not instances. Document this clearly.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, new-cap
      new (target as unknown as new () => unknown)();
    } catch (err) {
      throw new Error(
        `chorusWorkflowClass: failed to drain @chorusStepDecl initializers from class "${target.name}". ` +
          `Workflow classes must have a no-arg constructor (or no constructor at all) — they're namespaces, not instances. ` +
          `Underlying error: ${(err as Error).message}`,
      );
    }
    const stepSpecs = (target as unknown as ClassWithSteps).__chorusSteps;
    chorusWorkflow(
      { ...meta, id: meta.id ?? target.name },
      ($) => {
        if (stepSpecs) {
          for (const [name, spec] of stepSpecs) {
            $.step(name, spec);
          }
        }
      },
    );
    return target;
  };
}

// ── Build-time emitter (chorus emit-workflows) ───────────────────────────────

/**
 * Options for `emitWorkflows` — the build-time helper that drains the
 * registry and writes one JSON file per workflow.
 */
export interface EmitWorkflowsOptions {
  /**
   * Files to import. Each file's `import()` side-effects (i.e. its
   * `chorusWorkflow(...)` calls at module load) populate the registry.
   *
   * Resolved relative to `cwd`. Absolute paths are supported and used
   * verbatim. Files MUST exist; missing files throw.
   *
   * For "glob" support, the CLI subcommand expands a glob pattern into
   * a file list and passes it here.
   */
  files: string[];
  /**
   * Output directory for emitted JSON files. Defaults to
   * `<cwd>/chorus/workflows`. Created (recursively) if missing.
   */
  outDir?: string;
  /** Process cwd. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * If true, the registry is cleared BEFORE imports. Default `true` —
   * gives a clean slate per emit run. Set to `false` if you want to
   * accumulate registrations from multiple emit calls (rare).
   */
  clearBefore?: boolean;
  /**
   * Indent for JSON output. Defaults to 2 (matches `chorus compose`'s
   * style). Pass 0 for minified output.
   */
  jsonIndent?: number;
  /** Suppress console output. Tests set this to true. */
  silent?: boolean;
  /**
   * Optional file-loader override for tests. Defaults to native dynamic
   * `import()`. Tests pass a stub that lets them inject workflows
   * synchronously without spinning up tsx.
   */
  loadFile?: (absPath: string) => Promise<void>;
}

export interface EmittedWorkflow {
  /** Absolute path of the emitted JSON file. */
  filePath: string;
  /** Workflow id (also the JSON file's basename). */
  id: string;
}

export interface EmitWorkflowsResult {
  /** Files imported. */
  importedFiles: string[];
  /** Workflows emitted, in registry insertion order. */
  emitted: EmittedWorkflow[];
  /** outDir actually used (resolved against cwd). */
  outDir: string;
}

/**
 * Build-time helper. Imports each file in `opts.files` (so its
 * `chorusWorkflow(...)` registrations fire), drains the registry, and
 * writes one `<id>.json` per workflow into `opts.outDir`.
 *
 * Imports use native dynamic `import()`. If your `.ts` source files need
 * a TypeScript loader (most projects do), invoke this from a context
 * where `tsx` or `ts-node` is on the loader chain — e.g. via the
 * `chorus emit-workflows` CLI subcommand which boots through tsx.
 *
 * For `.js` / `.mjs` files this works without any loader.
 *
 * Symlink + path semantics: `import()` accepts a `file://` URL OR a
 * bare module specifier. We always wrap absolute paths in `pathToFileURL`
 * so Windows backslashes don't trip ESM resolution.
 *
 * Idempotency: when `clearBefore` is true (the default), the registry is
 * reset before imports so a second invocation in the same process gives
 * the same result as a first invocation.
 */
export async function emitWorkflows(
  opts: EmitWorkflowsOptions,
): Promise<EmitWorkflowsResult> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const cwd = opts.cwd ?? process.cwd();
  const outDir = opts.outDir
    ? path.isAbsolute(opts.outDir)
      ? opts.outDir
      : path.join(cwd, opts.outDir)
    : path.join(cwd, "chorus", "workflows");
  const indent = opts.jsonIndent ?? 2;
  const silent = opts.silent ?? false;
  const clearBefore = opts.clearBefore ?? true;

  if (!Array.isArray(opts.files) || opts.files.length === 0) {
    throw new Error(
      "emitWorkflows: no files supplied — pass at least one .ts/.js/.mjs file in opts.files",
    );
  }

  if (clearBefore) {
    clearRegistry();
  }

  const loadFile =
    opts.loadFile ??
    (async (absPath: string) => {
      // Native dynamic import. Wrap in pathToFileURL so Windows path
      // separators don't break ESM resolution. Add a cache-buster query
      // string so a second emitWorkflows call in the same process re-runs
      // the module's top-level (otherwise the registry would stay empty
      // because the module was cached on first import).
      const url = `${pathToFileURL(absPath).href}?ts=${Date.now()}`;
      await import(url);
    });

  const importedFiles: string[] = [];
  for (const f of opts.files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
    await loadFile(abs);
    importedFiles.push(abs);
  }

  const workflows = getRegisteredWorkflows();
  if (workflows.length === 0) {
    if (!silent) {
      const stderr = process.stderr.write.bind(process.stderr);
      stderr(
        `emitWorkflows: imported ${importedFiles.length} file(s), but no workflows were registered. ` +
          `Make sure each file calls chorusWorkflow(...) at module top level.\n`,
      );
    }
    return { importedFiles, emitted: [], outDir };
  }

  await mkdir(outDir, { recursive: true });

  const emitted: EmittedWorkflow[] = [];
  for (const wf of workflows) {
    const filePath = path.join(outDir, `${wf.id}.json`);
    const content = JSON.stringify(wf, null, indent) + "\n";
    await writeFile(filePath, content, "utf8");
    emitted.push({ filePath, id: wf.id });
  }

  if (!silent) {
    const stdout = process.stdout.write.bind(process.stdout);
    stdout(
      `emitWorkflows: wrote ${emitted.length} workflow(s) to ${outDir}\n`,
    );
    for (const e of emitted) {
      stdout(`  ${e.id} -> ${e.filePath}\n`);
    }
  }

  return { importedFiles, emitted, outDir };
}

// ── Class-based @-decorator variant continued ────────────────────────────────

/**
 * TC39 Stage 3 class field decorator (auto-accessor form). Marks an accessor
 * field as a chorus step. The class decorator (`@chorusWorkflowClass`)
 * collects all marked fields and registers them in declaration order.
 *
 * Why auto-accessor form: TC39 Stage 3 doesn't support method decorators
 * on regular methods in a way that captures the field name AND ordering
 * cleanly. Auto-accessors get a stable `addInitializer` hook and a name
 * via the context. We use this hook to push the field's name into a
 * class-scoped step list that the class decorator drains.
 *
 * The accessor's runtime value is never used — the class is just a
 * namespace. We assign a placeholder StepRef so destructured access in
 * tests doesn't crash.
 */
export function chorusStepDecl(spec: StepSpec) {
  return function decorate<This, Value>(
    _target: ClassAccessorDecoratorTarget<This, Value>,
    ctx: ClassAccessorDecoratorContext<This, Value>,
  ): ClassAccessorDecoratorResult<This, Value> {
    const fieldName = String(ctx.name);
    ctx.addInitializer(function (this: This) {
      // Attach to the constructor (the class), not the instance — the
      // class decorator drains this list at module-load time.
      const ctor = (this as { constructor: ClassWithSteps }).constructor;
      ctor.__chorusSteps ??= [];
      // Avoid duplicate appends if the class is instantiated multiple
      // times.
      const existing = ctor.__chorusSteps.find((entry) => entry[0] === fieldName);
      if (!existing) {
        ctor.__chorusSteps.push([fieldName, spec]);
      }
    });
    return {
      get(): Value {
        return Object.freeze({
          name: fieldName,
          ref: `{{${fieldName}.output}}`,
        }) as unknown as Value;
      },
      set(_value: Value) {
        // No-op: chorus steps are not mutable from instance code.
      },
    };
  };
}
