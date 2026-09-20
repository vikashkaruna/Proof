#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Automated Docker Local & Multi-Environment Manager
# ==============================================================================
# "Agents do the work. You approve. The proof is automatic."
#
# Usage:
#   ./scripts/dev-docker.sh [OPTIONS]
#
# Options:
#   --env, -e <name>   Target environment: local (default), staging, preprod, prod
#   --status, -s       Inspect & report status of all components without modifying
#   --build, -b        Force rebuild of all Docker container images
#   --down, -d         Stop and remove all running containers
#   --restart, -r      Restart all services
#   --test, -t         Run the full local Pre-CI verification suite
#   --logs, -l [svc]   Follow logs of all or a specific service
#   --help, -h         Display this help message
# ==============================================================================

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Formatting & Colors
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log_info()  { echo -e "  ${BLUE}ℹ${NC} $1"; }
log_succ()  { echo -e "  ${GREEN}✓${NC} $1"; }
log_warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
log_err()   { echo -e "  ${RED}✗${NC} $1"; }
log_step()  { echo -e "\n${BOLD}${CYAN}▶ $1${NC}"; }

# Defaults
TARGET_ENV="local"
ACTION="up"
FORCE_BUILD=false
SPECIFIC_SERVICE=""
NO_MARKETING=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|-e)
      TARGET_ENV="$2"
      shift 2
      ;;
    --onprem)
      TARGET_ENV="onprem"
      shift
      ;;
    --no-marketing)
      NO_MARKETING=true
      shift
      ;;
    --status|-s)
      ACTION="status"
      shift
      ;;
    --build|-b)
      FORCE_BUILD=true
      shift
      ;;
    --registry|-reg)
      export DOCKER_REGISTRY="$2"
      shift 2
      ;;
    --down|-d)
      ACTION="down"
      shift
      ;;
    --restart|-r)
      ACTION="restart"
      shift
      ;;
    --test|-t)
      ACTION="test"
      shift
      ;;
    status|down|restart|test)
      ACTION="$1"
      shift
      ;;
    up)
      ACTION="up"
      shift
      ;;
    --logs|-l)
      ACTION="logs"
      if [[ -n "$2" && "$2" != --* ]]; then
        SPECIFIC_SERVICE="$2"
        shift 2
      else
        shift
      fi
      ;;
    --help|-h)
      echo -e "${BOLD}Axiom Proof — Docker Deployment Manager${NC}"
      echo -e "Usage: ./scripts/dev-docker.sh [OPTIONS]"
      echo -e "Options:"
      echo -e "  --env, -e <name>   Target environment: local (default), staging, onprem, preprod, prod"
      echo -e "  --onprem           Shortcut to target sovereign on-premises environment"
      echo -e "  --no-marketing     Exclude the public marketing site (workbench-only / intranet)"
      echo -e "  --status, -s       Inspect & report status of all components"
      echo -e "  --build, -b        Force rebuild of all Docker images"
      echo -e "  --down, -d         Stop and remove containers"
      echo -e "  --restart, -r      Restart all services"
      echo -e "  --test, -t         Run the full local Pre-CI verification suite"
      echo -e "  --logs, -l [svc]   Follow logs of all or a specific service"
      echo -e "  --help, -h         Show this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option:${NC} $1"
      exit 1
      ;;
  esac
done

echo -e "\n${BOLD}${MAGENTA}================================================================${NC}"
echo -e "${BOLD}${MAGENTA}  AXIOM PROOF — Local & Multi-Environment Deploy Platform       ${NC}"
echo -e "${DIM}  Agents do the work. You approve. The proof is automatic.${NC}"
echo -e "${BOLD}${MAGENTA}================================================================${NC}"
echo -e "  Target Environment: ${BOLD}${CYAN}${TARGET_ENV}${NC}\n"

# ─── 1. Ensure Docker Desktop / Daemon is Running ────────────────────────────
ensure_docker_running() {
  log_step "Step 1: Checking Docker Daemon & Docker Desktop..."
  if docker info >/dev/null 2>&1; then
    log_succ "Docker daemon is already active and responsive."
    return 0
  fi

  log_warn "Docker daemon is not responding. Attempting to launch Docker Desktop..."

  if [[ "$(uname)" == "Darwin" ]]; then
    if open -a "Docker Desktop" 2>/dev/null || open -a Docker 2>/dev/null; then
      log_info "Opened Docker Desktop application. Waiting for Docker engine to initialize..."
    else
      log_err "Failed to launch Docker Desktop automatically. Please start Docker manually."
      exit 1
    fi
  else
    log_err "Docker is not running. Please start the Docker service."
    exit 1
  fi

  # Wait loop with spinner & timeout (90 seconds)
  local max_attempts=45
  local attempt=1
  local spin='-\|/'
  while ! docker info >/dev/null 2>&1; do
    if (( attempt > max_attempts )); then
      echo ""
      log_err "Docker daemon did not become ready within 90 seconds. Please check Docker Desktop."
      exit 1
    fi
    local char="${spin:attempt%4:1}"
    printf "\r  ${YELLOW}%s${NC} Waiting for Docker engine... (%ds/90s)" "$char" $((attempt * 2))
    sleep 2
    ((attempt++))
  done
  printf "\r\033[K"
  log_succ "Docker daemon is now online and ready!"
}

# ─── 2. Setup Environment Configuration ──────────────────────────────────────
setup_environment() {
  log_step "Step 2: Configuring environment parameters..."
  ENV_FILE="infra/docker/environments/.env.${TARGET_ENV}"
  ENV_EXAMPLE="infra/docker/environments/.env.${TARGET_ENV}.example"

  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$ENV_EXAMPLE" ]]; then
      log_info "Creating ${ENV_FILE} from template ${ENV_EXAMPLE}..."
      cp "$ENV_EXAMPLE" "$ENV_FILE"
      log_succ "Generated ${ENV_FILE}"
    else
      log_warn "${ENV_FILE} not found; using local fallback."
      ENV_FILE="infra/docker/environments/.env.local"
      if [[ ! -f "$ENV_FILE" ]]; then
        cp "infra/docker/environments/.env.local.example" "$ENV_FILE"
      fi
    fi
  else
    log_succ "Loaded configuration from ${ENV_FILE}"
  fi

  # Compose file selection
  COMPOSE_ARGS=("-f" "docker-compose.yml")
  if [[ ("$TARGET_ENV" == "staging" || "$TARGET_ENV" == "onprem") && -f "infra/docker/docker-compose.staging.yml" ]]; then
    COMPOSE_ARGS+=("-f" "infra/docker/docker-compose.staging.yml")
    if ! curl -fsS http://127.0.0.1:55321/rest/v1/ >/dev/null 2>&1 && [[ -f "infra/docker/docker-compose.supabase.yml" ]]; then
      log_info "No host Supabase detected on port 55321; including containerized Supabase services..."
      COMPOSE_ARGS+=("-f" "infra/docker/docker-compose.supabase.yml")
    fi
  elif [[ "$TARGET_ENV" == "local" ]]; then
    if ! curl -fsS http://127.0.0.1:55321/rest/v1/ >/dev/null 2>&1 && [[ -f "infra/docker/docker-compose.supabase.yml" ]]; then
      log_info "No host Supabase detected on port 55321; including containerized Supabase services..."
      COMPOSE_ARGS+=("-f" "infra/docker/docker-compose.supabase.yml")
    fi
  elif [[ "$TARGET_ENV" == "preprod" && -f "infra/docker/docker-compose.preprod.yml" ]]; then
    COMPOSE_ARGS+=("-f" "infra/docker/docker-compose.preprod.yml")
  elif [[ "$TARGET_ENV" == "prod" && -f "infra/docker/docker-compose.prod.yml" ]]; then
    COMPOSE_ARGS+=("-f" "infra/docker/docker-compose.prod.yml")
  fi
  COMPOSE_ARGS+=("--env-file" "$ENV_FILE")
}

# ─── 3. Pre-flight Artifacts & Supabase Local Setup ──────────────────────────
preflight_checks() {
  log_step "Step 3: Checking build artifacts, schemas, and control library..."

  # Build controls.json if missing
  local controls_json="services/agent-runtime/src/axiom/data/controls.json"
  if [[ ! -f "$controls_json" ]]; then
    log_info "Generating offline controls.json for Agent Runtime..."
    pnpm tsx scripts/build-controls-json.mjs
    log_succ "Control library controls.json generated."
  else
    log_succ "Control library controls.json is present (46 controls)."
  fi

  # Check Supabase status if targeting local
  if [[ "$TARGET_ENV" == "local" ]]; then
    if command -v supabase >/dev/null 2>&1; then
      if ! curl -fsS http://127.0.0.1:55321/rest/v1/ >/dev/null 2>&1; then
        log_info "Starting local Supabase stack..."
        (cd infra && supabase start)
      else
        log_succ "Local Supabase stack is running on port 55321 (DB port 55322)."
      fi

      # Migrations used to run as `pnpm db:migrate || true`, i.e. `supabase db
      # push` with its failure discarded. Two things were wrong with that.
      #
      # First, `db push` runs as the CLI's restricted migration role, and
      # migration 0000 creates database roles and writes to the Auth-owned
      # schema. It cannot succeed. Second, `|| true` meant it did not have to:
      # the stack came up against whatever schema happened to be there and
      # reported success. A deploy that cannot fail is not evidence of
      # anything, and here it produced the worst outcome available — services
      # running against a database missing every W0 security migration, which
      # reads as "the new code is broken" rather than "the schema is absent".
      #
      # scripts/migrate-database.py is the supported runner: it applies each
      # file once under the administration role, records SHA-256 checksums and
      # refuses changed history.
      # Read the project id rather than hardcoding it: the container name and
      # the ports both follow from it, and a stale guess would silently target
      # a different local project.
      local project_id
      project_id=$(sed -n 's/^[[:space:]]*project_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
        infra/supabase/config.toml | head -1)
      if [[ -z "$project_id" ]]; then
        log_err "Could not read project_id from infra/supabase/config.toml."
        return 1
      fi
      local db_container="supabase_db_${project_id}"
      if ! docker ps --format '{{.Names}}' | grep -qx "$db_container"; then
        log_err "Local Supabase database container '$db_container' is not running."
        return 1
      fi

      # The runner will not adopt a schema it has no record of. Reconciling an
      # existing database is a deliberate act with data at stake, so stop and
      # say so rather than half-applying or dropping anything.
      local tracked
      tracked=$(docker exec "$db_container" psql -X -U postgres -d postgres -t -A -c \
        "select to_regclass('axiom_migrations.applied') is not null" 2>/dev/null || echo 'f')
      local public_tables
      public_tables=$(docker exec "$db_container" psql -X -U postgres -d postgres -t -A -c \
        "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo '0')
      if [[ "$tracked" != "t" && "$public_tables" -gt 0 ]]; then
        log_err "Project '$project_id' has $public_tables public tables but no migration history."
        log_err "It predates the checksummed runner and is missing the 0015-0018 security migrations."
        log_err "Reconcile it deliberately, or verify against the isolated stack instead:"
        log_err "  ./scripts/test-strict-parity.sh     # real Auth/PostgREST, isolated project"
        log_err "  ./scripts/test-database.sh          # disposable Postgres, full migration series"
        return 1
      fi

      log_info "Applying migrations with the checksummed runner..."
      python3 scripts/migrate-database.py --container "$db_container" --user postgres --database postgres
      pnpm seed:controls
      pnpm seed:users
    else
      log_warn "Supabase CLI not found. Assuming external/containerized Supabase."
    fi
  fi
}

# ─── 4. Component Verification & Differential Deploy ─────────────────────────
verify_and_deploy_components() {
  log_step "Step 4: Verifying module containers & deploying missing components..."

  local services=("model-gateway" "agent-runtime" "bff" "temporal" "temporal-ui" "temporal-worker" "web")
  if [[ "$NO_MARKETING" != "true" ]]; then
    services+=("marketing")
  fi
  if [[ "${COMPOSE_ARGS[*]}" == *"docker-compose.supabase.yml"* ]]; then
    services+=("supabase-db" "supabase-auth" "supabase-rest" "supabase-studio" "supabase-gateway")
  fi
  local missing_or_stopped=()

  for svc in "${services[@]}"; do
    local container_name="axiom-${svc}"
    local status
    status="$(docker inspect --format='{{.State.Status}}' "$container_name" 2>/dev/null || echo "not_found")"

    if [[ "$status" == "running" ]]; then
      log_succ "Component ${BOLD}${svc}${NC} is currently running."
    else
      log_warn "Component ${BOLD}${svc}${NC} is ${status}. (Will be deployed/started)"
      missing_or_stopped+=("$svc")
    fi
  done

  if [[ "$FORCE_BUILD" == "true" ]]; then
    log_info "Force rebuild requested. Rebuilding module images..."
    docker compose "${COMPOSE_ARGS[@]}" build "${services[@]}"
    docker compose "${COMPOSE_ARGS[@]}" up -d "${services[@]}"
  elif (( ${#missing_or_stopped[@]} > 0 )); then
    log_info "Deploying ${#missing_or_stopped[@]} missing/stopped component(s): ${missing_or_stopped[*]}..."
    docker compose "${COMPOSE_ARGS[@]}" up -d "${missing_or_stopped[@]}"
  else
    log_succ "All components are already deployed and active!"
  fi
}

# ─── 5. Deep Health Checks & Status Table ────────────────────────────────────
check_health_and_report() {
  log_step "Step 5: Validating live service health endpoints..."

  local endpoints=(
    "Supabase Gateway:http://localhost:55321"
    "Supabase Studio:http://localhost:55323"
    "Model Gateway:http://localhost:8001/health"
    "Agent Runtime:http://localhost:8000/health"
    "BFF API Engine:http://localhost:4000/health"
    "Temporal UI:http://localhost:8233"
    "Web Workbench:http://localhost:3001"
  )
  if [[ "$NO_MARKETING" != "true" ]]; then
    endpoints+=("Marketing Public:http://localhost:3000")
  fi

  printf "\n  ${BOLD}%-22s %-32s %-12s %-10s${NC}\n" "MODULE" "URL" "STATUS" "LATENCY"
  echo -e "  -------------------------------------------------------------------------------"

  for item in "${endpoints[@]}"; do
    IFS=":" read -r name url <<< "$item"
    local full_url="${item#*:}"
    local start_time
    start_time="$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s000)"
    
    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$full_url" 2>/dev/null || echo "000")"
    local end_time
    end_time="$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s000)"
    local latency=$((end_time - start_time))

    if [[ "$http_code" =~ ^(200|301|302|307|308|404)$ ]]; then
      printf "  %-22s %-32s ${GREEN}%-12s${NC} %dms\n" "$name" "$full_url" "HEALTHY" "$latency"
    else
      printf "  %-22s %-32s ${RED}%-12s${NC} -\n" "$name" "$full_url" "UNAVAILABLE"
    fi
  done
  echo ""
}

# ─── 6. Action Handlers ──────────────────────────────────────────────────────
case "$ACTION" in
  down)
    ensure_docker_running
    setup_environment
    log_step "Stopping and removing all Axiom Proof containers..."
    docker compose "${COMPOSE_ARGS[@]}" down
    log_succ "All containers stopped."
    ;;
  restart)
    ensure_docker_running
    setup_environment
    log_step "Restarting all Axiom Proof services..."
    docker compose "${COMPOSE_ARGS[@]}" restart
    check_health_and_report
    ;;
  status)
    ensure_docker_running
    setup_environment
    check_health_and_report
    ;;
  logs)
    ensure_docker_running
    setup_environment
    if [[ -n "$SPECIFIC_SERVICE" ]]; then
      docker compose "${COMPOSE_ARGS[@]}" logs -f "$SPECIFIC_SERVICE"
    else
      docker compose "${COMPOSE_ARGS[@]}" logs -f
    fi
    ;;
  test)
    ensure_docker_running
    setup_environment
    preflight_checks
    verify_and_deploy_components
    check_health_and_report
    log_step "Executing Full Local Pre-CI & Live Stack Verification..."
    ./scripts/test-local-stack.sh
    ;;
  up)
    ensure_docker_running
    setup_environment
    preflight_checks
    verify_and_deploy_components
    check_health_and_report
    echo -e "${BOLD}${GREEN}================================================================${NC}"
    echo -e "${BOLD}${GREEN}  ✓ Axiom Proof is running and ready!                          ${NC}"
    echo -e "${BOLD}${GREEN}================================================================${NC}"
    echo -e "  • Web App (Workbench / Console): ${CYAN}http://localhost:3001${NC}"
    if [[ "$NO_MARKETING" != "true" ]]; then
      echo -e "  • Marketing Site (Gap-Scan):     ${CYAN}http://localhost:3000${NC}"
    fi
    echo -e "  • BFF API & Execution Gate:      ${CYAN}http://localhost:4000${NC}"
    echo -e "  • Agent Runtime:                 ${CYAN}http://localhost:8000${NC}"
    echo -e "  • Model Gateway:                 ${CYAN}http://localhost:8001${NC}"
    echo -e "  • Temporal UI:                   ${CYAN}http://localhost:8233${NC}"
    echo -e "  • Supabase Studio:               ${CYAN}http://localhost:55323${NC}\n"
    echo -e "  Run tests with: ${BOLD}./scripts/dev-docker.sh --test${NC} or ${BOLD}pnpm docker:test${NC}\n"
    ;;
esac
