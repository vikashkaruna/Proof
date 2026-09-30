#!/usr/bin/env bash
# Offline operator bootstrap. No image pulls, demo users, or silent WORM failures.
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
ENV_FILE="${AXIOM_ONPREM_ENV_FILE:-infra/docker/environments/.env.onprem}"
COMPOSE_FILE="infra/docker/docker-compose.onprem.yml"

for tool in docker python3 pnpm node; do
  command -v "$tool" >/dev/null || { echo "Missing required offline tool: $tool" >&2; exit 1; }
done
docker info >/dev/null
docker compose version >/dev/null
python3 scripts/onprem-preflight.py "$ENV_FILE" >/dev/null
read_env() {
  sed -n "s/^${1}=//p" "$ENV_FILE"
}
LICENSE="$(read_env AXIOM_OFFLINE_LICENSE)"
AXIOM_OFFLINE_LICENSE="$LICENSE" pnpm tsx scripts/verify-license.ts >/dev/null || {
  echo 'Offline license verification failed' >&2; exit 1;
}
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
"${COMPOSE[@]}" config --quiet
# Requiring every pinned image locally keeps this path genuinely air-gapped.
while IFS= read -r image; do
  docker image inspect "$image" >/dev/null || { echo "Offline image missing: $image" >&2; exit 1; }
done < <("${COMPOSE[@]}" config --images)

# GoTrue must own auth schema. Only roles/bootstrap SQL runs before it.
"${COMPOSE[@]}" up -d --no-deps --wait supabase-db
# An application database starts from template0; Auth owns its schema before
# Axiom's migration series runs.
if ! "${COMPOSE[@]}" exec -T supabase-db psql -X -U postgres -d postgres -Atqc \
  "select 1 from pg_database where datname='axiom_onprem'" | grep -qx 1; then
  "${COMPOSE[@]}" exec -T supabase-db createdb -U postgres -T template0 axiom_onprem
fi
"${COMPOSE[@]}" exec -T supabase-db psql -X -U postgres -d axiom_onprem -v ON_ERROR_STOP=1 -q \
  < infra/supabase/bootstrap-selfhosted.sql
REST_PASSWORD="$(read_env POSTGREST_DB_PASSWORD)"
printf "ALTER ROLE authenticator LOGIN PASSWORD '%s';\n" "$REST_PASSWORD" | \
  "${COMPOSE[@]}" exec -T supabase-db psql -X -U postgres -d axiom_onprem -v ON_ERROR_STOP=1 -q
"${COMPOSE[@]}" up -d --no-deps --wait supabase-auth
DB_CONTAINER="$("${COMPOSE[@]}" ps -q supabase-db)"
python3 scripts/migrate-database.py --container "$DB_CONTAINER" --user postgres --database axiom_onprem >/dev/null || {
  echo 'Checksummed migration failed' >&2; exit 1;
}
"${COMPOSE[@]}" up -d --no-deps supabase-rest supabase-gateway
# The reviewed BFF image carries the seed script and dependencies. Run it
# inside the egress-blocked sovereign network; no host DB/API port is needed.
"${COMPOSE[@]}" run --rm --no-deps --entrypoint /app/node_modules/.bin/tsx \
  bff /app/packages/control-library/scripts/seed.ts >/dev/null || {
  echo 'Control library seed failed' >&2; exit 1;
}
# No demo password installation, including on first boot.
"${COMPOSE[@]}" up -d --no-deps --wait minio
"${COMPOSE[@]}" run --rm --no-deps minio-init >/dev/null || {
  echo 'Compliance Object Lock provisioning/readback failed' >&2; exit 1;
}
"${COMPOSE[@]}" up -d --no-deps temporal-db redis model-gateway
"${COMPOSE[@]}" up -d --no-deps temporal
"${COMPOSE[@]}" up -d --no-deps agent-runtime bff temporal-worker web
printf 'On-prem bootstrap stages passed: license, local images, Auth ordering, checksummed migrations, control seed, and WORM default. Run persona and recovery acceptance before release.\n'
