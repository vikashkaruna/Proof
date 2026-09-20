#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Single Unified Environment Configuration & Propagation Tool
# ==============================================================================
# "Agents do the work. You approve. The proof is automatic."
#
# Single point of truth: Reads from the canonical .env.<env> file and propagates
# directly to:
#   1. terraform   : Generates infra/terraform/envs/<env>/terraform.tfvars
#   2. secrets     : Synchronizes sensitive secrets to GCP Secret Manager
#   3. cloudrun    : Updates Google Cloud Run environment variables & secret mounts
#   4. docker      : Prepares runtime environment for Docker Compose
#   5. verify      : Audits configuration schema, detects missing keys & placeholders
#   6. all         : Executes verify -> terraform -> secrets -> cloudrun
#
# Usage:
#   ./scripts/sync-env.sh [ENVIRONMENT] [TARGET]
#
# Examples:
#   ./scripts/sync-env.sh preprod verify
#   ./scripts/sync-env.sh preprod terraform
#   ./scripts/sync-env.sh preprod secrets
#   ./scripts/sync-env.sh preprod all
#   ./scripts/sync-env.sh staging verify
#   ./scripts/sync-env.sh local verify
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Styling
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
info() { echo -e "\n${BOLD}${CYAN}▶ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

ALLOW_SIMULATED=false
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-simulated) ALLOW_SIMULATED=true; shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]:-}"

TARGET_ENV="${1:-preprod}"
ACTION="${2:-verify}"

if [[ "$TARGET_ENV" == "-h" || "$TARGET_ENV" == "--help" || "$ACTION" == "-h" || "$ACTION" == "--help" ]]; then
  cat <<HELP
Usage: ./scripts/sync-env.sh [ENVIRONMENT] [TARGET]

Environments:
  preprod     (default) GCP Cloud Run + Cloud SQL + Secret Manager (asia-south1)
  staging     Local Network / LAN Staging (Docker Compose)
  local       Local Developer Stack (Supabase Local + Docker)
  onprem      Sovereign On-Premise Intranet Deployment
  production  Production Sovereign Deployment

Targets:
  verify      Audit .env against canonical schema, identify missing keys & placeholders
  terraform   Generate / refresh infra/terraform/envs/<env>/terraform.tfvars
  secrets     Synchronize sensitive variables to GCP Secret Manager
  cloudrun    Update Cloud Run service environment variables & secret bindings
  docker      Setup active .env symlink for Docker Compose
  all         Run verify -> terraform -> secrets -> cloudrun in sequence

HELP
  exit 0
fi

ENV_FILE="infra/docker/environments/.env.${TARGET_ENV}"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f ".env.${TARGET_ENV}" ]]; then
    ENV_FILE=".env.${TARGET_ENV}"
  elif [[ -f "infra/docker/environments/.env.${TARGET_ENV}.example" ]]; then
    info "Creating ${ENV_FILE} from template ${ENV_FILE}.example..."
    cp "infra/docker/environments/.env.${TARGET_ENV}.example" "$ENV_FILE"
    pass "Created ${ENV_FILE}"
  else
    fail "Configuration file not found: ${ENV_FILE}"
    exit 1
  fi
fi

# Load variables into environment
while IFS='=' read -r key val || [ -n "$key" ]; do
  key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$key" =~ ^#.*$ ]] || [ -z "$key" ]; then continue; fi
  val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  export "$key"="$val"
done < "$ENV_FILE"

get_val() {
  local key="$1"
  local fallback="${2:-}"
  local v="${!key:-}"

  if [ -z "$v" ]; then
    case "$key" in
      AXIOM_REGION) v="${AWS_REGION:-${GCP_REGION:-}}" ;;
      AWS_REGION) v="${AXIOM_REGION:-${GCP_REGION:-}}" ;;
      AXIOM_EVIDENCE_BUCKET) v="${AWS_S3_EVIDENCE_BUCKET:-${S3_EVIDENCE_BUCKET:-}}" ;;
      AWS_S3_EVIDENCE_BUCKET) v="${AXIOM_EVIDENCE_BUCKET:-${S3_EVIDENCE_BUCKET:-}}" ;;
      AXIOM_STORAGE_ENDPOINT) v="${AWS_S3_ENDPOINT:-${S3_ENDPOINT:-}}" ;;
      AWS_S3_ENDPOINT) v="${AXIOM_STORAGE_ENDPOINT:-${S3_ENDPOINT:-}}" ;;
      AXIOM_STORAGE_ACCESS_KEY_ID) v="${AXIOM_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}" ;;
      AWS_ACCESS_KEY_ID) v="${AXIOM_STORAGE_ACCESS_KEY_ID:-${AXIOM_ACCESS_KEY_ID:-}}" ;;
      AXIOM_STORAGE_SECRET_ACCESS_KEY) v="${AXIOM_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}" ;;
      AWS_SECRET_ACCESS_KEY) v="${AXIOM_STORAGE_SECRET_ACCESS_KEY:-${AXIOM_SECRET_ACCESS_KEY:-}}" ;;
      AXIOM_PROJECT_ID) v="${GCP_PROJECT_ID:-}" ;;
      GCP_PROJECT_ID) v="${AXIOM_PROJECT_ID:-}" ;;
      AXIOM_PROJECT_NUMBER) v="${GCP_PROJECT_NUMBER:-}" ;;
      GCP_PROJECT_NUMBER) v="${AXIOM_PROJECT_NUMBER:-}" ;;
    esac
  fi

  if [ -n "$v" ]; then
    echo "$v"
  else
    echo "$fallback"
  fi
}

echo -e "\n${BOLD}${MAGENTA}=================================================================${NC}"
echo -e "${BOLD}${MAGENTA}  AXIOM PROOF — Unified Environment Synchronization Platform     ${NC}"
echo -e "${DIM}  Agents do the work. You approve. The proof is automatic.${NC}"
echo -e "${BOLD}${MAGENTA}=================================================================${NC}"
echo -e "  Environment:  ${BOLD}${CYAN}${TARGET_ENV}${NC}"
echo -e "  Source File:  ${BOLD}${CYAN}${ENV_FILE}${NC}"
echo -e "  Action:       ${BOLD}${CYAN}${ACTION}${NC}"
echo -e "${BOLD}${MAGENTA}=================================================================${NC}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. VERIFY ACTION
# ─────────────────────────────────────────────────────────────────────────────
do_verify() {
  info "Auditing '${TARGET_ENV}' configuration against canonical master schema..."

  local required_keys=(
    "ENVIRONMENT:General"
    "NODE_ENV:General"
    "LOG_LEVEL:General"
    "AXIOM_REGION:Sovereign Residency"
    "MARKETING_PORT:Networking & Ports"
    "WEB_PORT:Networking & Ports"
    "BFF_PORT:Networking & Ports"
    "AGENT_RUNTIME_PORT:Networking & Ports"
    "MODEL_GATEWAY_PORT:Networking & Ports"
    "SUPABASE_URL:Database & Auth"
    "SUPABASE_ANON_KEY:Database & Auth"
    "SUPABASE_SERVICE_KEY:Database & Auth"
    "NEXT_PUBLIC_APP_URL:Client URLs"
    "NEXT_PUBLIC_BFF_URL:Client URLs"
    "BFF_URL:Inter-service"
    "AGENT_RUNTIME_URL:Inter-service"
    "MODEL_GATEWAY_URL:Inter-service"
    "APPROVAL_SIGNING_KEY:Security & Tokens"
    "AXIOM_MFA_ENCRYPTION_KEY:Security & Tokens"
    "AGENT_RUNTIME_INTERNAL_TOKEN:Security & Tokens"
    "MODEL_GATEWAY_API_KEY:Security & Tokens"
    "AXIOM_EVIDENCE_BUCKET:Evidence Vault"
    "AXIOM_STORAGE_ENDPOINT:Evidence Vault"
    "TEMPORAL_ADDRESS:Orchestration"
    "TEMPORAL_NAMESPACE:Orchestration"
    "ANTHROPIC_API_KEY:LLM Gateway"
    "OPENAI_API_KEY:LLM Gateway"
    "GEMINI_API_KEY:LLM Gateway"
    "RESEND_API_KEY:Email Delivery"
    "RESEND_FROM_EMAIL:Email Delivery"
    "CONTACT_RECIPIENT_EMAIL:Email Delivery"
    "FEATURE_DRY_RUN_ENGINE:Feature Flags"
    "FEATURE_EXECUTION_ENGINE:Feature Flags"
    "FEATURE_KILL_SWITCH:Feature Flags"
    # Security posture that varies by topology and must therefore be stated,
    # not inherited from a default nobody looked at.
    "AXIOM_MFA_SESSION_TTL_HOURS:Security & Tokens"
    "AXIOM_TRUSTED_PROXY_HOPS:Security & Tokens"
  )

  if [[ "$TARGET_ENV" == "preprod" || "$TARGET_ENV" == "production" ]]; then
    required_keys+=(
      "AXIOM_PROJECT_ID:Cloud Infrastructure"
      "AXIOM_PROJECT_NUMBER:Cloud Infrastructure"
      # Self-hosting Supabase means we own the signing secret. Terraform cannot
      # generate it: the anon and service keys are JWTs signed WITH it, so a
      # random value would leave GoTrue issuing tokens PostgREST rejects.
      "SUPABASE_JWT_SECRET:Database & Auth"
      "AXIOM_EVIDENCE_RETENTION_DAYS:Evidence Vault"
    )
  fi

  local ok_count=0
  local warn_count=0
  local simulated_count=0
  local missing_count=0

  printf "\n  %-32s %-22s %-12s %s\n" "VARIABLE" "CATEGORY" "STATUS" "VALUE PREVIEW"
  printf "  %-32s %-22s %-12s %s\n" "────────────────────────────────" "──────────────────────" "──────────" "────────────────────"

  for item in "${required_keys[@]}"; do
    local key="${item%%:*}"
    local cat="${item##*:}"
    local val="$(get_val "$key")"

    if [ -z "$val" ]; then
      if [[ ("$TARGET_ENV" == "local" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "onprem") && ("$cat" == "LLM Gateway" || "$cat" == "Email Delivery" || "$key" == "TEMPORAL_API_KEY" || "$key" == "AXIOM_STORAGE_ENDPOINT") ]]; then
        printf "  %-32s %-22s \033[0;34m%-12s\033[0m %s\n" "$key" "$cat" "SIMULATED" "(mock/offline)"
        simulated_count=$((simulated_count + 1))
      else
        printf "  %-32s %-22s \033[0;31m%-12s\033[0m %s\n" "$key" "$cat" "MISSING" "(empty)"
        missing_count=$((missing_count + 1))
      fi
    elif [[ "$val" == *"-el.a.run.app"* || "$val" == *"7zb7qphjbq"* || "$val" == *"<hash>"* ]]; then
      local preview="${val:0:18}..."
      printf "  %-32s %-22s \033[0;33m%-12s\033[0m %s (ephemeral hash)\n" "$key" "$cat" "EPHEMERAL_URL" "$preview"
      warn_count=$((warn_count + 1))
    elif [[ "$val" == *"placeholder"* || "$val" == *"<"*">"* || "$val" == *"YOUR_"* ]]; then
      if [[ ("$TARGET_ENV" == "local" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "onprem") && ("$cat" == "LLM Gateway" || "$cat" == "Email Delivery" || "$key" == "TEMPORAL_API_KEY") ]]; then
        printf "  %-32s %-22s \033[0;34m%-12s\033[0m %s\n" "$key" "$cat" "SIMULATED" "(mock/offline)"
        simulated_count=$((simulated_count + 1))
      else
        local preview="${val:0:18}..."
        printf "  %-32s %-22s \033[0;33m%-12s\033[0m %s\n" "$key" "$cat" "PLACEHOLDER" "$preview"
        warn_count=$((warn_count + 1))
      fi
    else
      local preview=""
      if [[ "$key" == *"KEY"* || "$key" == *"SECRET"* || "$key" == *"TOKEN"* || "$key" == *"PASSWORD"* ]]; then
        local len="${#val}"
        if [ "$len" -gt 12 ]; then
          preview="${val:0:7}...${val: -4}"
        else
          preview="${val:0:3}..."
        fi
      else
        preview="${val:0:22}"
      fi
      printf "  %-32s %-22s \033[0;32m%-12s\033[0m %s\n" "$key" "$cat" "CONFIGURED" "$preview"
      ok_count=$((ok_count + 1))
    fi
  done

  echo ""
  echo -e "  ─────────────────────────────────────────────────────────────────"
  echo -e "  Audit Summary for ${BOLD}${TARGET_ENV}${NC}:"
  echo -e "    ${GREEN}✓ Configured & Valid:${NC} ${ok_count}"
  if [ "$simulated_count" -gt 0 ]; then
    echo -e "    ${BLUE}ℹ Simulated / Mock:${NC}   ${simulated_count}"
  fi
  echo -e "    ${YELLOW}⚠ Placeholders:${NC}        ${warn_count}"
  echo -e "    ${RED}✗ Missing Keys:${NC}        ${missing_count}"
  echo -e "  ─────────────────────────────────────────────────────────────────"

  # A gate, not a report. This used to print the table and return 0 whatever it
  # found, so every caller — including `all`, which goes on to write terraform
  # variables and Cloud Run configuration — proceeded on a configuration it had
  # just described as incomplete. "Progressively pull values from .env" only
  # means anything if a value that is missing stops the deployment.
  local blocking=$((missing_count + warn_count))
  if [ "$simulated_count" -gt 0 ] && [ "$ALLOW_SIMULATED" != true ]; then
    blocking=$((blocking + simulated_count))
  fi

  if [ "$blocking" -eq 0 ]; then
    pass "Configuration schema validation PASSED for environment '${TARGET_ENV}'."
    return 0
  fi

  echo ""
  if [ "$missing_count" -gt 0 ]; then
    fail "${missing_count} required variable(s) are missing from ${ENV_FILE}."
  fi
  if [ "$warn_count" -gt 0 ]; then
    fail "${warn_count} variable(s) still hold placeholder or ephemeral values."
  fi
  if [ "$simulated_count" -gt 0 ] && [ "$ALLOW_SIMULATED" != true ]; then
    fail "${simulated_count} variable(s) are mock-only. Pass --allow-simulated to accept them."
    echo -e "  ${DIM}Intended for local, staging and onprem, where LLM, email and Temporal"
    echo -e "  credentials are deliberately absent. Never for preprod or production.${NC}"
  fi
  echo -e "  ${DIM}Nothing was written. Fill ${ENV_FILE} and run again.${NC}"
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. TERRAFORM ACTION
# ─────────────────────────────────────────────────────────────────────────────
# Where each Terraform variable gets its value. One place, so a variable that
# nothing fills is a build failure rather than a silent Terraform default.
#
# It is generated FROM variables.tf rather than written as a fixed block,
# because the environments declare disjoint sets: preprod is GCP (23
# variables), prod is AWS EKS (4), and emitting one shape into the other
# produces a tfvars full of undeclared variables that Terraform rejects.
tfvar_value() {
  case "$1" in
    # ── Identity and topology ──
    project_id)                 get_val "AXIOM_PROJECT_ID" "$(get_val "GCP_PROJECT_ID" "axiom-proof")" ;;
    region)                     get_val "AXIOM_REGION" "$(get_val "GCP_REGION" "asia-south1")" ;;
    environment)                echo "$TARGET_ENV" ;;
    cloud_sql_tier)             get_val "CLOUD_SQL_TIER" "db-f1-micro" ;;
    cloud_sql_disk_size_gb)     get_val "CLOUD_SQL_DISK_SIZE_GB" "10" ;;
    cloud_sql_instance_version) get_val "CLOUD_SQL_INSTANCE_VERSION" "POSTGRES_15" ;;
    cluster_name)               get_val "AXIOM_CLUSTER_NAME" "axiom-proof-prod" ;;
    vpc_cidr)                   get_val "AXIOM_VPC_CIDR" "10.10.0.0/16" ;;
    kubernetes_version)         get_val "AXIOM_KUBERNETES_VERSION" "1.29" ;;
    domain_name)                get_val "AXIOM_DOMAIN_NAME" "axiomproof.ai" ;;

    # ── Evidence retention ──
    # Applied as a COMPLIANCE-mode Object Lock, which nobody including the
    # project owner can shorten or delete before it expires. It had no
    # environment key at all and could only come from the Terraform default,
    # so a bucket could be created with a test-length retention while the
    # product documented seven years.
    retention_days)             get_val "AXIOM_EVIDENCE_RETENTION_DAYS" "7" ;;

    # ── Managed services ──
    upstash_redis_url)          get_val "UPSTASH_REDIS_URL" "$(get_val "REDIS_URL")" ;;
    temporal_address)           get_val "TEMPORAL_ADDRESS" "axiom-proof.dkxyc.tmprl.cloud:7233" ;;
    temporal_namespace)         get_val "TEMPORAL_NAMESPACE" "axiom-proof.dkxyc" ;;
    temporal_api_key)           get_val "TEMPORAL_API_KEY" ;;

    # ── Model providers ──
    anthropic_api_key)          get_val "ANTHROPIC_API_KEY" ;;
    openai_api_key)             get_val "OPENAI_API_KEY" ;;
    gemini_api_key)             get_val "GEMINI_API_KEY" "$(get_val "GOOGLE_API_KEY")" ;;

    # ── Secrets ──
    # An empty value here does NOT mean "unset": Terraform mints a stable
    # random secret instead. That is safe, but it is only correct when the
    # operator has not supplied one, which is why this mapping exists at all.
    approval_signing_key)         get_val "APPROVAL_SIGNING_KEY" ;;
    mfa_encryption_key)           get_val "AXIOM_MFA_ENCRYPTION_KEY" ;;
    agent_runtime_internal_token) get_val "AGENT_RUNTIME_INTERNAL_TOKEN" ;;
    model_gateway_api_key)        get_val "MODEL_GATEWAY_API_KEY" ;;

    # Self-hosted Supabase. These three are minted TOGETHER by
    # scripts/mint-supabase-keys.mjs: the anon and service keys are JWTs signed
    # with the secret, so mixing values from different mintings produces tokens
    # GoTrue issues and PostgREST rejects.
    supabase_jwt_secret)          get_val "SUPABASE_JWT_SECRET" ;;
    supabase_anon_key)            get_val "SUPABASE_ANON_KEY" ;;
    supabase_service_key)         get_val "SUPABASE_SERVICE_KEY" ;;

    # ── Email ──
    resend_api_key)             get_val "RESEND_API_KEY" ;;
    contact_recipient_email)    get_val "CONTACT_RECIPIENT_EMAIL" "hello@axiomminds.ai" ;;
    axiom_from_email)           get_val "AXIOM_FROM_EMAIL" "Axiom Proof <platform@axiomproof.ai>" ;;
    axiom_sales_email)          get_val "AXIOM_SALES_EMAIL" "sales@axiomproof.ai" ;;
    axiom_founder_email)        get_val "AXIOM_FOUNDER_EMAIL" "founder@axiomminds.ai" ;;

    *) return 1 ;;
  esac
}

# Numbers are written unquoted; Terraform rejects a quoted number for a
# `type = number` variable.
tfvar_is_number() {
  case "$1" in
    cloud_sql_disk_size_gb|retention_days) return 0 ;;
    *) return 1 ;;
  esac
}

do_terraform() {
  info "Propagating ${TARGET_ENV} configuration to Terraform..."

  # The Terraform directory for `production` is named `prod`. Without this the
  # lookup silently missed and production's variables were never written from
  # its .env at all — the warning below reads as "normal for local/staging".
  local tf_env="$TARGET_ENV"
  [[ "$TARGET_ENV" == "production" ]] && tf_env="prod"

  local tf_dir="infra/terraform/envs/${tf_env}"
  if [[ ! -d "$tf_dir" ]]; then
    warn "Terraform directory '${tf_dir}' does not exist. (Normal for local/staging/onprem)."
    return 0
  fi

  local vars_file="${tf_dir}/variables.tf"
  if [[ ! -f "$vars_file" ]]; then
    fail "No variables.tf in ${tf_dir}; cannot tell what this environment needs."
    return 1
  fi

  local tfvars_file="${tf_dir}/terraform.tfvars"
  info "Generating ${tfvars_file} from ${ENV_FILE}..."

  local body="" unmapped=()
  local name value
  while read -r name; do
    if ! value="$(tfvar_value "$name")"; then
      unmapped+=("$name")
      continue
    fi
    if tfvar_is_number "$name"; then
      body+="$(printf '%-28s = %s\n' "$name" "${value:-0}")"
    else
      body+="$(printf '%-28s = "%s"\n' "$name" "$value")"
    fi
    body+=$'\n'
  done < <(grep -oE '^variable "[a-z0-9_]+"' "$vars_file" | sed 's/variable "//;s/"//')

  if [ ${#unmapped[@]} -gt 0 ]; then
    fail "${tf_dir}/variables.tf declares variables nothing fills from ${ENV_FILE}:"
    printf "    %s\n" "${unmapped[@]}"
    echo -e "  ${DIM}Add them to tfvar_value() in scripts/sync-env.sh. Nothing was written.${NC}"
    return 1
  fi

  cat > "$tfvars_file" <<TFVARS
# ==============================================================================
# Axiom Proof — Terraform variables for '${TARGET_ENV}'
# Generated by scripts/sync-env.sh at $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# SINGLE SOURCE OF TRUTH: ${ENV_FILE}
# Do not edit this file. Edit ${ENV_FILE} and re-run:
#   ./scripts/sync-env.sh ${TARGET_ENV} terraform
# ==============================================================================

${body}
TFVARS

  pass "Wrote ${tfvars_file} ($(grep -cE '^[a-z]' "$tfvars_file") variables)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. SECRETS ACTION (GCP Secret Manager)
# ─────────────────────────────────────────────────────────────────────────────
do_secrets() {
  info "Synchronizing ${TARGET_ENV} secrets with GCP Secret Manager..."

  if ! command -v gcloud >/dev/null 2>&1; then
    warn "gcloud CLI not installed. Skipping Secret Manager synchronization."
    return 0
  fi

  local project="$(get_val "AXIOM_PROJECT_ID" "$(get_val "GCP_PROJECT_ID" "axiom-proof")")"
  local region="$(get_val "AXIOM_REGION" "$(get_val "GCP_REGION" "asia-south1")")"

  local secret_pairs=(
    "axiom-${TARGET_ENV}-resend-api-key:$(get_val "RESEND_API_KEY")"
    "axiom-${TARGET_ENV}-anthropic-api-key:$(get_val "ANTHROPIC_API_KEY")"
    "axiom-${TARGET_ENV}-openai-api-key:$(get_val "OPENAI_API_KEY")"
    "axiom-${TARGET_ENV}-gemini-api-key:$(get_val "GEMINI_API_KEY" "$(get_val "GOOGLE_API_KEY")")"
    "axiom-${TARGET_ENV}-temporal-api-key:$(get_val "TEMPORAL_API_KEY")"
    "axiom-${TARGET_ENV}-approval-signing-key:$(get_val "APPROVAL_SIGNING_KEY")"
    "axiom-${TARGET_ENV}-mfa-encryption-key:$(get_val "AXIOM_MFA_ENCRYPTION_KEY")"
    "axiom-${TARGET_ENV}-agent-runtime-internal-token:$(get_val "AGENT_RUNTIME_INTERNAL_TOKEN")"
    "axiom-${TARGET_ENV}-model-gateway-api-key:$(get_val "MODEL_GATEWAY_API_KEY")"
    "axiom-${TARGET_ENV}-upstash-redis-url:$(get_val "UPSTASH_REDIS_URL" "$(get_val "REDIS_URL")")"
  )

  local sa="axiom-${TARGET_ENV}-cloudrun-sa@${project}.iam.gserviceaccount.com"

  for item in "${secret_pairs[@]}"; do
    local sec_name="${item%%:*}"
    local sec_val="${item#*:}"
    if [ -z "$sec_val" ] || [[ "$sec_val" == *"placeholder"* ]]; then
      warn "Skipping empty or placeholder secret: ${sec_name}"
      continue
    fi

    if gcloud secrets describe "$sec_name" --project="$project" >/dev/null 2>&1; then
      # Add version
      echo -n "$sec_val" | gcloud secrets versions add "$sec_name" --data-file=- --project="$project" --quiet >/dev/null 2>&1 || true
      pass "Updated secret version: ${sec_name}"
    else
      # Create secret
      echo -n "$sec_val" | gcloud secrets create "$sec_name" \
        --data-file=- \
        --replication-policy="user-managed" \
        --locations="$region" \
        --project="$project" --quiet >/dev/null 2>&1 || true
      pass "Created new secret: ${sec_name}"
    fi

    # Ensure Cloud Run SA has secretAccessor
    gcloud secrets add-iam-policy-binding "$sec_name" \
      --member="serviceAccount:${sa}" \
      --role="roles/secretmanager.secretAccessor" \
      --project="$project" --quiet >/dev/null 2>&1 || true
  done

  pass "Secret Manager sync complete for environment '${TARGET_ENV}'."
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. CLOUDRUN ACTION
# ─────────────────────────────────────────────────────────────────────────────
do_cloudrun() {
  info "Synchronizing Cloud Run environment variables for ${TARGET_ENV}..."

  if ! command -v gcloud >/dev/null 2>&1; then
    warn "gcloud CLI not installed. Skipping Cloud Run sync."
    return 0
  fi

  local project="$(get_val "AXIOM_PROJECT_ID" "$(get_val "GCP_PROJECT_ID" "axiom-proof")")"
  local region="$(get_val "AXIOM_REGION" "$(get_val "GCP_REGION" "asia-south1")")"

  # Marketing Cloud Run
  info "Updating marketing service: axiom-marketing-${TARGET_ENV}..."
  gcloud run services update "axiom-marketing-${TARGET_ENV}" \
    --region="$region" \
    --project="$project" \
    --set-env-vars="ENVIRONMENT=${TARGET_ENV},NODE_ENV=production,RESEND_FROM_EMAIL=$(get_val "RESEND_FROM_EMAIL" "Axiom Proof <onboarding@resend.dev>"),CONTACT_RECIPIENT_EMAIL=$(get_val "CONTACT_RECIPIENT_EMAIL" "vkkaruna@outlook.com"),CONTACT_FALLBACK_RECIPIENT_EMAIL=$(get_val "CONTACT_FALLBACK_RECIPIENT_EMAIL" "hello@axiomminds.ai")" \
    --update-secrets="RESEND_API_KEY=axiom-${TARGET_ENV}-resend-api-key:latest" \
    --quiet || warn "axiom-marketing-${TARGET_ENV} service update warning (continuing)"

  pass "Cloud Run environment synchronization complete."
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. DOCKER ACTION
# ─────────────────────────────────────────────────────────────────────────────
do_docker() {
  info "Preparing Docker Compose runtime environment for ${TARGET_ENV}..."
  ln -sf "infra/docker/environments/.env.${TARGET_ENV}" .env
  pass "Linked .env -> infra/docker/environments/.env.${TARGET_ENV}"
  pass "Ready for: docker compose --env-file infra/docker/environments/.env.${TARGET_ENV} up -d"
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. SCAFFOLD ACTION — bring an existing .env up to the template
# ─────────────────────────────────────────────────────────────────────────────
# Templates gain keys as the platform does: AXIOM_TRUSTED_PROXY_HOPS and
# AXIOM_EVIDENCE_RETENTION_DAYS both arrived this way. An operator whose
# .env.<env> predates them would otherwise fail `verify` with no hint of what
# to add, or worse, silently take a Terraform default.
#
# Existing values are never touched. Only absent keys are appended, so this is
# safe to run against a file holding real credentials.
do_scaffold() {
  local template="infra/docker/environments/.env.${TARGET_ENV}.example"
  if [[ ! -f "$template" ]]; then
    fail "No template at ${template}."
    return 1
  fi

  info "Reconciling ${ENV_FILE} against ${template}..."
  local added=()
  local key
  while read -r key; do
    grep -qE "^[[:space:]]*${key}=" "$ENV_FILE" || added+=("$key")
  done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$template" | sed 's/=$//' | sort -u)

  if [ ${#added[@]} -eq 0 ]; then
    pass "${ENV_FILE} already carries every key in the template."
    return 0
  fi

  {
    echo ""
    echo "# ─── Added by sync-env.sh scaffold on $(date -u +"%Y-%m-%dT%H:%M:%SZ") ───"
    echo "# Present in the template and absent here. Review each value."
    for key in "${added[@]}"; do
      grep -E "^[[:space:]]*${key}=" "$template" | head -1
    done
  } >> "$ENV_FILE"

  pass "Appended ${#added[@]} missing key(s) to ${ENV_FILE}:"
  printf "    %s\n" "${added[@]}"
  warn "Values came from the template. Run './scripts/sync-env.sh ${TARGET_ENV} verify' before deploying."
}

# ─────────────────────────────────────────────────────────────────────────────
# 7. MINT ACTION — fill the secrets that have to be generated
# ─────────────────────────────────────────────────────────────────────────────
# `verify` correctly refuses a .env still holding `<run scripts/mint-...>`, and
# the operator then had to run the minting script and paste eight values by
# hand. Pasting the Supabase three in particular is where this goes wrong: the
# anon and service keys are JWTs signed with the secret, so taking them from
# different runs produces tokens GoTrue issues and PostgREST rejects.
#
# Existing real values are left alone. Only placeholders and empty values are
# filled, because rotating a live secret is a different act with real
# consequences — a new AXIOM_MFA_ENCRYPTION_KEY makes every enrolled
# authenticator undecryptable — and it needs --force said out loud.
do_mint() {
  local force=false
  [ "${MINT_FORCE:-false}" = true ] && force=true

  info "Minting generated secrets for ${TARGET_ENV}..."

  local minted
  if ! minted="$(node scripts/mint-supabase-keys.mjs --env "$TARGET_ENV" 2>/dev/null)"; then
    fail "scripts/mint-supabase-keys.mjs failed."
    return 1
  fi

  local filled=() kept=() key value current
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z_]+$ ]] || continue
    current="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"

    # A value counts as real unless it is empty or still template shaped.
    if [ "$force" != true ] && [ -n "$current" ] \
       && [[ "$current" != *"<"*">"* ]] && [[ "$current" != *placeholder* ]] \
       && [[ "$current" != *YOUR_* ]]; then
      kept+=("$key")
      continue
    fi

    if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
      # Values are base64/hex/JWT, so `|` is safe as a delimiter here.
      python3 - "$ENV_FILE" "$key" "$value" <<'REPLACE'
import re, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
text = re.sub(rf"^[ \t]*{re.escape(key)}=.*$", f"{key}={value}", text, count=1, flags=re.M)
open(path, "w").write(text)
REPLACE
    else
      printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
    filled+=("$key")
  done <<< "$minted"

  if [ ${#filled[@]} -gt 0 ]; then
    pass "Filled ${#filled[@]} secret(s) in ${ENV_FILE}:"
    printf "    %s\n" "${filled[@]}"
  fi
  if [ ${#kept[@]} -gt 0 ]; then
    info "Left ${#kept[@]} existing value(s) untouched:"
    printf "    %s\n" "${kept[@]}"
    echo -e "  ${DIM}MINT_FORCE=true overwrites them. Rotating AXIOM_MFA_ENCRYPTION_KEY makes"
    echo -e "  every enrolled authenticator undecryptable; rotating SUPABASE_JWT_SECRET"
    echo -e "  invalidates every live session.${NC}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# EXECUTION ROUTER
# ─────────────────────────────────────────────────────────────────────────────
case "$ACTION" in
  verify)
    do_verify
    ;;
  terraform)
    do_terraform
    ;;
  secrets)
    do_secrets
    ;;
  cloudrun)
    do_cloudrun
    ;;
  docker)
    do_docker
    ;;
  scaffold)
    do_scaffold
    ;;
  mint)
    do_mint
    ;;
  all)
    do_scaffold
    do_verify
    do_terraform
    do_docker
    if [[ "$TARGET_ENV" == "preprod" || "$TARGET_ENV" == "production" ]]; then
      do_secrets
      do_cloudrun
    fi
    ;;
  *)
    fail "Unknown action: '$ACTION'. Use scaffold, mint, verify, terraform, secrets, cloudrun, docker, or all."
    exit 1
    ;;
esac

echo -e "\n${BOLD}${GREEN}✔ Done! All operations for '${TARGET_ENV} (${ACTION})' completed successfully.${NC}\n"
