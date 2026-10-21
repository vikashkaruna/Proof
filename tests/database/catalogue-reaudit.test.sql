-- Run after catalogue-founder-approval fixture (without its rollback) and the
-- two current-version helper definitions. Synthetic SQL factors are not TOTP.
insert into public.platform_founders(user_id,designated_by,designation_reason)values(pg_temp.id(1),'synthetic owner','Synthetic re-audit authority');
create function pg_temp.denied(q text,expected text default '42501')returns void language plpgsql as $$begin begin execute q;exception when others then if sqlstate=expected then return;end if;raise;end;raise exception 'ASSERTION: unauthorized SQL succeeded';end$$;
create temporary table engagement178_saved(k text primary key,v jsonb,r text);
grant select,insert,update on engagement178_saved to service_role,human_action_writer;
create function pg_temp.release178(n int,v text)returns void language plpgsql as $$declare r text:=pg_temp.current_request(n,v);c uuid;begin c:=pg_temp.current_challenge(r);set local role human_action_writer;perform public.set_current_catalogue_version(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c);reset role;end$$;
select pg_temp.release178(17801,'0.1.1');
insert into public.estates(id,tenant_id,slug,name)values(pg_temp.id(17810),pg_temp.id(11),'reaudit-estate','Synthetic re-audit estate');
-- Application intake has no superuser/import bypass despite SECURITY DEFINER.
set local role human_action_writer;
insert into engagement178_saved values('intake',public.create_engagement_intake(pg_temp.id(11),pg_temp.id(2),'catalogue178-initial',pg_temp.id(17811),'Original audited basis','0.1.1',pg_temp.id(17810),pg_temp.id(17812)),null);
reset role;
select pg_temp.ok((select basis='current_default'from public.catalogue_engagement_admissions where engagement_id=pg_temp.id(17811)),'human intake requires released default');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)values(pg_temp.id(17820),pg_temp.id(11),'parikshan','spiffe://local.axiomproof.test/agent/parikshan','active');
set local role human_action_writer;
insert into engagement178_saved values('delegation',public.delegate_workload_task(pg_temp.id(11),pg_temp.id(2),pg_temp.id(17820),'parikshan',pg_temp.id(17810),pg_temp.id(17811),pg_temp.id(17821),repeat('a',64),repeat('b',64),array['control_library.read','findings.write'],clock_timestamp()+interval'10 minutes'),null);
reset role;
set local role service_role;
insert into engagement178_saved select 'start',public.start_workload_assessment(pg_temp.id(11),(v->>'run_id')::uuid,pg_temp.id(17820),repeat('b',64),repeat('a',64),clock_timestamp()+interval'5 minutes'),null from engagement178_saved where k='delegation';
insert into engagement178_saved select 'complete',public.complete_workload_assessment(pg_temp.id(11),(select(v->>'run_id')::uuid from engagement178_saved where k='delegation'),pg_temp.id(17820),repeat('b',64),v->>'library_digest',jsonb_build_object('library_version','0.1.1','posture_score',0,'estimated_exposure_inr',0,'findings',(select jsonb_agg(jsonb_build_object('control_id',c->>'id','score',0,'risk_points',0,'rationale','Synthetic canonical baseline'))from jsonb_array_elements(v->'controls')c)),clock_timestamp()+interval'5 minutes'),null from engagement178_saved where k='start';
insert into engagement178_saved select 'confirm',public.confirm_workload_assessment(pg_temp.id(11),(v->>'run_id')::uuid),null from engagement178_saved where k='delegation';
reset role;
select pg_temp.ok((select public.board_assessment_source_valid(pg_temp.id(11),(v->>'run_id')::uuid,pg_temp.id(17811))from engagement178_saved where k='delegation'),'canonical actual assessment finalized with independent ledger chain');
select pg_temp.release178(17802,'0.2.0');
insert into engagement178_saved values('status',public.read_catalogue_engagement(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102)),null);
select pg_temp.ok((select v->>'effectiveVersion'='0.1.1'and v->>'currentVersion'='0.2.0'and v->>'hasFinalizedAudit'='true'and jsonb_array_length(v->'upgradeOptions')=1 from engagement178_saved where k='status'),'audited basis retained with explicit available delta');
select pg_temp.ok((select jsonb_array_length(v#>'{upgradeOptions,0,delta,changed}')>0 from engagement178_saved where k='status'),'per-control changed fields visible');
-- An unaudited organization defaults to globally released current version.
insert into public.tenants(id,slug,name)values(pg_temp.id(17830),'catalogue178-new','New unaudited company');
insert into public.tenant_users(tenant_id,user_id,role)values(pg_temp.id(17830),pg_temp.id(2),'owner');
insert into public.estates(id,tenant_id,slug,name)values(pg_temp.id(17831),pg_temp.id(17830),'new-estate','New estate');
select pg_temp.ok(public.read_catalogue_engagement(pg_temp.id(17830),pg_temp.id(2),pg_temp.id(102))->>'effectiveVersion'='0.2.0','unaudited default follows release');
set local role human_action_writer;
select pg_temp.denied(format('select public.create_engagement_intake(%L,%L,%L,%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(2),'catalogue178-bypass',pg_temp.id(17840),'Unauthorized version upgrade','0.2.0',pg_temp.id(17810),pg_temp.id(17841)));
-- Existing engagements remain usable; generic intake keeps its current-only
-- requirement. Re-audit admission is granted only through its dedicated RPC.

select pg_temp.ok(public.create_engagement_intake(pg_temp.id(17830),pg_temp.id(2),'catalogue178-new-current',pg_temp.id(17844),'New current version work','0.2.0',pg_temp.id(17831),pg_temp.id(17845))->>'library_version'='0.2.0','new organization current intake');
select pg_temp.denied(format('insert into public.engagements(id,tenant_id,estate_id,library_version,title)values(%L,%L,%L,%L,%L)',pg_temp.id(17846),pg_temp.id(11),pg_temp.id(17810),'0.2.0','Raw human bypass'));
select pg_temp.ok(public.create_engagement_intake(pg_temp.id(17830),pg_temp.id(2),'catalogue178-first-attachment',pg_temp.id(17848),'Unscoped initial intake','0.2.0',null,pg_temp.id(17849))->>'library_version'='0.2.0','initial intake can precede estate attachment');
reset role;
update public.engagements set estate_id=pg_temp.id(17831)where id=pg_temp.id(17848);
select pg_temp.ok((select estate_id=pg_temp.id(17831)from public.engagements where id=pg_temp.id(17848)),'first estate attachment before any task is allowed');
select pg_temp.denied(format('update public.engagements set estate_id=null where id=%L',pg_temp.id(17848)),'23514');
set local role authenticated;
select pg_temp.denied(format('insert into public.engagements(id,tenant_id,estate_id,library_version,title)values(%L,%L,%L,%L,%L)',pg_temp.id(17846),pg_temp.id(11),pg_temp.id(17810),'0.2.0','Raw JWT bypass'));
select pg_temp.denied('select *from public.catalogue_reaudit_requests');
reset role;
set local role service_role;
select pg_temp.denied(format('insert into public.engagements(id,tenant_id,estate_id,library_version,title)values(%L,%L,%L,%L,%L)',pg_temp.id(17846),pg_temp.id(11),pg_temp.id(17810),'0.2.0','Raw service bypass'));
select pg_temp.denied(format('select public.submit_catalogue_reaudit(%L,%L,%L,%L,%L,false)',pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),'{}',pg_temp.id(17847)));
reset role;
-- Privileged synthetic run contexts prove that non-discovery work freezes a
-- formerly NULL estate even without a finalized packet or delegated task.
do $$declare agent_name text;eid uuid;begin
 foreach agent_name in array array['parikshan','sudhaar']loop
  eid:=gen_random_uuid();
  insert into public.engagements(id,tenant_id,library_version,title)values(eid,pg_temp.id(17830),'0.2.0','Synthetic non-discovery scope');
  insert into public.agent_runs(tenant_id,agent,engagement_id,correlation_id,status)values(pg_temp.id(17830),agent_name,eid,gen_random_uuid(),'running');
  perform pg_temp.denied(format('update public.engagements set estate_id=%L where id=%L',pg_temp.id(17831),eid),'23514');
 end loop;
end$$;
create function pg_temp.reaudit178_request(n int)returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(n),'baselineRunId',v#>>'{upgradeOptions,0,baselineRunId}','targetVersion','0.2.0','deltaSha256',v#>>'{upgradeOptions,0,delta,sha256}','reason','Owner requests continued delta audit engagement','confirmed',true))from engagement178_saved where k='status'$$;
create function pg_temp.reaudit178_decision(n int,d text default 'approve')returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',pg_temp.id(n),'requestId',pg_temp.id(17850),'decision',d,'reason','Founder reviews bounded continued engagement','confirmed',true))$$;
create function pg_temp.reaudit178_challenge(actor int,r text,d boolean)returns uuid language plpgsql as $$declare c uuid:=gen_random_uuid();binding text;begin
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array(case when d then'axiom.catalogue-reaudit.decision'else'axiom.catalogue-reaudit.request'end,1,pg_temp.id(11)::text,pg_temp.id(actor)::text,pg_temp.id(100+actor)::text,encode(sha256(convert_to(r,'UTF8')),'hex'))),'UTF8')),'hex');
 insert into public.mfa_challenges(id,user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at,satisfied_at,consumed_at,consumed_for,satisfied_with)values(c,pg_temp.id(actor),pg_temp.id(11),pg_temp.id(40+actor),'catalogue_adoption',r::jsonb->>'operationKey',binding,clock_timestamp()-interval'2 seconds',clock_timestamp()+interval'4 minutes',clock_timestamp()-interval'1 second',clock_timestamp(),r::jsonb->>'operationKey','totp');return c;
end$$;
-- An old completed record without independently valid retained proof is
-- conservatively retained for review, never treated as unaudited.
insert into public.tenants(id,slug,name)values(pg_temp.id(17832),'catalogue178-legacy','Historical completed company');
insert into public.tenant_users(tenant_id,user_id,role)values(pg_temp.id(17832),pg_temp.id(2),'owner');
insert into public.engagements(id,tenant_id,library_version,title,status,completed_at)values(pg_temp.id(17833),pg_temp.id(17832),'0.1.1','Historical import only','completed',clock_timestamp());
select pg_temp.ok(public.read_catalogue_engagement(pg_temp.id(17832),pg_temp.id(2),pg_temp.id(102))->>'historicalAuditNeedsReview'='true','legacy historical record blocks automatic upgrade');
set local role human_action_writer;
select pg_temp.denied(format('select public.create_engagement_intake(%L,%L,%L,%L,%L,%L,null,%L)',pg_temp.id(17832),pg_temp.id(2),'catalogue178-legacy-bypass',pg_temp.id(17834),'Legacy unauthorized upgrade','0.2.0',pg_temp.id(17835)));
reset role;
select pg_temp.denied(format('select public.preflight_catalogue_reaudit(%L,%L,%L,%L,false)',pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),controller_security.canonical_questionnaire_json(jsonb_set(pg_temp.reaudit178_request(17850)::jsonb,'{deltaSha256}',to_jsonb(repeat('f',64))))),'23514');
select pg_temp.denied(format('select public.preflight_catalogue_reaudit(%L,%L,%L,%L,false)',pg_temp.id(17830),pg_temp.id(2),pg_temp.id(102),pg_temp.reaudit178_request(17850)),'23514');
select pg_temp.denied(format('select public.preflight_catalogue_reaudit(%L,%L,%L,%L,false)',pg_temp.id(11),pg_temp.id(3),pg_temp.id(103),pg_temp.reaudit178_request(17850)));
select pg_temp.denied(format('select public.preflight_catalogue_reaudit(%L,%L,%L,%L,true)',pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),pg_temp.reaudit178_decision(17851)));
do $$declare r text:=pg_temp.reaudit178_request(17850);c uuid;v jsonb;begin
 c:=pg_temp.reaudit178_challenge(2,r,false);set local role human_action_writer;
 v:=public.submit_catalogue_reaudit(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),r,c,false);perform pg_temp.ok(v->>'status'='pending'and v->>'replayed'='false','owner receipt pending only');
 v:=public.submit_catalogue_reaudit(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),r,c,false);perform pg_temp.ok(v->>'replayed'='true','owner exact replay');reset role;
end$$;
select pg_temp.ok((select count(*)=0 from public.catalogue_reaudit_decisions),'owner cannot authorize own upgrade');
do $$declare r text:=pg_temp.reaudit178_request(17852);c uuid;begin c:=pg_temp.reaudit178_challenge(2,r,false);set local role human_action_writer;perform pg_temp.denied(format('select public.submit_catalogue_reaudit(%L,%L,%L,%L,%L,false)',pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),r,c),'23505');reset role;end$$;

-- Caller-selected immediate constraints must support both admission and the
-- decision/parent pair. An injected statement fault must leave neither grant
-- nor intake/admission/ledger row and must restore the FK's immediate behavior.
set constraints all immediate;
create function pg_temp.fail178_intake()returns trigger language plpgsql as $$begin raise exception 'Synthetic re-audit intake failure';end$$;
create trigger fail178_intake before insert on public.engagements for each row execute function pg_temp.fail178_intake();
do $$declare r text:=pg_temp.reaudit178_decision(17853);ch uuid;old_admissions bigint;begin
 ch:=pg_temp.reaudit178_challenge(1,r,true);select count(*)into old_admissions from public.catalogue_engagement_admissions;
 set local role human_action_writer;
 begin perform public.submit_catalogue_reaudit(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,ch,true);raise exception 'injected fault accepted';
 exception when sqlstate 'P0001' then if sqlerrm<>'Synthetic re-audit intake failure'then raise;end if;end;
 reset role;
 perform pg_temp.ok(not exists(select 1 from public.catalogue_reaudit_decisions),'failed grant has no decision');
 perform pg_temp.ok(not exists(select 1 from public.audit_ledger where action_type::text='catalogue.reaudit_decided'),'failed grant has no decision receipt');
 perform pg_temp.ok((select count(*)=old_admissions from public.catalogue_engagement_admissions),'failed grant has no detached admission');
 -- All other FK values reference existing fixture rows; only the deliberately
 -- absent parent tests whether the protected call leaked deferred constraints.
 perform pg_temp.denied(format('insert into public.catalogue_reaudit_decisions(request_id,operation_key,tenant_id,actor_id,session_id,decision,reason,request_text,challenge_id,engagement_id,receipt_id)values(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%s)',pg_temp.id(17850),pg_temp.id(17853),pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),'approve','Synthetic immediate FK probe',r,ch,gen_random_uuid(),(select receipt_id from public.catalogue_reaudit_requests where id=pg_temp.id(17850))),'23503');
end$$;
drop trigger fail178_intake on public.engagements;
-- Bound payload cannot be altered after MFA. Approval creates intake, not report.
do $$declare r text:=pg_temp.reaudit178_decision(17851);c uuid;v jsonb;altered text;begin
 altered:=controller_security.canonical_questionnaire_json(jsonb_set(r::jsonb,'{reason}','"Changed after MFA"'));
 c:=pg_temp.reaudit178_challenge(1,r,true);set local role human_action_writer;
 perform pg_temp.denied(format('select public.submit_catalogue_reaudit(%L,%L,%L,%L,%L,true)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),altered,c));
 v:=public.submit_catalogue_reaudit(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c,true);perform pg_temp.ok(v->>'status'='approved'and v->>'engagementId'is not null,'founder approved bounded intake');insert into engagement178_saved values('decision',v,r);
 perform pg_temp.ok(public.submit_catalogue_reaudit(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),r,c,true)->>'replayed'='true','founder exact replay');reset role;
end$$;
select pg_temp.ok((select status='intake'and library_version='0.2.0'from public.engagements where id=(select(v->>'engagementId')::uuid from engagement178_saved where k='decision')),'approval grants new unfinished assessment');
select pg_temp.ok((select basis='founder_reaudit_grant'from public.catalogue_engagement_admissions where engagement_id=(select(v->>'engagementId')::uuid from engagement178_saved where k='decision')),'specific intake bound to founder grant');
select pg_temp.denied(format('update public.engagements set estate_id=null where id=%L',(select(v->>'engagementId')::uuid from engagement178_saved where k='decision')),'23514');
select pg_temp.denied(format('update public.engagements set estate_id=null where id=%L',pg_temp.id(17811)),'23514');
select pg_temp.ok(public.read_catalogue_engagement(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102))->>'effectiveVersion'='0.1.1','no revised audited result before real re-audit finalization');
select pg_temp.ok((select library_version='0.1.1'from public.engagements where id=pg_temp.id(17811)),'historical original assessment unchanged');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type::text='catalogue.reaudit_requested')and(select count(*)=1 from public.audit_ledger where action_type::text='catalogue.reaudit_decided'),'separate owner and founder receipts');
-- The approved grant admits one bounded new engagement; only a genuine new
-- assessment's finalization changes audited-version tracking.
set local role human_action_writer;
insert into engagement178_saved select 'reaudit-delegation',public.delegate_workload_task(pg_temp.id(11),pg_temp.id(2),pg_temp.id(17820),'parikshan',pg_temp.id(17810),(v->>'engagementId')::uuid,pg_temp.id(17861),repeat('c',64),repeat('d',64),array['control_library.read','findings.write'],clock_timestamp()+interval'10 minutes'),null from engagement178_saved where k='decision';
reset role;
set local role service_role;
insert into engagement178_saved select 'reaudit-start',public.start_workload_assessment(pg_temp.id(11),(v->>'run_id')::uuid,pg_temp.id(17820),repeat('d',64),repeat('c',64),clock_timestamp()+interval'5 minutes'),null from engagement178_saved where k='reaudit-delegation';
insert into engagement178_saved select 'reaudit-complete',public.complete_workload_assessment(pg_temp.id(11),(select(v->>'run_id')::uuid from engagement178_saved where k='reaudit-delegation'),pg_temp.id(17820),repeat('d',64),v->>'library_digest',jsonb_build_object('library_version','0.2.0','posture_score',0,'estimated_exposure_inr',0,'findings',(select jsonb_agg(jsonb_build_object('control_id',c->>'id','score',0,'risk_points',0,'rationale','Synthetic genuine re-audit'))from jsonb_array_elements(v->'controls')c)),clock_timestamp()+interval'5 minutes'),null from engagement178_saved where k='reaudit-start';
select pg_temp.ok(public.read_catalogue_engagement(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102))->>'effectiveVersion'='0.1.1','completed but unfinalized result cannot revise audited basis');
insert into engagement178_saved select 'reaudit-confirm',public.confirm_workload_assessment(pg_temp.id(11),(v->>'run_id')::uuid),null from engagement178_saved where k='reaudit-delegation';
reset role;
select pg_temp.ok((select public.board_assessment_source_valid(pg_temp.id(11),(v->>'run_id')::uuid,(select(v->>'engagementId')::uuid from engagement178_saved where k='decision'))from engagement178_saved where k='reaudit-delegation'),'actual re-audit independently finalized');
select pg_temp.ok(public.read_catalogue_engagement(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102))->>'effectiveVersion'='0.2.0','only finalized new assessment changes audited basis');
select pg_temp.ok((select count(*)=2 from controller_security.catalogue178_baselines(pg_temp.id(11))),'old and new audited history retained');
select pg_temp.ok(jsonb_array_length(public.read_catalogue_engagement(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102))->'upgradeOptions')=0,'completed target no longer recommended as pending re-audit');
select pg_temp.denied('update public.catalogue_reaudit_requests set reason=reason','42501');
select pg_temp.denied('delete from public.catalogue_reaudit_decisions','42501');
set constraints all immediate;
rollback;
