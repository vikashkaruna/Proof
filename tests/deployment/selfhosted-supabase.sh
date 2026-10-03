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
eval "$(node scripts/mint-supabase-keys.mjs --env selfhosted-test | grep -E '^(SUPABASE_JWT_SECRET|SUPABASE_ANON_KEY|SUPABASE_SERVICE_KEY|SUPABASE_ARCHIVE_WRITER_KEY|SUPABASE_HUMAN_ACTION_WRITER_KEY|SUPABASE_AGENT_LEDGER_WRITER_KEY)=')"
[ -n "${SUPABASE_JWT_SECRET:-}" ] || { echo 'FAIL: no JWT secret minted'; exit 1; }
[ -n "${SUPABASE_ANON_KEY:-}" ] || { echo 'FAIL: no anon key minted'; exit 1; }
[ -n "${SUPABASE_HUMAN_ACTION_WRITER_KEY:-}" ] && [ -n "${SUPABASE_AGENT_LEDGER_WRITER_KEY:-}" ] && [ -n "${SUPABASE_ARCHIVE_WRITER_KEY:-}" ] || { echo 'FAIL: a scoped writer key was not minted'; exit 1; }
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

# Real PostgREST role-switch checks (not SQL-owner calls). A refusal must be
# exactly HTTP 403 (insufficient_privilege): 404 would also pass for a
# misspelt parameter and make every denial below vacuous, so each refusal is
# paired with a positive control that reaches the same function shape.
rpc_code() { # key function body -> HTTP status
  curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/rest/v1/rpc/$2" \
    -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -d "$3"
}
rpc_body() { # key function body -> response body (must be HTTP 200)
  curl -fsS -X POST "${BASE}/rest/v1/rpc/$2" \
    -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -d "$3"
}
expect_refused() { # label key function body
  local code; code="$(rpc_code "$2" "$3" "$4")"
  [ "$code" = "403" ] || { echo "FAIL: $1 (expected HTTP 403, got ${code})"; exit 1; }
}
expect_json_error() { # label expected response
  printf '%s' "$3" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("error") == sys.argv[1]' "$2" \
    || { echo "FAIL: $1 (response: $(printf '%s' "$3" | head -c 200))"; exit 1; }
}

# The shared agent/service JWT cannot forge an exported ledger receipt or an
# archive transition. Only the BFF human action writer reaches them, and the
# 0100 moved release to the human writer; the archive writer retains no release path.
EXPORT_BODY='{"p_tenant_id":"00000000-0000-4000-8000-0000000000ff","p_actor_id":"00000000-0000-4000-8000-0000000000fe","p_plan_id":null,"p_format":"json","p_filter_params":{},"p_summary":{},"p_artifact_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","p_artifact_bytes":1,"p_correlation_id":"00000000-0000-4000-8000-0000000000fd"}'
expect_refused 'shared service key reached approval export recorder' "$SUPABASE_SERVICE_KEY" record_approval_export "$EXPORT_BODY"
expect_refused 'archive writer still reaches the moved export recorder' "$SUPABASE_ARCHIVE_WRITER_KEY" record_approval_export "$EXPORT_BODY"
expect_json_error 'human writer did not reach the audited recorder tenant gate' tenant_not_found \
  "$(rpc_body "$SUPABASE_HUMAN_ACTION_WRITER_KEY" record_approval_export "$EXPORT_BODY")"
echo '  ✓ Shared service and archive-writer JWTs denied; human action writer JWT reaches audited recorder'
ARCHIVE_BODY='{"p_tenant_id":"00000000-0000-4000-8000-0000000000ff","p_actor_id":"00000000-0000-4000-8000-0000000000fe","p_token_id":"00000000-0000-4000-8000-0000000000fd","p_operation_key":"00000000-0000-4000-8000-0000000000fc","p_provider":"s3","p_bucket":"archive-fixture","p_object_key":"invalid","p_source_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","p_source_bytes":1,"p_correlation_id":"00000000-0000-4000-8000-0000000000fb"}'
expect_refused 'shared service key reached archive mutation' "$SUPABASE_SERVICE_KEY" begin_approval_proof_archive "$ARCHIVE_BODY"
expect_refused 'archive writer still reaches the moved begin RPC' "$SUPABASE_ARCHIVE_WRITER_KEY" begin_approval_proof_archive "$ARCHIVE_BODY"
expect_json_error 'human writer did not reach the archive founder gate' founder_authority_required \
  "$(rpc_body "$SUPABASE_HUMAN_ACTION_WRITER_KEY" begin_approval_proof_archive "$ARCHIVE_BODY")"
RELEASE_BODY='{"p_tenant_id":"00000000-0000-4000-8000-0000000000ff","p_actor_id":"00000000-0000-4000-8000-0000000000fe","p_archive_id":"00000000-0000-4000-8000-0000000000fd","p_source_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","p_version_id":"probe","p_correlation_id":"00000000-0000-4000-8000-0000000000fc"}'
expect_refused 'shared service key reached archive release' "$SUPABASE_SERVICE_KEY" release_approval_proof_archive "$RELEASE_BODY"
expect_refused 'archive writer reached archive release' "$SUPABASE_ARCHIVE_WRITER_KEY" release_approval_proof_archive "$RELEASE_BODY"
expect_json_error 'human writer did not reach the release founder gate' founder_authority_required \
  "$(rpc_body "$SUPABASE_HUMAN_ACTION_WRITER_KEY" release_approval_proof_archive "$RELEASE_BODY")"
echo '  ✓ Archive RPCs: service and archive writer denied; human writer reaches begin and release'

# Exercise the same apikey/Authorization split that the BFF's supabase-js
# client sends through the HTTP gateway, not just hand-crafted curl headers.
(
  cd services/bff
  AXIOM_PROBE_URL="$BASE" AXIOM_PROBE_ANON="$SUPABASE_ANON_KEY" AXIOM_PROBE_WRITER="$SUPABASE_HUMAN_ACTION_WRITER_KEY" \
    node --input-type=module <<'NODE'
import { createClient } from '@supabase/supabase-js';
const client = createClient(process.env.AXIOM_PROBE_URL, process.env.AXIOM_PROBE_ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${process.env.AXIOM_PROBE_WRITER}` } },
});
const { data, error } = await client.rpc('record_approval_export', {
  p_tenant_id: '00000000-0000-4000-8000-0000000000ff',
  p_actor_id: '00000000-0000-4000-8000-0000000000fe',
  p_plan_id: null,
  p_format: 'json',
  p_filter_params: {},
  p_summary: {},
  p_artifact_sha256: 'a'.repeat(64),
  p_artifact_bytes: 1,
  p_correlation_id: '00000000-0000-4000-8000-0000000000fd',
});
if (error || data?.error !== 'tenant_not_found') throw new Error('Scoped supabase-js writer client did not reach the recorder');
NODE
)
echo '  ✓ BFF-shaped supabase-js client reached recorder through gateway'

SERVICE_WRITE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/rest/v1/tenants" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H 'Content-Type: application/json' \
  -d '{"id":"00000000-0000-4000-8000-0000000000f2","slug":"service-write","name":"Service write fixture"}')"
[ "$SERVICE_WRITE" = "201" ] || { echo "FAIL: service-role write was refused (${SERVICE_WRITE})"; exit 1; }
echo '  ✓ Service role can persist application data without BYPASSRLS'

# ─── 0099: ledger authorship and the claimed execution gate ──────────
# The tenant created just above is the throwaway the producer event lands in.
LEDGER_TENANT='00000000-0000-4000-8000-0000000000f2'
ledger_body() { # actor_type actor_id action_type
  printf '{"p_tenant_id":"%s","p_correlation_id":"00000000-0000-4000-8000-0000000000e1","p_actor_type":"%s","p_actor_id":"%s","p_agent_version":null,"p_model_id":null,"p_prompt_hash":null,"p_action_type":"%s","p_target_ref":null,"p_input_hash":null,"p_output_hash":null,"p_approval_token_id":null,"p_approver_id":null,"p_pre_state_ref":null,"p_post_state_ref":null,"p_result":"success","p_detail":{}}' \
    "$LEDGER_TENANT" "$1" "$2" "$3"
}
SYSTEM_EVENT="$(ledger_body system gateway-probe discovery.started)"
# A real member of the throwaway tenant, so the human wrapper's membership check
# passes and only the role grant can refuse the agent writer (no masked denial).
MEMBER_ID="$(printf '%s' "$SIGNUP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["user"]["id"])')"
curl -fsS -o /dev/null -X POST "${BASE}/rest/v1/users" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H 'Content-Type: application/json' \
  -d "{\"id\":\"${MEMBER_ID}\",\"email\":\"${EMAIL}\"}" || { echo 'FAIL: could not mirror the ledger probe user'; exit 1; }
MEMBER_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/rest/v1/tenant_users" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H 'Content-Type: application/json' \
  -d "{\"tenant_id\":\"${LEDGER_TENANT}\",\"user_id\":\"${MEMBER_ID}\",\"role\":\"founder\"}")"
[ "$MEMBER_CODE" = "201" ] || { echo "FAIL: could not enrol the ledger probe member (${MEMBER_CODE})"; exit 1; }
HUMAN_EVENT="$(ledger_body human "$MEMBER_ID" discovery.started)"
HUMAN_AUTHORITY_EVENT="$(ledger_body system gateway-probe report.released)"
# (b) positive control first: the agent writer appends a harmless system event.
AGENT_APPEND="$(rpc_body "$SUPABASE_AGENT_LEDGER_WRITER_KEY" append_agent_ledger "$SYSTEM_EVENT")"
printf '%s' "$AGENT_APPEND" | python3 -c 'import json,sys; v=json.load(sys.stdin); assert isinstance(v,int) and v>0' \
  || { echo "FAIL: agent ledger writer did not append a system event (response: ${AGENT_APPEND})"; exit 1; }
# Positive control for the human wrapper: its own writer appends the same event
# for a real member, so the refusals below cannot be masked by the membership check.
HUMAN_APPEND="$(rpc_body "$SUPABASE_HUMAN_ACTION_WRITER_KEY" append_human_ledger "$HUMAN_EVENT")"
printf '%s' "$HUMAN_APPEND" | python3 -c 'import json,sys; v=json.load(sys.stdin); assert isinstance(v,int) and v>0' \
  || { echo "FAIL: human action writer did not append a member's event (response: ${HUMAN_APPEND})"; exit 1; }
# (a) the generic service JWT is refused on all four entry points.
for fn in append_ledger append_agent_ledger; do
  expect_refused "shared service key reached ${fn}" "$SUPABASE_SERVICE_KEY" "$fn" "$SYSTEM_EVENT"
done
expect_refused 'shared service key reached append_human_ledger' "$SUPABASE_SERVICE_KEY" append_human_ledger "$HUMAN_EVENT"
BATCH_BODY='{"p_tenant_id":"00000000-0000-4000-8000-0000000000f2","p_plan_id":"00000000-0000-4000-8000-0000000000d1","p_request_key":"gateway-probe","p_correlation_id":"00000000-0000-4000-8000-0000000000e2","p_nonce":"n","p_content_digest":"d","p_mode":"sequential","p_concurrency":1,"p_stop_on_failure":true,"p_dispatch_reference":"gateway-probe","p_action_ids":[]}'
expect_refused 'shared service key reached the legacy start_execution_batch' "$SUPABASE_SERVICE_KEY" start_execution_batch "$BATCH_BODY"
# (b) the agent writer cannot author a human event, nor a human-authority event
# under a system label, nor call the raw append.
expect_refused 'agent ledger writer reached append_human_ledger' "$SUPABASE_AGENT_LEDGER_WRITER_KEY" append_human_ledger "$HUMAN_EVENT"
expect_refused 'agent ledger writer appended a human-authority event' "$SUPABASE_AGENT_LEDGER_WRITER_KEY" append_agent_ledger "$HUMAN_AUTHORITY_EVENT"
expect_refused 'agent ledger writer reached append_ledger' "$SUPABASE_AGENT_LEDGER_WRITER_KEY" append_ledger "$SYSTEM_EVENT"
# (c) the human writer is refused the producer entry points.
expect_refused 'human action writer reached append_agent_ledger' "$SUPABASE_HUMAN_ACTION_WRITER_KEY" append_agent_ledger "$SYSTEM_EVENT"
expect_refused 'human action writer reached start_claimed_execution_batch' "$SUPABASE_HUMAN_ACTION_WRITER_KEY" start_claimed_execution_batch "$BATCH_BODY"
expect_refused 'agent ledger writer reached start_claimed_execution_batch' "$SUPABASE_AGENT_LEDGER_WRITER_KEY" start_claimed_execution_batch "$BATCH_BODY"
# (d) the service JWT reaches the claimed gate's business check.
expect_json_error 'service key did not reach the claimed execution gate' plan_not_found \
  "$(rpc_body "$SUPABASE_SERVICE_KEY" start_claimed_execution_batch "$BATCH_BODY")"
echo '  ✓ Ledger: service JWT refused on append_ledger/append_agent_ledger/append_human_ledger/start_execution_batch;'
echo '    agent writer appends system events only; human writer refused producer paths; service reaches claimed gate'
# The probe member was only a fixture; later RLS checks need a user with no membership.
curl -fsS -o /dev/null -X DELETE "${BASE}/rest/v1/tenant_users?user_id=eq.${MEMBER_ID}" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  || { echo 'FAIL: could not remove the ledger probe membership'; exit 1; }

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
