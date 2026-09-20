#!/usr/bin/env bash
#
# W7.3 (QUA-3) — one control count, everywhere.
#
# The library's canonical total is `CONTROL_LIBRARY_COUNT`, derived from the
# controls array. Six other places carried their own literal and had drifted:
# the dashboard said 43, the reports client said 48 (across "14 domains" when
# there are 13), the PRD said "forty-three", and three docs said 43. A client
# could see three different totals for the same library in one session, which
# on a compliance product invites the obvious question about everything else.
#
# This gate fails on any hardcoded control count that disagrees with the
# derived one. Code should import CONTROL_LIBRARY_COUNT; prose should be
# updated when the library version changes.
#
# Some counts legitimately are not the library total — "36 controls are in full
# compliance", "~19 new controls in 0.2.0". Mark those lines `axiom-count-ok`
# with a reason. The marker is deliberately explicit rather than a clever
# regex, because the whole failure mode here was numbers nobody re-checked.
set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'

# The canonical count, read from the library rather than restated here.
CANONICAL=$(node -e "
  const src = require('fs').readFileSync('packages/control-library/src/controls.ts', 'utf8');
  console.log((src.match(/^\s*id: '(DPDPA-[A-Z]+-\d{3})'/gm) || []).length);
")

if [[ -z "$CANONICAL" || "$CANONICAL" == "0" ]]; then
  echo "${RED}✗ Could not determine the control count from the library.${NC}"
  exit 1
fi

echo "Control count consistency gate"
echo "=============================="
echo "Canonical (derived from controls.ts): ${CANONICAL}"
echo

# Any "<number> controls" that is not the canonical number.
mismatches=$(
  grep -rnoE "\b[0-9]{2,3}\s+controls\b" \
    --include='*.ts' --include='*.tsx' --include='*.md' . 2>/dev/null \
  | grep -v node_modules \
  | grep -v '/\.kilo' \
  | grep -v '/\.claude/' \
  | grep -v 'docs/11_Phase0-5_Gap_Closure_Plan.md' \
  | grep -v 'docs/audits/' \
  | grep -vE ":${CANONICAL} controls\$" \
  | while IFS= read -r hit; do
      file="${hit%%:*}"
      rest="${hit#*:}"
      line="${rest%%:*}"
      # The marker may sit on the hit line or on a nearby comment line, since
      # the count is often inside a multi-line string.
      start=$(( line > 4 ? line - 4 : 1 ))
      sed -n "${start},$((line + 4))p" "$file" 2>/dev/null | grep -q 'axiom-count-ok' || echo "$hit"
    done
)

# Spelled-out numbers in prose.
worded=$(
  grep -rnoiE "\b(forty|fifty)[- ](one|two|three|four|five|six|seven|eight|nine)? ?controls?\b" \
    --include='*.md' . 2>/dev/null \
  | grep -v node_modules \
  | grep -v 'docs/11_Phase0-5_Gap_Closure_Plan.md' \
  | grep -viE "forty[- ]six controls" \
  | while IFS= read -r hit; do
      file="${hit%%:*}"
      rest="${hit#*:}"
      line="${rest%%:*}"
      # The marker may sit on the hit line or on a nearby comment line, since
      # the count is often inside a multi-line string.
      start=$(( line > 4 ? line - 4 : 1 ))
      sed -n "${start},$((line + 4))p" "$file" 2>/dev/null | grep -q 'axiom-count-ok' || echo "$hit"
    done
)

failed=0
if [[ -n "$mismatches" ]]; then
  echo "${RED}✗ Hardcoded control counts disagree with the library:${NC}"
  echo "$mismatches" | sed 's/^/    /'
  echo "  ${YELLOW}→ In code, import CONTROL_LIBRARY_COUNT from @axiom/control-library.${NC}"
  echo
  failed=1
fi

if [[ -n "$worded" ]]; then
  echo "${RED}✗ Spelled-out control counts disagree with the library:${NC}"
  echo "$worded" | sed 's/^/    /'
  echo
  failed=1
fi

if [[ $failed -eq 1 ]]; then
  echo "=============================="
  echo "${RED}Control count is inconsistent (QUA-3).${NC}"
  exit 1
fi

echo "${GREEN}✓ Every control count agrees with the library (${CANONICAL}).${NC}"
