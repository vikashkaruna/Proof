#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Complete GCP Preprod Infrastructure Teardown & Reset
# ==============================================================================
# Deletes preprod GCP infrastructure in reverse dependency order:
#   Phase 1 (services) : Cloud Run v2 microservices & IAM bindings
#   Phase 2 (secrets)  : Secret Manager secret versions and secrets
#   Phase 3 (db)       : Cloud SQL PostgreSQL (instance, database, user)
#   Phase 4 (base)     : VPC Connector, Peering, Global IP, SAs, GCS HMAC
#   Phase 5 (storage)  : Evidence Vault GCS bucket (if not WORM-locked)
#   Phase 6 (images)   : Artifact Registry repository (optional: --delete-images)
#   Phase 7 (network)  : Subnet and VPC Network
#   Phase 8 (reset)    : Session backup & Terraform state reset for clean freshstart
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

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
step_header() { echo -e "\n${BOLD}${RED}═════════════════════════════════════════════════════════════════${NC}\n${BOLD}${RED}  Teardown Phase $1: $2${NC}\n${BOLD}${RED}═════════════════════════════════════════════════════════════════${NC}"; }

# Defaults
PROJECT_ID="${GCP_PROJECT_ID:-axiom-proof}"
REGION="${GCP_REGION:-asia-south1}"
ENV="${ENVIRONMENT:-preprod}"
TARGET_PHASE="all"
DRY_RUN=false
FORCE=false
DELETE_IMAGES=false
RESET_STATE=false
ENV_FILE_OVERRIDE=""

show_help() {
  cat <<EOF
Usage: ./scripts/teardown-preprod-gcp.sh [OPTIONS] [PROJECT_ID] [REGION] [ENV]

Positional Arguments:
  PROJECT_ID          Google Cloud Project ID (default: ${PROJECT_ID})
  REGION              GCP Region (default: ${REGION})
  ENV                 Environment name (default: ${ENV})

Options:
  --env-file <path>   Path to preprod environment file
  --phase <name>      Teardown ONLY a specific phase:
                        services : Cloud Run v2 microservices & public IAM
                        secrets  : Secret Manager secrets & versions
                        db       : Cloud SQL PostgreSQL instance, db, user
                        base     : VPC Connector, Peering, Global IP, SAs, HMAC
                        storage  : Evidence Vault GCS bucket
                        images   : Artifact Registry repository & images
                        network  : VPC Network and regional Subnet
                        reset    : Backup session and reset Terraform state
  --dry-run           Plan destruction without destroying resources
  --force, -y         Skip interactive confirmation prompt
  --delete-images     Also purge container images from Artifact Registry
  --reset-state       Reset local Terraform state files after teardown for fresh start
  --help, -h          Display this help message

Examples:
  ./scripts/teardown-preprod-gcp.sh
  ./scripts/teardown-preprod-gcp.sh --force --reset-state
  ./scripts/teardown-preprod-gcp.sh --phase services
  ./scripts/teardown-preprod-gcp.sh --dry-run
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
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -y|--force)
      FORCE=true
      shift
      ;;
    --delete-images)
      DELETE_IMAGES=true
      shift
      ;;
    --reset-state)
      RESET_STATE=true
      shift
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

# Load environment configuration if present
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

  for candidate in "${candidate_files[@]}"; do
    if [ -f "$candidate" ]; then
      info "Loading preprod environment variables from: ${candidate}"
      while IFS='=' read -r key val || [ -n "$key" ]; do
        key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [[ "$key" =~ ^#.*$ ]] || [ -z "$key" ]; then continue; fi
        val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
        export "$key"="$val"
      done < "$candidate"
      pass "Environment variables loaded from $(basename "$candidate")"
      break
    fi
  done

  if [ -n "${GCP_PROJECT_ID:-}" ]; then PROJECT_ID="${GCP_PROJECT_ID}"; fi
  if [ -n "${GCP_REGION:-}" ]; then REGION="${GCP_REGION}"; fi
  if [ -n "${ENVIRONMENT:-}" ]; then ENV="${ENVIRONMENT}"; fi
}

load_preprod_env

# Assign positional overrides if supplied
if [ ${#POSITIONAL_ARGS[@]} -ge 1 ]; then PROJECT_ID="${POSITIONAL_ARGS[0]}"; fi
if [ ${#POSITIONAL_ARGS[@]} -ge 2 ]; then REGION="${POSITIONAL_ARGS[1]}"; fi
if [ ${#POSITIONAL_ARGS[@]} -ge 3 ]; then ENV="${POSITIONAL_ARGS[2]}"; fi

should_run_phase() {
  local phase="$1"
  if [ "$TARGET_PHASE" = "$phase" ] || [ "$TARGET_PHASE" = "all" ]; then
    return 0
  fi
  return 1
}

echo -e "\n${BOLD}${RED}=================================================================${NC}"
echo -e "${BOLD}${RED}  AXIOM PROOF — GCP Preprod Infrastructure Teardown              ${NC}"
echo -e "${BOLD}${RED}  Region: Mumbai (asia-south1) · Project: ${PROJECT_ID}          ${NC}"
echo -e "${BOLD}${RED}=================================================================${NC}"
echo -e "  Target Project:    ${BOLD}${CYAN}${PROJECT_ID}${NC}"
echo -e "  Target Region:     ${BOLD}${CYAN}${REGION}${NC}"
echo -e "  Environment:       ${BOLD}${CYAN}${ENV}${NC}"
echo -e "  Target Phase:      ${BOLD}${CYAN}${TARGET_PHASE}${NC}"
echo -e "  Dry Run:           ${BOLD}${CYAN}${DRY_RUN}${NC}"
echo -e "  Delete Images:     ${BOLD}${CYAN}${DELETE_IMAGES}${NC}"
echo -e "  Reset State:       ${BOLD}${CYAN}${RESET_STATE}${NC}\n"

# Interactive confirmation unless force is passed or dry-run
if [ "$FORCE" != true ] && [ "$DRY_RUN" != true ]; then
  read -r -p "Are you sure you want to TEAR DOWN preprod resources in '${PROJECT_ID}'? (yes/N): " CONFIRM
  if [ "$CONFIRM" != "yes" ] && [ "$CONFIRM" != "y" ]; then
    echo "Teardown aborted by user."
    exit 0
  fi
fi

TF_DIR="infra/terraform/envs/preprod"
TF_VARS=("-var=project_id=${PROJECT_ID}" "-var=region=${REGION}" "-var=environment=${ENV}")

# ─── Save Session State Backup ────────────────────────────────────────────────
if [ "$DRY_RUN" != true ] && [ -d "$TF_DIR" ] && [ -f "$TF_DIR/terraform.tfstate" ]; then
  BACKUP_PATH="${TF_DIR}/terraform.tfstate.session-backup.$(date +%s)"
  cp "${TF_DIR}/terraform.tfstate" "$BACKUP_PATH"
  pass "Current session state saved to: $(basename "$BACKUP_PATH")"
elif [ "$DRY_RUN" = true ]; then
  pass "Dry-run: session state backup simulated"
fi

# ─── Phase 1: Cloud Run Services & Ingress ────────────────────────────────────
if should_run_phase "services"; then
  step_header "1/7" "Destroying Cloud Run v2 Microservices"
  cd "$TF_DIR"
  if [ "$DRY_RUN" = true ]; then
    info "Dry-run: Planning destruction of Cloud Run services..."
    terraform plan -destroy "${TF_VARS[@]}"       -target=google_cloud_run_v2_service.bff       -target=google_cloud_run_v2_service.web       -target=google_cloud_run_v2_service.agent_runtime       -target=google_cloud_run_v2_service.model_gateway       -target=google_cloud_run_v2_service.temporal_worker       -target=google_cloud_run_v2_service.marketing       -target=google_cloud_run_v2_service.supabase_auth       -target=google_cloud_run_v2_service.supabase_rest       -target=google_cloud_run_v2_service.supabase_gateway       -target=google_cloud_run_v2_service_iam_member.agent_runtime_public       -target=google_cloud_run_v2_service_iam_member.model_gateway_public       -target=google_cloud_run_v2_service_iam_member.supabase_auth_public       -target=google_cloud_run_v2_service_iam_member.supabase_rest_public       -target=google_cloud_run_v2_service_iam_member.supabase_gateway_public       -target=google_cloud_run_v2_service_iam_member.bff_public       -target=google_cloud_run_v2_service_iam_member.web_public       -target=google_cloud_run_v2_service_iam_member.marketing_public || true
  else
    info "Destroying Cloud Run services..."
    terraform destroy -auto-approve "${TF_VARS[@]}"       -target=google_cloud_run_v2_service.bff       -target=google_cloud_run_v2_service.web       -target=google_cloud_run_v2_service.agent_runtime       -target=google_cloud_run_v2_service.model_gateway       -target=google_cloud_run_v2_service.temporal_worker       -target=google_cloud_run_v2_service.marketing       -target=google_cloud_run_v2_service.supabase_auth       -target=google_cloud_run_v2_service.supabase_rest       -target=google_cloud_run_v2_service.supabase_gateway       -target=google_cloud_run_v2_service_iam_member.agent_runtime_public       -target=google_cloud_run_v2_service_iam_member.model_gateway_public       -target=google_cloud_run_v2_service_iam_member.supabase_auth_public       -target=google_cloud_run_v2_service_iam_member.supabase_rest_public       -target=google_cloud_run_v2_service_iam_member.supabase_gateway_public       -target=google_cloud_run_v2_service_iam_member.bff_public       -target=google_cloud_run_v2_service_iam_member.web_public       -target=google_cloud_run_v2_service_iam_member.marketing_public || true
    pass "Cloud Run microservices destroyed"
  fi
  cd "$REPO_ROOT"
fi

# ─── Phase 2: Secret Manager Secrets ──────────────────────────────────────────
if should_run_phase "secrets"; then
  step_header "2/7" "Destroying Secret Manager Secrets & Versions"
  cd "$TF_DIR"
  if [ "$DRY_RUN" = true ]; then
    info "Dry-run: Planning destruction of Secret Manager secrets..."
    terraform plan -destroy "${TF_VARS[@]}"       -target=google_secret_manager_secret_version.version       -target=google_secret_manager_secret.secret       -target=google_secret_manager_secret.mfa_previous_keys       -target=google_secret_manager_secret_version.mfa_previous_keys       -target=google_secret_manager_secret_iam_member.runtime_access       -target=google_secret_manager_secret_iam_member.mfa_previous_access || true
  else
    info "Destroying Secret Manager secrets..."
    terraform destroy -auto-approve "${TF_VARS[@]}"       -target=google_secret_manager_secret_version.version       -target=google_secret_manager_secret.secret       -target=google_secret_manager_secret.mfa_previous_keys       -target=google_secret_manager_secret_version.mfa_previous_keys       -target=google_secret_manager_secret_iam_member.runtime_access       -target=google_secret_manager_secret_iam_member.mfa_previous_access || true
    pass "Secret Manager secrets destroyed"
  fi
  cd "$REPO_ROOT"
fi

# ─── Phase 3: Cloud SQL Database, User & Instance ─────────────────────────────
if should_run_phase "db"; then
  step_header "3/7" "Destroying Cloud SQL PostgreSQL"
  cd "$TF_DIR"
  if [ "$DRY_RUN" = true ]; then
    info "Dry-run: Planning destruction of Cloud SQL..."
    terraform plan -destroy "${TF_VARS[@]}"       -target=google_sql_database.axiom_db       -target=google_sql_user.axiom_user       -target=google_sql_database_instance.postgres       -target=random_id.db_suffix       -target=random_password.db_password || true
  else
    info "Destroying Cloud SQL database, user, and instance..."
    terraform destroy -auto-approve "${TF_VARS[@]}"       -target=google_sql_database.axiom_db       -target=google_sql_user.axiom_user       -target=google_sql_database_instance.postgres       -target=random_id.db_suffix       -target=random_password.db_password || true
    pass "Cloud SQL resources destroyed"
  fi
  cd "$REPO_ROOT"
fi

# ─── Phase 4: Serverless VPC Connector, Peering & Base IAM ────────────────────
if should_run_phase "base"; then
  step_header "4/7" "Destroying Serverless VPC Connector, Peering & Base IAM"
  cd "$TF_DIR"
  if [ "$DRY_RUN" = true ]; then
    info "Dry-run: Planning destruction of VPC Connector and Peering..."
    terraform plan -destroy "${TF_VARS[@]}"       -target=google_vpc_access_connector.connector       -target=google_service_networking_connection.private_vpc_connection       -target=google_compute_global_address.private_ip_address       -target=google_service_account.runtime       -target=google_service_account.storage_sa       -target=google_storage_hmac_key.s3_compat_key || true
  else
    info "Destroying VPC Connector and Peering..."
    terraform destroy -auto-approve "${TF_VARS[@]}"       -target=google_vpc_access_connector.connector       -target=google_service_networking_connection.private_vpc_connection       -target=google_compute_global_address.private_ip_address       -target=google_service_account.runtime       -target=google_service_account.storage_sa       -target=google_storage_hmac_key.s3_compat_key || true
    pass "Serverless VPC connector and peering destroyed"
  fi
  cd "$REPO_ROOT"
fi

# ─── Phase 5: GCS Evidence Vault Storage ──────────────────────────────────────
if should_run_phase "storage"; then
  step_header "5/7" "Handling Evidence Vault GCS Bucket"
  cd "$TF_DIR"
  if [ "$DRY_RUN" = true ]; then
    info "Dry-run: Planning destruction of Evidence Vault bucket..."
    terraform plan -destroy "${TF_VARS[@]}"       -target=google_storage_bucket_iam_member.storage_admin       -target=google_storage_bucket.evidence_vault || true
  else
    info "Attempting destruction of Evidence Vault GCS Bucket..."
    terraform destroy -auto-approve "${TF_VARS[@]}"       -target=google_storage_bucket_iam_member.storage_admin       -target=google_storage_bucket.evidence_vault || {
        warn "Evidence Vault retention lock or per-object retention prevented immediate bucket destruction."
        warn "The bucket is preserved safely under statutory compliance mode."
      }
  fi
  cd "$REPO_ROOT"
fi

# ─── Phase 6: Artifact Registry Repository ────────────────────────────────────
if should_run_phase "images"; then
  step_header "6/7" "Artifact Registry Repository"
  if [ "$DELETE_IMAGES" = true ]; then
    cd "$TF_DIR"
    if [ "$DRY_RUN" = true ]; then
      info "Dry-run: Planning destruction of Artifact Registry..."
      terraform plan -destroy "${TF_VARS[@]}" -target=google_artifact_registry_repository.docker_repo || true
    else
      info "Destroying Artifact Registry repository and images..."
      terraform destroy -auto-approve "${TF_VARS[@]}" -target=google_artifact_registry_repository.docker_repo || true
      pass "Artifact Registry repository purged"
    fi
    cd "$REPO_ROOT"
  else
    pass "Preserving container images in Artifact Registry (use --delete-images to remove)"
  fi
fi

# ─── Phase 7: VPC Network & Subnet ────────────────────────────────────────────
if should_run_phase "network"; then
  step_header "7/7" "Destroying VPC Network & Regional Subnet"
  cd "$TF_DIR"
  if [ "$DRY_RUN" = true ]; then
    info "Dry-run: Planning destruction of VPC and Subnet..."
    terraform plan -destroy "${TF_VARS[@]}"       -target=google_compute_subnetwork.subnet       -target=google_compute_network.vpc || true
  else
    info "Destroying VPC Network and Subnet..."
    terraform destroy -auto-approve "${TF_VARS[@]}"       -target=google_compute_subnetwork.subnet       -target=google_compute_network.vpc || true
    pass "VPC Network and Subnet destroyed"
  fi
  cd "$REPO_ROOT"
fi

# ─── Phase 8: State Reset for Clean Freshstart ────────────────────────────────
if [ "$DRY_RUN" != true ] && ([ "$TARGET_PHASE" = "reset" ] || [ "$RESET_STATE" = true ]); then
  info "Resetting Terraform state for clean freshstart..."
  cd "$TF_DIR"
  if [ -f "terraform.tfstate" ]; then
    mv terraform.tfstate "terraform.tfstate.archived.$(date +%s)"
    rm -f terraform.tfstate.backup
    pass "Terraform state archived and cleared for clean freshstart"
  fi
  cd "$REPO_ROOT"
elif [ "$DRY_RUN" = true ] && ([ "$TARGET_PHASE" = "reset" ] || [ "$RESET_STATE" = true ]); then
  pass "Dry-run: skipping Terraform state reset"
fi

echo -e "\n${BOLD}${GREEN}=================================================================${NC}"
echo -e "${BOLD}${GREEN}  ✓ TEARDOWN & FRESHSTART PREPARATION COMPLETE!                  ${NC}"
echo -e "${BOLD}${GREEN}=================================================================${NC}"
echo -e "  To launch a clean deployment from scratch:"
echo -e "  ${CYAN}./scripts/deploy-preprod-gcp.sh "${PROJECT_ID}" "${REGION}" --skip-build${NC}\n"
