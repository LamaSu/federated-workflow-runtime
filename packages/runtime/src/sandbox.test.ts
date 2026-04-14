import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SandboxError, runIsolated } from "./sandbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "__fixtures__", "handlers.cjs");

describe("runIsolated — basic invocation", () => {
  it("returns output from a simple handler", async () => {
    const res = await runIsolated<{ echoed: { hello: string } }>({
      handlerPath: fixture,
      exportName: "echo",
      input: { hello: "world" },
      timeoutMs: 10_000,
    });
    expect(res.output.echoed).toEqual({ hello: "world" });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("invokes a named export explicitly", async () => {
    const res = await runIsolated({
      handlerPath: fixture,
      exportName: "echo",
      input: "payload",
      timeoutMs: 10_000,
    });
    expect(res.output).toEqual({ echoed: "payload" });
  });

  it("passes numeric input cleanly", async () => {
    const res = await runIsolated<number>({
      handlerPath: fixture,
      exportName: "doubleInput",
      input: 21,
      timeoutMs: 10_000,
    });
    expect(res.output).toBe(42);
  });
});

describe("runIsolated — errors", () => {
  it("propagates a thrown error from the handler as a SandboxError", async () => {
    await expect(
      runIsolated({
        handlerPath: fixture,
        exportName: "throws",
        input: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      name: "SandboxError",
      kind: "runtime",
      message: expect.stringContaining("kaboom"),
    });
  });

  it("surfaces missing export as a runtime error", async () => {
    await expect(
      runIsolated({
        handlerPath: fixture,
        exportName: "nonExistent",
        input: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(SandboxError);
  });

  it("times out a hung handler and kills the child", async () => {
    await expect(
      runIsolated({
        handlerPath: fixture,
        exportName: "sleepForever",
        input: {},
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({
      name: "SandboxError",
      kind: "timeout",
    });
  });

  it("survives a hard subprocess crash without taking down the parent", async () => {
    // This is THE critical isolation property: a child crash MUST NOT crash
    // the test runner. We expect a SandboxError with kind 'runtime' or
    // 'crash' depending on whether the uncaughtException handler won the
    // race or the process exited first.
    let caught: unknown = null;
    try {
      await runIsolated({
        handlerPath: fixture,
        exportName: "crashHard",
        input: {},
        timeoutMs: 5_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    const e = caught as SandboxError;
    expect(["runtime", "crash"]).toContain(e.kind);
    // If the parent is still alive, this assertion runs — which is the point.
    expect(typeof process.pid).toBe("number");
  });

  it("can be aborted via signal", async () => {
    const ac = new AbortController();
    const p = runIsolated({
      handlerPath: fixture,
      exportName: "sleepForever",
      input: {},
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({
      name: "SandboxError",
      kind: "runtime",
      message: expect.stringContaining("aborted"),
    });
  });
});
