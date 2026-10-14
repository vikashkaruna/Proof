-- Transaction-only synthetic fixtures. Not human-session/MFA or credential delivery proof.
begin;
create function pg_temp.mc_id(n int) returns uuid language sql immutable as $$select ('51270000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.mc_ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
create function pg_temp.mc_refuse(q text) returns void language plpgsql as $$begin
 begin execute q;set constraints all immediate;exception when others then return;end;
 raise exception 'Unexpected catalogue success';end$$;
select pg_temp.mc_ok(controller_security.catalogue127_role_safe(),'safe initial role (creator ADMIN-only accepted)');
grant axiom_catalogue_publisher to authenticator with admin false,inherit false,set true;
select pg_temp.mc_ok(not controller_security.catalogue127_role_safe(),'inbound SET refused');
revoke axiom_catalogue_publisher from authenticator;
grant axiom_catalogue_publisher to agent_ledger_writer with admin false,inherit true,set false;
select pg_temp.mc_ok(not controller_security.catalogue127_role_safe(),'inbound INHERIT refused');
revoke axiom_catalogue_publisher from agent_ledger_writer;
grant axiom_catalogue_publisher to service_role with admin true,inherit false,set false;
select pg_temp.mc_ok(not controller_security.catalogue127_role_safe(),'foreign ADMIN-only refused');
revoke axiom_catalogue_publisher from service_role;
grant agent_ledger_writer to axiom_catalogue_publisher with admin false,inherit false,set false;
select pg_temp.mc_ok(not controller_security.catalogue127_role_safe(),'outbound privileges refused');
revoke agent_ledger_writer from axiom_catalogue_publisher;
alter role axiom_catalogue_publisher login;
select pg_temp.mc_ok(not controller_security.catalogue127_role_safe(),'unsafe attributes refused');
alter role axiom_catalogue_publisher nologin;
select pg_temp.mc_ok(controller_security.catalogue127_role_safe(),'role restored');
insert into auth.users(id,email) values(pg_temp.mc_id(1),'context-founder@test.invalid'),(pg_temp.mc_id(2),'context-viewer@test.invalid');
insert into public.users(id,email,is_axiom_internal) values(pg_temp.mc_id(1),'context-founder@test.invalid',true),(pg_temp.mc_id(2),'context-viewer@test.invalid',false);
insert into public.tenants(id,slug,name) values(pg_temp.mc_id(11),'context-audit-fixture','Synthetic audit fixture'),(pg_temp.mc_id(12),'context-foreign-fixture','Foreign fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.mc_id(12),pg_temp.mc_id(1),'founder'),(pg_temp.mc_id(11),pg_temp.mc_id(1),'founder'),(pg_temp.mc_id(11),pg_temp.mc_id(2),'viewer');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('context-test-v1',now(),'test','Synthetic context fixture',1);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('CONTEXT-001','context-test-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":1,"maxPenaltyINR":1}','{}','context-test-v1');
insert into public.frameworks(id,code,regulator,title,source_url,verified_on,verified_by,published_by)
 values(pg_temp.mc_id(21),'CONTEXT-FRAMEWORK','CERT-In','Synthetic framework','https://example.invalid/fixture',current_date,'test',pg_temp.mc_id(1));
insert into public.framework_controls(id,framework_id,ref,heading) values(pg_temp.mc_id(22),pg_temp.mc_id(21),'shared-ref','Synthetic ref');
insert into public.sector_packs(id,code,name,sector,library_version,control_ids,framework_codes,published_by)
 select pg_temp.mc_id(30+n),'CONTEXT-PACK-'||n,'Fixture',case n when 1 then 'BFSI' when 2 then 'Healthcare' else 'Tech/E-commerce' end,
 'context-test-v1',array['CONTEXT-001'],array['CONTEXT-FRAMEWORK'],pg_temp.mc_id(1) from generate_series(1,3)n;
create temporary table mc_fixture(contexts jsonb,request_text text,proof jsonb,replay jsonb,adoption_a jsonb,adoption_b jsonb,adoption_replay jsonb);
insert into mc_fixture(contexts) select jsonb_agg(jsonb_build_object('sectorPackCode','CONTEXT-PACK-'||n,'frameworkCode','CONTEXT-FRAMEWORK',
 'ref','shared-ref','controlId','CONTEXT-001','mappingStrength','partial','provenance','reference','note','Sector-specific note '||n) order by n) from generate_series(1,3)n;
update mc_fixture set request_text=jsonb_build_object('publicationVersion','context-test.v1','libraryVersion','context-test-v1','contexts',contexts)::text;
grant select,update on mc_fixture to axiom_catalogue_publisher;
create function pg_temp.mc_publish(ctx jsonb,t uuid default pg_temp.mc_id(11),a uuid default pg_temp.mc_id(1),c uuid default pg_temp.mc_id(41),v text default 'context-test.v1') returns jsonb language sql as $$
 select public.publish_mapping_context_publication(v,'context-test-v1',ctx,t,a,c,pg_temp.mc_id(44),
 jsonb_build_object('publicationVersion',v,'libraryVersion','context-test-v1','contexts',ctx)::text)
$$;
create function pg_temp.mc_req(k int default 51,pack text default 'CONTEXT-PACK-1',v text default 'context-test.v1') returns text language sql as $$
 select jsonb_build_object('operationKey',pg_temp.mc_id(k),'publicationVersion',v,'expectedPacketSha256',proof->>'packetSha256','sectorPackCode',pack)::text from mc_fixture
$$;
do $$declare r text;tab text;begin
 perform pg_temp.mc_ok(controller_security.catalogue127_role_safe(),'safe initial isolated publisher role');
 foreach r in array array['anon','authenticated','service_role','authenticator','agent_ledger_writer','human_action_writer'] loop
  perform pg_temp.mc_ok(not has_function_privilege(r,'public.publish_mapping_context_publication(text,text,jsonb,uuid,uuid,uuid,uuid,text)','EXECUTE'),'no shared publication authority');
  perform pg_temp.mc_ok(not has_function_privilege(r,'public.read_mapping_context_publication_proof(text,uuid,uuid,uuid,uuid,text)','EXECUTE'),'no private global provenance authority');
  perform pg_temp.mc_ok(not has_function_privilege(r,'public.adopt_mapping_context_publication(uuid,uuid,uuid,uuid,text)','EXECUTE'),'no shared adoption authority');
  perform pg_temp.mc_ok(not has_function_privilege(r,'public.read_mapping_context_adoption_proof(uuid,uuid,uuid,uuid,text,uuid)','EXECUTE'),'no private adoption proof authority');
 end loop;
 foreach r in array array['anon','authenticated','service_role','axiom_catalogue_publisher','agent_ledger_writer','human_action_writer'] loop
  foreach tab in array array['mapping_context_publications','mapping_context_publication_provenance','mapping_contexts','mapping_context_adoptions'] loop
   perform pg_temp.mc_ok(not has_table_privilege(r,'public.'||tab,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),'no direct table authority');
  end loop;
 end loop;
 perform pg_temp.mc_ok(not has_function_privilege('axiom_catalogue_publisher','public.append_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)','EXECUTE'),'no broad append grant');
end $$;
-- Controlled transaction-only fixture SET capability, removed by rollback.
grant axiom_catalogue_publisher to postgres with set true;
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L,%L,%L)',(select contexts from mc_fixture),pg_temp.mc_id(11),pg_temp.mc_id(2)));
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L)',(select contexts||jsonb_build_array(contexts->0) from mc_fixture)));
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L)',(select jsonb_set(contexts,'{0,extra}','true') from mc_fixture)));
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L)',(select jsonb_set(contexts,'{0,sectorPackCode}','"FOREIGN"') from mc_fixture)));
update mc_fixture set proof=pg_temp.mc_publish(contexts),replay=pg_temp.mc_publish(contexts);
select pg_temp.mc_ok((select proof=replay from mc_fixture),'global exact replay returns original provenance');
select pg_temp.mc_ok((select not(proof ?| array['receipt','auditTenantId']) from mc_fixture),'no fabricated global ledger proof');
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L)',(select jsonb_set(contexts,'{0,note}','"changed"') from mc_fixture)));
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L,%L,%L,%L)',(select contexts from mc_fixture),pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(42)));
select pg_temp.mc_ok((select public.read_mapping_context_publication_proof('context-test.v1',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(41),pg_temp.mc_id(44),request_text)=proof from mc_fixture),'exact global readback');
select pg_temp.mc_refuse(format('select public.read_mapping_context_publication_proof(%L,%L,%L,%L,%L,%L)','context-test.v1',pg_temp.mc_id(12),pg_temp.mc_id(1),pg_temp.mc_id(41),pg_temp.mc_id(44),(select request_text from mc_fixture)));
reset role;
set constraints all immediate;
set constraints all deferred;
select pg_temp.mc_ok((select count(*)=0 from public.audit_ledger where tenant_id in(pg_temp.mc_id(11),pg_temp.mc_id(12))),'global publication writes NO organisation ledger');
select pg_temp.mc_ok((select count(*)=3 and count(distinct note)=3 from public.mapping_contexts where publication_version='context-test.v1'),'all qualified notes retained');
select pg_temp.mc_ok((select count(*)=0 from public.control_mappings where library_version='context-test-v1'),'legacy rows untouched');
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(12),pg_temp.mc_id(2),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req()));
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),(pg_temp.mc_req()::jsonb||'{"actorId":"spoof"}'::jsonb)::text));
update mc_fixture set adoption_a=public.adopt_mapping_context_publication(pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req());
update mc_fixture set adoption_b=public.adopt_mapping_context_publication(pg_temp.mc_id(12),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req());
update mc_fixture set adoption_replay=public.adopt_mapping_context_publication(pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req());
select pg_temp.mc_ok((select adoption_a=adoption_replay and adoption_a->'receipt'<>adoption_b->'receipt' from mc_fixture),'each organisation own receipt; exact replay preserved');
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(51,'CONTEXT-PACK-2')));
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(51,'CONTEXT-PACK-1','unknown.v1')));
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),jsonb_set(pg_temp.mc_req()::jsonb,'{expectedPacketSha256}',to_jsonb(repeat('a',64)))::text));
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req()||' '));
select pg_temp.mc_refuse(format('select public.read_mapping_context_adoption_proof(%L,%L,%L,%L,%L,%L)',pg_temp.mc_id(12),pg_temp.mc_id(2),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(),pg_temp.mc_id(51)));
select pg_temp.mc_ok((select public.read_mapping_context_adoption_proof(pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(),pg_temp.mc_id(51))=adoption_a from mc_fixture),'lost response recovery exact scoped receipt');
reset role;
select pg_temp.mc_ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.mc_id(11) and action_type::text='catalogue.mapping_contexts_adopted'),'one A ledger receipt');
select pg_temp.mc_ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.mc_id(12) and action_type::text='catalogue.mapping_contexts_adopted'),'one B ledger receipt');
set local role authenticated;
select pg_temp.mc_ok(((public.read_mapping_context_publication('context-test.v1')->>'packetText')::jsonb->'contexts')->0->>'note'='Sector-specific note 1','public qualified source');
select pg_temp.mc_ok(not(public.read_mapping_context_publication('context-test.v1') ?| array['authorityTenantId','publisherId','correlationId','receipt','sessionId','adoptions']),'no private metadata leak');
reset role;
select pg_temp.mc_refuse('update public.mapping_contexts set note=''changed'' where publication_version=''context-test.v1''');
select pg_temp.mc_refuse('delete from public.mapping_context_publications where publication_version=''context-test.v1''');
select pg_temp.mc_refuse('truncate public.mapping_contexts');
select pg_temp.mc_refuse('update public.mapping_context_publication_provenance set request_text=''{}''');
select pg_temp.mc_refuse('truncate public.mapping_context_adoptions');
select pg_temp.mc_refuse('insert into public.mapping_context_publications(publication_version,library_version,packet_text,packet_sha256,context_count) values(''orphan.v1'',''context-test-v1'',''{}'',repeat(''a'',64),1)');
create function pg_temp.mc_fail_append() returns trigger language plpgsql as $$begin raise exception 'synthetic append fault';end$$;
create trigger mc_append_fault before insert on public.audit_ledger for each row when(new.action_type::text='catalogue.mapping_contexts_adopted') execute function pg_temp.mc_fail_append();
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(52)));
reset role;
drop trigger mc_append_fault on public.audit_ledger;
select pg_temp.mc_ok(not exists(select 1 from public.mapping_context_adoptions where operation_key=pg_temp.mc_id(52)),'append failure leaves no adoption');
select pg_temp.mc_ok((select count(*)=2 from public.audit_ledger where action_type::text='catalogue.mapping_contexts_adopted' and tenant_id in(pg_temp.mc_id(11),pg_temp.mc_id(12))),'append failure leaves no receipt');
select pg_temp.mc_refuse(format('select public.append_ledger(%L,%L,''human'',%L,null,null,null,''catalogue.mapping_contexts_adopted'',%L,null,null,null,null,null,null,''success'',''{}'')',pg_temp.mc_id(11),pg_temp.mc_id(43),pg_temp.mc_id(1)::text,pg_temp.mc_id(53)::text));
-- Copied legitimate receipt fields still cannot manufacture another dedicated event.
create function pg_temp.mc_copy_receipt() returns bigint language sql as $$
 select public.append_ledger(l.tenant_id,l.correlation_id,l.actor_type,l.actor_id,l.agent_version,l.model_id,l.prompt_hash,l.action_type,
 l.target_ref,l.input_hash,l.output_hash,l.approval_token_id,l.approver_id,l.pre_state_ref,l.post_state_ref,l.result,l.detail)
 from public.audit_ledger l where l.id=(select (adoption_a->'receipt'->>'id')::bigint from mc_fixture)
$$;
select pg_temp.mc_refuse('select pg_temp.mc_copy_receipt()');
-- Failure after the internal append also rolls back that receipt.
create trigger mc_adoption_insert_fault before insert on public.mapping_context_adoptions for each row execute function pg_temp.mc_fail_append();
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(52)));
reset role;
drop trigger mc_adoption_insert_fault on public.mapping_context_adoptions;
select pg_temp.mc_ok((select count(*)=2 from public.audit_ledger where action_type::text='catalogue.mapping_contexts_adopted' and tenant_id in(pg_temp.mc_id(11),pg_temp.mc_id(12))),'post-append row failure rolls back receipt');
-- Global provenance insertion failure leaves no half-publication (and no ledger).
create trigger mc_provenance_insert_fault before insert on public.mapping_context_publication_provenance for each row execute function pg_temp.mc_fail_append();
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L,%L,%L,%L,%L)',(select contexts from mc_fixture),pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(42),'context-test.v2'));
reset role;
drop trigger mc_provenance_insert_fault on public.mapping_context_publication_provenance;
select pg_temp.mc_ok(not exists(select 1 from public.mapping_context_publications where publication_version='context-test.v2') and not exists(select 1 from public.mapping_contexts where publication_version='context-test.v2'),'provenance failure atomic rollback');
insert into public.kill_switch_state(scope_key,scope,tenant_id,engaged) values(pg_temp.mc_id(11)::text,'tenant',pg_temp.mc_id(11),true);
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(52)));
select pg_temp.mc_ok((select public.read_mapping_context_publication_proof('context-test.v1',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(41),pg_temp.mc_id(44),request_text)=proof from mc_fixture),'global membership context is not adoption target');
reset role;
update public.kill_switch_state set engaged=true where scope_key='global';
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select pg_temp.mc_publish(%L)',(select contexts from mc_fixture)));
select pg_temp.mc_refuse(format('select public.adopt_mapping_context_publication(%L,%L,%L,%L,%L)',pg_temp.mc_id(12),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(52)));
reset role;
update public.kill_switch_state set engaged=false;
update public.tenant_users set role='viewer' where tenant_id=pg_temp.mc_id(11) and user_id=pg_temp.mc_id(1);
set local role axiom_catalogue_publisher;
select pg_temp.mc_refuse(format('select public.read_mapping_context_publication_proof(%L,%L,%L,%L,%L,%L)','context-test.v1',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(41),pg_temp.mc_id(44),(select request_text from mc_fixture)));
select pg_temp.mc_refuse(format('select public.read_mapping_context_adoption_proof(%L,%L,%L,%L,%L,%L)',pg_temp.mc_id(11),pg_temp.mc_id(1),pg_temp.mc_id(44),pg_temp.mc_id(41),pg_temp.mc_req(),pg_temp.mc_id(51)));
reset role;
select pg_temp.mc_ok(not exists(select 1 from public.verify_ledger(pg_temp.mc_id(11))) and not exists(select 1 from public.verify_ledger(pg_temp.mc_id(12))),'both ledgers intact');
rollback;
