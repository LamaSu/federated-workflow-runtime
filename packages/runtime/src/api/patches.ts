import type { FastifyInstance } from "fastify";
import type { DatabaseType } from "../db.js";
import { z } from "zod";

/**
 * GET /api/patches?limit=&integration=&stage=    — list
 * GET /api/patches/:id                           — detail
 *
 * Patches carry signed diffs from the registry. We only expose metadata +
 * manifest + whether a signature is present — never the signature bytes
 * themselves (those are opaque and not useful for UI).
 */

export const PatchSummarySchema = z.object({
  id: z.string(),
  integration: z.string(),
  signatureHash: z.string(),
  version: z.string(),
  state: z.string(),
  appliedAt: z.string().nullable(),
  rolledBackAt: z.string().nullable(),
});

export const PatchDetailSchema = PatchSummarySchema.extend({
  manifest: z.unknown(),
  hasSigstoreBundle: z.boolean(),
  hasEd25519Signature: z.boolean(),
});

export type PatchSummary = z.infer<typeof PatchSummarySchema>;
export type PatchDetail = z.infer<typeof PatchDetailSchema>;

interface PatchRow {
  id: string;
  integration: string;
  signature_hash: string;
  version: string;
  state: string;
  manifest: string;
  sigstore_bundle: Buffer | null;
  ed25519_sig: Buffer | null;
  applied_at: string | null;
  rolled_back_at: string | null;
}

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  integration: z.string().optional(),
  stage: z.string().optional(),
});

function rowToSummary(r: PatchRow): PatchSummary {
  return {
    id: r.id,
    integration: r.integration,
    signatureHash: r.signature_hash,
    version: r.version,
    state: r.state,
    appliedAt: r.applied_at,
    rolledBackAt: r.rolled_back_at,
  };
}

export function registerPatchesRoutes(app: FastifyInstance, db: DatabaseType): void {
  app.get("/api/patches", async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    const { limit, integration, stage } = parsed.data;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (integration) {
      clauses.push("integration = ?");
      params.push(integration);
    }
    if (stage) {
      clauses.push("state = ?");
      params.push(stage);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT * FROM patches ${where}
         ORDER BY COALESCE(applied_at, '') DESC, id ASC
         LIMIT ?`,
      )
      .all(...(params as never[]), limit) as PatchRow[];
    const patches = rows.map(rowToSummary).map((p) => PatchSummarySchema.parse(p));
    return { patches };
  });

  app.get<{ Params: { id: string } }>("/api/patches/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM patches WHERE id = ?").get(req.params.id) as
      | PatchRow
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND" };
    }
    let manifest: unknown = null;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      manifest = row.manifest;
    }
    const detail: PatchDetail = PatchDetailSchema.parse({
      ...rowToSummary(row),
      manifest,
      hasSigstoreBundle: row.sigstore_bundle !== null && row.sigstore_bundle.length > 0,
      hasEd25519Signature: row.ed25519_sig !== null && row.ed25519_sig.length > 0,
    });
    return { patch: detail };
  });
}
