import { describe, expect, it, vi, afterEach } from "vitest";
import { parsePayload, baseUrlFromConfig } from "./event.js";
import type { ChorusConfig } from "../config.js";

/**
 * Unit tests for the CLI event command. We do NOT spin up a Fastify server
 * here — the CLI sends HTTP via fetch, so we stub globalThis.fetch. This
 * keeps the CLI test suite fast and unit-scoped; end-to-end flows live in
 * the runtime's events API tests.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parsePayload", () => {
  it("empty string → empty object", async () => {
    expect(await parsePayload(undefined)).toEqual({});
    expect(await parsePayload("")).toEqual({});
  });

  it("raw JSON → parsed object", async () => {
    expect(await parsePayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("throws on invalid JSON", async () => {
    await expect(parsePayload("{not json}")).rejects.toThrow(/not valid JSON/);
  });

  it("@filepath reads a JSON file", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-cli-"));
    const f = path.join(dir, "p.json");
    await fs.writeFile(f, JSON.stringify({ x: "hi" }));
    try {
      expect(await parsePayload("@" + f)).toEqual({ x: "hi" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("baseUrlFromConfig", () => {
  it("picks http://host:port, rewrites 0.0.0.0 → 127.0.0.1", () => {
    const cfg = {
      name: "p",
      version: 1,
      workflowsDir: "w",
      database: { path: "d" },
      server: { host: "0.0.0.0", port: 1234 },
      repair: { autoAttempt: false, model: "claude-sonnet-4-5", dailyBudget: 10 },
      registry: {
        url: "https://registry.chorus.dev",
        pollIntervalMs: 300_000,
      },
    } as ChorusConfig;
    expect(baseUrlFromConfig(cfg)).toBe("http://127.0.0.1:1234");
  });
});

describe("event fire / watch / list-waiting — HTTP stubs", () => {
  it("fire: POSTs to /api/events with correct body, exits 0 on 202", async () => {
    const { fireEvent } = await import("./event.js");
    const captured: { url: string; method?: string; headers: unknown; body: unknown }[] = [];
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const i = (init ?? {}) as { method?: string; headers?: unknown; body?: unknown };
      captured.push({ url, method: i.method, headers: i.headers, body: i.body });
      return new Response(
        JSON.stringify({
          id: "evt-1",
          type: "order.paid",
          emittedAt: "2026-04-15T00:00:00.000Z",
          triggeredRunIds: [],
          resolvedWaitingSteps: 0,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const code = await fireEvent({
      type: "order.paid",
      payload: JSON.stringify({ amount: 100 }),
      correlationId: "corr-1",
      baseUrl: "http://127.0.0.1:3710",
    });
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:3710/api/events");
    expect(captured[0]?.method).toBe("POST");
    const sent = JSON.parse(captured[0]!.body as string) as {
      type: string;
      payload: { amount: number };
      correlationId: string;
    };
    expect(sent.type).toBe("order.paid");
    expect(sent.payload.amount).toBe(100);
    expect(sent.correlationId).toBe("corr-1");
  });

  it("fire: exits 1 on non-202 response", async () => {
    const { fireEvent } = await import("./event.js");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "BAD_REQUEST" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const code = await fireEvent({
      type: "bad",
      baseUrl: "http://127.0.0.1:3710",
    });
    expect(code).toBe(1);
  });

  it("watch: hits GET /api/events and prints 0 events", async () => {
    const { watchEvents } = await import("./event.js");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const code = await watchEvents({ baseUrl: "http://127.0.0.1:3710" });
    expect(code).toBe(0);
  });

  it("watch: --json outputs JSON on stdout", async () => {
    const { watchEvents } = await import("./event.js");
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              id: "a",
              type: "x",
              payload: {},
              source: null,
              emittedAt: "2026-04-15T00:00:00.000Z",
              correlationId: null,
              consumedByRun: null,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await watchEvents({
        baseUrl: "http://127.0.0.1:3710",
        json: true,
      });
      expect(code).toBe(0);
      const out = chunks.join("");
      const parsed = JSON.parse(out) as { events: Array<{ type: string }> };
      expect(parsed.events[0]?.type).toBe("x");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("list-waiting: returns 0 when empty", async () => {
    const { listWaiting } = await import("./event.js");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ waiting: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const code = await listWaiting({ baseUrl: "http://127.0.0.1:3710" });
    expect(code).toBe(0);
  });

  it("list-waiting: exits 1 on non-200", async () => {
    const { listWaiting } = await import("./event.js");
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const code = await listWaiting({ baseUrl: "http://127.0.0.1:3710" });
    expect(code).toBe(1);
  });

  it("fire: passes bearer token when apiToken set", async () => {
    const { fireEvent } = await import("./event.js");
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_input: unknown, init?: unknown) => {
      const i = (init ?? {}) as { headers?: Record<string, string> };
      headers = i.headers ?? {};
      return new Response(
        JSON.stringify({
          id: "e",
          type: "x",
          emittedAt: "2026-04-15T00:00:00.000Z",
          triggeredRunIds: [],
          resolvedWaitingSteps: 0,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await fireEvent({
      type: "x",
      baseUrl: "http://127.0.0.1:3710",
      apiToken: "sekret",
    });
    expect(headers["authorization"]).toBe("Bearer sekret");
  });
});
