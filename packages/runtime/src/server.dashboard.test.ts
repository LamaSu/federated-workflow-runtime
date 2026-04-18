import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ChorusServer } from "./server.js";
import { MINIMAL_HTML } from "./static/index.js";
import { setDashboard, resetDashboard } from "./static/holder.js";

/**
 * Server-level route tests: the ambient dashboard is reachable at both
 * `/` and `/dashboard`. The HTML we get back must be the current bundled
 * dashboard, and the response must carry the html content-type.
 *
 * These tests sit next to server.ts (not in src/api) because `/` is NOT
 * part of the /api/* surface and therefore isn't under the api test
 * module.
 */

/**
 * The loader is called only when the executor runs a workflow. These
 * tests never trigger a run, so returning a minimal stub is enough.
 */
const stubLoader: import("./executor.js").IntegrationLoader = async () =>
  ({
    manifest: {
      name: "stub",
      version: "0.0.0",
      description: "",
      authType: "none",
    },
    operations: {},
  }) as unknown as import("@delightfulchorus/core").IntegrationModule;

async function makeServer(): Promise<ChorusServer> {
  return createServer({
    dbPath: ":memory:",
    integrationLoader: stubLoader,
    encryptionKey: Buffer.alloc(32, 1),
  });
}

describe("Ambient dashboard routes", () => {
  let server: ChorusServer | null = null;

  afterEach(async () => {
    resetDashboard();
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("GET / returns the current dashboard HTML with html content-type", async () => {
    server = await makeServer();
    const res = await server.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["etag"]).toMatch(/^W\/"/);
    expect(res.body.startsWith("<!doctype html>")).toBe(true);
    expect(res.body).toBe(MINIMAL_HTML);
  });

  it("GET /dashboard serves the same HTML as GET /", async () => {
    server = await makeServer();
    const rootRes = await server.app.inject({ method: "GET", url: "/" });
    const dashRes = await server.app.inject({ method: "GET", url: "/dashboard" });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.body).toBe(rootRes.body);
    expect(dashRes.headers["etag"]).toBe(rootRes.headers["etag"]);
  });

  it("setDashboard swap is visible on subsequent GET /", async () => {
    server = await makeServer();
    const custom = "<!doctype html>\n<html><body>CUSTOM</body></html>";
    setDashboard(custom);
    const res = await server.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(custom);
    expect(res.body).not.toBe(MINIMAL_HTML);
  });

  it("dashboard routes do NOT require the bearer token (unauth is ok)", async () => {
    // Set CHORUS_API_TOKEN via the constructor: the dashboard must load
    // without a token so the browser auto-open works in bearer mode.
    const sv = createServer({
      dbPath: ":memory:",
      integrationLoader: stubLoader,
      encryptionKey: Buffer.alloc(32, 1),
      apiToken: "super-secret",
    });
    try {
      // Unauthenticated request to the dashboard: 200 OK.
      const ok = await sv.app.inject({ method: "GET", url: "/" });
      expect(ok.statusCode).toBe(200);
      // But /api/workflows still requires the token (sanity check):
      const denied = await sv.app.inject({ method: "GET", url: "/api/workflows" });
      expect(denied.statusCode).toBe(401);
    } finally {
      await sv.close();
    }
  });
});
