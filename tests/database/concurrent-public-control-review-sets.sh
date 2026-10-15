#!/usr/bin/env bash
# Isolated synthetic fixture only; the enclosing harness destroys its database.
set -euo pipefail
container="${1:?owned disposable test container required}"
database="${2:-axiom_policy_test}"
case "$(docker inspect -f '{{index .Config.Labels "com.axiom.fixture"}}' "$container")" in database-policy-test|public-review-core) ;; *) echo 'Owned disposable SQL fixture required' >&2; exit 1;; esac
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U supabase_admin -d "$database" -v ON_ERROR_STOP=1 -Atq "$@"; }
python3 - <<'PY' | sql
from pathlib import Path
s=Path('tests/database/public-control-review-set.test.sql').read_text()
s=s[s.index('create function pg_temp.id'):s.index('select pg_temp.refused')]
s=s.replace('pg_temp.','review_set_race.').replace('99133400-','99133500-').replace('review-core-','review-race-')
s=s.replace('create temporary table saved_check','create table review_set_race.saved_check').replace('from saved_check','from review_set_race.saved_check')
print('create schema review_set_race; grant usage on schema review_set_race to human_action_writer;')
print(s)
PY
race() {
 python3 tests/database/lib/concurrency-barrier.py "$container" supabase_admin "$1" "$2" "$result_dir/first" "$result_dir/second" "$result_dir/status" blocked success '' "$database"
}
same="select review_set_race.save(review_set_race.request(100))"
race "$same" "$same"
grep -q '"replayed": false' "$result_dir/first"
grep -q '"replayed": true' "$result_dir/second"
prior=$(sql -c 'select id from public.public_control_review_sets where tenant_id=review_set_race.id(31)')
race "select review_set_race.save(review_set_race.request(101,'$prior'))" "select review_set_race.save(review_set_race.request(102,'$prior'))"
grep -q '"replayed": false' "$result_dir/first"
grep -q 'stale_review' "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_control_review_sets where tenant_id=review_set_race.id(31)')" = 2 ]
prior=$(sql -c 'select id from public.public_control_review_sets where tenant_id=review_set_race.id(31) and previous_review_id is not null')
frozen=$(sql -c "select controller_security.canonical_questionnaire_json(review_set_race.request(103,'$prior'))")
request="set role human_action_writer; select public.record_public_control_review_set('99133500-0000-4000-8000-000000000031','99133500-0000-4000-8000-000000000001',\$body\$$frozen\$body\$)"
race "update public.tenant_users set role='viewer' where tenant_id=review_set_race.id(31) and user_id=review_set_race.id(1)" "$request"
grep -q forbidden "$result_dir/second"
sql -c "update public.tenant_users set role='founder' where tenant_id=review_set_race.id(31) and user_id=review_set_race.id(1)"
race 'update public.users set is_axiom_internal=false where id=review_set_race.id(1)' "$request"
grep -q forbidden "$result_dir/second"
sql -c 'update public.users set is_axiom_internal=true where id=review_set_race.id(1)'
sql -c "insert into public.estates(id,tenant_id,slug,name) values(review_set_race.id(60),review_set_race.id(31),'review-race-estate','Synthetic estate')"
race 'update public.engagements set estate_id=review_set_race.id(60) where id=review_set_race.id(41)' "$request"
grep -q invalid_record "$result_dir/second"
sql -c 'update public.engagements set estate_id=null where id=review_set_race.id(41)'
sql -c "insert into public.control_libraries(version,published_at,published_by,change_log,control_count,status) values('review-race-other',now(),'fixture','Synthetic only',0,'published')"
race "update public.engagements set library_version='review-race-other' where id=review_set_race.id(41)" "$request"
grep -q catalogue_refused "$result_dir/second"
sql -c "update public.engagements set library_version='0.1.1' where id=review_set_race.id(41)"
race "update public.engagements set status='cancelled' where id=review_set_race.id(41)" "$request"
grep -q context_refused "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_control_review_sets where tenant_id=review_set_race.id(31)')" = 2 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=review_set_race.id(31) and action_type::text='public_control.review_recorded'")" = 2 ]
# Same-actor record/cancel races share the tenant journal lock. The loser
# cannot create a late review after a positive cancellation receipt.
sql -c "update public.engagements set status='intake' where id=review_set_race.id(41)"
frozen=$(sql -c "select controller_security.canonical_questionnaire_json(review_set_race.request(104,'$prior'))")
record="set role human_action_writer; select public.record_public_control_review_set('99133500-0000-4000-8000-000000000031','99133500-0000-4000-8000-000000000001',\$body\$$frozen\$body\$)"
cancel="set role human_action_writer; select public.cancel_public_control_review_operation('99133500-0000-4000-8000-000000000031','99133500-0000-4000-8000-000000000001',\$body\$$frozen\$body\$,'Explicit synthetic cancellation')"
race "$cancel" "$record"
grep -q '"state": "cancelled"' "$result_dir/first"
grep -q operation_cancelled "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_control_review_sets where tenant_id=review_set_race.id(31)')" = 2 ]
frozen=$(sql -c "select controller_security.canonical_questionnaire_json(review_set_race.request(105,'$prior'))")
record="set role human_action_writer; select public.record_public_control_review_set('99133500-0000-4000-8000-000000000031','99133500-0000-4000-8000-000000000001',\$body\$$frozen\$body\$)"
cancel="set role human_action_writer; select public.cancel_public_control_review_operation('99133500-0000-4000-8000-000000000031','99133500-0000-4000-8000-000000000001',\$body\$$frozen\$body\$,'Explicit synthetic cancellation')"
race "$record" "$cancel"
grep -q '"replayed": false' "$result_dir/first"
grep -q '"state": "recorded"' "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_control_review_sets where tenant_id=review_set_race.id(31)')" = 3 ]
[ "$(sql -c 'select count(*) from public.public_control_review_cancellations where tenant_id=review_set_race.id(31)')" = 1 ]
echo 'Public review concurrency: exact replay, one CAS winner, late membership/internal/estate/catalogue/cancellation refusals and both record/cancel race orders passed.'
