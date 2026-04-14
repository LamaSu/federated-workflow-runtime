import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase, type DatabaseType } from "../db.js";
import { registerApiRoutes } from "./index.js";
import { PatchSummarySchema, PatchDetailSchema } from "./patches.js";

function setup() {
  const db = openDatabase(":memory:");
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db);
  return { db, app };
}

function seedPatch(
  db: DatabaseType,
  id: string,
  opts: {
    integration?: string;
    state?: string;
    version?: string;
    signatureHash?: string;
    appliedAt?: string | null;
    manifest?: Record<string, unknown>;
    sigstore?: Buffer | null;
    ed25519?: Buffer | null;
  } = {},
) {
  db.prepare(
    `INSERT INTO patches
       (id, integration, signature_hash, version, state, manifest,
        sigstore_bundle, ed25519_sig, applied_at, rolled_back_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.integration ?? "http-generic",
    opts.signatureHash ?? "sig-abc",
    opts.version ?? "0.2.0",
    opts.state ?? "proposed",
    JSON.stringify(opts.manifest ?? { description: "Fix rate-limit regression" }),
    opts.sigstore ?? null,
    opts.ed25519 ?? null,
    opts.appliedAt ?? null,
    null,
  );
}

describe("GET /api/patches", () => {
  it("returns [] when none", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/patches" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ patches: [] });
    await app.close();
    db.close();
  });

  it("lists patches", async () => {
    const { db, app } = setup();
    seedPatch(db, "p-1", { state: "fleet", appliedAt: "2026-04-14T00:00:00.000Z" });
    seedPatch(db, "p-2", { state: "proposed" });
    const res = await app.inject({ method: "GET", url: "/api/patches" });
    const body = res.json() as { patches: Array<{ id: string; state: string }> };
    expect(body.patches).toHaveLength(2);
    for (const p of body.patches) {
      expect(() => PatchSummarySchema.parse(p)).not.toThrow();
    }
    await app.close();
    db.close();
  });

  it("filters by integration and stage", async () => {
    const { db, app } = setup();
    seedPatch(db, "p-http-fleet", { integration: "http-generic", state: "fleet" });
    seedPatch(db, "p-http-rev", { integration: "http-generic", state: "revoked" });
    seedPatch(db, "p-slack-fleet", { integration: "slack-send", state: "fleet" });
    const byIntegration = await app.inject({
      method: "GET",
      url: "/api/patches?integration=slack-send",
    });
    expect((byIntegration.json() as { patches: unknown[] }).patches).toHaveLength(1);
    const byStage = await app.inject({ method: "GET", url: "/api/patches?stage=revoked" });
    const stageBody = byStage.json() as { patches: Array<{ id: string }> };
    expect(stageBody.patches).toHaveLength(1);
    expect(stageBody.patches[0]!.id).toBe("p-http-rev");
    await app.close();
    db.close();
  });
});

describe("GET /api/patches/:id", () => {
  it("returns 404 when unknown", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/patches/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it("returns detail with manifest + signature flags", async () => {
    const { db, app } = setup();
    seedPatch(db, "p-detail", {
      manifest: { description: "Repair for 429 handling" },
      sigstore: Buffer.from("sigstore-bundle"),
      ed25519: Buffer.from("ed25519-sig-bytes"),
    });
    const res = await app.inject({ method: "GET", url: "/api/patches/p-detail" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { patch: unknown };
    const parsed = PatchDetailSchema.parse(body.patch);
    expect(parsed.id).toBe("p-detail");
    expect(parsed.hasSigstoreBundle).toBe(true);
    expect(parsed.hasEd25519Signature).toBe(true);
    expect((parsed.manifest as { description: string }).description).toBe(
      "Repair for 429 handling",
    );
    await app.close();
    db.close();
  });

  it("handles patches with no sigs correctly (both false)", async () => {
    const { db, app } = setup();
    seedPatch(db, "p-unsigned");
    const res = await app.inject({ method: "GET", url: "/api/patches/p-unsigned" });
    const body = res.json() as { patch: { hasSigstoreBundle: boolean; hasEd25519Signature: boolean } };
    expect(body.patch.hasSigstoreBundle).toBe(false);
    expect(body.patch.hasEd25519Signature).toBe(false);
    await app.close();
    db.close();
  });
});
