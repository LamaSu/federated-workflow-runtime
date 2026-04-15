#!/usr/bin/env bash
# scripts/check-publish-ready.sh
#
# Smoke-test that Chorus workspaces are ready to `npm publish`.
#
# Run locally before tagging a release:
#   bash scripts/check-publish-ready.sh
#
# Also runs in CI before the publish step (.github/workflows/publish-npm.yml).
#
# Checks:
#   1. Every publishable workspace has:
#       - publishConfig.access = public
#       - publishConfig.registry = https://registry.npmjs.org/
#       - publishConfig.provenance = true
#       - repository.url pointing to the Chorus GH repo
#       - keywords (>= 3)
#       - author, license, bugs.url, homepage
#       - prepublishOnly script defined
#       - no "private": true (that would block publish)
#       - files array declared (not empty)
#   2. @chorus/cli has a bin entry and the file exists after build.
#   3. Version synchronization across all workspaces.
#
# Exits 0 on all-green, non-zero with a human-readable reason otherwise.
#
# Constitutional: no npm / pnpm / yarn invoked; just bash + node for JSON.
# Node must be on PATH.

set -euo pipefail

# Resolve repo root from this script's location so cwd doesn't matter.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
RESET=$'\033[0m'

ok=0
warn=0
failcount=0

pass() { printf '  %sOK%s  %s\n' "${GREEN}" "${RESET}" "$1"; ok=$((ok + 1)); }
note() { printf '  %sWARN%s %s\n' "${YELLOW}" "${RESET}" "$1"; warn=$((warn + 1)); }
flag() { printf '  %sFAIL%s %s\n' "${RED}" "${RESET}" "$1"; failcount=$((failcount + 1)); }

# Read a single field from a package.json using `node -e` with readFileSync.
# Usage: field_of <abs-path-to-json> <js-expression-in-var-p>
# Returns empty string (exit 0) if the key is missing/undefined/null.
field_of() {
  local file="$1"
  local expr="$2"
  NODE_JSON_PATH="${file}" NODE_JSON_EXPR="${expr}" node -e "
    const fs = require('fs');
    const file = process.env.NODE_JSON_PATH;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    let v;
    try { v = eval(process.env.NODE_JSON_EXPR); } catch { v = undefined; }
    if (v === undefined || v === null) { process.exit(0); }
    process.stdout.write(typeof v === 'object' ? JSON.stringify(v) : String(v));
  " 2>/dev/null
}

echo "Chorus publish-readiness check"
echo "  root: ${ROOT}"
echo

# Discover publishable workspaces (absolute paths).
mapfile -t PKGS < <(find "${ROOT}/packages" "${ROOT}/integrations" -maxdepth 2 -name package.json -not -path '*/node_modules/*' 2>/dev/null | sort)

if [[ ${#PKGS[@]} -eq 0 ]]; then
  printf '%sFAIL%s no package.json files under packages/ or integrations/\n' "${RED}" "${RESET}"
  exit 1
fi

echo "Found ${#PKGS[@]} workspace(s)."
echo

# ---- 1. Per-workspace field checks ------------------------------------------

ROOT_VERSION="$(field_of "${ROOT}/package.json" 'p.version')"
if [[ -z "${ROOT_VERSION}" ]]; then
  flag "root package.json missing version"
fi

for pkg in "${PKGS[@]}"; do
  name="$(field_of "${pkg}" 'p.name')"
  version="$(field_of "${pkg}" 'p.version')"
  [[ -z "${name}" ]] && name="(unknown)"
  rel="${pkg#${ROOT}/}"
  echo "→ ${name}   (${rel})"

  # Must not be private.
  priv="$(field_of "${pkg}" 'p.private')"
  if [[ "${priv}" == "true" ]]; then
    flag "  \"private\": true — workspace will not publish"
    echo
    continue
  fi

  # publishConfig
  access="$(field_of "${pkg}" 'p.publishConfig && p.publishConfig.access')"
  registry="$(field_of "${pkg}" 'p.publishConfig && p.publishConfig.registry')"
  provenance="$(field_of "${pkg}" 'p.publishConfig && p.publishConfig.provenance')"
  if [[ "${access}" != "public" ]]; then
    flag "  publishConfig.access must be \"public\" (got: '${access}')"
  else
    pass "  publishConfig.access = public"
  fi
  if [[ "${registry}" != "https://registry.npmjs.org/" ]]; then
    flag "  publishConfig.registry must be https://registry.npmjs.org/ (got: '${registry}')"
  else
    pass "  publishConfig.registry = npmjs.org"
  fi
  if [[ "${provenance}" != "true" ]]; then
    flag "  publishConfig.provenance must be true (got: '${provenance}')"
  else
    pass "  publishConfig.provenance = true"
  fi

  # repository
  repo_url="$(field_of "${pkg}" 'p.repository && p.repository.url')"
  if [[ -z "${repo_url}" ]]; then
    flag "  repository.url missing"
  elif [[ "${repo_url}" != *"LamaSu/federated-workflow-runtime"* ]]; then
    note "  repository.url does not point at LamaSu/federated-workflow-runtime (got: ${repo_url})"
  else
    pass "  repository.url correct"
  fi

  # keywords
  kw_count="$(field_of "${pkg}" '(p.keywords || []).length')"
  [[ -z "${kw_count}" ]] && kw_count=0
  if [[ "${kw_count}" -lt 3 ]]; then
    note "  keywords array has only ${kw_count} entr(y|ies); recommend 3+"
  else
    pass "  keywords present (${kw_count})"
  fi

  # author / license
  for fld in author license; do
    val="$(field_of "${pkg}" "p.${fld}")"
    if [[ -z "${val}" ]]; then
      flag "  ${fld} missing"
    else
      pass "  ${fld} = ${val}"
    fi
  done
  bugs_url="$(field_of "${pkg}" 'p.bugs && p.bugs.url')"
  if [[ -z "${bugs_url}" ]]; then
    flag "  bugs.url missing"
  else
    pass "  bugs.url = ${bugs_url}"
  fi
  homepage="$(field_of "${pkg}" 'p.homepage')"
  if [[ -z "${homepage}" ]]; then
    flag "  homepage missing"
  else
    pass "  homepage = ${homepage}"
  fi

  # prepublishOnly
  prepub="$(field_of "${pkg}" 'p.scripts && p.scripts.prepublishOnly')"
  if [[ -z "${prepub}" ]]; then
    note "  scripts.prepublishOnly missing (build+test before publish recommended)"
  else
    pass "  prepublishOnly defined"
  fi

  # files array
  files_len="$(field_of "${pkg}" '(p.files || []).length')"
  [[ -z "${files_len}" ]] && files_len=0
  if [[ "${files_len}" -eq 0 ]]; then
    flag "  files[] is empty or missing — publish would include everything"
  else
    pass "  files[] declared (${files_len} entr(y|ies))"
  fi

  # Version match root
  if [[ -n "${ROOT_VERSION}" ]] && [[ "${version}" != "${ROOT_VERSION}" ]]; then
    flag "  version ${version} != root version ${ROOT_VERSION}"
  else
    pass "  version ${version} matches root"
  fi

  # CLI-specific: bin + shebang + file exists after build
  if [[ "${name}" == "@chorus/cli" ]]; then
    bin_path="$(field_of "${pkg}" 'p.bin && p.bin.chorus')"
    if [[ -z "${bin_path}" ]]; then
      flag "  @chorus/cli must have bin.chorus entry"
    else
      pass "  bin.chorus = ${bin_path}"
      # Resolve relative to package dir.
      pkg_dir="$(dirname "${pkg}")"
      resolved="${pkg_dir}/${bin_path#./}"
      if [[ -f "${resolved}" ]]; then
        pass "  bin target exists: ${resolved}"
        first_line="$(head -n 1 "${resolved}")"
        if [[ "${first_line}" == "#!/usr/bin/env node" ]]; then
          pass "  bin shebang correct: #!/usr/bin/env node"
        else
          flag "  bin shebang wrong — got: '${first_line}'"
        fi
      else
        note "  bin target not built yet: ${resolved} (run npm run build)"
      fi
    fi

    src_cli="${ROOT}/packages/cli/src/cli.ts"
    if [[ -f "${src_cli}" ]]; then
      first_line="$(head -n 1 "${src_cli}")"
      if [[ "${first_line}" == "#!/usr/bin/env node" ]]; then
        pass "  src/cli.ts shebang correct"
      else
        flag "  src/cli.ts must start with #!/usr/bin/env node — got: '${first_line}'"
      fi
    fi
  fi

  echo
done

# ---- 2. Root-level check: root package.json must be private: true -----------

root_private="$(field_of "${ROOT}/package.json" 'p.private')"
if [[ "${root_private}" != "true" ]]; then
  note "root package.json should have \"private\": true (it's the workspace host, not a publishable package)"
else
  pass "root package.json is private (good)"
fi

# ---- Summary ----------------------------------------------------------------

echo "────────────────────────────────────────"
printf '  %sOK%s   %d\n' "${GREEN}" "${RESET}" "${ok}"
printf '  %sWARN%s %d\n' "${YELLOW}" "${RESET}" "${warn}"
printf '  %sFAIL%s %d\n' "${RED}" "${RESET}" "${failcount}"
echo

if [[ ${failcount} -gt 0 ]]; then
  echo "publish-readiness: FAIL"
  exit 1
fi

if [[ ${warn} -gt 0 ]]; then
  echo "publish-readiness: PASS with ${warn} warning(s)"
  exit 0
fi

echo "publish-readiness: PASS"
exit 0
