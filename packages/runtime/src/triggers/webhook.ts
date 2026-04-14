import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebhookTrigger } from "@chorus/core";
import type { RunQueue } from "../queue.js";

/**
 * Webhook trigger per ARCHITECTURE §4.2.
 *
 * Registers a Fastify route for each webhook trigger. Path shape:
 *   `POST /hooks/:workflow_id/:token`
 *
 * Optional HMAC secret validation via request header `x-chorus-signature`
 * containing a hex SHA-256 HMAC of the raw request body.
 */

export interface WebhookEntry {
  workflowId: string;
  token: string;
  config: WebhookTrigger;
}

export interface WebhookRegistryOptions {
  queue: RunQueue;
  signatureHeader?: string;
  /** Override Date.now()-based timestamps. */
  now?: () => Date;
}

export const DEFAULT_SIGNATURE_HEADER = "x-chorus-signature";

/**
 * Compute the expected HMAC signature for a webhook body.
 * Exposed so callers (tests, the CLI, or external clients) can produce a
 * matching signature without touching internal state.
 */
export function signWebhookBody(secret: string, body: string | Buffer): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return hmac.digest("hex");
}

/**
 * Verify the provided signature against the body+secret.
 * Constant-time comparison.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string | Buffer,
  provided: string | undefined,
): boolean {
  if (!provided) return false;
  const expected = signWebhookBody(secret, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class WebhookRegistry {
  private readonly entries = new Map<string, WebhookEntry>();
  private readonly signatureHeader: string;
  private readonly now: () => Date;

  constructor(private readonly opts: WebhookRegistryOptions) {
    this.signatureHeader = opts.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Register a webhook trigger in-memory. The Fastify route must also be
   * installed exactly once via `installRoutes()` below.
   */
  register(entry: WebhookEntry): void {
    const key = this.routeKey(entry.workflowId, entry.token);
    if (this.entries.has(key)) {
      throw new Error(`Webhook for ${key} already registered`);
    }
    this.entries.set(key, entry);
  }

  unregister(workflowId: string, token: string): void {
    this.entries.delete(this.routeKey(workflowId, token));
  }

  listEntries(): WebhookEntry[] {
    return [...this.entries.values()];
  }

  routeKey(workflowId: string, token: string): string {
    return `${workflowId}/${token}`;
  }

  /**
   * Install the Fastify route handler. Call ONCE during server boot.
   * The handler consults the in-memory registry on every request, so
   * register/unregister work dynamically afterwards.
   */
  installRoutes(app: FastifyInstance): void {
    app.route({
      url: "/hooks/:workflowId/:token",
      method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      handler: this.handleRequest.bind(this),
    });
  }

  /**
   * The request handler. Exposed as a method (not a closure) so tests can
   * invoke it without a real Fastify instance.
   */
  async handleRequest(
    req: FastifyRequest<{
      Params: { workflowId: string; token: string };
    }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { workflowId, token } = req.params;
    const entry = this.entries.get(this.routeKey(workflowId, token));
    if (!entry) {
      reply.code(404).send({ error: "NOT_FOUND", message: "Webhook not registered" });
      return;
    }
    if (entry.config.method !== req.method) {
      reply.code(405).send({
        error: "METHOD_NOT_ALLOWED",
        message: `Webhook expects ${entry.config.method}, got ${req.method}`,
      });
      return;
    }

    if (entry.config.secret) {
      const provided = req.headers[this.signatureHeader];
      const rawBody = toBuffer(req.body);
      const ok = verifyWebhookSignature(
        entry.config.secret,
        rawBody,
        typeof provided === "string" ? provided : undefined,
      );
      if (!ok) {
        reply.code(401).send({ error: "UNAUTHORIZED", message: "Invalid signature" });
        return;
      }
    }

    const runId = this.opts.queue.enqueue(entry.workflowId, {
      triggeredBy: "webhook",
      triggerPayload: { headers: headersToPayload(req), body: req.body },
      nowIso: this.now().toISOString(),
    });
    reply.code(202).send({ runId });
  }
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(JSON.stringify(body ?? {}));
}

function headersToPayload(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(",");
  }
  return out;
}
