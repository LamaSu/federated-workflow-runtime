import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  hashSignature,
  type RedactedErrorReport,
} from "@delightfulchorus/core";
import { extractSignature, type ExtractSignatureContext } from "./signature.js";
import { redactString, extractShape, redactHeaders } from "./redact.js";
import { fingerprintConfig } from "./fingerprint.js";
import { submitReport, type SubmitOptions, type SubmitResult } from "./submit.js";

/**
 * Stricter-than-core validation schema per ARCHITECTURE.md §6.2.
 *
 * `@delightfulchorus/core` provides a permissive schema for wire compatibility, but
 * the reporter MUST refuse to emit any envelope that doesn't satisfy the
 * tighter rules here (regex on reporterId, datetime on timestamps, etc).
 * This is the fail-closed gate.
 */
const StrictSignatureSchema = z
  .object({
    schemaVersion: z.literal(1),
    integration: z.string().regex(/^[a-z0-9-]+$/),
    operation: z.string().min(1),
    errorClass: z.string().min(1),
    httpStatus: z.number().int().min(100).max(599).optional(),
    httpStatusText: z.string().optional(),
    apiVersion: z.string().optional(),
    stackFingerprint: z.string().regex(/^[a-f0-9]{16}$|^no-stack$/),
    messagePattern: z.string().max(500),
    integrationVersion: z.string().min(1),
    runtimeVersion: z.string().min(1),
    occurrences: z.number().int().positive(),
    firstSeen: z.string().datetime(),
    lastSeen: z.string().datetime(),
  })
  .strict();

const StrictRedactedErrorReportSchema = z
  .object({
    signature: StrictSignatureSchema,
    configFingerprint: z.record(
      z.string(),
      z.union([z.string(), z.boolean(), z.number()]),
    ),
    contextShape: z.record(z.string(), z.string()),
    reporterId: z.string().regex(/^[a-f0-9]{32}$/),
    reportedAt: z.string().datetime(),
  })
  .strict();

/**
 * Pipeline-level context — a superset of what `extractSignature` wants,
 * plus the bits needed to build the full RedactedErrorReport envelope.
 */
export interface ReportContext extends ExtractSignatureContext {
  /**
   * Integration config, from the Node that was executing when the error
   * fired. Gets run through `fingerprintConfig` — NEVER submitted raw.
   */
  config?: Record<string, unknown>;
  /**
   * Additional context captured by the runtime (request shape, response
   * shape, retry count). Everything here runs through `extractShape`
   * first; values are never passed through.
   */
  context?: {
    requestMethod?: string;
    urlTemplate?: string;
    requestBody?: unknown;
    responseBody?: unknown;
    responseHeaders?: Record<string, string>;
    durationMs?: number;
    retryCount?: number;
  };
  /**
   * Stable pseudonymous reporter id. 32 hex chars. Chorus runtime generates
   * this once at install time (SHA-256 of project id + local salt); the
   * reporter is handed the already-computed value.
   */
  reporterId?: string;
}

/**
 * Result of the full pipeline: signature hash (so the caller can
 * correlate), submission outcome, and whether the registry already has a
 * patch on file.
 */
export interface ReportFailureResult {
  signatureHash: string;
  submitted: boolean;
  reason?: string;
  existingPatch?: Record<string, unknown>;
  report: RedactedErrorReport;
}

/**
 * Run the full pipeline:
 *
 *   1. Extract a stable `ErrorSignature` from the error + context.
 *   2. Hash the signature (registry primary key).
 *   3. Redact the message pattern and the context shape.
 *   4. Fingerprint the integration config.
 *   5. Assemble a `RedactedErrorReport` envelope.
 *   6. Validate via Zod — on parse failure, drop the report (fail-closed).
 *   7. Submit.
 *
 * Failures at any stage BEFORE submission are NOT sent to the registry.
 * They surface as `{ submitted: false, reason: '...' }`.
 */
export async function reportFailure(
  err: unknown,
  ctx: ReportContext,
  registryUrl: string | undefined,
  options: SubmitOptions = {},
): Promise<ReportFailureResult> {
  // 1 + 2. Signature.
  const signature = extractSignature(err, ctx);
  const signatureHash = hashSignature(signature);

  // 3. Redact / shape-only the message and the context. The message
  // pattern already ran through stabilizeMessage in extractSignature, but
  // redactString is additive and idempotent — belt-and-braces.
  signature.messagePattern = redactString(signature.messagePattern);

  const contextShape = buildContextShape(ctx.context);

  // 4. Fingerprint config.
  const configFingerprint = fingerprintConfig(ctx.config);

  // 5. Envelope.
  const reporterId = ctx.reporterId ?? generateReporterId();
  const reportedAt = new Date().toISOString();

  const candidate: RedactedErrorReport = {
    signature,
    configFingerprint,
    contextShape,
    reporterId,
    reportedAt,
  };

  // 6. Fail-closed validation. If the envelope won't parse, something went
  // wrong upstream (e.g. a caller supplied a bad integration name or a
  // bogus reporterId). DROP rather than submit a malformed report.
  const parsed = StrictRedactedErrorReportSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      signatureHash,
      submitted: false,
      reason: `validation-failed: ${parsed.error.message.slice(0, 200)}`,
      report: candidate,
    };
  }

  // 7. Submit. Never throws on network error — returns structured result.
  const result: SubmitResult = await submitReport(
    parsed.data as RedactedErrorReport,
    registryUrl,
    options,
  );

  return {
    signatureHash,
    submitted: result.accepted,
    reason: result.reason,
    existingPatch: result.existingPatch,
    report: parsed.data,
  };
}

/**
 * Convert the caller-supplied context into the `contextShape` sub-record.
 *
 * - requestBody / responseBody get their shape extracted (types, never
 *   values) and JSON-stringified into the shape record.
 * - responseHeaders get the header allowlist applied.
 * - method / url are normalised / stabilised.
 */
function buildContextShape(
  context: ReportContext["context"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!context) return out;

  if (typeof context.requestMethod === "string") {
    const m = context.requestMethod.toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m)) {
      out.requestMethod = m;
    }
  }
  if (typeof context.urlTemplate === "string") {
    out.urlTemplate = redactString(context.urlTemplate);
  }
  if (context.requestBody !== undefined) {
    out.requestShape = JSON.stringify(extractShape(context.requestBody));
  }
  if (context.responseBody !== undefined) {
    out.responseShape = JSON.stringify(extractShape(context.responseBody));
  }
  if (context.responseHeaders) {
    out.responseHeaderShape = JSON.stringify(
      redactHeaders(context.responseHeaders),
    );
  }
  if (typeof context.durationMs === "number" && Number.isFinite(context.durationMs)) {
    out.durationMs = String(Math.max(0, Math.floor(context.durationMs)));
  }
  if (typeof context.retryCount === "number" && Number.isFinite(context.retryCount)) {
    out.retryCount = String(Math.max(0, Math.floor(context.retryCount)));
  }
  return out;
}

/**
 * Generate a random reporter id when the caller didn't supply one.
 *
 * Proper usage: the runtime generates a stable id once and passes it in;
 * this fallback is just so that ad-hoc test code / the first-run case
 * doesn't blow up. 32 hex chars = 128 bits, matching the schema regex.
 */
function generateReporterId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Re-export for callers who want to compute a stable reporter id themselves
 * (project id + local salt). This matches §6.2 Stage 3: "Per-reporter
 * pseudonymized ID (SHA-256 of project ID + salt)".
 */
export function computeReporterId(projectId: string, salt: string): string {
  return createHash("sha256")
    .update(`${projectId}|${salt}`)
    .digest("hex")
    .slice(0, 32);
}
