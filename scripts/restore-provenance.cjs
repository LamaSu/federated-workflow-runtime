#!/usr/bin/env node
// scripts/restore-provenance.cjs
// Add publishConfig.provenance:true to every @delightfulchorus/* package.json
// that's missing it. Safe to re-run.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const dirs = ["packages", "integrations"];

let touched = 0;
for (const d of dirs) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) continue;
  for (const sub of fs.readdirSync(full)) {
    const pj = path.join(full, sub, "package.json");
    if (!fs.existsSync(pj)) continue;
    const raw = fs.readFileSync(pj, "utf8");
    const j = JSON.parse(raw);
    if (!j.publishConfig) j.publishConfig = { access: "public", registry: "https://registry.npmjs.org/" };
    if (j.publishConfig.provenance === true) continue;
    j.publishConfig.provenance = true;
    fs.writeFileSync(pj, JSON.stringify(j, null, 2) + "\n");
    touched++;
    console.log(`[ok] ${j.name}`);
  }
}
console.log(`\nrestored provenance:true on ${touched} package.json file(s)`);
