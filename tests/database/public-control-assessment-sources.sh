#!/usr/bin/env bash
# Only a labelled disposable database; never a retained local stack.
set -euo pipefail
container="${1:?owned disposable test container required}"
database="${2:-axiom_policy_test}"
case "$(docker inspect -f '{{index .Config.Labels "com.axiom.fixture"}}' "$container")" in database-policy-test|public-assessment-source) ;; *) echo 'Owned disposable fixture required' >&2; exit 1;; esac
sql() { docker exec -i "$container" psql -X -U supabase_admin -d "$database" -v ON_ERROR_STOP=1 -Atq "$@"; }
# Reuse the exact published catalogue/capture fixture, never a parallel seed.
python3 - <<'PY' | sql
from pathlib import Path
s=Path('tests/database/public-control-review-set.test.sql').read_text()
s=s[s.index('create function pg_temp.id'):s.index('select pg_temp.refused')]
# Earlier concurrency helpers retain this global immutable catalogue. Reuse it
# only after exact publication metadata and every expected control field match.
import re
library_start=s.index('insert into public.control_libraries')
controls_start=s.index('insert into public.controls')
controls_end=s.index('\n',controls_start)
seed_sql=s[library_start:controls_end]
seed=re.search(r'\$seed\$(.*?)\$seed\$',seed_sql,re.S).group(1)
change_log=re.search(r"values\('0.1.1','2026-09-20','Axiom Minds · Founder',(.*),46,'published'\);",s[library_start:controls_start],re.S).group(1)
reuse="""do $reuse_catalogue$ declare expected jsonb:=$seed$"""+seed+"""$seed$::jsonb;begin
 if not exists(select 1 from public.control_libraries where version='0.1.1') then
 """+seed_sql+"""
 elsif not exists(select 1 from public.control_libraries where version='0.1.1' and published_at='2026-09-20'::timestamptz and published_by='Axiom Minds · Founder' and change_log="""+change_log+""" and control_count=46 and status='published')
 or (select count(*) from public.controls where library_version='0.1.1')<>jsonb_array_length(expected)
 or exists(select 1 from jsonb_array_elements(expected) e left join public.controls c on c.id=e->>'id' and c.library_version='0.1.1' where c.id is null or (select jsonb_object_agg(key,to_jsonb(c)->key) from jsonb_object_keys(e) key) is distinct from e)
 then raise exception 'Existing immutable fixture catalogue differs from canonical publication';end if;
end $reuse_catalogue$;
"""
s=s[:library_start]+reuse+s[controls_end:]

s=s.replace('pg_temp.','assessment_source_test.').replace('99133400-','99133600-').replace('review-core-','assessment-source-')
s=s.replace('create temporary table saved_check','create table assessment_source_test.saved_check').replace('from saved_check','from assessment_source_test.saved_check')
print('create schema assessment_source_test; grant usage on schema assessment_source_test to human_action_writer;')
print(s)
PY
sql <<'SQL'
create table assessment_source_test.review as select (assessment_source_test.save(jsonb_set(assessment_source_test.request(),'{answers}','{"DPDPA-GOV-001":{"Q1":{"answer":null,"rationale":"Explicit unknown, not an omitted judgment.","candidateOrdinals":[]}}}'::jsonb))->'data') as value;
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values(assessment_source_test.id(81),assessment_source_test.id(31),'parikshan','spiffe://axiom.test/agent/parikshan','active');
create table assessment_source_test.policy as select '{}'::jsonb as value;
grant select on assessment_source_test.review,assessment_source_test.policy to human_action_writer;
grant update on assessment_source_test.policy to human_action_writer;
set role human_action_writer;
update assessment_source_test.policy set value=public.publish_assessment_dispatch_key_policy(assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(82),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||assessment_source_test.id(83)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||assessment_source_test.id(83)::text]);
reset role;
SQL
sql <<'SQL'
create function assessment_source_test.source(job int,actor int default 1, review jsonb default null) returns jsonb language plpgsql as $$
declare r jsonb;v jsonb:=coalesce(review,(select value from assessment_source_test.review));begin
 set local role human_action_writer;
 r:=public.resolve_public_control_assessment_source(assessment_source_test.id(31),assessment_source_test.id(actor),assessment_source_test.id(job),assessment_source_test.id(41),(v->>'id')::uuid,v->>'request_sha256',v->>'snapshot_sha256');reset role;return r;
exception when others then reset role;raise;end$$;
create function assessment_source_test.enqueue(job int,actor int default 1,review jsonb default null) returns jsonb language plpgsql as $$
declare r jsonb;s jsonb;v jsonb:=coalesce(review,(select value from assessment_source_test.review));begin
 s:=assessment_source_test.source(job,actor,v);if s?'error' then return s;end if;
 set local role human_action_writer;
 r:=public.enqueue_public_control_assessment_dispatch(assessment_source_test.id(job),assessment_source_test.id(31),assessment_source_test.id(actor),assessment_source_test.id(81),(s->'review'->>'estate_id')::uuid,assessment_source_test.id(41),assessment_source_test.id(job),s->>'inputSha256',encode(sha256(convert_to(job::text,'UTF8')),'hex'),now()+interval '5 minutes','arn:aws:kms:ap-south-1:123456789012:key/'||assessment_source_test.id(83)::text,decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),1,(select value->>'fingerprint' from assessment_source_test.policy),(v->>'id')::uuid,v->>'request_sha256',v->>'snapshot_sha256');reset role;return r;
exception when others then reset role;raise;end$$;
create function assessment_source_test.intent(job int,review jsonb default null) returns text language sql as $$
 select controller_security.canonical_questionnaire_json(jsonb_build_object('operationKey',assessment_source_test.id(job),'engagementId',assessment_source_test.id(41),'answers','{}'::jsonb,'applicability','{"sdfSelfAttested":null,"processesChildren":null,"processesHealth":null}'::jsonb,'reviewRef',jsonb_build_object('reviewId',v->'id','requestSha256',v->'request_sha256','snapshotSha256',v->'snapshot_sha256'))) from (select coalesce(review,(select value from assessment_source_test.review)) as v) x$$;
create function assessment_source_test.cancel_intent(job int,actor int default 1,reason text default 'Human abandons this exact undispatched source intent.',review jsonb default null) returns jsonb language plpgsql as $$
declare r jsonb;txt text:=assessment_source_test.intent(job,review);begin set local role human_action_writer;r:=public.cancel_assessment_source_intent(assessment_source_test.id(31),assessment_source_test.id(actor),txt,reason);reset role;return r;exception when others then reset role;raise;end$$;
create function assessment_source_test.read_intent(job int,actor int default 1) returns jsonb language plpgsql as $$
declare r jsonb;txt text:=assessment_source_test.intent(job);begin set local role human_action_writer;r:=public.read_assessment_source_operation(assessment_source_test.id(31),assessment_source_test.id(actor),txt);reset role;return r;exception when others then reset role;raise;end$$;
select assessment_source_test.ok(assessment_source_test.read_intent(221)->>'state'='not_found','absence is not positive cancellation');
select assessment_source_test.ok(assessment_source_test.cancel_intent(221)->>'state'='cancelled','explicit source intent cancellation recorded');
select assessment_source_test.ok(assessment_source_test.cancel_intent(221)=assessment_source_test.cancel_intent(221),'exact cancellation reason and body replay');
select assessment_source_test.ok(assessment_source_test.cancel_intent(221,1,'A changed decision.')->>'error'='dispatch_conflict','changed reason conflicts');
select assessment_source_test.ok(assessment_source_test.enqueue(221)->>'error'='assessment_source_cancelled','positive tombstone fences late exact dispatch');
select assessment_source_test.ok(assessment_source_test.read_intent(221)->>'state'='cancelled','positive readback reconciles lost cancellation response');
select assessment_source_test.ok(assessment_source_test.cancel_intent(223)->>'state'='cancelled','actor A cancels own UUID');
select assessment_source_test.ok(assessment_source_test.enqueue(223,3)?'run_id','actor A cannot preempt actor B same UUID');
select assessment_source_test.ok(assessment_source_test.read_intent(223)->>'state'='cancelled','actor A retains own cancellation proof after B dispatch');
select assessment_source_test.ok(assessment_source_test.source(201)->'review'->>'id'=(select value->>'id' from assessment_source_test.review),'current source resolves');
select assessment_source_test.ok((assessment_source_test.source(201)->>'inputText')::jsonb->'answers'->'DPDPA-GOV-001'->'Q1'='null'::jsonb,'explicit human null remains unknown');
select assessment_source_test.ok((assessment_source_test.source(201)->>'inputText')::jsonb->'answers'->'DPDPA-GOV-002'->'Q1'='null'::jsonb,'omitted human judgment remains unknown');
select assessment_source_test.ok(assessment_source_test.enqueue(201)?'run_id','existing encrypted dispatch accepts bound human review');
select assessment_source_test.ok(assessment_source_test.enqueue(201)=assessment_source_test.enqueue(201),'exact historical dispatch replay');
select assessment_source_test.ok((select count(*)=1 from public.public_control_assessment_sources where job_id=assessment_source_test.id(201)),'one immutable attachment');
select assessment_source_test.ok((select count(*)=1 from public.audit_ledger where tenant_id=assessment_source_test.id(31) and action_type='assessment.requested' and target_ref=assessment_source_test.id(201)::text),'one human request receipt');
select assessment_source_test.ok((select s.requested_receipt=(r.metadata->>'assessment_request_receipt')::bigint and s.input_sha256=j.input_hash and s.review_receipt=(v.value->>'receipt_id')::bigint from public.public_control_assessment_sources s join public.agent_runs r on r.id=s.run_id join public.assessment_dispatch_jobs j on j.id=s.job_id cross join assessment_source_test.review v where s.job_id=assessment_source_test.id(201)),'receipt and input closure');
-- Roll back the whole dispatch/request receipt if attachment insertion fails.
create function assessment_source_test.fail_insert() returns trigger language plpgsql as $$begin raise exception 'synthetic attachment fault' using errcode='22023';end$$;
create trigger fixture_source_failure before insert on public.public_control_assessment_sources for each row execute function assessment_source_test.fail_insert();
do $$declare n bigint;begin select count(*) into n from public.audit_ledger;
 begin perform assessment_source_test.enqueue(202);raise exception 'ASSERTION: fault accepted';exception when invalid_parameter_value then null;end;
 perform assessment_source_test.ok(not exists(select 1 from public.assessment_dispatch_jobs where id=assessment_source_test.id(202)),'attachment fault leaves no job');
 perform assessment_source_test.ok((select count(*)=n from public.audit_ledger),'attachment fault leaves no request receipt');end$$;
drop trigger fixture_source_failure on public.public_control_assessment_sources;
-- A real deferred closure failure also rolls back the job and human receipt.
create function assessment_source_test.swap_receipt() returns trigger language plpgsql as $$begin new.requested_receipt:=new.review_receipt;return new;end$$;
create trigger fixture_source_swap before insert on public.public_control_assessment_sources for each row execute function assessment_source_test.swap_receipt();
do $$declare n bigint;begin select count(*) into n from public.audit_ledger;
 begin perform assessment_source_test.enqueue(206);set constraints public_control_assessment_source_closure immediate;raise exception 'ASSERTION: swapped receipt accepted';exception when check_violation then null;end;
 set constraints public_control_assessment_source_closure deferred;
 perform assessment_source_test.ok(not exists(select 1 from public.assessment_dispatch_jobs where id=assessment_source_test.id(206)),'swapped receipt leaves no job');
 perform assessment_source_test.ok((select count(*)=n from public.audit_ledger),'swapped receipt leaves no request receipt');end$$;
drop trigger fixture_source_swap on public.public_control_assessment_sources;
-- Authority is live on exact retries, not inherited from a historic review.
update public.tenant_users set role='viewer' where tenant_id=assessment_source_test.id(31) and user_id=assessment_source_test.id(1);
select assessment_source_test.ok(assessment_source_test.enqueue(201)->>'error'='forbidden','offboarding blocks replay');
update public.tenant_users set role='founder' where tenant_id=assessment_source_test.id(31) and user_id=assessment_source_test.id(1);
select assessment_source_test.ok(assessment_source_test.enqueue(203,5)->>'error'='forbidden','reviewer may review but cannot invoke existing runtime');
select assessment_source_test.ok(assessment_source_test.enqueue(201,3)->>'error'='dispatch_conflict','different actor cannot recover original run');
-- Immutable historical source remains recoverable after a head change and refused estate mutation.
create table assessment_source_test.second_review as select assessment_source_test.save(assessment_source_test.request(52,(select (value->>'id')::uuid from assessment_source_test.review)))->'data' as value;
select assessment_source_test.ok(assessment_source_test.cancel_intent(221,review=>(select value from assessment_source_test.second_review))->>'error'='dispatch_conflict','changed original reference cannot reuse a cancelled key');
select assessment_source_test.ok(assessment_source_test.enqueue(204)->>'error'='review_source_changed','superseded review cannot start new run');
select assessment_source_test.ok(assessment_source_test.enqueue(201)?'run_id','superseded source remains exact-recoverable');
select assessment_source_test.ok(assessment_source_test.enqueue(201,1,(select value from assessment_source_test.second_review))->>'error'='dispatch_conflict','same worker answers cannot substitute another review');
insert into public.estates(id,tenant_id,name,slug) values(assessment_source_test.id(90),assessment_source_test.id(31),'Changed estate','assessment-source-changed');
do $$begin begin update public.engagements set estate_id=assessment_source_test.id(90) where id=assessment_source_test.id(41);raise exception 'admitted estate changed';exception when check_violation then null;end;end$$;
select assessment_source_test.ok((select estate_id is null from public.engagements where id=assessment_source_test.id(41)),'refused estate reassignment preserves admitted scope');
select assessment_source_test.ok(assessment_source_test.enqueue(201)?'run_id','historical estate is frozen for recovery');
select assessment_source_test.ok(assessment_source_test.enqueue(205)->>'error'='review_source_changed','new dispatch still refuses independently superseded review');
select assessment_source_test.ok(assessment_source_test.cancel_intent(224)->>'state'='cancelled','unrecorded intent can be abandoned after head change and refused estate mutation');
-- Existing generic paths cannot drop the attachment even with the exact input hash.
set role human_action_writer;
select assessment_source_test.ok(public.recover_reviewed_assessment_dispatch(assessment_source_test.id(201),assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(81),null,assessment_source_test.id(41),assessment_source_test.id(201),repeat('a',64),'0.1.1',repeat('a',64))->>'error'='dispatch_conflict','generic recovery cannot drop review reference');
select assessment_source_test.ok(public.cancel_unclaimed_assessment_request(assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(201),assessment_source_test.id(41),'0.1.1',repeat('a',64))->>'error'='cancellation_conflict','generic cancellation cannot drop review reference');
reset role;
-- A source-bound unclaimed cancellation survives supersession and refused estate mutation.
create function assessment_source_test.cancel_run() returns jsonb language plpgsql as $$
declare r jsonb;s jsonb;v jsonb:=(select value from assessment_source_test.review);begin
 s:=assessment_source_test.source(201);set local role human_action_writer;
 r:=public.cancel_public_control_assessment_request(assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(201),assessment_source_test.id(41),'0.1.1',s->>'inputSha256',(v->>'id')::uuid,v->>'request_sha256',v->>'snapshot_sha256');reset role;return r;
exception when others then reset role;raise;end$$;
select assessment_source_test.ok(assessment_source_test.cancel_run()?'cancellation_receipt','source-bound cancellation retains original historical context');
select assessment_source_test.ok(assessment_source_test.cancel_run()?'cancellation_receipt','source-bound cancellation exact replay');
-- Direct role access never supplies an alternative write or read path.
do $$declare r text;begin foreach r in array array['service_role','human_action_writer','agent_ledger_writer','anon','authenticated'] loop
 perform assessment_source_test.ok(not has_table_privilege(r,'public.public_control_assessment_sources','SELECT') and not has_table_privilege(r,'public.public_control_assessment_sources','INSERT'),'closed provenance table '||r);
end loop;end$$;
select assessment_source_test.ok((select count(*)=1 from public.public_control_assessment_sources where job_id=assessment_source_test.id(201)),'refusals preserve one source');
-- Generic human/producer appends cannot forge this positive proof.
do $$declare n bigint;begin select count(*) into n from public.audit_ledger;
 begin set local role human_action_writer;
 perform public.append_human_ledger(assessment_source_test.id(31),assessment_source_test.id(225),'human',assessment_source_test.id(1)::text,null,null,null,'assessment.source_cancelled','invented',null,null,null,null,null,null,'success','{}');
 set constraints assessment_source_cancel_ledger_receipt immediate;raise exception 'ASSERTION: generic forged receipt accepted';exception when insufficient_privilege then reset role;end;
 set constraints assessment_source_cancel_ledger_receipt deferred;
 perform assessment_source_test.ok((select count(*)=n from public.audit_ledger),'generic cancellation forge leaves no receipt');
 begin set local role agent_ledger_writer;
 perform public.append_agent_ledger(assessment_source_test.id(31),assessment_source_test.id(225),'agent','parikshan',null,null,null,'assessment.source_cancelled','invented',null,null,null,null,null,null,'success','{}');
 raise exception 'ASSERTION: producer forged receipt accepted';exception when insufficient_privilege then reset role;end;
 begin update public.assessment_source_cancellations set reason='rewrite' where job_id=assessment_source_test.id(221);raise exception 'ASSERTION: cancellation rewrite accepted';exception when insufficient_privilege then null;end;
 begin delete from public.assessment_source_cancellations where job_id=assessment_source_test.id(221);raise exception 'ASSERTION: cancellation delete accepted';exception when insufficient_privilege then null;end;
 begin truncate public.assessment_source_cancellations;raise exception 'ASSERTION: cancellation truncate accepted';exception when insufficient_privilege then null;end;
end$$;

SQL
echo 'Public control assessment sources: exact replay, sparse/null, atomic rollback, authority, supersession/estate and closed generic paths passed.'
# Observe real blocking rather than relying on sleeps for concurrent outcomes.
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql -c "update public.engagements set estate_id=null where id=assessment_source_test.id(41); update assessment_source_test.review set value=(select value from assessment_source_test.second_review)"
race() {
 python3 tests/database/lib/concurrency-barrier.py "$container" supabase_admin "$1" "$2" "$result_dir/first" "$result_dir/second" "$result_dir/status" blocked success '' "$database"
}
race 'select assessment_source_test.enqueue(211)' 'select assessment_source_test.enqueue(211)'
[ "$(sql -c 'select count(*) from public.public_control_assessment_sources where job_id=assessment_source_test.id(211)')" = 1 ]
first=$(cat "$result_dir/first")
second=$(cat "$result_dir/second")
[ "$first" = "$second" ]
race "update public.tenant_users set role='viewer' where tenant_id=assessment_source_test.id(31) and user_id=assessment_source_test.id(1)" 'select assessment_source_test.enqueue(212)'
grep -q forbidden "$result_dir/second"
sql -c "update public.tenant_users set role='founder' where tenant_id=assessment_source_test.id(31) and user_id=assessment_source_test.id(1)"
race 'update public.users set is_axiom_internal=false where id=assessment_source_test.id(1)' 'select assessment_source_test.enqueue(213)'
grep -q forbidden "$result_dir/second"
sql -c 'update public.users set is_axiom_internal=true where id=assessment_source_test.id(1)'
sql <<'SQL'
create function assessment_source_test.refuse_estate()returns void language plpgsql as $$begin
 perform id from public.engagements where id=assessment_source_test.id(41)for update;
 begin update public.engagements set estate_id=assessment_source_test.id(90)where id=assessment_source_test.id(41);raise exception 'admitted estate changed';exception when check_violation then null;end;
 perform assessment_source_test.ok((select estate_id is null from public.engagements where id=assessment_source_test.id(41)),'refused racing estate mutation preserves original scope');
end$$;
SQL
race 'select assessment_source_test.refuse_estate()' 'select assessment_source_test.enqueue(214)'
grep -q run_id "$result_dir/second"
[ "$(sql -c 'select count(*)from public.public_control_assessment_sources where job_id=assessment_source_test.id(214)and estate_id is null')" = 1 ]
sql -c 'update public.engagements set estate_id=null where id=assessment_source_test.id(41)'
prior=$(sql -c "select value->>'id' from assessment_source_test.review")
race "select assessment_source_test.save(assessment_source_test.request(53,'$prior'))" 'select assessment_source_test.enqueue(215)'
grep -q review_source_changed "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_dispatch_jobs where id in (assessment_source_test.id(212),assessment_source_test.id(213),assessment_source_test.id(215))')" = 0 ]
echo 'Public control assessment races: one stable-key dispatch; late role/internal/head changes block new dispatch; refused estate mutation preserves existing receipts and admits only unchanged in-scope new work.'

# Restore the current head used by both competing exact intents.
sql -c "update assessment_source_test.review set value=(select to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text) from public.public_control_review_sets r where tenant_id=assessment_source_test.id(31) and not exists(select 1 from public.public_control_review_sets n where n.previous_review_id=r.id))"
race 'select assessment_source_test.cancel_intent(241)' 'select assessment_source_test.enqueue(241)'
grep -q '"state": "cancelled"' "$result_dir/first"
grep -q assessment_source_cancelled "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_dispatch_jobs where id=assessment_source_test.id(241)')" = 0 ]
race 'select assessment_source_test.enqueue(242)' 'select assessment_source_test.cancel_intent(242)'
grep -q '"run_id"' "$result_dir/first"
grep -q '"state": "recorded"' "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_source_cancellations where job_id=assessment_source_test.id(242)')" = 0 ]
echo 'Source intent cancellation: both actual competing race orders preserve exactly one authoritative outcome.'
# Generic callers must not check absence BEFORE waiting for the same job lock.
# These regressions exercise both legacy plain enqueue and generic receipt-only
# recovery against the committing source transaction.
sql <<'SQL'
create function assessment_source_test.plain_enqueue(job int) returns jsonb language plpgsql as $$
declare r jsonb;begin set local role human_action_writer;
 r:=public.enqueue_assessment_dispatch(assessment_source_test.id(job),assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(81),null,assessment_source_test.id(41),assessment_source_test.id(job),repeat('a',64),encode(sha256(convert_to(job::text,'UTF8')),'hex'),now()+interval '5 minutes','arn:aws:kms:ap-south-1:123456789012:key/'||assessment_source_test.id(83)::text,decode(repeat('ab',12),'hex'),decode(repeat('ab',100),'hex'),decode(repeat('cd',32),'hex'),1,(select value->>'fingerprint' from assessment_source_test.policy));reset role;return r;
exception when others then reset role;raise;end$$;
create function assessment_source_test.generic_recover(job int) returns jsonb language plpgsql as $$
declare r jsonb;v jsonb:=(select value from assessment_source_test.review);snap jsonb;body text;input_hash text;begin
 snap:=(v->>'snapshot_text')::jsonb;
 body:=controller_security.canonical_questionnaire_json(jsonb_build_object('tenant_id',assessment_source_test.id(31),'engagement_id',assessment_source_test.id(41),'library_version','0.1.1','answers',snap->'normalizedAnswers','sdf_self_attested',snap->'request'->'applicability'->'sdfSelfAttested','processes_children',snap->'request'->'applicability'->'processesChildren','processes_health',snap->'request'->'applicability'->'processesHealth'));
 input_hash:=encode(sha256(convert_to(body,'UTF8')),'hex');
 set local role human_action_writer;
 r:=public.recover_reviewed_assessment_dispatch(assessment_source_test.id(job),assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(81),null,assessment_source_test.id(41),assessment_source_test.id(job),input_hash,'0.1.1',((v->>'request_text')::jsonb)->'expectedSource'->>'questionnaireDigest');reset role;return r;
exception when others then reset role;raise;end$$;
SQL
race 'select assessment_source_test.cancel_intent(251)' 'select assessment_source_test.plain_enqueue(251)'
grep -q '"state": "cancelled"' "$result_dir/first"
grep -q assessment_source_cancelled "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_dispatch_jobs where id=assessment_source_test.id(251)')" = 0 ]
race 'select assessment_source_test.enqueue(252)' 'select assessment_source_test.generic_recover(252)'
grep -q dispatch_conflict "$result_dir/second"
echo 'Generic precheck races: cancelled key cannot enter legacy plain enqueue; source-attached receipt cannot drop its reference.'
sql <<'SQL'
create function assessment_source_test.generic_cancel(job int) returns jsonb language plpgsql as $$
declare r jsonb;v jsonb:=(select value from assessment_source_test.review);snap jsonb;body text;input_hash text;begin
 snap:=(v->>'snapshot_text')::jsonb;
 body:=controller_security.canonical_questionnaire_json(jsonb_build_object('tenant_id',assessment_source_test.id(31),'engagement_id',assessment_source_test.id(41),'library_version','0.1.1','answers',snap->'normalizedAnswers','sdf_self_attested',snap->'request'->'applicability'->'sdfSelfAttested','processes_children',snap->'request'->'applicability'->'processesChildren','processes_health',snap->'request'->'applicability'->'processesHealth'));
 input_hash:=encode(sha256(convert_to(body,'UTF8')),'hex');set local role human_action_writer;
 r:=public.cancel_unclaimed_assessment_request(assessment_source_test.id(31),assessment_source_test.id(1),assessment_source_test.id(job),assessment_source_test.id(41),'0.1.1',input_hash);reset role;return r;
exception when others then reset role;raise;end$$;
SQL
race 'select assessment_source_test.enqueue(253)' 'select assessment_source_test.generic_cancel(253)'
grep -q cancellation_conflict "$result_dir/second"
[ "$(sql -c 'select count(*) from public.assessment_request_resolutions where job_id=assessment_source_test.id(253)')" = 0 ]
echo 'Generic cancel precheck race preserves the attached job and requires its exact source reference.'
