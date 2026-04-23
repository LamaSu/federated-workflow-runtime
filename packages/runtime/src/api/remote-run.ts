/**
 * POST /api/run + GET /api/run/:id/status — Wave 3 worknet receiver routes.
 *
 * Mounted ONLY when the chorus instance is launched with `--remote-callable`.
 * Default-off preserves the 127.0.0.1 binding model — every chorus instance
 * that wants to be call-able from outside opts in.
 *
 * This is the reciprocal of the `remote-workflow` integration:
 *   - Caller side (integration handler) signs an envelope, POSTs it here.
 *   - Receiver (this route) verifies signature, recomputes workflowHash,
 *     enforces optional acceptedCallers allowlist, enqueues a child run,
 *     responds with `{remoteRunId}`.
 *   - Caller polls `GET /api/run/:id/status` until terminal.
 *
 * Authentication note (per brief, decision 2): the per-run subprocess
 * sandbox is NOT bypassed. We enqueue normally — the existing executor
 * loop picks it up and runs the workflow under the same credential
 * boundary local runs already enjoy. No credentials are extracted from
 * the call envelope; the caller's identity is recorded for audit (in
 * triggered_by + a JSON tag in trigger_payload) but is not used to
 * elevate privileges.
 *
 * Error mapping:
 *   - 401  trust validation failed (bad sig, skew, missing-pin, etc.)
 *   - 403  caller not in acceptedCallers allowlist
 *   - 404  workflowRef not found locally / remoteRunId not found
 *   - 409  workflowHash mismatches the local definition's content hash
 *   - 422  malformed request body
 *   - 500  internal (queue insert failed, etc.)
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseType, RunRow, RunStatus, StepRow, WorkflowRow } from "../db.js";
import { QueryHelpers } from "../db.js";
import {
  computeWorkflowHash,
  envelopeBytes,
  validateCall,
  type CallEnvelope,
  type CallerIdentity,
  type ReputationLookup,
  type TrustPolicy,
} from "../trust-policy.js";

// ── Wire schemas ──────────────────────────────────────────────────────────

const CallerIdentitySchema = z.object({
  signature: z.string().min(1),
  publicKey: z.string().min(1),
  oidcIssuer: z.string().optional(),
  timestamp: z.number(),
  nonce: z.string().min(1),
});

/**
 * Inbound request body. We accept the trustPolicy as an OPTIONAL hint —
 * the receiver enforces its own policy primarily (acceptedCallers list +
 * envelope signature verification + hash pinning). The trustPolicy field
 * is forwarded to the validator only when present so OIDC/reputation
 * gates still run.
 */
const RemoteRunRequestSchema = z.object({
  workflowRef: z.string().min(1),
  workflowHash: z.string().min(1),
  input: z.unknown().optional(),
  callerIdentity: CallerIdentitySchema,
  trustPolicy: z
    .object({
      requireOidcIssuer: z.string().optional(),
      minReputation: z.number().nonnegative().optional(),
      maxLatencyMs: z.number().int().positive().optional(),
      allowedSigners: z.array(z.string()).optional(),
    })
    .optional(),
});

type RemoteRunRequest = z.infer<typeof RemoteRunRequestSchema>;

// ── Options ───────────────────────────────────────────────────────────────

export interface RegisterRemoteRunOptions {
  /**
   * Optional allowlist of base64-encoded Ed25519 public keys. When set,
   * incoming callers' publicKey MUST appear in this list. Empty/omitted →
   * accept any caller whose signature verifies (the publicKey is
   * self-attested but the signature proves possession).
   *
   * Sourced from the CLI flag `--accepted-caller <pubkey>` (repeatable)
   * or from `acceptedCallers` env var (comma-separated).
   */
  acceptedCallers?: string[];
  /**
   * Reputation lookup. Forwarded into the trust validator so trustPolicy
   * hints from the caller side can be honored. When absent, calls with
   * `minReputation` set in their trustPolicy are rejected (fail-closed).
   */
  getOperatorReputation?: ReputationLookup;
  /**
   * Override the timestamp skew window (default ±5min). Tests use this to
   * pin time without faking process clocks.
   */
  timestampSkewMs?: number;
  /** Override `now` for tests. */
  now?: () => number;
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerRemoteRunRoutes(
  app: FastifyInstance,
  db: DatabaseType,
  opts: RegisterRemoteRunOptions = {},
): void {
  const helpers = new QueryHelpers(db);
  const acceptedCallers = (opts.acceptedCallers ?? []).filter(
    (k) => k && k.length > 0,
  );

  // POST /api/run — accept a remote workflow invocation.
  app.post<{ Body: unknown }>("/api/run", async (req, reply) => {
    // 1. Schema-validate the request body.
    const parse = RemoteRunRequestSchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(422);
      return {
        error: "BAD_REQUEST",
        message: parse.error.message,
      };
    }
    const body: RemoteRunRequest = parse.data;
    const { workflowRef, workflowHash, callerIdentity } = body;
    const callInput = body.input ?? null;

    // 2. Acceptedcallers allowlist (when configured). Run BEFORE signature
    //    verification so a not-allowed caller can't even probe the verify
    //    path's timing.
    if (acceptedCallers.length > 0 && !acceptedCallers.includes(callerIdentity.publicKey)) {
      reply.code(403);
      return {
        error: "FORBIDDEN",
        message: "caller publicKey is not in this instance's acceptedCallers allowlist",
      };
    }

    // 3. Resolve the workflow locally. Try plain id first, then parse an
    //    optional `@version` suffix (`transcribe@v3` or `transcribe@3`).
    //    Reject 404 BEFORE signature verify so an attacker can't probe the
    //    workflow registry by burning signature work.
    let workflow: WorkflowRow | undefined = helpers.getWorkflow(workflowRef);
    if (!workflow) {
      const at = workflowRef.lastIndexOf("@");
      if (at > 0) {
        const rawVersion = workflowRef.slice(at + 1);
        const vMatch = /^v?(\d+)$/.exec(rawVersion);
        if (vMatch) {
          const version = Number.parseInt(vMatch[1]!, 10);
          const baseId = workflowRef.slice(0, at);
          workflow = helpers.getWorkflow(baseId, version);
        }
      }
    }
    if (!workflow) {
      reply.code(404);
      return {
        error: "WORKFLOW_NOT_FOUND",
        message: `workflowRef "${workflowRef}" not found in this instance's registry`,
      };
    }
    return await acceptInvocation(workflow);

    async function acceptInvocation(workflow: WorkflowRow): Promise<unknown> {
      // 4. Recompute the workflow content hash and require an exact match.
      //    Pinning is the receiver's defense against a confused caller
      //    ending up at a server with a drifted definition.
      let parsedDef: unknown;
      try {
        parsedDef = JSON.parse(workflow.definition);
      } catch (err) {
        reply.code(500);
        return {
          error: "WORKFLOW_CORRUPT",
          message: `workflow ${workflow.id}@${workflow.version} stored definition is not JSON: ${(err as Error).message}`,
        };
      }
      const localHash = computeWorkflowHash(parsedDef);
      if (localHash !== workflowHash) {
        reply.code(409);
        return {
          error: "HASH_MISMATCH",
          message: `workflowHash mismatch: caller pinned ${workflowHash} but local definition hashes to ${localHash}`,
          localHash,
          callerHash: workflowHash,
        };
      }

      // 5. Trust validation: signature, timestamps, optional OIDC, optional
      //    reputation. The caller's trustPolicy hints are forwarded so the
      //    SAME validator runs with consistent semantics on both sides.
      const envelope: CallEnvelope = {
        workflowRef,
        workflowHash,
        input: callInput,
        timestamp: callerIdentity.timestamp,
        nonce: callerIdentity.nonce,
      };
      const policy: TrustPolicy = body.trustPolicy ?? {};
      const validation = await validateCall({
        policy,
        envelope,
        identity: callerIdentity,
        getOperatorReputation: opts.getOperatorReputation,
        timestampSkewMs: opts.timestampSkewMs,
        now: opts.now,
      });
      if (validation.kind === "rejected") {
        reply.code(401);
        return {
          error: "UNAUTHORIZED",
          code: validation.code,
          message: validation.message,
        };
      }

      // 6. Insert a pending run directly. The existing executor loop
      //    (server.ts startLoop → tick → queue.claim) picks it up and
      //    runs it inside the existing per-run subprocess sandbox — NO
      //    credential elevation, no new code path. Brief decision 2.
      //
      //    We tag triggered_by with both `remote` and the caller's pubkey
      //    prefix so audit logs / `chorus run history` show provenance.
      //    We bypass `RunQueue.enqueue` because its `triggeredBy` field
      //    is constrained to a fixed union — the worknet tag intentionally
      //    falls outside that set so audit pipelines can filter remote
      //    invocations distinct from manual/cron/webhook/event triggers.
      const remoteRunId = randomUUID();
      const callerTag = `remote:${callerIdentity.publicKey.slice(0, 12)}`;
      const nowIso = new Date().toISOString();
      const runRow: RunRow = {
        id: remoteRunId,
        workflow_id: workflow.id,
        workflow_version: workflow.version,
        status: "pending",
        triggered_by: callerTag,
        trigger_payload: callInput === null ? null : JSON.stringify(callInput),
        priority: 0,
        next_wakeup: null,
        visibility_until: null,
        started_at: nowIso,
        finished_at: null,
        error: null,
        attempt: 1,
      };
      try {
        helpers.insertRun(runRow);
        reply.code(200);
        return { remoteRunId };
      } catch (err) {
        reply.code(500);
        return {
          error: "ENQUEUE_FAILED",
          message: `failed to enqueue child run: ${(err as Error).message}`,
        };
      }
    }
  });

  // GET /api/run/:id/status — return current status. Lightweight; the
  // remote-workflow integration polls this until terminal.
  app.get<{ Params: { id: string } }>("/api/run/:id/status", async (req, reply) => {
    const run = helpers.getRun(req.params.id);
    if (!run) {
      reply.code(404);
      return {
        error: "RUN_NOT_FOUND",
        message: `run ${req.params.id} not found`,
      };
    }
    const steps = helpers.listSteps(req.params.id);
    const status = run.status as RunStatus;
    const terminal =
      status === "success" || status === "failed" || status === "cancelled";

    // For success: extract the terminal node's output (last step's output JSON).
    let output: unknown = null;
    if (status === "success") {
      const lastStep = steps[steps.length - 1];
      if (lastStep && lastStep.output) {
        try {
          output = JSON.parse(lastStep.output);
        } catch {
          output = lastStep.output;
        }
      }
    }

    // Compute a hash-chain root over the steps' output JSONs in declaration
    // order. The caller stores this as a forensic anchor; both sides can
    // independently re-compute and compare.
    const hashRoot = terminal ? computeStepsHashRoot(steps) : "";

    reply.code(200);
    return {
      remoteRunId: run.id,
      status,
      output: status === "success" ? output : null,
      error: run.error,
      hashRoot,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash root across the run's step outputs. Mirrors
 * the moral intent of the patch hash-chain (per docs/ARCHITECTURE.md §5)
 * so the caller can record a single string that fingerprints the whole
 * remote run's terminal state.
 *
 * Implementation: SHA-256 over `step_name || ":" || (output_json || "null")`
 * concatenated with "\n" between rows. Cheap and deterministic. For
 * empty-step runs returns the hash of an empty string.
 */
function computeStepsHashRoot(steps: StepRow[]): string {
  const lines: string[] = [];
  for (const s of steps) {
    lines.push(`${s.step_name}:${s.output ?? "null"}`);
  }
  const hex = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
  return `sha256:${hex}`;
}

// Re-export helper for tests + the e2e integration test that needs to
// independently compute the same hash to verify the receiver's value.
export { computeStepsHashRoot };

// Suppress unused-import lint for envelopeBytes — the function is pulled
// in for forward symmetry; we don't call it directly here (validateCall
// does it internally) but we keep the import so the structural
// relationship is grep-able for future maintainers.
void envelopeBytes;
