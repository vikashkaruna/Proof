begin;
create function pg_temp.ok(condition boolean,message text) returns void language plpgsql as $$begin if condition is distinct from true then raise exception 'FAILED: %',message;end if;end $$;
insert into auth.users(id,email) values('01350000-0000-4000-8000-000000000001','intake@test.invalid');
insert into public.users(id,email,is_axiom_internal) values('01350000-0000-4000-8000-000000000001','intake@test.invalid',true);
insert into public.tenants(id,slug,name) values('01350000-0000-4000-8000-000000000011','intake-a','Intake A'),('01350000-0000-4000-8000-000000000012','intake-b','Intake B');
insert into public.tenant_users(tenant_id,user_id,role) values('01350000-0000-4000-8000-000000000011','01350000-0000-4000-8000-000000000001','owner');
update public.control_libraries set is_current=false where is_current;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current,status) values('intake-135',now(),'fixture','fixture',0,true,'published');
insert into public.estates(id,tenant_id,slug,name) values('01350000-0000-4000-8000-000000000021','01350000-0000-4000-8000-000000000011','intake','Intake estate');
create function pg_temp.create_intake(k text default 'operation-135',id uuid default '01350000-0000-4000-8000-000000000031',title text default 'Reviewed intake',estate uuid default '01350000-0000-4000-8000-000000000021',lib text default 'intake-135') returns jsonb language sql as $$
 select public.create_engagement_intake('01350000-0000-4000-8000-000000000011','01350000-0000-4000-8000-000000000001',k,id,title,lib,estate,gen_random_uuid());$$;
do $$declare r jsonb;again jsonb;before_count bigint;role_name text;begin
 r:=pg_temp.create_intake();
 perform pg_temp.ok(r->>'estate_id'='01350000-0000-4000-8000-000000000021' and r->>'tenant_id'='01350000-0000-4000-8000-000000000011'
  and r->>'library_version'='intake-135' and r->>'title'='Reviewed intake' and r->>'status'='intake'
  and r ? 'created_at' and r ? 'started_at' and r ? 'posture_score','existing full engagement response contract preserved');
 perform pg_temp.ok(r->>'legacy'='false' and r->>'replayed'='false' and r->>'receipt' is not null,'new intake audited');
 again:=pg_temp.create_intake();
 perform pg_temp.ok(again->>'id'=r->>'id' and again->>'receipt'=r->>'receipt' and again->>'replayed'='true','lost response replay returns original receipt');
 perform pg_temp.ok((select count(*)=1 from public.engagement_intake_receipts),'one creation receipt');
 again:=pg_temp.create_intake('alternate-header');
 perform pg_temp.ok(again->>'receipt'=r->>'receipt','PK replay with another header retained');
 perform pg_temp.ok(pg_temp.create_intake('alternate-header','01350000-0000-4000-8000-000000000039')->>'error'='request_key_conflict','alternate header cannot authorize another intent');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='engagement.created'),'one creation event');
 perform pg_temp.ok(pg_temp.create_intake('operation-135','01350000-0000-4000-8000-000000000031','Changed title')->>'error'='request_key_conflict','changed body refused');
 -- Replays return truthful saved lifecycle metadata, not fabricated intake state.
 update public.engagements set status='assessment' where id='01350000-0000-4000-8000-000000000031';
 again:=pg_temp.create_intake();
 perform pg_temp.ok(again->>'status'='assessment' and again->>'receipt'=r->>'receipt','current metadata and original receipt on replay');
 -- Immutable accepted intent remains replayable after mutable lifecycle changes.
 update public.estates set status='archived' where id='01350000-0000-4000-8000-000000000021';
 update public.control_libraries set is_current=false where version='intake-135';
 perform pg_temp.ok(pg_temp.create_intake()->>'receipt'=r->>'receipt','exact replay survives later lifecycle');
 perform pg_temp.ok(pg_temp.create_intake('different-operation','01350000-0000-4000-8000-000000000032')->>'error'='invalid_library','new intake checks library');
 update public.control_libraries set is_current=true where version='intake-135';
 perform pg_temp.ok(pg_temp.create_intake('different-operation','01350000-0000-4000-8000-000000000032')->>'error'='estate_archived','new intake checks estate');
 perform pg_temp.ok(pg_temp.create_intake('foreign-estate','01350000-0000-4000-8000-000000000032','Reviewed intake','01350000-0000-4000-8000-000000000099')->>'error'='invalid_reference','foreign or missing estate refused');
 update public.estates set status='active' where id='01350000-0000-4000-8000-000000000021';
 update public.tenant_users set role='viewer' where tenant_id='01350000-0000-4000-8000-000000000011';
 perform pg_temp.ok(pg_temp.create_intake()->>'error'='forbidden','demoted actor cannot replay');
 foreach role_name in array array['founder','axiom_analyst','owner','admin','reviewer'] loop
  update public.tenant_users set role=role_name::public.user_role where tenant_id='01350000-0000-4000-8000-000000000011';
  perform pg_temp.ok(pg_temp.create_intake()->>'receipt'=r->>'receipt','exact capability role parity');
 end loop;
 update public.tenant_users set role='axiom_analyst' where tenant_id='01350000-0000-4000-8000-000000000011';
 update public.users set is_axiom_internal=false where id='01350000-0000-4000-8000-000000000001';
 perform pg_temp.ok(pg_temp.create_intake()->>'error'='forbidden','offboarded analyst refused');
 update public.users set is_axiom_internal=true where id='01350000-0000-4000-8000-000000000001';
 update public.tenant_users set role='owner' where tenant_id='01350000-0000-4000-8000-000000000011';
 -- Historical rows are read back honestly, without a new creation event.
 insert into public.engagements(id,tenant_id,library_version,title,lead_reviewer_id,estate_id) values('01350000-0000-4000-8000-000000000041','01350000-0000-4000-8000-000000000011','intake-135','Reviewed intake','01350000-0000-4000-8000-000000000001','01350000-0000-4000-8000-000000000021');
 again:=pg_temp.create_intake('historical-key','01350000-0000-4000-8000-000000000041');
 perform pg_temp.ok(again->>'legacy'='true' and again->>'receipt' is null,'legacy replay not fabricated');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='engagement.created'),'no historical creation event');
 begin
  update public.engagement_intake_receipts set operation_key='changed-key';
  raise exception 'receipt update allowed';
 exception when insufficient_privilege then null;end;
 set constraints intake_receipt_binding,intake_ledger_binding immediate;
 begin truncate public.engagement_intake_receipts;raise exception 'receipt truncate allowed';exception when insufficient_privilege then null;end;
 set constraints intake_receipt_binding,intake_ledger_binding deferred;
end $$;
-- Real deferred anti-forgery checks must fail without a matching receipt.
do $$begin
 begin
  perform public.append_ledger('01350000-0000-4000-8000-000000000011',gen_random_uuid(),'human','01350000-0000-4000-8000-000000000001',null,null,null,'engagement.created','forged',null,null,null,null,null,null,'success','{}');
  set constraints intake_ledger_binding immediate;
  raise exception 'naked creation event allowed';
 exception when check_violation then null;end;
end $$;
-- A ledger failure rolls back intake creation, not just its receipt.
create function pg_temp.fail_intake_ledger() returns trigger language plpgsql as $$begin if new.action_type::text='engagement.created' then raise exception 'fixture ledger unavailable' using errcode='P0135';end if;return new;end $$;
create trigger intake_fixture_failure before insert on public.audit_ledger for each row execute function pg_temp.fail_intake_ledger();
do $$declare before_count bigint;begin
 select count(*) into before_count from public.engagements;
 begin perform pg_temp.create_intake('ledger-failure','01350000-0000-4000-8000-000000000051');raise exception 'ledger failure ignored';exception when sqlstate 'P0135' then null;end;
 perform pg_temp.ok((select count(*)=before_count from public.engagements),'ledger failure rolls back intake');
end $$;
drop trigger intake_fixture_failure on public.audit_ledger;
set constraints all immediate;
select pg_temp.ok(has_function_privilege('human_action_writer','public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid)','execute'),'human writer RPC');
select pg_temp.ok(not has_function_privilege('service_role','public.create_engagement_intake(uuid,uuid,text,uuid,text,text,uuid,uuid)','execute'),'generic reader cannot create');
select pg_temp.ok(not has_table_privilege('human_action_writer','public.engagement_intake_receipts','insert'),'no raw receipt write');
select pg_temp.ok(not has_function_privilege('human_action_writer','controller_security.create_engagement_intake_before_0136(uuid,uuid,text,uuid,text,text,uuid,uuid)','execute'),'private inner intake inaccessible to caller');
rollback;
