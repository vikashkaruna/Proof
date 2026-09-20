#!/usr/bin/env bash
#
# W7 (R-06) — the runtime scores against the citations we published.
#
# `packages/control-library/src/controls.ts` is the source of truth;
# `services/agent-runtime/src/axiom/data/controls.json` is a generated copy
# that Parikshan loads through `load_default_library()`. Nothing connected
# them, so W7.1's citation correction landed in TypeScript, passed its tests,
# and never reached the agent that actually scores an assessment.
#
# The gap was invisible for a specific reason: the control-count gate compared
# totals, and both sides had 46 controls the whole time. What differed was
# which rule each control cited. A client report would have named Rule 16, 17
# or 20 for obligations the Gazette puts at Rule 14 and Rule 7 — a compliance
# product citing provisions that do not say what the control claims.
#
# So this gate compares the bytes, not a summary of them. Regenerate with:
#   pnpm tsx scripts/build-controls-json.mjs
set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'

GENERATED='services/agent-runtime/src/axiom/data/controls.json'
EXPECTED="$(mktemp -t axiom-controls-XXXXXX.json)"
trap 'rm -f "$EXPECTED"' EXIT

echo 'Control library TS → runtime JSON drift gate'
echo '============================================'

if [ ! -f "$GENERATED" ]; then
  echo "${RED}✗ $GENERATED is missing.${NC}"
  echo '  The runtime falls back to a single in-code control when it is absent,'
  echo '  which scores an assessment against one control and reports a result.'
  echo '  Generate it: pnpm tsx scripts/build-controls-json.mjs'
  exit 1
fi

if ! pnpm tsx scripts/build-controls-json.mjs "$EXPECTED" >/dev/null 2>&1; then
  echo "${RED}✗ Could not regenerate the control library from TypeScript.${NC}"
  pnpm tsx scripts/build-controls-json.mjs "$EXPECTED"
  exit 1
fi

if diff -q "$EXPECTED" "$GENERATED" >/dev/null 2>&1; then
  VERSION=$(node -e "console.log(require('./$GENERATED').version)")
  COUNT=$(node -e "console.log(require('./$GENERATED').controls.length)")
  echo "${GREEN}✓ Runtime library matches the TypeScript source (v${VERSION}, ${COUNT} controls).${NC}"
  exit 0
fi

echo "${RED}✗ The runtime control library has drifted from its TypeScript source.${NC}"
echo
echo '  The agent runtime would score assessments against stale controls.'
echo '  Differences (expected = regenerated from TypeScript):'
echo
diff -u "$GENERATED" "$EXPECTED" | head -60
echo
echo '  Fix: pnpm tsx scripts/build-controls-json.mjs'
exit 1
