/**
 * @delightfulchorus/integration-stripe-charge
 *
 * Reference integration: create a Stripe charge via POST /v1/charges.
 * Tracks the worked example in ARCHITECTURE.md §8.3 (payments).
 *
 * Auth: API key (Stripe calls these "secret keys" — starts with sk_test_ or
 * sk_live_). Stripe accepts these as Bearer tokens on Authorization header,
 * which is equivalent to HTTP Basic with secretKey as the username and empty
 * password. We use Bearer because it keeps one code path with OAuth-shaped
 * services and because the Stripe docs document both forms.
 *
 * Chorus contract notes:
 *   - **Form-encoded body**, NOT JSON. Stripe's wire format is
 *     application/x-www-form-urlencoded (documented at
 *     https://stripe.com/docs/api/charges/create). Nested objects use
 *     bracket syntax: `metadata[key]=value`.
 *   - **Stripe-Version: 2024-06-20** is pinned. Stripe's API is versioned
 *     per-request; without a pin we inherit the account's default version
 *     which can drift. 2024-06-20 is the same version PCC pins and is a
 *     current (non-deprecated) stable release as of April 2026.
 *   - **Idempotency** is caller-opt-in. If the input includes
 *     `idempotencyKey` we pass it verbatim as the `Idempotency-Key` header.
 *     We do NOT auto-generate one — the runtime has its own idempotency
 *     model (node retries keyed by runId+nodeId), and auto-generating here
 *     would paper over caller intent. Stripe stores idempotency keys for
 *     24h and replays the prior response byte-for-byte on duplicates.
 *   - 429 (rate_limit_error) → RateLimitError with retryAfterMs parsed from
 *     Retry-After header.
 *   - 402 (card_declined, insufficient_funds, expired_card, etc.) →
 *     IntegrationError code STRIPE_CARD_DECLINED, retryable false. These
 *     are *terminal* from the agent's perspective — the card won't start
 *     working on retry.
 *   - 400 (validation_error, invalid_request_error) → IntegrationError
 *     code STRIPE_INVALID_REQUEST, retryable false.
 *   - 401 → AuthError (non-retryable; the credential needs user action).
 *   - 5xx → IntegrationError retryable true (Stripe infra blip).
 *   - Every call records a cassette (success AND failure) so the repair
 *     agent has shape data to validate future patches against.
 */
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type CredentialTestResult,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import { z } from "zod";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Stripe's API is versioned per-request. Pinning keeps our wire format stable
 * across Stripe's own release cadence; without a pin, we'd silently inherit
 * the account's default version (which Stripe nudges forward over time).
 *
 * Bump this when we want to adopt a new version, re-record cassettes, and
 * re-run the integration tests. Do NOT read it from config — a floating
 * version is a category of latent bug.
 */
export const STRIPE_API_VERSION = "2024-06-20";

const STRIPE_BASE_URL = "https://api.stripe.com";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const CreateChargeInputSchema = z.object({
  /** Amount in the currency's smallest unit (e.g., cents for USD). */
  amount: z.number().int().positive(),
  /** 3-letter ISO currency code (lowercase per Stripe convention). */
  currency: z.string().length(3),
  /** Token or card ID to charge (tok_*, card_*, pm_*). */
  source: z.string().optional(),
  /** Existing Stripe customer ID (cus_*). */
  customer: z.string().optional(),
  /** Human-readable description shown on the dashboard and receipts. */
  description: z.string().max(500).optional(),
  /**
   * Caller-supplied idempotency key. When present, we pass it as the
   * Idempotency-Key header; Stripe replays the prior response for 24h.
   * Not auto-generated — see module header note.
   */
  idempotencyKey: z.string().min(1).max(255).optional(),
  /**
   * Structured metadata. Each key-value becomes a `metadata[key]=value`
   * form field on the wire. Stripe limits: 50 keys, 40 chars per key,
   * 500 chars per value. We don't enforce here — Stripe's 400 response
   * is descriptive and maps to STRIPE_INVALID_REQUEST cleanly.
   */
  metadata: z.record(z.string()).optional(),
  /** Appears on the cardholder's statement. */
  statementDescriptor: z.string().max(22).optional(),
});

/**
 * Stripe's charge object is large and evolving. We type the fields we
 * promise to callers (id, status, amount, currency, created). Other fields
 * pass through in `raw` for callers that need them — this keeps us
 * forward-compatible when Stripe adds fields (they often do) without a
 * schema-drift false alarm.
 */
export const CreateChargeOutputSchema = z.object({
  id: z.string(),
  status: z.enum(["succeeded", "pending", "failed"]),
  amount: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  paid: z.boolean().optional(),
  captured: z.boolean().optional(),
  description: z.string().nullable().optional(),
  receipt_url: z.string().nullable().optional(),
  /** Full raw charge object from Stripe — forward-compat escape hatch. */
  raw: z.record(z.unknown()),
});

export type CreateChargeInput = z.infer<typeof CreateChargeInputSchema>;
export type CreateChargeOutput = z.infer<typeof CreateChargeOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "stripe-charge",
  version: "0.1.1",
  description:
    "Create a charge via Stripe's REST API (form-encoded, Stripe-Version pinned).",
  authType: "apiKey",
  baseUrl: STRIPE_BASE_URL,
  docsUrl: "https://stripe.com/docs/api/charges/create",
  /**
   * Credential catalog (docs/CREDENTIALS_ANALYSIS.md §4.3). stripe-charge
   * ships one API-key credential type. A future iteration could add
   * `stripeOAuth2` for Stripe Connect platforms — lands here alongside this
   * one.
   */
  credentialTypes: [
    {
      name: "stripeSecretKey",
      displayName: "Stripe Secret Key",
      authType: "apiKey",
      description:
        "A Stripe secret key (sk_test_* for test mode, sk_live_* for production). Find it on the Stripe Dashboard under Developers > API keys.",
      documentationUrl: "https://stripe.com/docs/keys",
      fields: [
        {
          name: "secretKey",
          displayName: "Secret Key",
          type: "password",
          required: true,
          description:
            "Starts with sk_test_ or sk_live_. Create or reveal one at https://dashboard.stripe.com/apikeys — rotate immediately if ever exposed.",
          deepLink: "https://dashboard.stripe.com/apikeys",
          pattern: "^sk_(test|live)_",
          oauthManaged: false,
        },
      ],
      test: {
        description:
          "Calls GET https://api.stripe.com/v1/account (read-only).",
      },
    },
  ],
  operations: [
    {
      name: "create",
      description:
        "Create a charge. Requires amount + currency and either a source (token) or customer. Supports idempotency-key replay.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["amount", "currency"],
        properties: {
          amount: { type: "integer", minimum: 1 },
          currency: { type: "string", minLength: 3, maxLength: 3 },
          source: { type: "string" },
          customer: { type: "string" },
          description: { type: "string", maxLength: 500 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 255 },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          statementDescriptor: { type: "string", maxLength: 22 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["id", "status", "amount", "currency", "created", "raw"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["succeeded", "pending", "failed"] },
          amount: { type: "integer" },
          currency: { type: "string" },
          created: { type: "integer" },
          paid: { type: "boolean" },
          captured: { type: "boolean" },
          description: { type: ["string", "null"] },
          receipt_url: { type: ["string", "null"] },
          raw: { type: "object" },
        },
      },
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

type OperationContextCreds = Record<string, unknown> | string | null | undefined;

/**
 * Pull a Stripe secret key out of the OperationContext. We accept four
 * shapes for back-compat with existing credential blobs:
 *   1. plain string — "sk_test_..."
 *   2. { secretKey: "sk_..." } — the catalog-declared field name
 *   3. { apiKey: "sk_..." } — common legacy alias
 *   4. { accessToken: "sk_..." } — the shape some UIs use generically
 *
 * The catalog declares `secretKey` (2). The others are tolerated so a user
 * who typed their key into a generic "API Key" field in the CLI still works.
 */
export function extractSecretKey(credentials: OperationContextCreds): string | undefined {
  if (!credentials) return undefined;
  if (typeof credentials === "string") return credentials;
  const candidate =
    (credentials as { secretKey?: unknown }).secretKey ??
    (credentials as { apiKey?: unknown }).apiKey ??
    (credentials as { accessToken?: unknown }).accessToken ??
    (credentials as { key?: unknown }).key;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Convert an RFC 7231 Retry-After value into milliseconds. Stripe sends
 * delta-seconds in practice; we tolerate a date form for robustness.
 */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/**
 * Build a URL-encoded form body for Stripe. Handles flat key-value pairs
 * and one level of nested metadata (Stripe's only nested shape in /v1/charges).
 * Undefined values are skipped so we don't send `source=undefined` on the wire.
 */
export function buildStripeFormBody(input: CreateChargeInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set("amount", String(input.amount));
  params.set("currency", input.currency);
  if (input.source !== undefined) params.set("source", input.source);
  if (input.customer !== undefined) params.set("customer", input.customer);
  if (input.description !== undefined) params.set("description", input.description);
  if (input.statementDescriptor !== undefined) {
    params.set("statement_descriptor", input.statementDescriptor);
  }
  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      params.set(`metadata[${key}]`, value);
    }
  }
  return params;
}

/**
 * Stripe error codes that come back on 402 card_declined responses. Not a
 * perfect enumeration — we use it to tag a single group as
 * STRIPE_CARD_DECLINED rather than re-mapping every decline reason.
 */
export function isStripeCardDeclineCode(code: string | undefined): boolean {
  if (!code) return false;
  return new Set([
    "card_declined",
    "insufficient_funds",
    "expired_card",
    "incorrect_cvc",
    "incorrect_number",
    "invalid_expiry_month",
    "invalid_expiry_year",
    "invalid_cvc",
    "invalid_number",
    "processing_error",
  ]).has(code);
}

// ── Handler ─────────────────────────────────────────────────────────────────

type StripeErrorBody = {
  error?: {
    type?: string;
    code?: string;
    message?: string;
    param?: string;
    decline_code?: string;
  };
};

type StripeChargeBody = {
  id?: string;
  object?: string;
  status?: string;
  amount?: number;
  currency?: string;
  created?: number;
  paid?: boolean;
  captured?: boolean;
  description?: string | null;
  receipt_url?: string | null;
  [key: string]: unknown;
};

export const create: OperationHandler<CreateChargeInput, CreateChargeOutput> = async (
  input,
  ctx,
) => {
  const parsed = CreateChargeInputSchema.parse(input);
  const secretKey = extractSecretKey(ctx.credentials);
  if (!secretKey) {
    throw new AuthError({
      message:
        "stripe-charge.create requires a Stripe secret key in ctx.credentials",
      integration: "stripe-charge",
      operation: "create",
    });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (parsed.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = parsed.idempotencyKey;
  }

  const body = buildStripeFormBody(parsed);

  let response: Response;
  try {
    response = await fetch(`${STRIPE_BASE_URL}/v1/charges`, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: ctx.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new IntegrationError({
      message: `stripe-charge network error: ${message}`,
      integration: "stripe-charge",
      operation: "create",
      code: "NETWORK_ERROR",
      retryable: true,
      cause: err,
    });
  }

  // 429 — rate-limited. Stripe sets Retry-After in seconds.
  if (response.status === 429) {
    const retryAfterMs =
      parseRetryAfter(response.headers.get("retry-after") ?? undefined) ?? 30_000;
    await ctx.snapshot?.record(
      "stripe-charge.create.429",
      {
        amount: parsed.amount,
        currency: parsed.currency,
        hasIdempotencyKey: parsed.idempotencyKey !== undefined,
      },
      { status: 429, retryAfterMs },
    );
    throw new RateLimitError({
      message: "Stripe rate limit exceeded",
      integration: "stripe-charge",
      operation: "create",
      httpStatus: 429,
      retryAfterMs,
    });
  }

  // 401 — bad/revoked secret key.
  if (response.status === 401) {
    await ctx.snapshot?.record(
      "stripe-charge.create.401",
      { amount: parsed.amount, currency: parsed.currency },
      { status: 401 },
    );
    throw new AuthError({
      message:
        "Stripe 401 — secret key invalid or revoked; user must rotate key",
      integration: "stripe-charge",
      operation: "create",
      httpStatus: 401,
    });
  }

  // Parse body — Stripe always returns JSON on /v1/charges, but guard anyway.
  let rawBody: (StripeErrorBody & StripeChargeBody) | null = null;
  try {
    rawBody = (await response.json()) as StripeErrorBody & StripeChargeBody;
  } catch {
    rawBody = null;
  }

  // 402 — card declined. Stripe's `error.code` carries the decline reason.
  if (response.status === 402) {
    const errCode = rawBody?.error?.code;
    const declineCode = rawBody?.error?.decline_code;
    await ctx.snapshot?.record(
      "stripe-charge.create.402",
      { amount: parsed.amount, currency: parsed.currency },
      { status: 402, errCode, declineCode },
    );
    throw new IntegrationError({
      message:
        rawBody?.error?.message ??
        `Stripe card declined${errCode ? ` (${errCode})` : ""}`,
      integration: "stripe-charge",
      operation: "create",
      code: "STRIPE_CARD_DECLINED",
      httpStatus: 402,
      retryable: false,
    });
  }

  // 400 — invalid request / validation.
  if (response.status === 400) {
    const errCode = rawBody?.error?.code;
    const errParam = rawBody?.error?.param;
    await ctx.snapshot?.record(
      "stripe-charge.create.400",
      { amount: parsed.amount, currency: parsed.currency },
      { status: 400, errCode, errParam },
    );
    throw new IntegrationError({
      message:
        rawBody?.error?.message ??
        `Stripe invalid request${errCode ? ` (${errCode})` : ""}`,
      integration: "stripe-charge",
      operation: "create",
      code: "STRIPE_INVALID_REQUEST",
      httpStatus: 400,
      retryable: false,
    });
  }

  // 5xx — Stripe server error; retryable.
  if (response.status >= 500) {
    await ctx.snapshot?.record(
      `stripe-charge.create.${response.status}`,
      { amount: parsed.amount, currency: parsed.currency },
      { status: response.status },
    );
    throw new IntegrationError({
      message: `Stripe server error HTTP ${response.status}`,
      integration: "stripe-charge",
      operation: "create",
      code: "STRIPE_SERVER_ERROR",
      httpStatus: response.status,
      retryable: true,
    });
  }

  // Any other 4xx we haven't specialized.
  if (response.status >= 400 || rawBody === null) {
    const errCode = rawBody?.error?.code ?? "unknown";
    await ctx.snapshot?.record(
      `stripe-charge.create.${response.status}`,
      { amount: parsed.amount, currency: parsed.currency },
      { status: response.status, errCode },
    );
    throw new IntegrationError({
      message: rawBody?.error?.message ?? `Stripe HTTP ${response.status}`,
      integration: "stripe-charge",
      operation: "create",
      code: `STRIPE_${errCode.toUpperCase()}`,
      httpStatus: response.status,
      retryable: false,
    });
  }

  // Success (2xx with a parsed body). Verify the body looks like a charge.
  const charge = rawBody as StripeChargeBody;
  if (
    typeof charge.id !== "string" ||
    typeof charge.status !== "string" ||
    typeof charge.amount !== "number" ||
    typeof charge.currency !== "string" ||
    typeof charge.created !== "number"
  ) {
    throw new IntegrationError({
      message: "Stripe success body missing required charge fields",
      integration: "stripe-charge",
      operation: "create",
      code: "STRIPE_MALFORMED_RESPONSE",
      httpStatus: response.status,
      retryable: false,
    });
  }

  // Normalize status to the enum we promise. Stripe only returns these
  // three values for charges on a `create`, but we fall through to "failed"
  // rather than erroring — the `raw` field preserves the actual value for
  // diagnostic purposes.
  const status =
    charge.status === "succeeded" || charge.status === "pending"
      ? charge.status
      : "failed";

  await ctx.snapshot?.record(
    "stripe-charge.create.200",
    {
      amount: parsed.amount,
      currency: parsed.currency,
      hasSource: parsed.source !== undefined,
      hasCustomer: parsed.customer !== undefined,
      hasMetadata: parsed.metadata !== undefined,
      hasIdempotencyKey: parsed.idempotencyKey !== undefined,
    },
    { status: 200, chargeStatus: status },
  );

  return {
    id: charge.id,
    status,
    amount: charge.amount,
    currency: charge.currency,
    created: charge.created,
    paid: charge.paid,
    captured: charge.captured,
    description: charge.description ?? null,
    receipt_url: charge.receipt_url ?? null,
    raw: rawBody as Record<string, unknown>,
  };
};

// ── testCredential (docs/CREDENTIALS_ANALYSIS.md §4.4) ─────────────────────

/**
 * Validate a Stripe secret key by calling GET /v1/account — read-only,
 * idempotent, cheap. Returns account identity on success so the CLI / MCP
 * can surface "authenticated as <email> at <business>" to the user.
 *
 * Stripe's /v1/account endpoint returns the caller's own account object
 * (not a list). The presence of an `id` field is sufficient evidence the
 * key authenticated.
 */
export async function testCredential(
  _credentialTypeName: string,
  ctx: OperationContext,
): Promise<CredentialTestResult> {
  const startedAt = Date.now();
  const secretKey = extractSecretKey(ctx.credentials);
  if (!secretKey) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error:
        "stripe-charge.testCredential: no secret key in ctx.credentials",
      errorCode: "AUTH_INVALID",
    };
  }
  try {
    const res = await fetch(`${STRIPE_BASE_URL}/v1/account`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: ctx.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (res.status === 401) {
      return {
        ok: false,
        latencyMs,
        error: "Stripe 401 — secret key invalid or revoked",
        errorCode: "AUTH_INVALID",
      };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        latencyMs,
        error: `Stripe HTTP ${res.status}`,
        errorCode: "NETWORK_ERROR",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        error: `Stripe HTTP ${res.status}`,
        errorCode: "AUTH_INVALID",
      };
    }
    type AccountBody = {
      id?: string;
      email?: string | null;
      business_profile?: { name?: string | null } | null;
      settings?: { dashboard?: { display_name?: string | null } } | null;
    };
    let body: AccountBody;
    try {
      body = (await res.json()) as AccountBody;
    } catch (err) {
      return {
        ok: false,
        latencyMs,
        error: `Stripe /v1/account: malformed response (${(err as Error).message})`,
        errorCode: "NETWORK_ERROR",
      };
    }
    if (typeof body.id !== "string") {
      return {
        ok: false,
        latencyMs,
        error: "Stripe /v1/account: response missing account id",
        errorCode: "AUTH_INVALID",
      };
    }
    // Prefer email as userName (it's what the user recognizes); fall back
    // to the account id.
    const userName =
      (typeof body.email === "string" && body.email) || body.id;
    const workspaceName =
      body.settings?.dashboard?.display_name ??
      body.business_profile?.name ??
      undefined;
    return {
      ok: true,
      latencyMs,
      identity: {
        userId: body.id,
        userName,
        workspaceName: workspaceName ?? undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: `network error: ${(err as Error).message}`,
      errorCode: "NETWORK_ERROR",
    };
  }
}

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    create: create as OperationHandler,
  },
  testCredential,
};

export default integration;
