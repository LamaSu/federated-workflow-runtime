#!/usr/bin/env node
/**
 * scripts/bump-version.js
 *
 * Chorus version-synchronization tool.
 *
 * Usage:
 *   node scripts/bump-version.js 0.2.0         # set all workspace versions to 0.2.0
 *   node scripts/bump-version.js --check       # verify all versions match root
 *   node scripts/bump-version.js --show        # print current version table
 *
 * Why a script and not `npm version --workspaces`?
 *
 * `npm version --workspaces X.Y.Z` works in npm 7+, BUT it also creates a git
 * commit + tag per workspace (one per package), which pollutes history when
 * you have 7 packages. We want one atomic bump across all packages with a
 * single commit. This script does exactly that and nothing else.
 *
 * No dependencies beyond node builtins. Runs on Node 20+.
 *
 * Constitutional:
 *   - Root `package.json` is the source of truth for version when --show.
 *   - On bump, ALL package.json files (root + packages/* + integrations/*)
 *     are rewritten with the new version. No exceptions.
 *   - Trailing newline preserved.
 *   - 2-space indent preserved (the existing convention in this repo).
 *
 * Exit codes:
 *   0  success (bump or check passed)
 *   1  validation error (bad semver, mismatch on --check)
 *   2  filesystem / parse error
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/**
 * Discover every package.json we control.
 * @returns {string[]} absolute paths
 */
function discoverPackageJsons() {
  const files = [join(ROOT, 'package.json')];
  for (const dir of ['packages', 'integrations']) {
    const parent = join(ROOT, dir);
    let entries;
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of entries) {
      const pkgDir = join(parent, name);
      try {
        if (!statSync(pkgDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const pkgJson = join(pkgDir, 'package.json');
      try {
        statSync(pkgJson);
        files.push(pkgJson);
      } catch {
        // no package.json in that workspace dir — skip
      }
    }
  }
  return files;
}

/**
 * Read JSON from disk. Exits 2 on parse error.
 * @param {string} p
 * @returns {{data: any, raw: string}}
 */
function readJson(p) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    console.error(`error: cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
  try {
    return { data: JSON.parse(raw), raw };
  } catch (e) {
    console.error(`error: invalid JSON at ${p}: ${e.message}`);
    process.exit(2);
  }
}

/**
 * Write JSON preserving trailing newline and 2-space indent.
 * @param {string} p
 * @param {any} data
 */
function writeJson(p, data) {
  const out = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(p, out, 'utf8');
}

function usage() {
  const msg = [
    'Usage:',
    '  node scripts/bump-version.js <semver>     bump all workspaces to <semver>',
    '  node scripts/bump-version.js --check      assert all versions are in sync',
    '  node scripts/bump-version.js --show       print version table (no changes)',
    '',
    'Examples:',
    '  node scripts/bump-version.js 0.2.0',
    '  node scripts/bump-version.js 1.0.0-rc.1',
    '  node scripts/bump-version.js --check',
    '',
  ].join('\n');
  console.log(msg);
}

/**
 * Print a table of (path, name, version) for every package.json.
 * @param {string[]} files
 */
function printTable(files) {
  const rows = files.map((f) => {
    const { data } = readJson(f);
    const relative = f.slice(ROOT.length + 1).replace(/\\/g, '/');
    return {
      path: relative,
      name: data.name || '(unnamed)',
      version: data.version || '(none)',
      private: data.private === true ? 'yes' : 'no',
    };
  });
  const widths = {
    path: Math.max(4, ...rows.map((r) => r.path.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    private: 7,
  };
  const line = (r) =>
    [
      r.path.padEnd(widths.path),
      r.name.padEnd(widths.name),
      r.version.padEnd(widths.version),
      r.private.padEnd(widths.private),
    ].join('  ');
  console.log(line({ path: 'PATH', name: 'NAME', version: 'VERSION', private: 'PRIVATE' }));
  console.log(line({ path: '-'.repeat(widths.path), name: '-'.repeat(widths.name), version: '-'.repeat(widths.version), private: '-'.repeat(widths.private) }));
  for (const r of rows) console.log(line(r));
}

/**
 * Assert every file has the same version as root. Exits 1 on mismatch.
 * @param {string[]} files
 */
function checkInSync(files) {
  const versions = files.map((f) => {
    const { data } = readJson(f);
    return { path: f, version: data.version, name: data.name };
  });
  const rootVersion = versions[0].version;
  if (!rootVersion) {
    console.error('error: root package.json has no version field');
    process.exit(1);
  }
  const mismatches = versions.filter((v) => v.version !== rootVersion);
  if (mismatches.length > 0) {
    console.error(`error: version drift — root is ${rootVersion}, but:`);
    for (const m of mismatches) {
      const rel = m.path.slice(ROOT.length + 1).replace(/\\/g, '/');
      console.error(`  ${rel}  (${m.name})  ${m.version}`);
    }
    console.error('');
    console.error(`Fix: node scripts/bump-version.js ${rootVersion}`);
    process.exit(1);
  }
  console.log(`all ${versions.length} workspaces at ${rootVersion}`);
}

/**
 * Bump all packages to the target version.
 * @param {string[]} files
 * @param {string} version
 */
function bump(files, version) {
  if (!SEMVER_RE.test(version)) {
    console.error(`error: '${version}' is not valid semver (X.Y.Z or X.Y.Z-prerelease)`);
    process.exit(1);
  }
  let changed = 0;
  for (const f of files) {
    const { data } = readJson(f);
    const before = data.version;
    if (before === version) continue;
    data.version = version;
    writeJson(f, data);
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
    console.log(`  ${rel}: ${before} -> ${version}`);
    changed++;
  }
  if (changed === 0) {
    console.log(`all workspaces already at ${version} — nothing changed`);
  } else {
    console.log(`bumped ${changed} package(s) to ${version}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exit(0);
  }
  const files = discoverPackageJsons();
  const cmd = argv[0];
  if (cmd === '--check') return checkInSync(files);
  if (cmd === '--show') return printTable(files);
  return bump(files, cmd);
}

main();
