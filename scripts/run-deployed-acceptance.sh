#!/usr/bin/env bash
# Explicit, isolated target. Creates synthetic fixture identities, never runs an agent action.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then echo 'Usage: run-deployed-acceptance.sh PRIVATE_TARGET_JSON [api-only]' >&2; exit 2; fi
if [ "${2:-}" != '' ] && [ "${2:-}" != api-only ]; then echo 'Unknown acceptance mode' >&2; exit 2; fi
export AXIOM_ACCEPTANCE_TARGET
AXIOM_ACCEPTANCE_TARGET=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$1")
# Validation and HTTP identity checks happen before any fixture creation.
pnpm exec tsx scripts/verify-strict-parity.ts
if [ "${2:-}" = api-only ]; then exit 0; fi
pnpm exec tsx scripts/seed-personas.ts
acceptance_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deploymentId"])' "$AXIOM_ACCEPTANCE_TARGET")
acceptance_dir="$PWD/.axiom-runtime/acceptance/$acceptance_id"
rm -f "$acceptance_dir/browser-results.json" "$acceptance_dir/browser-private.json"
export PLAYWRIGHT_JSON_OUTPUT_NAME="$acceptance_dir/browser-private.json"
# Errors and recordings can contain fixture credentials. Keep raw output local;
# publish only the allowlisted behavioral result, never this private report.
result=0
pnpm --filter @axiom/e2e exec playwright test --reporter=json > "$acceptance_dir/browser-private.log" 2>&1 || result=$?
pnpm exec tsx scripts/summarize-deployed-browser.ts
if [ "$result" -ne 0 ]; then echo 'Deployed browser acceptance failed; inspect the protected local report.' >&2; exit "$result"; fi
