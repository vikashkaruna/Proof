#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Local Pre-CI & Live Stack Verification Suite
# ==============================================================================
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Formatting
BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${CYAN}▶${NC} $1"; }

echo -e "\n${BOLD}${BLUE}======================================================${NC}"
echo -e "${BOLD}${BLUE}  Axiom Proof — Pre-CI Verification & Test Suite      ${NC}"
echo -e "${BOLD}${BLUE}======================================================${NC}\n"

# 1. Typecheck & Unit Tests (TypeScript)
info "Step 1/5: Running TypeScript unit tests & typechecks..."
if pnpm test; then
  pass "TypeScript unit tests passed"
else
  fail "TypeScript unit tests failed"
  exit 1
fi

# 2. Python Agent Runtime Tests
info "Step 2/5: Running Agent Runtime pytest suite..."
if (cd services/agent-runtime && uv run pytest -q); then
  pass "Agent Runtime tests passed (10 named agents)"
else
  fail "Agent Runtime tests failed"
  exit 1
fi

# 3. Python Model Gateway Tests
info "Step 3/5: Running Model Gateway pytest suite..."
if (cd services/model-gateway && uv run pytest -q); then
  pass "Model Gateway tests passed (PII redaction & routing)"
else
  fail "Model Gateway tests failed"
  exit 1
fi

# 4. Live Docker Stack HTTP Smoke Tests
info "Step 4/5: Running Live HTTP Smoke Tests against Docker services..."

# Check Model Gateway
if curl -fsS --connect-timeout 5 --max-time 15 http://localhost:8001/health >/dev/null 2>&1; then
  pass "Model Gateway live (/health)"
else
  fail "Model Gateway not responding on http://localhost:8001/health"
fi

# Check Agent Runtime
if curl -fsS --connect-timeout 5 --max-time 15 http://localhost:8000/health >/dev/null 2>&1; then
  pass "Agent Runtime live (/health)"
else
  fail "Agent Runtime not responding on http://localhost:8000/health"
fi

# Check BFF Health & Ready
if curl -fsS --connect-timeout 5 --max-time 15 http://localhost:4000/health >/dev/null 2>&1; then
  pass "BFF API live (/health)"
else
  fail "BFF not responding on http://localhost:4000/health"
fi

# Check Temporal UI
if curl -fsS --connect-timeout 5 --max-time 15 http://localhost:8233 >/dev/null 2>&1; then
  pass "Temporal UI live (http://localhost:8233)"
else
  fail "Temporal UI not responding on http://localhost:8233"
fi

# Check Web Workbench
if curl -fsS --connect-timeout 5 --max-time 15 http://localhost:3001 >/dev/null 2>&1; then
  pass "Web Product Workbench live (http://localhost:3001)"
else
  fail "Web App not responding on http://localhost:3001"
fi

# Check Marketing Site
if curl -fsS --connect-timeout 5 --max-time 15 http://localhost:3000 >/dev/null 2>&1; then
  pass "Marketing Site live (http://localhost:3000)"
else
  fail "Marketing site not responding on http://localhost:3000"
fi

# 5. Playwright E2E Suite (if Web & Marketing are running)
info "Step 5/5: Running Playwright E2E UI tests..."
if (cd tests/e2e && pnpm test:e2e); then
  pass "Playwright E2E tests passed"
else
  fail "Playwright E2E tests failed"
fi

echo -e "\n${BOLD}${GREEN}======================================================${NC}"
echo -e "${BOLD}${GREEN}  ✓ All Pre-CI verification suites completed successfully! ${NC}"
echo -e "${BOLD}${GREEN}======================================================${NC}\n"
