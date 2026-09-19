#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — Deploy Marketing Site to Google Firebase Static Hosting
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT_ID="${1:-${GCP_PROJECT_ID:-axiom-proof}}"

echo "================================================================="
echo "  Deploying Axiom Proof Marketing to Firebase Static Hosting     "
echo "  Target Project: ${PROJECT_ID}"
echo "================================================================="

echo "1. Building static export for @axiom/marketing..."
if [ -d "apps/marketing/src/app/api" ]; then
  mv "apps/marketing/src/app/api" "apps/marketing/src/app/_api_temp"
fi
if [ -d "apps/marketing/src/app/gap-scan/report" ]; then
  mv "apps/marketing/src/app/gap-scan/report" "apps/marketing/src/app/gap-scan/_report_temp"
fi

BUILD_SUCCESS=0
if pnpm --filter @axiom/marketing build:export; then
  BUILD_SUCCESS=1
fi

if [ -d "apps/marketing/src/app/_api_temp" ]; then
  mv "apps/marketing/src/app/_api_temp" "apps/marketing/src/app/api"
fi
if [ -d "apps/marketing/src/app/gap-scan/_report_temp" ]; then
  mv "apps/marketing/src/app/gap-scan/_report_temp" "apps/marketing/src/app/gap-scan/report"
fi

if [ "$BUILD_SUCCESS" -ne 1 ]; then
  echo "Error: Static export failed!"
  exit 1
fi

if [ ! -d "apps/marketing/out" ]; then
  echo "Error: apps/marketing/out directory was not created!"
  exit 1
fi

echo "2. Deploying to Firebase Hosting site: axiom-proof..."
if command -v firebase >/dev/null 2>&1; then
  firebase deploy --only hosting --project "${PROJECT_ID}"
else
  echo "Firebase CLI not found globally. Running via npx..."
  npx -y firebase-tools@latest deploy --only hosting --project "${PROJECT_ID}"
fi

echo "✓ Firebase static deployment complete!"
