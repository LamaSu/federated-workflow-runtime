import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type OperationContext,
  type SnapshotRecorder,
} from "@chorus/core";
import integration, {
  extractBearerToken,
  isSlackRetryable,
  parseRetryAfter,
  postMessage,
} from "./index.js";

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

function makeContext(opts: {
  credentials?: Record<string, unknown> | string | null;
  snapshot?: SnapshotRecorder;
  signal?: AbortSignal;
} = {}): OperationContext {
  // Distinguish "not passed" (use default token) from "explicitly null" (no creds).
  const creds =
    "credentials" in opts ? opts.credentials : { accessToken: "xoxb-test-token" };
  return {
    credentials: creds as OperationContext["credentials"],
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
 * Install a mock fetch with a prepared response. Also captures the RequestInit
 * so tests can assert on outgoing headers/body.
 */
function installMockFetch(responder: (init: RequestInit | undefined) => Response | Promise<Response>): {
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    return responder(init);
  });
  vi.stubGlobal("fetch", mock);
  return { mock };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@chorus-integrations/slack-send module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("slack-send");
    expect(integration.manifest.authType).toBe("bearer");
    expect(integration.manifest.operations.map((o) => o.name)).toContain("postMessage");
    expect(typeof integration.operations.postMessage).toBe("function");
  });
});

// ── Happy path + bearer header ─────────────────────────────────────────────

describe("postMessage — happy path", () => {
  it("sends bearer token in Authorization header and returns ts/channel", async () => {
    const { mock } = installMockFetch((init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer xoxb-test-token");
      expect(headers.get("content-type")).toMatch(/application\/json/i);
      return new Response(
        JSON.stringify({ ok: true, ts: "1234567890.000100", channel: "C01ABC" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const snapshot = makeSnapshot();
    const result = await postMessage(
      { channel: "C01ABC", text: "hello" },
      makeContext({ snapshot }),
    );
    expect(result).toEqual({ ts: "1234567890.000100", channel: "C01ABC" });
    expect(mock).toHaveBeenCalledOnce();
    expect(snapshot.calls[0]!.key).toBe("slack-send.postMessage.200");
  });

  it("passes blocks and thread_ts through to wire body", async () => {
    const { mock } = installMockFetch((init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]);
      expect(body.thread_ts).toBe("9999.0001");
      expect(body.text).toBe("hi");
      return new Response(
        JSON.stringify({ ok: true, ts: "1.0", channel: "C01ABC" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await postMessage(
      {
        channel: "C01ABC",
        text: "hi",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
        threadTs: "9999.0001",
      },
      makeContext(),
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it("accepts a plain string token credential", async () => {
    installMockFetch(() =>
      new Response(JSON.stringify({ ok: true, ts: "1.0", channel: "C" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await postMessage(
      { channel: "C", text: "hi" },
      makeContext({ credentials: "xoxb-plain-token" as never }),
    );
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe("postMessage — auth", () => {
  it("throws AuthError when no credential is present", async () => {
    await expect(
      postMessage({ channel: "C", text: "hi" }, makeContext({ credentials: null })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 401 HTTP to AuthError", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const snapshot = makeSnapshot();
    await expect(
      postMessage({ channel: "C", text: "hi" }, makeContext({ snapshot })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(snapshot.calls[0]!.key).toBe("slack-send.postMessage.401");
  });

  it("maps Slack ok:false auth-shaped errors to AuthError", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "token_revoked" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      postMessage({ channel: "C", text: "hi" }, makeContext()),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

// ── Rate limit ─────────────────────────────────────────────────────────────

describe("postMessage — rate limit", () => {
  it("throws RateLimitError with retryAfterMs from Retry-After seconds", async () => {
    installMockFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "45" },
        }),
    );
    const snapshot = makeSnapshot();
    await postMessage({ channel: "C", text: "hi" }, makeContext({ snapshot })).catch((err) => {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(45_000);
    });
    expect(snapshot.calls[0]!.key).toBe("slack-send.postMessage.429");
  });

  it("defaults retryAfterMs to 30s when header missing", async () => {
    installMockFetch(() => new Response("", { status: 429 }));
    try {
      await postMessage({ channel: "C", text: "hi" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30_000);
    }
  });

  it("treats ok:false ratelimited as RateLimitError", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 200,
          headers: { "content-type": "application/json", "retry-after": "10" },
        }),
    );
    try {
      await postMessage({ channel: "C", text: "hi" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(10_000);
    }
  });
});

// ── Slack ok:false terminal errors ─────────────────────────────────────────

describe("postMessage — Slack API errors", () => {
  it("surfaces unknown slack error as SLACK_<CODE> IntegrationError", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await postMessage({ channel: "C", text: "hi" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("SLACK_CHANNEL_NOT_FOUND");
      expect((err as IntegrationError).retryable).toBe(false);
    }
  });

  it("flags internal_error as retryable", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await postMessage({ channel: "C", text: "hi" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });

  it("treats 5xx HTTP as retryable SLACK_SERVER_ERROR", async () => {
    installMockFetch(() => new Response("{}", { status: 503 }));
    try {
      await postMessage({ channel: "C", text: "hi" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("SLACK_SERVER_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });
});

// ── Validation ─────────────────────────────────────────────────────────────

describe("postMessage — input validation", () => {
  it("rejects empty channel", async () => {
    await expect(
      postMessage({ channel: "", text: "hi" } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects text over 40000 chars", async () => {
    await expect(
      postMessage({ channel: "C", text: "x".repeat(40_001) } as never, makeContext()),
    ).rejects.toThrow();
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("extractBearerToken handles multiple credential shapes", () => {
    expect(extractBearerToken("abc")).toBe("abc");
    expect(extractBearerToken({ accessToken: "abc" })).toBe("abc");
    expect(extractBearerToken({ token: "abc" })).toBe("abc");
    expect(extractBearerToken({ bearer: "abc" })).toBe("abc");
    expect(extractBearerToken({ irrelevant: 1 } as never)).toBeUndefined();
    expect(extractBearerToken(null)).toBeUndefined();
  });

  it("parseRetryAfter handles seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });

  it("isSlackRetryable matches known transient errors", () => {
    expect(isSlackRetryable("internal_error")).toBe(true);
    expect(isSlackRetryable("ratelimited")).toBe(true);
    expect(isSlackRetryable("channel_not_found")).toBe(false);
  });
});
