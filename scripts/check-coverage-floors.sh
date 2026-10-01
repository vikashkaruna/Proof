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
TS_ONLY=false
if [ "${1:-}" = '--typescript' ]; then
  TS_ONLY=true
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--typescript]" >&2
  exit 2
fi

echo "======================================================================"
echo " Axiom Proof — W9 Measured Coverage & Enforced Per-Module Floors"
echo "======================================================================"

EXIT_CODE=0

# 1. Python services coverage enforcement (80% floor)
if [ "$TS_ONLY" = false ]; then
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
fi

# 2. Measure all source lines in each TypeScript app, service and package.
# Vitest otherwise includes only files imported by tests, which makes a
# pass-only coverage invocation misleading for untested modules.
echo "[2/4] Verifying TypeScript module line coverage (>= 80%)..."
MODULES=(
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
  "@axiom/bff"
  "@axiom/web"
  "@axiom/marketing"
)

# Fail when a new source-bearing workspace has no explicit floor. This also
# catches stale names in the list before a missing --filter silently passes.
node - "${MODULES[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const expected = new Set(process.argv.slice(2));
const actual = new Set();
for (const parent of ['apps', 'packages', 'services']) {
  for (const item of fs.readdirSync(parent, { withFileTypes: true })) {
    const dir = path.join(parent, item.name);
    if (!item.isDirectory() || !fs.existsSync(path.join(dir, 'package.json')) ||
        !fs.existsSync(path.join(dir, 'src'))) continue;
    actual.add(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name);
  }
}
const missing = [...actual].filter((name) => !expected.has(name));
const stale = [...expected].filter((name) => !actual.has(name));
if (missing.length || stale.length || expected.size !== process.argv.length - 2) {
  console.error('Coverage module inventory mismatch:', { missing, stale });
  process.exit(1);
}
NODE

for module in "${MODULES[@]}"; do
  echo "  -> ${module}..."
  output="$(mktemp)"
  if pnpm --filter "${module}" exec vitest run \
    --coverage --coverage.provider=v8 \
    --coverage.include='src/**/*.{ts,tsx}' \
    --coverage.thresholds.lines=80 \
    --coverage.reporter=text >"${output}" 2>&1; then
    grep -E '^Lines[[:space:]]*:' "${output}" | tail -n 1
  else
    echo "[!] ${module} did not meet the 80% source-line floor or its tests failed"
    tail -n 24 "${output}"
    EXIT_CODE=1
  fi
  rm -f "${output}"
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
  echo " [✓] ALL MEASURED COVERAGE FLOORS SATISFIED (>= 80% per module)."
else
  echo " [x] COVERAGE GATE FAILED: Some packages failed required thresholds."
  exit 1
fi
echo "======================================================================"
