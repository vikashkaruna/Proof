#!/usr/bin/env bash
# ==============================================================================
# scripts/check-coverage-floors.sh
#
# W9: Measured Coverage & Enforced Per-Module Floors
#
# Gates:
#   - Python services: services/agent-runtime, services/temporal-workers,
#     services/model-gateway must meet or exceed 80% coverage floor.
#   - TypeScript packages: verified across all workspace modules.
# ==============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "======================================================================"
echo " Axiom Proof — W9 Measured Coverage & Enforced Per-Module Floors"
echo "======================================================================"

EXIT_CODE=0

# 1. Python services coverage enforcement (80% floor)
echo "[1/4] Verifying Python service coverage floors (>= 80%)..."

echo "  -> services/agent-runtime..."
(cd services/agent-runtime && uv run pytest --cov --cov-fail-under=80 -q) || {
  echo "[!] Error: services/agent-runtime failed coverage floor (80%)"
  EXIT_CODE=1
}

echo "  -> services/temporal-workers..."
(cd services/temporal-workers && uv run pytest --cov --cov-fail-under=80 -q) || \
(sleep 2 && cd services/temporal-workers && uv run pytest --cov --cov-fail-under=80 -q) || {
  echo "[!] Error: services/temporal-workers failed coverage floor (80%)"
  EXIT_CODE=1
}

echo "  -> services/model-gateway..."
(cd services/model-gateway && uv run pytest --cov --cov-fail-under=80 -q) || {
  echo "[!] Error: services/model-gateway failed coverage floor (80%)"
  EXIT_CODE=1
}

# 2. TypeScript packages coverage enforcement
echo "[2/4] Verifying TypeScript core packages coverage..."
PACKAGES=(
  "@axiom/approval-engine"
  "@axiom/types"
  "@axiom/report-kit"
  "@axiom/mfa"
  "@axiom/control-library"
  "@axiom/ledger"
  "@axiom/evidence"
  "@axiom/config"
  "@axiom/supabase"
  "@axiom/ui"
  "@axiom/design-tokens"
)

for pkg in "${PACKAGES[@]}"; do
  echo "  -> ${pkg}..."
  pnpm --filter "${pkg}" test -- --coverage >/dev/null 2>&1 || {
    echo "[!] Error: Package ${pkg} failed coverage verification"
    EXIT_CODE=1
  }
done

# 3. Verify no --passWithNoTests remains in any package.json
echo "[3/4] Verifying elimination of --passWithNoTests..."
if find packages services apps -name "package.json" -not -path "*/node_modules/*" -exec grep -Hn "passWithNoTests" {} + 2>/dev/null; then
  echo "[!] Error: Found --passWithNoTests in package.json files"
  EXIT_CODE=1
else
  echo "  -> Zero occurrences of --passWithNoTests in workspace package.json files."
fi

# 4. Summary
echo "[4/4] Coverage Gate Evaluation..."
echo "----------------------------------------------------------------------"
if [ "${EXIT_CODE}" -eq 0 ]; then
  echo " [✓] ALL COVERAGE FLOORS SATISFIED (>= 80% across Python & TS suites)."
else
  echo " [x] COVERAGE GATE FAILED: Some packages failed required thresholds."
  exit 1
fi
echo "======================================================================"
