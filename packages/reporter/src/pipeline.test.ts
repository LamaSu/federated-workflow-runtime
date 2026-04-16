import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { ChorusError } from "@delightfulchorus/core";
import {
  computeReporterId,
  reportFailure,
  type ReportContext,
} from "./pipeline.js";
import { RateLimiter } from "./submit.js";

interface Capture {
  url: string;
  server: Server;
  requests: { body: string; headers: Record<string, string> }[];
}

async function startCapture(
  status = 200,
  responseBody = "{}",
): Promise<Capture> {
  const requests: Capture["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(",") : String(v ?? ""),
          ]),
        ),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/reports`, server, requests };
}

describe("reportFailure — end-to-end pipeline", () => {
  let cap: Capture | undefined;

  afterEach(async () => {
    if (cap) {
      await new Promise<void>((resolve) => cap!.server.close(() => resolve()));
      cap = undefined;
    }
  });

  const baseCtx: ReportContext = {
    integration: "slack-send",
    operation: "postMessage",
    integrationVersion: "1.4.2",
    runtimeVersion: "0.1.0",
    reporterId: "0123456789abcdef0123456789abcdef",
  };

  it("submits a well-formed RedactedErrorReport that parses as valid JSON", async () => {
    cap = await startCapture(201, JSON.stringify({ id: "rep_1", accepted: true }));
    const result = await reportFailure(
      new ChorusError({
        code: "HTTP",
        message: "service unavailable",
        httpStatus: 503,
      }),
      baseCtx,
      cap.url,
      { rateLimiter: new RateLimiter(100) },
    );

    expect(result.submitted).toBe(true);
    expect(result.signatureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cap.requests.length).toBe(1);

    const parsed = JSON.parse(cap.requests[0]!.body) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.report).toBeDefined();
    const report = parsed.report as Record<string, unknown>;
    expect((report.signature as Record<string, unknown>).integration).toBe("slack-send");
    expect((report.signature as Record<string, unknown>).httpStatus).toBe(503);
  });

  it("NO raw email, token, or credit-card value leaks even on deeply nested errors", async () => {
    cap = await startCapture();

    // Craft an error whose message, stack, config, and context all include
    // nasties. None of them should survive in the wire body.
    const deepError = new Error(
      "Login failure for alice@example.com using card 4242 4242 4242 4242 via 192.168.1.42",
    );

    const dirtyContext: ReportContext = {
      ...baseCtx,
      config: {
        apiKey: ["sk", "live", "51HxZqZJKFaabbccDDEEff00112233445566778899"].join("_"),
        baseUrl: "https://api.acme.io",
        adminEmail: "ceo@acme.com",
        retries: 3,
        unfurl: true,
      },
      context: {
        requestMethod: "post",
        urlTemplate: "/v1/users/bob@acme.com",
        requestBody: {
          user: {
            email: "bob@acme.com",
            password: "hunter2",
            ssn: "123-45-6789",
            cardNumber: "4242 4242 4242 4242",
            nested: { token: "Bearer eyJhbGciOiJIUzI1NiIsAAAAAAAAAAAAAA" },
          },
        },
        responseHeaders: {
          Authorization: "Bearer abc123XYZdef456GHIjkl789",
          "Set-Cookie": "sid=supersecret",
          "Content-Type": "application/json",
        },
        durationMs: 1234.7,
        retryCount: 2,
      },
    };

    const result = await reportFailure(deepError, dirtyContext, cap.url, {
      rateLimiter: new RateLimiter(100),
    });
    expect(result.submitted).toBe(true);
    expect(cap.requests.length).toBe(1);

    const wireBody = cap.requests[0]!.body;

    // ── Email ────────────────────────────────────────────────
    expect(wireBody).not.toContain("alice@example.com");
    expect(wireBody).not.toContain("bob@acme.com");
    expect(wireBody).not.toContain("ceo@acme.com");

    // ── Credit card ──────────────────────────────────────────
    expect(wireBody).not.toContain("4242 4242 4242 4242");
    expect(wireBody).not.toContain("4242424242424242");

    // ── IPv4 ─────────────────────────────────────────────────
    expect(wireBody).not.toContain("192.168.1.42");

    // ── API key (Stripe-style) ────────────────────────────────
    expect(wireBody).not.toContain("sk_live_51HxZqZJKFa");

    // ── JWT / Bearer ──────────────────────────────────────────
    expect(wireBody).not.toContain("eyJhbGciOiJIUzI1Ni");
    expect(wireBody).not.toContain("abc123XYZdef456GHIjkl");

    // ── SSN ──────────────────────────────────────────────────
    expect(wireBody).not.toContain("123-45-6789");

    // ── Passwords / cookies ──────────────────────────────────
    expect(wireBody).not.toContain("hunter2");
    expect(wireBody).not.toContain("supersecret");

    // Positive assertions — the REPORT is still useful.
    const parsed = JSON.parse(wireBody) as Record<string, unknown>;
    const report = parsed.report as Record<string, unknown>;
    const sig = report.signature as Record<string, unknown>;
    expect(sig.integration).toBe("slack-send");
    expect(sig.operation).toBe("postMessage");
    expect(sig.errorClass).toBe("Error");
    expect(typeof sig.stackFingerprint).toBe("string");
    // Message pattern exists (may be redacted / stabilized), but no raw PII.
    expect(typeof sig.messagePattern).toBe("string");
    expect((sig.messagePattern as string).length).toBeGreaterThan(0);

    // configFingerprint preserves knobs, redacts secrets.
    const fp = report.configFingerprint as Record<string, unknown>;
    expect(fp.apiKey).toBe("credential:present");
    expect(fp.unfurl).toBe(true);
    expect(fp.retries).toBe(3);
    expect(fp.baseUrl).toBe("string:url");

    // contextShape: method survives, url template redacted, body shape-only.
    const ctx = report.contextShape as Record<string, unknown>;
    expect(ctx.requestMethod).toBe("POST");
    expect(ctx.urlTemplate).not.toContain("bob@acme.com");
    expect(typeof ctx.requestShape).toBe("string");
    expect(ctx.requestShape).not.toContain("bob@acme.com");
    expect(ctx.requestShape).not.toContain("hunter2");
  });

  it("surfaces existingPatch when the registry already has one", async () => {
    cap = await startCapture(
      200,
      JSON.stringify({
        accepted: true,
        signatureHash: "abc",
        existingPatch: {
          id: "slack-send_foo_abc",
          stage: "fleet",
          inCohortForThisReporter: true,
        },
      }),
    );
    const result = await reportFailure(
      new Error("x"),
      baseCtx,
      cap.url,
      { rateLimiter: new RateLimiter(100) },
    );
    expect(result.submitted).toBe(true);
    expect(result.existingPatch?.id).toBe("slack-send_foo_abc");
  });

  it("fail-closed: submits nothing when validation fails upstream", async () => {
    cap = await startCapture();
    const badCtx: ReportContext = {
      ...baseCtx,
      // bogus reporterId that won't match the schema regex
      reporterId: "not-a-valid-hex",
    };
    const result = await reportFailure(new Error("x"), badCtx, cap.url, {
      rateLimiter: new RateLimiter(100),
    });
    expect(result.submitted).toBe(false);
    expect(result.reason).toMatch(/validation-failed/);
    expect(cap.requests.length).toBe(0);
  });

  it("returns accepted:true in local mode without hitting the network", async () => {
    const result = await reportFailure(
      new Error("local"),
      baseCtx,
      undefined, // no registry
      { rateLimiter: new RateLimiter(100) },
    );
    expect(result.submitted).toBe(true);
    expect(result.signatureHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces identical signature hashes for the same failure mode", async () => {
    cap = await startCapture();
    const r1 = await reportFailure(new Error("boom"), baseCtx, cap.url, {
      rateLimiter: new RateLimiter(100),
    });
    const r2 = await reportFailure(new Error("boom"), baseCtx, cap.url, {
      rateLimiter: new RateLimiter(100),
    });
    expect(r1.signatureHash).toBe(r2.signatureHash);
  });

  it("hash-relevant fields differ for different integrations", async () => {
    const r1 = await reportFailure(new Error("boom"), baseCtx, undefined);
    const r2 = await reportFailure(
      new Error("boom"),
      { ...baseCtx, integration: "http-generic" },
      undefined,
    );
    expect(r1.signatureHash).not.toBe(r2.signatureHash);
  });
});

describe("computeReporterId", () => {
  it("returns a stable 32-hex id for the same inputs", () => {
    const a = computeReporterId("project-x", "salt-1");
    const b = computeReporterId("project-x", "salt-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("changes when project id or salt changes", () => {
    const a = computeReporterId("proj-a", "s");
    const b = computeReporterId("proj-b", "s");
    const c = computeReporterId("proj-a", "t");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
