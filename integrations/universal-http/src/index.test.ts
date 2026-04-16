/**
 * @delightfulchorus/integration-universal-http — tests
 *
 * These exercise the catalog-driven dispatch path end-to-end with a mocked
 * fetch. We rely on the real @delightfulchorus/service-catalog package as the
 * source of truth — that's the whole point of having the catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type OperationContext,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import integration, {
  call,
  composeUrl,
  fillTemplate,
  parseRetryAfter,
  pickAuthType,
  pickOperation,
  renderAuthHeader,
} from "./index.js";
import { getService } from "@delightfulchorus/service-catalog";

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
  credentials?: Record<string, unknown> | null;
  snapshot?: SnapshotRecorder;
  signal?: AbortSignal;
} = {}): OperationContext {
  const creds = "credentials" in opts ? opts.credentials : null;
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

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Stub fetch and capture the URL + init of each call. The responder decides
 * what to return based on either the URL (URL-keyed lookup) or a simple
 * counter-based script (first call, second call, ...).
 */
function installMockFetch(
  responder: (call: MockFetchCall) => Response | Promise<Response>,
): { mock: ReturnType<typeof vi.fn>; captured: MockFetchCall[] } {
  const captured: MockFetchCall[] = [];
  const mock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const c: MockFetchCall = { url: String(url), init };
    captured.push(c);
    return responder(c);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, captured };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@delightfulchorus/integration-universal-http module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("universal-http");
    expect(integration.manifest.operations.map((o) => o.name)).toEqual(["call"]);
    expect(typeof integration.operations.call).toBe("function");
    // credentialTypes is empty by design — credentials come from the catalog.
    expect(integration.manifest.credentialTypes).toEqual([]);
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("fillTemplate substitutes {name} placeholders with URL-encoded values", () => {
    expect(fillTemplate("/users/{id}", { id: "42" })).toBe("/users/42");
    expect(fillTemplate("/users/{id}", { id: "a b" })).toBe("/users/a%20b");
  });

  it("fillTemplate throws when a placeholder has no value", () => {
    expect(() => fillTemplate("/users/{id}", {})).toThrow(/missing path/);
  });

  it("renderAuthHeader subs plain {fields} for Bearer", () => {
    expect(
      renderAuthHeader("Bearer {accessToken}", { accessToken: "tok123" }),
    ).toBe("Bearer tok123");
  });

  it("renderAuthHeader handles {base64:u:p} for Basic auth", () => {
    const header = renderAuthHeader(
      "Basic {base64:username:password}",
      { username: "user", password: "pass" },
    );
    // Basic: "user:pass" base64 is "dXNlcjpwYXNz"
    expect(header).toBe("Basic dXNlcjpwYXNz");
  });

  it("renderAuthHeader throws when a field is missing", () => {
    expect(() =>
      renderAuthHeader("Bearer {accessToken}", {}),
    ).toThrow(/accessToken/);
  });

  it("composeUrl respects absolute paths", () => {
    expect(composeUrl("https://api.ex.com", "/v1/foo", undefined)).toBe(
      "https://api.ex.com/v1/foo",
    );
    expect(
      composeUrl("https://api.ex.com", "https://other.host/abs", undefined),
    ).toBe("https://other.host/abs");
  });

  it("composeUrl merges query params", () => {
    expect(
      composeUrl("https://api.ex.com", "/v1/foo", { a: "1", b: 2, c: true }),
    ).toBe("https://api.ex.com/v1/foo?a=1&b=2&c=true");
  });

  it("parseRetryAfter handles delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });

  it("parseRetryAfter returns undefined for garbage", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });

  it("pickAuthType picks by id or falls back to first", () => {
    const gh = getService("github")!;
    expect(pickAuthType(gh, "githubPAT")!.id).toBe("githubPAT");
    expect(pickAuthType(gh, undefined)!.id).toBe("githubPAT");
    expect(pickAuthType(gh, "nonsense")).toBeNull();
  });

  it("pickOperation finds by id or returns null", () => {
    const gh = getService("github")!;
    expect(pickOperation(gh, "create-issue")!.method).toBe("POST");
    expect(pickOperation(gh, "does-not-exist")).toBeNull();
  });
});

// ── Unknown service ─────────────────────────────────────────────────────────

describe("call — unknown serviceId", () => {
  it("throws IntegrationError UNKNOWN_SERVICE", async () => {
    installMockFetch(() => new Response("", { status: 200 }));
    const snapshot = makeSnapshot();
    await expect(
      call(
        { serviceId: "notAService", operationId: "x" } as any,
        makeContext({ snapshot, credentials: {} }),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof IntegrationError)) return false;
      return err.code === "UNKNOWN_SERVICE";
    });
  });

  it("throws IntegrationError UNKNOWN_OPERATION for missing op", async () => {
    installMockFetch(() => new Response("", { status: 200 }));
    const snapshot = makeSnapshot();
    await expect(
      call(
        { serviceId: "github", operationId: "does-not-exist" },
        makeContext({ snapshot, credentials: { accessToken: "tok" } }),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof IntegrationError)) return false;
      return err.code === "UNKNOWN_OPERATION";
    });
  });
});

// ── GitHub: catalog mode, PAT bearer, path params ──────────────────────────

describe("call — GitHub PAT (bearer, path params)", () => {
  it("builds correct URL + Bearer header + records cassette on 201", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(201, { number: 42, title: "hi" }),
    );
    const snapshot = makeSnapshot();

    const out = await call(
      {
        serviceId: "github",
        operationId: "create-issue",
        authTypeId: "githubPAT",
        pathParams: { owner: "acme", repo: "widget" },
        body: { title: "hi" },
      },
      makeContext({
        snapshot,
        credentials: { accessToken: "ghp_test" },
      }),
    );

    expect(out.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.github.com/repos/acme/widget/issues");
    expect(captured[0]!.init!.method).toBe("POST");
    const sentHeaders = captured[0]!.init!.headers as Record<string, string>;
    expect(sentHeaders["Authorization"]).toBe("Bearer ghp_test");
    expect(sentHeaders["Content-Type"]).toBe("application/json");
    expect(captured[0]!.init!.body).toBe(JSON.stringify({ title: "hi" }));

    // Cassette recorded
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("universal-http.call.github.create-issue.201");
  });

  it("rejects with AuthError on 401", async () => {
    installMockFetch(() => jsonResponse(401, { message: "Bad creds" }));
    const snapshot = makeSnapshot();

    await expect(
      call(
        { serviceId: "github", operationId: "get-authenticated-user" },
        makeContext({
          snapshot,
          credentials: { accessToken: "ghp_bad" },
        }),
      ),
    ).rejects.toBeInstanceOf(AuthError);

    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("universal-http.call.github.get-authenticated-user.401");
  });
});

// ── 429 RateLimit with Retry-After ─────────────────────────────────────────

describe("call — 429 RateLimit", () => {
  it("raises RateLimitError and parses Retry-After", async () => {
    installMockFetch(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "120" },
        }),
    );

    const snapshot = makeSnapshot();
    try {
      await call(
        { serviceId: "github", operationId: "get-authenticated-user" },
        makeContext({
          snapshot,
          credentials: { accessToken: "ghp_tok" },
        }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(120_000);
    }
  });
});

// ── Anthropic: x-api-key header (format variation) ─────────────────────────

describe("call — Anthropic (x-api-key header)", () => {
  it("sends x-api-key with the raw apiKey (no 'Bearer' prefix)", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(200, { content: [] }),
    );

    await call(
      {
        serviceId: "anthropic",
        operationId: "create-message",
        body: { model: "claude-3-5-sonnet-20241022", max_tokens: 1, messages: [] },
      },
      makeContext({
        credentials: { apiKey: "sk-ant-test" },
      }),
    );

    const sentHeaders = captured[0]!.init!.headers as Record<string, string>;
    expect(sentHeaders["x-api-key"]).toBe("sk-ant-test");
    expect(sentHeaders["Authorization"]).toBeUndefined();
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });
});

// ── Notion: Bearer token, second auth type ────────────────────────────────

describe("call — Notion (Bearer)", () => {
  it("sends Authorization: Bearer for notion integration token", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(200, { results: [] }),
    );

    await call(
      { serviceId: "notion", operationId: "get-me" },
      makeContext({
        credentials: { accessToken: "secret_notion" },
      }),
    );

    const sentHeaders = captured[0]!.init!.headers as Record<string, string>;
    expect(sentHeaders["Authorization"]).toBe("Bearer secret_notion");
    expect(captured[0]!.url).toBe("https://api.notion.com/v1/users/me");
  });
});

// ── OAuth2 service (Google Sheets) — default Bearer via accessToken ───────

describe("call — Google Sheets OAuth2 (Bearer)", () => {
  it("sends Authorization: Bearer from oauth accessToken", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(200, { spreadsheetId: "abc" }),
    );

    await call(
      {
        serviceId: "google-sheets",
        operationId: "get-spreadsheet",
        pathParams: { spreadsheetId: "sheetABC" },
      },
      makeContext({
        credentials: {
          accessToken: "ya29.oauth-token",
          refreshToken: "refresh123",
        },
      }),
    );

    const sentHeaders = captured[0]!.init!.headers as Record<string, string>;
    expect(sentHeaders["Authorization"]).toBe("Bearer ya29.oauth-token");
    expect(captured[0]!.url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheetABC",
    );
  });
});

// ── Twilio: Basic auth with base64 encoding ───────────────────────────────

describe("call — Twilio (HTTP Basic, base64 encoding)", () => {
  it("sends Authorization: Basic base64(user:pass)", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(201, { sid: "SMxxx" }),
    );

    await call(
      {
        serviceId: "twilio",
        operationId: "send-sms",
        authTypeId: "twilioBasic",
        pathParams: { AccountSid: "ACabc" },
        body: { To: "+15551234567", From: "+15557654321", Body: "hi" },
      },
      makeContext({
        credentials: { username: "ACabc", password: "secret" },
      }),
    );

    const sentHeaders = captured[0]!.init!.headers as Record<string, string>;
    // "ACabc:secret" base64 = "QUNhYmM6c2VjcmV0"
    expect(sentHeaders["Authorization"]).toBe("Basic QUNhYmM6c2VjcmV0");
    expect(captured[0]!.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACabc/Messages.json",
    );
    // Twilio endpoint is form-encoded, not JSON.
    expect(sentHeaders["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // Body should be URL-encoded, not JSON.
    expect(captured[0]!.init!.body).toContain("To=%2B15551234567");
    expect(captured[0]!.init!.body).toContain("Body=hi");
  });
});

// ── Telegram: auth-in-URL (token as path segment) ─────────────────────────

describe("call — Telegram (bot token in URL)", () => {
  it("fills {botToken} from credentials into the path", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(200, { ok: true, result: { message_id: 42 } }),
    );

    await call(
      {
        serviceId: "telegram",
        operationId: "send-message",
        body: { chat_id: 12345, text: "hi" },
      },
      makeContext({
        credentials: { botToken: "111:ABC" },
      }),
    );

    // Telegram token is base-case URL-encoded — ':' stays, 'A' stays, etc.
    expect(captured[0]!.url).toBe(
      "https://api.telegram.org/bot111%3AABC/sendMessage",
    );
  });
});

// ── Ad-hoc mode (method + path) ───────────────────────────────────────────

describe("call — ad-hoc mode (method + path)", () => {
  it("dispatches without operationId", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(200, { data: "hello" }),
    );

    const out = await call(
      {
        serviceId: "github",
        method: "GET",
        path: "/gitignore/templates",
      },
      makeContext({
        credentials: { accessToken: "ghp_tok" },
      }),
    );

    expect(out.status).toBe(200);
    expect(captured[0]!.url).toBe(
      "https://api.github.com/gitignore/templates",
    );
    expect(captured[0]!.init!.method).toBe("GET");
  });

  it("rejects when both operationId and method+path are missing", async () => {
    installMockFetch(() => new Response("", { status: 200 }));
    await expect(
      call({ serviceId: "github" } as any, makeContext({ credentials: {} })),
    ).rejects.toThrow();
  });
});

// ── Query params get appended ─────────────────────────────────────────────

describe("call — query parameters", () => {
  it("appends query string to URL", async () => {
    const { captured } = installMockFetch(() => jsonResponse(200, []));

    await call(
      {
        serviceId: "github",
        operationId: "list-repos",
        query: { per_page: 10, type: "owner" },
      },
      makeContext({
        credentials: { accessToken: "ghp_tok" },
      }),
    );

    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(url.searchParams.get("type")).toBe("owner");
  });
});

// ── Cassette recording shape ──────────────────────────────────────────────

describe("call — cassette recording", () => {
  it("records on 2xx success", async () => {
    installMockFetch(() => jsonResponse(200, { login: "me" }));
    const snapshot = makeSnapshot();

    await call(
      {
        serviceId: "openai",
        operationId: "list-models",
      },
      makeContext({
        snapshot,
        credentials: { accessToken: "sk-test" },
      }),
    );

    expect(snapshot.calls).toHaveLength(1);
    const c = snapshot.calls[0]!;
    expect(c.key).toBe("universal-http.call.openai.list-models.200");
    const responseRecorded = c.response as Record<string, unknown>;
    expect(responseRecorded.status).toBe(200);
  });

  it("records on 5xx as well as success", async () => {
    installMockFetch(() => jsonResponse(503, { error: "down" }));
    const snapshot = makeSnapshot();

    await expect(
      call(
        { serviceId: "openai", operationId: "list-models" },
        makeContext({
          snapshot,
          credentials: { accessToken: "sk-test" },
        }),
      ),
    ).rejects.toBeInstanceOf(IntegrationError);

    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("universal-http.call.openai.list-models.503");
  });
});

// ── Override baseUrl via credential siteBaseUrl (Jira, Shopify pattern) ───

describe("call — siteBaseUrl credential override", () => {
  it("uses siteBaseUrl when present in credentials (Jira pattern)", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse(200, { issues: [] }),
    );

    await call(
      {
        serviceId: "jira",
        operationId: "search-issues",
        body: { jql: "project = TEST" },
      },
      makeContext({
        credentials: {
          username: "user@acme.com",
          password: "api-tok-123",
          siteBaseUrl: "https://acme.atlassian.net",
        },
      }),
    );

    expect(captured[0]!.url).toBe(
      "https://acme.atlassian.net/rest/api/3/search",
    );
  });
});

// ── 5xx is retryable ──────────────────────────────────────────────────────

describe("call — 5xx mapping", () => {
  it("5xx errors are retryable", async () => {
    installMockFetch(() => jsonResponse(502, { error: "bad gateway" }));
    try {
      await call(
        { serviceId: "openai", operationId: "list-models" },
        makeContext({ credentials: { accessToken: "sk" } }),
      );
      throw new Error("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(true);
      expect((err as IntegrationError).httpStatus).toBe(502);
    }
  });

  it("4xx (non-429/401/403) errors are NOT retryable", async () => {
    installMockFetch(() => jsonResponse(422, { error: "bad input" }));
    try {
      await call(
        { serviceId: "openai", operationId: "list-models" },
        makeContext({ credentials: { accessToken: "sk" } }),
      );
      throw new Error("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(false);
      expect((err as IntegrationError).httpStatus).toBe(422);
    }
  });
});
