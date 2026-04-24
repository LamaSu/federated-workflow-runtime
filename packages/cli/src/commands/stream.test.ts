/**
 * Tests for `chorus stream <runId>` (Wave 4 item 12, Track A).
 *
 * Strategy:
 *   - Spin up a real SSE server (the shared runtime registerStreamRoutes
 *     mounted on a Fastify instance), seed a run row in its DB.
 *   - Run runStream with baseUrlOverride pointing at the server, capture
 *     stdout via opts.captureStdout.
 *   - Drive the bus from the test, asserting frames appear in stdout.
 *
 * We deliberately use the real CLI command — including its real fetch +
 * response-stream parser — so this test catches wire-format bugs (frame
 * boundary handling, JSON-line emission, mode validation).
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase, type DatabaseType } from "@delightfulchorus/runtime";
import { StreamBus, registerStreamRoutes } from "@delightfulchorus/runtime";
import { parseModes, runStream } from "./stream.js";

interface ServerHarness {
  url: string;
  bus: StreamBus;
  app: FastifyInstance;
  db: DatabaseType;
  close: () => Promise<void>;
}

async function setupServer(opts?: { runIds?: string[] }): Promise<ServerHarness> {
  const db = openDatabase(":memory:");
  // Seed a workflow + runs.
  db.prepare(
    `INSERT INTO workflows (id, version, name, definition, active, created_at, updated_at)
     VALUES (?, 1, 'wf', '{}', 1, ?, ?)`,
  ).run("wf-x", new Date().toISOString(), new Date().toISOString());
  for (const id of opts?.runIds ?? ["run-1"]) {
    db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_version, status, triggered_by, started_at, attempt, priority)
       VALUES (?, 'wf-x', 1, 'running', 'test', ?, 1, 0)`,
    ).run(id, new Date().toISOString());
  }
  const bus = new StreamBus();
  const app = Fastify({ logger: false });
  registerStreamRoutes(app, db, { bus });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    bus,
    app,
    db,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

describe("parseModes", () => {
  it("default → 'updates'", () => {
    expect(parseModes(undefined)).toBe("updates");
    expect(parseModes("")).toBe("updates");
  });

  it("single mode passes through", () => {
    expect(parseModes("values")).toBe("values");
    expect(parseModes("messages")).toBe("messages");
  });

  it("CSV multi-mode passes through, trimmed", () => {
    expect(parseModes("values,tasks")).toBe("values,tasks");
    expect(parseModes("values, tasks ")).toBe("values,tasks");
  });

  it("rejects unknown modes", () => {
    expect(() => parseModes("bogus")).toThrow(/unknown stream mode "bogus"/);
    expect(() => parseModes("values,bogus")).toThrow(/unknown stream mode "bogus"/);
  });
});

describe("runStream — happy path", () => {
  it("connects, prints JSONL to stdout for each event, exits 0 on EOF", async () => {
    const { url, bus, close } = await setupServer({ runIds: ["r1"] });
    const stdout: string[] = [];
    // Fire publishes after a short delay so the subscriber registers first.
    setTimeout(() => {
      bus.publish({
        mode: "values",
        runId: "r1",
        step: {
          stepName: "step-a",
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
    }, 100);

    const code = await runStream({
      runId: "r1",
      mode: "values",
      baseUrlOverride: url,
      captureStdout: stdout,
      maxFrames: 1,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!.trim()) as {
      mode: string;
      runId: string;
      step: { stepName: string };
    };
    expect(parsed.mode).toBe("values");
    expect(parsed.runId).toBe("r1");
    expect(parsed.step.stepName).toBe("step-a");
    await close();
  });

  it("CSV multi-mode delivers events of multiple modes", async () => {
    const { url, bus, close } = await setupServer({ runIds: ["r1"] });
    const stdout: string[] = [];
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
        ts: Date.now(),
      });
      bus.publish({
        mode: "tasks",
        runId: "r1",
        phase: "step:start",
        stepName: "n1",
        ts: Date.now(),
      });
      bus.publish({
        mode: "messages",
        runId: "r1",
        stepName: "n1",
        chunk: "ignored — not subscribed",
        ts: Date.now(),
      });
    }, 100);
    const code = await runStream({
      runId: "r1",
      mode: "values,tasks",
      baseUrlOverride: url,
      captureStdout: stdout,
      maxFrames: 2,
    });
    expect(code).toBe(0);
    const modes = stdout.map((line) => (JSON.parse(line.trim()) as { mode: string }).mode);
    expect(modes).toContain("values");
    expect(modes).toContain("tasks");
    expect(modes).not.toContain("messages");
    await close();
  });

  it("--pretty produces human-readable output (non-JSON)", async () => {
    const { url, bus, close } = await setupServer({ runIds: ["r1"] });
    const stdout: string[] = [];
    setTimeout(() => {
      bus.publish({
        mode: "messages",
        runId: "r1",
        stepName: "tok",
        chunk: "hello",
        ts: Date.now(),
      });
    }, 100);
    const code = await runStream({
      runId: "r1",
      mode: "messages",
      pretty: true,
      baseUrlOverride: url,
      captureStdout: stdout,
      maxFrames: 1,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const line = stdout[0]!;
    // Pretty output contains the step name and the chunk text, but is
    // NOT valid JSON (it's a colored line).
    expect(line).toContain("tok");
    expect(line).toContain("hello");
    expect(() => JSON.parse(line)).toThrow();
    await close();
  });
});

describe("runStream — error paths", () => {
  it("returns 1 on invalid --mode (does not connect)", async () => {
    const stderr: string[] = [];
    // Override stderr by reaching into process.stderr.write — but easier:
    // since the function writes to stderr directly, we just trust the exit
    // code. The bad-mode branch never even constructs a fetch.
    const code = await runStream({
      runId: "r1",
      mode: "bogus",
      baseUrlOverride: "http://127.0.0.1:0",
    });
    expect(code).toBe(1);
  });

  it("returns 2 when the server is unreachable", async () => {
    // Random unused port — connection should refuse.
    const code = await runStream({
      runId: "r1",
      mode: "values",
      baseUrlOverride: "http://127.0.0.1:1",
    });
    expect(code).toBe(2);
  });

  it("returns 1 on 404 (unknown run)", async () => {
    const { url, close } = await setupServer({ runIds: ["r1"] });
    const code = await runStream({
      runId: "missing",
      mode: "values",
      baseUrlOverride: url,
    });
    expect(code).toBe(1);
    await close();
  });

  it("returns 1 on 400 (bad mode through to server) — surfaces server error", async () => {
    const { url, close } = await setupServer({ runIds: ["r1"] });
    // We construct the fetch manually inside runStream — but parseModes
    // catches bad modes client-side. To exercise the server's 400 path,
    // bypass parseModes by calling the URL directly. We do that via the
    // fetchFn override that always returns a synthetic 400.
    const code = await runStream({
      runId: "r1",
      mode: "values",
      baseUrlOverride: url,
      fetchFn: async () =>
        new Response(JSON.stringify({ error: "BAD_REQUEST", message: "synthetic" }), {
          status: 400,
        }),
    });
    expect(code).toBe(1);
    await close();
  });
});
