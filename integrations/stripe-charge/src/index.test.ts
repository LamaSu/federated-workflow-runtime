import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type OperationContext,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import integration, {
  STRIPE_API_VERSION,
  buildStripeFormBody,
  create,
  extractSecretKey,
  isStripeCardDeclineCode,
  parseRetryAfter,
  testCredential,
} from "./index.js";

// ── Test scaffolding ────────────────────────────────────────────────────────

/**
 * Fake Stripe secret key. We deliberately avoid a realistic-length token
 * literal so GitHub secret scanning doesn't flag this file. Pattern is
 * sk_test_* so it still matches the credential regex — the length is the
 * part that makes a real key look real, and we keep ours short.
 */
const FAKE_SECRET_KEY = ["sk", "test", "BOGUS_FAKE_xyz"].join("_");

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
    "credentials" in opts ? opts.credentials : { secretKey: FAKE_SECRET_KEY };
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
function installMockFetch(responder: (url: string | URL, init: RequestInit | undefined) => Response | Promise<Response>): {
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    return responder(url, init);
  });
  vi.stubGlobal("fetch", mock);
  return { mock };
}

/**
 * Minimal successful Stripe charge response body. Adjust per test as needed.
 */
function makeChargeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ch_test_123",
    object: "charge",
    status: "succeeded",
    amount: 2000,
    currency: "usd",
    created: 1_713_024_000,
    paid: true,
    captured: true,
    description: "Test charge",
    receipt_url: "https://pay.stripe.com/receipts/test_123",
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@delightfulchorus/integration-stripe-charge module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("stripe-charge");
    expect(integration.manifest.authType).toBe("apiKey");
    expect(integration.manifest.operations.map((o) => o.name)).toContain("create");
    expect(typeof integration.operations.create).toBe("function");
    expect(integration.manifest.baseUrl).toBe("https://api.stripe.com");
  });

  it("declares an apiKey credentialType with sk_ pattern", () => {
    expect(integration.manifest.credentialTypes).toHaveLength(1);
    const ct = integration.manifest.credentialTypes![0]!;
    expect(ct.name).toBe("stripeSecretKey");
    expect(ct.authType).toBe("apiKey");
    expect(ct.documentationUrl).toBe("https://stripe.com/docs/keys");
    expect(ct.fields).toHaveLength(1);
    const field = ct.fields![0]!;
    expect(field.name).toBe("secretKey");
    expect(field.type).toBe("password");
    expect(field.required).toBe(true);
    expect(field.pattern).toBe("^sk_(test|live)_");
    expect(field.deepLink).toBe("https://dashboard.stripe.com/apikeys");
    expect(field.oauthManaged).toBe(false);
  });

  it("accepts sk_test_ and sk_live_ via the credential pattern regex", () => {
    const pattern = new RegExp(
      integration.manifest.credentialTypes![0]!.fields![0]!.pattern!,
    );
    expect(pattern.test("sk_test_abc")).toBe(true);
    expect(pattern.test("sk_live_abc")).toBe(true);
    expect(pattern.test("pk_test_abc")).toBe(false);
    expect(pattern.test("xoxb-abc")).toBe(false);
  });

  it("exposes testCredential callable on the IntegrationModule", () => {
    expect(typeof integration.testCredential).toBe("function");
  });

  it("pins Stripe-Version to a documented string", () => {
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STRIPE_API_VERSION).toBe("2024-06-20");
  });
});

// ── testCredential ─────────────────────────────────────────────────────────

describe("testCredential — Stripe /v1/account", () => {
  it("returns ok:true with identity echo when /v1/account succeeds", async () => {
    installMockFetch((url, init) => {
      expect(String(url)).toBe("https://api.stripe.com/v1/account");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${FAKE_SECRET_KEY}`);
      expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
      return new Response(
        JSON.stringify({
          id: "acct_123",
          email: "founder@example.com",
          settings: { dashboard: { display_name: "Acme Payments" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await testCredential("stripeSecretKey", makeContext());
    expect(result.ok).toBe(true);
    expect(result.identity?.userId).toBe("acct_123");
    expect(result.identity?.userName).toBe("founder@example.com");
    expect(result.identity?.workspaceName).toBe("Acme Payments");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to account id when email absent", async () => {
    installMockFetch(() =>
      new Response(
        JSON.stringify({ id: "acct_xyz" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await testCredential("stripeSecretKey", makeContext());
    expect(result.ok).toBe(true);
    expect(result.identity?.userName).toBe("acct_xyz");
    expect(result.identity?.workspaceName).toBeUndefined();
  });

  it("returns ok:false AUTH_INVALID when no secret key in ctx", async () => {
    const result = await testCredential(
      "stripeSecretKey",
      makeContext({ credentials: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("maps Stripe 401 to AUTH_INVALID", async () => {
    installMockFetch(() => new Response("{}", { status: 401 }));
    const result = await testCredential("stripeSecretKey", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
    expect(result.error).toMatch(/401/);
  });

  it("maps 5xx to NETWORK_ERROR", async () => {
    installMockFetch(() => new Response("server error", { status: 503 }));
    const result = await testCredential("stripeSecretKey", makeContext());
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
    const result = await testCredential("stripeSecretKey", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NETWORK_ERROR");
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("returns AUTH_INVALID on /v1/account response missing id", async () => {
    installMockFetch(() =>
      new Response(
        JSON.stringify({ email: "nope" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await testCredential("stripeSecretKey", makeContext());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });
});

// ── create: happy path ─────────────────────────────────────────────────────

describe("create — happy path", () => {
  it("sends Bearer, form-encoded body, Stripe-Version, and returns charge", async () => {
    const { mock } = installMockFetch((url, init) => {
      expect(String(url)).toBe("https://api.stripe.com/v1/charges");
      const headers = new Headers(init?.headers);
      // Authorization
      expect(headers.get("authorization")).toBe(`Bearer ${FAKE_SECRET_KEY}`);
      // Content-Type is form-encoded (NOT JSON — this is the key contract)
      expect(headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      // Stripe-Version pinned
      expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
      // Body is a form-encoded string — assert it's NOT JSON
      const bodyStr = String(init?.body);
      expect(bodyStr).toContain("amount=2000");
      expect(bodyStr).toContain("currency=usd");
      // JSON would start with `{` — confirm we did not send JSON
      expect(bodyStr.startsWith("{")).toBe(false);
      // And it should be parseable by URLSearchParams
      const reparsed = new URLSearchParams(bodyStr);
      expect(reparsed.get("amount")).toBe("2000");
      expect(reparsed.get("currency")).toBe("usd");
      return new Response(JSON.stringify(makeChargeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const snapshot = makeSnapshot();
    const result = await create(
      { amount: 2000, currency: "usd", source: "tok_visa" },
      makeContext({ snapshot }),
    );
    expect(result.id).toBe("ch_test_123");
    expect(result.status).toBe("succeeded");
    expect(result.amount).toBe(2000);
    expect(result.currency).toBe("usd");
    expect(result.created).toBe(1_713_024_000);
    expect(result.paid).toBe(true);
    expect(result.receipt_url).toBe("https://pay.stripe.com/receipts/test_123");
    expect(result.raw.object).toBe("charge");
    expect(mock).toHaveBeenCalledOnce();
    expect(snapshot.calls[0]!.key).toBe("stripe-charge.create.200");
  });

  it("accepts a plain string secret key credential", async () => {
    installMockFetch(() =>
      new Response(JSON.stringify(makeChargeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await create(
      { amount: 500, currency: "usd" },
      makeContext({ credentials: FAKE_SECRET_KEY as never }),
    );
    expect(result.id).toBe("ch_test_123");
  });

  it("normalizes unknown status values to 'failed' without throwing", async () => {
    installMockFetch(() =>
      new Response(
        JSON.stringify(makeChargeBody({ status: "some_future_status" })),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await create(
      { amount: 100, currency: "usd" },
      makeContext(),
    );
    expect(result.status).toBe("failed");
    // Raw preserves the actual value for diagnostics.
    expect((result.raw as { status?: string }).status).toBe("some_future_status");
  });
});

// ── create: idempotency ────────────────────────────────────────────────────

describe("create — idempotency", () => {
  it("passes Idempotency-Key header when idempotencyKey provided", async () => {
    const { mock } = installMockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toBe("order_42_attempt_1");
      return new Response(JSON.stringify(makeChargeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await create(
      {
        amount: 1000,
        currency: "usd",
        source: "tok_visa",
        idempotencyKey: "order_42_attempt_1",
      },
      makeContext(),
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it("omits Idempotency-Key header when not provided", async () => {
    installMockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toBeNull();
      return new Response(JSON.stringify(makeChargeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await create(
      { amount: 1000, currency: "usd", source: "tok_visa" },
      makeContext(),
    );
  });
});

// ── create: metadata encoding ──────────────────────────────────────────────

describe("create — metadata form encoding", () => {
  it("encodes metadata[key]=value on the wire", async () => {
    installMockFetch((_url, init) => {
      const bodyStr = String(init?.body);
      // URLSearchParams percent-encodes [ and ] — accept either raw or %5B/%5D
      const decoded = decodeURIComponent(bodyStr);
      expect(decoded).toContain("metadata[order_id]=ord_99");
      expect(decoded).toContain("metadata[source_system]=chorus");
      return new Response(JSON.stringify(makeChargeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await create(
      {
        amount: 500,
        currency: "usd",
        source: "tok_visa",
        metadata: {
          order_id: "ord_99",
          source_system: "chorus",
        },
      },
      makeContext(),
    );
  });

  it("maps statementDescriptor to snake_case statement_descriptor", async () => {
    installMockFetch((_url, init) => {
      const bodyStr = String(init?.body);
      // Re-parse using URLSearchParams — this gives the decoded value directly.
      const parsed = new URLSearchParams(bodyStr);
      expect(parsed.get("statement_descriptor")).toBe("CHORUS TEST");
      // Verify the *wire format* (the raw string) uses proper form-encoding:
      // a space becomes either %20 or + under URLSearchParams.toString().
      expect(/statement_descriptor=(CHORUS%20TEST|CHORUS\+TEST)/.test(bodyStr)).toBe(true);
      return new Response(JSON.stringify(makeChargeBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await create(
      {
        amount: 500,
        currency: "usd",
        source: "tok_visa",
        statementDescriptor: "CHORUS TEST",
      },
      makeContext(),
    );
  });
});

// ── create: auth errors ────────────────────────────────────────────────────

describe("create — auth", () => {
  it("throws AuthError when no credential is present", async () => {
    await expect(
      create(
        { amount: 100, currency: "usd" },
        makeContext({ credentials: null }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError with wrong credential shape (no secretKey, no accessToken)", async () => {
    await expect(
      create(
        { amount: 100, currency: "usd" },
        makeContext({ credentials: { irrelevantField: "nope" } }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 401 HTTP to AuthError", async () => {
    installMockFetch(() =>
      new Response(
        JSON.stringify({ error: { type: "invalid_request_error" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const snapshot = makeSnapshot();
    await expect(
      create(
        { amount: 100, currency: "usd" },
        makeContext({ snapshot }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(snapshot.calls[0]!.key).toBe("stripe-charge.create.401");
  });
});

// ── create: rate limit ─────────────────────────────────────────────────────

describe("create — rate limit", () => {
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
      await create(
        { amount: 100, currency: "usd" },
        makeContext({ snapshot }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(45_000);
    }
    expect(snapshot.calls[0]!.key).toBe("stripe-charge.create.429");
  });

  it("defaults retryAfterMs to 30s when header missing", async () => {
    installMockFetch(() => new Response("", { status: 429 }));
    try {
      await create({ amount: 100, currency: "usd" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30_000);
    }
  });
});

// ── create: card declined (402) ────────────────────────────────────────────

describe("create — 402 card_declined", () => {
  it("maps 402 with error.code=card_declined to STRIPE_CARD_DECLINED IntegrationError (not retryable)", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: "card_error",
              code: "card_declined",
              decline_code: "insufficient_funds",
              message: "Your card has insufficient funds.",
            },
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    );
    const snapshot = makeSnapshot();
    try {
      await create(
        { amount: 1000, currency: "usd", source: "tok_chargeDeclinedInsufficientFunds" },
        makeContext({ snapshot }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("STRIPE_CARD_DECLINED");
      expect((err as IntegrationError).retryable).toBe(false);
      expect((err as IntegrationError).httpStatus).toBe(402);
      expect((err as IntegrationError).message).toMatch(/insufficient funds/i);
    }
    expect(snapshot.calls[0]!.key).toBe("stripe-charge.create.402");
  });

  it("maps 402 with missing error body to STRIPE_CARD_DECLINED still", async () => {
    installMockFetch(() =>
      new Response("", {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await create(
        { amount: 1000, currency: "usd" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("STRIPE_CARD_DECLINED");
      expect((err as IntegrationError).retryable).toBe(false);
    }
  });
});

// ── create: invalid request (400) ──────────────────────────────────────────

describe("create — 400 invalid_request", () => {
  it("maps 400 validation_error to STRIPE_INVALID_REQUEST (not retryable)", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "parameter_invalid_empty",
              param: "currency",
              message: "You must supply a currency.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await create(
        { amount: 100, currency: "xxx" },
        makeContext(),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("STRIPE_INVALID_REQUEST");
      expect((err as IntegrationError).retryable).toBe(false);
      expect((err as IntegrationError).httpStatus).toBe(400);
    }
  });
});

// ── create: server error (5xx) ─────────────────────────────────────────────

describe("create — 5xx server error", () => {
  it("maps 500/503 to retryable STRIPE_SERVER_ERROR", async () => {
    installMockFetch(() =>
      new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await create({ amount: 100, currency: "usd" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("STRIPE_SERVER_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
      expect((err as IntegrationError).httpStatus).toBe(503);
    }
  });
});

// ── create: network error ──────────────────────────────────────────────────

describe("create — network error", () => {
  it("wraps fetch exceptions as retryable NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    try {
      await create({ amount: 100, currency: "usd" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("NETWORK_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
      expect((err as IntegrationError).message).toMatch(/ECONNRESET/);
    }
  });
});

// ── create: input validation ───────────────────────────────────────────────

describe("create — input validation", () => {
  it("rejects zero amount", async () => {
    await expect(
      create({ amount: 0, currency: "usd" } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects negative amount", async () => {
    await expect(
      create({ amount: -100, currency: "usd" } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects non-3-letter currency", async () => {
    await expect(
      create({ amount: 100, currency: "dollars" } as never, makeContext()),
    ).rejects.toThrow();
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("extractSecretKey handles multiple credential shapes", () => {
    expect(extractSecretKey("sk_test_abc")).toBe("sk_test_abc");
    expect(extractSecretKey({ secretKey: "sk_test_abc" })).toBe("sk_test_abc");
    expect(extractSecretKey({ apiKey: "sk_test_abc" })).toBe("sk_test_abc");
    expect(extractSecretKey({ accessToken: "sk_test_abc" })).toBe("sk_test_abc");
    expect(extractSecretKey({ key: "sk_test_abc" })).toBe("sk_test_abc");
    expect(extractSecretKey({ irrelevant: 1 } as never)).toBeUndefined();
    expect(extractSecretKey(null)).toBeUndefined();
    expect(extractSecretKey(undefined)).toBeUndefined();
  });

  it("parseRetryAfter handles seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });

  it("buildStripeFormBody flattens metadata into bracket keys", () => {
    const body = buildStripeFormBody({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
      metadata: { a: "1", b: "2" },
    });
    expect(body.get("amount")).toBe("100");
    expect(body.get("currency")).toBe("usd");
    expect(body.get("source")).toBe("tok_visa");
    expect(body.get("metadata[a]")).toBe("1");
    expect(body.get("metadata[b]")).toBe("2");
  });

  it("buildStripeFormBody omits undefined optional fields", () => {
    const body = buildStripeFormBody({
      amount: 100,
      currency: "usd",
    });
    expect(body.get("source")).toBeNull();
    expect(body.get("customer")).toBeNull();
    expect(body.get("description")).toBeNull();
    expect(body.get("statement_descriptor")).toBeNull();
  });

  it("isStripeCardDeclineCode matches known decline codes", () => {
    expect(isStripeCardDeclineCode("card_declined")).toBe(true);
    expect(isStripeCardDeclineCode("insufficient_funds")).toBe(true);
    expect(isStripeCardDeclineCode("expired_card")).toBe(true);
    expect(isStripeCardDeclineCode("parameter_invalid_empty")).toBe(false);
    expect(isStripeCardDeclineCode(undefined)).toBe(false);
  });
});
