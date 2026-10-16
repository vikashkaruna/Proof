#!/usr/bin/env bash
# Mixed public RPC lock-order regressions. Only the existing owned disposable DB.
set -euo pipefail
container="${1:?owned disposable test container required}"
python3 - "$container" "$(pwd -P)" <<'PYOWN'
import json,re,subprocess,sys
name,owner=sys.argv[1:]
if not re.fullmatch(r'axiom-db-test-[0-9]+',name): raise SystemExit('Refusing non-harness container')
def inspect(field): return json.loads(subprocess.check_output(['docker','inspect','--format','{{json ('+field+')}}',name],text=True))
if inspect('.State.Running') is not True or inspect('index .Config.Labels "com.axiom.fixture"')!='database-policy-test' or inspect('index .Config.Labels "com.axiom.fixture.project"')!='axiom-db-tests' or inspect('index .Config.Labels "com.axiom.owner-worktree"')!=owner: raise SystemExit('Disposable fixture ownership mismatch')
PYOWN
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
# Reuse the exact reviewed canonical catalogue; no published row replacement.
python3 - <<'PY' | sql
from pathlib import Path
s=Path('tests/database/public-control-review-asset-sources.test.sql').read_text()
s=s[s.index('create function pg_temp.id'):s.index('select pg_temp.refused2')]
a=s.index('insert into public.control_libraries');b=s.index('insert into public.engagements',a)
seed=s[a:b]
s=s[:a]+'''do $reuse$ begin
if not exists(select 1 from public.control_libraries where version='0.1.1') then
'''+seed+'''else
if (select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_agg(to_jsonb(c)-'created_at' order by id)),'UTF8')),'hex') from public.controls c where library_version='0.1.1') is distinct from 'ddf7b3202e731871a78012ddeffa7b8ebde4c2f4b8b3dbbfa7fd95e1c6a7a011' then raise exception 'Existing canonical catalogue differs';end if;
end if;end $reuse$;
'''+s[b:]
s=s.replace('pg_temp.','review141_race.').replace('99133400-','99134100-').replace('review-core-','review141-race-').replace("'asset-review'","'asset-review141'")
s=s.replace('create temporary table saved_check','create table review141_race.saved_check').replace('from saved_check','from review141_race.saved_check')
s=s.replace('create temporary table asset_operations','create table review141_race.asset_operations').replace('into asset_operations','into review141_race.asset_operations').replace('from asset_operations','from review141_race.asset_operations')
print('create schema review141_race;grant usage on schema review141_race to human_action_writer;')
print(s)
PY
sql -c "select review141_race.save(review141_race.request(90)||jsonb_build_object('expectedEstateId',review141_race.id(71)))" > "$result_dir/v1-root"
review=$(sql -c "select id from public.public_control_review_sets where tenant_id=review141_race.id(31)")
id() { printf '99134100-0000-4000-8000-%012d' "$1"; }
# Original workload custody deliberately stays unconfigured in this lock-only
# fixture: RPCs must acquire their real initial locks, then refuse dispatch.
# Successful accepted-job/finalization recovery remains covered by the existing
# full controller fixture and must be extended before mounting source v2.
resolve() {
 local job="$1" rid="$2"
 sql -c "select format('set role human_action_writer;select public.resolve_public_control_assessment_source(%L,%L,%L,%L,%L,%L,%L)',tenant_id,review141_race.id(1),'$(id "$job")',engagement_id,id,request_sha256,snapshot_sha256) from public.public_control_review_sets where id='$rid'"
}
enqueue() {
 local job="$1" rid="$2"
 sql -c "select format('set role human_action_writer;select public.enqueue_public_control_assessment_dispatch(%L,%L,%L,%L,%L,%L,%L,%L,%L,clock_timestamp()+interval ''5 minutes'',%L,decode(''00'',''hex''),decode(''00'',''hex''),decode(''00'',''hex''),1,%L,%L,%L,%L)', '$(id "$job")',tenant_id,review141_race.id(1),review141_race.id(99),estate_id,engagement_id,'$(id "$job")',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_object('tenant_id',tenant_id,'engagement_id',engagement_id,'library_version','0.1.1','answers',snapshot_text::jsonb->'normalizedAnswers','sdf_self_attested',null,'processes_children',null,'processes_health',null)),'UTF8')),'hex'),repeat('f',64),'unconfigured-lock-fixture',repeat('f',64),id,request_sha256,snapshot_sha256) from public.public_control_review_sets where id='$rid'"
}
record() { local key="$1" prev="$2"; sql -c "select format('select review141_race.save(%L::jsonb,review141_race.id(5))', review141_race.request2($key,'$prev'))"; }
# Actual public v1 enqueue HEAD/inventory path versus v2 review, both orders.
race_run "$(enqueue 101 "$review")" "$(record 102 "$review")" "$result_dir/v1-enqueue" "$result_dir/v2-review" blocked success "review141:tenant:$(id 31)"
grep -q '"replayed": false' "$result_dir/v2-review"
latest=$(sql -c "select id from public.public_control_review_sets where tenant_id=review141_race.id(31) and not exists(select 1 from public.public_control_review_sets n where n.previous_review_id=public.public_control_review_sets.id)")
race_run "$(record 103 "$latest")" "$(enqueue 104 "$review")" "$result_dir/v2-first" "$result_dir/v1-stale" blocked success "review141:tenant:$(id 31)"
grep -q review_source_changed "$result_dir/v1-stale"
# Standalone public v1 resolver and new v2 job execute real prelock paths.
latest=$(sql -c "select id from public.public_control_review_sets where tenant_id=review141_race.id(31) and not exists(select 1 from public.public_control_review_sets n where n.previous_review_id=public.public_control_review_sets.id)")
race_run "$(resolve 105 "$review")" "$(enqueue 106 "$latest")" "$result_dir/resolve-first" "$result_dir/job-second" blocked success "review141:tenant:$(id 31)"
race_run "$(enqueue 107 "$latest")" "$(resolve 108 "$review")" "$result_dir/job-first" "$result_dir/resolve-second" blocked success "review141:tenant:$(id 31)"
# A v1 cancellation holds engagement SHARE then HEAD; new v2 job must never
# hold HEAD while upgrading engagement SHARE to UPDATE in the opposite order.
intent=$(sql -c 'select controller_security.canonical_questionnaire_json(review141_race.request(109))')
cancel="select review141_race.cancel(\$body\$$intent\$body\$::jsonb)"
race_run "$cancel" "$(enqueue 110 "$latest")" "$result_dir/cancel-first" "$result_dir/job-after-cancel" blocked success "review141:engagement:$(id 31)"
race_run "$(enqueue 111 "$latest")" "$cancel" "$result_dir/job-before-cancel" "$result_dir/cancel-second" blocked success "review141:engagement:$(id 31)"
# A normal v1 RECORD uses a separate engagement sharing the same estate/check.
# Its tenant-global HEAD advisory lock contends with the v2 job without allowing
# a v1 downgrade of the existing v2 review chain.
sql -c "insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(review141_race.id(142),review141_race.id(31),review141_race.id(71),'0.1.1','Legacy review lock fixture')"
legacy_record() {
 local key="$1" prev="$2"
 sql -c "select format('select review141_race.save(%L::jsonb)',review141_race.request($key,$prev)||jsonb_build_object('engagementId',review141_race.id(142),'expectedEstateId',review141_race.id(71)))"
}
race_run "$(legacy_record 112 null)" "$(enqueue 116 "$latest")" "$result_dir/v1-record-first" "$result_dir/job-after-v1-record" blocked success "review141:head:$(id 31)"
grep -q '"replayed": false' "$result_dir/v1-record-first"
legacy=$(sql -c "select id from public.public_control_review_sets where tenant_id=review141_race.id(31) and engagement_id=review141_race.id(142)")
race_run "$(enqueue 117 "$latest")" "$(legacy_record 113 "'$legacy'")" "$result_dir/job-before-v1-record" "$result_dir/v1-record-second" blocked success "review141:head:$(id 31)"
grep -q '"replayed": false' "$result_dir/v1-record-second"
# Same exact actor/key/body: cancellation first fences the never-recorded review;
# recording first returns an authoritative positive receipt to the cancel caller.
intent2=$(sql -c "select controller_security.canonical_questionnaire_json(review141_race.request2(114,'$latest'))")
record2="select review141_race.save(\$body\$$intent2\$body\$::jsonb,review141_race.id(5))"
cancel2="select review141_race.cancel(\$body\$$intent2\$body\$::jsonb,'Explicit v2 cancellation',review141_race.id(5))"
race_run "$cancel2" "$record2" "$result_dir/v2-cancel-first" "$result_dir/v2-record-cancelled" blocked success "review141:head:$(id 31)"
grep -q '"state": "cancelled"' "$result_dir/v2-cancel-first"
grep -q operation_cancelled "$result_dir/v2-record-cancelled"
[ "$(sql -c "select count(*) from public.public_control_review_sets where tenant_id=review141_race.id(31) and operation_key=review141_race.id(114)")" = 0 ]
intent2=$(sql -c "select controller_security.canonical_questionnaire_json(review141_race.request2(115,'$latest'))")
record2="select review141_race.save(\$body\$$intent2\$body\$::jsonb,review141_race.id(5))"
cancel2="select review141_race.cancel(\$body\$$intent2\$body\$::jsonb,'Explicit v2 cancellation',review141_race.id(5))"
race_run "$record2" "$cancel2" "$result_dir/v2-record-first" "$result_dir/v2-cancel-recorded" blocked success "review141:head:$(id 31)"
grep -q '"replayed": false' "$result_dir/v2-record-first"
grep -q '"state": "recorded"' "$result_dir/v2-cancel-recorded"
[ "$(sql -c "select count(*) from public.public_control_review_sets where tenant_id=review141_race.id(31) and operation_key=review141_race.id(115)")" = 1 ]
[ "$(sql -c "select count(*) from public.public_control_review_cancellations where tenant_id=review141_race.id(31) and operation_key=review141_race.id(115)")" = 0 ]
[ "$(sql -c "select count(*) from public.assessment_dispatch_jobs where tenant_id=review141_race.id(31)")" = 0 ]
# Safe phase metadata is retained by the enclosing harness log before cleanup.
for proof in "$result_dir/"*.lock-proof.json; do cat "$proof"; done
echo 'Mixed v1/v2 public RPC lock paths completed without deadlock; no unconfigured job was dispatched.'
