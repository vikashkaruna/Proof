begin;
create function pg_temp.ok(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if; end $$;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-0000000000d1','sustain-admin@test.invalid'),
 ('00000000-0000-4000-8000-0000000000d2','sustain-approver@test.invalid');
insert into public.users(id,email) values
 ('00000000-0000-4000-8000-0000000000d1','sustain-admin@test.invalid'),
 ('00000000-0000-4000-8000-0000000000d2','sustain-approver@test.invalid');
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-0000000000e1','sustain-a','A');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1','admin'),
 ('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d2','approver');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest)
 values ('00000000-0000-4000-8000-0000000000f1','sustain-test','1','sql','sandbox','{}');
create function pg_temp.est(op text, id uuid, body jsonb) returns jsonb language sql as $$
 select public.manage_estate('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1',op,id,body,gen_random_uuid());
$$;
create function pg_temp.step(w uuid, s text, v integer, body jsonb) returns jsonb language sql as $$
 select public.advance_onboarding_wizard('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1',w,s,v,body,gen_random_uuid());
$$;
set local role service_role;
do $$
declare w uuid; estate uuid; crm uuid; hr uuid; late uuid; conn uuid; r jsonb;
begin
 estate:=(pg_temp.est('estate.create',null,'{"slug":"sus","name":"Sustain"}')#>>'{resource,id}')::uuid;
 r:=public.onboarding_estate_drift('00000000-0000-4000-8000-0000000000e1',estate);
 perform pg_temp.ok(r->>'status'='not_onboarded','no completed run yet');
 perform pg_temp.ok(public.onboarding_estate_drift('00000000-0000-4000-8000-0000000000e1',gen_random_uuid())->>'error'='not_found','unknown estate');
 crm:=(pg_temp.est('system.create',estate,'{"name":"CRM","systemKind":"saas","dataCategories":["contact"]}')#>>'{resource,id}')::uuid;
 hr:=(pg_temp.est('system.create',estate,'{"name":"HR","systemKind":"database","dataCategories":["employment"]}')#>>'{resource,id}')::uuid;
 w:=(public.start_onboarding_wizard('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1',gen_random_uuid())#>>'{resource,id}')::uuid;
 perform pg_temp.step(w,'company',1,'{"isSdf":false,"processesChildrenData":false,"processesHealthData":false,"dpoName":"A","dpoEmail":"a@example.in"}');
 perform pg_temp.step(w,'estate',2,jsonb_build_object('estateId',estate));
 perform pg_temp.step(w,'inventory',3,'{}');
 perform pg_temp.step(w,'connectors',4,jsonb_build_object('manualSystemIds',jsonb_build_array(hr)));
 -- The CRM has no connector yet; register one before connection path is re-recorded.
 insert into public.connectors(tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance)
  values ('00000000-0000-4000-8000-0000000000e1',crm,'00000000-0000-4000-8000-0000000000f1','sandbox','CRM reader','crm_reader','high')
  returning id into conn;
 perform pg_temp.ok(pg_temp.step(w,'connectors',4,jsonb_build_object('manualSystemIds',jsonb_build_array(hr)))#>>'{resource,version}'='5','connection path');
 perform pg_temp.step(w,'grants',5,'{"acknowledged":true}');
 r:=pg_temp.step(w,'readiness',6,'{"confirmed":true}');
 perform pg_temp.ok(r#>>'{resource,status}'='completed','run completed');
 perform pg_temp.ok((select count(*)=2 from public.onboarding_attested_systems where wizard_id=w),'baseline snapshot written at completion');
 perform pg_temp.ok((select manual and not connector_registered from public.onboarding_attested_systems where system_id=hr),'manual system recorded');
 r:=public.onboarding_estate_drift('00000000-0000-4000-8000-0000000000e1',estate);
 perform pg_temp.ok(r->>'status'='current','no drift right after onboarding');

 late:=(pg_temp.est('system.create',estate,'{"name":"Late","systemKind":"other","dataCategories":["contact"]}')#>>'{resource,id}')::uuid;
 perform pg_temp.est('system.update',hr,'{"name":"HR","systemKind":"database","dataCategories":["employment","health"],"status":"active","expectedVersion":1}');
 update public.connectors set status='archived' where id=conn;
 r:=public.onboarding_estate_drift('00000000-0000-4000-8000-0000000000e1',estate);
 perform pg_temp.ok(r->>'status'='drifted','drift detected');
 perform pg_temp.ok(r#>>'{added,0,id}'=late::text,'new system reported');
 perform pg_temp.ok(r#>>'{changed,0,id}'=hr::text,'changed categories reported');
 perform pg_temp.ok(r#>>'{connectionLost,0,id}'=crm::text and jsonb_array_length(r->'connectionLost')=1,'lost connector reported; manual system is not');
 perform pg_temp.est('system.update',late,'{"name":"Late","systemKind":"other","dataCategories":["contact"],"status":"archived","expectedVersion":1}');
 perform pg_temp.est('system.update',crm,'{"name":"CRM","systemKind":"saas","dataCategories":["contact"],"status":"archived","expectedVersion":1}');
 r:=public.onboarding_estate_drift('00000000-0000-4000-8000-0000000000e1',estate);
 perform pg_temp.ok(r->'added'='[]'::jsonb and r#>>'{removed,0,id}'=crm::text,'archived baseline system reported as removed');
end $$;
reset role;

-- Grants: seeded directly (W4.4 issuance is not built). Review and revoke only.
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status) values
 ('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000e1','drishti','spiffe://test/drishti','active');
insert into public.connector_grants(id,tenant_id,connector_id,workload_identity_id,agent_name,internal_scope,created_at,expires_at) values
 ('00000000-0000-4000-8000-0000000000f3','00000000-0000-4000-8000-0000000000e1',
  (select id from public.connectors where tenant_id='00000000-0000-4000-8000-0000000000e1'),
  '00000000-0000-4000-8000-0000000000f2','drishti','connector.read',now()-interval '120 days',now()+interval '30 days'),
 ('00000000-0000-4000-8000-0000000000f4','00000000-0000-4000-8000-0000000000e1',
  (select id from public.connectors where tenant_id='00000000-0000-4000-8000-0000000000e1'),
  '00000000-0000-4000-8000-0000000000f2','drishti','connector.read',now()-interval '1 day',now()+interval '30 days');
set local role service_role;
do $$
declare q jsonb; r jsonb; events bigint;
begin
 q:=public.connector_grant_review_queue('00000000-0000-4000-8000-0000000000e1');
 perform pg_temp.ok(jsonb_array_length(q)=2 and q#>>'{0,id}'='00000000-0000-4000-8000-0000000000f3','oldest review first');
 perform pg_temp.ok((q#>>'{0,overdue}')::boolean and not (q#>>'{1,overdue}')::boolean,'never-reviewed grant is due 90 days after issue');
 r:=public.attest_connector_grant('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d2','00000000-0000-4000-8000-0000000000f3','keep',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='forbidden','approver cannot attest access');
 r:=public.attest_connector_grant('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000f3','maybe',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='invalid_decision','decision validated');
 r:=public.attest_connector_grant('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000f3','keep',gen_random_uuid());
 perform pg_temp.ok((r#>>'{attestation,next_due_at}')::timestamptz > now()+interval '89 days','keep schedules the next review');
 q:=public.connector_grant_review_queue('00000000-0000-4000-8000-0000000000e1');
 perform pg_temp.ok(q#>>'{1,id}'='00000000-0000-4000-8000-0000000000f3' and not (q#>>'{1,overdue}')::boolean,'kept grant no longer overdue');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='connector.grant.attested'),'keep audited');
 r:=public.attest_connector_grant('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000f4','revoke',gen_random_uuid());
 perform pg_temp.ok(r#>>'{attestation,decision}'='revoke','revoke recorded');
 perform pg_temp.ok((select revoked_at is not null from public.connector_grants where id='00000000-0000-4000-8000-0000000000f4'),'grant revoked');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where action_type='connector.grant.revoked'),'revocation audited');
 perform pg_temp.ok(jsonb_array_length(public.connector_grant_review_queue('00000000-0000-4000-8000-0000000000e1'))=1,'revoked grant leaves the queue');
 select count(*) into events from public.audit_ledger;
 r:=public.attest_connector_grant('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000f4','keep',gen_random_uuid());
 perform pg_temp.ok(r->>'error'='not_active' and (select count(*)=events from public.audit_ledger),'revoked grant cannot be kept');
 -- Decisions and baselines are append-only for the backend role too.
 begin update public.connector_grant_attestations set decision='keep'; raise exception 'attestation changed';
 exception when insufficient_privilege then null; end;
 begin insert into public.onboarding_attested_systems select * from public.onboarding_attested_systems limit 1; raise exception 'baseline forged';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
