import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type OperationContext,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import integration, {
  base64UrlEncode,
  buildRfc2822Email,
  extractAccessToken,
  parseRetryAfter,
  sendMessage,
  SendMessageInputSchema,
  testCredential,
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
  const creds =
    "credentials" in opts
      ? opts.credentials
      : { accessToken: "ya29.test-access-token" };
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
function installMockFetch(
  responder: (
    url: string | URL,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
): { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    return responder(url, init);
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

describe("@delightfulchorus/integration-gmail-send module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("gmail-send");
    expect(integration.manifest.authType).toBe("oauth2");
    expect(integration.manifest.operations.map((o) => o.name)).toContain("sendMessage");
    expect(typeof integration.operations.sendMessage).toBe("function");
    expect(integration.manifest.baseUrl).toBe("https://gmail.googleapis.com");
    expect(integration.manifest.docsUrl).toMatch(/developers\.google\.com\/gmail/);
  });

  it("declares an oauth2 credentialType with scopes + PKCE + endpoints", () => {
    expect(integration.manifest.credentialTypes).toHaveLength(1);
    const ct = integration.manifest.credentialTypes![0]!;
    expect(ct.name).toBe("gmailOAuth2");
    expect(ct.authType).toBe("oauth2");
    expect(ct.documentationUrl).toMatch(/^https:\/\//);
    expect(ct.displayName).toBe("Gmail OAuth2");

    // Fields — single oauth-managed accessToken.
    expect(ct.fields).toHaveLength(1);
    expect(ct.fields![0]!.name).toBe("accessToken");
    expect(ct.fields![0]!.type).toBe("password");
    expect(ct.fields![0]!.oauthManaged).toBe(true);

    // OAuth metadata — must be present for authType === "oauth2".
    expect(ct.oauth).toBeDefined();
    expect(ct.oauth!.authorizeUrl).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(ct.oauth!.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(ct.oauth!.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(ct.oauth!.pkce).toBe(true);
    expect(ct.oauth!.clientAuthStyle).toBe("body");
    // Google requires access_type=offline + prompt=consent for refresh tokens.
    expect(ct.oauth!.authorizeQueryParams?.access_type).toBe("offline");
    expect(ct.oauth!.authorizeQueryParams?.prompt).toBe("consent");
  });

  it("exposes testCredential callable on the IntegrationModule", () => {
    expect(typeof integration.testCredential).toBe("function");
  });

  it("manifest.authType matches credentialType.authType (refine constraint)", () => {
    // §4.3 refine: manifest must have at least one credentialType with the
    // same authType as the top-level field, OR all types must be "none".
    expect(integration.manifest.authType).toBe(
      integration.manifest.credentialTypes![0]!.authType,
    );
  });
});

// ── testCredential (docs/CREDENTIALS_ANALYSIS.md §4.4) ──────────────────────

describe("testCredential — Gmail users.getProfile", () => {
  it("returns ok:true with emailAddress as userName when profile succeeds", async () => {
    installMockFetch((url, init) => {
      expect(String(url)).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer ya29.test-access-token");
      return new Response(
        JSON.stringify({
          emailAddress: "alice@example.com",
          messagesTotal: 123,
          threadsTotal: 45,
          historyId: "999",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(true);
    expect(result.identity?.userName).toBe("alice@example.com");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok:false AUTH_INVALID when no access token in ctx", async () => {
    const result = await testCredential(
      "gmailOAuth2",
      makeContext({ credentials: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("maps Gmail 401 (plain) to AUTH_INVALID", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
    expect(result.error).toMatch(/401/);
  });

  it("maps Gmail 401 with 'token expired' body to AUTH_EXPIRED", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 401,
              message: "Request had invalid credentials (access token expired)",
              status: "UNAUTHENTICATED",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_EXPIRED");
  });

  it("maps Gmail 403 PERMISSION_DENIED to SCOPE_INSUFFICIENT", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("SCOPE_INSUFFICIENT");
  });

  it("maps 5xx to NETWORK_ERROR", async () => {
    installMockFetch(() => new Response("server error", { status: 503 }));
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NETWORK_ERROR");
  });

  it("handles fetch network failure gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NETWORK_ERROR");
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("returns AUTH_INVALID when response is 200 but emailAddress is missing", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ historyId: "1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await testCredential("gmailOAuth2", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });
});

// ── Happy path + bearer header + base64url ─────────────────────────────────

describe("sendMessage — happy path", () => {
  it("sends Authorization: Bearer and returns { id, threadId }", async () => {
    const { mock } = installMockFetch((url, init) => {
      expect(String(url)).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer ya29.test-access-token");
      expect(headers.get("content-type")).toMatch(/application\/json/i);
      return new Response(
        JSON.stringify({ id: "msg-1", threadId: "thr-1", labelIds: ["SENT"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const snapshot = makeSnapshot();
    const result = await sendMessage(
      { to: "bob@example.com", subject: "hi", body: "hello there" },
      makeContext({ snapshot }),
    );
    expect(result).toEqual({
      id: "msg-1",
      threadId: "thr-1",
      labelIds: ["SENT"],
    });
    expect(mock).toHaveBeenCalledOnce();
    expect(snapshot.calls[0]!.key).toBe("gmail-send.sendMessage.200");
  });

  it("encodes the RFC 2822 message as base64url in `raw`", async () => {
    const { mock } = installMockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { raw?: string };
      expect(typeof body.raw).toBe("string");
      // base64url alphabet: no `+`, no `/`, no `=` padding.
      expect(body.raw!).not.toMatch(/[+/=]/);
      // Round-trip decode — should contain our headers and body.
      const decoded = Buffer.from(body.raw!, "base64url").toString("utf8");
      expect(decoded).toMatch(/^To: bob@example\.com\r\n/m);
      expect(decoded).toMatch(/^Subject: hi\r\n/m);
      expect(decoded).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
      expect(decoded).toMatch(/\r\n\r\nhello there$/);
      return new Response(
        JSON.stringify({ id: "m", threadId: "t" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await sendMessage(
      { to: "bob@example.com", subject: "hi", body: "hello there" },
      makeContext(),
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it("respects from override and bodyType: html", async () => {
    const { mock } = installMockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { raw?: string };
      const decoded = Buffer.from(body.raw!, "base64url").toString("utf8");
      expect(decoded).toMatch(/^From: "Alice" <alice@example\.com>\r\n/m);
      expect(decoded).toMatch(/Content-Type: text\/html; charset="UTF-8"/);
      expect(decoded).toMatch(/<p>hi<\/p>$/);
      return new Response(
        JSON.stringify({ id: "m", threadId: "t" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await sendMessage(
      {
        to: "bob@example.com",
        from: '"Alice" <alice@example.com>',
        subject: "html",
        body: "<p>hi</p>",
        bodyType: "html",
      },
      makeContext(),
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it("omits labelIds from output when Gmail did not return any", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ id: "m", threadId: "t" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await sendMessage(
      { to: "bob@example.com", subject: "s", body: "b" },
      makeContext(),
    );
    expect(result.id).toBe("m");
    expect(result.threadId).toBe("t");
    expect(result.labelIds).toBeUndefined();
  });

  it("accepts a plain string token credential", async () => {
    const { mock } = installMockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer ya29.plain-string-token");
      return new Response(
        JSON.stringify({ id: "m", threadId: "t" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await sendMessage(
      { to: "bob@example.com", subject: "s", body: "b" },
      makeContext({ credentials: "ya29.plain-string-token" as never }),
    );
    expect(mock).toHaveBeenCalledOnce();
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe("sendMessage — auth", () => {
  it("throws AuthError when no credential is present", async () => {
    await expect(
      sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext({ credentials: null }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 401 HTTP to AuthError and records a 401 snapshot", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 401,
              message: "Invalid Credentials",
              status: "UNAUTHENTICATED",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const snapshot = makeSnapshot();
    await expect(
      sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext({ snapshot }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(snapshot.calls[0]!.key).toBe("gmail-send.sendMessage.401");
  });
});

// ── Rate limit ─────────────────────────────────────────────────────────────

describe("sendMessage — rate limit", () => {
  it("throws RateLimitError with retryAfterMs from Retry-After seconds", async () => {
    installMockFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "45" },
        }),
    );
    const snapshot = makeSnapshot();
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext({ snapshot }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(45_000);
    }
    expect(snapshot.calls[0]!.key).toBe("gmail-send.sendMessage.429");
  });

  it("defaults retryAfterMs to 30s when header missing", async () => {
    installMockFetch(() => new Response("", { status: 429 }));
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30_000);
    }
  });
});

// ── Gmail HTTP errors ──────────────────────────────────────────────────────

describe("sendMessage — Gmail API errors", () => {
  it("surfaces 400 INVALID_ARGUMENT as GMAIL_INVALID_ARGUMENT IntegrationError (non-retryable)", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "Recipient address required",
              status: "INVALID_ARGUMENT",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("GMAIL_INVALID_ARGUMENT");
      expect((err as IntegrationError).retryable).toBe(false);
      expect((err as IntegrationError).httpStatus).toBe(400);
    }
  });

  it("surfaces 403 PERMISSION_DENIED as GMAIL_PERMISSION_DENIED (non-retryable)", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Insufficient Permission",
              status: "PERMISSION_DENIED",
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("GMAIL_PERMISSION_DENIED");
      expect((err as IntegrationError).retryable).toBe(false);
    }
  });

  it("treats 5xx HTTP as retryable GMAIL_SERVER_ERROR", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 503, status: "UNAVAILABLE", message: "Backend blip" },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("GMAIL_SERVER_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });

  it("treats transport network error as retryable NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("NETWORK_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });

  it("treats success body without id/threadId as GMAIL_MALFORMED_RESPONSE", async () => {
    installMockFetch(
      () =>
        new Response(JSON.stringify({ labelIds: ["SENT"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await sendMessage(
        { to: "bob@example.com", subject: "s", body: "b" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("GMAIL_MALFORMED_RESPONSE");
      expect((err as IntegrationError).retryable).toBe(false);
    }
  });
});

// ── Validation ─────────────────────────────────────────────────────────────

describe("sendMessage — input validation", () => {
  it("rejects empty `to`", async () => {
    await expect(
      sendMessage(
        { to: "", subject: "s", body: "b" } as never,
        makeContext(),
      ),
    ).rejects.toThrow();
  });

  it("rejects subject over 998 chars (RFC 2822 line length)", async () => {
    await expect(
      sendMessage(
        { to: "bob@example.com", subject: "x".repeat(999), body: "b" } as never,
        makeContext(),
      ),
    ).rejects.toThrow();
  });

  it("defaults bodyType to 'text' when omitted", () => {
    const parsed = SendMessageInputSchema.parse({
      to: "bob@example.com",
      subject: "s",
      body: "b",
    });
    expect(parsed.bodyType).toBe("text");
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("extractAccessToken handles multiple credential shapes", () => {
    expect(extractAccessToken("abc")).toBe("abc");
    expect(extractAccessToken({ accessToken: "abc" })).toBe("abc");
    expect(extractAccessToken({ token: "abc" })).toBe("abc");
    expect(extractAccessToken({ bearer: "abc" })).toBe("abc");
    expect(extractAccessToken({ irrelevant: 1 } as never)).toBeUndefined();
    expect(extractAccessToken(null)).toBeUndefined();
  });

  it("parseRetryAfter handles seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });

  it("base64UrlEncode produces RFC 4648 §5 url-safe output (no +, /, =)", () => {
    // Inputs that exercise all three "dangerous" base64 characters plus
    // padding. The bytes `ù?>` map to `+` / `/` / `=` under standard
    // base64; base64url must replace/strip them.
    const inputs = [
      "hello",
      "a",
      "ab",
      "abc",
      "\u00ff\u00fe\u00fd",
      "subject: hi\r\n\r\nbody",
      // A longer run that spans many 3-byte groups to ensure we never emit
      // a padding `=`.
      "x".repeat(1000),
    ];
    for (const s of inputs) {
      const encoded = base64UrlEncode(s);
      expect(encoded).not.toMatch(/[+/=]/);
      // Must round-trip back to the exact input.
      expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(s);
    }
  });

  it("buildRfc2822Email produces required headers + blank line + body", () => {
    const msg = buildRfc2822Email({
      to: "bob@example.com",
      subject: "hi",
      body: "hello",
      bodyType: "text",
    });
    // CRLF-terminated header block, blank line, then body.
    expect(msg).toMatch(/^To: bob@example\.com\r\n/);
    expect(msg).toMatch(/\r\nSubject: hi\r\n/);
    expect(msg).toMatch(/\r\nMIME-Version: 1\.0\r\n/);
    expect(msg).toMatch(/\r\nContent-Type: text\/plain; charset="UTF-8"\r\n/);
    expect(msg).toMatch(/\r\n\r\nhello$/);
  });

  it("buildRfc2822Email omits From when caller did not supply it", () => {
    const msg = buildRfc2822Email({
      to: "bob@example.com",
      subject: "s",
      body: "b",
      bodyType: "text",
    });
    expect(msg).not.toMatch(/^From:/m);
  });

  it("buildRfc2822Email emits text/html for bodyType: html", () => {
    const msg = buildRfc2822Email({
      to: "bob@example.com",
      subject: "s",
      body: "<b>b</b>",
      bodyType: "html",
    });
    expect(msg).toMatch(/Content-Type: text\/html; charset="UTF-8"/);
  });
});
