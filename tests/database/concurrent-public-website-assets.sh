#!/usr/bin/env bash
# Observed-lock tests; accepts only the existing owned disposable DB harness.
set -euo pipefail
container="$1"
# Inspect only ownership labels/state; never dump container environment or secrets.
python3 - "$container" "$(pwd -P)" <<'PYOWNERSHIP'
import json,re,subprocess,sys
name,owner=sys.argv[1:]
if not re.fullmatch(r'axiom-db-test-[0-9]+',name):
 raise SystemExit('Refusing non-harness container')
def inspect(field):
 return json.loads(subprocess.check_output(['docker','inspect','--format','{{json ('+field+')}}',name],text=True))
if inspect('.State.Running') is not True or inspect('index .Config.Labels "com.axiom.fixture"')!='database-policy-test' or inspect('index .Config.Labels "com.axiom.fixture.project"')!='axiom-db-tests' or inspect('index .Config.Labels "com.axiom.owner-worktree"')!=owner:
 raise SystemExit('Disposable fixture ownership mismatch')
PYOWNERSHIP
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql <<'SQL'
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99139999-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
insert into auth.users(id,email) values(pg_temp.id(1),'asset-race@example.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'asset-race@example.invalid');
insert into public.tenants(id,slug,name) select pg_temp.id(10+n),'asset-race-'||n,'Race '||n from generate_series(1,5)n;
insert into public.tenant_users(tenant_id,user_id,role) select pg_temp.id(10+n),pg_temp.id(1),'owner' from generate_series(1,5)n;
insert into public.estates(id,tenant_id,slug,name) select pg_temp.id(20+n),pg_temp.id(10+n),'race','Race' from generate_series(1,5)n;
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) select pg_temp.id(30+n),pg_temp.id(10+n),pg_temp.id(20+n),'Site','application' from generate_series(1,5)n;
create function pg_temp.payload() returns jsonb language sql as $$select jsonb_build_object(
'version',2,'extractorVersion','static-public-2','scope','bounded_public_pages','requiresHumanReview',true,'candidates','[]'::jsonb,'candidatesTruncated',false,
'pages',jsonb_build_array(
jsonb_build_object('page','root','state','examined','contentSha256',repeat('a',64),'truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','privacy','state','examined','contentSha256',repeat('b',64),'truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','contact','state','unavailable','truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','terms','state','unexamined','truncated',false,'coverageReasons','[]'::jsonb),
jsonb_build_object('page','consent','state','examined','contentSha256',repeat('c',64),'truncated',false,'coverageReasons','[]'::jsonb)))$$;
create function pg_temp.sources() returns jsonb language sql as $$select jsonb_build_array(
jsonb_build_object('page','root','state','examined','requestedUrl','https://public.org/','finalUrl','https://public.org/','contentSha256',repeat('a',64)),
jsonb_build_object('page','privacy','state','examined','requestedUrl','https://public.org/privacy','finalUrl','https://public.org/privacy','contentSha256',repeat('b',64)),
jsonb_build_object('page','contact','state','unavailable','requestedUrl','https://public.org/contact','finalUrl',null,'contentSha256',null),
jsonb_build_object('page','terms','state','unexamined','requestedUrl',null,'finalUrl',null,'contentSha256',null),
jsonb_build_object('page','consent','state','examined','requestedUrl','https://public.org/consent','finalUrl','https://public.org/consent','contentSha256',repeat('c',64)))$$;
create function pg_temp.result() returns jsonb language sql as $$select jsonb_build_object('requestedUrl','https://public.org/','finalUrl','https://public.org/','checkedAt',now(),'status','checked','httpStatus',200,'bytes',3,'contentSha256',repeat('a',64),'title','Synthetic public page','headings','[]'::jsonb,'publicLinks','[]'::jsonb,'auditPages',jsonb_build_array(jsonb_build_object('kind','privacy','status','checked','requestedUrl','https://public.org/privacy','finalUrl','https://public.org/privacy','contentSha256',repeat('b',64)),jsonb_build_object('kind','contact','status','unavailable','requestedUrl','https://public.org/contact','errorCode','unreachable')),'observations',jsonb_build_array(jsonb_build_object('kind','privacy','status','retrieved'),jsonb_build_object('kind','contact','status','unavailable'),jsonb_build_object('kind','terms','status','not_linked')))$$;


do $$declare n integer;txt text;begin
 for n in 2..5 loop
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','register_target','operationKey',pg_temp.id(40+n),'confirmed',true,'estateId',pg_temp.id(20+n),'systemId',pg_temp.id(30+n),'expectedEstateVersion',1,'expectedSystemVersion',1,'url','https://public.org/'));
 set local role human_action_writer;
 perform public.record_public_website_asset_operation(pg_temp.id(10+n),pg_temp.id(1),txt);
 reset role;
 end loop;
end$$;
do $$declare n integer;txt text:=controller_security.canonical_questionnaire_json(pg_temp.payload());begin
 for n in 2..5 loop
 set local role human_action_writer;
 perform public.record_public_website_control_capture(pg_temp.id(10+n),pg_temp.id(1),pg_temp.id(50+n),'https://public.org/','https://public.org/',pg_temp.result(),'axiom-public-evidence-v2-canonical-json-1',txt,encode(sha256(convert_to(txt,'UTF8')),'hex'),pg_temp.sources());
 reset role;
 end loop;
end$$;
SQL
id() { printf '99139999-0000-4000-8000-%012d' "$1"; }
actor=$(id 1)
archive() { local n="$1"; printf "set role human_action_writer; select public.manage_estate('%s','%s','estate.update','%s',jsonb_build_object('name','Archived','status','archived','expectedVersion',1),gen_random_uuid())" "$(id $((10+n)))" "$actor" "$(id $((20+n)))"; }
# Build all request text on the server using the same canonical contract.
associate() { local n="$1"; printf "set role human_action_writer; select public.record_public_website_asset_operation('%s','%s','%s')" "$(id $((10+n)))" "$actor" "$(sql -c "select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','associate_capture','operationKey','$(id $((60+n)))','confirmed',true,'targetId',t.id,'expectedTargetSha256',t.snapshot_sha256,'checkId',p.check_id,'expectedPayloadSha256',p.payload_sha256,'expectedCaptureReceipt',p.capture_receipt::text)) from public.public_website_targets t join public.public_website_control_evidence p on p.tenant_id=t.tenant_id where t.tenant_id='$(id $((10+n)))'")"; }
withdraw() { local n="$1"; printf "set role human_action_writer; select public.record_public_website_asset_operation('%s','%s','%s')" "$(id $((10+n)))" "$actor" "$(sql -c "select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','withdraw','operationKey','$(id $((70+n)))','confirmed',true,'subjectType','target','subjectId',id,'expectedSubjectSha256',snapshot_sha256,'reason','Synthetic replacement')) from public.public_website_targets where tenant_id='$(id $((10+n)))'")"; }
registration="set role human_action_writer; select public.record_public_website_asset_operation('$(id 11)','$actor','$(sql -c "select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','register_target','operationKey','$(id 41)','confirmed',true,'estateId','$(id 21)','systemId','$(id 31)','expectedEstateVersion',1,'expectedSystemVersion',1,'url','https://public.org/'))")')"
race_run "$(archive 1)" "$registration" "$result_dir/archive-first" "$result_dir/register-second" blocked error
grep -q 'current inventory required' "$result_dir/register-second"
[ "$(sql -c "select count(*) from public.public_website_targets where tenant_id='$(id 11)'")" = 0 ]
race_run "$(associate 2)" "$(archive 2)" "$result_dir/associate-first" "$result_dir/archive-second"
[ "$(sql -c "select count(*) from public.public_website_asset_associations where tenant_id='$(id 12)'")" = 1 ]
update_system="set role human_action_writer; select public.manage_estate('$(id 13)','$actor','system.update','$(id 33)',jsonb_build_object('name','Updated','status','active','expectedVersion',1,'systemKind','application','dataCategories','[]'::jsonb),gen_random_uuid())"
race_run "$update_system" "$(associate 3)" "$result_dir/update-first" "$result_dir/associate-stale" blocked error
grep -q 'target inventory changed' "$result_dir/associate-stale"
[ "$(sql -c "select count(*) from public.public_website_asset_associations where tenant_id='$(id 13)'")" = 0 ]
race_run "$(withdraw 4)" "$(associate 4)" "$result_dir/withdraw-first" "$result_dir/associate-withdrawn" blocked error
grep -q 'current target required' "$result_dir/associate-withdrawn"
[ "$(sql -c "select count(*) from public.public_website_asset_associations where tenant_id='$(id 14)'")" = 0 ]
race_run "$(associate 5)" "$(withdraw 5)" "$result_dir/associate-before-withdraw" "$result_dir/withdraw-after-associate"
[ "$(sql -c "select count(*) from public.public_website_asset_associations where tenant_id='$(id 15)'")" = 1 ]
echo 'Public website assets: observed-lock archive/update/withdrawal races preserve immutable accepted history and refuse stale association.'

#140: cancellation and both sanctioned writers share the139 serialization point.
# Reuse synthetic retained payload bytes only, never a target request or real account.
sql <<'SQL'
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99139999-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
insert into public.tenants(id,slug,name) select pg_temp.id(10+n),'asset-race-'||n,'Cancellation race '||n from generate_series(6,9)n;
insert into public.tenant_users(tenant_id,user_id,role) select pg_temp.id(10+n),pg_temp.id(1),'owner' from generate_series(6,9)n;
insert into public.estates(id,tenant_id,slug,name) select pg_temp.id(20+n),pg_temp.id(10+n),'race','Cancellation race' from generate_series(6,9)n;
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) select pg_temp.id(30+n),pg_temp.id(10+n),pg_temp.id(20+n),'Site','application' from generate_series(6,9)n;
do $$declare n integer;txt text;begin for n in 8..9 loop
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','register_target','operationKey',pg_temp.id(40+n),'confirmed',true,'estateId',pg_temp.id(20+n),'systemId',pg_temp.id(30+n),'expectedEstateVersion',1,'expectedSystemVersion',1,'url','https://public.org/'));
 set local role human_action_writer;perform public.record_public_website_asset_operation(pg_temp.id(10+n),pg_temp.id(1),txt);reset role;
 end loop;end$$;
SQL
new_request() { local n="$1"; if [ "$n" -lt 8 ]; then
 sql -c "select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','register_target','operationKey','$(id $((80+n)))','confirmed',true,'estateId','$(id $((20+n)))','systemId','$(id $((30+n)))','expectedEstateVersion',1,'expectedSystemVersion',1,'url','https://public.org/'))"
 else sql -c "select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','capture','operationKey','$(id $((80+n)))','confirmed',true,'targetId',id,'expectedTargetSha256',snapshot_sha256)) from public.public_website_targets where tenant_id='$(id $((10+n)))'"; fi; }
write_new() { local n="$1" request; request=$(new_request "$n"); if [ "$n" -lt 8 ]; then
 printf "set role human_action_writer; select public.record_public_website_asset_operation('%s','%s','%s')" "$(id $((10+n)))" "$actor" "$request"
 else sql -c "select format('set role human_action_writer; select public.record_targeted_public_website_capture(%L,%L,%L,%L,%L::jsonb,%L,%L,%L,%L::jsonb)', '$(id $((10+n)))','$actor',\$req\$$request\$req\$,'https://public.org/',c.result::text,p.codec,p.payload_text,p.payload_sha256,p.page_sources::text) from public.public_website_checks c join public.public_website_control_evidence p on p.check_id=c.id where c.tenant_id='$(id 12)' limit 1"; fi; }
cancel_new() { local n="$1";printf "set role human_action_writer; select public.cancel_public_website_asset_operation('%s','%s','%s','Abandon synthetic uncertain intent',true)" "$(id $((10+n)))" "$actor" "$(new_request "$n")"; }
race_run "$(cancel_new 6)" "$(write_new 6)" "$result_dir/cancel-before-ordinary" "$result_dir/ordinary-after-cancel"
grep -q '"state": "cancelled"' "$result_dir/ordinary-after-cancel"
[ "$(sql -c "select count(*) from public.public_website_asset_operations where tenant_id='$(id 16)'")" = 0 ]
race_run "$(write_new 7)" "$(cancel_new 7)" "$result_dir/ordinary-before-cancel" "$result_dir/cancel-after-ordinary"
grep -q '"state": "recorded"' "$result_dir/cancel-after-ordinary"
[ "$(sql -c "select count(*) from public.public_website_asset_cancellations where tenant_id='$(id 17)'")" = 0 ]
race_run "$(cancel_new 8)" "$(write_new 8)" "$result_dir/cancel-before-capture" "$result_dir/capture-after-cancel"
grep -q '"state": "cancelled"' "$result_dir/capture-after-cancel"
[ "$(sql -c "select (select count(*) from public.public_website_checks where tenant_id='$(id 18)')+(select count(*) from public.public_website_control_evidence where tenant_id='$(id 18)')+(select count(*) from public.public_website_asset_associations where tenant_id='$(id 18)')")" = 0 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='$(id 18)'")" = 2 ]
race_run "$(write_new 9)" "$(cancel_new 9)" "$result_dir/capture-before-cancel" "$result_dir/cancel-after-capture"
grep -q '"state": "recorded"' "$result_dir/cancel-after-capture"
[ "$(sql -c "select count(*) from public.public_website_asset_cancellations where tenant_id='$(id 19)'")" = 0 ]
[ "$(sql -c "select count(*) from public.public_website_asset_associations where tenant_id='$(id 19)'")" = 1 ]
echo 'Public website assets: four observed-lock cancellation/ordinary/targeted-capture orderings passed; no cancelled capture side effects.'
