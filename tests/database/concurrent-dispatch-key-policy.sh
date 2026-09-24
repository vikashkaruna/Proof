#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql -c 'create schema policy_race'
sed '/-- POLICY_FIXTURE_READY/,$d' tests/database/dispatch-key-policy.test.sql | sed '/^begin;$/d;s/pg_temp/policy_race/g;s/71710000/73730000/g;s/policy-fixture/policy-race/g;s/policy-legacy-/policy-race-legacy-/g;s/'"'"'policy-'"'"'/'"'"'policy-race-'"'"'/g' | sql
sql -c 'grant usage on schema policy_race to service_role;'
sql -c 'select policy_race.publish(0,61,array[61,62]);' > /dev/null
initial=$(sql -c 'select policy_race.fingerprint()')
sql -c "select policy_race.queued(51,1,'$initial');" > /dev/null
barrier() {
 for attempt in $(seq 1 100); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
  sleep 0.05
 done
 echo 'Policy concurrency barrier not reached'; exit 1
}
race() {
 sql -c "set application_name='policy-first'; begin; set local role service_role; $1; select pg_sleep(2); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier policy-first wait_event PgSleep
 sql -c "set application_name='policy-second'; set role service_role; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier policy-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
}
race 'select policy_race.publish(1,62,array[61,62])' "select policy_race.queued(52,1,'$initial')"
grep -q policy_stale "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_dispatch_jobs where id=policy_race.id(52)')" = 0 ]
current=$(sql -c 'select policy_race.fingerprint()')
race "select policy_race.claim(51,2,'$current')" 'select policy_race.publish(2,61,array[61,62])'
[ "$(sql -c 'select claimed_at is not null from public.assessment_dispatch_jobs where id=policy_race.id(51)')" = t ]
[ "$(sql -c 'select revision from public.assessment_dispatch_key_policies where tenant_id=policy_race.id(11)')" = 3 ]
current=$(sql -c 'select policy_race.fingerprint()')
race "select policy_race.queued(53,3,'$current')" 'select policy_race.publish(3,62,array[61,62])'
[ "$(sql -c 'select key_ref=policy_race.ref(61) and claimed_at is null from public.assessment_dispatch_jobs where id=policy_race.id(53)')" = t ]
current=$(sql -c 'select policy_race.fingerprint()')
race 'select policy_race.publish(4,61,array[61,62])' "select policy_race.claim(53,4,'$current')"
grep -q policy_stale "$result_dir/second"
[ "$(sql -c 'select claimed_at is null from public.assessment_dispatch_jobs where id=policy_race.id(53)')" = t ]
race 'select policy_race.publish(5,61,array[61,62,63])' 'select policy_race.publish(5,61,array[61,62,64])'
grep -q policy_conflict "$result_dir/second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=policy_race.id(11) and action_type='workload.dispatch_policy_published'")" = 6 ]
sql -c "insert into public.tenants(id,slug,name) values(policy_race.id(12),'policy-race-other','Other'); insert into public.tenant_users(tenant_id,user_id,role) values(policy_race.id(12),policy_race.id(1),'owner');"
race 'select policy_race.publish(6,61,array[61,62,63,65])' "select public.publish_assessment_dispatch_key_policy(policy_race.id(12),policy_race.id(1),policy_race.id(41),0,'aws',policy_race.ref(65),array[policy_race.ref(65)])"
grep -q policy_keys_required "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_dispatch_key_policies where tenant_id=policy_race.id(12)')" = 0 ]
sql -c 'drop schema policy_race cascade' >/dev/null 2>&1
echo 'Policy races: both enqueue and claim orderings fenced; competing publication has one winner; cross-tenant key adoption serializes.'
