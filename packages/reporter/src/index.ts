/**
 * @delightfulchorus/reporter — failure capture + PII redaction + registry submission.
 *
 * See `docs/ARCHITECTURE.md` §6 for the design.
 *
 * Typical usage:
 *
 * ```ts
 * import { reportFailure, computeReporterId } from "@delightfulchorus/reporter";
 *
 * const reporterId = computeReporterId(project.id, localSalt);
 *
 * try {
 *   await integration.operation(input);
 * } catch (err) {
 *   await reportFailure(err, {
 *     integration: "slack-send",
 *     operation: "postMessage",
 *     integrationVersion: "1.4.2",
 *     runtimeVersion: "0.1.0",
 *     config: node.config,
 *     context: { requestMethod: "POST", urlTemplate: "/chat.postMessage" },
 *     reporterId,
 *   }, "https://registry.chorus.dev/v1/reports");
 * }
 * ```
 */

export {
  extractSignature,
  fingerprintApiVersion,
  hashSignature,
  type ExtractSignatureContext,
} from "./signature.js";

export {
  redactString,
  extractShape,
  redactHeaders,
  pseudonymize,
} from "./redact.js";

export { fingerprintConfig } from "./fingerprint.js";

export {
  submitReport,
  RateLimiter,
  type SubmitOptions,
  type SubmitResult,
} from "./submit.js";

export {
  reportFailure,
  computeReporterId,
  type ReportContext,
  type ReportFailureResult,
} from "./pipeline.js";
