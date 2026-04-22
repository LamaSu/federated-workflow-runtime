#!/usr/bin/env node
// scripts/publish-local.js
//
// Publish all @delightfulchorus/* packages to npm from a local machine.
//
// Why this script exists:
//   Every package.json declares publishConfig.provenance = true, which tells
//   npm to attach a Sigstore attestation. That only works under CI OIDC — on a
//   laptop it fails with "Automatic provenance generation not supported for
//   provider: null". So we:
//     1. Strip provenance:true from every package.json (in-place)
//     2. Publish each one (npm publish --access=public)
//     3. Restore provenance:true (git-level no-op since the file contents
//        round-trip to the pre-strip version)
//
// Safe to re-run: if a package is already published at the current version
// npm returns 403 and we continue. Non-fatal.
//
// Usage: node scripts/publish-local.js [--dry-run]

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry-run");

const dirs = ["packages", "integrations"];
const pkgs = [];
for (const d of dirs) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) continue;
  for (const sub of fs.readdirSync(full)) {
    const pj = path.join(full, sub, "package.json");
    if (fs.existsSync(pj)) pkgs.push({ dir: path.join(full, sub), pj });
  }
}

// Publish order: core first, then leaf packages that depend on core, then CLI.
// npm resolves workspace:* / * at publish time so intra-workspace deps that
// haven't been published yet will break. We order deepest-first.
const order = [
  "core",
  "service-catalog",
  "mcp",
  "reporter",
  "repair-agent",
  "registry",
  "runtime",
  "cli",
  "integration-gmail-send",
  "integration-http-generic",
  "integration-mcp-proxy",
  "integration-postgres-query",
  "integration-slack-send",
  "integration-stripe-charge",
  "integration-universal-http",
];

pkgs.sort((a, b) => {
  const an = JSON.parse(fs.readFileSync(a.pj, "utf8")).name.replace("@delightfulchorus/", "");
  const bn = JSON.parse(fs.readFileSync(b.pj, "utf8")).name.replace("@delightfulchorus/", "");
  return (order.indexOf(an) === -1 ? 999 : order.indexOf(an)) -
         (order.indexOf(bn) === -1 ? 999 : order.indexOf(bn));
});

const originals = new Map();

// Step 1: strip provenance everywhere
for (const { pj } of pkgs) {
  const raw = fs.readFileSync(pj, "utf8");
  originals.set(pj, raw);
  const j = JSON.parse(raw);
  if (j.publishConfig?.provenance) {
    delete j.publishConfig.provenance;
    fs.writeFileSync(pj, JSON.stringify(j, null, 2) + "\n");
  }
}
console.log(`[strip] removed provenance from ${originals.size} package.json files`);

// Step 2: publish each one
const results = [];
for (const { dir, pj } of pkgs) {
  const j = JSON.parse(fs.readFileSync(pj, "utf8"));
  const name = j.name;
  const version = j.version;
  if (DRY) {
    console.log(`[dry]   would publish ${name}@${version}`);
    results.push({ name, version, status: "dry" });
    continue;
  }
  try {
    console.log(`[pub]   ${name}@${version} ...`);
    // --ignore-scripts skips prepublishOnly (rebuild + retest). dist/ is
    // already built on the originating machine; Spark often lacks linked
    // workspace node_modules after a tar sync and rebuilding there adds no
    // signal.
    execSync("npm publish --access=public --ignore-scripts", {
      cwd: dir,
      stdio: "inherit",
    });
    results.push({ name, version, status: "published" });
  } catch (e) {
    // 403 = already at this version. Not fatal.
    const msg = String(e.message || e);
    if (msg.includes("403") || msg.includes("previously published")) {
      console.log(`[skip]  ${name}@${version} already on npm`);
      results.push({ name, version, status: "already-published" });
    } else {
      console.error(`[fail]  ${name}@${version}: ${msg.split("\n")[0]}`);
      results.push({ name, version, status: "failed", error: msg.split("\n")[0] });
    }
  }
}

// Step 3: restore
for (const [pj, raw] of originals) {
  fs.writeFileSync(pj, raw);
}
console.log(`[restore] restored ${originals.size} package.json files`);

// Summary
console.log("\n===== SUMMARY =====");
const pub = results.filter((r) => r.status === "published").length;
const skip = results.filter((r) => r.status === "already-published").length;
const fail = results.filter((r) => r.status === "failed").length;
console.log(`Published: ${pub}   Already: ${skip}   Failed: ${fail}`);
if (fail) {
  for (const r of results.filter((r) => r.status === "failed")) {
    console.log(`  FAIL ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
