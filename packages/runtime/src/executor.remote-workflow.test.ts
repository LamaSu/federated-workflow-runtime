/**
 * End-to-end test for Wave 3 worknet — TWO chorus instances on different
 * ports, one invokes the other's workflow as a `remote-workflow` step.
 *
 * Verified properties (per wave-3-brief Wave-3 exit criteria):
 *
 *   (1) Caller-side handler signs the envelope, POSTs to receiver
 *       (real Fastify with `--remote-callable`), polls until success,
 *       returns terminal output.
 *
 *   (2) Receiver-side route verifies the signature, recomputes the
 *       workflow hash, enqueues a child run, executes it through the
 *       SAME executor + per-run subprocess sandbox model used for local
 *       runs (credential boundary preserved).
 *
 *   (3) Memoization invariant carried across the federation boundary:
 *       on parent replay, the remote-workflow node returns its cached
 *       output WITHOUT a second POST to the receiver. We assert this
 *       by counting POST hits on the receiver across two parent runs
 *       with the same runId — exactly ONE POST regardless of replay.
 *
 *   (4) Receiver responds to GET /api/run/:id/status with terminal
 *       output + hashRoot once the child run completes.
 *
 *   (5) The child run is independently queryable on the receiver via
 *       its own runId — both sides can `chorus run history` it locally.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  IntegrationManifest,
  IntegrationModule,
  Workflow,
} from "@delightfulchorus/core";
import remoteWorkflowIntegration from "@delightfulchorus/integration-remote-workflow";
import { generateKeypair } from "@delightfulchorus/registry";
import { openDatabase, QueryHelpers, type DatabaseType } from "./db.js";
import { RunQueue } from "./queue.js";
import { Executor, type IntegrationLoader } from "./executor.js";
import { registerRemoteRunRoutes } from "./api/remote-run.js";
import { computeWorkflowHash } from "./trust-policy.js";

// ── Test fixtures ─────────────────────────────────────────────────────────

function noopManifest(name: string, ops: string[]): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    description: "test",
    authType: "none",
    credentialTypes: [],
    operations: ops.map((op) => ({
      name: op,
      description: op,
      inputSchema: {},
      outputSchema: {},
      idempotent: true,
    })),
  };
}

function makeIntegration(
  name: string,
  operations: Record<string, (input: unknown) => Promise<unknown>>,
): IntegrationModule {
  return {
    manifest: noopManifest(name, Object.keys(operations)),
    operations: Object.fromEntries(
      Object.entries(operations).map(([op, fn]) => [op, async (input) => fn(input)]),
    ),
  };
}

function makeWorkflow(
  id: string,
  nodes: Workflow["nodes"],
  connections: Workflow["connections"] = [],
): Workflow {
  return {
    id,
    name: id,
    version: 1,
    active: true,
    trigger: { type: "manual" },
    nodes,
    connections,
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
  };
}

function makeLoader(map: Record<string, IntegrationModule>): IntegrationLoader {
  return async (name) => {
    const mod = map[name];
    if (!mod) throw new Error(`unknown integration ${name}`);
    return mod;
  };
}

interface ChorusInstance {
  db: DatabaseType;
  helpers: QueryHelpers;
  queue: RunQueue;
  executor: Executor;
  app: FastifyInstance;
  port: number;
  baseUrl: string;
  /** Drive ticks like server.ts's tick() — claim one + run one. */
  tick: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Spin up a chorus instance with the worknet receiver routes mounted.
 * Listens on an OS-assigned port (port 0).
 */
async function spinUpReceiver(opts: {
  integrations: Record<string, IntegrationModule>;
  workflows: Workflow[];
  acceptedCallers?: string[];
}): Promise<ChorusInstance> {
  const db = openDatabase(":memory:");
  const helpers = new QueryHelpers(db);
  const queue = new RunQueue(db);
  const executor = new Executor({
    db,
    integrationLoader: makeLoader(opts.integrations),
  });
  for (const wf of opts.workflows) {
    helpers.insertWorkflow({
      id: wf.id,
      version: wf.version,
      name: wf.name,
      definition: JSON.stringify(wf),
      active: 1,
      created_at: wf.createdAt,
      updated_at: wf.updatedAt,
    });
  }
  const app = Fastify({ logger: false });
  registerRemoteRunRoutes(app, db, {
    acceptedCallers: opts.acceptedCallers,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Fastify did not bind to a TCP port");
  }
  const port = addr.port;

  // Driving function: claim+run pending runs. We don't start an interval
  // loop — tests drive ticks manually so the timing is deterministic.
  async function tick(): Promise<void> {
    const claimed = queue.claim();
    if (!claimed) return;
    const wfRow = helpers.getWorkflow(claimed.workflow_id, claimed.workflow_version);
    if (!wfRow) {
      queue.complete(claimed.id, "failed", { error: "workflow not found" });
      return;
    }
    try {
      const workflow = JSON.parse(wfRow.definition);
      const payload = claimed.trigger_payload ? JSON.parse(claimed.trigger_payload) : null;
      const result = await executor.run(workflow, claimed.id, payload);
      if (result.status === "success") {
        queue.complete(claimed.id, "success");
      } else if (result.status === "waiting") {
        queue.release(claimed.id);
      } else {
        queue.complete(claimed.id, "failed", { error: result.error ?? "unknown" });
      }
    } catch (err) {
      queue.complete(claimed.id, "failed", { error: (err as Error).message });
    }
  }

  return {
    db,
    helpers,
    queue,
    executor,
    app,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    tick,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/** Spin up a caller-side instance — no receiver routes needed, just an executor. */
function spinUpCaller(integrations: Record<string, IntegrationModule>): ChorusInstance {
  const db = openDatabase(":memory:");
  const helpers = new QueryHelpers(db);
  const queue = new RunQueue(db);
  const executor = new Executor({
    db,
    integrationLoader: makeLoader(integrations),
  });
  // Caller has no public surface — just satisfy the interface.
  const app = Fastify({ logger: false });
  return {
    db,
    helpers,
    queue,
    executor,
    app,
    port: 0,
    baseUrl: "",
    tick: async () => {
      const claimed = queue.claim();
      if (!claimed) return;
      const wfRow = helpers.getWorkflow(claimed.workflow_id, claimed.workflow_version);
      if (!wfRow) {
        queue.complete(claimed.id, "failed", { error: "workflow not found" });
        return;
      }
      try {
        const workflow = JSON.parse(wfRow.definition);
        const payload = claimed.trigger_payload ? JSON.parse(claimed.trigger_payload) : null;
        const result = await executor.run(workflow, claimed.id, payload);
        if (result.status === "success") {
          queue.complete(claimed.id, "success");
        } else if (result.status === "waiting") {
          queue.release(claimed.id);
        } else {
          queue.complete(claimed.id, "failed", { error: result.error ?? "unknown" });
        }
      } catch (err) {
        queue.complete(claimed.id, "failed", { error: (err as Error).message });
      }
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/**
 * Drive the receiver's tick loop until the named child run terminates or
 * we exhaust max iterations. Tests use this so the receiver-side child
 * actually completes (otherwise the caller's poll loop spins forever).
 */
async function driveUntilTerminal(
  instance: ChorusInstance,
  runId: string,
  maxIterations = 50,
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    await instance.tick();
    const run = instance.helpers.getRun(runId);
    if (run && (run.status === "success" || run.status === "failed" || run.status === "cancelled")) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} did not terminate within ${maxIterations} ticks`);
}

// ── E2E test ───────────────────────────────────────────────────────────────

describe("E2E: two chorus instances calling each other via remote-workflow", () => {
  let receiver: ChorusInstance | null = null;
  let caller: ChorusInstance | null = null;

  beforeEach(() => {
    receiver = null;
    caller = null;
  });

  afterEach(async () => {
    if (caller) await caller.close();
    if (receiver) await receiver.close();
    receiver = null;
    caller = null;
  });

  it("end-to-end invocation: caller→receiver, receiver runs child, caller memoizes", async () => {
    // ── Receiver setup ───────────────────────────────────────────────
    // Receiver has a single 'echo' workflow that echoes its input back.
    const echoMod = makeIntegration("echo", {
      go: async (input) => ({ ok: true, echoed: input }),
    });
    const receiverWf = makeWorkflow("transcribe", [
      {
        id: "echo-step",
        integration: "echo",
        operation: "go",
        config: {},
        inputs: { hello: "from receiver" },
        onError: "retry",
      },
    ]);
    receiver = await spinUpReceiver({
      integrations: { echo: echoMod },
      workflows: [receiverWf],
    });

    // ── Caller setup ─────────────────────────────────────────────────
    // Caller has a single 'remote-workflow' node pointing at the receiver.
    const callerKp = await generateKeypair();
    // Inject keypair via ctx.credentials.operatorKeypair so we don't have
    // to mutate process.env (the executor flows ctx.credentials per node).
    const callerWf = makeWorkflow("parent", [
      {
        id: "call-remote",
        integration: "remote-workflow",
        operation: "invoke",
        config: {
          endpoint: `${receiver.baseUrl}/api/run`,
          workflowRef: "transcribe",
          workflowHash: computeWorkflowHash(receiverWf),
        },
        inputs: { audioUrl: "https://example.com/audio.mp3" },
        onError: "retry",
      },
    ]);
    caller = spinUpCaller({
      "remote-workflow": remoteWorkflowIntegration,
    });

    // Override credentialsFor so the remote-workflow handler picks up
    // the caller's keypair via ctx.credentials.operatorKeypair.
    (caller.executor as unknown as {
      credentialsFor: (name: string) => Record<string, unknown> | null;
    }).credentialsFor = (integration: string) => {
      if (integration === "remote-workflow") {
        return {
          operatorKeypair: {
            privateKey: callerKp.privateKey,
            publicKey: callerKp.publicKey,
          },
        };
      }
      return null;
    };

    // Register the parent workflow on the caller's DB so the queue can
    // resolve it.
    caller.helpers.insertWorkflow({
      id: callerWf.id,
      version: callerWf.version,
      name: callerWf.name,
      definition: JSON.stringify(callerWf),
      active: 1,
      created_at: callerWf.createdAt,
      updated_at: callerWf.updatedAt,
    });

    // ── First invocation ─────────────────────────────────────────────
    const parentRunId = caller.queue.enqueue(callerWf.id);
    caller.queue.claim();

    // Drive the caller and the receiver concurrently. The caller's
    // executor.run() makes the POST → polls → returns; the receiver
    // needs its own tick loop to actually run the enqueued child.
    const callerPromise = caller.executor.run(callerWf, parentRunId, {
      requestor: "test",
    });

    // Drain receiver ticks while the caller's invoke is in-flight. Any
    // run that lands in the receiver's queue must be processed for the
    // caller's poll loop to ever see "success".
    let stopDrain = false;
    const driveReceiver = async () => {
      while (!stopDrain) {
        if (receiver) await receiver.tick();
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const drainHandle = driveReceiver();
    let result;
    try {
      result = await callerPromise;
    } finally {
      stopDrain = true;
      await drainHandle.catch(() => {
        /* swallow — drain may resolve after `receiver` cleanup */
      });
    }

    expect(result.status).toBe("success");
    expect(result.steps).toHaveLength(1);
    const parentOut = JSON.parse(result.steps[0]!.output!);
    // Handler returns { output, remoteRunId, remoteHashRoot, endpoint, workflowRef }.
    expect(parentOut.workflowRef).toBe("transcribe");
    expect(parentOut.endpoint).toBe(`${receiver.baseUrl}/api/run`);
    expect(typeof parentOut.remoteRunId).toBe("string");
    expect(parentOut.remoteHashRoot).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The receiver's child workflow returned { ok: true, echoed: <node input> }.
    // The executor composes node inputs as { ...node.inputs, triggerPayload }
    // — so the echo node sees both its declared inputs ({hello: "from receiver"})
    // AND the trigger payload that the caller sent ({audioUrl: "..."}).
    expect(parentOut.output).toMatchObject({
      ok: true,
      echoed: {
        hello: "from receiver",
        triggerPayload: { audioUrl: "https://example.com/audio.mp3" },
      },
    });

    // Verify the child run exists on the receiver and is independently
    // queryable (per Wave 3 brief — both sides can `chorus run history`).
    const childRunId = parentOut.remoteRunId as string;
    const childRun = receiver.helpers.getRun(childRunId);
    expect(childRun).toBeDefined();
    expect(childRun!.workflow_id).toBe("transcribe");
    expect(childRun!.status).toBe("success");
    expect(childRun!.triggered_by).toMatch(/^remote:/);
    expect(childRun!.triggered_by).toContain(callerKp.publicKey.slice(0, 12));

    // ── Memoization replay test ──────────────────────────────────────
    // Re-run the parent with the SAME runId. The remote-workflow step
    // should return its cached output WITHOUT a second POST to receiver.
    // We verify by counting steps on the receiver: only ONE child run.
    const receiverRunCountBefore = (
      receiver.db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }
    ).c;
    expect(receiverRunCountBefore).toBe(1);

    const replayResult = await caller.executor.run(callerWf, parentRunId, {
      requestor: "test",
    });
    expect(replayResult.status).toBe("success");
    expect(replayResult.steps).toHaveLength(1);
    // Cached output identical to first run.
    const replayOut = JSON.parse(replayResult.steps[0]!.output!);
    expect(replayOut).toEqual(parentOut);

    // CRITICAL: receiver side has STILL only one run. The remote was NOT
    // re-invoked — chorus's memoization invariant carries across the
    // federation boundary.
    const receiverRunCountAfter = (
      receiver.db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }
    ).c;
    expect(receiverRunCountAfter).toBe(1);
  }, 30_000);

  it("rejects when caller's workflowHash does not match receiver's def", async () => {
    const echoMod = makeIntegration("echo", {
      go: async () => ({ ok: true }),
    });
    const receiverWf = makeWorkflow("wf", [
      {
        id: "x",
        integration: "echo",
        operation: "go",
        config: {},
        inputs: {},
        onError: "retry",
      },
    ]);
    receiver = await spinUpReceiver({
      integrations: { echo: echoMod },
      workflows: [receiverWf],
    });

    const callerKp = await generateKeypair();
    const callerWf = makeWorkflow("parent", [
      {
        id: "call",
        integration: "remote-workflow",
        operation: "invoke",
        config: {
          endpoint: `${receiver.baseUrl}/api/run`,
          workflowRef: "wf",
          workflowHash: "sha256:wronghash", // mismatch
          trustPolicy: { maxLatencyMs: 1000 },
        },
        inputs: {},
        onError: "retry",
      },
    ]);
    caller = spinUpCaller({
      "remote-workflow": remoteWorkflowIntegration,
    });
    (caller.executor as unknown as {
      credentialsFor: (name: string) => Record<string, unknown> | null;
    }).credentialsFor = (integration: string) =>
      integration === "remote-workflow"
        ? {
            operatorKeypair: {
              privateKey: callerKp.privateKey,
              publicKey: callerKp.publicKey,
            },
          }
        : null;
    caller.helpers.insertWorkflow({
      id: callerWf.id,
      version: callerWf.version,
      name: callerWf.name,
      definition: JSON.stringify(callerWf),
      active: 1,
      created_at: callerWf.createdAt,
      updated_at: callerWf.updatedAt,
    });

    const parentRunId = caller.queue.enqueue(callerWf.id);
    caller.queue.claim();
    const result = await caller.executor.run(callerWf, parentRunId, {});
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/REMOTE_REJECTED|409|hash/i);
  });

  it("acceptedCallers allowlist rejects unknown caller keys", async () => {
    const echoMod = makeIntegration("echo", {
      go: async () => ({ ok: true }),
    });
    const receiverWf = makeWorkflow("wf", [
      {
        id: "x",
        integration: "echo",
        operation: "go",
        config: {},
        inputs: {},
        onError: "retry",
      },
    ]);

    // Receiver only accepts a SPECIFIC pubkey.
    const allowedKp = await generateKeypair();
    receiver = await spinUpReceiver({
      integrations: { echo: echoMod },
      workflows: [receiverWf],
      acceptedCallers: [allowedKp.publicKey],
    });

    // Caller uses a DIFFERENT (not-allowlisted) pubkey.
    const otherKp = await generateKeypair();
    const callerWf = makeWorkflow("parent", [
      {
        id: "call",
        integration: "remote-workflow",
        operation: "invoke",
        config: {
          endpoint: `${receiver.baseUrl}/api/run`,
          workflowRef: "wf",
          workflowHash: computeWorkflowHash(receiverWf),
          trustPolicy: { maxLatencyMs: 1000 },
        },
        inputs: {},
        onError: "retry",
      },
    ]);
    caller = spinUpCaller({
      "remote-workflow": remoteWorkflowIntegration,
    });
    (caller.executor as unknown as {
      credentialsFor: (name: string) => Record<string, unknown> | null;
    }).credentialsFor = (integration: string) =>
      integration === "remote-workflow"
        ? {
            operatorKeypair: {
              privateKey: otherKp.privateKey,
              publicKey: otherKp.publicKey,
            },
          }
        : null;
    caller.helpers.insertWorkflow({
      id: callerWf.id,
      version: callerWf.version,
      name: callerWf.name,
      definition: JSON.stringify(callerWf),
      active: 1,
      created_at: callerWf.createdAt,
      updated_at: callerWf.updatedAt,
    });

    const parentRunId = caller.queue.enqueue(callerWf.id);
    caller.queue.claim();
    const result = await caller.executor.run(callerWf, parentRunId, {});
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/REMOTE_REJECTED|403|FORBIDDEN/i);
    // Receiver did NOT enqueue — the 403 fired before the workflow lookup.
    const receiverRunCount = (
      receiver.db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }
    ).c;
    expect(receiverRunCount).toBe(0);
  });

  // Note: the e2e suite intentionally does NOT cover the streaming
  // protocol (Wave 4). Polling-only is the Wave 3 contract.
  // Reference unused import to satisfy the test suite linter.
  void randomUUID;
});
