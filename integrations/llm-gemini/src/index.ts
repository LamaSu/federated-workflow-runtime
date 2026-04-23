/**
 * @delightfulchorus/integration-llm-gemini
 *
 * Thin adapter: wraps Vercel AI SDK's `generateText` and `generateObject`
 * against Google's Gemini models (Google AI Studio / Generative Language API).
 * One of three first-party LLM integrations (anthropic, openai, gemini) that
 * share the same operation shape — workflows can swap providers without
 * rewiring nodes.
 *
 * Auth: a Google AI Studio API key (user-supplied; the runtime hands it over
 * via ctx.credentials.apiKey). The SDK sends it as the `x-goog-api-key`
 * header.
 *
 * Chorus contract notes:
 *   - 401 / 403 / "API_KEY_INVALID" → AuthError (non-retryable).
 *   - 429 → RateLimitError with retryAfter when the SDK surfaces it.
 *   - Any other API error → IntegrationError with the provider's error code
 *     preserved (useful for the repair-agent's error-signature matching).
 *   - Cassette records track input shape (prompt length, model) and output
 *     shape (text length, token counts) — never verbatim content.
 */
import {
  createGoogleGenerativeAI,
  google,
  type GoogleGenerativeAIProvider,
} from "@ai-sdk/google";
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

// ── Shared helpers ─────────────────────────────────────────────────────────

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

export function mapProviderError(
  err: unknown,
  integration: string,
  operation: string,
): never {
  const asErr = err as {
    name?: string;
    statusCode?: number;
    message?: string;
    cause?: unknown;
  };
  const status = asErr.statusCode;
  const message = asErr.message ?? String(err);

  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|invalid.*api.*key|unauthorized|permission.?denied/i.test(message)
  ) {
    throw new AuthError({
      message: `${integration}.${operation}: ${message}`,
      integration,
      operation,
      httpStatus: status,
    });
  }

  if (status === 429 || /rate.?limit|quota.?exceeded|resource.?exhausted/i.test(message)) {
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

export const GenerateTextInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
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

export const GenerateObjectInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
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

const DEFAULT_MODEL = "gemini-2.0-flash-exp";

export const manifest: IntegrationManifest = {
  name: "llm-gemini",
  version: "0.1.0",
  description:
    "Google Gemini text + structured-output generation via the Vercel AI SDK.",
  authType: "apiKey",
  baseUrl: "https://generativelanguage.googleapis.com",
  docsUrl: "https://ai.google.dev/gemini-api/docs",
  credentialTypes: [
    {
      name: "googleAiStudioApiKey",
      displayName: "Google AI Studio API Key",
      authType: "apiKey",
      description:
        "An API key issued by Google AI Studio for the Generative Language (Gemini) API. Create one at https://aistudio.google.com/app/apikey — the free tier supports development use.",
      documentationUrl: "https://aistudio.google.com/app/apikey",
      fields: [
        {
          name: "apiKey",
          displayName: "API Key",
          type: "password",
          required: true,
          description:
            "Usually starts with AIzaSy... Keep it secret; it authenticates every request.",
          deepLink: "https://aistudio.google.com/app/apikey",
          pattern: "^[A-Za-z0-9_\\-]{20,}$",
          oauthManaged: false,
        },
      ],
      test: {
        description:
          "Calls Gemini with a 1-token prompt to validate the key. Free on the free tier.",
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
      message: `llm-gemini.${operation} requires an apiKey in ctx.credentials`,
      integration: "llm-gemini",
      operation,
    });
  }
  const provider: GoogleGenerativeAIProvider = createGoogleGenerativeAI({ apiKey });
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
      "llm-gemini.generate.200",
      { model: modelId, promptLength: parsed.prompt.length, hasSystem: parsed.system !== undefined },
      { finishReason: result.finishReason, textLength: result.text.length, usage: out.usage },
    );

    return out;
  } catch (err) {
    await ctx.snapshot?.record(
      "llm-gemini.generate.error",
      { model: modelId, promptLength: parsed.prompt.length },
      { errorName: (err as { name?: string }).name ?? "unknown" },
    );
    mapProviderError(err, "llm-gemini", "generate");
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
      "llm-gemini.generateObject.200",
      { model: modelId, promptLength: parsed.prompt.length, hasSystem: parsed.system !== undefined },
      { finishReason: result.finishReason, usage: out.usage },
    );

    return out;
  } catch (err) {
    await ctx.snapshot?.record(
      "llm-gemini.generateObject.error",
      { model: modelId, promptLength: parsed.prompt.length },
      { errorName: (err as { name?: string }).name ?? "unknown" },
    );
    mapProviderError(err, "llm-gemini", "generateObject");
  }
};

// ── testCredential ──────────────────────────────────────────────────────────

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
      error: "llm-gemini.testCredential: no apiKey in ctx.credentials",
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
      identity: { workspaceName: "google-ai-studio" },
    };
  } catch (err) {
    const asErr = err as { statusCode?: number; message?: string };
    const latencyMs = Date.now() - startedAt;
    if (asErr.statusCode === 401 || asErr.statusCode === 403) {
      return {
        ok: false,
        latencyMs,
        error: `Gemini ${asErr.statusCode} — API key invalid or revoked`,
        errorCode: "AUTH_INVALID",
      };
    }
    if (asErr.statusCode === 429) {
      return {
        ok: false,
        latencyMs,
        error: "Gemini 429 — rate limited (try again shortly)",
        errorCode: "AUTH_INVALID",
      };
    }
    return {
      ok: false,
      latencyMs,
      error: `Gemini error: ${asErr.message ?? String(err)}`,
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

export { google };
