import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationError, RateLimitError, type OperationContext, type SnapshotRecorder } from "@chorus/core";
import integration, { parseRetryAfter, request } from "./index.js";

// ── Test scaffolding ────────────────────────────────────────────────────────

interface FakeSnapshot extends SnapshotRecorder {
  calls: Array<{ key: string; request: unknown; response: unknown }>;
}

function makeSnapshot(): FakeSnapshot {
  const calls: FakeSnapshot["calls"] = [];
  return {
    calls,
    async record(key, request, response) {
      calls.push({ key, request, response });
    },
    async replay() {
      return null;
    },
  };
}

function makeContext(opts: { snapshot?: SnapshotRecorder; signal?: AbortSignal } = {}): OperationContext {
  return {
    credentials: null,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    signal: opts.signal ?? new AbortController().signal,
    snapshot: opts.snapshot,
  };
}

/**
 * Build a mock fetch that returns a single scripted response. We manage the
 * full Response shape ourselves so we can simulate status/headers/body triples
 * without reaching out to the network.
 */
function mockFetchOnce(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}): void {
  const mock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    const responseHeaders = new Headers(opts.headers ?? {});
    const text =
      opts.bodyText !== undefined
        ? opts.bodyText
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : "";
    const response = new Response(text, {
      status: opts.status,
      headers: responseHeaders,
    });
    return response;
  });
  vi.stubGlobal("fetch", mock);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@chorus/integration-http-generic module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("http-generic");
    expect(integration.manifest.authType).toBe("none");
    expect(integration.manifest.operations.map((o) => o.name)).toContain("request");
    expect(typeof integration.operations.request).toBe("function");
  });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("request — happy path", () => {
  it("parses JSON response and returns status/headers/body", async () => {
    mockFetchOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
    });

    const snapshot = makeSnapshot();
    const result = await request(
      { url: "https://example.test/api", method: "GET", timeoutMs: 5000 },
      makeContext({ snapshot }),
    );

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toMatch(/json/);
    expect(result.body).toEqual({ hello: "world" });
    // Cassette written with shape, not raw values
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("http-generic.request.200");
  });

  it("serializes object body as JSON with default Content-Type", async () => {
    const mock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      // Inspect the outgoing request — this is the primary assertion
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toMatch(/application\/json/i);
      expect(init?.body).toBe(JSON.stringify({ msg: "hi" }));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", mock);

    await request(
      {
        url: "https://example.test/api",
        method: "POST",
        body: { msg: "hi" },
        timeoutMs: 5000,
      },
      makeContext(),
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it("preserves caller-supplied Content-Type and string body", async () => {
    const mock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("text/xml");
      expect(init?.body).toBe("<x/>");
      // 200 (not 204) because the Response constructor forbids a body on
      // null-body status codes; we want to assert body pass-through too.
      return new Response("<ok/>", { status: 200, headers: { "content-type": "text/xml" } });
    });
    vi.stubGlobal("fetch", mock);

    const result = await request(
      {
        url: "https://example.test/api",
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: "<x/>",
        timeoutMs: 5000,
      },
      makeContext(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe("<ok/>");
  });

  it("records cassette even when no snapshot recorder is provided (noop)", async () => {
    mockFetchOnce({ status: 200, body: {} });
    const result = await request({ url: "https://x.test/a", method: "GET" }, makeContext());
    expect(result.status).toBe(200);
  });
});

// ── 429 rate-limit ──────────────────────────────────────────────────────────

describe("request — 429 rate-limit", () => {
  it("throws RateLimitError with parsed Retry-After seconds", async () => {
    mockFetchOnce({
      status: 429,
      headers: { "retry-after": "30", "content-type": "application/json" },
      body: { error: "rate_limited" },
    });

    const snapshot = makeSnapshot();
    await expect(
      request({ url: "https://example.test/a", method: "GET" }, makeContext({ snapshot })),
    ).rejects.toMatchObject({
      name: "RateLimitError",
      code: "RATE_LIMIT",
      httpStatus: 429,
      retryAfterMs: 30_000,
    });

    // Rate-limit still records a cassette — ARCHITECTURE §8.2 says we
    // record success AND failure shapes.
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("http-generic.request.429");
  });

  it("omits retryAfterMs when header is absent", async () => {
    mockFetchOnce({ status: 429, body: {} });
    try {
      await request({ url: "https://example.test/a", method: "GET" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBeUndefined();
    }
  });
});

// ── 5xx / 4xx ──────────────────────────────────────────────────────────────

describe("request — 4xx/5xx", () => {
  it("throws IntegrationError with httpStatus for 4xx (non-retryable)", async () => {
    mockFetchOnce({ status: 404, body: { not: "found" } });
    try {
      await request({ url: "https://x.test/a", method: "GET" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).httpStatus).toBe(404);
      expect((err as IntegrationError).retryable).toBe(false);
      expect((err as IntegrationError).code).toBe("CLIENT_ERROR");
    }
  });

  it("throws IntegrationError with retryable=true for 5xx", async () => {
    mockFetchOnce({ status: 503, body: "service unavailable" });
    try {
      await request({ url: "https://x.test/a", method: "GET" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(true);
      expect((err as IntegrationError).code).toBe("SERVER_ERROR");
    }
  });
});

// ── Timeout & cancellation ─────────────────────────────────────────────────

describe("request — timeout & cancellation", () => {
  it("aborts and throws TIMEOUT error when request exceeds timeoutMs", async () => {
    // Fetch that never resolves unless aborted
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL, init?: RequestInit) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const reason =
              (init.signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted");
            reject(reason);
          });
        });
      }),
    );

    const start = Date.now();
    await expect(
      request({ url: "https://slow.test/", method: "GET", timeoutMs: 50 }, makeContext()),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("rejects immediately when context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("upstream-cancelled"));
    await expect(
      request(
        { url: "https://x.test/a", method: "GET", timeoutMs: 5000 },
        makeContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

// ── Input validation ──────────────────────────────────────────────────────

describe("request — input validation", () => {
  it("rejects non-URL input before dispatch", async () => {
    await expect(
      request({ url: "not-a-url", method: "GET" } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects timeout beyond 10 minutes", async () => {
    await expect(
      request(
        { url: "https://x.test/", method: "GET", timeoutMs: 10 * 60 * 1000 + 1 } as never,
        makeContext(),
      ),
    ).rejects.toThrow();
  });
});

// ── parseRetryAfter helper ──────────────────────────────────────────────────

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("parses HTTP-date into relative ms", () => {
    const inAMinute = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter(inAMinute);
    expect(result).toBeGreaterThan(50_000);
    expect(result).toBeLessThan(70_000);
  });

  it("returns undefined for garbage", () => {
    expect(parseRetryAfter("banana")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });
});
