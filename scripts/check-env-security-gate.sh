#!/usr/bin/env bash
#
# W0.0 CI gate — "one codebase, one ruleset".
#
# The root cause of SEC-1, SEC-2, SEC-3 and SEC-13 was that environment
# identity was used as a proxy for security posture: nine independent sites
# each invented their own `ENVIRONMENT === 'preprod' || NODE_ENV !== 'production'`
# OR-chain, and the effective posture became the union of all of them.
#
# This gate makes that pattern un-reintroducible. It fails the build on:
#
#   1. Any security decision keyed on ENVIRONMENT / NODE_ENV.
#      The ONLY sanctioned switch is `resolveAuthMode()` from @axiom/config,
#      which is refused at boot outside local/test.
#   2. The `axiom_e2e_bypass` cookie, which was a complete unauthenticated
#      founder-owner takeover chain (SEC-2).
#   3. `createSupabaseAdmin()` inside apps/web (SEC-3) — the service-role key
#      bypasses RLS, which is how 17 pages leaked across tenants.
#
# Topology references (routing to the right host, naming a bucket, picking a
# GCP project) are legitimate and are allowlisted by path below. The
# distinction is exactly the W0.0 table: topology may vary by environment,
# the security ruleset may not.
set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'
failures=0

# Paths where an ENVIRONMENT comparison is topology, not security posture.
# Each entry needs a justification comment. Keep this list short.
TOPOLOGY_ALLOWLIST=(
  'apps/marketing/src/lib/url-resolver.ts'   # resolves the public base URL per environment
  'packages/config/src/index.ts'             # defines the ruleset; the one place allowed to read ENVIRONMENT
)

is_allowlisted() {
  local file="$1"
  for allowed in "${TOPOLOGY_ALLOWLIST[@]}"; do
    [[ "$file" == "$allowed" ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
report() {
  local title="$1"; shift
  local remedy="$1"; shift
  local hits="$1"
  if [[ -n "$hits" ]]; then
    echo "${RED}✗ ${title}${NC}"
    echo "$hits" | sed 's/^/    /'
    echo "  ${YELLOW}→ ${remedy}${NC}"
    echo
    failures=$((failures + 1))
  else
    echo "${GREEN}✓ ${title}${NC}"
  fi
}

# Matches code only. Comment lines are excluded deliberately: each deleted
# branch leaves behind a comment explaining what used to be there and why it
# was dangerous, and that documentation is the point — it is what stops the
# pattern being reintroduced by someone who does not know the history.
scan() {
  grep -rnE "$1" apps packages services \
    --include='*.ts' --include='*.tsx' \
    2>/dev/null \
  | grep -v node_modules \
  | grep -v '\.test\.ts' \
  | grep -v '\.spec\.ts' \
  | grep -v '/test/' \
  | grep -vE '^[^:]+:[0-9]+: *(//|\*|/\*)' \
  | while IFS= read -r line; do
      file="${line%%:*}"
      is_allowlisted "$file" || echo "$line"
    done
}

echo "W0.0 environment/security separation gate"
echo "========================================="
echo

report "No security decision keyed on ENVIRONMENT" \
  "Use resolveAuthMode() from @axiom/config. Environment determines topology only." \
  "$(scan "(process\.env\.|env\.)ENVIRONMENT\s*===\s*['\"](preprod|staging|production|development|local|onprem)['\"]")"

report "No security decision keyed on NODE_ENV" \
  "Use resolveAuthMode() from @axiom/config. NODE_ENV is not a security boundary." \
  "$(scan "(process\.env\.)?NODE_ENV\s*(!==|===)\s*['\"](production|test|development)['\"]")"

report "No axiom_e2e_bypass cookie (SEC-2)" \
  "Deleted in W0.0. This cookie was a full unauthenticated founder-owner takeover chain." \
  "$(scan "axiom_e2e_bypass")"

report "No AXIOM_E2E_BYPASS_AUTH reads outside @axiom/config (SEC-1)" \
  "Set AXIOM_AUTH_MODE=e2e-bypass instead; it is refused at boot outside local/test." \
  "$(scan "AXIOM_E2E_BYPASS_AUTH")"

# SEC-3 runs as a ratchet against a recorded baseline rather than a flat ban.
# The 17 offending pages are migrated to the user-scoped client in W1; until
# then the gate's job is to stop the set growing. See the baseline file header.
BASELINE_FILE="scripts/sec3-service-role-baseline.txt"
current_service_role="$(grep -rln 'createSupabaseAdmin' apps/web/src --include='*.ts' --include='*.tsx' 2>/dev/null | sort)"
baseline_service_role="$(grep -vE '^\s*(#|$)' "$BASELINE_FILE" 2>/dev/null | sort)"
new_service_role="$(comm -23 <(echo "$current_service_role") <(echo "$baseline_service_role"))"

report "No NEW service-role Supabase client in apps/web (SEC-3)" \
  "Use createSupabaseServerClient(); RLS enforces tenancy. The service-role key bypasses it." \
  "$new_service_role"

# Report progress, and prompt the baseline to shrink as W1 lands.
remaining=$(echo "$baseline_service_role" | grep -c . || true)
fixed="$(comm -13 <(echo "$current_service_role") <(echo "$baseline_service_role"))"
if [[ -n "$fixed" ]]; then
  echo "${YELLOW}  ℹ ${NC}$(echo "$fixed" | grep -c .) baseline file(s) no longer use the service-role client."
  echo "    Remove them from ${BASELINE_FILE} to lock the improvement in:"
  echo "$fixed" | sed 's/^/      /'
elif [[ "$remaining" -gt 0 ]]; then
  echo "${YELLOW}  ℹ ${NC}${remaining} file(s) still on the SEC-3 baseline; W1 migrates these."
fi

echo "========================================="
if [[ $failures -gt 0 ]]; then
  echo "${RED}${failures} gate(s) failed.${NC}"
  echo "See docs/11_Phase0-5_Gap_Closure_Plan.md § W0.0 for the governing principle."
  exit 1
fi
echo "${GREEN}All W0.0 gates pass.${NC}"
