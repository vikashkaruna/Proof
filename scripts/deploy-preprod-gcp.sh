#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Complete GCP Preprod Deployment Pipeline
# ==============================================================================
# Progressive, parameterized, and self-healing deployment orchestrator:
#   Phase 1 (prep)     : Pre-flight prerequisites & Google APIs
#   Phase 2 (base)     : VPC, Subnet, Peering, VPC Connector, GCS Vault, Artifact Registry, IAM
#   Phase 3 (db)       : Cloud SQL PostgreSQL (with automatic state healing) & Secret Manager
#   Phase 4 (images)   : Build & push container images (intelligent skip if present)
#   Phase 5 (services) : Cloud Run v2 microservices (BFF, Web, Runtime, Model Gateway, Temporal)
#   Phase 6 (migrate)  : Database migrations & statutory control library seeding
#   Phase 7 (firebase) : Google Firebase static hosting for marketing
#   Phase 8 (verify)   : Live readiness & service health verification
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Ensure all container operations default to linux/amd64 for Google Cloud Run
export DOCKER_DEFAULT_PLATFORM="linux/amd64"

# Colors & Formatting
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
info() { echo -e "\n${BOLD}${CYAN}▶ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
step_header() { echo -e "\n${BOLD}${BLUE}═════════════════════════════════════════════════════════════════${NC}\n${BOLD}${BLUE}  Phase $1: $2${NC}\n${BOLD}${BLUE}═════════════════════════════════════════════════════════════════${NC}"; }

# Defaults
PROJECT_ID="${GCP_PROJECT_ID:-axiom-proof}"
REGION="${GCP_REGION:-asia-south1}"
ENV="${ENVIRONMENT:-preprod}"
IMAGE_TAG="${IMAGE_TAG:-preprod}"
CLOUD_SQL_TIER=""
TARGET_PHASE="all"
FROM_PHASE=""
SKIP_BUILD=false
FORCE_BUILD=false
SKIP_MIGRATE=false
SEED_IDENTITIES=false
SKIP_FIREBASE=false
DRY_RUN=false
FORCE_HEAL=false

ENV_FILE_OVERRIDE=""
PROJECT_ID_EXPLICIT=false
REGION_EXPLICIT=false
ENV_EXPLICIT=false

# CLI Help
show_help() {
  cat <<EOF
Usage: ./scripts/deploy-preprod-gcp.sh [OPTIONS] [PROJECT_ID] [REGION] [ENV]

Positional Arguments:
  PROJECT_ID          Google Cloud Project ID (default: ${PROJECT_ID})
  REGION              GCP Region for sovereign residency (default: ${REGION})
  ENV                 Environment name (default: ${ENV})

Options:
  --env-file <path>   Explicit path to preprod environment configuration file
  --phase <name>      Execute ONLY a specific phase:
                        prep     : Prerequisites and GCP API enablement
                        base     : Networking (VPC/Peering/Connector), IAM, GCS & Artifact Registry
                        db       : Cloud SQL PostgreSQL (with self-healing) & Secret Manager
                        images   : Build & push container images
                        services : Cloud Run v2 microservices & IAM
                        migrate  : Database schema migrations & statutory seeds
                        firebase : Google Firebase static hosting
                        verify   : Service health probes & summary
  --from-phase <name> Resume pipeline starting from <name> through the end
  --skip-build        Skip container image building (use existing Artifact Registry images)
  --force-build       Force rebuilding and pushing all container images
  --skip-migrate      Skip database migrations and seeding
  --seed-identities   Also seed representative tenants and persona logins
                        (fixed passwords; refused for production)
  --skip-firebase     Skip Firebase static hosting deployment
  --dry-run           Perform terraform plan without mutating infrastructure
  --heal-state        Force check and prune stale/orphaned Cloud SQL state references
  --tier <tier>       Override Cloud SQL tier (e.g. db-f1-micro, db-custom-2-7680)
  --tag <tag>         Override Docker image tag (default: ${IMAGE_TAG})
  --help, -h          Display this help message

Examples:
  ./scripts/deploy-preprod-gcp.sh
  ./scripts/deploy-preprod-gcp.sh "axiom-proof" "asia-south1" --skip-build
  ./scripts/deploy-preprod-gcp.sh --env-file infra/docker/environments/.env.preprod
  ./scripts/deploy-preprod-gcp.sh --phase db
  ./scripts/deploy-preprod-gcp.sh --from-phase services
  ./scripts/deploy-preprod-gcp.sh --dry-run
EOF
  exit 0
}

# Parse Command Line Options
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-file)
      ENV_FILE_OVERRIDE="$2"
      shift 2
      ;;
    --phase)
      TARGET_PHASE="$2"
      shift 2
      ;;
    --from-phase)
      FROM_PHASE="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --force-build)
      FORCE_BUILD=true
      shift
      ;;
    --skip-migrate)
      SKIP_MIGRATE=true
      shift
      ;;
    --seed-identities)
      SEED_IDENTITIES=true
      shift
      ;;
    --skip-firebase)
      SKIP_FIREBASE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --heal-state)
      FORCE_HEAL=true
      shift
      ;;
    --tier)
      CLOUD_SQL_TIER="$2"
      shift 2
      ;;
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    -h|--help)
      show_help
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

# Load environment configuration from .env.preprod
load_preprod_env() {
  local candidate_files=()
  if [ -n "$ENV_FILE_OVERRIDE" ]; then
    candidate_files=("$ENV_FILE_OVERRIDE")
  else
    candidate_files=(
      "${REPO_ROOT}/.env.preprod"
      "${REPO_ROOT}/infra/docker/environments/.env.preprod"
      "${REPO_ROOT}/.env"
    )
  fi

  local loaded_file=""
  for candidate in "${candidate_files[@]}"; do
    if [ -f "$candidate" ]; then
      loaded_file="$candidate"
      break
    fi
  done

  if [ -z "$loaded_file" ]; then
    # Previously this fell through in silence and the deploy continued on
    # whatever happened to be in the ambient environment, which on a clean
    # runner is nothing at all.
    fail "No environment file found. Looked for:"
    printf "    %s\n" "${candidate_files[@]}"
    echo "  Create one with: ./scripts/sync-env.sh ${ENV} scaffold"
    exit 1
  fi

  if [ -n "$loaded_file" ]; then
    info "Loading preprod environment variables from: ${loaded_file}"
    # Read variables safely
    while IFS='=' read -r key val || [ -n "$key" ]; do
      # Strip leading/trailing whitespace
      key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      # Ignore comments and empty lines
      if [[ "$key" =~ ^#.*$ ]] || [ -z "$key" ]; then continue; fi
      # Clean value of quotes
      val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
      export "$key"="$val"
    done < "$loaded_file"
    pass "Environment variables loaded from $(basename "$loaded_file")"
  fi

  # Terraform variables are NOT mapped here any more.
  #
  # This function used to export TF_VAR_* one `if` per line. It covered 15 of
  # the 23 variables preprod declares, so the rest silently took their
  # Terraform defaults — including `mfa_encryption_key`, which meant an
  # operator who set AXIOM_MFA_ENCRYPTION_KEY in .env.preprod had it ignored
  # while Terraform minted a different random key into Secret Manager, and
  # `retention_days`, which could put a test-length COMPLIANCE lock on an
  # evidence bucket that documentation described as seven years.
  #
  # scripts/sync-env.sh now generates terraform.tfvars from the same .env,
  # driven by variables.tf so a newly declared variable is a build failure
  # rather than a silent default. See scripts/check-tfvars-coverage.sh.
  if [ -n "${GCP_PROJECT_ID:-}" ]; then PROJECT_ID="${GCP_PROJECT_ID}"; fi
  if [ -n "${AXIOM_PROJECT_ID:-}" ]; then PROJECT_ID="${AXIOM_PROJECT_ID}"; fi
  if [ -n "${GCP_REGION:-}" ]; then REGION="${GCP_REGION}"; fi
  if [ -n "${AXIOM_REGION:-}" ]; then REGION="${AXIOM_REGION}"; fi
  if [ -n "${ENVIRONMENT:-}" ]; then ENV="${ENVIRONMENT}"; fi
}

load_preprod_env

# Assign positional overrides if supplied (positionals take precedence over .env)
if [ ${#POSITIONAL_ARGS[@]} -ge 1 ]; then PROJECT_ID="${POSITIONAL_ARGS[0]}"; PROJECT_ID_EXPLICIT=true; fi
if [ ${#POSITIONAL_ARGS[@]} -ge 2 ]; then REGION="${POSITIONAL_ARGS[1]}"; REGION_EXPLICIT=true; fi
if [ ${#POSITIONAL_ARGS[@]} -ge 3 ]; then ENV="${POSITIONAL_ARGS[2]}"; ENV_EXPLICIT=true; fi

# Phase Execution Order Mapping
PHASES=("prep" "base" "db" "images" "services" "migrate" "firebase" "verify")

should_run_phase() {
  local phase="$1"
  if [ "$TARGET_PHASE" = "$phase" ]; then
    return 0
  fi
  if [ "$TARGET_PHASE" != "all" ]; then
    return 1
  fi
  if [ -n "$FROM_PHASE" ]; then
    local matched=false
    for p in "${PHASES[@]}"; do
      if [ "$p" = "$FROM_PHASE" ]; then matched=true; fi
      if [ "$matched" = true ] && [ "$p" = "$phase" ]; then return 0; fi
    done
    return 1
  fi
  return 0
}

echo -e "\n${BOLD}${MAGENTA}=================================================================${NC}"
echo -e "${BOLD}${MAGENTA}  AXIOM PROOF — Progressive GCP Deployment Pipeline             ${NC}"
echo -e "${BOLD}${MAGENTA}  Region: Mumbai (asia-south1) · Sovereign Indian Data Residency ${NC}"
echo -e "${BOLD}${MAGENTA}=================================================================${NC}"
echo -e "  GCP Project ID:    ${BOLD}${CYAN}${PROJECT_ID}${NC}"
echo -e "  Target Region:     ${BOLD}${CYAN}${REGION}${NC}"
echo -e "  Environment:       ${BOLD}${CYAN}${ENV}${NC}"
echo -e "  Target Phase:      ${BOLD}${CYAN}${TARGET_PHASE}${NC}"
if [ -n "$FROM_PHASE" ]; then
  echo -e "  Resume From:       ${BOLD}${CYAN}${FROM_PHASE}${NC}"
fi
echo -e "  Image Tag:         ${BOLD}${CYAN}${IMAGE_TAG}${NC}"
echo -e "  Skip Build:        ${BOLD}${CYAN}${SKIP_BUILD}${NC}"
echo -e "  Dry Run (Plan):    ${BOLD}${CYAN}${DRY_RUN}${NC}\n"

# ─── Phase 0: the configuration this deployment will use ──────────────────────
# Runs before every phase, including a single --phase run, because no phase is
# safe to execute on a configuration nobody checked. `verify` is a gate: a
# missing or placeholder value stops the deployment here rather than producing
# a half-configured environment that reports success.
step_header "0/8" "Configuration audit and Terraform variable generation"
if ! ./scripts/sync-env.sh "$ENV" verify; then
  fail "Configuration for '${ENV}' is incomplete. Nothing was deployed."
  echo "  Fix the values above in infra/docker/environments/.env.${ENV}, then re-run."
  echo "  New keys can be pulled in with: ./scripts/sync-env.sh ${ENV} scaffold"
  exit 1
fi
# Writes infra/terraform/envs/<env>/terraform.tfvars from the same .env, driven
# by variables.tf so nothing can declare a variable this never fills.
./scripts/sync-env.sh "$ENV" terraform
pass "Configuration verified and propagated to Terraform"

# Helper for terraform variable arguments
# Only values a human typed on the command line are passed as -var. Everything
# else comes from terraform.tfvars, which sync-env.sh generated from the .env.
# Passing them unconditionally would mean this script's own defaults silently
# overrode the configuration file it had just been told to read.
get_tf_vars() {
  local vars=()
  [ "$PROJECT_ID_EXPLICIT" = true ] && vars+=("-var=project_id=${PROJECT_ID}")
  [ "$REGION_EXPLICIT" = true ] && vars+=("-var=region=${REGION}")
  [ "$ENV_EXPLICIT" = true ] && vars+=("-var=environment=${ENV}")
  [ -n "$CLOUD_SQL_TIER" ] && vars+=("-var=cloud_sql_tier=${CLOUD_SQL_TIER}")
  echo "${vars[@]:-}"
}

# Self-Healing Cloud SQL State Resolver
heal_cloudsql_state_if_needed() {
  local tf_dir="infra/terraform/envs/preprod"
  cd "$tf_dir"
  
  local state_has_instance=false
  local state_instance_name=""

  if terraform state list 2>/dev/null | grep -q "google_sql_database_instance.postgres"; then
    state_has_instance=true
    state_instance_name=$(terraform state show google_sql_database_instance.postgres 2>/dev/null | grep '^[[:space:]]*name[[:space:]]*=' | head -n1 | cut -d'"' -f2 || echo "")
  fi

  local gcp_instance_exists=false
  if [ -n "$state_instance_name" ] && command -v gcloud >/dev/null 2>&1; then
    if gcloud sql instances describe "$state_instance_name" --project="$PROJECT_ID" >/dev/null 2>&1; then
      gcp_instance_exists=true
    fi
  fi

  if [ "$FORCE_HEAL" = true ] || ([ "$state_has_instance" = true ] && [ "$gcp_instance_exists" = false ]); then
    warn "Detected Cloud SQL instance in Terraform state ('${state_instance_name:-unknown}') that does not exist in GCP."
    warn "Self-healing state: Pruning stale database/user child references to prevent GCP 403 API lock & name collision..."
    terraform state rm google_sql_database.axiom_db 2>/dev/null || true
    terraform state rm google_sql_user.axiom_user 2>/dev/null || true
    terraform state rm google_sql_database_instance.postgres 2>/dev/null || true
    terraform state rm random_id.db_suffix 2>/dev/null || true
    pass "State healed: Orphaned Cloud SQL resources cleared from local state"
  fi
  cd "$REPO_ROOT"
}

# Self-Healing Secret Manager State Resolver (Prevents 409 Conflict if secrets already exist in GCP)
heal_secret_manager_state_if_needed() {
  local tf_dir="infra/terraform/envs/preprod"
  cd "$tf_dir"

  local secrets=(
    "resend_api_key"
    "db_password"
    "db_url"
    "upstash_redis_url"
    "anthropic_api_key"
    "openai_api_key"
    "gemini_api_key"
    "approval_signing_key"
    "mfa_encryption_key"
    "agent_runtime_internal_token"
    "model_gateway_api_key"
    "temporal_api_key"
    "gcs_hmac_access_key"
    "gcs_hmac_secret_key"
  )

  if command -v gcloud >/dev/null 2>&1; then
    for sec_key in "${secrets[@]}"; do
      local sec_id="axiom-${ENV}-${sec_key//_/-}"
      if ! terraform state list 2>/dev/null | grep -q "google_secret_manager_secret\.secret\[\"${sec_key}\"\]"; then
        if gcloud secrets describe "$sec_id" --project="$PROJECT_ID" >/dev/null 2>&1; then
          info "Importing pre-existing secret '${sec_id}' into Terraform state to prevent 409 Conflict..."
          terraform import "google_secret_manager_secret.secret[\"${sec_key}\"]" "projects/${PROJECT_ID}/secrets/${sec_id}" >/dev/null 2>&1 || true
        fi
      fi
    done
  fi

  cd "$REPO_ROOT"
}


# ─── Phase 1: Prerequisites & APIs ────────────────────────────────────────────
if should_run_phase "prep"; then
  step_header "1/8" "Verifying Prerequisites & GCP APIs"
  command -v gcloud >/dev/null 2>&1 || { fail "gcloud CLI not installed. Please install Google Cloud SDK."; exit 1; }
  command -v terraform >/dev/null 2>&1 || { fail "Terraform not installed."; exit 1; }
  command -v docker >/dev/null 2>&1 || { fail "Docker CLI not installed."; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    if [ -d "/Applications/Docker.app" ]; then
      warn "Docker daemon not running. Launching Docker Desktop..."
      open -a Docker || true
      for i in {1..30}; do
        if docker info >/dev/null 2>&1; then break; fi
        sleep 2
      done
    fi
  fi
  docker info >/dev/null 2>&1 || { fail "Docker daemon not running. Please start Docker."; exit 1; }
  command -v pnpm >/dev/null 2>&1 || { fail "pnpm not installed."; exit 1; }
  pass "Pre-flight dependencies verified (gcloud, terraform, docker, pnpm)"

  # GCP Authentication
  if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]; then
    if gcloud auth application-default print-access-token >/dev/null 2>&1; then
      pass "Google Cloud Application Default Credentials (ADC) active"
    elif TOKEN=$(gcloud auth print-access-token 2>/dev/null); then
      export GOOGLE_OAUTH_ACCESS_TOKEN="$TOKEN"
      pass "Active gcloud user session detected; exported GOOGLE_OAUTH_ACCESS_TOKEN"
    else
      fail "No Google Cloud credentials found. Run 'gcloud auth application-default login'."
      exit 1
    fi
  fi

  # Enable required GCP services if gcloud is configured
  info "Verifying required GCP APIs for ${PROJECT_ID}..."
  REQUIRED_APIS=(
    "servicenetworking.googleapis.com"
    "compute.googleapis.com"
    "sqladmin.googleapis.com"
    "run.googleapis.com"
    "secretmanager.googleapis.com"
    "artifactregistry.googleapis.com"
    "vpcaccess.googleapis.com"
    "storage.googleapis.com"
  )
  # `|| true` here meant a failure to enable an API surfaced three phases later
  # as an obscure permission error from Terraform, with nothing pointing back
  # to the cause.
  failed_apis=()
  for api in "${REQUIRED_APIS[@]}"; do
    gcloud services enable "$api" --project="$PROJECT_ID" --quiet >/dev/null 2>&1 || failed_apis+=("$api")
  done
  if [ ${#failed_apis[@]} -gt 0 ]; then
    fail "Could not enable required Google Cloud APIs on ${PROJECT_ID}:"
    printf "    %s\n" "${failed_apis[@]}"
    echo "    Check the account has serviceusage.services.enable and that billing is active."
    exit 1
  fi
  pass "Required Google Cloud APIs enabled"
fi


# ─── Phase 2: Base Infrastructure (VPC, Subnet, Peering, Connector, GCS, AR) ──
if should_run_phase "base"; then
  step_header "2/8" "Foundational Networking, Identity & Storage"
  cd "infra/terraform/envs/preprod"
  terraform init -upgrade
  if [ ! -f "terraform.tfvars" ] && [ -f "terraform.tfvars.example" ]; then
    warn "terraform.tfvars not found. Creating from terraform.tfvars.example..."
    cp terraform.tfvars.example terraform.tfvars
  fi

  TF_VARS=$(get_tf_vars)

  if [ "$DRY_RUN" = true ]; then
    info "Executing dry-run plan for Base Infrastructure..."
    terraform plan $TF_VARS \
      -target=google_project_service.apis \
      -target=google_compute_network.vpc \
      -target=google_compute_subnetwork.subnet \
      -target=google_compute_global_address.private_ip_address \
      -target=google_service_networking_connection.private_vpc_connection \
      -target=google_vpc_access_connector.connector \
      -target=google_service_account.cloudrun_sa \
      -target=google_service_account.storage_sa \
      -target=google_project_iam_member.secret_accessor \
      -target=google_project_iam_member.artifact_reader \
      -target=google_project_iam_member.cloudsql_client \
      -target=google_storage_bucket.evidence_vault \
      -target=google_storage_hmac_key.s3_compat_key \
      -target=google_storage_bucket_iam_member.storage_admin \
      -target=google_artifact_registry_repository.docker_repo
  else
    info "Applying Base Infrastructure (VPC, Peering, Connector, Storage, Artifact Registry)..."
    terraform apply -auto-approve $TF_VARS \
      -target=google_project_service.apis \
      -target=google_compute_network.vpc \
      -target=google_compute_subnetwork.subnet \
      -target=google_compute_global_address.private_ip_address \
      -target=google_service_networking_connection.private_vpc_connection \
      -target=google_vpc_access_connector.connector \
      -target=google_service_account.cloudrun_sa \
      -target=google_service_account.storage_sa \
      -target=google_project_iam_member.secret_accessor \
      -target=google_project_iam_member.artifact_reader \
      -target=google_project_iam_member.cloudsql_client \
      -target=google_storage_bucket.evidence_vault \
      -target=google_storage_hmac_key.s3_compat_key \
      -target=google_storage_bucket_iam_member.storage_admin \
      -target=google_artifact_registry_repository.docker_repo
    pass "Base Networking, Identity & Storage established"
  fi
  cd "$REPO_ROOT"
fi


# ─── Phase 3: Data Layer & Secrets (Cloud SQL & Secret Manager) ────────────────
if should_run_phase "db"; then
  step_header "3/8" "Data Layer & Secret Manager (Cloud SQL with Self-Healing)"
  
  # Step 3a: Run self-healing check on state
  heal_cloudsql_state_if_needed
  heal_secret_manager_state_if_needed

  cd "infra/terraform/envs/preprod"
  terraform init
  TF_VARS=$(get_tf_vars)

  if [ "$DRY_RUN" = true ]; then
    info "Executing dry-run plan for Cloud SQL & Secrets..."
    terraform plan $TF_VARS \
      -target=random_id.db_suffix \
      -target=random_password.db_password \
      -target=google_sql_database_instance.postgres \
      -target=google_sql_database.axiom_db \
      -target=google_sql_user.axiom_user \
      -target=google_secret_manager_secret.secret \
      -target=google_secret_manager_secret_version.version
  else
    info "Applying Cloud SQL PostgreSQL & Secret Manager..."
    terraform apply -auto-approve $TF_VARS \
      -target=random_id.db_suffix \
      -target=random_password.db_password \
      -target=google_sql_database_instance.postgres \
      -target=google_sql_database.axiom_db \
      -target=google_sql_user.axiom_user \
      -target=google_secret_manager_secret.secret \
      -target=google_secret_manager_secret_version.version
    
    DB_NAME=$(terraform state show google_sql_database_instance.postgres 2>/dev/null | grep '^[[:space:]]*name[[:space:]]*=' | head -n1 | cut -d'"' -f2 || echo "")
    DB_PUBLIC_IP=$(terraform output -raw cloud_sql_public_ip 2>/dev/null || echo "")
    pass "Cloud SQL Instance active: ${DB_NAME} (Public IP: ${DB_PUBLIC_IP:-pending})"
    pass "Secrets synchronized in Google Secret Manager"
  fi
  cd "$REPO_ROOT"
fi


# ─── Phase 4: Container Images (Build & Push to Artifact Registry) ─────────────
if should_run_phase "images"; then
  step_header "4/8" "Container Images (Artifact Registry)"
  if [ "$DRY_RUN" = true ]; then
    pass "Dry-run: skipping container image build and push"
  elif [ "$SKIP_BUILD" = true ]; then
    pass "Build skipped via --skip-build flag; using existing images in Artifact Registry"
  else
    info "Building and pushing container images to Artifact Registry..."
    FORCE_BUILD="$FORCE_BUILD" PUSH_IMAGES=true ./scripts/build-preprod-images.sh "${PROJECT_ID}" "${REGION}" "${IMAGE_TAG}"
    pass "Container images published to ${REGION}-docker.pkg.dev/${PROJECT_ID}/axiom-proof-preprod"
  fi
fi


# ─── Phase 5: Compute Layer (Cloud Run v2 Microservices) ───────────────────────
if should_run_phase "services"; then
  step_header "5/8" "Deploying Cloud Run v2 Microservices"
  cd "infra/terraform/envs/preprod"
  TF_VARS=$(get_tf_vars)

  if [ "$DRY_RUN" = true ]; then
    info "Executing dry-run plan for Cloud Run Microservices..."
    terraform plan $TF_VARS
  else
    info "Applying Cloud Run services and IAM bindings..."
    terraform apply -auto-approve $TF_VARS
    BFF_URL=$(terraform output -raw bff_url 2>/dev/null || echo "")
    WEB_URL=$(terraform output -raw web_url 2>/dev/null || echo "")
    pass "Cloud Run microservices successfully deployed"
  fi
  cd "$REPO_ROOT"
fi


# ─── Phase 6: Database Migrations & Statutory Controls Seeding ─────────────────
if should_run_phase "migrate"; then
  step_header "6/8" "Cloud SQL PostgreSQL Migrations & Control Library Seeding"
  if [ "$DRY_RUN" = true ]; then
    pass "Dry-run: skipping database migrations"
  elif [ "$SKIP_MIGRATE" = true ]; then
    pass "Migrations skipped via --skip-migrate flag"
  else
    cd "infra/terraform/envs/preprod"
    DB_PUBLIC_IP=$(terraform output -raw cloud_sql_public_ip 2>/dev/null || echo "")
    DB_PASSWORD=$(terraform output -raw db_password 2>/dev/null || echo "")
    cd "$REPO_ROOT"

    # Both branches used to warn and continue, so phase 8 could report a
    # healthy preprod on a database that had never been migrated — or had been
    # migrated by a script that swallowed its own failures. A deployment that
    # cannot migrate is a deployment that must stop.
    if [ -z "$DB_PUBLIC_IP" ] || [ -z "$DB_PASSWORD" ]; then
      fail "Cloud SQL address or password could not be read from Terraform outputs."
      echo "    The database phase must complete before migrations can run."
      echo "    Re-run with --from-phase db, or --skip-migrate to defer deliberately."
      exit 1
    fi

    CONN_STR="postgresql://axiom_admin:${DB_PASSWORD}@${DB_PUBLIC_IP}:5432/axiom_proof_preprod"
    info "Applying the migration series to Cloud SQL (${DB_PUBLIC_IP})..."
    SEED_ARGS=()
    [ "$SEED_IDENTITIES" = true ] && SEED_ARGS+=("--seed-identities")
    if ! ./scripts/migrate-cloudsql.sh "${SEED_ARGS[@]:-}" "$CONN_STR"; then
      fail "Migrations failed. The deployed services are running against an"
      echo "    unmigrated or partially migrated schema."
      echo "    If the connection was refused, add this host to the instance's"
      echo "    authorized networks; the runner records nothing on a failure, so"
      echo "    re-running after fixing access is safe."
      exit 1
    fi
    pass "Migration series applied"
  fi
fi


# ─── Phase 7: Firebase Static Marketing Site ──────────────────────────────────
if should_run_phase "firebase"; then
  step_header "7/8" "Google Firebase Static Hosting (Marketing)"
  if [ "$DRY_RUN" = true ]; then
    pass "Dry-run: skipping Firebase deployment"
  elif [ "$SKIP_FIREBASE" = true ]; then
    pass "Firebase deployment skipped via --skip-firebase flag"
  else
    info "Deploying marketing site to Firebase Hosting..."
    # Was `|| warn`, so a failed hosting deploy still reached the success
    # banner. Use --skip-firebase to leave it out deliberately.
    if ! ./scripts/deploy-firebase-marketing.sh "${PROJECT_ID}"; then
      fail "Firebase hosting deployment failed."
      echo "    Run 'firebase login' if this is a CLI authentication problem,"
      echo "    or pass --skip-firebase to deploy the backend without it."
      exit 1
    fi
  fi
fi


# ─── Phase 8: Verification & Health Probes ────────────────────────────────────
if should_run_phase "verify"; then
  step_header "8/8" "Readiness Verification & Health Probes"
  cd "infra/terraform/envs/preprod"
  BFF_URL=$(terraform output -raw bff_url 2>/dev/null || echo "")
  WEB_URL=$(terraform output -raw web_url 2>/dev/null || echo "")
  MARKETING_URL=$(terraform output -raw marketing_url 2>/dev/null || echo "")
  DB_PUBLIC_IP=$(terraform output -raw cloud_sql_public_ip 2>/dev/null || echo "")
  cd "$REPO_ROOT"

  # This phase printed "PIPELINE COMPLETE" unconditionally. An unreadable BFF
  # URL skipped the probe entirely, and a probe that exhausted all twelve
  # attempts simply fell out of the loop — both reached the same green banner.
  # The summary then printed a literal "<hash>" placeholder as though it were
  # a deployed URL. A verification phase that cannot fail verifies nothing.
  if [ "$DRY_RUN" = true ]; then
    pass "Dry-run: skipping live health probes"
  else
    if [ -z "$BFF_URL" ]; then
      fail "No BFF URL in Terraform outputs; the services phase has not completed."
      echo "    Re-run with --from-phase services."
      exit 1
    fi
    info "Probing Cloud Run BFF health endpoint (${BFF_URL}/health)..."
    healthy=false
    for _ in {1..12}; do
      if curl -fsS "${BFF_URL}/health" >/dev/null 2>&1; then healthy=true; break; fi
      sleep 3
    done
    if [ "$healthy" != true ]; then
      fail "The BFF did not report healthy after 12 attempts."
      echo "    The infrastructure exists but the service is not serving."
      echo "    Check: gcloud run services logs read axiom-bff-${ENV} --region ${REGION}"
      exit 1
    fi
    pass "Cloud Run BFF is responsive and healthy"
  fi

  echo -e "\n${BOLD}${GREEN}=================================================================${NC}"
  echo -e "${BOLD}${GREEN}  ✓ PREPROD DEPLOYMENT PIPELINE COMPLETE!                        ${NC}"
  echo -e "${BOLD}${GREEN}=================================================================${NC}"
  # No placeholder fallbacks: an address that was never read is reported as
  # unavailable, not as a plausible-looking URL.
  echo -e "  Web Workbench:       ${CYAN}${WEB_URL:-"(not available from Terraform outputs)"}${NC}"
  echo -e "  API Layer (BFF):     ${CYAN}${BFF_URL}${NC}"
  echo -e "  Cloud SQL IP:        ${CYAN}${DB_PUBLIC_IP:-"(not available from Terraform outputs)"}${NC}"
  echo -e "  Marketing Site:      ${CYAN}https://${PROJECT_ID}.web.app${NC}${MARKETING_URL:+ / ${CYAN}${MARKETING_URL}}${NC}\n"
  echo -e "  ${BOLD}Run Live Functional Flow:${NC}"
  echo -e "  ${CYAN}./scripts/run-preprod-flow.sh \"${BFF_URL}\"${NC}\n"
fi

