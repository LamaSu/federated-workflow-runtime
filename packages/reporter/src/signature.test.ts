import { describe, expect, it } from "vitest";
import { ChorusError, hashSignature } from "@delightfulchorus/core";
import {
  extractSignature,
  fingerprintApiVersion,
  type ExtractSignatureContext,
} from "./signature.js";

const baseCtx: ExtractSignatureContext = {
  integration: "slack-send",
  operation: "postMessage",
  integrationVersion: "1.4.2",
  runtimeVersion: "0.1.0",
};

describe("extractSignature", () => {
  it("produces a valid ErrorSignature from a plain Error", () => {
    const err = new Error("boom");
    const sig = extractSignature(err, baseCtx);

    expect(sig.schemaVersion).toBe(1);
    expect(sig.integration).toBe("slack-send");
    expect(sig.operation).toBe("postMessage");
    expect(sig.errorClass).toBe("Error");
    expect(sig.messagePattern).toContain("boom");
    expect(sig.integrationVersion).toBe("1.4.2");
    expect(sig.runtimeVersion).toBe("0.1.0");
    expect(sig.occurrences).toBe(1);
    expect(sig.firstSeen).toBe(sig.lastSeen);
    // stack fingerprint is either "no-stack" or 16 hex chars
    expect(sig.stackFingerprint).toMatch(/^[a-f0-9]{16}$|^no-stack$/);
  });

  it("pulls httpStatus off a ChorusError", () => {
    const err = new ChorusError({
      code: "HTTP",
      message: "Service Unavailable",
      httpStatus: 503,
    });
    const sig = extractSignature(err, baseCtx);
    expect(sig.httpStatus).toBe(503);
    expect(sig.errorClass).toBe("ChorusError");
  });

  it("falls back to httpMeta.status when the error has none", () => {
    const err = new Error("timeout");
    const sig = extractSignature(err, {
      ...baseCtx,
      httpMeta: { status: 504, statusText: "Gateway Timeout" },
    });
    expect(sig.httpStatus).toBe(504);
    expect(sig.httpStatusText).toBe("Gateway Timeout");
  });

  it("produces identical signature hashes for the same error twice", () => {
    const mk = () => new Error("schema mismatch on field `foo`");
    const s1 = extractSignature(mk(), { ...baseCtx, now: "2026-01-01T00:00:00.000Z" });
    const s2 = extractSignature(mk(), { ...baseCtx, now: "2027-06-05T00:00:00.000Z" });
    // Different timestamps but the hash-relevant fields should collide.
    expect(hashSignature(s1)).toBe(hashSignature(s2));
  });

  it("produces DIFFERENT hashes for different error classes", () => {
    const s1 = extractSignature(new Error("x"), baseCtx);
    const s2 = extractSignature(new TypeError("x"), baseCtx);
    expect(hashSignature(s1)).not.toBe(hashSignature(s2));
  });

  it("produces DIFFERENT hashes for different integrations", () => {
    const s1 = extractSignature(new Error("x"), baseCtx);
    const s2 = extractSignature(new Error("x"), {
      ...baseCtx,
      integration: "http-generic",
    });
    expect(hashSignature(s1)).not.toBe(hashSignature(s2));
  });

  it("stabilizes UUIDs and long numbers in the message pattern", () => {
    const err = new Error(
      "resource 11111111-2222-3333-4444-555555555555 not found, 4567890123 retries",
    );
    const sig = extractSignature(err, baseCtx);
    expect(sig.messagePattern).not.toContain("11111111-2222");
    expect(sig.messagePattern).toContain("{uuid}");
    // Long numbers become `{n}`
    expect(sig.messagePattern).toContain("{n}");
  });

  it("handles a string throw", () => {
    const sig = extractSignature("plain string throw", baseCtx);
    expect(sig.errorClass).toBe("StringThrow");
    expect(sig.messagePattern).toContain("plain string throw");
  });

  it("handles an object throw", () => {
    const sig = extractSignature({ kind: "weird" }, baseCtx);
    expect(sig.errorClass).toBe("ObjectThrow");
  });

  it("handles undefined throw", () => {
    const sig = extractSignature(undefined, baseCtx);
    expect(sig.errorClass).toBe("UnknownError");
    expect(sig.messagePattern.length).toBeGreaterThanOrEqual(0);
  });

  it("uses ctx.now when supplied", () => {
    const now = "2026-04-13T12:34:56.000Z";
    const sig = extractSignature(new Error("x"), { ...baseCtx, now });
    expect(sig.firstSeen).toBe(now);
    expect(sig.lastSeen).toBe(now);
  });
});

describe("fingerprintApiVersion", () => {
  it("returns undefined for no headers", () => {
    expect(fingerprintApiVersion(undefined)).toBeUndefined();
    expect(fingerprintApiVersion({})).toBeUndefined();
  });

  it("reads Stripe-Version", () => {
    expect(
      fingerprintApiVersion({ "Stripe-Version": "2023-10-16" }),
    ).toBe("2023-10-16");
  });

  it("reads Api-Version (case-insensitive)", () => {
    expect(fingerprintApiVersion({ "API-Version": "2024-02-01" })).toBe(
      "2024-02-01",
    );
  });

  it("reads X-Api-Version", () => {
    expect(fingerprintApiVersion({ "x-api-version": "v3.1" })).toBe("v3.1");
  });

  it("parses `accept: application/vnd.foo+json;version=7`", () => {
    expect(
      fingerprintApiVersion({
        accept: "application/vnd.foo+json; version=7",
      }),
    ).toBe("7");
  });

  it("parses `accept: application/vnd.foo.v3+json`", () => {
    expect(
      fingerprintApiVersion({ accept: "application/vnd.foo.v3+json" }),
    ).toBe("v3");
  });

  it("clamps absurdly long values", () => {
    const long = "x".repeat(500);
    const out = fingerprintApiVersion({ "api-version": long });
    expect(out!.length).toBeLessThanOrEqual(64);
  });
});
