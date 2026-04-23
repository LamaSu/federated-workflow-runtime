#!/usr/bin/env node
/**
 * Chorus CLI entry point.
 *
 * Subcommands (see ARCHITECTURE §9):
 *   chorus init
 *   chorus compose "<natural-language prompt>"
 *   chorus run [workflow]
 *   chorus report [--json]
 *   chorus patch <list|apply|propose|revoke>
 *   chorus validate <file...>
 *   chorus credentials <add|list|remove|test|pat-help|types|migrate> ...
 *   chorus event <fire|watch|list-waiting> ...
 *   chorus mcp <list|generate|serve|config> ...
 *
 * This file wires commander flags to the command modules in ./commands/.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { runInit } from "./commands/init.js";
import { runRun } from "./commands/run.js";
import { runReport } from "./commands/report.js";
import { runValidate } from "./commands/validate.js";
import { runUi } from "./commands/ui.js";
import { composeCommand } from "./commands/compose.js";
import {
  runPatchCommand,
  type PatchAction,
} from "./commands/patch.js";
import {
  credentialsAdd,
  credentialsList,
  credentialsMigrate,
  credentialsPatHelp,
  credentialsRemove,
  credentialsTest,
  credentialsTypes,
  type CredentialType,
} from "./commands/credentials.js";
import { fireEvent, watchEvents, listWaiting } from "./commands/event.js";
import {
  mcpList,
  mcpGenerate,
  mcpServe,
  mcpConfig,
} from "./commands/mcp.js";

/**
 * Read version from the CLI package's own package.json at runtime. Works
 * whether invoked from tsx (src/cli.ts → ../package.json) or from the
 * built bundle (dist/cli.js → ../package.json). Falls back to "unknown"
 * if the file can't be read — the CLI still runs, just without a version.
 */
function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readVersion();

/**
 * Build the commander program. Exported so tests (and embedded users) can
 * re-parse without the process.exit side effect.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("chorus")
    .description("Chorus — federated workflow runtime with crowd-sourced integration maintenance")
    .version(VERSION);

  // ── init ──────────────────────────────────────────────────────────────────
  program
    .command("init")
    .description("scaffold a ./chorus/ project directory")
    .option("-n, --name <name>", "project name (defaults to basename of cwd)")
    .option("--passphrase <pass>", "explicit encryption passphrase (unsafe in shared shells)")
    .option("--passphrase-from-env", "skip generating a key; read CHORUS_ENCRYPTION_KEY from env at runtime")
    .action(async (opts: { name?: string; passphrase?: string; passphraseFromEnv?: boolean }) => {
      try {
        await runInit({
          name: opts.name,
          passphrase: opts.passphrase,
          passphraseFromEnv: opts.passphraseFromEnv,
        });
        process.exit(0);
      } catch (err) {
        process.stderr.write(pc.red(`init failed: ${(err as Error).message}\n`));
        process.exit(1);
      }
    });

  // ── run ───────────────────────────────────────────────────────────────────
  program
    .command("run [workflow]")
    .description("start the runtime (foreground). With a workflow id, run just that one.")
    .option("--dry-run", "parse + validate workflows, do not start the executor")
    .option("--no-follow", "do not tail step output")
    .action(async (workflow: string | undefined, opts: { dryRun?: boolean; follow?: boolean }) => {
      const code = await runRun({
        target: workflow,
        dryRun: opts.dryRun,
        follow: opts.follow,
      });
      process.exit(code);
    });

  // ── report ────────────────────────────────────────────────────────────────
  program
    .command("report")
    .description("show recent runs, error signatures, and known patches")
    .option("--json", "output JSON for agents/scripting")
    .option("--limit <n>", "max rows per table", (v) => Number.parseInt(v, 10), 20)
    .action(async (opts: { json?: boolean; limit?: number }) => {
      const code = await runReport({ json: opts.json, limit: opts.limit });
      process.exit(code);
    });

  // ── ui ────────────────────────────────────────────────────────────────────
  program
    .command("ui")
    .description(
      "generate a dashboard with your agent (prints API URL + prompt template)",
    )
    .option("--prompt", "print only the prompt template (pipe-friendly)")
    .option("--example", "write examples/ui/minimal.html into the cwd")
    .option("--serve", "serve the minimal reference HTML on port 3711")
    .option(
      "--port <port>",
      "override --serve port",
      (v) => Number.parseInt(v, 10),
      3711,
    )
    .action(async (opts: { prompt?: boolean; example?: boolean; serve?: boolean; port?: number }) => {
      const code = await runUi({
        prompt: opts.prompt,
        example: opts.example,
        serve: opts.serve,
        servePort: opts.port,
      });
      process.exit(code);
    });

  // ── compose ───────────────────────────────────────────────────────────────
  program
    .command("compose <prompt>")
    .description(
      "describe a workflow in natural language; emit a typed TS file to ./chorus/",
    )
    .option(
      "--max-attempts <n>",
      "Ralph-loop retries when the model's output fails Zod validation",
      (v) => Number.parseInt(v, 10),
      3,
    )
    .option(
      "--slug <slug>",
      "override the output filename slug (defaults to slugified workflow name)",
    )
    .action(
      async (
        prompt: string,
        opts: { maxAttempts?: number; slug?: string },
      ) => {
        const code = await composeCommand(prompt, {
          maxAttempts: opts.maxAttempts,
          slug: opts.slug,
        });
        process.exit(code);
      },
    );

  // ── validate ──────────────────────────────────────────────────────────────
  program
    .command("validate <files...>")
    .description("schema-check workflow file(s) without executing")
    .option("--json", "output JSON")
    .action(async (files: string[], opts: { json?: boolean }) => {
      const code = await runValidate(files, opts);
      process.exit(code);
    });

  // ── patch ─────────────────────────────────────────────────────────────────
  const patch = program
    .command("patch")
    .description("manage integration patches (list, apply, propose, revoke)");

  patch
    .command("list")
    .description("list known patches for installed integrations")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const code = await runPatchCommand("list", { json: opts.json });
      process.exit(code);
    });

  patch
    .command("apply <patchId>")
    .description("apply a patch after signature + canary verification")
    .option("--force", "skip canary gate (testing only)")
    .action(async (patchId: string, opts: { force?: boolean }) => {
      const code = await runPatchCommand("apply", { patchId, force: opts.force });
      process.exit(code);
    });

  patch
    .command("propose <manifestPath>")
    .description("submit a local patch proposal to the registry")
    .option("--json", "output JSON")
    .action(async (manifestPath: string, opts: { json?: boolean }) => {
      const code = await runPatchCommand("propose", { manifestPath, json: opts.json });
      process.exit(code);
    });

  patch
    .command("revoke <patchId>")
    .description("locally revoke a patch and report to the registry")
    .action(async (patchId: string) => {
      const code = await runPatchCommand("revoke", { patchId });
      process.exit(code);
    });

  // ── credentials ───────────────────────────────────────────────────────────
  const creds = program
    .command("credentials")
    .alias("cred")
    .description("add/list/remove credentials (stored encrypted; plaintext never printed)");

  creds
    .command("add <integration>")
    .description("encrypt and store a credential for an integration")
    .option("--type <type>", "credential type (apiKey|oauth2|basic|bearer)", "apiKey")
    .option("--name <name>", "label for the credential", "default")
    .option("--secret <value>", "provide the secret on CLI (visible to ps aux; prefer stdin)")
    .option("--interactive", "read secret from stdin without echoing")
    .action(
      async (
        integration: string,
        opts: { type: string; name?: string; secret?: string; interactive?: boolean },
      ) => {
        const type = validateCredentialType(opts.type);
        if (!type) {
          process.stderr.write(pc.red(`error: unknown credential type '${opts.type}'\n`));
          process.exit(1);
        }
        const code = await credentialsAdd({
          integration,
          type,
          name: opts.name,
          secret: opts.secret,
          interactive: opts.interactive,
        });
        process.exit(code);
      },
    );

  creds
    .command("list")
    .description("list credential labels (values never printed)")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const code = await credentialsList({ json: opts.json });
      process.exit(code);
    });

  creds
    .command("remove <integration> <name>")
    .description("remove a stored credential")
    .action(async (integration: string, name: string) => {
      const code = await credentialsRemove({ integration, name });
      process.exit(code);
    });

  // New catalog-aware subcommands (docs/CREDENTIALS_ANALYSIS.md §6) ---------

  creds
    .command("test <ref>")
    .description("test a stored credential via its integration's testCredential (ref = <integration>:<name>)")
    .option("--json", "output JSON (for CI / agents)")
    .action(async (ref: string, opts: { json?: boolean }) => {
      const code = await credentialsTest({ ref, json: opts.json });
      process.exit(code);
    });

  creds
    .command("pat-help <integration>")
    .description("open the docs URL for a credential type (solves 'where do I get this PAT?')")
    .option("--type <typeName>", "specific credentialType within the integration")
    .action(
      async (
        integration: string,
        opts: { type?: string },
      ) => {
        const code = await credentialsPatHelp({
          integration,
          type: opts.type,
        });
        process.exit(code);
      },
    );

  creds
    .command("types")
    .description("list declared credential types across integrations")
    .option("--integration <name>", "restrict to one integration")
    .option("--json", "output JSON (for mcp-papa / agents)")
    .action(async (opts: { integration?: string; json?: boolean }) => {
      const code = await credentialsTypes({
        integration: opts.integration,
        json: opts.json,
      });
      process.exit(code);
    });

  creds
    .command("migrate <id>")
    .description("reassign a credential row's credential_type_name (legacy → catalog entry)")
    .requiredOption("--to <typeName>", "target credential type name")
    .action(async (id: string, opts: { to: string }) => {
      const code = await credentialsMigrate({ id, to: opts.to });
      process.exit(code);
    });

  // ── event ────────────────────────────────────────────────────────────────
  const evt = program
    .command("event")
    .description("fire, watch, and inspect the internal event bus (v1.1 — waitForEvent)");

  evt
    .command("fire <type>")
    .description("emit an event via the runtime HTTP API")
    .option("--payload <json>", "JSON payload (or @path/to/file.json)")
    .option("--correlation <id>", "correlationId to tag the event with")
    .option("--source <name>", "source label for the event")
    .action(
      async (
        type: string,
        opts: { payload?: string; correlation?: string; source?: string },
      ) => {
        const code = await fireEvent({
          type,
          payload: opts.payload,
          correlationId: opts.correlation,
          source: opts.source,
        });
        process.exit(code);
      },
    );

  evt
    .command("watch [type]")
    .description("tail recent events (read-only)")
    .option("--limit <n>", "max events to show", (v) => Number.parseInt(v, 10), 50)
    .option("--json", "output JSON")
    .action(async (type: string | undefined, opts: { limit?: number; json?: boolean }) => {
      const code = await watchEvents({ type, limit: opts.limit, json: opts.json });
      process.exit(code);
    });

  evt
    .command("list-waiting")
    .description("show runs currently parked on step.waitForEvent")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const code = await listWaiting({ json: opts.json });
      process.exit(code);
    });

  // ── mcp ───────────────────────────────────────────────────────────────────
  const mcp = program
    .command("mcp")
    .description(
      "auto-MCP: expose Chorus integrations as MCP tools (list | generate | serve | config)",
    );

  mcp
    .command("list")
    .description("list installed integrations and their MCP-readiness")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const code = await mcpList({ json: opts.json });
      process.exit(code);
    });

  mcp
    .command("generate <integration>")
    .description("generate a standalone MCP server scaffold for an integration")
    .option("--out <dir>", "override output directory")
    .action(async (integration: string, opts: { out?: string }) => {
      const code = await mcpGenerate({ integration, out: opts.out });
      process.exit(code);
    });

  mcp
    .command("serve <integration>")
    .description("run an MCP server for the integration inline (stdio transport)")
    .action(async (integration: string) => {
      const code = await mcpServe({ integration });
      process.exit(code);
    });

  mcp
    .command("config <integration>")
    .description("print the .mcp.json snippet for a generated server (no filesystem writes)")
    .option("--out <dir>", "path used to compute the server's index.js location")
    .action(async (integration: string, opts: { out?: string }) => {
      const code = await mcpConfig({ integration, out: opts.out });
      process.exit(code);
    });

  return program;
}

function validateCredentialType(t: string): CredentialType | null {
  if (t === "apiKey" || t === "oauth2" || t === "basic" || t === "bearer") return t;
  return null;
}

// Re-export action types so power users can extend the CLI programmatically.
export type { PatchAction };

/**
 * Main: only runs when this file is executed directly (not when imported
 * from tests or another module).
 */
async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

// Detect direct invocation in an ESM-safe way. `import.meta.url` is the
// module's URL; comparing its pathname against `process.argv[1]` tells us
// whether this file was called as a script.
const isDirectInvocation = (): boolean => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const here = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    // Normalize slashes so Windows `C:\...` compares equal to URL `C:/...`.
    const normalize = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
    return normalize(argv1) === normalize(here);
  } catch {
    return false;
  }
};

if (isDirectInvocation()) {
  void main().catch((err) => {
    process.stderr.write(pc.red(`chorus: ${(err as Error).message}\n`));
    process.exit(1);
  });
}
