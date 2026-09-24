#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
insert into auth.users(id,email) values ('e0000000-0000-4000-8000-000000000001','proposal-staff@test.invalid'),('e0000000-0000-4000-8000-000000000002','proposal-owner@test.invalid');
insert into public.users(id,email) values ('e0000000-0000-4000-8000-000000000001','proposal-staff@test.invalid'),('e0000000-0000-4000-8000-000000000002','proposal-owner@test.invalid');
insert into public.tenants(id,slug,name) values ('e0000000-0000-4000-8000-000000000011','proposal-race','Proposal race');
insert into public.tenant_users(tenant_id,user_id,role) values ('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001','axiom_analyst'),('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002','owner');
insert into public.estates(id,tenant_id,slug,name) values ('e0000000-0000-4000-8000-000000000021','e0000000-0000-4000-8000-000000000011','race','Race');
insert into public.tenant_onboarding_intakes(tenant_id,submitted_by,proposed_systems) values ('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002','[{"name":"CRM"}]');
select public.prepare_onboarding_proposal('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000021','[{"name":"CRM","systemKind":"saas","dataCategories":[]}]',gen_random_uuid());
SQL
review="select public.review_onboarding_proposal('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002',id,content_sha256,'approved','Reviewed',gen_random_uuid()) from public.onboarding_proposals where tenant_id='e0000000-0000-4000-8000-000000000011'"
sql -c "set application_name='proposal-first'; begin; set local role service_role; $review; select pg_sleep(3); commit;" > "$result_dir/first" 2>&1 &
first_pid=$!
ready=false
for attempt in $(seq 1 50); do
 if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='proposal-first' and wait_event='PgSleep'")" = 1 ]; then ready=true; break; fi
 sleep 0.05
done
[ "$ready" = true ] || { echo 'Proposal race missed barrier'; cat "$result_dir/first"; exit 1; }
sql -c "set application_name='proposal-second'; set role service_role; $review;" > "$result_dir/second" 2>&1 &
second_pid=$!
blocked=false
for attempt in $(seq 1 30); do
 if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='proposal-second' and wait_event_type='Lock'")" = 1 ]; then blocked=true; break; fi
 sleep 0.05
done
[ "$blocked" = true ] || { echo 'Proposal race did not contend'; cat "$result_dir/second"; exit 1; }
wait "$first_pid"
wait "$second_pid"
grep -q 'already_reviewed' "$result_dir/second"
[ "$(sql -c "select count(*) from public.estate_systems where tenant_id='e0000000-0000-4000-8000-000000000011'")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='e0000000-0000-4000-8000-000000000011' and action_type='onboarding.proposal.approved'")" = 1 ]
echo 'Concurrent proposal approvals: one system, one approval event, duplicate refused.'
