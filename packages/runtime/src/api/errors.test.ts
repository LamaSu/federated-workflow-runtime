import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase, type DatabaseType } from "../db.js";
import { registerApiRoutes } from "./index.js";
import { ErrorSignatureSummarySchema } from "./errors.js";

function setup() {
  const db = openDatabase(":memory:");
  const app = Fastify({ logger: false });
  registerApiRoutes(app, db);
  return { db, app };
}

function seedError(
  db: DatabaseType,
  hash: string,
  opts: {
    integration?: string;
    operation?: string;
    errorClass?: string;
    httpStatus?: number | null;
    occurrences?: number;
    lastSeen?: string;
    reported?: boolean;
    components?: Record<string, unknown>;
    messagePat?: string;
  } = {},
) {
  db.prepare(
    `INSERT INTO error_signatures
       (hash, integration, operation, error_class, http_status, stack_fp, message_pat,
        components, first_seen, last_seen, occurrences, reported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash,
    opts.integration ?? "http-generic",
    opts.operation ?? "request",
    opts.errorClass ?? "HTTPError",
    opts.httpStatus ?? 429,
    "stack-fp-0",
    opts.messagePat ?? "Rate limited by %%HOST%%",
    JSON.stringify(opts.components ?? { headerKeys: ["x-rate-limit"], requestMethod: "GET" }),
    "2026-04-13T10:00:00.000Z",
    opts.lastSeen ?? "2026-04-14T10:00:00.000Z",
    opts.occurrences ?? 3,
    opts.reported === true ? 1 : 0,
  );
}

describe("GET /api/errors", () => {
  it("returns empty list when none", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/errors" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ errors: [] });
    await app.close();
    db.close();
  });

  it("returns aggregated signatures, newest-seen first", async () => {
    const { db, app } = setup();
    seedError(db, "sig-old", { lastSeen: "2026-04-10T00:00:00.000Z" });
    seedError(db, "sig-new", { lastSeen: "2026-04-14T10:00:00.000Z" });
    const res = await app.inject({ method: "GET", url: "/api/errors" });
    const body = res.json() as { errors: Array<{ hash: string; occurrences: number }> };
    expect(body.errors[0]!.hash).toBe("sig-new");
    for (const e of body.errors) {
      expect(() => ErrorSignatureSummarySchema.parse(e)).not.toThrow();
    }
    await app.close();
    db.close();
  });

  it("exposes redacted sampleContext via the components column + messagePattern", async () => {
    const { db, app } = setup();
    seedError(db, "sig-1", {
      components: { paramKeys: ["id"], requestMethod: "POST" },
      messagePat: "user %%ID%% not found",
    });
    const res = await app.inject({ method: "GET", url: "/api/errors" });
    const body = res.json() as { errors: Array<{ sampleContext: Record<string, unknown> }> };
    expect(body.errors[0]!.sampleContext.paramKeys).toEqual(["id"]);
    expect(body.errors[0]!.sampleContext.requestMethod).toBe("POST");
    expect(body.errors[0]!.sampleContext.messagePattern).toBe("user %%ID%% not found");
    await app.close();
    db.close();
  });

  it("filters by integration", async () => {
    const { db, app } = setup();
    seedError(db, "sig-slack", { integration: "slack-send" });
    seedError(db, "sig-http", { integration: "http-generic" });
    const res = await app.inject({ method: "GET", url: "/api/errors?integration=slack-send" });
    const body = res.json() as { errors: Array<{ hash: string; integration: string }> };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.integration).toBe("slack-send");
    await app.close();
    db.close();
  });

  it("respects ?limit=N", async () => {
    const { db, app } = setup();
    for (let i = 0; i < 5; i++) {
      seedError(db, `sig-${i}`, { lastSeen: `2026-04-14T10:00:0${i}.000Z` });
    }
    const res = await app.inject({ method: "GET", url: "/api/errors?limit=2" });
    const body = res.json() as { errors: unknown[] };
    expect(body.errors).toHaveLength(2);
    await app.close();
    db.close();
  });

  it("400s on limit > 500", async () => {
    const { db, app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/errors?limit=99999" });
    expect(res.statusCode).toBe(400);
    await app.close();
    db.close();
  });
});
