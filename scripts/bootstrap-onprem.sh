#!/usr/bin/env bash
# ==============================================================================
# scripts/bootstrap-onprem.sh
#
# Axiom Proof — Sovereign On-Premise & Air-Gapped Bootstrap Automation (W10)
#
# Checks:
#   1. Pre-flight verification (Docker daemon)
#   2. Sovereign environment configuration (.env.onprem)
#   3. Pre-issued offline license validation
#   4. Checksummed append-only database migrations
#   5. Control-library seeding; demo identities only by explicit opt-in
# This does not provision or validate the full on-premises stack.
# ==============================================================================

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "======================================================================"
echo " Axiom Proof — Sovereign On-Premise Bootstrap (W10)"
echo "======================================================================"

# 1. Pre-flight checks
echo "[1/6] Running sovereign pre-flight verification..."
if ! command -v docker >/dev/null 2>&1; then
  echo "[-] Error: docker is not installed or not in PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[-] Error: Docker daemon is not running."
  exit 1
fi
echo "  -> Docker daemon is operational."

# 2. Sovereign Environment Configuration (.env.onprem)
echo "[2/6] Verifying sovereign configuration (.env.onprem)..."
ENV_FILE="infra/docker/environments/.env.onprem"
if [ ! -f "${ENV_FILE}" ]; then
  echo "  -> Copying ${ENV_FILE}.example to ${ENV_FILE}..."
  cp "${ENV_FILE}.example" "${ENV_FILE}"
fi

# Ensure secrets are minted if placeholders remain
MINT_SCRIPT="scripts/mint-supabase-keys.mjs"
if [ -f "${MINT_SCRIPT}" ]; then
  echo "  -> Verifying minted cryptographic keys in ${ENV_FILE}..."
  # If placeholder keys are found, generate real cryptographic keys
  if grep -q "<64 hex chars" "${ENV_FILE}" 2>/dev/null || grep -q "<48 hex chars" "${ENV_FILE}" 2>/dev/null; then
    echo "  -> Generating sovereign cryptographic keys..."
    SIGNING_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    MFA_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    RUNTIME_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    GATEWAY_KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")

    sed -i.bak -e "s/<64 hex chars — approval signing key>/${SIGNING_KEY}/g" "${ENV_FILE}"
    sed -i.bak -e "s/<64 hex chars — distinct MFA encryption key>/${MFA_KEY}/g" "${ENV_FILE}"
    sed -i.bak -e "s/<48 hex chars — internal runtime token>/${RUNTIME_TOKEN}/g" "${ENV_FILE}"
    sed -i.bak -e "s/<48 hex chars — model gateway key>/${GATEWAY_KEY}/g" "${ENV_FILE}"
    rm -f "${ENV_FILE}.bak"
    echo "  -> Cryptographic keys injected into ${ENV_FILE}."
  fi
fi

# 3. Cryptographic Offline License Token
echo "[3/6] Verifying offline cryptographic sovereign license..."
read_env_value() {
  local name="$1"
  local matches
  matches=$(grep -c "^${name}=" "${ENV_FILE}" || true)
  if [ "${matches}" -ne 1 ]; then
    echo "[x] ${name} must occur exactly once in ${ENV_FILE}." >&2
    exit 1
  fi
  sed -n "s/^${name}=//p" "${ENV_FILE}"
}

CURRENT_LICENSE=$(read_env_value AXIOM_OFFLINE_LICENSE)
if [ -z "${CURRENT_LICENSE}" ]; then
  echo "[x] A pre-issued offline license is required." >&2
  exit 1
fi
if ! AXIOM_OFFLINE_LICENSE="${CURRENT_LICENSE}" pnpm tsx scripts/verify-license.ts >/dev/null 2>&1; then
  echo "[x] Offline license verification failed." >&2
  exit 1
fi
echo "  -> Offline license verified."

# 4. Database migrations
echo "[4/6] Applying checksummed database migrations..."
SUPABASE_DB_URL="${SUPABASE_DB_URL:-$(read_env_value SUPABASE_DB_URL)}"
SUPABASE_URL="${SUPABASE_URL:-$(read_env_value SUPABASE_URL)}"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:-$(read_env_value SUPABASE_SERVICE_KEY)}"
if [ -z "${SUPABASE_DB_URL}" ] || [ -z "${SUPABASE_URL}" ] || [ -z "${SUPABASE_SERVICE_KEY}" ]; then
  echo "[x] Database URL, Supabase URL and service key are required." >&2
  exit 1
fi
export SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_KEY
if ! python3 scripts/migrate-database.py --dsn "${SUPABASE_DB_URL}" >/dev/null; then
  echo "[x] Database migration failed." >&2
  exit 1
fi
echo "  -> Database migrations applied or verified by checksum."

# 5. Seeding
echo "[5/6] Seeding control library..."
if ! pnpm seed:controls >/dev/null; then
  echo "[x] Control-library seed failed." >&2
  exit 1
fi
echo "  -> Control-library seed completed."

# The shared seed:users command installs known demo passwords and resets them
# when rerun. It must never run as an implicit production bootstrap step.
if [ "${AXIOM_ONPREM_SEED_DEMO_USERS:-0}" = "1" ]; then
  if ! pnpm seed:users >/dev/null; then
    echo "[x] Demo-user seed failed." >&2
    exit 1
  fi
  echo "  -> Demo-user seed completed; rotate its credentials before use."
fi

# 6. Summary
echo "[6/6] Sovereign Bootstrap Assessment..."
echo "----------------------------------------------------------------------"
echo " [✓] BOOTSTRAP CHECKS PASSED"
echo " License, migrations and requested seed commands completed."
echo " Verify the deployment, Object Lock and service health separately."
echo "======================================================================"
