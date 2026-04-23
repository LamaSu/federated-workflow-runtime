/**
 * Unit tests for @delightfulchorus/integration-remote-workflow.
 *
 * Coverage goals:
 *   - Manifest sanity (name, operation, no auth)
 *   - resolveInvocationParams: missing/conflicting endpoint/workflowRef/hash
 *   - Mandatory hash pinning rejected before reaching trust validator
 *   - Operator keypair sourcing (env + ctx.credentials override)
 *   - Successful invoke: signs envelope, POSTs correct body, polls until
 *     terminal, returns shape
 *   - Network error → REMOTE_NETWORK
 *   - 4xx response → REMOTE_REJECTED
 *   - Status reports failed → REMOTE_FAILED
 *   - Status reports cancelled → REMOTE_CANCELLED
 *   - maxLatencyMs exceeded → REMOTE_TIMEOUT
 *   - buildStatusUrl handles edge cases (trailing slash, query string)
 *
 * Real server-vs-server flows are covered by the e2e test in
 * packages/runtime/src/executor.remote-workflow.test.ts (writing later in
 * Wave 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationContext } from "@delightfulchorus/core";
import {
  envelopeBytes,
  computeWorkflowHash,
} from "@delightfulchorus/runtime";
import { generateKeypair } from "@delightfulchorus/registry";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import remoteWorkflow, {
  buildStatusUrl,
  invokeOp,
  manifest,
  resolveInvocationParams,
} from "./index.js";

// Wire sha512 sync in case the test is the first to import @noble/ed25519.
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...msgs: Uint8Array[]) => {
    let total = 0;
    for (const p of msgs) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of msgs) {
      out.set(p, off);
      off += p.length;
    }
    return sha512(out);
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function noopLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

interface MakeCtxOpts {
  fetchFn?: typeof fetch;
  credentials?: Record<string, unknown> | null;
  nodeConfig?: Record<string, unknown>;
  signal?: AbortSignal;
  getOperatorReputation?: (pubkey: string) => Promise<number | undefined> | number | undefined;
}

function makeCtx(opts: MakeCtxOpts = {}): OperationContext {
  const ctx: OperationContext & {
    fetch?: typeof fetch;
    nodeConfig?: Record<string, unknown>;
    getOperatorReputation?: MakeCtxOpts["getOperatorReputation"];
  } = {
    credentials: opts.credentials ?? null,
    logger: noopLogger(),
    signal: opts.signal ?? new AbortController().signal,
  };
  if (opts.fetchFn) ctx.fetch = opts.fetchFn;
  if (opts.nodeConfig) ctx.nodeConfig = opts.nodeConfig;
  if (opts.getOperatorReputation) ctx.getOperatorReputation = opts.getOperatorReputation;
  return ctx;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FakeFetchHistoryEntry {
  url: string;
  method: string;
  body?: string;
}

function makeFakeFetch(
  responses: Array<Response | (() => Response | Promise<Response>)>,
): {
  fetchFn: typeof fetch;
  history: FakeFetchHistoryEntry[];
} {
  const history: FakeFetchHistoryEntry[] = [];
  let i = 0;
  const fetchFn: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    history.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (i >= responses.length) {
      throw new Error(`fake fetch: no more responses (call #${i + 1} to ${url})`);
    }
    const r = responses[i++]!;
    return typeof r === "function" ? r() : r;
  };
  return { fetchFn, history };
}

// ── Manifest sanity ────────────────────────────────────────────────────────

describe("manifest", () => {
  it("declares the invoke operation", () => {
    expect(manifest.name).toBe("remote-workflow");
    expect(manifest.operations.find((o) => o.name === "invoke")).toBeDefined();
  });

  it("requires no credentials", () => {
    expect(manifest.authType).toBe("none");
    expect(manifest.credentialTypes).toEqual([]);
  });

  it("module export wires up invoke", () => {
    expect(remoteWorkflow.operations["invoke"]).toBe(invokeOp);
  });
});

// ── resolveInvocationParams ────────────────────────────────────────────────

describe("resolveInvocationParams", () => {
  it("requires endpoint", () => {
    expect(() =>
      resolveInvocationParams(
        { workflowRef: "x", workflowHash: "sha256:y" },
        undefined,
      ),
    ).toThrow(/MISSING_ENDPOINT|requires `endpoint`/);
  });

  it("requires workflowRef", () => {
    expect(() =>
      resolveInvocationParams(
        { endpoint: "https://x/api/run", workflowHash: "sha256:y" },
        undefined,
      ),
    ).toThrow(/MISSING_WORKFLOW_REF|requires `workflowRef`/);
  });

  it("requires workflowHash (mandatory pinning)", () => {
    expect(() =>
      resolveInvocationParams(
        { endpoint: "https://x/api/run", workflowRef: "wf" },
        undefined,
      ),
    ).toThrow(/MISSING_WORKFLOW_HASH|requires `workflowHash`/);
  });

  it("reads from config (canonical form)", () => {
    const r = resolveInvocationParams(
      { audioUrl: "x" },
      {
        endpoint: "https://op-bob.example/api/run",
        workflowRef: "transcribe@v3",
        workflowHash: "sha256:abc",
      },
    );
    expect(r.endpoint).toBe("https://op-bob.example/api/run");
    expect(r.workflowRef).toBe("transcribe@v3");
    expect(r.workflowHash).toBe("sha256:abc");
    expect(r.triggerPayload).toEqual({ audioUrl: "x" });
  });

  it("input wins over config", () => {
    const r = resolveInvocationParams(
      {
        endpoint: "https://override/api/run",
        workflowRef: "v2",
        workflowHash: "sha256:over",
      },
      {
        endpoint: "https://default/api/run",
        workflowRef: "v1",
        workflowHash: "sha256:def",
      },
    );
    expect(r.endpoint).toBe("https://override/api/run");
    expect(r.workflowRef).toBe("v2");
    expect(r.workflowHash).toBe("sha256:over");
  });

  it("strips bookkeeping fields from triggerPayload", () => {
    const r = resolveInvocationParams(
      {
        endpoint: "https://x/api/run",
        workflowRef: "y",
        workflowHash: "sha256:z",
        trustPolicy: { minReputation: 100 },
        somePayloadField: "keep me",
      },
      undefined,
    );
    expect(r.triggerPayload).toEqual({ somePayloadField: "keep me" });
  });

  it("validates trust policy schema", () => {
    expect(() =>
      resolveInvocationParams(
        {
          endpoint: "https://x/api/run",
          workflowRef: "y",
          workflowHash: "sha256:z",
          // @ts-expect-error testing runtime rejection
          trustPolicy: { minReputation: -1 },
        },
        undefined,
      ),
    ).toThrow(/BAD_TRUST_POLICY|trustPolicy/);
  });

  it("accepts case-insensitive keys (FBP round-trip)", () => {
    const r = resolveInvocationParams(
      {
        ENDPOINT: "https://x/api/run",
        WORKFLOWREF: "y",
        workflowhash: "sha256:z",
      } as unknown as Parameters<typeof resolveInvocationParams>[0],
      undefined,
    );
    expect(r.endpoint).toBe("https://x/api/run");
    expect(r.workflowRef).toBe("y");
    expect(r.workflowHash).toBe("sha256:z");
  });

  it("accepts trustPolicy as a JSON string (FBP IIP)", () => {
    const r = resolveInvocationParams(
      {
        endpoint: "https://x/api/run",
        workflowRef: "y",
        workflowHash: "sha256:z",
        trustPolicy: JSON.stringify({ minReputation: 100 }) as unknown as { minReputation: number },
      },
      undefined,
    );
    expect(r.trustPolicy.minReputation).toBe(100);
  });
});

// ── buildStatusUrl ────────────────────────────────────────────────────────

describe("buildStatusUrl", () => {
  it("appends /<id>/status to the endpoint path", () => {
    expect(buildStatusUrl("https://x.example/api/run", "abc-123")).toBe(
      "https://x.example/api/run/abc-123/status",
    );
  });

  it("strips trailing slashes", () => {
    expect(buildStatusUrl("https://x.example/api/run/", "abc")).toBe(
      "https://x.example/api/run/abc/status",
    );
  });

  it("preserves query strings", () => {
    expect(buildStatusUrl("https://x.example/api/run?x=1", "abc")).toBe(
      "https://x.example/api/run/abc/status?x=1",
    );
  });

  it("URL-encodes the runId", () => {
    expect(buildStatusUrl("https://x.example/api/run", "id with spaces")).toBe(
      "https://x.example/api/run/id%20with%20spaces/status",
    );
  });

  it("rejects bad URLs", () => {
    expect(() => buildStatusUrl("not a url", "x")).toThrow(/BAD_ENDPOINT|valid URL/);
  });
});

// ── Operator keypair sourcing ─────────────────────────────────────────────

describe("operator keypair sourcing", () => {
  beforeEach(() => {
    delete process.env.CHORUS_OPERATOR_PRIVATE_KEY;
    delete process.env.CHORUS_OPERATOR_PUBLIC_KEY;
    delete process.env.CHORUS_OPERATOR_OIDC_ISSUER;
  });
  afterEach(() => {
    delete process.env.CHORUS_OPERATOR_PRIVATE_KEY;
    delete process.env.CHORUS_OPERATOR_PUBLIC_KEY;
    delete process.env.CHORUS_OPERATOR_OIDC_ISSUER;
  });

  it("rejects when keypair env vars are absent and no override given", async () => {
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/MISSING_OPERATOR_KEYPAIR|CHORUS_OPERATOR_PRIVATE_KEY/);
  });

  it("uses ctx.credentials.operatorKeypair override (env not required)", async () => {
    const kp = await generateKeypair();
    const { fetchFn, history } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({ remoteRunId: "r1", status: "success", output: { ok: 1 } }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    const out = await invokeOp(
      {
        endpoint: "https://x/api/run",
        workflowRef: "wf",
        workflowHash: "sha256:abc",
      },
      ctx,
    );
    expect(out.remoteRunId).toBe("r1");
    expect(history[0]!.method).toBe("POST");
  });

  it("forwards CHORUS_OPERATOR_OIDC_ISSUER into callerIdentity", async () => {
    const kp = await generateKeypair();
    process.env.CHORUS_OPERATOR_PRIVATE_KEY = kp.privateKey;
    process.env.CHORUS_OPERATOR_PUBLIC_KEY = kp.publicKey;
    process.env.CHORUS_OPERATOR_OIDC_ISSUER = "github.com/operator-bob";
    const { fetchFn, history } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({ remoteRunId: "r1", status: "success", output: null }),
    ]);
    await invokeOp(
      {
        endpoint: "https://x/api/run",
        workflowRef: "wf",
        workflowHash: "sha256:abc",
      },
      makeCtx({ fetchFn }),
    );
    const postBody = JSON.parse(history[0]!.body!);
    expect(postBody.callerIdentity.oidcIssuer).toBe("github.com/operator-bob");
  });
});

// ── Successful invoke ─────────────────────────────────────────────────────

describe("invokeOp — successful invoke", () => {
  it("posts envelope + identity, polls, returns shape", async () => {
    const kp = await generateKeypair();
    const { fetchFn, history } = makeFakeFetch([
      jsonResponse({ remoteRunId: "abc-123" }),
      jsonResponse({ remoteRunId: "abc-123", status: "running" }),
      jsonResponse({
        remoteRunId: "abc-123",
        status: "success",
        output: { transcription: "Hello world" },
        hashRoot: "sha256:terminalroothash",
      }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    const out = await invokeOp(
      {
        endpoint: "https://op-bob.example/api/run",
        workflowRef: "transcribe@v3",
        workflowHash: "sha256:def456",
        audioUrl: "https://example.com/audio.mp3",
      },
      ctx,
    );

    // POST body shape
    expect(history).toHaveLength(3);
    expect(history[0]!.method).toBe("POST");
    expect(history[0]!.url).toBe("https://op-bob.example/api/run");
    const postBody = JSON.parse(history[0]!.body!);
    expect(postBody.workflowRef).toBe("transcribe@v3");
    expect(postBody.workflowHash).toBe("sha256:def456");
    expect(postBody.input).toEqual({ audioUrl: "https://example.com/audio.mp3" });
    expect(postBody.callerIdentity.publicKey).toBe(kp.publicKey);
    expect(typeof postBody.callerIdentity.signature).toBe("string");
    expect(postBody.callerIdentity.signature.length).toBeGreaterThan(0);
    expect(typeof postBody.callerIdentity.timestamp).toBe("number");
    expect(typeof postBody.callerIdentity.nonce).toBe("string");

    // Status URL
    expect(history[1]!.method).toBe("GET");
    expect(history[1]!.url).toBe("https://op-bob.example/api/run/abc-123/status");

    // Output shape
    expect(out.output).toEqual({ transcription: "Hello world" });
    expect(out.remoteRunId).toBe("abc-123");
    expect(out.remoteHashRoot).toBe("sha256:terminalroothash");
    expect(out.endpoint).toBe("https://op-bob.example/api/run");
    expect(out.workflowRef).toBe("transcribe@v3");
  });

  it("envelope signature verifies against the local keypair", async () => {
    const kp = await generateKeypair();
    const { fetchFn, history } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({ remoteRunId: "r1", status: "success", output: null }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await invokeOp(
      {
        endpoint: "https://x/api/run",
        workflowRef: "wf",
        workflowHash: "sha256:abc",
        foo: "bar",
      },
      ctx,
    );
    const postBody = JSON.parse(history[0]!.body!);
    const env = {
      workflowRef: "wf",
      workflowHash: "sha256:abc",
      input: { foo: "bar" },
      timestamp: postBody.callerIdentity.timestamp,
      nonce: postBody.callerIdentity.nonce,
    };
    const expected = envelopeBytes(env);
    const sigBytes = new Uint8Array(Buffer.from(postBody.callerIdentity.signature, "base64"));
    const pubBytes = new Uint8Array(Buffer.from(kp.publicKey, "base64"));
    const ok = ed.verify(sigBytes, expected, pubBytes);
    expect(ok).toBe(true);
  });

  it("works when remote omits hashRoot (returns empty string)", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({ remoteRunId: "r1", status: "success", output: 42 }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    const out = await invokeOp(
      {
        endpoint: "https://x/api/run",
        workflowRef: "wf",
        workflowHash: "sha256:abc",
      },
      ctx,
    );
    expect(out.output).toBe(42);
    expect(out.remoteHashRoot).toBe("");
  });

  it("respects trustPolicy.maxLatencyMs as poll-loop timeout", async () => {
    const kp = await generateKeypair();
    // POST returns OK; status forever-pending. We expect REMOTE_TIMEOUT.
    let pollCount = 0;
    const { fetchFn } = makeFakeFetch([
      jsonResponse({ remoteRunId: "stuck" }),
      ...Array.from({ length: 100 }, () => () => {
        pollCount++;
        return jsonResponse({ remoteRunId: "stuck", status: "running" });
      }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
          trustPolicy: { maxLatencyMs: 500 },
        },
        ctx,
      ),
    ).rejects.toThrow(/REMOTE_TIMEOUT|did not complete within 500ms/);
    expect(pollCount).toBeGreaterThan(0);
  });
});

// ── Failure paths ─────────────────────────────────────────────────────────

describe("invokeOp — failure paths", () => {
  it("network error during POST → REMOTE_NETWORK", async () => {
    const kp = await generateKeypair();
    const fetchFn: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        ctx,
      ),
    ).rejects.toThrow(/REMOTE_NETWORK|ECONNREFUSED/);
  });

  it("4xx response → REMOTE_REJECTED", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([
      new Response("bad signature", { status: 401 }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        ctx,
      ),
    ).rejects.toThrow(/REMOTE_REJECTED|401/);
  });

  it("non-JSON POST response → REMOTE_MALFORMED_RESPONSE", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([
      new Response("definitely not json", { status: 200 }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        ctx,
      ),
    ).rejects.toThrow(/REMOTE_MALFORMED_RESPONSE|non-JSON/);
  });

  it("missing remoteRunId in response → REMOTE_MALFORMED_RESPONSE", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([jsonResponse({ wrong: "shape" })]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        ctx,
      ),
    ).rejects.toThrow(/REMOTE_MALFORMED_RESPONSE|missing remoteRunId/);
  });

  it("status reports failed → REMOTE_FAILED", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({
        remoteRunId: "r1",
        status: "failed",
        error: "downstream timeout",
      }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        ctx,
      ),
    ).rejects.toThrow(/REMOTE_FAILED|downstream timeout/);
  });

  it("status reports cancelled → REMOTE_CANCELLED", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({ remoteRunId: "r1", status: "cancelled" }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_CANCELLED" });
  });

  it("local trust validation rejects (e.g. minReputation w/o lookup)", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
    });
    await expect(
      invokeOp(
        {
          endpoint: "https://x/api/run",
          workflowRef: "wf",
          workflowHash: "sha256:abc",
          trustPolicy: { minReputation: 100 },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "LOCAL_TRUST_REPUTATION_UNAVAILABLE" });
  });

  it("local trust validation passes when lookup wired and rep meets floor", async () => {
    const kp = await generateKeypair();
    const { fetchFn } = makeFakeFetch([
      jsonResponse({ remoteRunId: "r1" }),
      jsonResponse({ remoteRunId: "r1", status: "success", output: null }),
    ]);
    const ctx = makeCtx({
      fetchFn,
      credentials: {
        operatorKeypair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      },
      getOperatorReputation: () => 1000,
    });
    const out = await invokeOp(
      {
        endpoint: "https://x/api/run",
        workflowRef: "wf",
        workflowHash: "sha256:abc",
        trustPolicy: { minReputation: 100 },
      },
      ctx,
    );
    expect(out.remoteRunId).toBe("r1");
  });
});

// ── computeWorkflowHash sanity (re-exported via runtime) ───────────────────

describe("computeWorkflowHash (cross-package)", () => {
  it("produces a hash that the receiver could match against its own def", () => {
    const wf = { id: "wf1", nodes: [], connections: [] };
    const h1 = computeWorkflowHash(wf);
    const h2 = computeWorkflowHash({ nodes: [], id: "wf1", connections: [] });
    expect(h1).toBe(h2);
  });
});

// Suppress vi import warning if unused in some configs.
void vi;
