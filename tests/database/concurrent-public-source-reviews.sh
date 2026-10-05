#!/usr/bin/env bash
# Synthetic disposable DB only. Each contention is observed against its holder PID.
set -euo pipefail
container="${1:?test container required}"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
python3 - <<'PY' | sql
from pathlib import Path
s = Path('tests/database/public-source-reviews.test.sql').read_text()
s = s[s.index('create function pg_temp.id'):s.index('-- Review tests start here')]
s = s.replace('pg_temp.', 'source_review_race.').replace('99100900-', '99101900-').replace('source-review-', 'source-review-race-')
s = s.replace('create temporary table source_fixture', 'create table source_review_race.source_fixture')
s = s.replace('on source_fixture ', 'on source_review_race.source_fixture ').replace('into source_fixture ', 'into source_review_race.source_fixture ').replace('from source_fixture ', 'from source_review_race.source_fixture ')
print('create schema source_review_race;')
print('grant usage on schema source_review_race to human_action_writer,agent_ledger_writer,service_role;')
print(s)
PY
race() { race_run "$1" "$2" "$result_dir/first" "$result_dir/second"; }
same="select source_review_race.review(jsonb_build_object('key',source_review_race.id(300)))"
race "$same" "$same"
grep -q '"created": true' "$result_dir/first"
grep -q '"replayed": true' "$result_dir/second"
[ "$(sql -c "select count(*) from public.public_source_reviews where tenant_id=source_review_race.id(11)")" = 1 ]
sql -c "insert into source_review_race.source_fixture values('first_review_id',(select to_jsonb(id) from public.public_source_reviews where tenant_id=source_review_race.id(11) and operation_key=source_review_race.id(300)));"
prior="(select v#>>'{}' from source_review_race.source_fixture where k='first_review_id')"
race "select source_review_race.review(jsonb_build_object('key',source_review_race.id(301),'previous',$prior,'decision','disputed'))" \
  "select source_review_race.review(jsonb_build_object('key',source_review_race.id(302),'previous',$prior))"
grep -q '"created": true' "$result_dir/first"
grep -q stale_review "$result_dir/second"
[ "$(sql -c "select count(*) from public.public_source_reviews where tenant_id=source_review_race.id(11)")" = 2 ]

indicator="select source_review_race.review(jsonb_build_object('key',source_review_race.id(303),'target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',1,'content_sha256',repeat('b',64)))"
race "update public.tenant_users set role='viewer' where tenant_id=source_review_race.id(11) and user_id=source_review_race.id(7)" "$indicator"
grep -q forbidden "$result_dir/second"
[ "$(sql -c "select count(*) from public.public_source_reviews where tenant_id=source_review_race.id(11)")" = 2 ]
sql -c "update public.tenant_users set role='reviewer' where tenant_id=source_review_race.id(11) and user_id=source_review_race.id(7);"
race "$indicator" "update public.tenant_users set role='viewer' where tenant_id=source_review_race.id(11) and user_id=source_review_race.id(7)"
grep -q '"created": true' "$result_dir/first"
[ "$(sql -c "$same")" = '{"error": "forbidden"}' ]
sql -c "update public.tenant_users set role='reviewer' where tenant_id=source_review_race.id(11) and user_id=source_review_race.id(7);"

zero="select source_review_race.review(jsonb_build_object('key',source_review_race.id(304),'observation',source_review_race.observation('zero_vibhaag')))"
race "update public.engagements set status='cancelled' where id=source_review_race.id(31)" "$zero"
grep -q context_refused "$result_dir/second"
sql -c "update public.engagements set status='intake' where id=source_review_race.id(31);"
race "$zero" "update public.engagements set status='cancelled' where id=source_review_race.id(31)"
grep -q '"created": true' "$result_dir/first"
[ "$(sql -c "$zero")" = '{"error": "context_refused"}' ]
sql -c "update public.engagements set status='intake' where id=source_review_race.id(31);"

internal="select source_review_race.review(jsonb_build_object('key',source_review_race.id(305),'actor',source_review_race.id(4),'observation',source_review_race.observation('drishti')))"
race 'update public.users set is_axiom_internal=false where id=source_review_race.id(4)' "$internal"
grep -q forbidden "$result_dir/second"
sql -c 'update public.users set is_axiom_internal=true where id=source_review_race.id(4);'
race "$internal" 'update public.users set is_axiom_internal=false where id=source_review_race.id(4)'
grep -q '"created": true' "$result_dir/first"
[ "$(sql -c "$internal")" = '{"error": "forbidden"}' ]
sql -c 'update public.users set is_axiom_internal=true where id=source_review_race.id(4);'

# Current estate remains locked without replacing a historically NULL binding estate.
sql -c 'update public.engagements set estate_id=source_review_race.id(21) where id=source_review_race.id(31);'
estate="select source_review_race.review(jsonb_build_object('key',source_review_race.id(306),'observation',source_review_race.observation('zero_drishti')))"
race "$estate" "update public.estates set name='Still the same assigned estate' where id=source_review_race.id(21)"
grep -q '"created": true' "$result_dir/first"
[ "$(sql -c 'select count(*) from public.public_source_reviews where tenant_id=source_review_race.id(11) and estate_id is not null')" = 0 ]
[ "$(sql -c 'select count(*) from public.public_source_reviews where tenant_id=source_review_race.id(11)')" = 6 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=source_review_race.id(11) and action_type='classification.reviewed'")" = 6 ]
[ "$(sql -c 'select count(*) from public.verify_ledger(source_review_race.id(11),1)')" = 0 ]
sql -c 'drop schema source_review_race cascade' >/dev/null 2>&1
echo 'Public source review concurrency: one receipt per operation, stale corrections and revoked authority refused; source/context locks serialize.'
