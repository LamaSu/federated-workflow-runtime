import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeCredentialService } from "../credential-service.js";

/**
 * Credential control-plane HTTP surface per docs/CREDENTIALS_ANALYSIS.md §7.
 *
 *   GET  /api/credentials?integration=X           — list (no payload)
 *   POST /api/credentials                          — configure (encrypted)
 *   POST /api/credentials/:id/test                 — test
 *   POST /api/credentials/:id/authenticate         — initiate OAuth
 *
 * All routes live under /api/* so they inherit the bearer auth guard in
 * api/index.ts. These are the first WRITE endpoints besides POST
 * /api/events; the manifest (`api/manifest.ts`) calls them out as
 * `credentials.*` and `oauth.*` capabilities.
 *
 * Shape discipline:
 *   - Bodies are validated via Zod; invalid → 400 BAD_REQUEST.
 *   - `integration` comes from query for list, body for configure. The
 *     catalog resolution is delegated to the service.
 *   - The list endpoint NEVER returns encrypted payloads or plaintext.
 *
 * Standalone MCP scaffolds use HttpCredentialServiceClient
 * (packages/mcp/src/credential-client.ts) to call these endpoints.
 */

const ConfigureBodySchema = z.object({
  integration: z.string().min(1),
  credentialTypeName: z.string().min(1),
  name: z.string().min(1).max(80),
  fields: z.record(z.unknown()),
});

const AuthenticateBodySchema = z.object({
  integration: z.string().min(1),
  credentialTypeName: z.string().min(1).optional(),
  name: z.string().min(1).max(80).default("default"),
});

const ListQuerySchema = z.object({
  integration: z.string().min(1),
});

export interface RegisterCredentialsRoutesOptions {
  credentialService: RuntimeCredentialService;
}

export function registerCredentialsRoutes(
  app: FastifyInstance,
  opts: RegisterCredentialsRoutesOptions,
): void {
  // GET /api/credentials?integration=X
  app.get("/api/credentials", async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    const credentials = await opts.credentialService.list(parsed.data.integration);
    return { credentials };
  });

  // POST /api/credentials
  app.post("/api/credentials", async (req, reply) => {
    const parsed = ConfigureBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    try {
      const result = await opts.credentialService.configure(parsed.data);
      reply.code(201);
      return result;
    } catch (err) {
      reply.code(400);
      return { error: "CONFIGURE_FAILED", message: (err as Error).message };
    }
  });

  // POST /api/credentials/:id/test
  app.post<{ Params: { id: string }; Body: { integration?: string } }>(
    "/api/credentials/:id/test",
    async (req, reply) => {
      const body = (req.body ?? {}) as { integration?: string };
      const integration = body.integration;
      if (!integration || typeof integration !== "string") {
        reply.code(400);
        return { error: "BAD_REQUEST", message: "body.integration required" };
      }
      try {
        const result = await opts.credentialService.testAuth({
          integration,
          credentialId: req.params.id,
        });
        return result;
      } catch (err) {
        reply.code(500);
        return { error: "INTERNAL", message: (err as Error).message };
      }
    },
  );

  // POST /api/credentials/:id/authenticate — initiate OAuth authorize
  // NOTE: id isn't used here; the OAuth flow creates a NEW credential on
  // callback. We accept the path for REST-symmetry but the body carries
  // the integration/type. `:id` is just "any" here — we use 'new' in the
  // client for readability.
  app.post("/api/credentials/authenticate", async (req, reply) => {
    const parsed = AuthenticateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "BAD_REQUEST", message: parsed.error.message };
    }
    try {
      const result = await opts.credentialService.authenticate({
        integration: parsed.data.integration,
        credentialTypeName: parsed.data.credentialTypeName ?? "",
        name: parsed.data.name,
      });
      return result;
    } catch (err) {
      reply.code(400);
      return { error: "AUTHENTICATE_FAILED", message: (err as Error).message };
    }
  });
}
