import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase } from "../db.js";
import { registerApiRoutes } from "./index.js";
import { buildManifest } from "./manifest.js";

function setup(apiToken: string | null = null) {
  const db = openDatabase(":memory:");
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db, { apiToken });
  return { db, app };
}

describe("GET /api/manifest", () => {
  it("returns a 200 with ApiManifest shape and cross-cutting headers", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/manifest" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-chorus-api-version"]).toBe("1");
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as ReturnType<typeof buildManifest>;
    expect(body.chorusApiVersion).toBe("1");
    expect(body.readOnly).toBe(true);
    expect(body.authMode).toBe("localhost");
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.length).toBeGreaterThanOrEqual(9);
    // Every endpoint has the required fields — this is the contract an agent reads.
    for (const ep of body.endpoints) {
      expect(typeof ep.path).toBe("string");
      expect(ep.path.startsWith("/api/")).toBe(true);
      expect(ep.method).toBe("GET");
      expect(typeof ep.description).toBe("string");
      expect(typeof ep.responseShape).toBe("string");
    }
    // Data model keys reference every endpoint's response.
    expect(body.dataModel.WorkflowSummary).toBeDefined();
    expect(body.dataModel.RunDetail).toBeDefined();
    expect(body.dataModel.ErrorSignatureSummary).toBeDefined();
    expect(body.dataModel.PatchDetail).toBeDefined();
    expect(body.dataModel.IntegrationSummary).toBeDefined();
    // Capabilities: at least the CRUD list actions.
    expect(body.capabilities).toContain("workflows.list");
    expect(body.capabilities).toContain("runs.list");
    expect(body.capabilities).toContain("errors.list");
    expect(body.capabilities).toContain("patches.list");
    expect(body.capabilities).toContain("integrations.list");
    await app.close();
    db.close();
  });

  it("reports authMode='bearer' when a token is configured", async () => {
    const { db, app } = setup("secret");
    const res = await app.inject({
      method: "GET",
      url: "/api/manifest",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { authMode: string }).authMode).toBe("bearer");
    await app.close();
    db.close();
  });

  it("rejects requests without the bearer token when auth is enabled", async () => {
    const { db, app } = setup("secret");
    const res = await app.inject({ method: "GET", url: "/api/manifest" });
    expect(res.statusCode).toBe(401);
    const res2 = await app.inject({
      method: "GET",
      url: "/api/manifest",
      headers: { authorization: "Bearer WRONG" },
    });
    expect(res2.statusCode).toBe(401);
    await app.close();
    db.close();
  });

  it("does not interfere with non-/api/ routes", async () => {
    const { db, app } = setup("secret");
    app.get("/health", async () => ({ status: "ok" }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    // The /api/ X-Chorus-API-Version header should NOT leak to /health.
    expect(res.headers["x-chorus-api-version"]).toBeUndefined();
    await app.close();
    db.close();
  });
});

describe("buildManifest — pure function", () => {
  it("emits distinct paths for every endpoint", () => {
    const m = buildManifest("localhost");
    const paths = m.endpoints.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("generatedAt is a parseable ISO timestamp", () => {
    const m = buildManifest("localhost");
    expect(() => new Date(m.generatedAt).toISOString()).not.toThrow();
  });
});
