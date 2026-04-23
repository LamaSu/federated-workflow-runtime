/**
 * @delightfulchorus/integration-remote-workflow
 *
 * Worknet — invoke a workflow on a REMOTE chorus instance as a single
 * memoized step in the parent. Companion to integration-workflow (which
 * resolves to a LOCAL workflow registry); both round-trip through the same
 * `step.run` memoization so replays of the parent NEVER re-invoke the
 * remote run.
 *
 * Node shape (the canonical / spec form):
 *   {
 *     id: "transcribe",
 *     integration: "remote-workflow",
 *     operation: "invoke",
 *     config: {
 *       endpoint: "https://operator-bob.chorus.dev/api/run",
 *       workflowRef: "transcribe-audio@v3",
 *       workflowHash: "sha256:abc123...",        // mandatory pinning
 *       trustPolicy: {
 *         requireOidcIssuer?: string,             // e.g. "github.com/operator-bob"
 *         minReputation?: number,                 // 1000+ for production
 *         maxLatencyMs?: number,                  // poll-loop timeout
 *         allowedSigners?: string[]               // pubkey allowlist
 *       },
 *     },
 *     inputs: { audioUrl: "..." }
 *   }
 *
 * Behavior (per wave-3-brief.md, deliverable 1):
 *   1. Resolve endpoint / workflowRef / workflowHash / trustPolicy from
 *      either node.config (canonical) or node.inputs (FBP IIP form).
 *   2. Build a CallEnvelope { workflowRef, workflowHash, input, timestamp,
 *      nonce } and Ed25519-sign it with the LOCAL operator's private key
 *      (env: CHORUS_OPERATOR_PRIVATE_KEY + CHORUS_OPERATOR_PUBLIC_KEY).
 *   3. Validate the trust policy LOCALLY before sending — catches
 *      misconfiguration early (e.g. minReputation set with no lookup wired)
 *      and avoids a wasted network round-trip.
 *   4. POST the envelope + identity to `endpoint`. Receiver responds with
 *      `{remoteRunId}`.
 *   5. Poll GET `<endpoint>/<remoteRunId>/status` until terminal (success /
 *      failed / cancelled) or until `trustPolicy.maxLatencyMs` elapses.
 *      On success: return terminal output + remoteHashRoot.
 *      On timeout: throw IntegrationError("REMOTE_TIMEOUT") — surfaces
 *      through Node.fallbacks chain (Wave 1 item 6) if declared.
 *      On remote failure: throw IntegrationError("REMOTE_FAILED") with
 *      the remote run's error message.
 *   6. The OUTER step.run wrapper (executor.ts) memoizes our return value.
 *      Replay returns cached output WITHOUT re-invoking step 4-5.
 *
 * MEMOIZATION INVARIANT (per brief, decision 3):
 *   The parent's `steps` table gets ONE row for the remote-workflow node.
 *   That row's output JSON contains both the terminal output and the
 *   remote run's hash-chain root for forensic inspection.
 *
 * SECURITY (per brief — flagged for end-of-pipeline /vet):
 *   - Hash pinning is mandatory (rejected at validateCall + reasserted by
 *     the receiving server). Cannot be opted-out of.
 *   - Caller identity is Ed25519-signed over a canonical envelope
 *     including a freshly-generated nonce + current timestamp. The
 *     receiver enforces ±5min skew (configurable on the receiver side).
 *   - The trust policy travels with the call (minReputation, etc.) but
 *     these are HINTS to the receiver — the receiver enforces its own
 *     acceptedCallers allowlist independently.
 *   - We do NOT send local credentials — the remote operator runs the
 *     child workflow under its own credential set inside its own
 *     subprocess sandbox. The credential boundary is preserved by
 *     construction (we never marshal credentials into the envelope).
 *   - We do NOT retry on REMOTE_FAILED inside the handler — the executor's
 *     existing retry budget + Node.fallbacks is the right control point.
 */
import {
  IntegrationError,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import {
  signCallEnvelope,
  validateCall,
  type CallEnvelope,
  type CallerIdentity,
  type ReputationLookup,
  type TrustPolicy,
} from "@delightfulchorus/runtime";
import { z } from "zod";
import { randomBytes } from "node:crypto";

// ── Schemas ────────────────────────────────────────────────────────────────

/**
 * Trust policy schema — every field optional. Mirrors the runtime's
 * TrustPolicy type but as a Zod schema so we can validate at config-resolve
 * time (defense-in-depth: bad policies caught here become clear errors
 * instead of obscure trust-validation failures down the road).
 */
const TrustPolicySchema = z
  .object({
    requireOidcIssuer: z.string().min(1).optional(),
    minReputation: z.number().nonnegative().optional(),
    maxLatencyMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
    allowedSigners: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Input to the `invoke` operation.
 *
 * Both `endpoint`, `workflowRef`, `workflowHash`, and `trustPolicy` are
 * accepted at the top level so they round-trip through the FBP adapter as
 * IIPs. They may also be supplied via `config` (the canonical spec form,
 * see resolveInvocationParams). When both present, `input` wins.
 *
 * Anything else in the input object is treated as the workflow's trigger
 * payload. Bookkeeping fields are stripped before sending.
 */
export const InvokeInputSchema = z
  .object({
    endpoint: z.string().url().optional(),
    workflowRef: z.string().min(1).optional(),
    workflowHash: z.string().min(1).optional(),
    trustPolicy: TrustPolicySchema.optional(),
  })
  .passthrough();

export type InvokeInput = z.infer<typeof InvokeInputSchema>;

export const InvokeOutputSchema = z.object({
  /** Terminal output of the remote workflow. */
  output: z.unknown(),
  /** Remote run id — queryable on the remote instance via `chorus run history`. */
  remoteRunId: z.string(),
  /**
   * Remote run's terminal-state hash root. Empty string when the receiver
   * doesn't support it; non-empty when the receiver returns a `hashRoot`
   * field (or when we hash the output ourselves on the local side).
   */
  remoteHashRoot: z.string(),
  /** Endpoint that was invoked (for debugging / forensic). */
  endpoint: z.string(),
  /** Workflow ref that was requested (for debugging / forensic). */
  workflowRef: z.string(),
});

export type InvokeOutput = z.infer<typeof InvokeOutputSchema>;

// ── Manifest ───────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "remote-workflow",
  version: "0.1.9",
  description:
    "Worknet — invoke a workflow on a remote chorus instance as a single memoized step. Signed Ed25519 calls, mandatory hash pinning, optional reputation/OIDC/allowlist gates.",
  authType: "none",
  /**
   * The operator's identity (Ed25519 keypair) is sourced from the runtime's
   * environment, not from `ctx.credentials` — the keypair is per-instance,
   * not per-integration. See readOperatorKeypair.
   */
  credentialTypes: [],
  operations: [
    {
      name: "invoke",
      description:
        "Invoke a workflow on a remote chorus instance. Signs the envelope, posts to the remote, polls until terminal, returns the remote terminal output. The whole call is one memoized step in the parent — replay returns cached output without re-invoking the remote.",
      idempotent: false,
      inputSchema: {
        type: "object",
        properties: {
          endpoint: { type: "string", format: "uri" },
          workflowRef: { type: "string", minLength: 1 },
          workflowHash: { type: "string", minLength: 1 },
          trustPolicy: { type: "object" },
        },
      },
      outputSchema: {
        type: "object",
        required: ["output", "remoteRunId", "remoteHashRoot", "endpoint", "workflowRef"],
        properties: {
          output: {},
          remoteRunId: { type: "string" },
          remoteHashRoot: { type: "string" },
          endpoint: { type: "string" },
          workflowRef: { type: "string" },
        },
      },
    },
  ],
};

// ── Param resolution ───────────────────────────────────────────────────────

interface ResolvedInvocationParams {
  endpoint: string;
  workflowRef: string;
  workflowHash: string;
  trustPolicy: TrustPolicy;
  /** The trigger payload to send to the remote — input minus bookkeeping. */
  triggerPayload: unknown;
}

/**
 * Resolve invocation parameters from input/config. Config wins for
 * configuration values (canonical spec form); input wins as a final
 * override (FBP IIP form). The leftover input fields become the trigger
 * payload sent to the remote.
 *
 * Bookkeeping fields stripped from the trigger payload (case-insensitive,
 * for FBP round-trip tolerance):
 *   endpoint, workflowref, workflowhash, trustpolicy
 */
export function resolveInvocationParams(
  input: InvokeInput,
  config: Record<string, unknown> | undefined,
): ResolvedInvocationParams {
  const endpoint =
    caseInsensitiveString(input as Record<string, unknown>, "endpoint") ??
    (config !== undefined ? caseInsensitiveString(config, "endpoint") : undefined);
  if (!endpoint || endpoint.length === 0) {
    throw new IntegrationError({
      message:
        "remote-workflow.invoke requires `endpoint` (in either node.config or node.inputs).",
      integration: "remote-workflow",
      operation: "invoke",
      code: "MISSING_ENDPOINT",
    });
  }

  const workflowRef =
    caseInsensitiveString(input as Record<string, unknown>, "workflowRef") ??
    (config !== undefined ? caseInsensitiveString(config, "workflowRef") : undefined);
  if (!workflowRef || workflowRef.length === 0) {
    throw new IntegrationError({
      message:
        "remote-workflow.invoke requires `workflowRef` (in either node.config or node.inputs).",
      integration: "remote-workflow",
      operation: "invoke",
      code: "MISSING_WORKFLOW_REF",
    });
  }

  const workflowHash =
    caseInsensitiveString(input as Record<string, unknown>, "workflowHash") ??
    (config !== undefined ? caseInsensitiveString(config, "workflowHash") : undefined);
  if (!workflowHash || workflowHash.length === 0) {
    // Pinning is mandatory per brief decision 1. Catch it early so users
    // get a clear error before the trust validator's MISSING_HASH path.
    throw new IntegrationError({
      message:
        "remote-workflow.invoke requires `workflowHash` (mandatory pinning prevents version drift). Compute it via runtime.computeWorkflowHash(localDef) or fetch from the remote operator.",
      integration: "remote-workflow",
      operation: "invoke",
      code: "MISSING_WORKFLOW_HASH",
    });
  }

  const policyRaw =
    caseInsensitiveObject(input as Record<string, unknown>, "trustPolicy") ??
    (config !== undefined ? caseInsensitiveObject(config, "trustPolicy") : undefined) ??
    {};
  const policyParse = TrustPolicySchema.safeParse(policyRaw);
  if (!policyParse.success) {
    throw new IntegrationError({
      message: `remote-workflow.invoke: trustPolicy is malformed: ${policyParse.error.message}`,
      integration: "remote-workflow",
      operation: "invoke",
      code: "BAD_TRUST_POLICY",
    });
  }
  const trustPolicy: TrustPolicy = policyParse.data;

  // Strip bookkeeping fields to derive the trigger payload.
  const triggerPayload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const lk = k.toLowerCase();
    if (
      lk === "endpoint" ||
      lk === "workflowref" ||
      lk === "workflowhash" ||
      lk === "trustpolicy" ||
      lk === "triggerpayload"
    ) {
      continue;
    }
    triggerPayload[k] = v;
  }

  return { endpoint, workflowRef, workflowHash, trustPolicy, triggerPayload };
}

// ── Operator keypair ──────────────────────────────────────────────────────

/**
 * Read the local operator's Ed25519 keypair from the environment. This is
 * an INSTANCE identity, not a per-call credential — every outbound remote
 * call from this chorus instance uses the same identity. Operators rotate
 * by changing the env var values + re-deploying.
 *
 * Env vars:
 *   CHORUS_OPERATOR_PRIVATE_KEY   base64-encoded 32-byte Ed25519 seed
 *   CHORUS_OPERATOR_PUBLIC_KEY    base64-encoded 32-byte Ed25519 public key
 *   CHORUS_OPERATOR_OIDC_ISSUER   optional Sigstore OIDC issuer label
 *
 * Returning a typed object here lets tests inject a fake keypair via
 * `ctx.credentials.operatorKeypair` (defense in depth — handlers should
 * always be testable without env state).
 */
function readOperatorKeypair(ctx: OperationContext): {
  privateKey: string;
  publicKey: string;
  oidcIssuer?: string;
} {
  // Test/override path: ctx.credentials.operatorKeypair allows injection
  // without env mutation. Guards against accidentally signing real calls
  // during tests.
  const cred = ctx.credentials as
    | { operatorKeypair?: { privateKey?: unknown; publicKey?: unknown; oidcIssuer?: unknown } }
    | null
    | undefined;
  const overridden = cred?.operatorKeypair;
  if (
    overridden &&
    typeof overridden.privateKey === "string" &&
    typeof overridden.publicKey === "string"
  ) {
    return {
      privateKey: overridden.privateKey,
      publicKey: overridden.publicKey,
      ...(typeof overridden.oidcIssuer === "string"
        ? { oidcIssuer: overridden.oidcIssuer }
        : {}),
    };
  }

  const priv = process.env.CHORUS_OPERATOR_PRIVATE_KEY;
  const pub = process.env.CHORUS_OPERATOR_PUBLIC_KEY;
  if (!priv || !pub) {
    throw new IntegrationError({
      message:
        "remote-workflow.invoke: CHORUS_OPERATOR_PRIVATE_KEY + CHORUS_OPERATOR_PUBLIC_KEY env vars are required to sign outbound calls. Generate via runtime.generateKeypair() and set both before launching `chorus run`.",
      integration: "remote-workflow",
      operation: "invoke",
      code: "MISSING_OPERATOR_KEYPAIR",
    });
  }
  const issuer = process.env.CHORUS_OPERATOR_OIDC_ISSUER;
  return {
    privateKey: priv,
    publicKey: pub,
    ...(issuer && issuer.length > 0 ? { oidcIssuer: issuer } : {}),
  };
}

// ── Reputation lookup ─────────────────────────────────────────────────────

/**
 * Pull a reputation lookup off ctx if the runtime has wired one. Returns
 * undefined if no lookup is available — the trust validator handles
 * fail-closed semantics (when policy.minReputation is set but lookup is
 * absent → REPUTATION_UNAVAILABLE).
 */
function extractReputationLookup(ctx: OperationContext): ReputationLookup | undefined {
  const ext = ctx as OperationContext & {
    getOperatorReputation?: ReputationLookup;
  };
  return typeof ext.getOperatorReputation === "function"
    ? ext.getOperatorReputation
    : undefined;
}

// ── HTTP transport ────────────────────────────────────────────────────────

/**
 * Pull a fetch override off ctx (tests). Defaults to the global fetch.
 * Lets the e2e harness route in-process between two Executor instances
 * without spinning up real Fastify servers.
 */
function extractFetch(ctx: OperationContext): typeof fetch {
  const ext = ctx as OperationContext & { fetch?: typeof fetch };
  return typeof ext.fetch === "function" ? ext.fetch : fetch;
}

interface PostRunResponse {
  remoteRunId: string;
}

interface RunStatusResponse {
  remoteRunId: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  output?: unknown;
  error?: string | null;
  /** SHA-256 hex of canonical-JSON terminal state. Optional — receiver may omit. */
  hashRoot?: string;
}

/** Default polling interval — 200ms is a balance between latency and load. */
const DEFAULT_POLL_INTERVAL_MS = 200;
/** Default max wall time before we give up — 60s. Brief decision 4 hooks into Node.fallbacks. */
const DEFAULT_MAX_LATENCY_MS = 60_000;

// ── Handler ────────────────────────────────────────────────────────────────

export const invokeOp: OperationHandler<InvokeInput, InvokeOutput> = async (
  input,
  ctx,
) => {
  const parsed = InvokeInputSchema.parse(input);
  const config = (ctx as OperationContext & {
    nodeConfig?: Record<string, unknown>;
  }).nodeConfig;
  const { endpoint, workflowRef, workflowHash, trustPolicy, triggerPayload } =
    resolveInvocationParams(parsed, config);

  // 1. Build the envelope + sign with the local operator's keypair.
  const operator = readOperatorKeypair(ctx);
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const envelope: CallEnvelope = {
    workflowRef,
    workflowHash,
    input: triggerPayload,
    timestamp,
    nonce,
  };
  const signature = signCallEnvelope(envelope, operator.privateKey);
  const identity: CallerIdentity = {
    signature,
    publicKey: operator.publicKey,
    timestamp,
    nonce,
    ...(operator.oidcIssuer ? { oidcIssuer: operator.oidcIssuer } : {}),
  };

  // 2. LOCAL trust validation — defense-in-depth so misconfigured policies
  //    fail before a wasted network round-trip. The receiver MUST also
  //    validate (its policy may be stricter — e.g. acceptedCallers).
  const localValidation = await validateCall({
    policy: trustPolicy,
    envelope,
    identity,
    getOperatorReputation: extractReputationLookup(ctx),
  });
  if (localValidation.kind === "rejected") {
    throw new IntegrationError({
      message: `remote-workflow.invoke: local trust validation failed: ${localValidation.message}`,
      integration: "remote-workflow",
      operation: "invoke",
      code: `LOCAL_TRUST_${localValidation.code}`,
    });
  }

  // 3. POST to the remote endpoint. The body is the wire format that the
  //    receiver's POST /api/run handler parses + validates.
  const fetchFn = extractFetch(ctx);
  const requestBody = {
    workflowRef,
    workflowHash,
    input: triggerPayload,
    callerIdentity: identity,
  };

  const maxLatencyMs = trustPolicy.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;
  const startedAt = Date.now();

  let postRes: Response;
  try {
    postRes = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: ctx.signal,
    });
  } catch (err) {
    throw new IntegrationError({
      message: `remote-workflow.invoke: POST to ${endpoint} failed: ${(err as Error).message}`,
      integration: "remote-workflow",
      operation: "invoke",
      code: "REMOTE_NETWORK",
      cause: err,
    });
  }

  if (!postRes.ok) {
    const text = await safeText(postRes);
    throw new IntegrationError({
      message: `remote-workflow.invoke: POST to ${endpoint} returned ${postRes.status}: ${text}`,
      integration: "remote-workflow",
      operation: "invoke",
      code: "REMOTE_REJECTED",
      httpStatus: postRes.status,
    });
  }

  let postBody: PostRunResponse;
  try {
    postBody = (await postRes.json()) as PostRunResponse;
  } catch (err) {
    throw new IntegrationError({
      message: `remote-workflow.invoke: ${endpoint} responded with non-JSON body: ${(err as Error).message}`,
      integration: "remote-workflow",
      operation: "invoke",
      code: "REMOTE_MALFORMED_RESPONSE",
      cause: err,
    });
  }
  if (!postBody.remoteRunId || typeof postBody.remoteRunId !== "string") {
    throw new IntegrationError({
      message: `remote-workflow.invoke: ${endpoint} response missing remoteRunId`,
      integration: "remote-workflow",
      operation: "invoke",
      code: "REMOTE_MALFORMED_RESPONSE",
    });
  }

  // 4. Poll for terminal status. Brief decision 6: polling is the Wave 3
  //    default; Wave 4 will introduce streaming.
  const statusUrl = buildStatusUrl(endpoint, postBody.remoteRunId);
  let status: RunStatusResponse | null = null;
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxLatencyMs) {
      throw new IntegrationError({
        message: `remote-workflow.invoke: remote run ${postBody.remoteRunId} did not complete within ${maxLatencyMs}ms (last status: ${status?.status ?? "<none>"})`,
        integration: "remote-workflow",
        operation: "invoke",
        code: "REMOTE_TIMEOUT",
      });
    }
    if (ctx.signal.aborted) {
      throw new IntegrationError({
        message: `remote-workflow.invoke: aborted while polling remote run ${postBody.remoteRunId}`,
        integration: "remote-workflow",
        operation: "invoke",
        code: "ABORTED",
      });
    }

    let getRes: Response;
    try {
      getRes = await fetchFn(statusUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      });
    } catch (err) {
      // Single failed poll is not fatal — the next iteration retries until
      // we exhaust maxLatencyMs.
      ctx.logger.warn(
        `remote-workflow: status poll for ${postBody.remoteRunId} failed: ${(err as Error).message}`,
      );
      await sleep(DEFAULT_POLL_INTERVAL_MS, ctx.signal);
      continue;
    }

    if (!getRes.ok) {
      // 404 on status indicates the receiver lost the run record (server
      // crash + missing persistence) — also non-fatal until timeout.
      ctx.logger.warn(
        `remote-workflow: status ${getRes.status} from ${statusUrl}`,
      );
      await sleep(DEFAULT_POLL_INTERVAL_MS, ctx.signal);
      continue;
    }

    try {
      status = (await getRes.json()) as RunStatusResponse;
    } catch (err) {
      ctx.logger.warn(
        `remote-workflow: malformed status JSON from ${statusUrl}: ${(err as Error).message}`,
      );
      await sleep(DEFAULT_POLL_INTERVAL_MS, ctx.signal);
      continue;
    }

    if (status.status === "success") break;
    if (status.status === "failed" || status.status === "cancelled") {
      throw new IntegrationError({
        message: `remote-workflow.invoke: remote run ${postBody.remoteRunId} ${status.status}: ${status.error ?? "<no message>"}`,
        integration: "remote-workflow",
        operation: "invoke",
        code: status.status === "cancelled" ? "REMOTE_CANCELLED" : "REMOTE_FAILED",
      });
    }
    // pending | running — keep polling
    await sleep(DEFAULT_POLL_INTERVAL_MS, ctx.signal);
  }

  // 5. Snapshot record for forensic / replay introspection.
  await ctx.snapshot?.record(
    "remote-workflow.invoke.200",
    {
      endpoint,
      workflowRef,
      workflowHash,
      hasTrustPolicy: Object.keys(trustPolicy).length > 0,
    },
    {
      remoteRunId: status.remoteRunId ?? postBody.remoteRunId,
      hashRoot: status.hashRoot ?? "",
    },
  );

  return {
    output: status.output ?? null,
    remoteRunId: status.remoteRunId ?? postBody.remoteRunId,
    remoteHashRoot: status.hashRoot ?? "",
    endpoint,
    workflowRef,
  };
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the status URL from the POST endpoint + remoteRunId. Convention:
 *   POST  https://host/api/run             →  invoke
 *   GET   https://host/api/run/<id>/status →  poll
 *
 * We parse the endpoint URL, append `/<id>/status` to its path, and
 * preserve the rest of the URL (query, fragment, host).
 */
export function buildStatusUrl(endpoint: string, remoteRunId: string): string {
  // URL parse so we don't accidentally double-slash or break on query
  // strings the operator may have on their endpoint.
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new IntegrationError({
      message: `remote-workflow.invoke: endpoint "${endpoint}" is not a valid URL`,
      integration: "remote-workflow",
      operation: "invoke",
      code: "BAD_ENDPOINT",
    });
  }
  // Strip trailing slash to keep paths tidy.
  const trimmed = url.pathname.replace(/\/+$/, "");
  url.pathname = `${trimmed}/${encodeURIComponent(remoteRunId)}/status`;
  return url.toString();
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable response body>";
  }
}

/**
 * Sleep that respects the abort signal. Resolves early on abort so the
 * polling loop can break out cleanly.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(t);
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function caseInsensitiveString(
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!record) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === target && typeof v === "string") return v;
  }
  return undefined;
}

function caseInsensitiveObject(
  record: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() !== target) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    if (typeof v === "string" && v.length > 0) {
      // FBP IIP form — JSON-encoded object.
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    invoke: invokeOp as OperationHandler,
  },
};

export default integration;
