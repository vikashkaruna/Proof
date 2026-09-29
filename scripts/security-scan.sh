#!/usr/bin/env bash
# Local code-scanning parity, run before push (.husky/pre-push) and on demand
# (`pnpm security:scan`). It mirrors what GitHub code scanning reports so a
# finding is fixed while the change is being written, not after CI.
#
#   1. Bandit with the shared .bandit config (same as .github/workflows/bandit.yml):
#      shipped Python services fail on MEDIUM+; the whole repository on HIGH.
#   2. gitleaks (when installed) over the unpushed commits, with .gitleaksignore.
#   3. ESLint, which carries the CodeQL-parity rules (Math.random, URL host
#      substring checks) from @axiom/eslint-config.
#   4. Optional: set AXIOM_CODEQL=/path/to/codeql to run the CodeQL
#      security-extended suites locally and fail on high-severity results.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v uvx >/dev/null 2>&1; then
  bandit=(uvx --quiet --from 'bandit==1.9.4' bandit)
elif command -v bandit >/dev/null 2>&1; then
  bandit=(bandit)
else
  echo "security-scan: install uv (preferred) or bandit" >&2
  exit 1
fi
# Agent-tool state and stale worktrees (.claude/.kilo/.codex) are gitignored,
# and private runtime/build caches are gitignored. CI never checks them out;
# scanning them locally only reports findings from
# stale copies of the source. Excluded alongside the other non-product paths.
exclusions='*/tests/*,*/.venv/*,*/node_modules/*,*/.claude/*,*/.kilo/*,*/.codex/*,*/.axiom-runtime/*'

echo "security-scan: bandit (services, medium+)"
"${bandit[@]}" -q -r services/agent-runtime/src services/model-gateway/src \
  services/temporal-workers/src --ini .bandit -x "$exclusions" -ll -ii
echo "security-scan: bandit (repository, high)"
"${bandit[@]}" -q -r . --ini .bandit -x "$exclusions" -lll -ii

if command -v gitleaks >/dev/null 2>&1; then
  # Same engine and .gitleaksignore as CI, over the commits about to be pushed.
  range="HEAD"
  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  [ -n "$upstream" ] && range="$upstream..HEAD"
  echo "security-scan: gitleaks ($range)"
  gitleaks git . --log-opts="--no-merges $range" --redact --no-banner
fi

echo "security-scan: eslint"
pnpm turbo run lint --output-logs=errors-only

echo "security-scan: pnpm audit (production dependencies)"
pnpm audit --prod --audit-level=high

if command -v uv >/dev/null 2>&1 && command -v uvx >/dev/null 2>&1; then
  echo "security-scan: pip-audit (Python locked runtime dependencies)"
  audit_temp=$(mktemp -d)
  trap 'rm -rf "$audit_temp"' EXIT
  for service in agent-runtime temporal-workers model-gateway; do
    uv export --locked --no-dev --no-emit-project --project "services/$service" --output-file "$audit_temp/$service-requirements.txt"
    uvx --python 3.11 pip-audit==2.10.1 --strict --disable-pip --no-deps -r "$audit_temp/$service-requirements.txt"
  done
fi

if command -v trivy >/dev/null 2>&1; then
  echo "security-scan: trivy (filesystem CRITICAL,HIGH)"
  trivy fs . --severity CRITICAL,HIGH --exit-code 1
fi

if command -v semgrep >/dev/null 2>&1; then
  echo "security-scan: semgrep"
  semgrep scan --config auto --error --quiet
fi

if [ -n "${AXIOM_CODEQL:-}" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  for lang in javascript-typescript python; do
    echo "security-scan: codeql ($lang)"
    suite="codeql/${lang%%-*}-queries:codeql-suites/${lang%%-*}-security-extended.qls"
    "$AXIOM_CODEQL" database create "$work/$lang" --language="$lang" --source-root=. --overwrite -j 0 >/dev/null
    "$AXIOM_CODEQL" database analyze "$work/$lang" "$suite" --format=sarif-latest \
      --output="$work/$lang.sarif" -j 0 >/dev/null
  done
  python3 - "$work"/*.sarif <<'PY'
import json, sys
high = []
for path in sys.argv[1:]:
    run = json.load(open(path))["runs"][0]
    rules = {r["id"]: r for t in [run["tool"]["driver"], *run["tool"].get("extensions", [])] for r in t.get("rules", [])}
    for result in run["results"]:
        severity = float(rules.get(result["ruleId"], {}).get("properties", {}).get("security-severity", 0))
        loc = result["locations"][0]["physicalLocation"]
        if severity >= 7.0:
            high.append(f'{loc["artifactLocation"]["uri"]}:{loc["region"]["startLine"]} {result["ruleId"]}')
print("\n".join(high) or "codeql: no high-severity results")
sys.exit(1 if high else 0)
PY
fi
echo "security-scan: clean"
