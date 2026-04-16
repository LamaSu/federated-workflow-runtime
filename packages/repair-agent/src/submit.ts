import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ErrorSignature } from "@delightfulchorus/core";
import type {
  PatchProposal,
  SubmissionMode,
  SubmissionResult,
} from "./types.js";

export interface SubmitOptions {
  registryUrl?: string;
  /** Opaque signing key material (Ed25519 or sigstore config). */
  signingKey?: string;
  /** Override private-mode path. Default ~/.chorus/patches/pending/. */
  privateDir?: string;
  /** Inject fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** User's current reputation. */
  reputation: number;
  /** Minimum reputation for community mode. Default 100. */
  communityRepFloor?: number;
}

export class ReputationFloorError extends Error {
  readonly required: number;
  readonly actual: number;
  constructor(required: number, actual: number) {
    super(
      `need rep \u2265${required} for auto-community submission (you have ${actual})`,
    );
    this.name = "ReputationFloorError";
    this.required = required;
    this.actual = actual;
  }
}

export class RegistrySubmitError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RegistrySubmitError";
    this.status = status;
  }
}

/**
 * Submit a patch proposal, enforcing reputation floor for community mode and
 * writing to a local pending dir for private mode.
 */
export async function submitPatchProposal(
  proposal: PatchProposal,
  sig: ErrorSignature,
  mode: SubmissionMode,
  opts: SubmitOptions,
): Promise<SubmissionResult> {
  const floor = opts.communityRepFloor ?? 100;

  if (mode === "community") {
    if (opts.reputation < floor) {
      throw new ReputationFloorError(floor, opts.reputation);
    }
    return submitCommunity(proposal, sig, opts);
  }

  return submitPrivate(proposal, sig, opts);
}

async function submitPrivate(
  proposal: PatchProposal,
  sig: ErrorSignature,
  opts: SubmitOptions,
): Promise<SubmissionResult> {
  const baseDir =
    opts.privateDir ?? join(homedir(), ".chorus", "patches", "pending");
  await mkdir(baseDir, { recursive: true });

  const patchId = deriveId(sig, proposal);
  const file = join(baseDir, `${patchId}.json`);
  const payload = {
    patchId,
    signatureHash: hashSig(sig),
    integration: sig.integration,
    operation: sig.operation,
    proposal,
    submittedAt: new Date().toISOString(),
    signingKey: opts.signingKey ? "present" : "absent",
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");

  return {
    mode: "private",
    location: file,
    patchId,
    submittedAt: payload.submittedAt,
  };
}

async function submitCommunity(
  proposal: PatchProposal,
  sig: ErrorSignature,
  opts: SubmitOptions,
): Promise<SubmissionResult> {
  if (!opts.registryUrl) {
    throw new Error("community submission requires registryUrl");
  }
  if (!opts.signingKey) {
    throw new Error("community submission requires signingKey");
  }

  const url = opts.registryUrl.replace(/\/+$/, "") + "/v1/patches/propose";
  const patchId = deriveId(sig, proposal);
  const submittedAt = new Date().toISOString();

  const body = JSON.stringify({
    patchId,
    signatureHash: hashSig(sig),
    integration: sig.integration,
    operation: sig.operation,
    proposal,
    submittedAt,
  });

  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chorus-signing-key": opts.signingKey,
      "x-chorus-reputation": String(opts.reputation),
    },
    body,
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new RegistrySubmitError(
      res.status,
      `registry rejected submission (status ${res.status}): ${text}`,
    );
  }

  const respData = (await safeJson(res)) as {
    patchId?: string;
    location?: string;
  } | null;

  return {
    mode: "community",
    location: respData?.location ?? url,
    patchId: respData?.patchId ?? patchId,
    submittedAt,
  };
}

function hashSig(sig: ErrorSignature): string {
  const canonical = JSON.stringify({
    integration: sig.integration,
    operation: sig.operation,
    errorClass: sig.errorClass,
    httpStatus: sig.httpStatus ?? null,
    stackFingerprint: sig.stackFingerprint,
    messagePattern: sig.messagePattern,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function deriveId(sig: ErrorSignature, proposal: PatchProposal): string {
  const h = createHash("sha256");
  h.update(sig.integration);
  h.update(":");
  h.update(sig.operation);
  h.update(":");
  h.update(sig.errorClass);
  h.update(":");
  h.update(proposal.diff);
  const digest = h.digest("hex").slice(0, 12);
  const salt = randomBytes(3).toString("hex");
  return `${sig.integration}_${sig.errorClass.toLowerCase()}_${digest}${salt}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
