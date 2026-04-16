import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  IntegrationError,
  type OperationContext,
  type SnapshotRecorder,
} from "@delightfulchorus/core";
import integration, {
  buildCassetteRequest,
  buildCassetteResponse,
  classifyPgError,
  extractConnectionString,
  query,
  setPgClientFactory,
  testCredential,
  type PgClientFactory,
  type PgClientLike,
  type PgQueryResultLike,
} from "./index.js";

// ── Test scaffolding ────────────────────────────────────────────────────────

interface FakeSnapshot extends SnapshotRecorder {
  calls: Array<{ key: string; request: unknown; response: unknown }>;
}

function makeSnapshot(): FakeSnapshot {
  const calls: FakeSnapshot["calls"] = [];
  return {
    calls,
    async record(key, request, response) {
      calls.push({ key, request, response });
    },
    async replay() {
      return null;
    },
  };
}

function makeContext(opts: {
  credentials?: Record<string, unknown> | string | null;
  snapshot?: SnapshotRecorder;
  signal?: AbortSignal;
  warnSpy?: ReturnType<typeof vi.fn>;
} = {}): OperationContext {
  const creds =
    "credentials" in opts
      ? opts.credentials
      : { connectionString: "postgres://u:p@localhost:5432/chorus_test" };
  return {
    credentials: creds as OperationContext["credentials"],
    logger: {
      debug: () => {},
      info: () => {},
      warn: opts.warnSpy ?? (() => {}),
      error: () => {},
    },
    signal: opts.signal ?? new AbortController().signal,
    snapshot: opts.snapshot,
  };
}

/**
 * Programmable fake pg.Client. Each test installs one via setPgClientFactory.
 */
interface FakeClientConfig {
  connectFails?: unknown;
  queryResponder?: (config: {
    text: string;
    values?: unknown[];
  }) => PgQueryResultLike | Promise<PgQueryResultLike> | never;
}

interface FakeClient extends PgClientLike {
  received: { text: string; values?: unknown[] }[];
  connectCount: number;
  endCount: number;
  config: { connectionString: string; statement_timeout: number };
}

function installFakeClient(cfg: FakeClientConfig = {}): {
  factory: PgClientFactory;
  clients: FakeClient[];
} {
  const clients: FakeClient[] = [];
  const factory: PgClientFactory = (config) => {
    const received: { text: string; values?: unknown[] }[] = [];
    const client: FakeClient = {
      received,
      connectCount: 0,
      endCount: 0,
      config,
      async connect() {
        client.connectCount += 1;
        if (cfg.connectFails) {
          throw cfg.connectFails;
        }
      },
      async query(q) {
        received.push(q);
        if (cfg.queryResponder) {
          const r = cfg.queryResponder(q);
          return await r;
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      async end() {
        client.endCount += 1;
      },
    };
    clients.push(client);
    return client;
  };
  setPgClientFactory(factory);
  return { factory, clients };
}

/** Make a realistic pg error (has a `code` property). */
function pgError(code: string, message = "pg error"): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

beforeEach(() => {
  setPgClientFactory(null);
});

afterEach(() => {
  setPgClientFactory(null);
  vi.restoreAllMocks();
});

// ── Module shape ────────────────────────────────────────────────────────────

describe("@delightfulchorus/integration-postgres-query module shape", () => {
  it("exports a valid IntegrationModule", () => {
    expect(integration.manifest.name).toBe("postgres-query");
    expect(integration.manifest.authType).toBe("basic");
    expect(integration.manifest.operations.map((o) => o.name)).toContain(
      "query",
    );
    expect(typeof integration.operations.query).toBe("function");
  });

  it("declares a basic credentialType with postgres URI pattern", () => {
    expect(integration.manifest.credentialTypes).toHaveLength(1);
    const ct = integration.manifest.credentialTypes![0]!;
    expect(ct.name).toBe("postgresConnectionString");
    expect(ct.authType).toBe("basic");
    expect(ct.documentationUrl).toMatch(/^https:\/\/www\.postgresql\.org/);
    expect(ct.fields).toHaveLength(1);
    const field = ct.fields![0]!;
    expect(field.name).toBe("connectionString");
    expect(field.type).toBe("password");
    expect(field.required).toBe(true);
    expect(field.pattern).toBe("^postgres(ql)?://");
    expect(field.oauthManaged).toBe(false);
    expect(field.deepLink).toMatch(/^https:\/\//);
  });

  it("declares a test hook describing SELECT 1", () => {
    const ct = integration.manifest.credentialTypes![0]!;
    expect(ct.test?.description).toMatch(/SELECT 1/);
  });

  it("exposes testCredential callable on the IntegrationModule", () => {
    expect(typeof integration.testCredential).toBe("function");
  });

  it("pattern accepts both postgres:// and postgresql:// URIs", () => {
    const pattern = new RegExp(
      integration.manifest.credentialTypes![0]!.fields![0]!.pattern!,
    );
    expect(pattern.test("postgres://u:p@h/d")).toBe(true);
    expect(pattern.test("postgresql://u:p@h/d")).toBe(true);
    expect(pattern.test("mysql://u:p@h/d")).toBe(false);
    expect(pattern.test("http://example.com")).toBe(false);
  });
});

// ── testCredential — the SELECT 1 probe ────────────────────────────────────

describe("testCredential — Postgres SELECT 1", () => {
  it("returns ok:true with server version workspaceName on happy path", async () => {
    const { clients } = installFakeClient({
      queryResponder: (q) => {
        if (q.text.includes("SELECT 1")) {
          return {
            rows: [{ ok: 1 }],
            rowCount: 1,
            fields: [{ name: "ok", dataTypeID: 23 }],
          };
        }
        if (q.text.includes("version()")) {
          return {
            rows: [
              {
                v: "PostgreSQL 16.1 on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit",
              },
            ],
            rowCount: 1,
            fields: [{ name: "v", dataTypeID: 25 }],
          };
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
    });

    const result = await testCredential(
      "postgresConnectionString",
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(result.identity?.workspaceName).toMatch(/PostgreSQL 16\.1/);
    // Version string capped at 80 chars.
    expect(result.identity!.workspaceName!.length).toBeLessThanOrEqual(80);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify we DID open and close the client.
    expect(clients[0]!.connectCount).toBe(1);
    expect(clients[0]!.endCount).toBe(1);
  });

  it("returns ok:true with no identity when version() throws", async () => {
    installFakeClient({
      queryResponder: (q) => {
        if (q.text.includes("SELECT 1")) {
          return {
            rows: [{ ok: 1 }],
            rowCount: 1,
            fields: [{ name: "ok", dataTypeID: 23 }],
          };
        }
        throw pgError("42000", "no permission for version()");
      },
    });
    const result = await testCredential(
      "postgresConnectionString",
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(result.identity).toBeUndefined();
  });

  it("returns AUTH_INVALID when no connectionString in ctx", async () => {
    const result = await testCredential(
      "postgresConnectionString",
      makeContext({ credentials: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("maps ECONNREFUSED to NETWORK_ERROR", async () => {
    installFakeClient({
      connectFails: pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"),
    });
    const result = await testCredential(
      "postgresConnectionString",
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NETWORK_ERROR");
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("maps invalid-password (28P01) connect failure to AUTH_INVALID", async () => {
    installFakeClient({
      connectFails: pgError("28P01", "password authentication failed for user 'u'"),
    });
    const result = await testCredential(
      "postgresConnectionString",
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });

  it("maps permission-denied during SELECT 1 to AUTH_INVALID", async () => {
    installFakeClient({
      queryResponder: () => {
        throw pgError("42501", "permission denied for relation foo");
      },
    });
    const result = await testCredential(
      "postgresConnectionString",
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTH_INVALID");
  });
});

// ── query — happy path ─────────────────────────────────────────────────────

describe("query — happy path", () => {
  it("returns rows, rowCount, and fields on a successful query", async () => {
    const { clients } = installFakeClient({
      queryResponder: () => ({
        rows: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
        rowCount: 2,
        fields: [
          { name: "id", dataTypeID: 23 },
          { name: "name", dataTypeID: 25 },
        ],
      }),
    });

    const snapshot = makeSnapshot();
    const result = await query(
      {
        sql: "SELECT id, name FROM users WHERE active = $1",
        params: [true],
      },
      makeContext({ snapshot }),
    );

    expect(result.rowCount).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.fields).toEqual([
      { name: "id", dataTypeID: 23 },
      { name: "name", dataTypeID: 25 },
    ]);

    expect(clients[0]!.connectCount).toBe(1);
    expect(clients[0]!.endCount).toBe(1);
    expect(clients[0]!.config.connectionString).toMatch(/^postgres:/);
    expect(clients[0]!.config.statement_timeout).toBe(30_000);
    expect(snapshot.calls[0]!.key).toBe("postgres-query.query.200");
  });

  it("passes params through as an array (no string interpolation)", async () => {
    const { clients } = installFakeClient({
      queryResponder: () => ({ rows: [], rowCount: 0, fields: [] }),
    });

    await query(
      {
        sql: "SELECT * FROM t WHERE a=$1 AND b=$2 AND c=$3",
        params: ["literal; DROP TABLE users;--", 42, null],
      },
      makeContext(),
    );

    const received = clients[0]!.received[0]!;
    expect(received.text).toBe("SELECT * FROM t WHERE a=$1 AND b=$2 AND c=$3");
    expect(received.values).toEqual(["literal; DROP TABLE users;--", 42, null]);
    // SQL text must be the template, NOT an interpolated string.
    expect(received.text).not.toContain("DROP TABLE");
    expect(received.text).not.toContain("42");
  });

  it("applies the requested statement_timeout to the pg.Client", async () => {
    const { clients } = installFakeClient();
    await query(
      { sql: "SELECT 1", timeoutMs: 5_000 },
      makeContext(),
    );
    expect(clients[0]!.config.statement_timeout).toBe(5_000);
  });

  it("accepts a plain string credential as the connection URI", async () => {
    const { clients } = installFakeClient();
    await query(
      { sql: "SELECT 1" },
      makeContext({
        credentials: "postgres://u:p@other.example:5432/db" as never,
      }),
    );
    expect(clients[0]!.config.connectionString).toBe(
      "postgres://u:p@other.example:5432/db",
    );
  });

  it("rowLimit truncates results and emits a warn log", async () => {
    installFakeClient({
      queryResponder: () => ({
        rows: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
        rowCount: 5,
        fields: [{ name: "n", dataTypeID: 23 }],
      }),
    });

    const warnSpy = vi.fn();
    const result = await query(
      {
        sql: "SELECT n FROM generate_series(1,5) n",
        rowLimit: 2,
      },
      makeContext({ warnSpy }),
    );

    expect(result.rows).toHaveLength(2);
    // rowCount is what the server reported — the full count — NOT the
    // truncated length, so the caller knows they missed rows.
    expect(result.rowCount).toBe(5);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, data] = warnSpy.mock.calls[0]!;
    expect(String(msg)).toMatch(/truncated/i);
    expect(data).toMatchObject({ rowLimit: 2, actualRows: 5 });
  });

  it("does not truncate or warn when rowLimit is not set", async () => {
    installFakeClient({
      queryResponder: () => ({
        rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
        rowCount: 3,
        fields: [{ name: "n", dataTypeID: 23 }],
      }),
    });
    const warnSpy = vi.fn();
    const result = await query(
      { sql: "SELECT n FROM t" },
      makeContext({ warnSpy }),
    );
    expect(result.rows).toHaveLength(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── query — auth ────────────────────────────────────────────────────────────

describe("query — auth", () => {
  it("throws AuthError when no credential is present", async () => {
    await expect(
      query(
        { sql: "SELECT 1" },
        makeContext({ credentials: null }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("maps permission-denied (42501) to AuthError", async () => {
    installFakeClient({
      queryResponder: () => {
        throw pgError("42501", "permission denied for relation secrets");
      },
    });
    const snapshot = makeSnapshot();
    await expect(
      query({ sql: "SELECT * FROM secrets" }, makeContext({ snapshot })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(snapshot.calls[0]!.key).toBe("postgres-query.query.auth_error");
  });

  it("maps 28xxx (invalid auth spec) during connect to AuthError", async () => {
    installFakeClient({
      connectFails: pgError("28P01", "password authentication failed"),
    });
    const snapshot = makeSnapshot();
    await expect(
      query({ sql: "SELECT 1" }, makeContext({ snapshot })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(snapshot.calls[0]!.key).toBe("postgres-query.query.auth_error");
  });
});

// ── query — connection failures ────────────────────────────────────────────

describe("query — connection errors", () => {
  it("maps ECONNREFUSED to PG_CONNECTION_ERROR retryable", async () => {
    installFakeClient({
      connectFails: pgError(
        "ECONNREFUSED",
        "connect ECONNREFUSED 127.0.0.1:5432",
      ),
    });
    const snapshot = makeSnapshot();
    try {
      await query({ sql: "SELECT 1" }, makeContext({ snapshot }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("PG_CONNECTION_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
    }
    expect(snapshot.calls[0]!.key).toBe(
      "postgres-query.query.connection_error",
    );
  });

  it("maps ENOTFOUND to PG_CONNECTION_ERROR retryable", async () => {
    installFakeClient({
      connectFails: pgError("ENOTFOUND", "getaddrinfo ENOTFOUND db.example"),
    });
    try {
      await query({ sql: "SELECT 1" }, makeContext());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("PG_CONNECTION_ERROR");
      expect((err as IntegrationError).retryable).toBe(true);
    }
  });
});

// ── query — SQL errors ──────────────────────────────────────────────────────

describe("query — SQL errors", () => {
  it("maps syntax-error (42601) to PG_SYNTAX_ERROR non-retryable", async () => {
    installFakeClient({
      queryResponder: () => {
        throw pgError("42601", 'syntax error at or near "FROMM"');
      },
    });
    const snapshot = makeSnapshot();
    try {
      await query(
        { sql: "SELECT * FROMM users" },
        makeContext({ snapshot }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("PG_SYNTAX_ERROR");
      expect((err as IntegrationError).retryable).toBe(false);
    }
    expect(snapshot.calls[0]!.key).toBe("postgres-query.query.syntax_error");
  });

  it("maps statement-timeout (57014) to PG_TIMEOUT retryable", async () => {
    installFakeClient({
      queryResponder: () => {
        throw pgError("57014", "canceling statement due to statement timeout");
      },
    });
    const snapshot = makeSnapshot();
    try {
      await query(
        { sql: "SELECT pg_sleep(60)", timeoutMs: 1_000 },
        makeContext({ snapshot }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("PG_TIMEOUT");
      expect((err as IntegrationError).retryable).toBe(true);
    }
    expect(snapshot.calls[0]!.key).toBe("postgres-query.query.timeout");
  });

  it("maps unknown SQLSTATE to PG_<SQLSTATE> non-retryable", async () => {
    installFakeClient({
      queryResponder: () => {
        throw pgError("23505", "duplicate key value violates unique constraint");
      },
    });
    const snapshot = makeSnapshot();
    try {
      await query(
        { sql: "INSERT INTO t (id) VALUES ($1)", params: [1] },
        makeContext({ snapshot }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("PG_23505");
      expect((err as IntegrationError).retryable).toBe(false);
    }
    expect(snapshot.calls[0]!.key).toBe("postgres-query.query.error.PG_23505");
  });

  it("closes the client even when the query throws", async () => {
    const { clients } = installFakeClient({
      queryResponder: () => {
        throw pgError("42601", "boom");
      },
    });
    await expect(
      query({ sql: "junk" }, makeContext()),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(clients[0]!.endCount).toBe(1);
  });
});

// ── query — input validation ───────────────────────────────────────────────

describe("query — input validation", () => {
  it("rejects empty sql", async () => {
    await expect(
      query({ sql: "" } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects non-positive timeoutMs", async () => {
    await expect(
      query({ sql: "SELECT 1", timeoutMs: 0 } as never, makeContext()),
    ).rejects.toThrow();
  });

  it("rejects rowLimit outside [1, 1_000_000]", async () => {
    await expect(
      query(
        { sql: "SELECT 1", rowLimit: 0 } as never,
        makeContext(),
      ),
    ).rejects.toThrow();
    await expect(
      query(
        { sql: "SELECT 1", rowLimit: 2_000_000 } as never,
        makeContext(),
      ),
    ).rejects.toThrow();
  });
});

// ── Cassette safety — the load-bearing invariant ───────────────────────────

describe("cassette safety — no raw values leak", () => {
  it("records sql template + paramCount only; NEVER raw param values", async () => {
    installFakeClient({
      queryResponder: () => ({
        rows: [{ secret: "hunter2" }],
        rowCount: 1,
        fields: [{ name: "secret", dataTypeID: 25 }],
      }),
    });

    const snapshot = makeSnapshot();
    await query(
      {
        sql: "SELECT secret FROM vault WHERE user_email = $1 AND token = $2",
        params: ["alice@example.com", "xoxb-super-secret"],
      },
      makeContext({ snapshot }),
    );

    // Capture the WHOLE snapshot payload and stringify it — grep the string
    // for leaks. Belt-and-suspenders: any regression that accidentally
    // records values will fail this assertion loudly.
    const serialized = JSON.stringify(snapshot.calls);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("xoxb-super-secret");
    expect(serialized).not.toContain("hunter2");

    const req = snapshot.calls[0]!.request as {
      sql: string;
      paramCount: number;
    };
    expect(req.sql).toBe(
      "SELECT secret FROM vault WHERE user_email = $1 AND token = $2",
    );
    expect(req.paramCount).toBe(2);
  });

  it("records response shape (fields + rowCount + truncated), not rows", async () => {
    installFakeClient({
      queryResponder: () => ({
        rows: [
          { id: 1, ssn: "123-45-6789" },
          { id: 2, ssn: "987-65-4321" },
        ],
        rowCount: 2,
        fields: [
          { name: "id", dataTypeID: 23 },
          { name: "ssn", dataTypeID: 25 },
        ],
      }),
    });

    const snapshot = makeSnapshot();
    await query(
      { sql: "SELECT id, ssn FROM people" },
      makeContext({ snapshot }),
    );

    const serialized = JSON.stringify(snapshot.calls);
    expect(serialized).not.toContain("123-45-6789");
    expect(serialized).not.toContain("987-65-4321");

    const resp = snapshot.calls[0]!.response as {
      rowCount: number;
      fields: { name: string; dataTypeID: number }[];
      truncated: boolean;
    };
    expect(resp.rowCount).toBe(2);
    expect(resp.fields).toEqual([
      { name: "id", dataTypeID: 23 },
      { name: "ssn", dataTypeID: 25 },
    ]);
    expect(resp.truncated).toBe(false);
  });

  it("flags truncated=true in the cassette when rowLimit activates", async () => {
    installFakeClient({
      queryResponder: () => ({
        rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
        rowCount: 3,
        fields: [{ name: "n", dataTypeID: 23 }],
      }),
    });
    const snapshot = makeSnapshot();
    await query(
      { sql: "SELECT n FROM t", rowLimit: 1 },
      makeContext({ snapshot }),
    );
    const resp = snapshot.calls[0]!.response as { truncated: boolean };
    expect(resp.truncated).toBe(true);
  });

  it("error cassettes include SQLSTATE classification, not raw error text", async () => {
    installFakeClient({
      queryResponder: () => {
        const err = pgError(
          "42501",
          "permission denied for user 'alice@evil.example' accessing secret='hunter2'",
        );
        throw err;
      },
    });
    const snapshot = makeSnapshot();
    try {
      await query(
        { sql: "SELECT * FROM secrets", params: ["nope"] },
        makeContext({ snapshot }),
      );
    } catch {
      // expected
    }
    const serialized = JSON.stringify(snapshot.calls);
    // Raw pg error message must NOT be in the cassette — we only store
    // the classified kind + sqlstate.
    expect(serialized).not.toContain("alice@evil.example");
    expect(serialized).not.toContain("hunter2");
    const resp = snapshot.calls[0]!.response as {
      kind: string;
      sqlstate?: string;
    };
    expect(resp.kind).toBe("auth");
    expect(resp.sqlstate).toBe("42501");
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("extractConnectionString handles string and object credential shapes", () => {
    expect(extractConnectionString("postgres://u:p@h/d")).toBe(
      "postgres://u:p@h/d",
    );
    expect(
      extractConnectionString({ connectionString: "postgres://u:p@h/d" }),
    ).toBe("postgres://u:p@h/d");
    expect(extractConnectionString({ url: "postgres://u:p@h/d" })).toBe(
      "postgres://u:p@h/d",
    );
    expect(extractConnectionString({ uri: "postgres://u:p@h/d" })).toBe(
      "postgres://u:p@h/d",
    );
    expect(extractConnectionString({ irrelevant: 1 } as never)).toBeUndefined();
    expect(extractConnectionString(null)).toBeUndefined();
    expect(extractConnectionString(undefined)).toBeUndefined();
  });

  it("classifyPgError maps known SQLSTATE and errno codes", () => {
    expect(classifyPgError(pgError("42601")).kind).toBe("syntax");
    expect(classifyPgError(pgError("57014")).kind).toBe("timeout");
    expect(classifyPgError(pgError("42501")).kind).toBe("auth");
    expect(classifyPgError(pgError("28P01")).kind).toBe("auth");
    expect(classifyPgError(pgError("28000")).kind).toBe("auth");
    expect(classifyPgError(pgError("ECONNREFUSED")).kind).toBe("network");
    expect(classifyPgError(pgError("ENOTFOUND")).kind).toBe("network");
    expect(classifyPgError(pgError("23505")).kind).toBe("other");
    expect(classifyPgError(pgError("23505")).sqlstate).toBe("23505");
    expect(classifyPgError(new Error("no code")).kind).toBe("other");
    expect(classifyPgError(null).kind).toBe("other");
    expect(classifyPgError(undefined).kind).toBe("other");
  });

  it("buildCassetteRequest omits param values", () => {
    const req = buildCassetteRequest({
      sql: "SELECT $1, $2",
      params: ["secret", 42],
      timeoutMs: 5000,
      rowLimit: 10,
    });
    expect(req.sql).toBe("SELECT $1, $2");
    expect(req.paramCount).toBe(2);
    expect(req.timeoutMs).toBe(5000);
    expect(req.hasRowLimit).toBe(true);
    expect(JSON.stringify(req)).not.toContain("secret");
    expect(JSON.stringify(req)).not.toContain("42");
  });

  it("buildCassetteRequest reports paramCount=0 when params is absent", () => {
    const req = buildCassetteRequest({
      sql: "SELECT 1",
      timeoutMs: 30_000,
    } as never);
    expect(req.paramCount).toBe(0);
    expect(req.hasRowLimit).toBe(false);
  });

  it("buildCassetteResponse reflects truncation flag", () => {
    const resp = buildCassetteResponse({
      rowCount: 10,
      fields: [{ name: "n", dataTypeID: 23 }],
      truncated: true,
    });
    expect(resp.truncated).toBe(true);
    expect(resp.rowCount).toBe(10);
  });
});
