#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql -c 'create schema policy_race'
sed '/-- POLICY_FIXTURE_READY/,$d' tests/database/dispatch-key-policy.test.sql | sed '/^begin;$/d;s/pg_temp/policy_race/g;s/71710000/73730000/g;s/policy-fixture/policy-race/g;s/policy-legacy-/policy-race-legacy-/g;s/'"'"'policy-'"'"'/'"'"'policy-race-'"'"'/g' | sql
sql -c 'grant usage on schema policy_race to service_role, human_action_writer;'
sql -c 'select policy_race.publish(0,61,array[61,62]);' > /dev/null
initial=$(sql -c 'select policy_race.fingerprint()')
sql -c "select policy_race.queued(51,1,'$initial');" > /dev/null
# publish_assessment_dispatch_key_policy appends a human event (0099: human
# writer only); enqueue/claim remain producer operations for service_role.
role_for() { case "$1" in *publish*) echo human_action_writer;; *) echo service_role;; esac; }
race() {
 race_run "set local role $(role_for "$1"); $1" "set role $(role_for "$2"); $2" "$result_dir/first" "$result_dir/second"
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
