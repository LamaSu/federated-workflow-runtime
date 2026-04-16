/**
 * @delightfulchorus/integration-postgres-query
 *
 * Run parameterized SQL against a Postgres database using a connection string.
 *
 * Scope note (docs/CREDENTIALS_ANALYSIS.md §4.3 maps to this file):
 *   - slack-send is the reference HTTP+bearer integration.
 *   - http-generic is the credential-less HTTP integration.
 *   - This integration proves the catalog handles TWO new axes simultaneously:
 *       (a) a non-HTTP driver (node-postgres / `pg`) instead of `fetch`, and
 *       (b) a connection-string shaped credential carried on `authType: "basic"`.
 *
 * Why "basic" for a connection string?
 *   The five-value `authType` enum is locked by §4.2 of the credential catalog
 *   design. A libpq-style URI ("postgres://user:password@host:port/db") is a
 *   single opaque string — the closest existing envelope is `basic` (a single
 *   credential material, not an OAuth pair, not an API key header). We repurpose
 *   `basic` by storing the URI under a well-known field name
 *   (`connectionString`) so downstream consumers (`credentials-oscar`,
 *   `mcp-papa`) know exactly what to look for. The mapping is documented in
 *   the credentialType description and in the field description below.
 *
 * Chorus contract notes:
 *   - Connection-refused / DNS failure → IntegrationError PG_CONNECTION_ERROR
 *     (retryable — infra blip, not a code bug).
 *   - Statement timeout (SQLSTATE 57014) → IntegrationError PG_TIMEOUT
 *     (retryable; the runtime may re-try against a healthier replica).
 *   - Syntax error (SQLSTATE 42601) → IntegrationError PG_SYNTAX_ERROR
 *     (non-retryable; a code change is required).
 *   - Permission denied (SQLSTATE 42501) → AuthError (the role is wrong;
 *     rotate the credential or grant the role).
 *   - Other pg errors → IntegrationError with code `PG_<SQLSTATE>`, non-retryable.
 *   - Every call records a cassette (success AND failure). Cassette contents
 *     are DELIBERATELY LOSSY: we record the SQL template, the PARAM COUNT,
 *     and the result-set SHAPE (column names + OIDs + row count). We never
 *     record param values or row values — those may contain PII, secrets, or
 *     hostile SQL fragments that would make the cassette itself a leak vector.
 *     See "Cassette safety" at the bottom of this file.
 */
import {
  AuthError,
  IntegrationError,
  type CredentialTestResult,
  type IntegrationManifest,
  type IntegrationModule,
  type OperationContext,
  type OperationHandler,
} from "@delightfulchorus/core";
import { Client as PgClient } from "pg";
import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const QueryInputSchema = z.object({
  /** SQL text. Use parameter placeholders ($1, $2, ...) — do NOT interpolate values. */
  sql: z.string().min(1),
  /**
   * Positional parameters for $1, $2, ... Always passed through as an array;
   * pg serializes each one safely. This is the ONLY safe way to pass
   * user-supplied values into a query.
   */
  params: z.array(z.unknown()).optional(),
  /** Statement timeout in milliseconds. Default 30s. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  /** Cap on returned rows. If the result has more, we slice AND emit a warn log. */
  rowLimit: z.number().int().positive().max(1_000_000).optional(),
});

export const QueryOutputSchema = z.object({
  rows: z.array(z.unknown()),
  rowCount: z.number().int().nonnegative(),
  fields: z.array(
    z.object({
      name: z.string(),
      dataTypeID: z.number().int(),
    }),
  ),
});

export type QueryInput = z.input<typeof QueryInputSchema>;
export type QueryParsed = z.output<typeof QueryInputSchema>;
export type QueryOutput = z.infer<typeof QueryOutputSchema>;

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifest: IntegrationManifest = {
  name: "postgres-query",
  version: "0.1.1",
  description:
    "Run parameterized SQL against a Postgres database using a libpq connection string.",
  /**
   * We repurpose `basic` — the catalog's single-material auth envelope — to
   * carry a libpq connection URI. See the file-level comment for rationale.
   */
  authType: "basic",
  docsUrl:
    "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING",
  /**
   * Credential catalog (docs/CREDENTIALS_ANALYSIS.md §4.3). postgres-query
   * ships ONE connection-string credential type. A future iteration that
   * supports IAM-issued temporary creds (AWS RDS / GCP Cloud SQL) would add
   * a second entry with its own fields and test.
   */
  credentialTypes: [
    {
      name: "postgresConnectionString",
      displayName: "Postgres Connection String",
      authType: "basic",
      description:
        "A libpq connection URI of the form postgres://user:password@host:port/dbname. " +
        "Stored encrypted at rest and handed to the driver on a per-call basis — we open " +
        "and close one Client per operation, so callers needing pooling should wrap this " +
        "integration in their own pool or use pgbouncer at the DB side.",
      documentationUrl:
        "https://www.postgresql.org/docs/current/libpq-connect.html",
      fields: [
        {
          name: "connectionString",
          displayName: "Connection String",
          type: "password",
          required: true,
          description:
            "libpq URI: postgres://user:password@host:port/dbname?sslmode=require. " +
            "See https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING " +
            "for the full parameter list.",
          deepLink:
            "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING",
          pattern: "^postgres(ql)?://",
          oauthManaged: false,
        },
      ],
      test: {
        description: "Runs SELECT 1 (read-only, zero side effects).",
      },
    },
  ],
  operations: [
    {
      name: "query",
      description:
        "Execute a parameterized SQL statement. Returns rows, rowCount, and field descriptors.",
      // Most SQL is not idempotent (INSERT/UPDATE/DELETE). Callers declare
      // idempotency on read-only queries at the workflow-node level.
      idempotent: false,
      inputSchema: {
        type: "object",
        required: ["sql"],
        properties: {
          sql: { type: "string", minLength: 1 },
          params: { type: "array" },
          timeoutMs: { type: "number", minimum: 1, maximum: 600_000 },
          rowLimit: { type: "number", minimum: 1, maximum: 1_000_000 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["rows", "rowCount", "fields"],
        properties: {
          rows: { type: "array" },
          rowCount: { type: "number" },
          fields: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "dataTypeID"],
              properties: {
                name: { type: "string" },
                dataTypeID: { type: "number" },
              },
            },
          },
        },
      },
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

type OperationContextCreds = Record<string, unknown> | string | null | undefined;

/**
 * Pull a libpq connection string out of the OperationContext. We accept two
 * shapes — a plain string credential (legacy) or an object with
 * `connectionString` (canonical, matches the catalog field name).
 */
export function extractConnectionString(
  credentials: OperationContextCreds,
): string | undefined {
  if (!credentials) return undefined;
  if (typeof credentials === "string") return credentials;
  const candidate =
    (credentials as { connectionString?: unknown }).connectionString ??
    (credentials as { url?: unknown }).url ??
    (credentials as { uri?: unknown }).uri;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Classify a node-postgres error. Returns:
 *  - `kind: "auth"` for permission / role errors (→ AuthError),
 *  - `kind: "network"` for connect-time failures (→ IntegrationError retryable),
 *  - `kind: "timeout"` for statement timeouts (→ IntegrationError retryable),
 *  - `kind: "syntax"` for bad SQL (→ IntegrationError non-retryable),
 *  - `kind: "other"` for everything else (→ IntegrationError non-retryable).
 *
 * Exported so tests (and, eventually, patch tooling) can reason about the
 * mapping without importing pg internals.
 */
export type PgErrorKind = "auth" | "network" | "timeout" | "syntax" | "other";

export function classifyPgError(err: unknown): {
  kind: PgErrorKind;
  sqlstate?: string;
  code?: string;
} {
  if (!err || typeof err !== "object") return { kind: "other" };
  const e = err as { code?: string; errno?: string | number };
  const raw = typeof e.code === "string" ? e.code : undefined;

  // Node.js connection-level errors carry errno-style codes on `.code`
  // (ECONNREFUSED / ENOTFOUND / ETIMEDOUT / EHOSTUNREACH / ECONNRESET).
  const networkCodes = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ECONNRESET",
    "EPIPE",
  ]);
  if (raw && networkCodes.has(raw)) {
    return { kind: "network", code: raw };
  }

  // Postgres protocol errors carry a 5-char SQLSTATE on `.code`.
  if (raw && /^[0-9A-Z]{5}$/.test(raw)) {
    if (raw === "42501") return { kind: "auth", sqlstate: raw };
    if (raw === "42601") return { kind: "syntax", sqlstate: raw };
    if (raw === "57014") return { kind: "timeout", sqlstate: raw };
    // 28xxx (invalid authorization specification) — these are also auth-shaped.
    // 28P01 = invalid password, 28000 = invalid auth spec.
    if (raw.startsWith("28")) return { kind: "auth", sqlstate: raw };
    return { kind: "other", sqlstate: raw };
  }

  return { kind: "other" };
}

/**
 * Build the cassette request fingerprint. DELIBERATELY excludes param values
 * AND row values — see "Cassette safety" comment at the bottom of this file.
 */
export function buildCassetteRequest(parsed: QueryParsed): {
  sql: string;
  paramCount: number;
  timeoutMs: number;
  hasRowLimit: boolean;
} {
  return {
    sql: parsed.sql,
    paramCount: parsed.params?.length ?? 0,
    timeoutMs: parsed.timeoutMs,
    hasRowLimit: parsed.rowLimit !== undefined,
  };
}

/**
 * Build the cassette response fingerprint. Records ONLY the shape of the
 * result (column names + OIDs + row count, never row data).
 */
export function buildCassetteResponse(result: {
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  truncated: boolean;
}): {
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  truncated: boolean;
} {
  return {
    rowCount: result.rowCount,
    fields: result.fields,
    truncated: result.truncated,
  };
}

/**
 * Narrow the minimum surface of pg.Client we actually need, so tests can mock
 * it without importing pg itself. Matches the live API 1:1.
 */
export interface PgClientLike {
  connect(): Promise<void>;
  query(config: { text: string; values?: unknown[] }): Promise<PgQueryResultLike>;
  end(): Promise<void>;
}

export interface PgQueryResultLike {
  rows: unknown[];
  rowCount: number | null;
  fields: { name: string; dataTypeID: number }[];
}

/**
 * Factory for the pg client. Exposed so tests can swap in a fake; production
 * callers always go through the handlers which instantiate pg.Client directly.
 */
export type PgClientFactory = (config: {
  connectionString: string;
  statement_timeout: number;
}) => PgClientLike;

const defaultClientFactory: PgClientFactory = (config) => {
  return new PgClient(config) as unknown as PgClientLike;
};

// A module-level slot the tests flip via setPgClientFactory. Keeps the handler
// free of awkward DI plumbing for every call site.
let clientFactory: PgClientFactory = defaultClientFactory;

export function setPgClientFactory(factory: PgClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const query: OperationHandler<QueryInput, QueryOutput> = async (
  input,
  ctx,
) => {
  const parsed = QueryInputSchema.parse(input);
  const connectionString = extractConnectionString(ctx.credentials);
  if (!connectionString) {
    throw new AuthError({
      message:
        "postgres-query.query requires a connectionString in ctx.credentials",
      integration: "postgres-query",
      operation: "query",
    });
  }

  const client = clientFactory({
    connectionString,
    statement_timeout: parsed.timeoutMs,
  });

  const cassetteRequest = buildCassetteRequest(parsed);

  try {
    try {
      await client.connect();
    } catch (err) {
      const info = classifyPgError(err);
      // Connection-level failure — map to a network or auth-shaped error.
      if (info.kind === "auth") {
        await ctx.snapshot?.record(
          "postgres-query.query.auth_error",
          cassetteRequest,
          { kind: info.kind, sqlstate: info.sqlstate },
        );
        throw new AuthError({
          message: `Postgres auth error (SQLSTATE ${info.sqlstate ?? "unknown"}): role or password invalid`,
          integration: "postgres-query",
          operation: "query",
          cause: err,
        });
      }
      await ctx.snapshot?.record(
        "postgres-query.query.connection_error",
        cassetteRequest,
        { kind: info.kind, code: info.code, sqlstate: info.sqlstate },
      );
      throw new IntegrationError({
        message: `Postgres connection error: ${info.code ?? info.sqlstate ?? "unknown"}`,
        integration: "postgres-query",
        operation: "query",
        code: "PG_CONNECTION_ERROR",
        retryable: true,
        cause: err,
      });
    }

    let result: PgQueryResultLike;
    try {
      result = await client.query({
        text: parsed.sql,
        values: parsed.params,
      });
    } catch (err) {
      const info = classifyPgError(err);

      if (info.kind === "auth") {
        await ctx.snapshot?.record(
          "postgres-query.query.auth_error",
          cassetteRequest,
          { kind: info.kind, sqlstate: info.sqlstate },
        );
        throw new AuthError({
          message: `Postgres permission denied (SQLSTATE ${info.sqlstate ?? "42501"})`,
          integration: "postgres-query",
          operation: "query",
          cause: err,
        });
      }

      if (info.kind === "timeout") {
        await ctx.snapshot?.record(
          "postgres-query.query.timeout",
          cassetteRequest,
          { kind: info.kind, sqlstate: info.sqlstate },
        );
        throw new IntegrationError({
          message: `Postgres statement timeout (SQLSTATE 57014) after ${parsed.timeoutMs}ms`,
          integration: "postgres-query",
          operation: "query",
          code: "PG_TIMEOUT",
          retryable: true,
          cause: err,
        });
      }

      if (info.kind === "syntax") {
        await ctx.snapshot?.record(
          "postgres-query.query.syntax_error",
          cassetteRequest,
          { kind: info.kind, sqlstate: info.sqlstate },
        );
        throw new IntegrationError({
          message: `Postgres syntax error (SQLSTATE 42601)`,
          integration: "postgres-query",
          operation: "query",
          code: "PG_SYNTAX_ERROR",
          retryable: false,
          cause: err,
        });
      }

      // Anything else with a SQLSTATE — surface it with PG_<SQLSTATE>.
      const code = info.sqlstate ? `PG_${info.sqlstate}` : "PG_UNKNOWN";
      await ctx.snapshot?.record(
        `postgres-query.query.error.${code}`,
        cassetteRequest,
        { kind: info.kind, sqlstate: info.sqlstate },
      );
      throw new IntegrationError({
        message: `Postgres error: ${(err as Error).message ?? "unknown"}`,
        integration: "postgres-query",
        operation: "query",
        code,
        retryable: false,
        cause: err,
      });
    }

    // Success — normalize shape.
    const rawRowCount = typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
    const fields = (result.fields ?? []).map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
    }));

    let rows = result.rows ?? [];
    let truncated = false;
    if (parsed.rowLimit !== undefined && rows.length > parsed.rowLimit) {
      ctx.logger.warn?.(
        "postgres-query: result truncated to rowLimit; increase rowLimit to see all rows",
        { rowLimit: parsed.rowLimit, actualRows: rows.length },
      );
      rows = rows.slice(0, parsed.rowLimit);
      truncated = true;
    }

    await ctx.snapshot?.record(
      "postgres-query.query.200",
      cassetteRequest,
      buildCassetteResponse({ rowCount: rawRowCount, fields, truncated }),
    );

    return {
      rows,
      rowCount: rawRowCount,
      fields,
    };
  } finally {
    // Always close the client. Swallow errors — nothing useful to do and we
    // don't want a close-time failure masking the real operation result.
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};

// ── testCredential (docs/CREDENTIALS_ANALYSIS.md §4.4) ─────────────────────

/**
 * Validate a Postgres connection string by running `SELECT 1 as ok` plus a
 * version fetch. Read-only, idempotent, zero side effects. Returns the
 * short-form server version string so the CLI can surface
 * "connected to Postgres 16.1 on host X".
 *
 * The runtime decrypts the credential and hands it via `ctx.credentials`
 * exactly as it does for the operation handler, so a passing test is strong
 * evidence real queries will also authenticate and connect.
 */
export async function testCredential(
  _credentialTypeName: string,
  ctx: OperationContext,
): Promise<CredentialTestResult> {
  const startedAt = Date.now();
  const connectionString = extractConnectionString(ctx.credentials);
  if (!connectionString) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error:
        "postgres-query.testCredential: no connectionString in ctx.credentials",
      errorCode: "AUTH_INVALID",
    };
  }

  const client = clientFactory({
    connectionString,
    // Shorter cap for the test path — we don't want a hung test to stall
    // the CLI for half a minute.
    statement_timeout: 10_000,
  });

  try {
    try {
      await client.connect();
    } catch (err) {
      const info = classifyPgError(err);
      const latencyMs = Date.now() - startedAt;
      if (info.kind === "auth") {
        return {
          ok: false,
          latencyMs,
          error: `Postgres auth error (SQLSTATE ${info.sqlstate ?? "unknown"})`,
          errorCode: "AUTH_INVALID",
        };
      }
      return {
        ok: false,
        latencyMs,
        error: `Postgres connection error: ${(err as Error).message ?? info.code ?? "unknown"}`,
        errorCode: "NETWORK_ERROR",
      };
    }

    try {
      // Cheap validity probe.
      const okRes = await client.query({ text: "SELECT 1 as ok" });
      if (!okRes.rows || okRes.rows.length !== 1) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: "Postgres SELECT 1 returned an unexpected shape",
          errorCode: "NETWORK_ERROR",
        };
      }

      // Identity echo: short server version, best-effort.
      let workspaceName: string | undefined;
      try {
        const verRes = await client.query({ text: "SELECT version() as v" });
        const row = verRes.rows?.[0] as { v?: unknown } | undefined;
        if (row && typeof row.v === "string") {
          workspaceName = row.v.slice(0, 80);
        }
      } catch {
        // Version lookup is advisory — don't fail the test on it.
        workspaceName = undefined;
      }

      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        identity: workspaceName ? { workspaceName } : undefined,
      };
    } catch (err) {
      const info = classifyPgError(err);
      const latencyMs = Date.now() - startedAt;
      if (info.kind === "auth") {
        return {
          ok: false,
          latencyMs,
          error: `Postgres permission denied (SQLSTATE ${info.sqlstate ?? "42501"})`,
          errorCode: "AUTH_INVALID",
        };
      }
      return {
        ok: false,
        latencyMs,
        error: `Postgres query error: ${(err as Error).message ?? "unknown"}`,
        errorCode: "NETWORK_ERROR",
      };
    }
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

// ── Module export ──────────────────────────────────────────────────────────

const integration: IntegrationModule = {
  manifest,
  operations: {
    query: query as OperationHandler,
  },
  testCredential,
};

export default integration;

// ── Cassette safety ────────────────────────────────────────────────────────
//
// Unlike HTTP integrations where the request body is usually a well-typed
// payload (Slack JSON, a JSON-RPC call, etc.), a SQL query carries the
// parameter values as opaque positional arguments. Those values are almost
// always one of:
//   - raw user input (search terms, form fields, IDs),
//   - PII (email addresses, names, phone numbers),
//   - secrets (API tokens looked up by some OTHER query),
//   - hostile strings (the exact thing SQL injection tries to sneak in).
//
// Every one of those is a reason NOT to record param values to a cassette
// that lives on disk and may be replayed or diff'd later. The result rows
// have the same issue — they're whatever the DB returned, which is also
// someone else's data.
//
// We therefore record ONLY:
//   - the SQL template (the code, not the data),
//   - the param count (an integer — safe),
//   - the response shape: row count + column names + column OIDs,
//   - the error kind + SQLSTATE when things fail.
//
// A reviewer diffing two cassettes can see "this query now returns an extra
// column called `email`" without ever seeing the email addresses themselves.
// The repair agent can confirm shape invariants without being handed the
// keys to the kingdom.
