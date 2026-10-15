#!/usr/bin/env bash
# Uses only the disposable container provided by the database harness.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql <<'SQL'
create schema intake_race;
create table intake_race.previous_current as select version from public.control_libraries where is_current;
insert into auth.users(id,email) values('01359900-0000-4000-8000-000000000001','intake-race@test.invalid');
insert into public.users(id,email,is_axiom_internal) values('01359900-0000-4000-8000-000000000001','intake-race@test.invalid',true);
insert into public.tenants(id,slug,name) values('01359900-0000-4000-8000-000000000011','intake-race','Intake race');
insert into public.tenant_users(tenant_id,user_id,role) values('01359900-0000-4000-8000-000000000011','01359900-0000-4000-8000-000000000001','founder');
insert into public.estates(id,tenant_id,slug,name) values('01359900-0000-4000-8000-000000000021','01359900-0000-4000-8000-000000000011','intake-race','Intake race');
update public.control_libraries set is_current=false where is_current;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current,status) values('intake-race-135',now(),'fixture','fixture',0,true,'published');
create function intake_race.make(k text,id uuid default null) returns jsonb language sql as $$ select public.create_engagement_intake('01359900-0000-4000-8000-000000000011','01359900-0000-4000-8000-000000000001',k,id,'Concurrent intake','intake-race-135','01359900-0000-4000-8000-000000000021',gen_random_uuid()) $$;
grant usage on schema intake_race to human_action_writer;
SQL
race() { race_run "$1" "$2" "$result_dir/first" "$result_dir/second"; }
race "set local role human_action_writer; select intake_race.make('same-operation','01359900-0000-4000-8000-000000000031')" "set role human_action_writer; select intake_race.make('same-operation','01359900-0000-4000-8000-000000000031')"
grep -q '"replayed": true' "$result_dir/second"
[ "$(sql -c "select count(*) from public.engagement_intake_receipts where tenant_id='01359900-0000-4000-8000-000000000011'")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='01359900-0000-4000-8000-000000000011' and action_type='engagement.created'")" = 1 ]
race "update public.tenant_users set role='viewer' where tenant_id='01359900-0000-4000-8000-000000000011'" "set role human_action_writer; select intake_race.make('same-operation','01359900-0000-4000-8000-000000000031')"
grep -q forbidden "$result_dir/second"
sql -c "update public.tenant_users set role='founder' where tenant_id='01359900-0000-4000-8000-000000000011';"
race "update public.users set is_axiom_internal=false where id='01359900-0000-4000-8000-000000000001'" "set role human_action_writer; select intake_race.make('same-operation','01359900-0000-4000-8000-000000000031')"
grep -q forbidden "$result_dir/second"
sql -c "update public.users set is_axiom_internal=true where id='01359900-0000-4000-8000-000000000001';"
race "update public.estates set status='archived' where id='01359900-0000-4000-8000-000000000021'" "set role human_action_writer; select intake_race.make('new-estate-operation')"
grep -q estate_archived "$result_dir/second"
sql -c "update public.estates set status='active' where id='01359900-0000-4000-8000-000000000021';"
race "update public.control_libraries set is_current=false where version='intake-race-135'" "set role human_action_writer; select intake_race.make('new-library-operation')"
grep -q invalid_library "$result_dir/second"
[ "$(sql -c "select count(*) from public.engagement_intake_receipts where tenant_id='01359900-0000-4000-8000-000000000011'")" = 1 ]
sql -c 'update public.control_libraries set is_current=true where version in (select version from intake_race.previous_current);drop schema intake_race cascade;' >/dev/null 2>&1
echo 'Concurrent intake: one creation/receipt, exact replay, live demotion/offboarding/estate/library checks after waits.'
