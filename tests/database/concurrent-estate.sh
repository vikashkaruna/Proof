#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql <<'SQL'
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000f1','estate-race@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-0000000000f1','estate-race@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-0000000000f2','estate-race','Estate race');
insert into public.tenant_users(tenant_id,user_id,role) values ('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f1','owner');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-0000000000f3','00000000-0000-4000-8000-0000000000f2','race','Race');
SQL
manage="public.manage_estate('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f1','estate.update','00000000-0000-4000-8000-0000000000f3','{\"name\":\"Changed\",\"status\":\"active\",\"expectedVersion\":1}',gen_random_uuid())"
race_run "set local role human_action_writer; select $manage" "set role human_action_writer; select $manage" "$result_dir/first" "$result_dir/second"
grep -q 'version_conflict' "$result_dir/second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='00000000-0000-4000-8000-0000000000f2' and action_type='estate.updated'")" = 1 ]
[ "$(sql -c "select version from public.estates where id='00000000-0000-4000-8000-0000000000f3'")" = 2 ]
echo 'Concurrent estate edits: one update/audit event; stale contender refused after waiting.'
