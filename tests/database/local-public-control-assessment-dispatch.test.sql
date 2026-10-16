-- Generated synthetic prefix is prepended by the canonical harness. SQL-only
-- session/MFA stand-ins do not establish real Auth, SPIRE or local key custody.
create function local147_fixture.publish_cloud() returns jsonb language plpgsql as $$
declare v jsonb;ref text:='arn:aws:kms:ap-south-1:123456789012:key/'||local147_fixture.id(180);begin
 set local role human_action_writer;
 v:=public.publish_assessment_dispatch_key_policy(local147_fixture.id(31),local147_fixture.id(1),local147_fixture.id(180),0,'aws',ref,array[ref]);reset role;return v;
exception when others then reset role;raise;end$$;
savepoint cloud_first;
select local147_fixture.ok(not local147_fixture.publish_cloud()?'error','existing cloud publisher can win before first accepted local job');
select local147_fixture.ok(local147_fixture.enqueue(301)->>'error'='local_policy_stale','cloud publication winning first refuses NEW local admission');
select local147_fixture.ok((select count(*)=0 from public.assessment_dispatch_jobs where tenant_id=local147_fixture.id(31)) and (select count(*)=0 from public.assessment_local_custody_authorizations where tenant_id=local147_fixture.id(31)),'provider contention leaves no orphan local job/grant');
rollback to cloud_first;
create temporary table local147_saved(n int primary key,v jsonb);
insert into local147_saved values(301,local147_fixture.enqueue(301)),(302,local147_fixture.enqueue(302)),(303,local147_fixture.enqueue(303));
select local147_fixture.ok((select bool_and(not v?'error') from local147_saved),'three genuine atomic local NEW receipts');
set constraints all immediate;set constraints all deferred;
select local147_fixture.ok((select count(*)=3 from public.assessment_local_custody_authorizations where tenant_id=local147_fixture.id(31)),'exactly three immutable accepted grants');
select local147_fixture.ok((select count(*)=3 from public.public_control_assessment_sources where tenant_id=local147_fixture.id(31)),'exactly three immutable source sidecars');
select local147_fixture.ok((select bool_and((r.snapshot_text::jsonb)->>'version'='2') from public.public_control_assessment_sources s join public.public_control_review_sets r on r.id=s.review_id where s.tenant_id=local147_fixture.id(31)),'real registered asset review2 retained');
select local147_fixture.ok((select bool_and(g.grant_text=controller_security.canonical_questionnaire_json(controller_security.local143_job_grant(g))) from public.assessment_local_custody_authorizations g where g.tenant_id=local147_fixture.id(31)),'grants bind actual original run/task/ledger/key');
select local147_fixture.ok((select bool_and(l.actor_type='human' and l.action_type='assessment.requested' and l.detail->>'custody_policy_id'=g.policy_id::text) from public.assessment_local_custody_authorizations g join public.audit_ledger l on l.id=g.request_receipt_id where g.tenant_id=local147_fixture.id(31)),'actual human request is not custody approval impersonation');
select local147_fixture.ok((select count(*)=0 from public.assessment_dispatch_key_policies where tenant_id=local147_fixture.id(31)),'no cloud provider disguise');
select local147_fixture.ok(local147_fixture.publish_cloud()->>'error'='policy_keys_required','local enqueue winning first prevents cloud publisher from dropping original local key readability');
create temporary table local147_before as select
 (select count(*) from public.audit_ledger) ledger,
 (select count(*) from public.assessment_dispatch_jobs) jobs,
 (select count(*) from public.agent_runs) runs,
 (select count(*) from public.workload_task_delegations) tasks,
 (select count(*) from public.public_control_assessment_sources) sources,
 (select count(*) from public.assessment_local_custody_authorizations) grants;
select local147_fixture.ok(local147_fixture.enqueue(301)=(select v from local147_saved where n=301),'lost response exact replay returns same receipt');
select local147_fixture.ok(local147_fixture.enqueue(301,3,'{"keyRef":"axiom-local-dispatch://stale","policySha256":"stale","activationEpoch":99}')=(select v from local147_saved where n=301),'historical recovery does not rewrap or renew under changed configuration');
select local147_fixture.ok(local147_fixture.enqueue(301,3,jsonb_build_object('inputHash',repeat('f',64)))->>'error'='dispatch_conflict','changed historical input refused');
select local147_fixture.ok(local147_fixture.enqueue(311,3,jsonb_build_object('policySha256',repeat('f',64)))->>'error'='local_policy_stale','NEW wrong policy hash refused');
select local147_fixture.ok(local147_fixture.enqueue(312,3,'{"activationEpoch":99}')->>'error'='local_policy_stale','NEW wrong activation epoch refused');
select local147_fixture.ok(local147_fixture.enqueue(313,6)->>'error'='forbidden','viewer cannot enqueue');
select local147_fixture.ok(local147_fixture.enqueue(322,3,jsonb_build_object('reviewRequestSha256',repeat('f',64)))->>'error'='review_source_refused','wrong retained review request hash refused');
select local147_fixture.ok(local147_fixture.enqueue(323,3,jsonb_build_object('reviewSnapshotSha256',repeat('f',64)))->>'error'='review_source_refused','wrong retained review snapshot hash refused');
savepoint library_changed;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,status) values('local147-other',now(),'Synthetic','Not pinned',0,'draft');
update public.engagements set library_version='local147-other' where id=local147_fixture.id(41);
select local147_fixture.ok(local147_fixture.enqueue(324)?'error','changed engagement library cannot bypass pinned questionnaire source');
rollback to library_changed;
do $$begin
 begin update public.controls set assessment_questions='[]' where library_version='0.1.1' and id='DPDPA-GOV-001';raise exception 'published questionnaire mutable';
 exception when sqlstate 'P0001' then if sqlerrm is distinct from 'Controls are immutable; publish a new library version instead.' then raise;end if;end;
 begin update public.control_libraries set control_count=45 where version='0.1.1';raise exception 'published catalogue mutable';
 exception when insufficient_privilege then if sqlerrm is distinct from 'Published library source is immutable' then raise;end if;end;
end$$;

select local147_fixture.ok(local147_fixture.claim(301,jsonb_build_object('policySha256',repeat('f',64)))->>'error'='local_dispatch_unavailable','wrong claim policy does not spend delivery');
do $$begin
 begin perform local147_fixture.claim(301,jsonb_build_object('tenantId',local147_fixture.id(32)));raise exception 'foreign controller accepted';exception when insufficient_privilege then null;end;
end $$;
-- A grant insert failure happens AFTER delegation, outbox, request ledger and
-- source writes. Everything must roll back, not leave a recoverable half-job.
create function local147_fixture.reject_grant() returns trigger language plpgsql as $$begin raise exception 'synthetic grant persistence failure' using errcode='22023';end$$;
create trigger local147_fault before insert on public.assessment_local_custody_authorizations for each row execute function local147_fixture.reject_grant();
do $$begin
 begin perform local147_fixture.enqueue(314);raise exception 'fault not exercised';exception when invalid_parameter_value then null;end;
end$$;
drop trigger local147_fault on public.assessment_local_custody_authorizations;
select local147_fixture.ok((select ledger=(select count(*) from public.audit_ledger) and jobs=(select count(*) from public.assessment_dispatch_jobs) and runs=(select count(*) from public.agent_runs) and tasks=(select count(*) from public.workload_task_delegations) and sources=(select count(*) from public.public_control_assessment_sources) and grants=(select count(*) from public.assessment_local_custody_authorizations) from local147_before),'replays/refusals and late fault create no duplicate/orphan authority');
-- Current owner/founder/operator checks apply to NEW admissions; no policy
-- lifetime is renewed by an overdue reminder, nor by any replay.
savepoint retired_founder;
update public.tenant_users set role='viewer' where tenant_id=local147_fixture.id(31) and user_id=local147_fixture.id(1);
select local147_fixture.ok(local147_fixture.enqueue(315)->>'error'='local_policy_stale','retired founder approval cannot admit NEW job');
rollback to retired_founder;
savepoint stopped;
update public.kill_switch_state set engaged=true where scope_key='global';
select local147_fixture.ok(local147_fixture.enqueue(316)?'error','global stop blocks NEW job');
select local147_fixture.ok(local147_fixture.claim(301)?'error','global stop blocks claim without spending');
rollback to stopped;
savepoint missing_source;
update public.estates set status='archived' where id=local147_fixture.id(71);
do $$begin begin perform local147_fixture.enqueue(317);raise exception 'archived estate accepted';exception when invalid_parameter_value then null;end;end$$;
rollback to missing_source;
savepoint withdrawn;
select local147_fixture.ok(local147_fixture.asset_write(jsonb_build_object('version',1,'kind','withdraw','operationKey',local147_fixture.id(318),'confirmed',true,'subjectType','association','subjectId',(value->>'snapshotText')::jsonb->>'id','expectedSubjectSha256',value->>'snapshotSha256','reason','Synthetic mistaken association'))->>'state'='recorded','actual audited association withdrawal') from local147_fixture.asset_operations where kind='association';
do $$begin begin perform local147_fixture.enqueue(319);raise exception 'withdrawn source accepted';exception when invalid_parameter_value then null;end;end$$;
select local147_fixture.ok(local147_fixture.enqueue(301)=(select v from local147_saved where n=301),'historical positive readback survives source withdrawal');
rollback to withdrawn;
select local147_fixture.ok(local147_fixture.revoke_policy()->>'transition'='revoke','actual audited owner policy revocation');
select local147_fixture.ok(local147_fixture.enqueue(320)->>'error'='local_policy_stale','revoked policy blocks NEW admission');
select local147_fixture.ok(local147_fixture.enqueue(301)=(select v from local147_saved where n=301),'accepted receipt remains exact after policy revocation');
create temporary table local147_claimed as select local147_fixture.claim(301) v;
select local147_fixture.ok((select v->>'job_id'=local147_fixture.id(301)::text and v->'local_custody'->>'grant_sha256'=(select grant_sha256 from public.assessment_local_custody_authorizations where job_id=local147_fixture.id(301)) from local147_claimed),'accepted job may claim after custody policy revocation under original immutable grant');
select local147_fixture.ok(local147_fixture.claim(301)->>'error'='dispatch_reconciliation_required','lost claim response never delivers ciphertext twice');
savepoint actor_retired;
update public.tenant_users set role='viewer' where tenant_id=local147_fixture.id(31) and user_id=local147_fixture.id(3);
select local147_fixture.ok(local147_fixture.claim(302)?'error','accepted job retains live actor gate');
rollback to actor_retired;
select local147_fixture.ok(public.revoke_workload_task(local147_fixture.id(31),local147_fixture.id(3),(select (v->>'run_id')::uuid from local147_saved where n=302),local147_fixture.id(321))='{"revoked":true}'::jsonb,'actual task revocation recorded');
select local147_fixture.ok(local147_fixture.claim(302)?'error','task revocation blocks accepted grant');
select local147_fixture.ok((select count(*)=0 from public.assessment_dispatch_jobs j left join public.assessment_local_custody_authorizations g on g.job_id=j.id where j.tenant_id=local147_fixture.id(31) and g.job_id is null),'no job without atomic grant');
select local147_fixture.ok((select count(*)=0 from public.verify_ledger(local147_fixture.id(31))),'append-only ledger chain valid');
select local147_fixture.ok(not has_function_privilege('service_role','public.claim_local_assessment_dispatch(uuid,uuid,uuid,text,text)','EXECUTE'),'generic service cannot claim local custody');
select local147_fixture.ok(not has_function_privilege('axiom_local_custody_verifier','public.claim_local_assessment_dispatch(uuid,uuid,uuid,text,text)','EXECUTE'),'key-service verifier cannot claim');
select local147_fixture.ok(not has_function_privilege('human_action_writer','public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea)','EXECUTE'),'human cannot bypass narrow local admission');
set constraints all immediate;
rollback;
