begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-0000000000a1','wizard-admin@test.invalid'),
 ('00000000-0000-4000-8000-0000000000a2','wizard-viewer@test.invalid');
insert into public.users(id,email) values
 ('00000000-0000-4000-8000-0000000000a1','wizard-admin@test.invalid'),
 ('00000000-0000-4000-8000-0000000000a2','wizard-viewer@test.invalid');
insert into public.tenants(id,slug,name) values
 ('00000000-0000-4000-8000-0000000000b1','wizard-a','A'),
 ('00000000-0000-4000-8000-0000000000b2','wizard-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','admin'),
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a2','viewer');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest)
 values ('00000000-0000-4000-8000-0000000000c1','wizard-test','1','sql','sandbox','{}');
create function pg_temp.step(w uuid, s text, v integer, body jsonb) returns jsonb language sql as $$
 select public.advance_onboarding_wizard('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',w,s,v,body,gen_random_uuid());
$$;
set local role service_role;
do $$
declare w uuid; again jsonb; r jsonb; estate uuid; other_estate uuid; crm uuid; hr uuid; events bigint;
begin
 r:=public.start_onboarding_wizard('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a2',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='forbidden','viewer cannot start the wizard');
 r:=public.start_onboarding_wizard('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',gen_random_uuid());
 w:=(r#>>'{resource,id}')::uuid;
 perform pg_temp.ok((r->>'created')::boolean and w is not null,'admin starts a wizard');
 again:=public.start_onboarding_wizard('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',gen_random_uuid());
 perform pg_temp.ok(again#>>'{resource,id}'=w::text and not (again->>'created')::boolean,'resume returns the open run');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='onboarding.wizard.started' and target_ref=w::text),'start audited once');
 perform pg_temp.ok(not (r#>>'{readiness,ready}')::boolean,'new run is not ready');

 r:=pg_temp.step(w,'estate',1,'{}');
 perform pg_temp.ok(r->>'error'='step_out_of_order' and r->>'nextStep'='company','steps cannot be skipped');
 r:=pg_temp.step(w,'company',1,'{"isSdf":false,"processesChildrenData":true,"processesHealthData":false,"dpoName":"Asha","dpoEmail":"not-an-email"}');
 perform pg_temp.ok(r->>'error'='invalid_payload','invalid DPO email refused');
 r:=pg_temp.step(w,'company',1,'{"isSdf":false,"processesChildrenData":true,"processesHealthData":false,"dpoName":"Asha Rao","dpoEmail":"DPO@Example.in"}');
 perform pg_temp.ok(r#>>'{resource,version}'='2','company step recorded');
 perform pg_temp.ok((select dpo_email='dpo@example.in' and processes_children_data from public.tenants where id='00000000-0000-4000-8000-0000000000b1'),'tenant profile updated and email normalised');
 perform pg_temp.ok(not exists(select 1 from public.audit_ledger where action_type='onboarding.wizard.step_completed' and detail::text like '%dpo@example.in%'),'ledger does not copy the DPO email');
 r:=pg_temp.step(w,'estate',1,'{"estateId":"00000000-0000-4000-8000-000000000000"}');
 perform pg_temp.ok(r->>'error'='version_conflict','stale version refused');

 estate:=(public.manage_estate('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','estate.create',null,'{"slug":"wiz-prod","name":"Prod"}',gen_random_uuid())#>>'{resource,id}')::uuid;
 other_estate:=(public.manage_estate('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','estate.create',null,'{"slug":"wiz-sg","name":"SG"}',gen_random_uuid())#>>'{resource,id}')::uuid;
 r:=pg_temp.step(w,'estate',2,jsonb_build_object('estateId',estate));
 perform pg_temp.ok(r#>>'{resource,estate_id}'=estate::text,'estate chosen');
 r:=pg_temp.step(w,'inventory',3,'{}');
 perform pg_temp.ok(r->>'error'='inventory_incomplete','inventory needs a system');
 crm:=(public.manage_estate('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','system.create',estate,'{"name":"CRM","systemKind":"saas","dataCategories":["contact"]}',gen_random_uuid())#>>'{resource,id}')::uuid;
 hr:=(public.manage_estate('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','system.create',estate,'{"name":"HR","systemKind":"database","dataCategories":[]}',gen_random_uuid())#>>'{resource,id}')::uuid;
 r:=pg_temp.step(w,'inventory',3,'{}');
 perform pg_temp.ok(r->>'error'='inventory_incomplete','every system needs a declared category');
 perform public.manage_estate('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','system.update',hr,'{"name":"HR","systemKind":"database","dataCategories":["employment"],"status":"active","expectedVersion":1}',gen_random_uuid());
 r:=pg_temp.step(w,'inventory',3,'{}');
 perform pg_temp.ok(r#>>'{resource,version}'='4','inventory confirmed');

 insert into public.connectors(tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance)
 values ('00000000-0000-4000-8000-0000000000b1',crm,'00000000-0000-4000-8000-0000000000c1','sandbox','CRM reader','crm_reader','high');
 r:=pg_temp.step(w,'connectors',4,'{"manualSystemIds":[]}');
 perform pg_temp.ok(r->>'error'='connection_path_missing' and r->>'missing'='1','system without connector or manual declaration refused');
 r:=pg_temp.step(w,'connectors',4,jsonb_build_object('manualSystemIds',jsonb_build_array('00000000-0000-4000-8000-0000000000ff')));
 perform pg_temp.ok(r->>'error'='not_found','manual declaration must name a system in the estate');
 r:=pg_temp.step(w,'connectors',4,jsonb_build_object('manualSystemIds',jsonb_build_array(hr)));
 perform pg_temp.ok(r#>>'{readiness,counts,manualSystems}'='1' and r#>>'{readiness,counts,registeredConnectors}'='1','connection path recorded');
 r:=pg_temp.step(w,'grants',5,'{"acknowledged":false}');
 perform pg_temp.ok(r->>'error'='confirmation_required','grant review needs acknowledgement');
 r:=pg_temp.step(w,'grants',5,'{"acknowledged":true}');
 perform pg_temp.ok((r#>>'{readiness,ready}')::boolean,'all checks pass before readiness');
 perform pg_temp.ok(not exists(select 1 from public.connector_grants),'wizard issues no grants');

 -- A system added after review makes readiness fail; the failed attempt changes nothing.
 perform public.manage_estate('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','system.create',estate,'{"name":"Late","systemKind":"other","dataCategories":["contact"]}',gen_random_uuid());
 select count(*) into events from public.audit_ledger;
 r:=pg_temp.step(w,'readiness',6,'{"confirmed":true}');
 perform pg_temp.ok(r->>'error'='not_ready','late unconnected system blocks readiness');
 perform pg_temp.ok((select version=6 and status='in_progress' and not ('readiness'=any(completed_steps)) from public.tenant_onboarding_wizards where id=w),'refused readiness rolled back');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'refused readiness has no ledger entry');
 r:=pg_temp.step(w,'connectors',6,jsonb_build_object('manualSystemIds',(select jsonb_agg(id) from public.estate_systems where estate_id=estate and id<>crm)));
 perform pg_temp.ok(r#>>'{resource,version}'='7','revisiting a completed step is allowed');
 r:=pg_temp.step(w,'readiness',7,'{"confirmed":true}');
 perform pg_temp.ok(r#>>'{resource,status}'='completed','wizard completes');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='onboarding.wizard.completed' and target_ref=w::text),'completion audited');
 r:=pg_temp.step(w,'company',8,'{"isSdf":true,"processesChildrenData":true,"processesHealthData":false,"dpoName":"X","dpoEmail":"x@example.in"}');
 perform pg_temp.ok(r->>'error'='wizard_completed','completed run is closed');

 -- A new run may start after completion; changing its estate resets later steps.
 r:=public.start_onboarding_wizard('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',gen_random_uuid());
 w:=(r#>>'{resource,id}')::uuid;
 perform pg_temp.ok((r->>'created')::boolean,'re-onboarding starts a new run');
 perform pg_temp.step(w,'company',1,'{"isSdf":false,"processesChildrenData":false,"processesHealthData":false,"dpoName":"Asha Rao","dpoEmail":"dpo@example.in"}');
 perform pg_temp.step(w,'estate',2,jsonb_build_object('estateId',estate));
 perform pg_temp.step(w,'inventory',3,'{}');
 r:=pg_temp.step(w,'estate',4,jsonb_build_object('estateId',other_estate));
 perform pg_temp.ok(r#>'{resource,completed_steps}'='["company","estate"]'::jsonb,'changing estate resets later steps');
 r:=public.advance_onboarding_wizard('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000a1',w,'company',5,'{}',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='forbidden','other tenant refused');
end $$;

-- The completed run is immutable and runs are never deleted, even for the backend role.
do $$ begin
 begin
  update public.tenant_onboarding_wizards set completed_steps='{}' where status='completed';
  raise exception 'completed run changed';
 exception when insufficient_privilege then null; end;
 begin
  delete from public.tenant_onboarding_wizards;
  raise exception 'run deleted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Members read their own tenant's runs; direct client writes are impossible.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
do $$ begin
 perform pg_temp.ok((select count(*)=2 from public.tenant_onboarding_wizards),'member reads tenant runs');
 begin
  insert into public.tenant_onboarding_wizards(tenant_id,started_by) values ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a2');
  raise exception 'client inserted a run';
 exception when insufficient_privilege then null; end;
 begin
  perform public.start_onboarding_wizard('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a2',gen_random_uuid());
  raise exception 'client called the RPC';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
