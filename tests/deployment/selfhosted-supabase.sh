#!/usr/bin/env bash
# W0.1 — the self-hosted Supabase topology preprod will run.
#
# The founder's decision is that higher environments self-host Supabase Auth
# and PostgREST against their own Postgres rather than using Supabase Cloud, so
# that preprod is a real replica of production and no third-party processor
# sits in the data path.
#
# That shape had never been exercised the way a deployment builds it. The
# committed compose file mounts the migration series into the database image's
# `docker-entrypoint-initdb.d`, which is a local convenience that does not
# exist on Cloud SQL. A deployment instead starts an empty managed database,
# applies the series over the network, and only then points GoTrue and
# PostgREST at it. The risk is entirely in that ordering: migration 0000
# creates the `auth` schema and Supabase's roles itself, and GoTrue runs its
# own migrations over the same schema when it starts.
#
# So this builds it the way a deployment does and proves the parts agree:
# a user can be created through GoTrue, the token it issues is accepted by
# PostgREST, and RLS answers that token as itself rather than as a superuser.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET="axiom-selfhosted-$$"
DB="axiom-sh-db-$$"
AUTH="axiom-sh-auth-$$"
REST="axiom-sh-rest-$$"
GW="axiom-sh-gw-$$"
PG_IMAGE="${AXIOM_TEST_POSTGRES_IMAGE:-supabase/postgres:17.6.1.127}"
GOTRUE_IMAGE="${AXIOM_TEST_GOTRUE_IMAGE:-supabase/gotrue:v2.169.0}"
REST_IMAGE="${AXIOM_TEST_POSTGREST_IMAGE:-postgrest/postgrest:v12.2.8}"

cleanup() {
  for c in "$GW" "$REST" "$AUTH" "$DB"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for image in "$PG_IMAGE" "$GOTRUE_IMAGE" "$REST_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
done

docker network create "$NET" >/dev/null

# ─── Secrets, minted exactly as a deployment mints them ──────────────
# One secret signs in GoTrue and validates in PostgREST. They were two
# different hardcoded values once, which meant no token GoTrue issued could
# ever be accepted; nothing noticed because authentication was bypassed.
eval "$(node scripts/mint-supabase-keys.mjs --env selfhosted-test | grep -E '^(SUPABASE_JWT_SECRET|SUPABASE_ANON_KEY|SUPABASE_SERVICE_KEY)=')"
[ -n "${SUPABASE_JWT_SECRET:-}" ] || { echo 'FAIL: no JWT secret minted'; exit 1; }
[ -n "${SUPABASE_ANON_KEY:-}" ] || { echo 'FAIL: no anon key minted'; exit 1; }
echo '  ✓ Minted a JWT secret and its anon/service keys'

# ─── An empty managed database, as Cloud SQL is ──────────────────────
DB_PASSWORD='sh-test-password'
docker run --rm -d --name "$DB" --network "$NET" -p 127.0.0.1:0:5432 \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$DB" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DB" pg_isready -h 127.0.0.1 -U postgres >/dev/null
DB_PORT="$(docker port "$DB" 5432/tcp | head -1 | sed 's/.*://')"
docker exec "$DB" createdb -U postgres -T template0 axiom_selfhosted

HOST_DSN="postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/axiom_selfhosted?sslmode=disable"
NET_DSN="postgresql://postgres:${DB_PASSWORD}@${DB}:5432/axiom_selfhosted?sslmode=disable"
echo '  ✓ Empty database started'

# ─── Roles and an empty auth schema, then GoTrue, then the series ────
# The order is the finding. Running our series first gives GoTrue an
# `auth.users` it did not create, and its own migration chain then fails
# partway having already created sixteen tables.
PGPASSWORD="$DB_PASSWORD" psql -w "$HOST_DSN" -v ON_ERROR_STOP=1 -q -f infra/supabase/bootstrap-selfhosted.sql
echo '  ✓ Roles and an empty auth schema created'

# ─── GoTrue owns `auth` ──────────────────────────────────────────────
# search_path=auth is not optional. GoTrue's MFA migration creates the
# `factor_type` and `factor_status` enums UNQUALIFIED, so without it they land
# in `public` and a later migration dies on
# `type "auth.factor_type" does not exist`.
docker run -d --name "$AUTH" --network "$NET" \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="${NET_DSN}&search_path=auth" \
  -e GOTRUE_SITE_URL=http://localhost:3000 \
  -e GOTRUE_URI_ALLOW_LIST=http://localhost:3000 \
  -e GOTRUE_JWT_SECRET="$SUPABASE_JWT_SECRET" \
  -e GOTRUE_JWT_EXP=3600 \
  -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=false \
  -e GOTRUE_DISABLE_SIGNUP=true \
  -e API_EXTERNAL_URL=http://localhost:9999 \
  "$GOTRUE_IMAGE" >/dev/null

gotrue_ready=false
for _ in $(seq 1 90); do
  if docker logs "$AUTH" 2>&1 | grep -q 'GoTrue API started'; then gotrue_ready=true; break; fi
  if docker logs "$AUTH" 2>&1 | grep -q '"level":"fatal"'; then break; fi
  sleep 1
done
if [ "$gotrue_ready" != true ]; then
  echo 'FAIL: GoTrue did not complete its own migrations'
  docker logs "$AUTH" 2>&1 | grep -oE '"level":"fatal"[^,]*,"msg":"[^"]{0,200}' | head -3
  exit 1
fi
migration_count="$(PGPASSWORD="$DB_PASSWORD" psql -w "$HOST_DSN" -Atqc 'select count(*) from auth.schema_migrations')"
[ "$migration_count" -gt 50 ] || { echo "FAIL: GoTrue recorded only ${migration_count} migrations"; exit 1; }
echo "  ✓ GoTrue applied its own ${migration_count} migrations and owns the auth schema"

# The enums must be in `auth`, not `public`. This is the assertion that fails
# if search_path is ever dropped from the connection string.
enum_schema="$(PGPASSWORD="$DB_PASSWORD" psql -w "$HOST_DSN" -Atqc \
  "select n.nspname from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='factor_type'")"
[ "$enum_schema" = "auth" ] || { echo "FAIL: factor_type was created in '${enum_schema}', not auth"; exit 1; }
echo '  ✓ GoTrue created its enums in auth, not public'

# ─── Our series, over GoTrue's schema ────────────────────────────────
python3 scripts/migrate-database.py --dsn "$HOST_DSN" >/dev/null
echo '  ✓ Migration series applied over the network on top of GoTrue'"'"'s auth schema'

# Cloud SQL does not grant the superuser-only BYPASSRLS attribute. A
# Supabase image may carry it already; explicitly remove it in this rehearsal.
docker exec "$DB" psql -X -U supabase_admin -d axiom_selfhosted -v ON_ERROR_STOP=1 -q -c "alter role service_role nobypassrls;"
PGPASSWORD="$DB_PASSWORD" psql -w "$HOST_DSN" -v ON_ERROR_STOP=1 -q <<'SQL'
insert into public.tenants(id, slug, name) values
 ('00000000-0000-4000-8000-0000000000f1', 'selfhosted-positive', 'Service access fixture');
SQL

docker run --rm -d --name "$REST" --network "$NET" \
  -e PGRST_DB_URI="$NET_DSN" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$SUPABASE_JWT_SECRET" \
  "$REST_IMAGE" >/dev/null

# The single origin SUPABASE_URL points at, mirroring docker-compose.supabase.yml.
GW_CONF="$(mktemp)"
cat > "$GW_CONF" <<'NGINX'
server {
    listen 80;
    client_max_body_size 50M;
    location /rest/v1/ { proxy_pass http://REST_HOST:3000/; proxy_set_header Host $host; }
    location /auth/v1/ { proxy_pass http://AUTH_HOST:9999/; proxy_set_header Host $host; }
}
NGINX
sed -i.bak "s/REST_HOST/${REST}/; s/AUTH_HOST/${AUTH}/" "$GW_CONF"
docker run --rm -d --name "$GW" --network "$NET" -p 127.0.0.1:0:80 \
  -v "${GW_CONF}:/etc/nginx/conf.d/default.conf:ro" nginx:alpine >/dev/null
GW_PORT="$(docker port "$GW" 80/tcp | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:${GW_PORT}"

ready=false
for _ in $(seq 1 60); do
  if curl -fsS "${BASE}/auth/v1/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo 'FAIL: the gateway never reached GoTrue'
  docker logs "$GW" 2>&1 | tail -15
  exit 1
fi
echo '  ✓ One origin serves both /auth/v1 and /rest/v1'

# ─── A real sign-up, and a token PostgREST accepts ───────────────────
EMAIL="selfhosted-$$@test.invalid"
PUBLIC_SIGNUP_BODY="$(mktemp)"
SIGNUP_STATUS="$(curl -s -o "$PUBLIC_SIGNUP_BODY" -w '%{http_code}' -X POST "${BASE}/auth/v1/signup" \
  -H 'Content-Type: application/json' -d "{\"email\":\"${EMAIL}\",\"password\":\"SelfHosted@123456\"}")"
SIGNUP_ERROR="$(python3 - "$PUBLIC_SIGNUP_BODY" <<'PYCODE'
import json, sys
with open(sys.argv[1]) as f: print(json.load(f).get('error_code', ''))
PYCODE
)"
rm -f "$PUBLIC_SIGNUP_BODY"
[ "$SIGNUP_ERROR" = "signup_disabled" ] || { echo "FAIL: public registration was not explicitly disabled (${SIGNUP_STATUS}, ${SIGNUP_ERROR})"; exit 1; }
# The operator explicitly provisions a synthetic confirmed test account.
curl -fsS -X POST "${BASE}/auth/v1/admin/users" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H 'Content-Type: application/json' \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"SelfHosted@123456\",\"email_confirm\":true}" >/dev/null
SIGNUP="$(curl -fsS -X POST "${BASE}/auth/v1/token?grant_type=password" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"SelfHosted@123456\"}")"

ACCESS_TOKEN="$(printf '%s' "$SIGNUP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))')"
[ -n "$ACCESS_TOKEN" ] || { echo 'FAIL: sign-up returned no access token'; exit 1; }
echo '  ✓ Public registration refused; admin-provisioned user signs in with real GoTrue'

# The defect this pairing exists to catch: one secret signs, the other
# validates. A mismatch makes every issued token unusable.
BODY_FILE="$(mktemp)"
CODE="$(curl -s -o "$BODY_FILE" -w '%{http_code}' "${BASE}/rest/v1/tenants?select=id&limit=1" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${ACCESS_TOKEN}")"
if [ "$CODE" != "200" ]; then
  echo "FAIL: PostgREST rejected GoTrue's token (HTTP ${CODE})"
  echo "  response: $(head -c 400 "$BODY_FILE")"
  docker logs "$REST" 2>&1 | tail -10
  rm -f "$BODY_FILE"
  exit 1
fi
rm -f "$BODY_FILE"
echo '  ✓ PostgREST accepted the token GoTrue signed'

# Empty denial checks are vacuous unless privileged access to an existing
# row works. The BFF uses this service JWT for its authoritative queries.
SERVICE_ROWS="$(curl -fsS "${BASE}/rest/v1/tenants?select=id" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
[ "$SERVICE_ROWS" = "1" ] || { echo "FAIL: service role read ${SERVICE_ROWS} rows; expected the known tenant without BYPASSRLS"; exit 1; }
echo '  ✓ Service role reads known application data without BYPASSRLS'

SERVICE_WRITE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/rest/v1/tenants" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H 'Content-Type: application/json' \
  -d '{"id":"00000000-0000-4000-8000-0000000000f2","slug":"service-write","name":"Service write fixture"}')"
[ "$SERVICE_WRITE" = "201" ] || { echo "FAIL: service-role write was refused (${SERVICE_WRITE})"; exit 1; }
echo '  ✓ Service role can persist application data without BYPASSRLS'

# ─── RLS answers the token as itself ─────────────────────────────────
# A brand-new user belongs to no tenant. Migration 0016 made every tenant read
# membership-bound, so the honest answer is an empty set. A non-empty one here
# would mean the request was being served with more authority than the token
# carries.
ROWS="$(curl -fsS "${BASE}/rest/v1/tenants?select=id" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
[ "$ROWS" = "0" ] || { echo "FAIL: a user with no membership read ${ROWS} tenant row(s)"; exit 1; }
echo '  ✓ RLS returned nothing to a user who belongs to no tenant'

# And an anonymous caller is not quietly upgraded.
ANON_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/rest/v1/tenants?select=id" \
  -H "apikey: ${SUPABASE_ANON_KEY}")"
[ "$ANON_CODE" = "200" ] || [ "$ANON_CODE" = "401" ] || {
  echo "FAIL: unexpected status for an anonymous read (HTTP ${ANON_CODE})"; exit 1; }
if [ "$ANON_CODE" = "200" ]; then
  ANON_ROWS="$(curl -fsS "${BASE}/rest/v1/tenants?select=id" -H "apikey: ${SUPABASE_ANON_KEY}" \
    | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
  [ "$ANON_ROWS" = "0" ] || { echo "FAIL: anonymous read returned ${ANON_ROWS} row(s)"; exit 1; }
fi
echo '  ✓ An anonymous caller reads nothing'

rm -f "$GW_CONF" "${GW_CONF}.bak"
echo 'Self-hosted Supabase: GoTrue owns auth and runs FIRST, the series applies over it,'
echo 'one secret signs and validates, and RLS holds for both an authenticated and an anonymous caller.'
