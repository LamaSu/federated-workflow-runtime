#!/usr/bin/env -S node --experimental-strip-types
/**
 * validate-revocation.ts
 *
 * Standalone validator for a CDN-published Chorus revocation list.
 *
 * Usage:
 *   tsx validate-revocation.ts \
 *       --url https://patches.example.com/revoked.json \
 *       --sig-url https://patches.example.com/revoked.sig.json \
 *       --public-key <base64-Ed25519-pubkey>
 *       [--max-age-seconds 900]
 *       [--allow-stale]
 *
 * Exit codes:
 *   0   list verified and fresh
 *   1   verification failure (schema, signature, freshness, network)
 *   2   usage / arg error
 *
 * This is the mental model of a Chorus client's 5-minute revocation poll:
 *   1. Fetch revoked.json + its signature bundle.
 *   2. Parse the signature bundle → extract payloadSha256 + signatureBase64 + signerId.
 *   3. Recompute SHA-256 over canonical JSON of revoked.json and compare.
 *   4. Verify the signature over the canonical payload with the trusted public key.
 *   5. Enforce freshness: `asOf` must be within --max-age-seconds (default 15 min).
 *
 * Dependencies: @noble/ed25519, @noble/hashes — the same libs the Chorus client uses.
 * This keeps ops tooling and client implementation aligned, byte-for-byte.
 */

import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Wire sync sha512 for @noble/ed25519 v2 (mirrors packages/registry/src/sign.ts).
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...msgs: Uint8Array[]) => sha512(concat(msgs));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

interface Args {
  url: string;
  sigUrl: string;
  publicKeyB64: string;
  maxAgeSeconds: number;
  allowStale: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { maxAgeSeconds: 900, allowStale: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--sig-url":
        args.sigUrl = argv[++i];
        break;
      case "--public-key":
        args.publicKeyB64 = argv[++i];
        break;
      case "--max-age-seconds":
        args.maxAgeSeconds = Number(argv[++i]);
        break;
      case "--allow-stale":
        args.allowStale = true;
        break;
      case "-h":
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        console.error(`unknown flag: ${flag}`);
        printUsageAndExit(2);
    }
  }
  if (!args.url || !args.sigUrl || !args.publicKeyB64) {
    console.error("missing required flags");
    printUsageAndExit(2);
  }
  if (!Number.isFinite(args.maxAgeSeconds) || (args.maxAgeSeconds as number) < 0) {
    console.error("--max-age-seconds must be a non-negative number");
    printUsageAndExit(2);
  }
  return args as Args;
}

function printUsageAndExit(code: number): never {
  process.stderr.write(
    [
      "usage: validate-revocation.ts --url <json-url> --sig-url <sig-url> --public-key <base64>",
      "                             [--max-age-seconds 900] [--allow-stale]",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

/** Recursively sorted, compact JSON (mirrors canary.ts/manifest.ts canonicalJson). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return res.json();
}

interface RevocationList {
  schemaVersion: string;
  asOf: string;
  revoked: Array<{ patchId: string; reason: string; severity: string; revokedAt: string }>;
  signature?: string;
  rekorLogIndex?: number;
}

interface SignatureBundle {
  payloadSha256: string;
  signatureBase64: string;
  signerId: string;
  signedAt: string;
}

function isRevocationList(x: unknown): x is RevocationList {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.schemaVersion === "string" &&
    typeof o.asOf === "string" &&
    Array.isArray(o.revoked)
  );
}

function isSignatureBundle(x: unknown): x is SignatureBundle {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.payloadSha256 === "string" &&
    typeof o.signatureBase64 === "string" &&
    typeof o.signerId === "string" &&
    typeof o.signedAt === "string"
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let listRaw: unknown;
  let sigRaw: unknown;
  try {
    [listRaw, sigRaw] = await Promise.all([fetchJson(args.url), fetchJson(args.sigUrl)]);
  } catch (err) {
    fail(`network: ${(err as Error).message}`);
  }

  if (!isRevocationList(listRaw)) fail("schema: revocation list is not a valid shape");
  if (!isSignatureBundle(sigRaw)) fail("schema: signature bundle is not a valid shape");
  const list = listRaw as RevocationList;
  const sig = sigRaw as SignatureBundle;

  if (list.schemaVersion !== "1.0.0") fail(`schema: unsupported schemaVersion ${list.schemaVersion}`);

  // Canonicalize the list minus any `signature` field and SHA-256 it.
  const { signature: _s, ...body } = list;
  void _s;
  const canonical = canonicalJson(body);
  const hex = createHash("sha256").update(canonical).digest("hex");

  if (hex !== sig.payloadSha256) {
    fail(
      `hash mismatch: list canonical SHA-256=${hex} but signature claims ${sig.payloadSha256}`,
    );
  }

  // Verify the Ed25519 signature over the canonical payload bytes.
  const pub = base64ToBytes(args.publicKeyB64);
  if (pub.length !== 32) fail(`public key must be 32 bytes, got ${pub.length}`);
  const sigBytes = base64ToBytes(sig.signatureBase64);
  if (sigBytes.length !== 64) fail(`signature must be 64 bytes, got ${sigBytes.length}`);
  const payloadBytes = new TextEncoder().encode(canonical);

  const ok = ed.verify(sigBytes, payloadBytes, pub);
  if (!ok) fail("signature: Ed25519 verify FAILED against provided public key");

  // Freshness check.
  const asOfMs = Date.parse(list.asOf);
  if (!Number.isFinite(asOfMs)) fail(`freshness: unparseable asOf ${list.asOf}`);
  const ageS = Math.floor((Date.now() - asOfMs) / 1000);
  if (ageS > args.maxAgeSeconds && !args.allowStale) {
    fail(`freshness: asOf is ${ageS}s old, max-age-seconds=${args.maxAgeSeconds}`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        asOf: list.asOf,
        revokedCount: list.revoked.length,
        signerId: sig.signerId,
        payloadSha256: hex,
        ageSeconds: ageS,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

function fail(msg: string): never {
  process.stderr.write(`FAIL: ${msg}\n`);
  process.exit(1);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
