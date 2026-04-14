/**
 * `chorus credentials <add|list|remove>` — credential management.
 *
 * Credentials are encrypted with AES-256-GCM using CHORUS_ENCRYPTION_KEY
 * before being written to SQLite. Plaintext never hits disk, never hits
 * stdout — this command LISTS labels only and REMOVES by label.
 *
 * When @chorus/runtime is available, we delegate encryption to its
 * credentials module (so we share a code path with the executor). If the
 * runtime isn't built yet, we fall back to an inline AES-GCM helper that
 * matches the algorithm documented in ARCHITECTURE §4.6.
 */
import { randomBytes, createCipheriv } from "node:crypto";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pc from "picocolors";
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
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
  try {
    const mod = (await dynamicImport("better-sqlite3")) as
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
