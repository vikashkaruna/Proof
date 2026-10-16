-- Unmounted139 core: synthetic rollback-only PostgreSQL authority/receipt tests.
-- Must run only through the owned disposable database harness.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99139900-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'website-asset-'||n||'@example.invalid' from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'website-asset-'||n||'@example.invalid',n=3 from generate_series(1,4)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'website-asset-a','A'),(pg_temp.id(12),'website-asset-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'viewer'),(pg_temp.id(11),pg_temp.id(3),'founder'),(pg_temp.id(11),pg_temp.id(4),'founder');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'asset-a','A'),(pg_temp.id(22),pg_temp.id(12),'asset-b','B');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'Public site','application'),(pg_temp.id(32),pg_temp.id(12),pg_temp.id(22),'Foreign site','application');
create function pg_temp.registration(k integer default 41) returns jsonb language sql as $$select jsonb_build_object('version',1,'kind','register_target','operationKey',pg_temp.id(k),'confirmed',true,'estateId',pg_temp.id(21),'systemId',pg_temp.id(31),'expectedEstateVersion',1,'expectedSystemVersion',1,'url','https://public.org/')$$;
create function pg_temp.write(r jsonb,a uuid default pg_temp.id(1),t uuid default pg_temp.id(11)) returns jsonb language plpgsql as $$
declare result jsonb;txt text:=controller_security.canonical_questionnaire_json(r);prior text:=current_user;
begin set local role human_action_writer;result:=public.record_public_website_asset_operation(t,a,txt);execute format('set local role %I',prior);return result;
exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.refused(r jsonb,m text,a uuid default pg_temp.id(1),t uuid default pg_temp.id(11)) returns void language plpgsql as $$
declare refused boolean:=false;n bigint;begin select count(*) into n from public.audit_ledger;
begin perform pg_temp.write(r,a,t);set constraints all immediate;set constraints all deferred;exception when others then refused:=true;end;
perform pg_temp.ok(refused,m);perform pg_temp.ok((select count(*)=n from public.audit_ledger),'refusal leaves ledger unchanged');end$$;
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

create temporary table asset_saved(kind text primary key,v jsonb);
insert into asset_saved values('registration',pg_temp.write(pg_temp.registration()));
set constraints all immediate;set constraints all deferred;
select pg_temp.ok((select count(*)=1 from public.public_website_targets where tenant_id=pg_temp.id(11)),'one target');
do $$declare denied boolean:=false;begin
 begin perform public.list_public_website_assets(pg_temp.id(11),pg_temp.id(1),null,null);exception when invalid_parameter_value then denied:=true;end;
 perform pg_temp.ok(denied,'null page limit refused');
end$$;

select pg_temp.ok((select v->'replayed'='false'::jsonb and (v->>'snapshotText')::jsonb->'ownershipVerified'='false'::jsonb and (v->>'snapshotText')::jsonb->'connectorAccessGranted'='false'::jsonb from asset_saved where kind='registration'),'metadata confers no verified ownership/connector authority');
select pg_temp.ok(pg_temp.write(pg_temp.registration())->'replayed'='true'::jsonb,'exact replay');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11)),'one atomic receipt');
select pg_temp.refused(pg_temp.registration()||jsonb_build_object('url','https://other.org/'),'same key changed body');
select pg_temp.refused(pg_temp.registration(42),'active duplicate target');
select pg_temp.refused(pg_temp.registration(42),'viewer refused',pg_temp.id(2));
select pg_temp.refused(pg_temp.registration(42),'offboarded founder refused',pg_temp.id(4));
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('systemId',pg_temp.id(32)),'foreign system refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('expectedEstateVersion',2),'stale estate refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('url','https://user:secret@public.org/'),'credentials refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('url','https://public.org/?token=secret'),'query refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('url','https://metadata.internal/'),'reserved DNS refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('url','https://other.org/','version',1.0),'noncanonical decimal version refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('url',E'https://public.org/a\\b'),'noncanonical backslash refused');
select pg_temp.refused(pg_temp.registration(42)||jsonb_build_object('url','https://public.org/<page>'),'noncanonical escaped path refused');
-- Private helpers and direct storage grant no caller-controlled write authority.
select pg_temp.ok(not has_function_privilege('service_role','public.record_public_website_asset_operation(uuid,uuid,text)','EXECUTE'),'service role no metadata writer');
select pg_temp.ok(not has_function_privilege('human_action_writer','controller_security.website_asset139_write(uuid,uuid,text,uuid)','EXECUTE'),'human no private helper execution');
select pg_temp.ok(not has_table_privilege('human_action_writer','public.public_website_targets','INSERT'),'human no direct target insert');
select pg_temp.ok(not has_table_privilege('service_role','public.public_website_asset_operations','SELECT'),'service no direct operation reads');
-- Generic agent never gains human metadata action authority.
do $$declare refused boolean:=false;begin
 begin set local role agent_ledger_writer;perform public.append_agent_ledger(pg_temp.id(11),gen_random_uuid(),'agent','fixture',null,null,null,'connector.website.target_registered',null,null,null,null,null,null,null,'success','{}');exception when insufficient_privilege then refused:=true;end;
 reset role;perform pg_temp.ok(refused,'generic agent action refused');end$$;
-- Immutable historical rows remain readable even when current inventory changes.
update public.estates set status='archived',version=version+1 where id=pg_temp.id(21);
select pg_temp.ok(pg_temp.write(pg_temp.registration())->'replayed'='true'::jsonb,'historical exact replay does not create again after archive');
select pg_temp.refused(pg_temp.registration(43),'new registration archived');
update public.estates set status='active',version=1 where id=pg_temp.id(21);
-- Current authority still governs every historical replay.
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
select pg_temp.refused(pg_temp.registration(),'historical replay after demotion refused');
update public.tenant_users set role='owner' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);

-- Fresh capture and association commit as one transaction with original v2 bytes.
create function pg_temp.capture_asset(r jsonb) returns jsonb language plpgsql as $$
declare result jsonb;txt text:=controller_security.canonical_questionnaire_json(r);payload text:=controller_security.canonical_questionnaire_json(pg_temp.payload());prior text:=current_user;
begin set local role human_action_writer;result:=public.record_targeted_public_website_capture(pg_temp.id(11),pg_temp.id(1),txt,'https://public.org/',pg_temp.result(),'axiom-public-evidence-v2-canonical-json-1',payload,encode(sha256(convert_to(payload,'UTF8')),'hex'),pg_temp.sources());execute format('set local role %I',prior);return result;
exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.capture_intent(k integer default 44) returns jsonb language sql as $$select jsonb_build_object('version',1,'kind','capture','operationKey',pg_temp.id(k),'confirmed',true,'targetId',(v->>'snapshotText')::jsonb->>'id','expectedTargetSha256',v->>'snapshotSha256') from asset_saved where kind='registration'$$;
insert into asset_saved values('capture',pg_temp.capture_asset(pg_temp.capture_intent()));
set constraints all immediate;set constraints all deferred;
select pg_temp.ok((select count(*)=1 from public.public_website_asset_associations where tenant_id=pg_temp.id(11)),'one association');
select pg_temp.ok((select count(*)=1 from public.public_website_control_evidence where tenant_id=pg_temp.id(11)),'one capture');
select pg_temp.ok(pg_temp.capture_asset(pg_temp.capture_intent())->'replayed'='true'::jsonb,'fresh replay no second capture');
select pg_temp.ok((select count(*)=1 from public.public_website_control_evidence where tenant_id=pg_temp.id(11)),'capture remains one');
-- Explicit existing-capture association does not invoke fetch and requires exact receipt.
create function pg_temp.association(k integer default 45) returns jsonb language sql as $$select jsonb_build_object('version',1,'kind','associate_capture','operationKey',pg_temp.id(k),'confirmed',true,
 'targetId',(v->>'snapshotText')::jsonb->>'targetId','expectedTargetSha256',(v->>'snapshotText')::jsonb->>'targetSha256',
 'checkId',(v->>'snapshotText')::jsonb->>'checkId','expectedPayloadSha256',(v->>'snapshotText')::jsonb->>'payloadSha256',
 'expectedCaptureReceipt',(v->>'snapshotText')::jsonb->'captureReceipt'->>'id') from asset_saved where kind='capture'$$;
select pg_temp.refused(pg_temp.association()||jsonb_build_object('expectedPayloadSha256',repeat('f',64)),'capture digest mismatch refused');
select pg_temp.refused(pg_temp.association()||jsonb_build_object('expectedCaptureReceipt','1'),'capture receipt mismatch refused');
insert into asset_saved values('association',pg_temp.write(pg_temp.association()));
set constraints all immediate;set constraints all deferred;
-- Composite FK preserves tenant identity without intercepting the original rich
-- evidence TRUNCATE-denial trigger. Reciprocal receipt guard must independently
-- reject a missing/mismatched richer companion, even for coherent owner DML.
insert into asset_saved values('legacy',(select public.record_public_website_check(pg_temp.id(11),pg_temp.id(1),gen_random_uuid(),'https://public.org/','https://public.org/','checked',pg_temp.result(),null)));
create function pg_temp.forge_binding(check_id uuid,payload_sha text) returns void language plpgsql as $$
declare base jsonb:=(select (v->>'snapshotText')::jsonb from asset_saved where kind='capture');r jsonb;s jsonb;rt text;st text;
 oid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();op uuid:=gen_random_uuid();receipt bigint;
begin
 s:=base||jsonb_build_object('id',rid,'checkId',check_id,'payloadSha256',payload_sha);
 r:=jsonb_build_object('version',1,'kind','associate_capture','operationKey',op,'confirmed',true,'targetId',s->>'targetId',
 'expectedTargetSha256',s->>'targetSha256','checkId',check_id,'expectedPayloadSha256',payload_sha,'expectedCaptureReceipt',s->'captureReceipt'->>'id');
 rt:=controller_security.canonical_questionnaire_json(r);st:=controller_security.canonical_questionnaire_json(s);
 receipt:=public.append_ledger(pg_temp.id(11),op,'human',pg_temp.id(1)::text,null,null,null,'connector.website.asset_associated',rid::text,
 encode(sha256(convert_to(rt,'UTF8')),'hex'),encode(sha256(convert_to(st,'UTF8')),'hex'),null,null,null,null,'success',
 jsonb_build_object('operation_id',oid,'operation_key',op,'kind','associate_capture'));
 insert into public.public_website_asset_operations(id,tenant_id,actor_id,operation_key,kind,resource_id,request_text,request_sha256,snapshot_text,snapshot_sha256,receipt_id)
 values(oid,pg_temp.id(11),pg_temp.id(1),op,'associate_capture',rid,rt,encode(sha256(convert_to(rt,'UTF8')),'hex'),st,encode(sha256(convert_to(st,'UTF8')),'hex'),receipt);
 insert into public.public_website_asset_associations values(rid,pg_temp.id(11),(s->>'targetId')::uuid,check_id,s->>'targetSha256',payload_sha,(s->'captureReceipt'->>'id')::bigint,st,encode(sha256(convert_to(st,'UTF8')),'hex'),oid);
end$$;
do $$declare denied boolean;n bigint;begin
 select count(*) into n from public.audit_ledger;
 denied:=false;begin perform pg_temp.forge_binding((select (v->>'id')::uuid from asset_saved where kind='legacy'),repeat('f',64));set constraints all immediate;
 exception when check_violation then denied:=true;end;
 perform pg_temp.ok(denied,'reciprocal guard rejects missing rich evidence');
 denied:=false;begin perform pg_temp.forge_binding((select ((v->>'snapshotText')::jsonb->>'checkId')::uuid from asset_saved where kind='capture'),repeat('f',64));set constraints all immediate;
 exception when check_violation then denied:=true;end;
 perform pg_temp.ok(denied,'reciprocal guard rejects mismatched rich evidence');
 perform pg_temp.ok((select count(*)=n from public.audit_ledger),'coherent forged receipts rolled back');
end$$;
set constraints all deferred;
-- Failure of the association receipt rolls back the check and both capture events.
create function pg_temp.fail_asset_receipt() returns trigger language plpgsql as $$begin
 if current_setting('axiom.asset_fixture_fail',true)='on' and new.action_type::text='connector.website.asset_associated' then raise exception 'synthetic receipt outage';end if;return new;end$$;
create trigger asset_fixture_receipt_outage before insert on public.audit_ledger for each row execute function pg_temp.fail_asset_receipt();
do $$declare checks bigint;events bigint;refused boolean:=false;begin
 select count(*) into checks from public.public_website_checks;select count(*) into events from public.audit_ledger;
 perform set_config('axiom.asset_fixture_fail','on',true);
 begin perform pg_temp.capture_asset(pg_temp.capture_intent(48));exception when others then refused:=true;end;
 perform set_config('axiom.asset_fixture_fail','off',true);
 perform pg_temp.ok(refused,'receipt outage fails capture');
 perform pg_temp.ok((select count(*)=checks from public.public_website_checks),'failed association leaves no check');
 perform pg_temp.ok((select count(*)=events from public.audit_ledger),'failed association leaves no ledger events');
end$$;
drop trigger asset_fixture_receipt_outage on public.audit_ledger;
-- Naked generic human receipts cannot claim asset operations.
do $$declare refused boolean:=false;begin
 begin perform public.append_ledger(pg_temp.id(11),gen_random_uuid(),'human',pg_temp.id(1)::text,null,null,null,'connector.website.asset_associated',pg_temp.id(99)::text,repeat('a',64),repeat('b',64),null,null,null,null,'success','{}');set constraints all immediate;
 exception when check_violation then refused:=true;end;
 perform pg_temp.ok(refused,'naked human receipt refused');
end$$;
set constraints all deferred;
-- Withdrawal appends a new immutable event; it neither edits nor deletes prior rows.
insert into asset_saved values('withdraw',pg_temp.write((select jsonb_build_object('version',1,'kind','withdraw','operationKey',pg_temp.id(46),'confirmed',true,'subjectType','target','subjectId',(v->>'snapshotText')::jsonb->>'id','expectedSubjectSha256',v->>'snapshotSha256','reason','QA replacement') from asset_saved where kind='registration')));
select pg_temp.refused(pg_temp.association(47),'withdrawn target rejects new association');
select pg_temp.ok(pg_temp.capture_asset(pg_temp.capture_intent())->'replayed'='true'::jsonb,'historical capture remains exact after withdrawal');
set constraints all immediate;set constraints all deferred;
do $$declare refused boolean;begin
 refused:=false;begin update public.public_website_targets set url='https://other.org/';exception when others then refused:=true;end;perform pg_temp.ok(refused,'target update immutable');
 refused:=false;begin delete from public.public_website_asset_associations;exception when others then refused:=true;end;perform pg_temp.ok(refused,'association delete immutable');
 refused:=false;begin truncate public.public_website_asset_operations cascade;exception when others then refused:=true;end;perform pg_temp.ok(refused,'operation truncate immutable');
end$$;
select pg_temp.ok(not exists(select 1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type::text like 'connector.website.%' and (detail::text like '%https:%' or detail::text like '%QA replacement%')),'ledger contains no URL/reason/raw page');
rollback;
