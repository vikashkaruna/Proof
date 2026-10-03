#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — operator command line: CI, build, deploy, soft stop/start
# ==============================================================================
# One entry point, one rule: every value comes from `.env.<env>` (repo-root
# symlink or infra/docker/environments/; templates: `.env.<env>.example`).
# Nothing is hard-coded here.
#
#   scripts/axiom-ops.sh <command> --env <local|staging|preprod> [options] [-- extra]
#
# Commands
#   env-check   find the env file and report which required keys are set
#   ci          the CI gates, locally (format, lint, typecheck, tests, scans)
#   build       build container images (preprod: exact-SHA push to the registry)
#   deploy      deploy the environment (preprod: the GCP pipeline)
#   stop        soft stop: cut idle cost, delete nothing, keep every object ID
#   start       reverse of stop
#   status      what is running and what still costs money
#
# Options
#   --env <name>       local | staging | preprod   (production/onprem refused)
#   --env-file <path>  explicit env file (also AXIOM_ENV_FILE)
#   --dry-run          show what would change; mutate nothing
#   --yes, -y          do not ask for confirmation (needed when not on a TTY)
#   --skip-security --skip-python --skip-config   (ci only) skip a gate
#   -- <args>          passed unchanged to the underlying deploy/build script
#
# Examples
#   scripts/axiom-ops.sh ci --env preprod
#   scripts/axiom-ops.sh build  --env preprod --yes
#   scripts/axiom-ops.sh deploy --env preprod --dry-run
#   scripts/axiom-ops.sh deploy --env preprod --yes -- --from-phase services
#   scripts/axiom-ops.sh stop   --env preprod --dry-run
#   scripts/axiom-ops.sh stop   --env preprod --yes
#   scripts/axiom-ops.sh start  --env preprod --yes
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/ops-env.sh
. "$REPO_ROOT/scripts/lib/ops-env.sh"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

COMMAND="${1:-}"
case "$COMMAND" in
  -h|--help|help|"") awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
esac
shift

ENV_NAME=""; DRY_RUN=false; ASSUME_YES=false; EXTRA=()
SKIP_SECURITY=false; SKIP_PYTHON=false; SKIP_CONFIG=false
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --env-file) AXIOM_ENV_FILE="${2:-}"; export AXIOM_ENV_FILE; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --skip-security) SKIP_SECURITY=true; shift ;;
    --skip-python) SKIP_PYTHON=true; shift ;;
    --skip-config) SKIP_CONFIG=true; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

case "$COMMAND" in env-check|ci|build|deploy|stop|start|status) ;; *) die "unknown command: $COMMAND (see --help)" ;; esac
[ "$COMMAND" = ci ] && [ -z "$ENV_NAME" ] && SKIP_CONFIG=true
[ -n "$ENV_NAME" ] || [ "$COMMAND" = ci ] || die "--env is required (local | staging | preprod)"

if [ -n "$ENV_NAME" ]; then
  case "$ENV_NAME" in
    local|staging|preprod) ;;
    production|prod|onprem)
      die "'$ENV_NAME' is not driven by this tool. Nothing is deployed there; follow docs/23_Operator_Runbook.md." ;;
    *) die "unknown environment '$ENV_NAME' (local | staging | preprod)" ;;
  esac
fi

# Never reads a value that is already in the process environment from the file
# (see ops_load_env_file), so a one-off override on the command line wins.
ENV_FILE=""
load_env() {
  ENV_FILE="$(ops_find_env_file "$ENV_NAME" "$REPO_ROOT")" \
    || die "no env file for '$ENV_NAME'. Create it from the template:  cp infra/docker/environments/.env.${ENV_NAME}.example infra/docker/environments/.env.${ENV_NAME}  and fill it in."
  AXIOM_ENV_FILE="$ENV_FILE"; export AXIOM_ENV_FILE
  ops_load_env_file "$ENV_FILE"
  # A file whose ENVIRONMENT disagrees with its name would drive cloud tooling
  # at the wrong tier (a `.env.staging` that says production).
  if [ "$ENV_NAME" != local ] && [ -n "${ENVIRONMENT:-}" ] && [ "$ENVIRONMENT" != "$ENV_NAME" ]; then
    die "$ENV_FILE sets ENVIRONMENT=$ENVIRONMENT but was selected as --env $ENV_NAME"
  fi
  export ENVIRONMENT="${ENVIRONMENT:-$ENV_NAME}"
  printf 'env file: %s\n' "$ENV_FILE"
}

confirm() {
  local prompt="$1"
  [ "$DRY_RUN" = true ] && return 0
  [ "$ASSUME_YES" = true ] && return 0
  [ -t 0 ] || die "not a terminal; re-run with --yes to confirm: $prompt"
  printf '%s [type yes to continue] ' "$prompt"
  local answer; read -r answer
  [ "$answer" = yes ] || die "cancelled"
}

# The Docker environments read the same file from the older location; a symlink
# keeps one real copy. It is untracked (gitignored) and never overwritten.
link_docker_env() {
  local target="$REPO_ROOT/infra/docker/environments/.env.${ENV_NAME}"
  if [ ! -e "$target" ] && [ "$ENV_FILE" != "$target" ]; then
    mkdir -p "$(dirname "$target")"
    ln -s "$ENV_FILE" "$target"
    printf 'linked %s -> %s\n' "${target#"$REPO_ROOT"/}" "$ENV_FILE"
  fi
}

require_clean_tree() {
  [ -z "$(git status --porcelain --untracked-files=normal)" ] \
    || die "uncommitted changes. Cloud releases are exact-SHA: commit or discard them first."
}

gcp_params() {
  ops_require_value GCP_PROJECT_ID
  ops_require_value GCP_REGION
  PROJECT_ID="$GCP_PROJECT_ID"; REGION="$GCP_REGION"
}

cmd_env_check() {
  load_env
  local required=() key
  case "$ENV_NAME" in
    preprod) required=(GCP_PROJECT_ID GCP_REGION ENVIRONMENT AXIOM_TF_STATE_BUCKET UPSTREAM_GOTRUE_IMAGE UPSTREAM_POSTGREST_IMAGE) ;;
    *) required=(ENVIRONMENT) ;;
  esac
  local bad=0
  for key in "${required[@]}"; do
    if ops_require_value "$key" 2>/dev/null; then printf '  ok       %s\n' "$key"; else printf '  MISSING  %s\n' "$key"; bad=1; fi
  done
  if [ "$ENV_NAME" = preprod ]; then
    ./scripts/sync-env.sh preprod verify || bad=1
  fi
  [ "$bad" = 0 ] || die "environment '$ENV_NAME' is not ready"
  say "environment '$ENV_NAME' is ready"
}

cmd_ci() {
  local failed=()
  step() { # step "<label>" cmd...
    local label="$1"; shift
    say "$label"
    if "$@"; then printf 'PASS  %s\n' "$label"; else printf 'FAIL  %s\n' "$label"; failed+=("$label"); fi
  }
  if [ "$SKIP_CONFIG" = false ]; then load_env; step "configuration audit ($ENV_NAME)" ./scripts/sync-env.sh "$ENV_NAME" verify; fi
  step "install (frozen lockfile)" pnpm install --frozen-lockfile
  step "format" pnpm format:check
  step "lint" pnpm lint
  step "typecheck" pnpm typecheck
  step "unit tests" pnpm test
  step "script tests" python3 -m unittest discover -s tests/scripts -p 'test_*.py'
  step "control count gate" bash scripts/check-control-count.sh
  step "tfvars coverage gate" bash scripts/check-tfvars-coverage.sh
  if [ "$SKIP_PYTHON" = false ]; then
    step "agent-runtime tests" bash -c 'cd services/agent-runtime && uv run pytest -q'
    step "model-gateway tests" bash -c 'cd services/model-gateway && uv run pytest -q'
  fi
  if [ "$SKIP_SECURITY" = false ]; then step "security scan" bash scripts/security-scan.sh; fi
  say "CI summary"
  if [ ${#failed[@]} -eq 0 ]; then echo "all gates passed"; else printf 'FAILED: %s\n' "${failed[@]}"; exit 1; fi
}

cmd_build() {
  load_env
  if [ "$ENV_NAME" = preprod ]; then
    gcp_params; require_clean_tree
    local sha; sha="$(git rev-parse HEAD)"
    echo "Builds the nine images from ${sha} and PUSHES them to ${REGION}-docker.pkg.dev/${PROJECT_ID}."
    [ "$DRY_RUN" = true ] && { echo "[dry-run] would run build-preprod-images.sh ${PROJECT_ID} ${REGION} release-${sha}"; return 0; }
    confirm "Build and push release-${sha} to project ${PROJECT_ID}?"
    AXIOM_RELEASE_SHA="$sha" PUSH_IMAGES=true IMAGE_TAG="release-${sha}" \
      ./scripts/build-preprod-images.sh "$PROJECT_ID" "$REGION" "release-${sha}" ${EXTRA[@]+"${EXTRA[@]}"}
  else
    link_docker_env
    [ "$DRY_RUN" = true ] && { echo "[dry-run] would run dev-docker.sh --env ${ENV_NAME} --build"; return 0; }
    ./scripts/dev-docker.sh --env "$ENV_NAME" --build
  fi
}

cmd_deploy() {
  load_env
  if [ "$ENV_NAME" = preprod ]; then
    gcp_params; require_clean_tree
    local sha; sha="$(git rev-parse HEAD)"
    export AXIOM_RELEASE_SHA="$sha"
    local args=(--env-file "$ENV_FILE")
    [ "$DRY_RUN" = true ] && args+=(--dry-run)
    echo "Deploys ${sha} to GCP project ${PROJECT_ID} (${REGION}). This provisions billable resources."
    confirm "Deploy preprod from exact commit ${sha}?"
    ./scripts/deploy-preprod-gcp.sh "${args[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$PROJECT_ID" "$REGION" preprod
  else
    link_docker_env
    [ "$DRY_RUN" = true ] && { echo "[dry-run] would run dev-docker.sh --env ${ENV_NAME}"; return 0; }
    ./scripts/dev-docker.sh --env "$ENV_NAME"
  fi
}

cmd_softstop() { # stop | start | status
  load_env
  if [ "$ENV_NAME" = preprod ]; then
    gcp_params
    local args=("$COMMAND" --env "$ENV_NAME" --project "$PROJECT_ID" --region "$REGION")
    [ "$DRY_RUN" = true ] && args+=(--dry-run)
    [ "$COMMAND" != status ] && confirm "$COMMAND the '${ENV_NAME}' environment in project ${PROJECT_ID}? (nothing is deleted)"
    python3 scripts/softstop-gcp.py "${args[@]}"
  else
    link_docker_env
    local flag=()
    case "$COMMAND" in stop) flag=(--down) ;; start) flag=() ;; status) flag=(--status) ;; esac
    [ "$DRY_RUN" = true ] && { echo "[dry-run] would run dev-docker.sh --env ${ENV_NAME} ${flag[*]:-}"; return 0; }
    # --down keeps containers and data in place for local and staging.
    ./scripts/dev-docker.sh --env "$ENV_NAME" ${flag[@]+"${flag[@]}"}
  fi
}

case "$COMMAND" in
  env-check) cmd_env_check ;;
  ci) cmd_ci ;;
  build) cmd_build ;;
  deploy) cmd_deploy ;;
  stop|start|status) cmd_softstop ;;
esac
