import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { RedactedErrorReport } from "@chorus/core";
import { RateLimiter, submitReport } from "./submit.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const REPORT: RedactedErrorReport = {
  signature: {
    schemaVersion: 1,
    integration: "slack-send",
    operation: "postMessage",
    errorClass: "Error",
    httpStatus: 503,
    apiVersion: undefined,
    stackFingerprint: "0123456789abcdef",
    messagePattern: "service unavailable",
    integrationVersion: "1.4.2",
    runtimeVersion: "0.1.0",
    occurrences: 1,
    firstSeen: "2026-04-13T00:00:00.000Z",
    lastSeen: "2026-04-13T00:00:00.000Z",
  },
  configFingerprint: {
    apiKey: "credential:present",
    unfurl_links: true,
  },
  contextShape: {
    requestMethod: "POST",
  },
  reporterId: "0123456789abcdef0123456789abcdef",
  reportedAt: "2026-04-13T00:00:00.100Z",
};

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string>;
  body: string;
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function startServer(handler: Handler): Promise<{
  url: string;
  server: Server;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await collectBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(",") : String(v ?? ""),
        ]),
      ),
      body,
    });
    await handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/reports`, server, requests };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("submitReport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = undefined;
    }
  });

  it("returns accepted:true on a 2xx response", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "rep_123", accepted: true }));
    });
    server = started.server;
    const result = await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
    });
    expect(result.accepted).toBe(true);
    expect(result.id).toBe("rep_123");
    expect(result.statusCode).toBe(201);
  });

  it("carries no PII in the submitted body", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server = started.server;

    // Intentionally inject pseudo-PII into the values that flow through.
    // submit.ts should NOT itself modify the body (that's pipeline.ts's job),
    // but we assert here that the CALLER already redacted everything, AND
    // that nothing accidentally leaks in the submitted JSON.
    const dirtyReport: RedactedErrorReport = {
      ...REPORT,
      signature: {
        ...REPORT.signature,
        messagePattern: "user {redacted:email} failed",
      },
    };

    await submitReport(dirtyReport, started.url, {
      rateLimiter: new RateLimiter(100),
    });

    expect(started.requests.length).toBe(1);
    const sent = started.requests[0]!.body;
    expect(sent).not.toMatch(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    expect(sent).not.toContain("sk_live");
    expect(sent).not.toContain("Bearer ");
    // Positive assertion: the marker survives.
    expect(sent).toContain("{redacted:email}");
  });

  it("retries on 500 and eventually succeeds", async () => {
    let attempts = 0;
    const started = await startServer((_req, res) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(500);
        res.end("boom");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "rep_retry", accepted: true }));
      }
    });
    server = started.server;
    const result = await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
      maxRetries: 5,
      backoffMs: 5,
    });
    expect(result.accepted).toBe(true);
    expect(attempts).toBe(3);
    expect(result.id).toBe("rep_retry");
  });

  it("does NOT retry on 400", async () => {
    let attempts = 0;
    const started = await startServer((_req, res) => {
      attempts++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
    });
    server = started.server;
    const result = await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
      maxRetries: 5,
      backoffMs: 5,
    });
    expect(result.accepted).toBe(false);
    expect(attempts).toBe(1); // no retry
    expect(result.reason).toMatch(/client-error-400/);
    expect(result.statusCode).toBe(400);
  });

  it("surfaces the existingPatch block when present", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          accepted: true,
          signatureHash: "abc",
          existingPatch: {
            id: "slack-send_fix_xyz",
            stage: "canary-10",
            inCohortForThisReporter: false,
          },
        }),
      );
    });
    server = started.server;
    const result = await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
    });
    expect(result.accepted).toBe(true);
    expect(result.existingPatch?.id).toBe("slack-send_fix_xyz");
    expect(result.existingPatch?.stage).toBe("canary-10");
  });

  it("honors the rate limiter", async () => {
    // Allow only 2/min.
    const limiter = new RateLimiter(2);
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server = started.server;

    const r1 = await submitReport(REPORT, started.url, { rateLimiter: limiter });
    const r2 = await submitReport(REPORT, started.url, { rateLimiter: limiter });
    const r3 = await submitReport(REPORT, started.url, { rateLimiter: limiter });
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
    expect(r3.accepted).toBe(false);
    expect(r3.reason).toBe("rate-limited");
  });

  it("short-circuits in localMode (returns accepted:true without network)", async () => {
    // Deliberately use an unreachable URL — if the code tries to hit it,
    // the test hangs / fails. localMode should bypass the network entirely.
    const result = await submitReport(
      REPORT,
      "http://127.0.0.1:1/never",
      {
        rateLimiter: new RateLimiter(100),
        localMode: true,
      },
    );
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("local-mode");
  });

  it("short-circuits when registryUrl is falsy", async () => {
    const result = await submitReport(REPORT, undefined, {
      rateLimiter: new RateLimiter(100),
    });
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("local-mode");
  });

  it("sets the User-Agent header", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server = started.server;
    await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
    });
    expect(started.requests[0]!.headers["user-agent"]).toContain("chorus-reporter/");
  });

  it("attaches the x-chorus-signature header when signingKey supplied", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server = started.server;
    await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
      signingKey: (_body) => "fake-signature-AAA",
    });
    expect(started.requests[0]!.headers["x-chorus-signature"]).toBe("fake-signature-AAA");
  });

  it("surfaces signing failures without contacting the registry", async () => {
    let called = 0;
    const started = await startServer((_req, res) => {
      called++;
      res.writeHead(200);
      res.end();
    });
    server = started.server;
    const result = await submitReport(REPORT, started.url, {
      rateLimiter: new RateLimiter(100),
      signingKey: () => {
        throw new Error("hsm unavailable");
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/signing-failed/);
    expect(called).toBe(0);
  });
});

describe("RateLimiter", () => {
  it("rolls over after 60s", () => {
    const lim = new RateLimiter(1);
    const t0 = 1_000_000;
    expect(lim.tryAcquire(t0)).toBe(true);
    expect(lim.tryAcquire(t0 + 1000)).toBe(false);
    expect(lim.tryAcquire(t0 + 60_500)).toBe(true);
  });

  it("reports remaining slots", () => {
    const lim = new RateLimiter(3);
    expect(lim.remaining()).toBe(3);
    lim.tryAcquire();
    expect(lim.remaining()).toBe(2);
  });
});
