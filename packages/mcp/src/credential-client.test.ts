import { describe, expect, it } from "vitest";
import { HttpCredentialServiceClient } from "./credential-client.js";

/**
 * HttpCredentialServiceClient tests — mock fetch, verify the correct URL,
 * headers, and body are sent for each operation.
 */

function makeFetch(
  handler: (req: { url: string; method: string; body: string; headers: Headers }) => Response | Promise<Response>,
): typeof fetch {
  const captured: { url: string; method: string; body: string; headers: Headers }[] = [];
  const fn = (async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const req = {
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : "",
      headers: new Headers(init?.headers ?? {}),
    };
    captured.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  (fn as unknown as { captured: typeof captured }).captured = captured;
  return fn;
}

function capturedCalls(fn: typeof fetch): Array<{ url: string; method: string; body: string; headers: Headers }> {
  return (fn as unknown as { captured: Array<{ url: string; method: string; body: string; headers: Headers }> }).captured;
}

describe("HttpCredentialServiceClient", () => {
  it("list → GET /api/credentials?integration=X", async () => {
    const fetchFn = makeFetch(() =>
      new Response(JSON.stringify({ credentials: [{ id: "c1", name: "w" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchFn,
    });
    const list = await client.list("slack-send");
    expect(list).toEqual([{ id: "c1", name: "w" }]);
    const calls = capturedCalls(fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3000/api/credentials?integration=slack-send",
    );
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.get("Accept")).toBe("application/json");
  });

  it("list with apiToken sends Authorization header", async () => {
    const fetchFn = makeFetch(() =>
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://127.0.0.1:3000",
      apiToken: "bearer-abc",
      fetchFn,
    });
    await client.list("x");
    expect(capturedCalls(fetchFn)[0]!.headers.get("Authorization")).toBe(
      "Bearer bearer-abc",
    );
  });

  it("configure → POST /api/credentials with JSON body", async () => {
    const fetchFn = makeFetch(() =>
      new Response(JSON.stringify({ id: "new-id", name: "work" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://localhost:8080",
      fetchFn,
    });
    const result = await client.configure({
      integration: "slack-send",
      credentialTypeName: "slackUserToken",
      name: "work",
      fields: { token: "xoxp-secret" },
    });
    expect(result).toEqual({ id: "new-id", name: "work" });
    const call = capturedCalls(fetchFn)[0]!;
    expect(call.url).toBe("http://localhost:8080/api/credentials");
    expect(call.method).toBe("POST");
    expect(call.headers.get("Content-Type")).toBe("application/json");
    const parsed = JSON.parse(call.body) as {
      integration: string;
      credentialTypeName: string;
      name: string;
      fields: Record<string, unknown>;
    };
    expect(parsed.integration).toBe("slack-send");
    expect(parsed.fields.token).toBe("xoxp-secret");
  });

  it("authenticate → POST /api/credentials/authenticate", async () => {
    const fetchFn = makeFetch(() =>
      new Response(
        JSON.stringify({
          authorizeUrl: "https://slack.com/oauth/v2/authorize?client_id=x",
          state: "state-123",
          expiresAt: "2026-04-15T00:15:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchFn,
    });
    const result = await client.authenticate({
      integration: "slack-send",
      credentialTypeName: "slackOAuth2Bot",
      name: "work",
    });
    expect(result.authorizeUrl).toContain("slack.com");
    expect(capturedCalls(fetchFn)[0]!.url).toBe(
      "http://127.0.0.1:3000/api/credentials/authenticate",
    );
  });

  it("testAuth → POST /api/credentials/:id/test with integration in body", async () => {
    const fetchFn = makeFetch(() =>
      new Response(JSON.stringify({ ok: true, latencyMs: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchFn,
    });
    const result = await client.testAuth({
      integration: "slack-send",
      credentialId: "cred-42",
    });
    expect(result.ok).toBe(true);
    const call = capturedCalls(fetchFn)[0]!;
    expect(call.url).toBe("http://127.0.0.1:3000/api/credentials/cred-42/test");
    expect(call.method).toBe("POST");
    const parsed = JSON.parse(call.body) as { integration: string };
    expect(parsed.integration).toBe("slack-send");
  });

  it("URL-encodes credential id in testAuth path", async () => {
    const fetchFn = makeFetch(() =>
      new Response(JSON.stringify({ ok: true, latencyMs: 1 }), { status: 200 }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://host",
      fetchFn,
    });
    await client.testAuth({
      integration: "x",
      credentialId: "cred/with%special chars",
    });
    expect(capturedCalls(fetchFn)[0]!.url).toBe(
      "http://host/api/credentials/cred%2Fwith%25special%20chars/test",
    );
  });

  it("throws a descriptive error on non-200 response", async () => {
    const fetchFn = makeFetch(() =>
      new Response("forbidden — bad token", { status: 403 }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://host",
      fetchFn,
    });
    await expect(client.list("x")).rejects.toThrow(
      /HttpCredentialServiceClient\.list: runtime returned 403/,
    );
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchFn = makeFetch(() =>
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://host///",
      fetchFn,
    });
    await client.list("x");
    expect(capturedCalls(fetchFn)[0]!.url).toBe(
      "http://host/api/credentials?integration=x",
    );
  });

  it("throws when baseUrl is missing", () => {
    expect(
      () =>
        new HttpCredentialServiceClient({
          baseUrl: "",
          fetchFn: makeFetch(() => new Response("")),
        }),
    ).toThrow(/baseUrl is required/);
  });

  it("propagates abort signal", async () => {
    let passedSignal: AbortSignal | null = null;
    const fetchFn = (async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      passedSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const client = new HttpCredentialServiceClient({
      baseUrl: "http://h",
      fetchFn,
      signal: controller.signal,
    });
    await client.list("x");
    expect(passedSignal).toBe(controller.signal);
  });
});
