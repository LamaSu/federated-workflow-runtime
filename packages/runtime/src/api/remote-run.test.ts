/**
 * Tests for the worknet receiver routes (POST /api/run + GET /api/run/:id/status).
 *
 * Coverage goals:
 *   - 422 on malformed body
 *   - 403 when acceptedCallers set + caller not in list
 *   - 404 when workflowRef not found locally
 *   - 409 when workflowHash mismatches local definition
 *   - 401 with code from validateCall on bad signature / skew / pin issues
 *   - 200 + remoteRunId on happy path; verify trigger_payload + triggered_by
 *     stored correctly
 *   - GET /status returns {status, output, hashRoot} for terminal runs
 *   - GET /status returns {status: "running", output: null} mid-run
 *   - GET /status 404 for unknown runId
 *   - acceptedCallers with empty list = no restriction
 *   - workflowRef with @version suffix resolves correctly
 *   - reputation gate: with lookup wired, calls below floor are 401
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { generateKeypair } from "@delightfulchorus/registry";
import { openDatabase, type DatabaseType } from "../db.js";
import { QueryHelpers } from "../db.js";
import { registerRemoteRunRoutes, computeStepsHashRoot } from "./remote-run.js";
import {
  computeWorkflowHash,
  signCallEnvelope,
  type CallEnvelope,
  type CallerIdentity,
} from "../trust-policy.js";

// ── Helpers ────────────────────────────────────────────────────────────────

interface TestHarness {
  app: FastifyInstance;
  db: DatabaseType;
  helpers: QueryHelpers;
  insertWorkflow: (id: string, definition: Record<string, unknown>, version?: number) => string;
}

function makeHarness(opts: {
  acceptedCallers?: string[];
  getOperatorReputation?: (pubkey: string) => number | undefined;
} = {}): TestHarness {
  const db = openDatabase(":memory:");
  const helpers = new QueryHelpers(db);
  const app = Fastify({ logger: false });
  registerRemoteRunRoutes(app, db, {
    acceptedCallers: opts.acceptedCallers,
    getOperatorReputation: opts.getOperatorReputation,
  });
  return {
    app,
    db,
    helpers,
    insertWorkflow: (id: string, definition: Record<string, unknown>, version = 1) => {
      const now = new Date().toISOString();
      helpers.insertWorkflow({
        id,
        version,
        name: id,
        definition: JSON.stringify(definition),
        active: 1,
        created_at: now,
        updated_at: now,
      });
      return computeWorkflowHash(definition);
    },
  };
}

async function buildSignedCall(opts: {
  workflowRef: string;
  workflowHash: string;
  input?: unknown;
  privateKey?: string;
  publicKey?: string;
  oidcIssuer?: string;
  timestamp?: number;
}): Promise<{
  body: Record<string, unknown>;
  identity: CallerIdentity;
  publicKey: string;
  privateKey: string;
}> {
  let priv = opts.privateKey;
  let pub = opts.publicKey;
  if (!priv || !pub) {
    const kp = await generateKeypair();
    priv = kp.privateKey;
    pub = kp.publicKey;
  }
  const timestamp = opts.timestamp ?? Date.now();
  const nonce = randomUUID();
  const envelope: CallEnvelope = {
    workflowRef: opts.workflowRef,
    workflowHash: opts.workflowHash,
    input: opts.input ?? null,
    timestamp,
    nonce,
  };
  const sig = signCallEnvelope(envelope, priv);
  const identity: CallerIdentity = {
    signature: sig,
    publicKey: pub,
    timestamp,
    nonce,
    ...(opts.oidcIssuer ? { oidcIssuer: opts.oidcIssuer } : {}),
  };
  const body = {
    workflowRef: opts.workflowRef,
    workflowHash: opts.workflowHash,
    input: opts.input ?? null,
    callerIdentity: identity,
  };
  return { body, identity, publicKey: pub, privateKey: priv };
}

// ── POST /api/run ─────────────────────────────────────────────────────────

describe("POST /api/run — request validation", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("rejects 422 on malformed body", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: { wrong: "shape" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "BAD_REQUEST" });
  });

  it("rejects 422 when callerIdentity is missing fields", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: {
        workflowRef: "wf",
        workflowHash: "sha256:abc",
        callerIdentity: { signature: "x" }, // missing publicKey/timestamp/nonce
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /api/run — acceptedCallers gate", () => {
  let h: TestHarness;
  let ownerKp: { privateKey: string; publicKey: string };
  beforeEach(async () => {
    ownerKp = await generateKeypair();
    h = makeHarness({ acceptedCallers: [ownerKp.publicKey] });
    h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("rejects 403 when caller not in acceptedCallers", async () => {
    const otherKp = await generateKeypair();
    const wfHash = computeWorkflowHash({ id: "wf", nodes: [], connections: [] });
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      privateKey: otherKp.privateKey,
      publicKey: otherKp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "FORBIDDEN" });
  });

  it("accepts 200 when caller IS in acceptedCallers", async () => {
    const wfHash = computeWorkflowHash({ id: "wf", nodes: [], connections: [] });
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      privateKey: ownerKp.privateKey,
      publicKey: ownerKp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ remoteRunId: expect.any(String) });
  });
});

describe("POST /api/run — workflow resolution", () => {
  let h: TestHarness;
  let kp: { privateKey: string; publicKey: string };
  beforeEach(async () => {
    kp = await generateKeypair();
    h = makeHarness();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("rejects 404 when workflowRef not found", async () => {
    const { body } = await buildSignedCall({
      workflowRef: "nonexistent",
      workflowHash: "sha256:abc",
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "WORKFLOW_NOT_FOUND" });
  });

  it("rejects 409 when workflowHash mismatches", async () => {
    h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: "sha256:wronghash",
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(409);
    const j = res.json();
    expect(j).toMatchObject({ error: "HASH_MISMATCH" });
    expect(j.localHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(j.callerHash).toBe("sha256:wronghash");
  });

  it("resolves @version suffix correctly", async () => {
    const def = { id: "wf", nodes: [], connections: [] };
    h.insertWorkflow("wf", def, 1);
    h.insertWorkflow("wf", { ...def, name: "v2" }, 2);
    const wfHash2 = computeWorkflowHash({ ...def, name: "v2" });

    const { body } = await buildSignedCall({
      workflowRef: "wf@2",
      workflowHash: wfHash2,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it("resolves @v3 (v-prefix) suffix correctly", async () => {
    const def3 = { id: "wf", nodes: [], connections: [], name: "v3" };
    h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] }, 1);
    h.insertWorkflow("wf", def3, 3);
    const wfHash3 = computeWorkflowHash(def3);

    const { body } = await buildSignedCall({
      workflowRef: "wf@v3",
      workflowHash: wfHash3,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/run — trust validation (delegates to validateCall)", () => {
  let h: TestHarness;
  let kp: { privateKey: string; publicKey: string };
  let wfHash: string;
  beforeEach(async () => {
    kp = await generateKeypair();
    h = makeHarness();
    wfHash = h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("rejects 401 with BAD_SIGNATURE on tampered envelope", async () => {
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      input: { foo: "original" },
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    // Tamper the input post-signing.
    body.input = { foo: "tampered" };
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHORIZED", code: "BAD_SIGNATURE" });
  });

  it("rejects 401 with TIMESTAMP_SKEW for stale timestamps", async () => {
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      timestamp: Date.now() - 1000 * 60 * 60, // 1h ago
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "TIMESTAMP_SKEW" });
  });
});

describe("POST /api/run — happy path persistence", () => {
  let h: TestHarness;
  let kp: { privateKey: string; publicKey: string };
  let wfHash: string;
  beforeEach(async () => {
    kp = await generateKeypair();
    h = makeHarness();
    wfHash = h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns 200 + remoteRunId; queue row has triggered_by tagged", async () => {
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      input: { hello: "world" },
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const remoteRunId = res.json().remoteRunId as string;

    const run = h.helpers.getRun(remoteRunId);
    expect(run).toBeDefined();
    expect(run!.workflow_id).toBe("wf");
    expect(run!.status).toBe("pending");
    expect(run!.triggered_by).toMatch(/^remote:/);
    expect(run!.triggered_by).toContain(kp.publicKey.slice(0, 12));
    expect(JSON.parse(run!.trigger_payload!)).toEqual({ hello: "world" });
  });
});

describe("POST /api/run — reputation gate", () => {
  let h: TestHarness;
  let kp: { privateKey: string; publicKey: string };
  let wfHash: string;
  beforeEach(async () => {
    kp = await generateKeypair();
  });
  afterEach(async () => {
    if (h) {
      await h.app.close();
      h.db.close();
    }
  });

  it("rejects 401 when caller's trustPolicy.minReputation > lookup result", async () => {
    h = makeHarness({
      getOperatorReputation: () => 50,
    });
    wfHash = h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    body.trustPolicy = { minReputation: 1000 };
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "REPUTATION_BELOW_THRESHOLD" });
  });

  it("rejects 401 when minReputation set but no lookup wired (fail-closed)", async () => {
    h = makeHarness();
    wfHash = h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    body.trustPolicy = { minReputation: 100 };
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "REPUTATION_UNAVAILABLE" });
  });

  it("accepts 200 when reputation meets floor", async () => {
    h = makeHarness({ getOperatorReputation: () => 1500 });
    wfHash = h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const { body } = await buildSignedCall({
      workflowRef: "wf",
      workflowHash: wfHash,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    body.trustPolicy = { minReputation: 1000 };
    const res = await h.app.inject({
      method: "POST",
      url: "/api/run",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── GET /api/run/:id/status ───────────────────────────────────────────────

describe("GET /api/run/:id/status", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns 404 for unknown runId", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/run/no-such-id/status",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "RUN_NOT_FOUND" });
  });

  it("returns running status for in-flight runs", async () => {
    h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const runId = randomUUID();
    const now = new Date().toISOString();
    h.helpers.insertRun({
      id: runId,
      workflow_id: "wf",
      workflow_version: 1,
      status: "running",
      triggered_by: "test",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: now,
      finished_at: null,
      error: null,
      attempt: 1,
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/run/${runId}/status`,
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.status).toBe("running");
    expect(j.output).toBeNull();
    expect(j.hashRoot).toBe("");
  });

  it("returns terminal output + hashRoot for successful runs", async () => {
    h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const runId = randomUUID();
    const now = new Date().toISOString();
    h.helpers.insertRun({
      id: runId,
      workflow_id: "wf",
      workflow_version: 1,
      status: "success",
      triggered_by: "test",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: now,
      finished_at: now,
      error: null,
      attempt: 1,
    });
    h.helpers.upsertStep({
      run_id: runId,
      step_name: "node1",
      attempt: 1,
      status: "success",
      input: null,
      output: JSON.stringify({ hello: "world" }),
      error: null,
      error_sig_hash: null,
      started_at: now,
      finished_at: now,
      duration_ms: 0,
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/run/${runId}/status`,
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.status).toBe("success");
    expect(j.output).toEqual({ hello: "world" });
    expect(j.hashRoot).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns failed + error for failed runs", async () => {
    h.insertWorkflow("wf", { id: "wf", nodes: [], connections: [] });
    const runId = randomUUID();
    const now = new Date().toISOString();
    h.helpers.insertRun({
      id: runId,
      workflow_id: "wf",
      workflow_version: 1,
      status: "failed",
      triggered_by: "test",
      trigger_payload: null,
      priority: 0,
      next_wakeup: null,
      visibility_until: null,
      started_at: now,
      finished_at: now,
      error: "downstream broke",
      attempt: 1,
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/run/${runId}/status`,
    });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.status).toBe("failed");
    expect(j.error).toBe("downstream broke");
  });
});

// ── computeStepsHashRoot ──────────────────────────────────────────────────

describe("computeStepsHashRoot", () => {
  it("is deterministic given the same step rows", () => {
    const now = new Date().toISOString();
    const stepA = {
      run_id: "r",
      step_name: "n1",
      attempt: 1,
      status: "success" as const,
      input: null,
      output: JSON.stringify({ x: 1 }),
      error: null,
      error_sig_hash: null,
      started_at: now,
      finished_at: now,
      duration_ms: 0,
    };
    const stepB = { ...stepA, step_name: "n2", output: JSON.stringify({ y: 2 }) };
    const a = computeStepsHashRoot([stepA, stepB]);
    const b = computeStepsHashRoot([stepA, stepB]);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("differs when step output changes", () => {
    const now = new Date().toISOString();
    const stepBase = {
      run_id: "r",
      step_name: "n1",
      attempt: 1,
      status: "success" as const,
      input: null,
      output: JSON.stringify({ x: 1 }),
      error: null,
      error_sig_hash: null,
      started_at: now,
      finished_at: now,
      duration_ms: 0,
    };
    const stepAlt = { ...stepBase, output: JSON.stringify({ x: 2 }) };
    expect(computeStepsHashRoot([stepBase])).not.toBe(computeStepsHashRoot([stepAlt]));
  });

  it("returns hash of empty string when no steps", () => {
    const h = computeStepsHashRoot([]);
    expect(h).toMatch(/^sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855$/);
  });
});
