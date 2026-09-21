#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Preprod Container Image Builder & Artifact Registry Pusher
# ==============================================================================
# Usage:
#   ./scripts/build-preprod-images.sh [GCP_PROJECT_ID] [REGION] [TAG]
#
# Examples:
#   ./scripts/build-preprod-images.sh
#   ./scripts/build-preprod-images.sh my-gcp-project asia-south1 preprod
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT_ID="${1:-${GCP_PROJECT_ID:-axiom-proof}}"
REGION="${2:-${GCP_REGION:-asia-south1}}"
TAG="${3:-${IMAGE_TAG:-preprod}}"
REPO_NAME="axiom-proof-preprod"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}"

# Auto-load preprod environment if available
if [ -f "${REPO_ROOT}/infra/docker/environments/.env.preprod" ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ "$key" =~ ^#.*$ ]] || [ -z "$key" ]; then continue; fi
    val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    if [ -z "${!key:-}" ]; then export "$key"="$val"; fi
  done < "${REPO_ROOT}/infra/docker/environments/.env.preprod"
fi

echo "================================================================="
echo "  AXIOM PROOF — Preprod Container Image Builder                  "
echo "================================================================="
echo "  Project ID:      ${PROJECT_ID}"
echo "  Region:          ${REGION} (Mumbai)"
echo "  Artifact Target: ${REGISTRY}"
echo "  Image Tag:       ${TAG}"
echo "================================================================="

if ! docker info >/dev/null 2>&1; then
  if [ -d "/Applications/Docker.app" ]; then
    echo "⚠ Docker daemon not running. Launching Docker Desktop..."
    open -a Docker || true
    for i in {1..30}; do
      if docker info >/dev/null 2>&1; then break; fi
      sleep 2
    done
  fi
fi
docker info >/dev/null 2>&1 || { echo "✗ Docker daemon not running. Please start Docker."; exit 1; }

# Authenticate Docker with Google Artifact Registry if gcloud is installed
if command -v gcloud >/dev/null 2>&1; then
  echo "▶ Authenticating Docker with Artifact Registry..."
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet || true
fi

# Force target platform for Google Cloud Run (always requires linux/amd64)
export DOCKER_DEFAULT_PLATFORM="linux/amd64"

SERVICES=(
  "bff:infra/docker/Dockerfile.bff"
  "web:infra/docker/Dockerfile.web"
  "agent-runtime:infra/docker/Dockerfile.agent-runtime"
  "model-gateway:infra/docker/Dockerfile.model-gateway"
  "temporal-worker:infra/docker/Dockerfile.temporal-worker"
  "marketing:infra/docker/Dockerfile.marketing"
  # The Supabase API gateway. Self-hosting means something has to present
  # /auth/v1 and /rest/v1 on one origin, because supabase-js is given a single
  # base URL and appends those paths itself.
  "supabase-gateway:infra/docker/Dockerfile.supabase-gateway"
)

# Upstream images Cloud Run cannot pull directly — it serves from Artifact
# Registry or Container Registry only, not Docker Hub. Versions match
# docker-compose.supabase.yml so local and preprod run the same builds.
MIRRORED_IMAGES=(
  "gotrue:v2.169.0:supabase/gotrue:v2.169.0"
  "postgrest:v12.2.8:postgrest/postgrest:v12.2.8"
)

TARGET_SERVICE="${4:-${TARGET_SERVICE:-all}}"
FORCE_BUILD="${FORCE_BUILD:-false}"

for entry in "${SERVICES[@]}"; do
  SVC_NAME="${entry%%:*}"
  DOCKERFILE="${entry##*:}"
  IMAGE_URI="${REGISTRY}/axiom-${SVC_NAME}:${TAG}"
  LOCAL_TAG="axiom-${SVC_NAME}:${TAG}"

  if [ "$TARGET_SERVICE" != "all" ] && [ "$TARGET_SERVICE" != "$SVC_NAME" ]; then
    continue
  fi

  # Check if image already exists in Artifact Registry when force-build is not set
  if [ "$FORCE_BUILD" != "true" ] && command -v gcloud >/dev/null 2>&1; then
    if gcloud artifacts docker images describe "${IMAGE_URI}" >/dev/null 2>&1; then
      echo "  ✓ Image ${IMAGE_URI} already exists in Artifact Registry (skipping build; set FORCE_BUILD=true to rebuild)"
      continue
    fi
  fi

  BUILD_ARGS=()
  if [[ "$SVC_NAME" =~ ^(bff|web|marketing)$ ]] && [ -z "$(git status --porcelain --untracked-files=normal)" ]; then
    BUILD_ARGS+=(--build-arg "AXIOM_RELEASE_SHA=$(git rev-parse HEAD)")
  fi
  if [ "$SVC_NAME" = "marketing" ] || [ "$SVC_NAME" = "web" ]; then
    local_proj_num="${GCP_PROJECT_NUMBER:-}"
    if [ -z "$local_proj_num" ] && command -v gcloud >/dev/null 2>&1; then
      local_proj_num="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || echo "")"
    fi
    if [ -z "$local_proj_num" ]; then
      local_proj_num="188516662106"
    fi

    local_web_url="${NEXT_PUBLIC_APP_URL:-https://axiom-web-preprod-${local_proj_num}.${REGION}.run.app}"
    local_bff_url="${NEXT_PUBLIC_BFF_URL:-https://axiom-bff-preprod-${local_proj_num}.${REGION}.run.app}"

    BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_APP_URL=${local_web_url}" --build-arg "NEXT_PUBLIC_BFF_URL=${local_bff_url}")
  fi

  echo -e "\n▶ Building [${SVC_NAME}] using ${DOCKERFILE} (platform: linux/amd64)..."
  docker build --platform linux/amd64 --provenance=false ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} -f "${DOCKERFILE}" -t "${LOCAL_TAG}" -t "${IMAGE_URI}" .

  if [ "${PUSH_IMAGES:-false}" = "true" ] || [ "${1:-}" != "" ]; then
    echo "  Pushing ${IMAGE_URI}..."
    docker push "${IMAGE_URI}"
  fi
  echo "  ✓ Successfully built and pushed ${LOCAL_TAG}"
done

# ─── Mirror the upstream Supabase images ──────────────────────────────────────
if [ "$TARGET_SERVICE" = "all" ] || [ "$TARGET_SERVICE" = "supabase" ]; then
  for entry in "${MIRRORED_IMAGES[@]}"; do
    MIRROR_NAME="${entry%%:*}"
    rest="${entry#*:}"
    MIRROR_TAG="${rest%%:*}"
    UPSTREAM="${rest#*:}"
    MIRROR_URI="${REGISTRY}/${MIRROR_NAME}:${MIRROR_TAG}"

    if [ "$FORCE_BUILD" != "true" ] && command -v gcloud >/dev/null 2>&1; then
      if gcloud artifacts docker images describe "${MIRROR_URI}" >/dev/null 2>&1; then
        echo "  ✓ ${MIRROR_URI} already mirrored (set FORCE_BUILD=true to refresh)"
        continue
      fi
    fi

    echo -e "\n▶ Mirroring ${UPSTREAM} -> ${MIRROR_URI}..."
    docker pull --platform linux/amd64 "${UPSTREAM}"
    docker tag "${UPSTREAM}" "${MIRROR_URI}"
    if [ "${PUSH_IMAGES:-false}" = "true" ] || [ "${1:-}" != "" ]; then
      docker push "${MIRROR_URI}"
    fi
    echo "  ✓ Mirrored ${MIRROR_NAME}:${MIRROR_TAG}"
  done
fi

echo -e "\n================================================================="
echo "  ✓ Axiom Proof preprod images built and Supabase images mirrored"
echo "================================================================="
