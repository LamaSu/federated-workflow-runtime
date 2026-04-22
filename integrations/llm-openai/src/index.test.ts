import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  IntegrationError,
  RateLimitError,
  type OperationContext,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import { MockLanguageModelV1 } from "ai/test";
import integration, {
  extractApiKey,
  generate,
  generateObjectOp,
  mapProviderError,
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
  mockModel?: MockLanguageModelV1;
  snapshot?: SnapshotRecorder;
  signal?: AbortSignal;
} = {}): OperationContext {
  const baseCreds =
    "credentials" in opts ? opts.credentials : { apiKey: "sk-test" };
  let creds: OperationContext["credentials"];
  if (opts.mockModel) {
    creds = { ...(typeof baseCreds === "object" && baseCreds !== null ? baseCreds : {}), _providerOverride: opts.mockModel } as OperationContext["credentials"];
  } else if (typeof baseCreds === "string") {
    creds = { apiKey: baseCreds } as OperationContext["credentials"];
  } else {
    creds = baseCreds as OperationContext["credentials"];
  }
  return {
    credentials: creds,
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

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@delightfulchorus/integration-llm-openai module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("llm-openai");
    expect(integration.manifest.authType).toBe("apiKey");
    const opNames = integration.manifest.operations.map((o) => o.name);
    expect(opNames).toContain("generate");
    expect(opNames).toContain("generateObject");
    expect(typeof integration.operations.generate).toBe("function");
    expect(typeof integration.operations.generateObject).toBe("function");
  });

  it("declares an apiKey credentialType with a fields catalog", () => {
    expect(integration.manifest.credentialTypes).toHaveLength(1);
    const ct = integration.manifest.credentialTypes![0]!;
    expect(ct.name).toBe("openaiApiKey");
    expect(ct.authType).toBe("apiKey");
    expect(ct.documentationUrl).toMatch(/^https:\/\/platform\.openai\.com/);
    expect(ct.fields).toHaveLength(1);
    const field = ct.fields![0]!;
    expect(field.name).toBe("apiKey");
    expect(field.type).toBe("password");
    expect(field.pattern).toBe("^sk-");
    expect(field.deepLink).toBe("https://platform.openai.com/api-keys");
  });

  it("exposes testCredential callable on the IntegrationModule", () => {
    expect(typeof integration.testCredential).toBe("function");
  });
});

// ── generate — happy path ──────────────────────────────────────────────────

describe("generate — happy path", () => {
  it("returns text + usage + finishReason from the provider", async () => {
    const mockModel = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 7 },
        text: "hello from gpt",
      }),
    });

    const snapshot = makeSnapshot();
    const out = await generate(
      { prompt: "say hi", maxTokens: 64 },
      makeContext({ mockModel, snapshot }),
    );
    expect(out.text).toBe("hello from gpt");
    expect(out.usage.inputTokens).toBe(5);
    expect(out.usage.outputTokens).toBe(7);
    expect(out.finishReason).toBe("stop");
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.key).toBe("llm-openai.generate.200");
  });

  it("passes system prompt + temperature + maxTokens through", async () => {
    const captured: Array<{ system?: unknown; temperature?: unknown; maxTokens?: unknown }> = [];
    const mockModel = new MockLanguageModelV1({
      doGenerate: async (args: unknown) => {
        const a = args as { prompt: Array<unknown>; temperature?: number; maxTokens?: number };
        const first = a.prompt[0] as { role?: string; content?: string } | undefined;
        captured.push({
          system: first?.role === "system" ? first.content : undefined,
          temperature: a.temperature,
          maxTokens: a.maxTokens,
        });
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1 },
          text: "ok",
        };
      },
    });

    await generate(
      { prompt: "p", system: "be helpful", temperature: 0.1, maxTokens: 10 },
      makeContext({ mockModel }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.system).toBe("be helpful");
    expect(captured[0]!.temperature).toBe(0.1);
    expect(captured[0]!.maxTokens).toBe(10);
  });
});

// ── generate — auth + errors ────────────────────────────────────────────────

describe("generate — auth + errors", () => {
  it("throws AuthError when no apiKey in ctx.credentials", async () => {
    await expect(
      generate({ prompt: "hi" }, makeContext({ credentials: null })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps provider 401 to AuthError", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => {
        const e = new Error("invalid api key") as Error & { statusCode?: number };
        e.statusCode = 401;
        throw e;
      },
    });
    await expect(
      generate({ prompt: "hi" }, makeContext({ mockModel })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps provider 429 to RateLimitError with retryAfterMs when present", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => {
        const e = new Error("rate limited") as Error & {
          statusCode?: number;
          retryAfter?: number;
        };
        e.statusCode = 429;
        e.retryAfter = 30;
        throw e;
      },
    });
    await expect(
      generate({ prompt: "hi" }, makeContext({ mockModel })),
    ).rejects.toMatchObject({ name: "RateLimitError", retryAfterMs: 30_000 });
  });

  it("maps provider 500 to retryable IntegrationError", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => {
        const e = new Error("server error") as Error & { statusCode?: number };
        e.statusCode = 500;
        throw e;
      },
    });
    try {
      await generate({ prompt: "hi" }, makeContext({ mockModel }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });

  it("records a cassette for error responses", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const snapshot = makeSnapshot();
    await expect(
      generate({ prompt: "hi" }, makeContext({ mockModel, snapshot })),
    ).rejects.toThrow();
    expect(snapshot.calls.some((c) => c.key.endsWith(".error"))).toBe(true);
  });
});

// ── generate — input validation ────────────────────────────────────────────

describe("generate — input validation", () => {
  it("rejects empty prompt", async () => {
    await expect(
      generate({ prompt: "" } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects temperature > 2", async () => {
    await expect(
      generate({ prompt: "hi", temperature: 5 } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects maxTokens over 200k", async () => {
    await expect(
      generate({ prompt: "hi", maxTokens: 200_001 } as never, makeContext()),
    ).rejects.toThrow();
  });
});

// ── generateObject — happy path ─────────────────────────────────────────────

describe("generateObject — happy path", () => {
  it("returns structured object matching the schema", async () => {
    const mockModel = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20 },
        text: JSON.stringify({ name: "bob", age: 42 }),
      }),
    });

    const snapshot = makeSnapshot();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
      additionalProperties: false,
    };

    const out = await generateObjectOp(
      { prompt: "make a person", schema },
      makeContext({ mockModel, snapshot }),
    );

    expect(out.object).toEqual({ name: "bob", age: 42 });
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(20);
    expect(out.finishReason).toBe("stop");
    expect(snapshot.calls[0]!.key).toBe("llm-openai.generateObject.200");
  });
});

// ── generateObject — auth + errors ─────────────────────────────────────────

describe("generateObject — auth + errors", () => {
  it("throws AuthError when no apiKey", async () => {
    await expect(
      generateObjectOp(
        { prompt: "hi", schema: { type: "object" } },
        makeContext({ credentials: null }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("records a cassette for error responses", async () => {
    const mockModel = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const snapshot = makeSnapshot();
    await expect(
      generateObjectOp(
        { prompt: "hi", schema: { type: "object" } },
        makeContext({ mockModel, snapshot }),
      ),
    ).rejects.toThrow();
    expect(snapshot.calls.some((c) => c.key.endsWith(".error"))).toBe(true);
  });
});

// ── testCredential ──────────────────────────────────────────────────────────

describe("testCredential", () => {
  it("returns ok:true when a minimal call succeeds", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
        text: "ok",
      }),
    });
    const result = await testCredential("openaiApiKey", makeContext({ mockModel }));
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns ok:false AUTH_INVALID when no apiKey", async () => {
    const result = await testCredential(
      "openaiApiKey",
      makeContext({ credentials: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("maps provider 401 to AUTH_INVALID", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => {
        const e = new Error("invalid key") as Error & { statusCode?: number };
        e.statusCode = 401;
        throw e;
      },
    });
    const result = await testCredential("openaiApiKey", makeContext({ mockModel }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("maps provider 5xx to NETWORK_ERROR", async () => {
    const mockModel = new MockLanguageModelV1({
      doGenerate: async () => {
        const e = new Error("upstream failure") as Error & { statusCode?: number };
        e.statusCode = 503;
        throw e;
      },
    });
    const result = await testCredential("openaiApiKey", makeContext({ mockModel }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NETWORK_ERROR");
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("extractApiKey", () => {
  it("accepts string credential", () => {
    expect(extractApiKey("sk-x")).toBe("sk-x");
  });

  it("accepts { apiKey }", () => {
    expect(extractApiKey({ apiKey: "sk-x" })).toBe("sk-x");
  });

  it("accepts { api_key }", () => {
    expect(extractApiKey({ api_key: "sk-x" })).toBe("sk-x");
  });

  it("accepts { token }", () => {
    expect(extractApiKey({ token: "sk-x" })).toBe("sk-x");
  });

  it("returns undefined for unrelated shapes", () => {
    expect(extractApiKey({ unrelated: 1 } as never)).toBeUndefined();
    expect(extractApiKey(null)).toBeUndefined();
    expect(extractApiKey(undefined)).toBeUndefined();
  });
});

describe("mapProviderError", () => {
  it("throws AuthError for 401", () => {
    const e = new Error("invalid") as Error & { statusCode?: number };
    e.statusCode = 401;
    expect(() => mapProviderError(e, "x", "y")).toThrow(AuthError);
  });

  it("throws RateLimitError for 429 and converts retryAfter seconds to ms", () => {
    const e = new Error("429") as Error & { statusCode?: number; retryAfter?: number };
    e.statusCode = 429;
    e.retryAfter = 15;
    try {
      mapProviderError(e, "x", "y");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(15_000);
    }
  });

  it("classifies 5xx as retryable IntegrationError", () => {
    const e = new Error("down") as Error & { statusCode?: number };
    e.statusCode = 503;
    try {
      mapProviderError(e, "x", "y");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });

  it("classifies 4xx (non-429) as non-retryable IntegrationError", () => {
    const e = new Error("bad request") as Error & { statusCode?: number };
    e.statusCode = 400;
    try {
      mapProviderError(e, "x", "y");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).retryable).toBe(false);
    }
  });
});
