#!/usr/bin/env node
/**
 * Chorus CLI entry point.
 *
 * Subcommands (see ARCHITECTURE §9):
 *   chorus init
 *   chorus run [workflow]
 *   chorus report [--json]
 *   chorus patch <list|apply|propose|revoke>
 *   chorus validate <file...>
 *   chorus credentials <add|list|remove> ...
 *
 * This file wires commander flags to the command modules in ./commands/.
 */
import { Command } from "commander";
import pc from "picocolors";
import { runInit } from "./commands/init.js";
import { runRun } from "./commands/run.js";
import { runReport } from "./commands/report.js";
import { runValidate } from "./commands/validate.js";
import {
  runPatchCommand,
  type PatchAction,
} from "./commands/patch.js";
import {
  credentialsAdd,
  credentialsList,
  credentialsRemove,
  type CredentialType,
} from "./commands/credentials.js";

const VERSION = "0.1.0";

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
