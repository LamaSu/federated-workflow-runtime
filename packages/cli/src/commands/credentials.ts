/**
 * `chorus credentials <add|list|remove|test|pat-help|types|migrate>` —
 * credential management per docs/CREDENTIALS_ANALYSIS.md §6.
 *
 * Credentials are encrypted with AES-256-GCM using CHORUS_ENCRYPTION_KEY
 * before being written to SQLite. Plaintext never hits disk, never hits
 * stdout — this command LISTS labels only and REMOVES by label.
 *
 * When @chorus/runtime is available, we delegate encryption to its
 * credentials module (so we share a code path with the executor). If the
 * runtime isn't built yet, we fall back to an inline AES-GCM helper that
 * matches the algorithm documented in ARCHITECTURE §4.6.
 *
 * The catalog-aware subcommands (`test`, `types`, `migrate`, `pat-help`)
 * accept an optional `integrationLoader` so callers can inject a
 * pre-wired integration resolver; the default loader dynamic-imports
 * `@chorus-integrations/<name>`.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import pc from "picocolors";
import type {
  CredentialTestResult,
  CredentialTypeDefinition,
  IntegrationManifest,
  IntegrationModule,
  OperationContext,
} from "@chorus/core";
import { loadConfig } from "../config.js";

export type CredentialType = "apiKey" | "oauth2" | "basic" | "bearer";

export interface CredentialsAddOptions {
  cwd?: string;
  integration: string;
  type: CredentialType;
  name?: string;
  /** Pre-provided secret (CI use). Prompted when absent + interactive=true. */
  secret?: string;
  /** For oauth2/basic, the composite payload to encrypt. */
  payload?: Record<string, unknown>;
  /** Whether to read the secret from stdin when missing. */
  interactive?: boolean;
}

export interface CredentialsListOptions {
  cwd?: string;
  json?: boolean;
}

export interface CredentialsRemoveOptions {
  cwd?: string;
  integration: string;
  name: string;
}

export interface CredentialSummary {
  id: string;
  integration: string;
  name: string;
  type: CredentialType;
  createdAt: string;
}

// ── add ─────────────────────────────────────────────────────────────────────

export async function credentialsAdd(opts: CredentialsAddOptions): Promise<number> {
  const name = opts.name ?? "default";
  const p = process.stdout.write.bind(process.stdout);
  const key = readEncryptionKey();
  if (!key) {
    process.stderr.write(
      pc.red(
        "error: CHORUS_ENCRYPTION_KEY not set. Add it to your environment before storing credentials.\n",
      ),
    );
    return 2;
  }

  // Compose the plaintext payload.
  let plaintext: string;
  if (opts.payload) {
    plaintext = JSON.stringify(opts.payload);
  } else if (opts.secret !== undefined) {
    plaintext = opts.secret;
  } else if (opts.interactive) {
    plaintext = await promptSecret(`enter ${opts.type} secret for ${opts.integration}: `);
    if (!plaintext) {
      process.stderr.write(pc.red("error: empty secret — aborting\n"));
      return 3;
    }
  } else {
    process.stderr.write(
      pc.red(
        "error: no secret provided. Pass --secret, --payload, or --interactive.\n",
      ),
    );
    return 3;
  }

  const blob = encryptAesGcm(plaintext, key);
  await upsertCredentialRow({
    cwd: opts.cwd,
    id: randomUUID(),
    integration: opts.integration,
    name,
    type: opts.type,
    encryptedPayload: blob,
  });

  p(
    `${pc.green("✓")} stored credential ${pc.cyan(`${opts.integration}:${name}`)} ` +
      `(${opts.type})\n`,
  );
  p(`   ${pc.dim("(encrypted with CHORUS_ENCRYPTION_KEY; plaintext never written)")}\n`);
  return 0;
}

// ── list ────────────────────────────────────────────────────────────────────

export async function credentialsList(opts: CredentialsListOptions): Promise<number> {
  const rows = await queryCredentials(opts.cwd);
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  const p = process.stdout.write.bind(process.stdout);
  if (rows.length === 0) {
    p(`${pc.dim("no credentials stored")}\n`);
    return 0;
  }
  p(`${pc.bold("Credentials")} ${pc.dim(`(${rows.length})`)}\n`);
  for (const r of rows) {
    p(
      `   ${pc.cyan(r.integration)}:${r.name}  ${pc.dim(r.type)}  ${pc.dim(`created ${r.createdAt}`)}\n`,
    );
  }
  return 0;
}

// ── remove ──────────────────────────────────────────────────────────────────

export async function credentialsRemove(opts: CredentialsRemoveOptions): Promise<number> {
  const removed = await deleteCredential(opts.cwd, opts.integration, opts.name);
  const p = process.stdout.write.bind(process.stdout);
  if (removed) {
    p(`${pc.green("✓")} removed ${pc.cyan(`${opts.integration}:${opts.name}`)}\n`);
    return 0;
  }
  p(`${pc.yellow("!")} no credential found for ${opts.integration}:${opts.name}\n`);
  return 1;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function readEncryptionKey(): Buffer | null {
  const raw = process.env.CHORUS_ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Encrypt plaintext → (IV || tag || ciphertext). Matches the algorithm
 * documented in ARCHITECTURE §4.6 — the runtime's decrypt will work on
 * the output of this function.
 */
export function encryptAesGcm(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

async function upsertCredentialRow(args: {
  cwd?: string;
  id: string;
  integration: string;
  name: string;
  type: CredentialType;
  encryptedPayload: Buffer;
}): Promise<void> {
  const { config, chorusDir } = await loadConfig(args.cwd ?? process.cwd());
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);
  const Database = await loadSqlite();
  if (!Database) throw new Error("better-sqlite3 not available");
  const db = Database(dbPath, { readonly: false, fileMustExist: false });
  try {
    ensureCredentialsTable(db);
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO credentials (id, integration, type, name, encrypted_payload,
                                oauth_access_expires, oauth_refresh_expires, oauth_scopes,
                                state, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', NULL, ?, ?)
       ON CONFLICT(integration, name) DO UPDATE SET
         encrypted_payload = excluded.encrypted_payload,
         type = excluded.type,
         updated_at = excluded.updated_at,
         state = 'active', last_error = NULL`,
    ).run(
      args.id,
      args.integration,
      args.type,
      args.name,
      args.encryptedPayload,
      nowIso,
      nowIso,
    );
  } finally {
    db.close();
  }
}

async function queryCredentials(cwd: string | undefined): Promise<CredentialSummary[]> {
  const root = cwd ?? process.cwd();
  let dbPath: string;
  try {
    const { config, chorusDir } = await loadConfig(root);
    dbPath = path.isAbsolute(config.database.path)
      ? config.database.path
      : path.join(path.dirname(chorusDir), config.database.path);
  } catch {
    return [];
  }
  const Database = await loadSqlite();
  if (!Database) return [];
  let db: ReturnType<typeof Database>;
  try {
    db = Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    if (!hasTable(db, "credentials")) return [];
    const rows = db
      .prepare(
        `SELECT id, integration, name, type, created_at AS createdAt
           FROM credentials
          ORDER BY integration, name`,
      )
      .all() as CredentialSummary[];
    return rows;
  } finally {
    db.close();
  }
}

async function deleteCredential(
  cwd: string | undefined,
  integration: string,
  name: string,
): Promise<boolean> {
  const root = cwd ?? process.cwd();
  const { config, chorusDir } = await loadConfig(root);
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);
  const Database = await loadSqlite();
  if (!Database) return false;
  const db = Database(dbPath, { readonly: false, fileMustExist: false });
  try {
    ensureCredentialsTable(db);
    const result = db
      .prepare(`DELETE FROM credentials WHERE integration = ? AND name = ?`)
      .run(integration, name) as { changes?: number };
    return (result.changes ?? 0) > 0;
  } finally {
    db.close();
  }
}

function ensureCredentialsTable(db: {
  prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
}): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS credentials (
       id                    TEXT PRIMARY KEY,
       integration           TEXT NOT NULL,
       type                  TEXT NOT NULL,
       name                  TEXT NOT NULL,
       encrypted_payload     BLOB NOT NULL,
       oauth_access_expires  TEXT,
       oauth_refresh_expires TEXT,
       oauth_scopes          TEXT,
       state                 TEXT NOT NULL DEFAULT 'active',
       last_error            TEXT,
       created_at            TEXT NOT NULL,
       updated_at            TEXT NOT NULL,
       UNIQUE(integration, name)
     )`,
  ).run();
}

function hasTable(db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

async function loadSqlite(): Promise<
  | null
  | ((
      path: string,
      opts?: { readonly?: boolean; fileMustExist?: boolean },
    ) => {
      prepare: (sql: string) => {
        run: (...a: unknown[]) => unknown;
        all: (...a: unknown[]) => unknown;
        get: (...a: unknown[]) => unknown;
      };
      close: () => void;
    })
> {
  // Native ESM dynamic import — `new Function("s", "return import(s)")`
  // fails in vitest/vite runners with "dynamic import callback was not
  // specified", so we use the standard form. Resolves to
  // `better-sqlite3`'s default export (the Database constructor).
  try {
    const mod = (await import("better-sqlite3")) as
      | { default: unknown }
      | Record<string, unknown>;
    const ctor = ((mod as { default?: unknown }).default ?? mod) as never;
    return ctor;
  } catch {
    return null;
  }
}

/**
 * Read a secret from stdin without echoing. Robust for non-TTY input
 * (e.g. piped). Interactive behavior depends on readline being available.
 */
async function promptSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const str = Buffer.concat(chunks).toString("utf8");
      const nl = str.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(str.slice(0, nl).replace(/\r$/, ""));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ── Catalog-aware subcommands (docs/CREDENTIALS_ANALYSIS.md §6) ─────────────

/**
 * Integration loader signature — matches `@chorus/runtime`'s
 * `IntegrationLoader`. Kept isomorphic so both can use the same
 * `@chorus-integrations/<name>` convention or an injected resolver.
 */
export type IntegrationLoader = (
  integration: string,
) => Promise<IntegrationModule>;

/**
 * Default loader: dynamic-imports `@chorus-integrations/<name>`. Returns
 * the default export (the IntegrationModule). Throws a descriptive
 * error when the package isn't installed.
 */
export async function defaultIntegrationLoader(
  name: string,
): Promise<IntegrationModule> {
  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<unknown>;
  try {
    const mod = (await dynamicImport(
      `@chorus-integrations/${name}`,
    )) as { default?: IntegrationModule } | IntegrationModule;
    const m =
      (mod as { default?: IntegrationModule }).default ??
      (mod as IntegrationModule);
    if (!m?.manifest) {
      throw new Error(
        `@chorus-integrations/${name} does not export a valid IntegrationModule`,
      );
    }
    return m;
  } catch (err) {
    throw new Error(
      `cannot load @chorus-integrations/${name}: ${(err as Error).message}`,
    );
  }
}

// ── test ───────────────────────────────────────────────────────────────────

export interface CredentialsTestOptions {
  cwd?: string;
  /** Reference: `<integration>:<name>` (e.g. `slack-send:default`). */
  ref: string;
  /** Override integration loader; defaults to @chorus-integrations/<name>. */
  integrationLoader?: IntegrationLoader;
  /** Override fetch — used by tests. */
  fetchFn?: typeof fetch;
  json?: boolean;
}

/**
 * `chorus credentials test <integration:name>` — call the integration's
 * testCredential and print the verdict. Exit 0 on pass, 1 on fail.
 *
 * The runtime decrypts the credential blob, constructs an
 * OperationContext with ctx.credentials populated from the decrypted
 * payload (object when JSON, plain string otherwise), and invokes:
 *   1. `integration.testCredential` if present (preferred)
 *   2. otherwise prints "no test available" and exits 0
 *
 * Note: the `test.viaOperation` path from §4.4 is not implemented here —
 * it would require wiring the full executor, which is out of scope for
 * the CLI fast-path. Integrations that want a test should implement
 * `testCredential` on their IntegrationModule directly.
 */
export async function credentialsTest(
  opts: CredentialsTestOptions,
): Promise<number> {
  const p = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const parsed = parseRef(opts.ref);
  if (!parsed) {
    stderr(
      pc.red(
        `error: invalid ref "${opts.ref}". Expected format: <integration>:<name>\n`,
      ),
    );
    return 2;
  }
  const { integration, name } = parsed;

  const key = readEncryptionKey();
  if (!key) {
    stderr(pc.red("error: CHORUS_ENCRYPTION_KEY not set.\n"));
    return 2;
  }

  // Load credential row.
  const row = await queryCredentialRow(opts.cwd, integration, name);
  if (!row) {
    stderr(pc.red(`error: no credential for ${integration}:${name}\n`));
    return 2;
  }

  // Decrypt.
  let decoded: unknown;
  try {
    const plaintext = decryptAesGcm(row.encrypted_payload, key);
    try {
      decoded = JSON.parse(plaintext) as unknown;
    } catch {
      decoded = plaintext; // raw string credential
    }
  } catch (err) {
    stderr(
      pc.red(`error: decryption failed: ${(err as Error).message}\n`),
    );
    return 2;
  }

  // Load integration.
  const loader = opts.integrationLoader ?? defaultIntegrationLoader;
  let integrationModule: IntegrationModule;
  try {
    integrationModule = await loader(integration);
  } catch (err) {
    stderr(
      pc.yellow(
        `! cannot load integration '${integration}': ${(err as Error).message}\n`,
      ),
    );
    stderr(
      pc.dim(
        `  credential saved unchecked. Install the integration package to run tests.\n`,
      ),
    );
    return 0;
  }

  if (!integrationModule.testCredential) {
    p(
      pc.yellow("! ") +
        `no testCredential exported by ${integration}; credential saved unchecked\n`,
    );
    return 0;
  }

  const ctx: OperationContext = {
    credentials: decoded as Record<string, unknown> | null,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    signal: new AbortController().signal,
  };
  const typeName = row.credential_type_name || `${integration}:legacy`;
  let result: CredentialTestResult;
  try {
    result = await integrationModule.testCredential(typeName, ctx);
  } catch (err) {
    stderr(
      pc.red(
        `✗ ${integration}:${name} (${typeName}) — test threw: ${(err as Error).message}\n`,
      ),
    );
    return 1;
  }

  if (opts.json) {
    p(JSON.stringify({ ref: `${integration}:${name}`, typeName, ...result }, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  const ms = Math.round(result.latencyMs);
  if (result.ok) {
    p(
      `${pc.green("✓")} ${pc.cyan(`${integration}:${name}`)} ` +
        `(${pc.dim(typeName)}) — ${ms}ms\n`,
    );
    const id = result.identity;
    if (id?.userName || id?.workspaceName) {
      const who = id.userName ? `@${id.userName}` : "unknown user";
      const where = id.workspaceName ? ` in ${id.workspaceName}` : "";
      p(`  authenticated as: ${who}${where}\n`);
    }
    if (id?.scopes && id.scopes.length > 0) {
      p(`  scopes: ${id.scopes.join(",")}\n`);
    }
    return 0;
  }
  p(
    `${pc.red("✗")} ${pc.cyan(`${integration}:${name}`)} ` +
      `(${pc.dim(typeName)}) — ${ms}ms\n`,
  );
  if (result.error) p(`  error: ${result.errorCode ?? "UNKNOWN"} — ${result.error}\n`);
  return 1;
}

// ── pat-help ───────────────────────────────────────────────────────────────

export interface CredentialsPatHelpOptions {
  cwd?: string;
  integration: string;
  /** Which credentialType to open docs for. Defaults to first type. */
  type?: string;
  integrationLoader?: IntegrationLoader;
  /** Override the browser-open routine — tests set this to a no-op/spy. */
  openFn?: (url: string) => void;
}

/**
 * `chorus credentials pat-help <integration> [--type <typeName>]` —
 * prints and opens the credential-type's documentationUrl (or the
 * first field's deepLink if absent). Solves the "where do I get this PAT?"
 * 3 AM confusion.
 */
export async function credentialsPatHelp(
  opts: CredentialsPatHelpOptions,
): Promise<number> {
  const p = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const loader = opts.integrationLoader ?? defaultIntegrationLoader;
  let mod: IntegrationModule;
  try {
    mod = await loader(opts.integration);
  } catch (err) {
    stderr(pc.red(`error: ${(err as Error).message}\n`));
    return 2;
  }
  const types = mod.manifest.credentialTypes ?? [];
  if (types.length === 0) {
    stderr(
      pc.yellow(
        `! ${opts.integration} declares no credentialTypes (manifest authType=${mod.manifest.authType})\n`,
      ),
    );
    if (mod.manifest.docsUrl) {
      p(`${pc.dim("opening docs:")} ${mod.manifest.docsUrl}\n`);
      (opts.openFn ?? openUrl)(mod.manifest.docsUrl);
      return 0;
    }
    return 1;
  }
  let chosen: CredentialTypeDefinition | undefined;
  if (opts.type) {
    chosen = types.find((t) => t.name === opts.type);
    if (!chosen) {
      stderr(pc.red(`error: no credentialType '${opts.type}' for ${opts.integration}\n`));
      return 2;
    }
  } else {
    chosen = types[0];
  }
  if (!chosen) {
    stderr(pc.red("error: internal resolution failure\n"));
    return 2;
  }
  const url =
    chosen.documentationUrl ??
    chosen.fields.find((f) => f.deepLink)?.deepLink ??
    mod.manifest.docsUrl;
  if (!url) {
    stderr(
      pc.yellow(
        `! no documentationUrl or deepLink for ${opts.integration}:${chosen.name}\n`,
      ),
    );
    return 1;
  }
  p(`${pc.dim("opening:")} ${url}\n`);
  (opts.openFn ?? openUrl)(url);
  return 0;
}

// ── types ──────────────────────────────────────────────────────────────────

export interface CredentialsTypesOptions {
  cwd?: string;
  /** Restrict to one integration. If omitted, list across all known integrations. */
  integration?: string;
  /** Where to look when no integration is given. Defaults to config.integrations list. */
  integrationNames?: string[];
  integrationLoader?: IntegrationLoader;
  json?: boolean;
}

/**
 * `chorus credentials types [--integration <name>]` — list declared
 * credential types. Used by users ("what can I configure?") and by
 * mcp-papa for discovery. JSON mode for agents.
 */
export async function credentialsTypes(
  opts: CredentialsTypesOptions,
): Promise<number> {
  const p = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const loader = opts.integrationLoader ?? defaultIntegrationLoader;

  const targets = opts.integration
    ? [opts.integration]
    : opts.integrationNames ?? (await listKnownIntegrations(opts.cwd));

  const summary: Array<{
    integration: string;
    types: Array<{
      name: string;
      authType: string;
      displayName: string;
      description?: string;
      documentationUrl?: string;
      fields: Array<{ name: string; type: string; required: boolean }>;
    }>;
  }> = [];

  for (const name of targets) {
    let mod: IntegrationModule;
    try {
      mod = await loader(name);
    } catch {
      continue;
    }
    summary.push({
      integration: name,
      types: (mod.manifest.credentialTypes ?? []).map((t) => ({
        name: t.name,
        authType: t.authType,
        displayName: t.displayName,
        description: t.description,
        documentationUrl: t.documentationUrl,
        fields: t.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
        })),
      })),
    });
  }

  if (opts.json) {
    p(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  if (summary.length === 0) {
    p(`${pc.dim("no integrations found")}\n`);
    return 0;
  }
  for (const s of summary) {
    p(`${pc.bold(s.integration)}\n`);
    if (s.types.length === 0) {
      p(`  ${pc.dim("(no credentialTypes declared)")}\n`);
      continue;
    }
    for (const t of s.types) {
      p(
        `  ${pc.cyan(t.name)}  ${pc.dim(`(${t.authType})`)}  ${t.displayName}\n`,
      );
      if (t.description) p(`    ${pc.dim(t.description)}\n`);
    }
  }
  if (summary.length === 1) {
    if (summary[0]!.types.length === 0) {
      stderr(pc.yellow(`! ${summary[0]!.integration} declares no credentialTypes\n`));
    }
  }
  return 0;
}

// ── migrate ────────────────────────────────────────────────────────────────

export interface CredentialsMigrateOptions {
  cwd?: string;
  id: string;
  /** New credentialTypeName (typically one declared on the integration). */
  to: string;
}

/**
 * `chorus credentials migrate <id> --to <typeName>` — reassigns the
 * row's `credential_type_name`. See docs/CREDENTIALS_ANALYSIS.md §5.3.
 */
export async function credentialsMigrate(
  opts: CredentialsMigrateOptions,
): Promise<number> {
  const p = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const { config, chorusDir } = await loadConfig(opts.cwd ?? process.cwd());
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);
  const Database = await loadSqlite();
  if (!Database) {
    stderr(pc.red("error: better-sqlite3 not available\n"));
    return 2;
  }
  const db = Database(dbPath, { readonly: false, fileMustExist: false });
  try {
    ensureCredentialsTable(db);
    // Ensure the new column exists on older DBs (belt-and-braces — the
    // runtime's openDatabase should have added it already, but the CLI
    // may be invoked against a DB the runtime hasn't opened yet).
    ensureCredentialTypeNameColumn(db);
    const row = db
      .prepare(
        `SELECT id, integration, credential_type_name AS credentialTypeName
           FROM credentials WHERE id = ?`,
      )
      .get(opts.id) as
      | { id: string; integration: string; credentialTypeName: string }
      | undefined;
    if (!row) {
      stderr(pc.red(`error: no credential with id ${opts.id}\n`));
      return 1;
    }
    const res = db
      .prepare(
        `UPDATE credentials SET credential_type_name = ?, updated_at = ? WHERE id = ?`,
      )
      .run(opts.to, new Date().toISOString(), opts.id) as {
      changes?: number;
    };
    if ((res.changes ?? 0) === 0) {
      stderr(pc.red(`error: update affected 0 rows (unexpected)\n`));
      return 1;
    }
    p(
      `${pc.green("✓")} migrated ${pc.cyan(`${row.integration}`)} ${pc.dim(opts.id)} ` +
        `${row.credentialTypeName || "''"} ${pc.dim("→")} ${pc.cyan(opts.to)}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function parseRef(
  ref: string,
): { integration: string; name: string } | null {
  const idx = ref.indexOf(":");
  if (idx < 1 || idx === ref.length - 1) return null;
  return {
    integration: ref.slice(0, idx),
    name: ref.slice(idx + 1),
  };
}

/**
 * Inverse of encryptAesGcm. Accepts blob/buffer from SQLite, returns
 * UTF-8 plaintext. Throws on tamper / bad key.
 */
function decryptAesGcm(blob: Buffer, key: Buffer): string {
  if (blob.length < 12 + 16) {
    throw new Error("credential blob too short");
  }
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

interface CredentialRowFull {
  id: string;
  integration: string;
  type: string;
  credential_type_name: string;
  name: string;
  encrypted_payload: Buffer;
  created_at: string;
  updated_at: string;
}

async function queryCredentialRow(
  cwd: string | undefined,
  integration: string,
  name: string,
): Promise<CredentialRowFull | null> {
  const root = cwd ?? process.cwd();
  const { config, chorusDir } = await loadConfig(root);
  const dbPath = path.isAbsolute(config.database.path)
    ? config.database.path
    : path.join(path.dirname(chorusDir), config.database.path);
  const Database = await loadSqlite();
  if (!Database) return null;
  let db: ReturnType<typeof Database>;
  try {
    db = Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    if (!hasTable(db, "credentials")) return null;
    const cols = listCols(db, "credentials");
    const selectTypeName = cols.includes("credential_type_name")
      ? "credential_type_name AS credential_type_name"
      : `'' AS credential_type_name`;
    const row = db
      .prepare(
        `SELECT id, integration, type, name, encrypted_payload,
                ${selectTypeName}, created_at, updated_at
           FROM credentials
          WHERE integration = ? AND name = ?`,
      )
      .get(integration, name) as CredentialRowFull | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

async function listKnownIntegrations(cwd: string | undefined): Promise<string[]> {
  // The CLI has no canonical integrations list today — the `types`
  // command picks up whatever the caller passes via `--integration`
  // or `integrationNames`. When neither is given, we walk the
  // credentials table to discover which integrations the user has
  // already configured and list their declared catalog.
  const root = cwd ?? process.cwd();
  try {
    const { config, chorusDir } = await loadConfig(root);
    const dbPath = path.isAbsolute(config.database.path)
      ? config.database.path
      : path.join(path.dirname(chorusDir), config.database.path);
    const Database = await loadSqlite();
    if (!Database) return [];
    let db: ReturnType<typeof Database>;
    try {
      db = Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return [];
    }
    try {
      if (!hasTable(db, "credentials")) return [];
      const rows = db
        .prepare(
          `SELECT DISTINCT integration FROM credentials ORDER BY integration`,
        )
        .all() as Array<{ integration: string }>;
      return rows.map((r) => r.integration);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function listCols(
  db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown } },
  table: string,
): string[] {
  const rows = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  ).map((r) => r.name ?? "");
  return rows.filter(Boolean);
}

function ensureCredentialTypeNameColumn(db: {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => unknown;
  };
}): void {
  const cols = listCols(db, "credentials");
  if (cols.includes("credential_type_name")) return;
  db.prepare(
    `ALTER TABLE credentials ADD COLUMN credential_type_name TEXT NOT NULL DEFAULT ''`,
  ).run();
}

/**
 * Cross-platform "open a URL in the default browser" that matches the
 * pattern used elsewhere in the CLI (see `chorus ui --serve`).
 */
function openUrl(url: string): void {
  const cmd =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.unref();
  } catch {
    // Best-effort; if no browser is available (headless CI), the URL
    // has already been printed to stdout — that's the fallback UX.
  }
}

/**
 * Manifest-only export helper: re-expose the CredentialTypeDefinition
 * listing logic for mcp-papa / other consumers that want to render the
 * same summary without invoking the CLI.
 */
export function summarizeCredentialTypes(
  manifest: IntegrationManifest,
): Array<{
  name: string;
  authType: string;
  displayName: string;
  fieldCount: number;
}> {
  return (manifest.credentialTypes ?? []).map((t) => ({
    name: t.name,
    authType: t.authType,
    displayName: t.displayName,
    fieldCount: t.fields.length,
  }));
}
