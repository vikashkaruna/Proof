#!/usr/bin/env bash
# Deploy the public static marketing pages; private routes stay on Cloud Run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/lib/ops-env.sh"

ENV_FILE="${AXIOM_ENV_FILE:-}"
BUILD_ONLY=false
EXPECTED_PROJECT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || { echo "error: --env-file needs a path" >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --build-only)
      BUILD_ONLY=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 --env-file <protected-file> [--build-only] [expected-project-id]"
      exit 0
      ;;
    -*)
      echo "error: unknown option $1" >&2
      exit 2
      ;;
    *)
      [ -z "$EXPECTED_PROJECT" ] || { echo "error: too many positional arguments" >&2; exit 2; }
      EXPECTED_PROJECT="$1"
      shift
      ;;
  esac
done

[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || {
  echo "error: an explicit protected --env-file or AXIOM_ENV_FILE is required" >&2
  exit 2
}
case "$ENV_FILE" in *.example) echo "error: template files cannot drive deployment" >&2; exit 2 ;; esac

# These deploy targets are file-owned. Ambient shell values must not retarget
# a Firebase deploy or change the public origins compiled into the client.
unset GCP_PROJECT_ID GCP_REGION FIREBASE_HOSTING_SITE_ID FIREBASE_MARKETING_SERVICE_ID
unset AXIOM_PROOF_MARKETING_URL AXIOM_PROOF_PLATFORM_URL ENVIRONMENT
ops_load_env_file "$ENV_FILE"
for name in GCP_PROJECT_ID GCP_REGION FIREBASE_HOSTING_SITE_ID FIREBASE_MARKETING_SERVICE_ID AXIOM_PROOF_MARKETING_URL AXIOM_PROOF_PLATFORM_URL ENVIRONMENT; do
  ops_require_value "$name"
done

[[ "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || {
  echo "error: invalid GCP_PROJECT_ID" >&2; exit 2;
}
[[ "$FIREBASE_HOSTING_SITE_ID" =~ ^[a-z][a-z0-9-]{3,28}[a-z0-9]$ ]] || {
  echo "error: invalid FIREBASE_HOSTING_SITE_ID" >&2; exit 2;
}
[[ "$FIREBASE_MARKETING_SERVICE_ID" =~ ^[a-z][a-z0-9-]{1,47}[a-z0-9]$ ]] || {
  echo "error: invalid FIREBASE_MARKETING_SERVICE_ID" >&2; exit 2;
}
[ "$GCP_REGION" = "asia-south1" ] || {
  echo "error: marketing Cloud Run rewrite must stay in asia-south1" >&2; exit 2;
}
case "$ENVIRONMENT" in
  preprod|production) ;;
  *) echo "error: marketing Hosting profile must be preprod or production" >&2; exit 2 ;;
esac
if [ -n "$EXPECTED_PROJECT" ] && [ "$EXPECTED_PROJECT" != "$GCP_PROJECT_ID" ]; then
  echo "error: positional project ID differs from the protected env file" >&2
  exit 2
fi

node --input-type=module <<'NODE'
for (const name of ['AXIOM_PROOF_MARKETING_URL', 'AXIOM_PROOF_PLATFORM_URL']) {
  const url = new URL(process.env[name]);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash) {
    throw new Error(`${name} must be a bare HTTPS origin`);
  }
}
if (process.env.ENVIRONMENT === 'preprod' &&
    process.env.AXIOM_PROOF_MARKETING_URL !== 'https://stg.axiomproof.ai') {
  throw new Error('Preprod marketing origin must be https://stg.axiomproof.ai');
}
if (process.env.ENVIRONMENT === 'production' &&
    process.env.AXIOM_PROOF_MARKETING_URL !== 'https://axiomproof.ai') {
  throw new Error('Production marketing origin must be https://axiomproof.ai');
}
NODE

mkdir -p "$REPO_ROOT/.axiom-runtime"
BUILD_DIR="$(mktemp -d "$REPO_ROOT/.axiom-runtime/marketing-export.XXXXXX")"
cleanup() {
  if [ "$BUILD_ONLY" = false ]; then rm -rf "$BUILD_DIR"; fi
}
trap cleanup EXIT

# Copy only the static app and its workspace sources. The original API and
# private report route never move, even if the build fails or is interrupted.
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json; do
  cp "$REPO_ROOT/$file" "$BUILD_DIR/$file"
done
mkdir -p "$BUILD_DIR/apps/marketing" "$BUILD_DIR/packages"
rsync -a --exclude 'node_modules/' --exclude '.next/' --exclude 'out/' --exclude '.env*' --exclude '*.test.ts' --exclude '*.test.tsx' --exclude '/src/app/api/' --exclude '/src/app/gap-scan/report/' "$REPO_ROOT/apps/marketing/" "$BUILD_DIR/apps/marketing/"
rsync -a --exclude 'node_modules/' --exclude 'dist/' "$REPO_ROOT/packages/" "$BUILD_DIR/packages/"
pnpm --dir "$BUILD_DIR" install --frozen-lockfile --filter @axiom/marketing...

AXIOM_STRICT_PUBLIC_URLS=1 AXIOM_PROOF_MARKETING_URL="$AXIOM_PROOF_MARKETING_URL" AXIOM_PROOF_PLATFORM_URL="$AXIOM_PROOF_PLATFORM_URL" NEXT_PUBLIC_APP_URL="$AXIOM_PROOF_PLATFORM_URL" pnpm --dir "$BUILD_DIR/apps/marketing" build:export
[ -f "$BUILD_DIR/apps/marketing/out/index.html" ] || {
  echo "error: isolated static export did not produce index.html" >&2
  exit 1
}

export BUILD_DIR
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const runtime = { serviceId: process.env.FIREBASE_MARKETING_SERVICE_ID,
                  region: process.env.GCP_REGION };
const security = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];
const config = {
  hosting: {
    site: process.env.FIREBASE_HOSTING_SITE_ID,
    public: join(process.env.BUILD_DIR, 'apps/marketing/out'),
    ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
    cleanUrls: true,
    trailingSlash: false,
    rewrites: [
      { source: '/api/**', run: runtime },
      { source: '/gap-scan/report/**', run: runtime },
    ],
    headers: [
      { source: '**', headers: security },
      { source: '/api/**', headers: [
        { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      ] },
      { source: '/gap-scan/report/**', headers: [
        { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      ] },
    ],
  },
};
writeFileSync(join(process.env.BUILD_DIR, 'firebase.json'), JSON.stringify(config, null, 2));
NODE

if [ "$BUILD_ONLY" = true ]; then
  echo "Static export and Firebase configuration prepared at: $BUILD_DIR"
  exit 0
fi

command -v firebase >/dev/null 2>&1 || {
  echo "error: Firebase CLI is required for deployment" >&2
  exit 1
}
cd "$BUILD_DIR"
firebase deploy --config "$BUILD_DIR/firebase.json" --only hosting \
  --project "$GCP_PROJECT_ID" --non-interactive
echo "Firebase marketing deploy complete for site $FIREBASE_HOSTING_SITE_ID."
