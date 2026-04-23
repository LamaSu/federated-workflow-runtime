import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase } from "../db.js";
import { StreamBus } from "../stream-bus.js";
import { registerApiRoutes } from "./index.js";

/**
 * Tests for GET /api/run/:runId/stream (Wave 4 item 12, Track A).
 *
 * Approach: spin up a real Fastify on an ephemeral port, fire fetch()
 * with a streaming body reader, parse SSE frames as they arrive. We do
 * NOT use the inject() shortcut because inject buffers the entire
 * response — that defeats the test's purpose (the endpoint MUST stream).
 *
 * What's covered:
 *   - 404 for unknown runId
 *   - 400 for invalid mode
 *   - default mode = values
 *   - per-mode delivery (values, updates, messages, tasks)
 *   - multi-mode CSV (values,tasks)
 *   - updates mode backfills existing step rows on connect
 *   - SSE wire format (data: <json>\n\n) parses cleanly with EventSource-style logic
 *   - heartbeat ":keepalive" frames don't poison data parsing (covered indirectly
 *     via the parser ignoring leading colon)
 */

interface SseFrame {
  data: unknown;
}

/**
 * Read SSE frames from a body stream until `predicate` is satisfied or
 * `timeoutMs` elapses. Yields parsed JSON data per frame.
 */
async function readSseFrames(
  resp: Response,
  predicate: (frames: SseFrame[]) => boolean,
  timeoutMs = 4_000,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  if (!resp.body) throw new Error("response has no body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 200),
      ),
    ]);
    if (done) {
      if (predicate(frames)) return frames;
      // Body finished but predicate not met → still return what we have.
      if (!value) {
        // Try once more — maybe more arrived since the timeout race.
        if (predicate(frames)) return frames;
        // Stream ended; stop polling.
        break;
      }
    }
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      // Split on double-newline = one SSE frame.
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = frame.split("\n");
        for (const line of lines) {
          if (line.startsWith(":")) continue; // SSE comment (heartbeat)
          if (line.startsWith("data: ")) {
            const payload = line.slice("data: ".length);
            try {
              frames.push({ data: JSON.parse(payload) });
            } catch {
              frames.push({ data: payload });
            }
          }
        }
        if (predicate(frames)) {
          // Cancel the reader so the server-side close hook fires.
          await reader.cancel();
          return frames;
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  }
  await reader.cancel();
  return frames;
}

async function setupServer(opts?: {
  insertRun?: { runId: string; workflowId?: string };
}): Promise<{
  url: string;
  bus: StreamBus;
  close: () => Promise<void>;
  insertStep: (
    runId: string,
    stepName: string,
    status: "running" | "success" | "failed",
    output?: unknown,
  ) => void;
}> {
  const db = openDatabase(":memory:");
  const bus = new StreamBus();
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db, { streamBus: bus });

  if (opts?.insertRun) {
    db.prepare(
      `INSERT INTO workflows (id, version, name, definition, active, created_at, updated_at)
       VALUES (?, 1, 'wf', '{}', 1, ?, ?)`,
    ).run(opts.insertRun.workflowId ?? "wf-x", new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_version, status, triggered_by, started_at, attempt, priority)
       VALUES (?, ?, 1, 'running', 'test', ?, 1, 0)`,
    ).run(opts.insertRun.runId, opts.insertRun.workflowId ?? "wf-x", new Date().toISOString());
  }

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no addr");

  const insertStep = (
    runId: string,
    stepName: string,
    status: "running" | "success" | "failed",
    output: unknown = null,
  ): void => {
    db.prepare(
      `INSERT INTO steps
        (run_id, step_name, attempt, status, input, output, error,
         error_sig_hash, started_at, finished_at, duration_ms)
       VALUES (?, ?, 1, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      runId,
      stepName,
      status,
      output === null ? null : JSON.stringify(output),
      new Date().toISOString(),
      status === "running" ? null : new Date().toISOString(),
      status === "running" ? null : 10,
    );
  };

  return {
    url: `http://127.0.0.1:${addr.port}`,
    bus,
    insertStep,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

describe("GET /api/run/:runId/stream — basic correctness", () => {
  it("404 for unknown run", async () => {
    const { url, close } = await setupServer();
    const resp = await fetch(`${url}/api/run/missing/stream`);
    expect(resp.status).toBe(404);
    await close();
  });

  it("400 for invalid mode", async () => {
    const { url, close } = await setupServer({ insertRun: { runId: "r1" } });
    const resp = await fetch(`${url}/api/run/r1/stream?mode=bogus`);
    expect(resp.status).toBe(400);
    await close();
  });

  it("default mode = values; emits a values event when bus publishes", async () => {
    const { url, bus, close } = await setupServer({ insertRun: { runId: "r1" } });
    const resp = await fetch(`${url}/api/run/r1/stream`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    // Publish after a tiny delay so the subscriber is registered.
    setTimeout(() => {
      bus.publish({
        mode: "values",
        runId: "r1",
        step: {
          stepName: "s1",
          status: "success",
          attempt: 1,
          output: { ok: true },
          error: null,
          durationMs: 5,
          startedAt: "2026-04-23T00:00:00Z",
          finishedAt: "2026-04-23T00:00:00.005Z",
        },
        ts: Date.now(),
      });
    }, 50);

    const frames = await readSseFrames(resp, (f) => f.length >= 1);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const f = frames[0]!.data as { mode: string; step: { stepName: string } };
    expect(f.mode).toBe("values");
    expect(f.step.stepName).toBe("s1");
    await close();
  });
});

describe("GET /api/run/:runId/stream — per-mode delivery", () => {
  it("messages mode delivers ctx.stream.write chunks", async () => {
    const { url, bus, close } = await setupServer({ insertRun: { runId: "r1" } });
    const resp = await fetch(`${url}/api/run/r1/stream?mode=messages`);
    expect(resp.status).toBe(200);
    setTimeout(() => {
      bus.publish({ mode: "messages", runId: "r1", stepName: "tok", chunk: "a", ts: 1 });
      bus.publish({ mode: "messages", runId: "r1", stepName: "tok", chunk: "b", ts: 2 });
      bus.publish({ mode: "messages", runId: "r1", stepName: "tok", chunk: "c", ts: 3 });
    }, 50);
    const frames = await readSseFrames(resp, (f) => f.length >= 3);
    expect(frames).toHaveLength(3);
    const chunks = frames.map((f) => (f.data as { chunk: string }).chunk);
    expect(chunks).toEqual(["a", "b", "c"]);
    await close();
  });

  it("tasks mode delivers step:start / step:end", async () => {
    const { url, bus, close } = await setupServer({ insertRun: { runId: "r1" } });
    const resp = await fetch(`${url}/api/run/r1/stream?mode=tasks`);
    setTimeout(() => {
      bus.publish({ mode: "tasks", runId: "r1", phase: "step:start", stepName: "n1", ts: 1 });
      bus.publish({
        mode: "tasks",
        runId: "r1",
        phase: "step:end",
        stepName: "n1",
        status: "success",
        ts: 2,
      });
    }, 50);
    const frames = await readSseFrames(resp, (f) => f.length >= 2);
    expect(frames).toHaveLength(2);
    expect((frames[0]!.data as { phase: string }).phase).toBe("step:start");
    expect((frames[1]!.data as { phase: string }).phase).toBe("step:end");
    await close();
  });

  it("multi-mode CSV (values,tasks) delivers both", async () => {
    const { url, bus, close } = await setupServer({ insertRun: { runId: "r1" } });
    const resp = await fetch(`${url}/api/run/r1/stream?mode=values,tasks`);
    setTimeout(() => {
      bus.publish({
        mode: "values",
        runId: "r1",
        step: {
          stepName: "n1",
          status: "running",
          attempt: 1,
          output: null,
          error: null,
          durationMs: null,
          startedAt: "2026-04-23T00:00:00Z",
          finishedAt: null,
        },
        ts: 1,
      });
      bus.publish({ mode: "tasks", runId: "r1", phase: "step:start", stepName: "n1", ts: 2 });
      bus.publish({
        mode: "messages",
        runId: "r1",
        stepName: "n1",
        chunk: "ignored",
        ts: 3,
      });
    }, 50);
    const frames = await readSseFrames(resp, (f) => f.length >= 2, 1500);
    const modes = frames.map((f) => (f.data as { mode: string }).mode);
    expect(modes).toContain("values");
    expect(modes).toContain("tasks");
    expect(modes).not.toContain("messages");
    await close();
  });

  it("updates mode backfills existing step rows on connect", async () => {
    const { url, insertStep, close } = await setupServer({
      insertRun: { runId: "r1" },
    });
    insertStep("r1", "step-a", "success", { v: 1 });
    insertStep("r1", "step-b", "running");
    const resp = await fetch(`${url}/api/run/r1/stream?mode=updates`);
    const frames = await readSseFrames(resp, (f) => f.length >= 2, 2000);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const stepNames = frames.map(
      (f) => (f.data as { step: { stepName: string } }).step.stepName,
    );
    expect(stepNames).toContain("step-a");
    expect(stepNames).toContain("step-b");
    await close();
  });
});

describe("GET /api/run/:runId/stream — isolation", () => {
  it("publishes to runId X do not reach a subscriber on runId Y", async () => {
    const { url, bus, close } = await setupServer({ insertRun: { runId: "r1" } });
    // Insert a second run so the route doesn't 404 on /r2.
    const resp1 = await fetch(`${url}/api/run/r1/stream?mode=values`);
    setTimeout(() => {
      bus.publish({
        mode: "values",
        runId: "OTHER",
        step: {
          stepName: "x",
          status: "success",
          attempt: 1,
          output: null,
          error: null,
          durationMs: null,
          startedAt: null,
          finishedAt: null,
        },
        ts: 1,
      });
      bus.publish({
        mode: "values",
        runId: "r1",
        step: {
          stepName: "ours",
          status: "success",
          attempt: 1,
          output: null,
          error: null,
          durationMs: null,
          startedAt: null,
          finishedAt: null,
        },
        ts: 2,
      });
    }, 50);
    const frames = await readSseFrames(resp1, (f) => f.length >= 1);
    expect(frames).toHaveLength(1);
    expect((frames[0]!.data as { step: { stepName: string } }).step.stepName).toBe("ours");
    await close();
  });
});
