#!/usr/bin/env bash
# standup-registry.sh
#
# Creates LamaSu/chorus-registry as a PUBLIC GitHub repo and pushes the
# contents of federation/registry-template/ as the initial commit.
#
# This is a one-shot bootstrapper. It is NEVER auto-invoked by /go or any
# other pipeline — a human has to type it by hand. Rationale: standing up a
# signed federation registry is a deliberate decision; we don't want an agent
# doing it because something looked like a standup task.
#
# Prereqs:
#   1. gh CLI authenticated as LamaSu (verify with `gh auth status`).
#   2. The git working tree has `federation/registry-template/` populated,
#      including `.github/workflows/` (4 YAML files) and a non-empty
#      `trusted-signers.json`.
#   3. You have run this script's companion docs in `federation/STANDUP.md`
#      and understand what you're about to publish.
#
# Safety rails:
#   - Refuses to run unless CONFIRM=1 is in the environment.
#   - Refuses to clobber an existing LamaSu/chorus-registry repo; bail out
#     and let the operator decide (fork / delete / rename).
#   - Uses a temporary working directory so the caller's working tree is
#     never touched.
#
# Exit codes:
#   0   — success, repo exists + initial commit pushed + Actions enabled
#   1   — generic failure
#   2   — preflight check failed (missing deps or template)
#   3   — repo already exists; operator must resolve
#   4   — user bailed at the confirmation prompt

set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────
OWNER="LamaSu"
REPO_NAME="chorus-registry"
FULL_REPO="${OWNER}/${REPO_NAME}"
DEFAULT_BRANCH="main"
REPO_DESCRIPTION="Federated patch registry for the Chorus workflow runtime"
REPO_VISIBILITY="public"

# Resolve the chorus repo root relative to this script, so the operator can
# invoke the script from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHORUS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_DIR="${CHORUS_ROOT}/federation/registry-template"

# ── helpers ───────────────────────────────────────────────────────────────────
log()  { printf '\e[36m[standup]\e[0m %s\n' "$*"; }
warn() { printf '\e[33m[standup]\e[0m %s\n' "$*" >&2; }
die()  { printf '\e[31m[standup]\e[0m %s\n' "$*" >&2; exit "${2:-1}"; }

# ── preflight ─────────────────────────────────────────────────────────────────
preflight() {
  log "preflight: checking prerequisites"

  command -v gh  >/dev/null 2>&1 || die "gh CLI not found on PATH" 2
  command -v git >/dev/null 2>&1 || die "git not found on PATH" 2

  # gh must be authenticated AND the active account must be able to create
  # repos under ${OWNER}. `gh api user` is authoritative: it hits the GitHub
  # API with whatever token is active and returns the login. We don't grep
  # `gh auth status` because that command's exit code isn't reliable when
  # auxiliary accounts have stale tokens (and it exits non-zero even when
  # the active account is healthy).
  local active_login
  if ! active_login="$(gh api user --jq .login 2>/dev/null)"; then
    die "gh CLI not authenticated. Run: gh auth login" 2
  fi
  if [[ "${active_login}" != "${OWNER}" ]]; then
    die "gh active account is '${active_login}', expected '${OWNER}'. Run: gh auth switch -u ${OWNER}" 2
  fi

  [[ -d "${TEMPLATE_DIR}" ]] || die "template dir missing: ${TEMPLATE_DIR}" 2
  [[ -f "${TEMPLATE_DIR}/README.md" ]] || die "template README missing: ${TEMPLATE_DIR}/README.md" 2
  [[ -f "${TEMPLATE_DIR}/LICENSE"   ]] || die "template LICENSE missing: ${TEMPLATE_DIR}/LICENSE" 2
  [[ -f "${TEMPLATE_DIR}/trusted-signers.json" ]] || die "trusted-signers.json missing" 2
  [[ -f "${TEMPLATE_DIR}/revoked.json" ]] || die "revoked.json missing" 2

  # Every workflow file must be present.
  local wf_dir="${TEMPLATE_DIR}/.github/workflows"
  for wf in sign-patch.yml canary-promote.yml publish-revocation.yml abort-on-spike.yml; do
    [[ -f "${wf_dir}/${wf}" ]] || die "workflow missing: ${wf_dir}/${wf}" 2
  done

  # trusted-signers.json must have at least one signer — otherwise the registry
  # starts with an empty trust set and will refuse every patch.
  local signer_count
  signer_count="$(python -c "import json,sys; print(len(json.load(open(sys.argv[1]))['signers']))" "${TEMPLATE_DIR}/trusted-signers.json" 2>/dev/null || echo 0)"
  if [[ "${signer_count}" -lt 1 ]]; then
    die "trusted-signers.json has 0 signers — seed at least one before standup" 2
  fi

  # Refuse to clobber an existing repo. Let the operator handle it.
  if gh repo view "${FULL_REPO}" >/dev/null 2>&1; then
    die "repo ${FULL_REPO} already exists. Delete or rename before rerunning." 3
  fi

  log "preflight: OK (template=${TEMPLATE_DIR}, signers=${signer_count})"
}

# ── confirmation ──────────────────────────────────────────────────────────────
confirm() {
  if [[ "${CONFIRM:-0}" != "1" ]]; then
    cat >&2 <<EOF

This script will:
  * Create PUBLIC repo:    ${FULL_REPO}
  * Default branch:        ${DEFAULT_BRANCH}
  * Description:           ${REPO_DESCRIPTION}
  * Push initial commit from: ${TEMPLATE_DIR}
  * Enable Actions on the new repo

Re-run with CONFIRM=1 to proceed. Example:

    CONFIRM=1 bash scripts/standup-registry.sh

EOF
    exit 4
  fi
}

# ── standup ───────────────────────────────────────────────────────────────────
standup() {
  local work_dir
  work_dir="$(mktemp -d -t chorus-registry-XXXXXXXX)"
  log "working dir: ${work_dir}"

  log "copying template into working dir"
  # Use cp -a so we preserve .github/ and hidden files. Trailing /. on the
  # source copies *contents* (not the template dir itself).
  cp -a "${TEMPLATE_DIR}/." "${work_dir}/"

  (
    cd "${work_dir}"

    log "initializing git repo"
    git init --quiet --initial-branch="${DEFAULT_BRANCH}"
    git add .
    git -c "user.name=LamaSu" -c "user.email=lamasu@chorus.dev" \
        commit --quiet -m "initial: import chorus registry template"

    log "creating remote repo ${FULL_REPO}"
    gh repo create "${FULL_REPO}" \
      --"${REPO_VISIBILITY}" \
      --description "${REPO_DESCRIPTION}" \
      --source=. \
      --remote=origin \
      --push

    log "enabling Actions"
    # gh doesn't expose workflow enable/disable directly at the repo level,
    # but Actions is ON by default for new repos. We set workflow permissions
    # to read+write so canary-promote / abort-on-spike can push to main.
    gh api \
      --method PUT \
      -H "Accept: application/vnd.github+json" \
      "/repos/${FULL_REPO}/actions/permissions" \
      -f enabled=true \
      -f allowed_actions=all \
      >/dev/null

    gh api \
      --method PUT \
      -H "Accept: application/vnd.github+json" \
      "/repos/${FULL_REPO}/actions/permissions/workflow" \
      -f default_workflow_permissions=write \
      -f can_approve_pull_request_reviews=true \
      >/dev/null
  )

  log "cleanup: removing working dir"
  rm -rf "${work_dir}"
}

# ── post-flight summary ───────────────────────────────────────────────────────
summary() {
  local base="https://github.com/${FULL_REPO}"
  local wf="${base}/actions/workflows"

  cat <<EOF

╭──────────────────────────────────────────────────────────────────────────╮
│ Registry standup: DONE                                                   │
╰──────────────────────────────────────────────────────────────────────────╯

Repo URL:                ${base}
Trusted signers:         ${base}/blob/${DEFAULT_BRANCH}/trusted-signers.json
Revocation list:         ${base}/blob/${DEFAULT_BRANCH}/revoked.json

Workflows (inspect each before going live):
  sign-patch              ${wf}/sign-patch.yml
  canary-promote          ${wf}/canary-promote.yml
  publish-revocation      ${wf}/publish-revocation.yml
  abort-on-spike          ${wf}/abort-on-spike.yml

Next steps (see federation/STANDUP.md):
  1. Set up the R2 / S3 bucket and add secrets to the repo.
  2. Replace placeholder handles in CODEOWNERS.
  3. Enable branch protection on ${DEFAULT_BRANCH}.
  4. Run: gh run list --repo ${FULL_REPO}
EOF
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  preflight
  confirm
  standup
  summary
}

main "$@"
