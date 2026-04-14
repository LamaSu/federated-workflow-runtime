#!/usr/bin/env bash
#
# publish-revocation.sh — sign `revoked.json` with Ed25519 and upload to a CDN path.
#
# Covers the fallback signing path documented in ARCHITECTURE.md §5.3; the primary
# path is Sigstore keyless (handled by publish-revocation.yml). This script is used:
#   - during initial bootstrap (before GH Actions is wired up)
#   - in CI alongside Sigstore (so clients that only trust Ed25519 can verify)
#   - by operators running manual emergency publishes
#
# Usage:
#   publish-revocation.sh \
#       [--file revoked.json] \
#       [--bucket $CDN_BUCKET] \
#       [--endpoint $CDN_ENDPOINT_URL] \
#       [--public-url $CDN_PUBLIC_URL] \
#       [--key-file path/to/ed25519.json] \
#       [--out revoked.sig.json] \
#       [--dry-run]
#
# Signature payload: the canonical JSON of revoked.json (sorted keys, compact).
# Signature format: Ed25519 over SHA-256 of canonical JSON.
# Output `revoked.sig.json` shape:
#   {
#     "payloadSha256": "<hex>",
#     "signatureBase64": "<base64>",
#     "signerId": "<id from key file>",
#     "signedAt": "<ISO>"
#   }
#
# Required tooling: bash >= 4, jq, openssl, coreutils, aws-cli (unless --dry-run).
# macOS + Linux compatible — no GNU-specific flags.

set -euo pipefail

# ── arg parsing ──────────────────────────────────────────────────────────────

FILE="revoked.json"
BUCKET="${CDN_BUCKET:-}"
ENDPOINT="${CDN_ENDPOINT_URL:-}"
PUBLIC_URL="${CDN_PUBLIC_URL:-}"
KEY_FILE=""
OUT_FILE="revoked.sig.json"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)        FILE="$2"; shift 2 ;;
    --bucket)      BUCKET="$2"; shift 2 ;;
    --endpoint)    ENDPOINT="$2"; shift 2 ;;
    --public-url)  PUBLIC_URL="$2"; shift 2 ;;
    --key-file)    KEY_FILE="$2"; shift 2 ;;
    --out)         OUT_FILE="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

# ── preflight ────────────────────────────────────────────────────────────────

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: missing tool $1" >&2; exit 2; }; }
need jq
need openssl
need awk
# sha256sum (Linux) / shasum (macOS) — at least one must exist.
command -v sha256sum >/dev/null 2>&1 \
  || command -v shasum >/dev/null 2>&1 \
  || { echo "error: need sha256sum or shasum" >&2; exit 2; }

sha256_hex() {
  # Read from stdin, emit hex digest only.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    echo "error: need sha256sum or shasum" >&2
    return 2
  fi
}

[[ -f "$FILE" ]] || { echo "error: $FILE not found" >&2; exit 2; }
jq -e '.' "$FILE" >/dev/null || { echo "error: $FILE is not valid JSON" >&2; exit 2; }
jq -e '.schemaVersion == "1.0.0"' "$FILE" >/dev/null \
  || { echo "error: $FILE schemaVersion must be 1.0.0" >&2; exit 2; }

# ── canonicalize + hash ──────────────────────────────────────────────────────

echo ">> canonicalizing $FILE"
CANON="$(mktemp)"
# Canonical = sort keys recursively, compact. Exclude any existing top-level
# `signature` field so re-signing is idempotent.
jq --sort-keys 'del(.signature)' "$FILE" > "$CANON"
HEX="$(sha256_hex < "$CANON")"
echo "   payloadSha256=$HEX"

# ── sign ─────────────────────────────────────────────────────────────────────

SIG_B64=""
SIGNER_ID=""

# Prefer env-provided signing key; fall back to --key-file.
if [[ -n "${CHORUS_REVOCATION_SIGNING_KEY:-}" ]]; then
  # Key material comes as base64-encoded 32-byte Ed25519 seed in the env var.
  echo ">> signing with env CHORUS_REVOCATION_SIGNING_KEY"
  RAW_SEED="$(printf '%s' "$CHORUS_REVOCATION_SIGNING_KEY" | base64 -d 2>/dev/null || true)"
  if [[ -z "$RAW_SEED" ]] || [[ "$(printf '%s' "$RAW_SEED" | wc -c | tr -d ' ')" -ne 32 ]]; then
    echo "error: CHORUS_REVOCATION_SIGNING_KEY must be base64(32 bytes)" >&2
    exit 2
  fi
  PEM="$(mktemp)"
  trap 'rm -f "$PEM"' EXIT
  # Assemble a PKCS8 Ed25519 private key from the raw seed.
  # RFC 8410: OID 1.3.101.112, wrapped in OCTET STRING inside PrivateKeyInfo.
  # openssl ≥ 3.0 accepts `-algorithm ed25519 -in <seed-hex>` via `pkey`, but the
  # cleanest portable path is to hand it PKCS8 DER.
  {
    # PKCS8 header bytes for Ed25519 private key (hex): 302e020100300506032b657004220420
    printf '302e020100300506032b657004220420'
    printf '%s' "$RAW_SEED" | od -An -tx1 | tr -d ' \n'
  } | xxd -r -p > "$PEM.der"
  openssl pkey -inform DER -in "$PEM.der" -out "$PEM" 2>/dev/null \
    || { echo "error: openssl failed to load Ed25519 key"; rm -f "$PEM.der"; exit 2; }
  rm -f "$PEM.der"

  SIG_FILE="$(mktemp)"
  openssl pkeyutl -sign -rawin -inkey "$PEM" -in "$CANON" -out "$SIG_FILE"
  SIG_B64="$(base64 < "$SIG_FILE" | tr -d '\n')"
  rm -f "$SIG_FILE"
  SIGNER_ID="env:CHORUS_REVOCATION_SIGNING_KEY"
elif [[ -n "$KEY_FILE" ]]; then
  echo ">> signing with $KEY_FILE"
  [[ -f "$KEY_FILE" ]] || { echo "error: key file $KEY_FILE not found" >&2; exit 2; }

  PRIV_B64="$(jq -r '.privateKey' "$KEY_FILE")"
  SIGNER_ID="$(jq -r '.id // .publicKey[0:16]' "$KEY_FILE")"

  if [[ -z "$PRIV_B64" || "$PRIV_B64" == "null" ]]; then
    echo "error: key file missing .privateKey" >&2
    exit 2
  fi

  RAW_SEED="$(printf '%s' "$PRIV_B64" | base64 -d 2>/dev/null || true)"
  if [[ -z "$RAW_SEED" ]] || [[ "$(printf '%s' "$RAW_SEED" | wc -c | tr -d ' ')" -ne 32 ]]; then
    echo "error: $KEY_FILE .privateKey must be base64(32 bytes)" >&2
    exit 2
  fi

  PEM="$(mktemp)"
  trap 'rm -f "$PEM"' EXIT
  {
    printf '302e020100300506032b657004220420'
    printf '%s' "$RAW_SEED" | od -An -tx1 | tr -d ' \n'
  } | xxd -r -p > "$PEM.der"
  openssl pkey -inform DER -in "$PEM.der" -out "$PEM" 2>/dev/null \
    || { echo "error: openssl failed to load Ed25519 key"; rm -f "$PEM.der"; exit 2; }
  rm -f "$PEM.der"

  SIG_FILE="$(mktemp)"
  openssl pkeyutl -sign -rawin -inkey "$PEM" -in "$CANON" -out "$SIG_FILE"
  SIG_B64="$(base64 < "$SIG_FILE" | tr -d '\n')"
  rm -f "$SIG_FILE"
else
  echo "error: no signing key (set CHORUS_REVOCATION_SIGNING_KEY env or pass --key-file)" >&2
  exit 2
fi

# ── emit signature bundle ────────────────────────────────────────────────────

SIGNED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
jq -n \
  --arg hex "$HEX" \
  --arg sig "$SIG_B64" \
  --arg signer "$SIGNER_ID" \
  --arg at "$SIGNED_AT" \
  '{payloadSha256: $hex, signatureBase64: $sig, signerId: $signer, signedAt: $at}' \
  > "$OUT_FILE"
echo ">> wrote signature bundle to $OUT_FILE"

# ── upload ───────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ">> DRY RUN — skipping upload."
  echo "   revoked.json:    $(wc -c < "$FILE" | tr -d ' ') bytes"
  echo "   $OUT_FILE:       $(wc -c < "$OUT_FILE" | tr -d ' ') bytes"
  exit 0
fi

if [[ -z "$BUCKET" ]]; then
  echo "error: no --bucket provided and CDN_BUCKET not set" >&2
  exit 2
fi
need aws

EXTRA=()
if [[ -n "$ENDPOINT" ]]; then
  EXTRA+=(--endpoint-url "$ENDPOINT")
fi

echo ">> uploading $FILE → $BUCKET/revoked.json"
aws s3 cp "$FILE" "$BUCKET/revoked.json" \
  --cache-control "public, max-age=60, must-revalidate" \
  --content-type "application/json" \
  "${EXTRA[@]}"

echo ">> uploading $OUT_FILE → $BUCKET/revoked.sig.json"
aws s3 cp "$OUT_FILE" "$BUCKET/revoked.sig.json" \
  --cache-control "public, max-age=60, must-revalidate" \
  --content-type "application/json" \
  "${EXTRA[@]}"

if [[ -n "$PUBLIC_URL" ]]; then
  echo ">> verifying download from $PUBLIC_URL/revoked.json"
  curl -fsSL --retry 3 --max-time 30 "$PUBLIC_URL/revoked.json" > /dev/null
  echo ">> verifying download from $PUBLIC_URL/revoked.sig.json"
  curl -fsSL --retry 3 --max-time 30 "$PUBLIC_URL/revoked.sig.json" > /dev/null
  echo ">> OK"
fi
