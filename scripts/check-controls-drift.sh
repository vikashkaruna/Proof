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

DATA_DIR='services/agent-runtime/src/axiom/data'
GENERATED="$DATA_DIR/controls.json"
SCRATCH="$(mktemp -d -t axiom-controls-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

echo 'Control library TS → runtime JSON drift gate'
echo '============================================'

if [ ! -f "$GENERATED" ]; then
  echo "${RED}✗ $GENERATED is missing.${NC}"
  echo '  The runtime falls back to a single in-code control when it is absent,'
  echo '  which scores an assessment against one control and reports a result.'
  echo '  Generate it: pnpm tsx scripts/build-controls-json.mjs'
  exit 1
fi

# Every known version has its own mirror; old versions must stay byte-identical
# so historical assessments keep verifying against the library they recorded.
if ! VERSIONS=$(pnpm --silent tsx -e "import('./packages/control-library/src/library-versions.ts').then(m=>{for(const v of m.KNOWN_LIBRARY_VERSIONS)console.log(v)})" 2>/dev/null) || [ -z "$VERSIONS" ]; then
  echo "${RED}✗ Could not list the control library versions from TypeScript.${NC}"
  exit 1
fi

DEFAULT_VERSION=$(node -e "console.log(require('./$GENERATED').version)")
STATUS=0
for VERSION in $VERSIONS; do
  if [ "$VERSION" = "$DEFAULT_VERSION" ]; then TARGET="$GENERATED"; else TARGET="$DATA_DIR/controls-$VERSION.json"; fi
  EXPECTED="$SCRATCH/$VERSION.json"
  if ! pnpm tsx scripts/build-controls-json.mjs "$EXPECTED" "$VERSION" >/dev/null 2>&1; then
    echo "${RED}✗ Could not regenerate control library v$VERSION from TypeScript.${NC}"
    pnpm tsx scripts/build-controls-json.mjs "$EXPECTED" "$VERSION"
    exit 1
  fi
  if [ -f "$TARGET" ] && diff -q "$EXPECTED" "$TARGET" >/dev/null 2>&1; then
    COUNT=$(node -e "console.log(require('./$TARGET').controls.length)")
    echo "${GREEN}✓ $TARGET matches the TypeScript source (v${VERSION}, ${COUNT} controls).${NC}"
    continue
  fi
  STATUS=1
  echo "${RED}✗ $TARGET has drifted from its TypeScript source (v$VERSION).${NC}"
  echo
  echo '  The agent runtime would score assessments against stale controls.'
  echo '  Differences (expected = regenerated from TypeScript):'
  echo
  if [ -f "$TARGET" ]; then diff -u "$TARGET" "$EXPECTED" | head -60; else echo "  (missing)"; fi
  echo
  echo '  Fix: pnpm tsx scripts/build-controls-json.mjs'
done
exit "$STATUS"
