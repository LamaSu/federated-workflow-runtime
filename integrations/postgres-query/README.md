# @delightfulchorus/integration-postgres-query

Run parameterized SQL against a Postgres database using a libpq connection string.

Part of the Chorus integration SDK. This package exists to prove two things
the HTTP reference integrations (`slack-send`, `http-generic`) didn't cover:

1. **Non-HTTP integrations are first-class.** The SDK doesn't assume `fetch`.
   This integration uses `pg` (node-postgres) and exercises the same
   `IntegrationModule` contract — manifest, operations, credential catalog,
   cassette recording, error mapping — without making a single HTTP call.
2. **The credential catalog's `basic` envelope carries a libpq URI.**
   A connection string is a single opaque credential material. We store it
   under the canonical field name `connectionString` so the CLI, the runtime,
   and the repair pipeline all see it the same way.

## Install

```bash
npm install @delightfulchorus/integration-postgres-query
```

## Usage

```ts
import integration from "@delightfulchorus/integration-postgres-query";

// Register with the Chorus runtime alongside any other integrations.
```

## Credential shape

Store this under `integration: "postgres-query"`, credential type
`postgresConnectionString`:

```json
{
  "connectionString": "postgres://user:password@host:5432/dbname?sslmode=require"
}
```

The pattern `^postgres(ql)?://` is validated at credential-save time.

## Operation: `query`

```ts
await runtime.invoke("postgres-query", "query", {
  sql: "SELECT id, email FROM users WHERE active = $1 LIMIT $2",
  params: [true, 100],
  timeoutMs: 30_000,    // default 30s; statement-level
  rowLimit: 1000,       // optional; caps rows returned to the caller
});
```

Always use `$1`, `$2`, ... placeholders. Never interpolate values into the
SQL string — `pg` serializes the `params` array safely and the cassette
layer relies on the SQL template staying constant.

### Returns

```ts
{
  rows: unknown[];             // the result rows
  rowCount: number;            // server-reported count (may exceed rows.length if rowLimit truncated)
  fields: { name: string; dataTypeID: number }[];
}
```

## Error mapping

| Condition | Error | Retryable |
|---|---|---|
| `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` | `IntegrationError PG_CONNECTION_ERROR` | yes |
| SQLSTATE `57014` (statement timeout) | `IntegrationError PG_TIMEOUT` | yes |
| SQLSTATE `42601` (syntax) | `IntegrationError PG_SYNTAX_ERROR` | no |
| SQLSTATE `42501` (permission denied) | `AuthError` | no |
| SQLSTATE `28xxx` (invalid auth spec) | `AuthError` | no |
| Other SQLSTATE | `IntegrationError PG_<SQLSTATE>` | no |
| Missing credential | `AuthError` | no |

## Cassette safety

This integration does **not** record param values or row values to cassettes.
Both may carry PII, secrets, or hostile SQL fragments — recording them would
make the cassette itself a leak vector. We record:

- the SQL template (code, not data),
- the param count (an integer),
- the result-set shape: `rowCount` + column names + column OIDs + a
  `truncated` flag,
- on errors, the classified kind + SQLSTATE.

A reviewer diffing two cassettes can see "this query now returns an extra
column called `email`" without ever seeing the email addresses themselves.

## Pooling

This integration opens one `pg.Client` per call and closes it in `finally`.
That keeps the handler simple and cassette-diffable; callers needing
connection reuse should front it with `pgbouncer` at the database side, or
wrap with their own pool at the workflow level.

## License

MIT
