/**
 * @delightfulchorus/integration-llm-anthropic
 *
 * Thin adapter: wraps Vercel AI SDK's `generateText` and `generateObject`
 * against Anthropic Claude. One of three first-party LLM integrations
 * (openai, gemini, anthropic) that share the same operation shape —
 * workflows can swap providers without rewiring nodes.
 *
 * Auth: an Anthropic API key (user-supplied; the runtime hands it over via
 * ctx.credentials.apiKey). The SDK sends it as the `x-api-key` header.
 *
 * Chorus contract notes:
 *   - 401 / "invalid x-api-key" → AuthError (non-retryable).
 *   - 429 → RateLimitError with the AI SDK's `retryAfterMs` hint when
 *     available; otherwise the runtime's default backoff applies.
 *   - Any other API error → IntegrationError with the provider's error code
 *     preserved (useful for the repair-agent's error-signature matching).
 *   - Cassette records track input shape (prompt length, model) and output
 *     shape (text length, token counts) — never the prompt or response
 *     verbatim, because both frequently contain user secrets/PII.
 */
import {
  anthropic,
  createAnthropic,
  type AnthropicProvider,
} from "@ai-sdk/anthropic";
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
import {
  generateObject,
  generateText,
  jsonSchema,
  type LanguageModelV1,
} from "ai";
import { z } from "zod";

// ── Shared helpers (extracted so all 3 LLM integrations stay in lockstep) ──

/**
 * Pull an API key from OperationContext. We accept:
 *   - string credentials (legacy raw token)
 *   - { apiKey: string } (canonical, matches the credentialType field)
 *   - { token: string } / { bearer: string } (symmetric with slack-send)
 */
export function extractApiKey(
  credentials: Record<string, unknown> | string | null | undefined,
): string | undefined {
  if (!credentials) return undefined;
  if (typeof credentials === "string") return credentials;
  const candidate =
    (credentials as { apiKey?: unknown }).apiKey ??
    (credentials as { api_key?: unknown }).api_key ??
    (credentials as { token?: unknown }).token ??
    (credentials as { bearer?: unknown }).bearer;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Map an AI SDK / provider error into a Chorus error. The SDK throws
 * strongly-typed errors with `name` attributes we can switch on (e.g.
 * `AI_APICallError`, `AI_RateLimitError`). We fall back to message
 * inspection when the name is absent so upstream SDK churn doesn't break
 * classification.
 */
export function mapProviderError(
  err: unknown,
  integration: string,
  operation: string,
): never {
  const asErr = err as {
    name?: string;
    statusCode?: number;
    message?: string;
    responseBody?: string;
    cause?: unknown;
    reason?: string;
  };
  const status = asErr.statusCode;
  const message = asErr.message ?? String(err);

  if (status === 401 || status === 403 || /invalid.*api.*key|unauthorized/i.test(message)) {
    throw new AuthError({
      message: `${integration}.${operation}: ${message}`,
      integration,
      operation,
      httpStatus: status,
    });
  }

  if (status === 429 || /rate.?limit/i.test(message)) {
    // AI SDK exposes `retryAfter` as header value (seconds) or ms on some
    // providers; we tolerate both shapes.
    const retryAfterCandidate =
      (err as { retryAfter?: unknown }).retryAfter ??
      (err as { retryAfterMs?: unknown }).retryAfterMs;
    let retryAfterMs: number | undefined;
    if (typeof retryAfterCandidate === "number" && Number.isFinite(retryAfterCandidate)) {
      retryAfterMs =
        retryAfterCandidate < 1000
          ? retryAfterCandidate * 1000
          : retryAfterCandidate;
    }
    throw new RateLimitError({
      message: `${integration}.${operation}: ${message}`,
      integration,
      operation,
      httpStatus: status ?? 429,
      retryAfterMs,
    });
  }

  throw new IntegrationError({
    message: `${integration}.${operation}: ${message}`,
    integration,
    operation,
    code: asErr.name ?? "PROVIDER_ERROR",
    httpStatus: status,
    retryable: status === undefined ? false : status >= 500,
    cause: err,
  });
}

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Input shared by `generate` and `generateObject`. The `model` field is
 * optional — each integration declares its own default — so workflows can
 * swap providers without rewriting node configs (`prompt`, `temperature`,
 * `maxTokens` are all identical across vendors).
 */
export const GenerateTextInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  /** Model identifier; defaults to the integration's DEFAULT_MODEL. */
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
});

export const GenerateTextOutputSchema = z.object({
  text: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  finishReason: z.string(),
});

export type GenerateTextInput = z.infer<typeof GenerateTextInputSchema>;
export type GenerateTextOutput = z.infer<typeof GenerateTextOutputSchema>;

/**
 * generateObject accepts a JSON Schema describing the desired output shape.
 * The AI SDK's `jsonSchema()` helper converts it into its internal schema
 * representation; the provider is asked to produce structured output that
 * matches.
 */
export const GenerateObjectInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  /**
   * JSON Schema of the desired output. Users may emit this via zod-to-json-schema
   * or hand-write it. Supplied as unknown so we can pass through any valid
   * JSON Schema shape; AI SDK validates on its side.
   */
  schema: z.unknown(),
});

export const GenerateObjectOutputSchema = z.object({
  object: z.unknown(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  finishReason: z.string(),
});

export type GenerateObjectInput = z.infer<typeof GenerateObjectInputSchema>;
export type GenerateObjectOutput = z.infer<typeof GenerateObjectOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-5";

export const manifest: IntegrationManifest = {
  name: "llm-anthropic",
  version: "0.1.0",
  description:
    "Anthropic Claude text + structured-output generation via the Vercel AI SDK.",
  authType: "apiKey",
  baseUrl: "https://api.anthropic.com",
  docsUrl: "https://docs.anthropic.com/en/api/getting-started",
  credentialTypes: [
    {
      name: "anthropicApiKey",
      displayName: "Anthropic API Key",
      authType: "apiKey",
      description:
        "An Anthropic API key (sk-ant-...). Create one at https://console.anthropic.com/settings/keys — you'll need a paid Anthropic account with Claude access.",
      documentationUrl: "https://console.anthropic.com/settings/keys",
      fields: [
        {
          name: "apiKey",
          displayName: "API Key",
          type: "password",
          required: true,
          description:
            "Starts with sk-ant-. Keep it secret; it authenticates every request and is billed per token.",
          deepLink: "https://console.anthropic.com/settings/keys",
          pattern: "^sk-ant-",
          oauthManaged: false,
        },
      ],
      test: {
        description:
          "Calls Claude with a 1-token prompt to validate the key. Costs ~$0.00001.",
      },
    },
  ],
  operations: [
    {
      name: "generate",
      description:
        "Text completion — returns plain text plus token usage and finish reason.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          system: { type: "string" },
          model: { type: "string" },
          temperature: { type: "number", minimum: 0, maximum: 2 },
          maxTokens: { type: "number", minimum: 1, maximum: 200_000 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["text", "usage", "finishReason"],
        properties: {
          text: { type: "string" },
          usage: {
            type: "object",
            required: ["inputTokens", "outputTokens"],
            properties: {
              inputTokens: { type: "number" },
              outputTokens: { type: "number" },
            },
          },
          finishReason: { type: "string" },
        },
      },
    },
    {
      name: "generateObject",
      description:
        "Structured-output completion — returns a JSON object matching the supplied JSON Schema, with token usage.",
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["prompt", "schema"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          system: { type: "string" },
          model: { type: "string" },
          temperature: { type: "number", minimum: 0, maximum: 2 },
          maxTokens: { type: "number", minimum: 1, maximum: 200_000 },
          schema: { type: "object" },
        },
      },
      outputSchema: {
        type: "object",
        required: ["object", "usage", "finishReason"],
        properties: {
          object: {},
          usage: {
            type: "object",
            required: ["inputTokens", "outputTokens"],
            properties: {
              inputTokens: { type: "number" },
              outputTokens: { type: "number" },
            },
          },
          finishReason: { type: "string" },
        },
      },
    },
  ],
};

// ── Provider factory ───────────────────────────────────────────────────────

/**
 * Build an Anthropic AI SDK LanguageModel. We accept an optional injected
 * provider so tests can substitute a MockLanguageModelV1 without touching
 * the real SDK surface.
 *
 * Resolution:
 *   1. If `ctx.credentials._providerOverride` is a LanguageModelV1, use it
 *      directly. (Test hook — never set in production.)
 *   2. Otherwise, build an AnthropicProvider with the extracted apiKey and
 *      call `.languageModel(modelId)`.
 */
function resolveModel(
  ctx: OperationContext,
  modelId: string,
  operation: string,
): LanguageModelV1 {
  const override = (ctx.credentials as Record<string, unknown> | null)?.[
    "_providerOverride"
  ];
  if (override && typeof override === "object" && "specificationVersion" in override) {
    return override as LanguageModelV1;
  }
  const apiKey = extractApiKey(ctx.credentials);
  if (!apiKey) {
    throw new AuthError({
      message: `llm-anthropic.${operation} requires an apiKey in ctx.credentials`,
      integration: "llm-anthropic",
      operation,
    });
  }
  const provider: AnthropicProvider = createAnthropic({ apiKey });
  return provider.languageModel(modelId);
}

// ── Handlers ───────────────────────────────────────────────────────────────

export const generate: OperationHandler<GenerateTextInput, GenerateTextOutput> = async (
  input,
  ctx,
) => {
  const parsed = GenerateTextInputSchema.parse(input);
  const modelId = parsed.model ?? DEFAULT_MODEL;
  const model = resolveModel(ctx, modelId, "generate");

  try {
    const result = await generateText({
      model,
      system: parsed.system,
      prompt: parsed.prompt,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
      abortSignal: ctx.signal,
    });

    const out: GenerateTextOutput = {
      text: result.text,
      usage: {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
      },
      finishReason: result.finishReason,
    };

    await ctx.snapshot?.record(
      "llm-anthropic.generate.200",
      { model: modelId, promptLength: parsed.prompt.length, hasSystem: parsed.system !== undefined },
      { finishReason: result.finishReason, textLength: result.text.length, usage: out.usage },
    );

    return out;
  } catch (err) {
    await ctx.snapshot?.record(
      "llm-anthropic.generate.error",
      { model: modelId, promptLength: parsed.prompt.length },
      { errorName: (err as { name?: string }).name ?? "unknown" },
    );
    mapProviderError(err, "llm-anthropic", "generate");
  }
};

export const generateObjectOp: OperationHandler<
  GenerateObjectInput,
  GenerateObjectOutput
> = async (input, ctx) => {
  const parsed = GenerateObjectInputSchema.parse(input);
  const modelId = parsed.model ?? DEFAULT_MODEL;
  const model = resolveModel(ctx, modelId, "generateObject");

  try {
    // jsonSchema() wraps a raw JSON Schema; we accept whatever the caller
    // supplies and pass it through. AI SDK validates structurally.
    const schema = jsonSchema(parsed.schema as Parameters<typeof jsonSchema>[0]);
    const result = await generateObject({
      model,
      system: parsed.system,
      prompt: parsed.prompt,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
      schema,
      abortSignal: ctx.signal,
    });

    const out: GenerateObjectOutput = {
      object: result.object,
      usage: {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
      },
      finishReason: result.finishReason,
    };

    await ctx.snapshot?.record(
      "llm-anthropic.generateObject.200",
      { model: modelId, promptLength: parsed.prompt.length, hasSystem: parsed.system !== undefined },
      { finishReason: result.finishReason, usage: out.usage },
    );

    return out;
  } catch (err) {
    await ctx.snapshot?.record(
      "llm-anthropic.generateObject.error",
      { model: modelId, promptLength: parsed.prompt.length },
      { errorName: (err as { name?: string }).name ?? "unknown" },
    );
    mapProviderError(err, "llm-anthropic", "generateObject");
  }
};

// ── testCredential ──────────────────────────────────────────────────────────

/**
 * Validate an Anthropic API key with a minimal generateText call (1 output
 * token). Cheap but not free — docs/CREDENTIALS_ANALYSIS.md §4.4 notes that
 * LLM providers don't offer free introspection endpoints; a ~$0.00001
 * round-trip is the honest cost of validation.
 */
export async function testCredential(
  _credentialTypeName: string,
  ctx: OperationContext,
): Promise<CredentialTestResult> {
  const startedAt = Date.now();
  const apiKey = extractApiKey(ctx.credentials);
  if (!apiKey && !(ctx.credentials as Record<string, unknown> | null)?.["_providerOverride"]) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: "llm-anthropic.testCredential: no apiKey in ctx.credentials",
      errorCode: "AUTH_INVALID",
    };
  }
  try {
    const model = resolveModel(ctx, DEFAULT_MODEL, "testCredential");
    await generateText({
      model,
      prompt: "ping",
      maxTokens: 1,
      abortSignal: ctx.signal,
    });
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      identity: { workspaceName: "anthropic" },
    };
  } catch (err) {
    const asErr = err as { statusCode?: number; message?: string };
    const latencyMs = Date.now() - startedAt;
    if (asErr.statusCode === 401 || asErr.statusCode === 403) {
      return {
        ok: false,
        latencyMs,
        error: `Anthropic ${asErr.statusCode} — API key invalid or revoked`,
        errorCode: "AUTH_INVALID",
      };
    }
    if (asErr.statusCode === 429) {
      return {
        ok: false,
        latencyMs,
        error: "Anthropic 429 — rate limited (try again shortly)",
        errorCode: "AUTH_INVALID",
      };
    }
    return {
      ok: false,
      latencyMs,
      error: `Anthropic error: ${asErr.message ?? String(err)}`,
      errorCode:
        asErr.statusCode !== undefined && asErr.statusCode >= 500
          ? "NETWORK_ERROR"
          : "AUTH_INVALID",
    };
  }
}

// ── Module export ───────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    generate: generate as OperationHandler,
    generateObject: generateObjectOp as OperationHandler,
  },
  testCredential,
};

export default integration;

// Re-export the shared anthropic binding so advanced users can go off-path.
export { anthropic };
