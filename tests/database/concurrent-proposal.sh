#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql <<'SQL'
insert into auth.users(id,email) values ('e0000000-0000-4000-8000-000000000001','proposal-staff@test.invalid'),('e0000000-0000-4000-8000-000000000002','proposal-owner@test.invalid');
insert into public.users(id,email) values ('e0000000-0000-4000-8000-000000000001','proposal-staff@test.invalid'),('e0000000-0000-4000-8000-000000000002','proposal-owner@test.invalid');
insert into public.tenants(id,slug,name) values ('e0000000-0000-4000-8000-000000000011','proposal-race','Proposal race');
insert into public.tenant_users(tenant_id,user_id,role) values ('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001','axiom_analyst'),('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002','owner');
insert into public.estates(id,tenant_id,slug,name) values ('e0000000-0000-4000-8000-000000000021','e0000000-0000-4000-8000-000000000011','race','Race');
insert into public.tenant_onboarding_intakes(tenant_id,submitted_by,proposed_systems) values ('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002','[{"name":"CRM"}]');
select public.prepare_onboarding_proposal('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000021','[{"name":"CRM","systemKind":"saas","dataCategories":[]}]',gen_random_uuid());
SQL
proposal_id=$(sql -c "select id from public.onboarding_proposals where tenant_id='e0000000-0000-4000-8000-000000000011'")
proposal_digest=$(sql -c "select content_sha256 from public.onboarding_proposals where id='$proposal_id'")
review="select public.review_onboarding_proposal('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000002','$proposal_id','$proposal_digest','approved','Reviewed',gen_random_uuid())"
race_run "set local role human_action_writer; $review" "set role human_action_writer; $review" "$result_dir/first" "$result_dir/second"
grep -q 'already_reviewed' "$result_dir/second"
[ "$(sql -c "select count(*) from public.estate_systems where tenant_id='e0000000-0000-4000-8000-000000000011'")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='e0000000-0000-4000-8000-000000000011' and action_type='onboarding.proposal.approved'")" = 1 ]
echo 'Concurrent proposal approvals: one system, one approval event, duplicate refused.'
