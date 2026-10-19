-- Synthetic metadata only; real SQL authority/immutability. No target/provider
-- call, actual TOTP enrollment, hosted identity or personal values.
begin;
-- Match the canonical migration owner's Auth stand-in. Only create an absent
-- rollback-scoped fixture; never change a real Auth table or caller grants.
do $auth$declare prior text:=current_user;begin
 if to_regclass('auth.sessions') is null then
  set local role postgres;
  create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
  execute format('set local role %I',prior);
 end if;
end $auth$;
create function pg_temp.id(n int)returns uuid language sql immutable as $$select('17400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text)returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
create function pg_temp.refused(q text,code text default'42501')returns void language plpgsql as $$begin begin execute q;exception when others then if sqlstate=code then return;end if;raise;end;raise exception 'Statement unexpectedly succeeded';end$$;
insert into auth.users(id,email)select pg_temp.id(n),'flow174-'||n||'@example.invalid'from generate_series(1,7)n;
insert into public.users(id,email,is_axiom_internal)select pg_temp.id(n),'flow174-'||n||'@example.invalid',n in(6,7)from generate_series(1,7)n;
insert into public.tenants(id,slug,name)values(pg_temp.id(11),'flow174-a','Synthetic A'),(pg_temp.id(12),'flow174-b','Synthetic B');
insert into public.tenant_users(tenant_id,user_id,role)values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'admin'),(pg_temp.id(11),pg_temp.id(3),'viewer'),(pg_temp.id(11),pg_temp.id(4),'axiom_analyst'),(pg_temp.id(12),pg_temp.id(5),'owner'),(pg_temp.id(11),pg_temp.id(7),'founder');
insert into public.platform_founders(user_id,designated_by,designation_reason)values(pg_temp.id(6),'SQL fixture','Synthetic live founder designation');
insert into auth.sessions(id,user_id,not_after)select pg_temp.id(100+n),pg_temp.id(n),null from generate_series(1,7)n;
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)select pg_temp.id(40+n),pg_temp.id(n),'totp','active','synthetic-sealed'from generate_series(1,7)n;
insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)select pg_temp.id(n),pg_temp.id(100+n)::text,pg_temp.id(40+n),clock_timestamp(),clock_timestamp()+interval'1 hour'from generate_series(1,7)n;
insert into public.estates(id,tenant_id,slug,name)values(pg_temp.id(21),pg_temp.id(11),'flow-a','Synthetic A'),(pg_temp.id(22),pg_temp.id(12),'flow-b','Synthetic B');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind)values(pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'Source','database'),(pg_temp.id(32),pg_temp.id(11),pg_temp.id(21),'Destination','saas'),(pg_temp.id(33),pg_temp.id(12),pg_temp.id(22),'Foreign','saas');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)values('flow174-fixture',clock_timestamp(),'synthetic','Metadata only',0);
insert into public.engagements(id,tenant_id,library_version,title)values(pg_temp.id(34),pg_temp.id(11),'flow174-fixture','Synthetic declared source');
set local role human_action_writer;
select public.record_operator_workflow(pg_temp.id(11),pg_temp.id(1),pg_temp.id(35),'ropa',jsonb_build_object('engagementId',pg_temp.id(34),'sourceNote','Explicit synthetic interview; facts unresolved','system','Synthetic source','purpose',null,'legalBasis',null,'retentionMonths',null,'dataCategories',null,'processors',null,'region',null,'crossBorder',null,'securityMeasures',null,'dataPrincipals',null,'recipients',null,'destinationCountries',null,'transferSafeguards',null,'dpiaRequired',null),pg_temp.id(36));
reset role;
create temporary table flow174_saved(k text primary key,v jsonb);
grant select,insert,update on flow174_saved to service_role,human_action_writer;
create function pg_temp.declare174(op int,prior uuid default null)returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('phase','declare','request',jsonb_build_object('schemaVersion',1,'operationKey',pg_temp.id(op),'flowId',pg_temp.id(200),'previousRevisionId',prior,'origin',controller_security.flow174_pin(pg_temp.id(11),pg_temp.id(31)),'destination',jsonb_build_object('kind','unknown','reason','Destination has not been established.'),'purpose',null,'dataCategories',null,'originCountry',null,'destinationCountries',null,'crossBorder',null,'transferSafeguards',null,'sourceRopaId',(select id from public.operator_workflow_records where tenant_id=pg_temp.id(11)and operation_key=pg_temp.id(35)),'sourceNote','Synthetic human metadata only','validUntil',to_char((clock_timestamp()+interval'1 day')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'reason','Explicit synthetic declaration reviewed carefully')))$$;
do $$declare original jsonb:=pg_temp.declare174(299)::jsonb;change jsonb;begin
 foreach change in array array[
 jsonb_set(original,'{request,crossBorder}','"false"'),
 jsonb_set(original,'{request,origin,contentSha256}','123'),
 jsonb_set(original,'{request,destination}',jsonb_build_object('kind','system','system',controller_security.flow174_pin(pg_temp.id(12),pg_temp.id(33)))),
 jsonb_set(original,'{request,sourceRopaId}',to_jsonb(pg_temp.id(999))),
 jsonb_set(original,'{request,validUntil}','null'),
 jsonb_set(original,'{request,sourceNote}',to_jsonb(U&'\00A0leading whitespace'::text))
 ]loop
  begin
   perform public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),controller_security.canonical_questionnaire_json(change));
  exception when sqlstate'22023'or sqlstate'42501'or sqlstate'40001'then continue;end;
  raise exception 'Malformed/foreign source accepted';
 end loop;
end$$;
insert into flow174_saved values('declare',jsonb_build_object('text',pg_temp.declare174(201)));
create function pg_temp.decision174(phase text,op int,revision int default 201)returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_build_object('phase',$1,'request',jsonb_build_object('schemaVersion',1,'operationKey',pg_temp.id(op),'revisionId',pg_temp.id(revision),'expectedContentSha256',(select content_sha256 from controller_security.flow174_revisions where tenant_id=pg_temp.id(11)and id=pg_temp.id(revision)),'reason','Exact synthetic metadata decision reviewed carefully')))$$;
create function pg_temp.mfa174(intent text,actor int)returns uuid language plpgsql as $$declare v jsonb:=intent::jsonb;op uuid:=(v#>>'{request,operationKey}')::uuid;b text;issued jsonb;c uuid;begin
 b:=controller_security.flow174_hash(jsonb_build_array('axiom.data-flow.'||(v->>'phase'),1,pg_temp.id(11)::text,pg_temp.id(actor)::text,pg_temp.id(100+actor)::text,controller_security.flow174_hash(v)));
 set local role service_role;issued:=public.issue_data_flow_declaration_mfa_challenge(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),op,b,300000);reset role;c:=(issued->>'id')::uuid;
 -- Only an owned SQL factor-counter stand-in. The real verifier is tested in BFF.
 update public.mfa_challenges set attempts=1 where id=c;
 set local role service_role;
 perform public.satisfy_data_flow_declaration_mfa_challenge(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),op,b,c,1,'totp');
 perform public.consume_data_flow_declaration_mfa_challenge(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),pg_temp.id(40+actor),op,b,c,1,op);reset role;return c;
end$$;
create function pg_temp.record174(intent text,actor int)returns jsonb language plpgsql as $$declare c uuid;v jsonb;begin c:=pg_temp.mfa174(intent,actor);set local role human_action_writer;v:=public.record_data_flow_declaration(pg_temp.id(11),pg_temp.id(actor),pg_temp.id(100+actor),intent,c);reset role;return v;end$$;
select pg_temp.ok(not has_function_privilege('service_role','public.record_data_flow_declaration(uuid,uuid,uuid,text,uuid)','EXECUTE'),'backend cannot retain decision');
select pg_temp.ok(not has_function_privilege('agent_ledger_writer','public.record_data_flow_declaration(uuid,uuid,uuid,text,uuid)','EXECUTE'),'agent cannot declare or review');
select pg_temp.ok(not has_table_privilege('human_action_writer','controller_security.flow174_revisions','INSERT'),'human writer has no arbitrary table write');
select pg_temp.refused('select public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(3),pg_temp.id(103),(select v->>''text''from flow174_saved where k=''declare''))');
select pg_temp.refused('select public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(4),pg_temp.id(104),(select v->>''text''from flow174_saved where k=''declare''))');
select pg_temp.refused('select public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(7),pg_temp.id(107),(select v->>''text''from flow174_saved where k=''declare''))');
select pg_temp.refused('select public.data_flow_declaration_context(pg_temp.id(11),pg_temp.id(5),pg_temp.id(105),null)');
select pg_temp.ok(public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(6),pg_temp.id(106),(select v->>'text'from flow174_saved where k='declare'))->>'actorId'=pg_temp.id(6)::text,'live global founder allowed without explicit membership');
-- Mutating the public challenge cannot replace immutable original actor,
-- session, domain, operation, factor or database-clock commitments.
do $$declare intent text:=pg_temp.declare174(250);c uuid;mutation text;begin
 c:=pg_temp.mfa174(intent,1);
 foreach mutation in array array[
 'user_id=pg_temp.id(2)',
 'tenant_id=pg_temp.id(12)',
 'purpose=''approval_issuance''',
 'bound_resource_ref=pg_temp.id(999)::text',
 'bound_payload_sha256=repeat(''f'',64)',
 'factor_id=pg_temp.id(42)',
 'created_at=created_at-interval ''1 second''',
 'expires_at=expires_at-interval ''1 second''',
 'satisfied_at=null,consumed_at=null,consumed_for=null,satisfied_with=null',
 'consumed_at=null,consumed_for=null',
 'consumed_for=pg_temp.id(999)::text'
 ]loop
  begin
   execute 'update public.mfa_challenges set '||mutation||' where id='||quote_literal(c);
   set local role human_action_writer;
   perform pg_temp.refused(format('select public.record_data_flow_declaration(%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),intent,c));
   reset role;raise sqlstate'P1740';
  exception when sqlstate'P1740'then null;end;
 end loop;
 begin
  delete from public.tenant_users where tenant_id=pg_temp.id(11)and user_id=pg_temp.id(1);
  insert into public.tenant_users(tenant_id,user_id,role)values(pg_temp.id(11),pg_temp.id(1),'owner');
  set local role human_action_writer;
  perform pg_temp.refused(format('select public.record_data_flow_declaration(%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),intent,c));
  reset role;raise sqlstate'P1740';
 exception when sqlstate'P1740'then null;end;
 set local role human_action_writer;
 perform pg_temp.ok(public.fence_data_flow_declaration(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),intent)->>'fenced'='true','original unknown intent may be fenced without replacement');
 perform pg_temp.refused(format('select public.record_data_flow_declaration(%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),intent,c));
 reset role;
end$$;
insert into flow174_saved values('declared',pg_temp.record174((select v->>'text'from flow174_saved where k='declare'),1));
select pg_temp.ok((select v->>'recorded'='true'and v->>'state'='proposed'from flow174_saved where k='declared'),'declaration alone creates no approved edge');
select pg_temp.ok((select(intent_text::jsonb)#>'{request,crossBorder}'='null'::jsonb from controller_security.flow174_revisions where id=pg_temp.id(201)),'unknown cross-border remains null');
insert into flow174_saved values('approve',jsonb_build_object('text',pg_temp.decision174('approve',202)));
select pg_temp.refused('select public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),(select v->>''text''from flow174_saved where k=''approve''))');
insert into flow174_saved values('approved',pg_temp.record174((select v->>'text'from flow174_saved where k='approve'),2));
select pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='approved','independent current admin review approves metadata');
set local role service_role;
select pg_temp.ok(public.read_data_flow_declaration_operation(pg_temp.id(11),pg_temp.id(2),pg_temp.id(102),(select v->>'text'from flow174_saved where k='approve'))=(select v from flow174_saved where k='approved'),'lost reply returns exact immutable original');
reset role;
delete from public.mfa_session_attestations where user_id=pg_temp.id(3);
select pg_temp.ok(public.data_flow_declaration_context(pg_temp.id(11),pg_temp.id(3),pg_temp.id(103),pg_temp.id(201))#>>'{revisions,0,state}'='approved','viewer reads exact retained revision');
-- Current authority and exact source versions matter after approval; neither
-- state change deletes history nor claims real processing ceased.
do $$begin
 begin update public.engagements set status='cancelled'where id=pg_temp.id(34);perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='stale','retained RoPA source invalidation is explicit');raise sqlstate'P1740';exception when sqlstate'P1740'then null;end;
 begin update public.estate_systems set version=version+1 where id=pg_temp.id(31);perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='stale','system version drift invalidates current review');raise sqlstate'P1740';exception when sqlstate'P1740'then null;end;
 begin delete from public.tenant_users where tenant_id=pg_temp.id(11)and user_id=pg_temp.id(2);perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='stale','reviewer offboarding invalidates current review');insert into public.tenant_users(tenant_id,user_id,role)values(pg_temp.id(11),pg_temp.id(2),'admin');perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='stale','replacement membership does not revive old review');raise sqlstate'P1740';exception when sqlstate'P1740'then null;end;
 begin update public.estates set status='archived',version=version+1 where id=pg_temp.id(21);update public.estates set status='active',version=version+1 where id=pg_temp.id(21);perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='stale','parent estate archive/restore does not revive old source');raise sqlstate'P1740';exception when sqlstate'P1740'then null;end;
end$$;
-- Newer approved then withdrawn revision never revives older approval.
insert into flow174_saved values('declare2',jsonb_build_object('text',pg_temp.declare174(203,pg_temp.id(201))));
select pg_temp.record174((select v->>'text'from flow174_saved where k='declare2'),1);
select pg_temp.record174(pg_temp.decision174('approve',204,203),2);
select pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='superseded','new approval supersedes old review');
select pg_temp.record174(pg_temp.decision174('withdraw',205,203),1);
select pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(203))='withdrawn'and controller_security.flow174_state(pg_temp.id(11),pg_temp.id(201))='superseded','withdrawal never reactivates old approval');
-- Each typed destination is exercised through actual declaration + independent
-- review RPCs, not a graph-only fabricated approval fixture.
create function pg_temp.party174(op int,flow int,existing boolean default false)returns text language sql as $$select controller_security.canonical_questionnaire_json(jsonb_set(jsonb_set(jsonb_set(pg_temp.declare174(op)::jsonb,'{request,flowId}',to_jsonb(pg_temp.id(flow))),'{request,destination}',jsonb_build_object('kind','party','party',case when existing then jsonb_build_object('kind','existing','partyRef',pg_temp.id(401),'contentSha256',(select content_sha256 from controller_security.flow174_parties where tenant_id=pg_temp.id(11)and id=pg_temp.id(401)))else jsonb_build_object('kind','new','declaration',jsonb_build_object('partyRef',pg_temp.id(401),'label','Synthetic organization processor','role','processor','supersedesPartyRef',null))end,'system',controller_security.flow174_pin(pg_temp.id(11),pg_temp.id(32)))),'{request,crossBorder}','false'))$$;
select pg_temp.record174(pg_temp.party174(301,300),1);
select pg_temp.refused('select public.preflight_data_flow_declaration(pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),pg_temp.party174(303,310,true))');
select pg_temp.record174(pg_temp.decision174('approve',302,301),2);
select pg_temp.record174(pg_temp.party174(303,310,true),1);
select pg_temp.record174(pg_temp.decision174('approve',304,303),2);
select pg_temp.ok((public.data_flow_declaration_context(pg_temp.id(11),pg_temp.id(3),pg_temp.id(103),pg_temp.id(303))#>>'{revisions,0,party,label}')='Synthetic organization processor','reader receives immutable reviewed party label');
select pg_temp.ok((public.data_flow_declaration_context(pg_temp.id(11),pg_temp.id(3),pg_temp.id(103),pg_temp.id(303))#>'{revisions,0,request,crossBorder}')='false'::jsonb,'declared false is not unknown');
do $$declare intent text;begin
 intent:=controller_security.canonical_questionnaire_json(jsonb_set(jsonb_set(pg_temp.declare174(305)::jsonb,'{request,flowId}',to_jsonb(pg_temp.id(320))),'{request,destination}',jsonb_build_object('kind','system','system',controller_security.flow174_pin(pg_temp.id(11),pg_temp.id(32)))));
 perform pg_temp.record174(intent,6);
 perform pg_temp.record174(pg_temp.decision174('approve',306,305),1);
 perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(305))='approved','live founder prepares, independent owner reviews explicit system link');
end$$;
select pg_temp.refused('insert into controller_security.flow174_parties(tenant_id,id,declaration,content_sha256,supersedes_party_ref)values(pg_temp.id(12),pg_temp.id(402),''{}'',repeat(''a'',64),pg_temp.id(401))','23503');
select pg_temp.ok((select count(*)=2 from pg_constraint where conrelid='controller_security.flow174_revisions'::regclass and confrelid='public.estate_systems'::regclass and contype='f'and cardinality(conkey)=2),'origin and destination system references have composite tenant FKs');
-- Original consumed challenge cannot be re-authorized by replacing the actor's
-- authenticator while keeping its public session identity.
do $$declare intent text;c uuid;begin
 intent:=controller_security.canonical_questionnaire_json(jsonb_set(pg_temp.declare174(350)::jsonb,'{request,flowId}',to_jsonb(pg_temp.id(351))));
 c:=pg_temp.mfa174(intent,1);
 begin
  update public.user_mfa_factors set status='revoked',revoked_at=clock_timestamp()where id=pg_temp.id(41);
  insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)values(pg_temp.id(451),pg_temp.id(1),'totp','active','synthetic-replacement');
  insert into public.mfa_session_attestations(user_id,session_id,factor_id,satisfied_at,expires_at)values(pg_temp.id(1),pg_temp.id(101)::text,pg_temp.id(451),clock_timestamp(),clock_timestamp()+interval'1 hour');
  set local role human_action_writer;
  perform pg_temp.refused(format('select public.record_data_flow_declaration(%L,%L,%L,%L,%L)',pg_temp.id(11),pg_temp.id(1),pg_temp.id(101),intent,c));
  reset role;raise sqlstate'P1740';
 exception when sqlstate'P1740'then null;end;
end$$;
do $$declare intent text;begin
 intent:=controller_security.canonical_questionnaire_json(jsonb_set(jsonb_set(pg_temp.declare174(360)::jsonb,'{request,flowId}',to_jsonb(pg_temp.id(361))),'{request,validUntil}',to_jsonb(to_char((clock_timestamp()+interval'1 second')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))));
 perform pg_temp.record174(intent,1);
 perform pg_temp.record174(pg_temp.decision174('approve',362,360),2);
 perform pg_sleep(1.05);
 perform pg_temp.ok(controller_security.flow174_state(pg_temp.id(11),pg_temp.id(360))='expired','elapsed review validity preserves approved immutable history as expired');
end$$;

select pg_temp.refused('update controller_security.flow174_revisions set valid_until=clock_timestamp()where id=pg_temp.id(201)');
select pg_temp.refused('delete from controller_security.flow174_reviews where revision_id=pg_temp.id(201)');
select pg_temp.refused('truncate controller_security.flow174_reviews');
select pg_temp.ok((select count(*)=0 from public.approval_tokens where tenant_id=pg_temp.id(11)),'metadata review creates no execution token');
set local role agent_ledger_writer;
select pg_temp.refused('select public.append_agent_ledger(pg_temp.id(11),pg_temp.id(999),''agent'',''synthetic'',null,null,null,''data_flow.reviewed'',null,null,null,null,null,null,null,''success'',''{}'')');
reset role;
select pg_temp.ok((select count(*)=0 from public.connector_grants where tenant_id=pg_temp.id(11)),'metadata review creates no connector grant');
rollback;
