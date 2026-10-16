--140 exact-intent cancellation: only the disposable synthetic harness.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99140000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'asset-cancel-'||n||'@example.invalid' from generate_series(1,4)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'asset-cancel-'||n||'@example.invalid',n=3 from generate_series(1,4)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'asset-cancel-a','A'),(pg_temp.id(12),'asset-cancel-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(12),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'viewer'),(pg_temp.id(11),pg_temp.id(3),'founder'),(pg_temp.id(11),pg_temp.id(4),'founder');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'asset-cancel-a','A'),(pg_temp.id(22),pg_temp.id(12),'asset-cancel-b','B');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values(pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'Site','application'),(pg_temp.id(32),pg_temp.id(12),pg_temp.id(22),'B site','application');
create function pg_temp.registration(k integer default 41) returns jsonb language sql as $$select jsonb_build_object('version',1,'kind','register_target','operationKey',pg_temp.id(k),'confirmed',true,'estateId',pg_temp.id(21),'systemId',pg_temp.id(31),'expectedEstateVersion',1,'expectedSystemVersion',1,'url','https://public.org/')$$;
create function pg_temp.write(r jsonb) returns jsonb language plpgsql as $$declare v jsonb;txt text:=controller_security.canonical_questionnaire_json(r);prior text:=current_user;begin set local role human_action_writer;v:=public.record_public_website_asset_operation(pg_temp.id(11),pg_temp.id(1),txt);execute format('set local role %I',prior);return v;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.cancel(r jsonb,reason text default 'Abandon this exact pending intent',actor uuid default pg_temp.id(1),tenant uuid default pg_temp.id(11),confirmed boolean default true) returns jsonb language plpgsql as $$declare v jsonb;txt text:=controller_security.canonical_questionnaire_json(r);prior text:=current_user;begin set local role human_action_writer;v:=public.cancel_public_website_asset_operation(tenant,actor,txt,reason,confirmed);execute format('set local role %I',prior);return v;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.refused(r jsonb,m text,reason text default 'Abandon this exact pending intent',actor uuid default pg_temp.id(1),tenant uuid default pg_temp.id(11),confirmed boolean default true) returns void language plpgsql as $$declare denied boolean:=false;n bigint;begin select count(*) into n from public.audit_ledger;begin perform pg_temp.cancel(r,reason,actor,tenant,confirmed);set constraints all immediate;exception when others then denied:=true;end;perform pg_temp.ok(denied,m);perform pg_temp.ok((select count(*)=n from public.audit_ledger),'refused cancellation appends nothing');end$$;
create temporary table cancel_saved(kind text primary key,v jsonb);
insert into cancel_saved values('cancelled',pg_temp.cancel(pg_temp.registration()));
set constraints all immediate;set constraints all deferred;
select pg_temp.ok((select v->>'state'='cancelled' and v->'replayed'='false'::jsonb from cancel_saved where kind='cancelled'),'new cancellation positive');
select pg_temp.ok(pg_temp.cancel(pg_temp.registration())->'replayed'='true'::jsonb,'exact cancellation replay');
select pg_temp.ok(pg_temp.write(pg_temp.registration())->>'state'='cancelled','ordinary late write fenced');
select pg_temp.ok((select count(*)=0 from public.public_website_asset_operations where tenant_id=pg_temp.id(11)),'no recorded operation after cancellation');
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11)),'exactly one cancellation receipt');
select pg_temp.refused(pg_temp.registration(),'changed reason conflict','Different reason');
select pg_temp.refused(pg_temp.registration()||jsonb_build_object('url','https://other.org/'),'changed body conflict');
select pg_temp.refused(pg_temp.registration(42),'viewer refused','Abandon',pg_temp.id(2));
select pg_temp.refused(pg_temp.registration(42),'offboarded founder refused','Abandon',pg_temp.id(4));
select pg_temp.refused(pg_temp.registration(42),'cross-tenant references refused','Abandon',pg_temp.id(1),pg_temp.id(12));
select pg_temp.refused(pg_temp.registration(42),'unconfirmed refused','Abandon',pg_temp.id(1),pg_temp.id(11),false);
select pg_temp.refused(pg_temp.registration(42),'blank reason refused',' ');
update public.estates set status='archived',version=2 where id=pg_temp.id(21);
select pg_temp.ok(pg_temp.cancel(pg_temp.registration(42))->>'state'='cancelled','stale archived intent can be cancelled');
update public.estates set status='active' where id=pg_temp.id(21);
insert into cancel_saved values('recorded',pg_temp.write(pg_temp.registration(43)||jsonb_build_object('expectedEstateVersion',2)));
select pg_temp.ok(pg_temp.cancel(pg_temp.registration(43)||jsonb_build_object('expectedEstateVersion',2))->>'state'='recorded','recorded positive wins; no undo');
select pg_temp.ok(not exists(select 1 from public.public_website_asset_cancellations where operation_key=pg_temp.id(43)),'recorded intent has no tombstone');
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


create function pg_temp.capture_intent() returns jsonb language sql as $$select jsonb_build_object('version',1,'kind','capture','operationKey',pg_temp.id(44),'confirmed',true,'targetId',(v->>'snapshotText')::jsonb->>'id','expectedTargetSha256',v->>'snapshotSha256') from cancel_saved where kind='recorded'$$;
insert into cancel_saved values('capture_cancelled',pg_temp.cancel(pg_temp.capture_intent()));
-- Valid late collector output would create a check in133 without the OUTER
--140 guard. Its cancellation must return before any such nested insert.
do $$declare result jsonb;txt text:=controller_security.canonical_questionnaire_json(pg_temp.capture_intent());payload text:=controller_security.canonical_questionnaire_json(pg_temp.payload());n bigint;begin
 select count(*) into n from public.audit_ledger;
 set local role human_action_writer;
 result:=public.record_targeted_public_website_capture(pg_temp.id(11),pg_temp.id(1),txt,'https://public.org/',pg_temp.result(),'axiom-public-evidence-v2-canonical-json-1',payload,encode(sha256(convert_to(payload,'UTF8')),'hex'),pg_temp.sources());
 reset role;
 perform pg_temp.ok(result->>'state'='cancelled','late capture returns cancellation, not capture receipt');
 perform pg_temp.ok((select count(*)=n from public.audit_ledger),'late capture no ledger events');
 perform pg_temp.ok(not exists(select 1 from public.public_website_checks where tenant_id=pg_temp.id(11)),'late capture no website check');
 perform pg_temp.ok(not exists(select 1 from public.public_website_control_evidence where tenant_id=pg_temp.id(11)),'late capture no rich evidence');
 perform pg_temp.ok(not exists(select 1 from public.public_website_asset_associations where tenant_id=pg_temp.id(11)),'late capture no association');
end$$;
update public.estates set status='archived',version=3 where id=pg_temp.id(21);
select pg_temp.ok(pg_temp.cancel(pg_temp.capture_intent())->>'state'='cancelled','historical cancellation replay ignores later lifecycle');
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
select pg_temp.refused(pg_temp.capture_intent(),'demotion blocks cancellation replay');
do $$declare v jsonb;begin set local role service_role;v:=public.read_public_website_asset_operation(pg_temp.id(11),pg_temp.id(1),pg_temp.id(44));reset role;perform pg_temp.ok(v->>'state'='cancelled','read capability can recover historical cancellation after demotion');end$$;
update public.tenant_users set role='owner' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
do $$declare v jsonb;begin set local role service_role;v:=public.read_public_website_asset_operation(pg_temp.id(11),pg_temp.id(2),pg_temp.id(44));reset role;perform pg_temp.ok(v->>'state'='not_found','other actor cannot read tombstone');end$$;
-- Stale payload claims and legacy capture richness are not cancellation gates.
insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,final_url,status,result) values(pg_temp.id(61),pg_temp.id(11),pg_temp.id(1),gen_random_uuid(),'https://public.org/','https://public.org/','checked',pg_temp.result());
select pg_temp.ok(pg_temp.cancel((select jsonb_build_object('version',1,'kind','associate_capture','operationKey',pg_temp.id(45),'confirmed',true,'targetId',(v->>'snapshotText')::jsonb->>'id','expectedTargetSha256',repeat('f',64),'checkId',pg_temp.id(61),'expectedPayloadSha256',repeat('e',64),'expectedCaptureReceipt','999') from cancel_saved where kind='recorded'))->>'state'='cancelled','abandonment never attests claimed capture facts');
-- New tombstone and ledger are atomic on any receipt failure.
create function pg_temp.cancel_outage() returns trigger language plpgsql as $$begin if new.action_type::text='connector.website.operation_cancelled' then raise exception 'synthetic cancellation receipt outage';end if;return new;end$$;
create trigger asset_cancel_outage before insert on public.audit_ledger for each row execute function pg_temp.cancel_outage();
select pg_temp.refused(pg_temp.registration(46),'receipt outage rolls back cancellation');
drop trigger asset_cancel_outage on public.audit_ledger;
select pg_temp.ok(not exists(select 1 from public.public_website_asset_cancellations where operation_key=pg_temp.id(46)),'no tombstone after failed receipt');
-- No bypass to prior public/private writers, generic agent or direct rows.
select pg_temp.ok(not has_function_privilege('human_action_writer','controller_security.record_targeted_public_website_capture_before_0140(uuid,uuid,text,text,jsonb,text,text,text,jsonb)','EXECUTE'),'old targeted writer private');
select pg_temp.ok(not has_function_privilege('human_action_writer','controller_security.website_asset139_write_before_0140(uuid,uuid,text,uuid)','EXECUTE'),'old common helper private');
select pg_temp.ok(not has_function_privilege('service_role','public.cancel_public_website_asset_operation(uuid,uuid,text,text,boolean)','EXECUTE'),'service has no cancellation authority');
select pg_temp.ok(not has_table_privilege('human_action_writer','public.public_website_asset_cancellations','INSERT'),'no direct cancellation insert');
do $$declare denied boolean:=false;begin begin set local role agent_ledger_writer;perform public.append_agent_ledger(pg_temp.id(11),gen_random_uuid(),'agent','fixture',null,null,null,'connector.website.operation_cancelled',null,null,null,null,null,null,null,'success','{}');exception when insufficient_privilege then denied:=true;end;reset role;perform pg_temp.ok(denied,'generic agent cancellation denied');end$$;
-- Drain prior reciprocal events so TRUNCATE reaches its immutable trigger.
set constraints all immediate;set constraints all deferred;
do $$declare denied boolean;begin
 denied:=false;begin update public.public_website_asset_cancellations set reason='Changed';exception when insufficient_privilege then denied:=true;end;perform pg_temp.ok(denied,'cancellation update immutable');
 denied:=false;begin delete from public.public_website_asset_cancellations;exception when insufficient_privilege then denied:=true;end;perform pg_temp.ok(denied,'cancellation delete immutable');
 denied:=false;begin truncate public.public_website_asset_cancellations;exception when insufficient_privilege then denied:=true;end;perform pg_temp.ok(denied,'cancellation truncate immutable');
 denied:=false;begin perform public.append_ledger(pg_temp.id(11),gen_random_uuid(),'human',pg_temp.id(1)::text,null,null,null,'connector.website.operation_cancelled',pg_temp.id(99)::text,repeat('a',64),repeat('b',64),null,null,null,null,'success','{}');set constraints all immediate;exception when check_violation then denied:=true;end;perform pg_temp.ok(denied,'naked cancellation receipt denied');
end$$;
set constraints all deferred;
select pg_temp.ok(not exists(select 1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type::text='connector.website.operation_cancelled' and (detail::text like '%https:%' or detail::text like '%Abandon%')),'cancellation ledger has only scoped IDs, not URL/reason');

-- Scoped selector reads expose retained history without fabricated rows or writes.
do $$declare v jsonb;target uuid;denied boolean:=false;n bigint;begin
 select ((s.v->>'snapshotText')::jsonb->>'id')::uuid into target from cancel_saved s where kind='recorded';
 select count(*) into n from public.audit_ledger;
 set local role service_role;
 v:=public.list_public_website_asset_selection(pg_temp.id(11),pg_temp.id(2),'targets',pg_temp.id(21),pg_temp.id(31),null,null);
 reset role;
 perform pg_temp.ok(v->>'tenantId'=pg_temp.id(11)::text and jsonb_array_length(v->'rows')=1 and v->'nextCursor'='null'::jsonb,'viewer scoped historical target selector');
 set local role service_role;
 v:=public.list_public_website_asset_selection(pg_temp.id(11),pg_temp.id(2),'captures',null,null,target,null);
 reset role;
 perform pg_temp.ok(jsonb_array_length(v->'rows')=0,'legacy hash-only check excluded from richer capture selector');
 begin set local role service_role;v:=public.list_public_website_asset_selection(pg_temp.id(12),pg_temp.id(1),'targets',pg_temp.id(21),pg_temp.id(31),null,null);exception when insufficient_privilege then denied:=true;end;reset role;
 perform pg_temp.ok(denied,'other tenant inventory selection refused');
 perform pg_temp.ok((select count(*)=n from public.audit_ledger),'selector reads append nothing');
end$$;

-- Coherent reciprocal forgery cannot give a recorded operation a second,
-- contradictory cancellation outcome, even through privileged fixture DML.
do $$declare o public.public_website_asset_operations;cid uuid:=gen_random_uuid();st text;rid bigint;denied boolean:=false;n bigint;begin
 select * into o from public.public_website_asset_operations where tenant_id=pg_temp.id(11) and operation_key=pg_temp.id(43);
 st:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'id',cid,'tenantId',o.tenant_id,'actorId',o.actor_id,'operationKey',o.operation_key,'requestSha256',o.request_sha256,'reason','Synthetic contradictory tombstone','confirmed',true));
 select count(*) into n from public.audit_ledger;
 begin
  rid:=public.append_ledger(o.tenant_id,o.operation_key,'human',o.actor_id::text,null,null,null,'connector.website.operation_cancelled',cid::text,o.request_sha256,encode(sha256(convert_to(st,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('cancellation_id',cid,'operation_key',o.operation_key,'kind',o.kind));
  insert into public.public_website_asset_cancellations(id,tenant_id,actor_id,operation_key,request_text,request_sha256,reason,cancellation_text,cancellation_sha256,receipt_id)
  values(cid,o.tenant_id,o.actor_id,o.operation_key,o.request_text,o.request_sha256,'Synthetic contradictory tombstone',st,encode(sha256(convert_to(st,'UTF8')),'hex'),rid);
  set constraints all immediate;
 exception when check_violation then denied:=true;end;
 perform pg_temp.ok(denied,'coherent recorded/cancelled coexistence refused');
 perform pg_temp.ok((select count(*)=n from public.audit_ledger),'coexistence failure rolls back second receipt');
end$$;

-- Real look-ahead pagination and association-only withdrawal preserve the target.
update public.estates set status='active' where id=pg_temp.id(21);
select pg_temp.write(jsonb_build_object('version',1,'kind','withdraw','operationKey',pg_temp.id(99),'confirmed',true,'subjectType','target','subjectId',(v->>'snapshotText')::jsonb->>'id','expectedSubjectSha256',v->>'snapshotSha256','reason','Replace stale synthetic target')) from cancel_saved where kind='recorded';
do $$declare n integer;v jsonb;page jsonb;page2 jsonb;t uuid;digest text;captured jsonb;association jsonb;request_text text;payload text:=controller_security.canonical_questionnaire_json(pg_temp.payload());begin
 for n in 100..150 loop
  v:=pg_temp.write(pg_temp.registration(n)||jsonb_build_object('expectedEstateVersion',3,'url',case when n=100 then 'https://public.org/' else 'https://public.org/page-'||n end));
 end loop;
 set local role service_role;
 page:=public.list_public_website_asset_selection(pg_temp.id(11),pg_temp.id(2),'targets',pg_temp.id(21),pg_temp.id(31),null,null);
 page2:=public.list_public_website_asset_selection(pg_temp.id(11),pg_temp.id(2),'targets',pg_temp.id(21),pg_temp.id(31),null,(page->>'nextCursor')::uuid);
 reset role;
 perform pg_temp.ok(jsonb_array_length(page->'rows')=50 and page->>'nextCursor'=page->'rows'->49->>'id','fifty-row page cursor is exact final row');
 perform pg_temp.ok(jsonb_array_length(page2->'rows')=2 and page2->'nextCursor'='null'::jsonb,'second page contains remaining rows only');
 select id,snapshot_sha256 into t,digest from public.public_website_targets where tenant_id=pg_temp.id(11) and estate_version=3 and url='https://public.org/' order by id limit 1;
 request_text:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'kind','capture','operationKey',pg_temp.id(161),'confirmed',true,'targetId',t,'expectedTargetSha256',digest));
 set local role human_action_writer;
 captured:=public.record_targeted_public_website_capture(pg_temp.id(11),pg_temp.id(1),request_text,'https://public.org/',pg_temp.result(),'axiom-public-evidence-v2-canonical-json-1',payload,encode(sha256(convert_to(payload,'UTF8')),'hex'),pg_temp.sources());
 reset role;
 association:=(captured->>'snapshotText')::jsonb;
 perform pg_temp.write(jsonb_build_object('version',1,'kind','withdraw','operationKey',pg_temp.id(162),'confirmed',true,'subjectType','association','subjectId',association->>'id','expectedSubjectSha256',captured->>'snapshotSha256','reason','Synthetic mistaken binding'));
 set local role service_role;
 page:=public.list_public_website_asset_selection(pg_temp.id(11),pg_temp.id(2),'associations',null,null,t,null);
 page2:=public.list_public_website_asset_selection(pg_temp.id(11),pg_temp.id(2),'captures',null,null,t,null);
 reset role;
 perform pg_temp.ok(jsonb_array_length(page->'rows')=1 and page->'rows'->0->'withdrawn'='true'::jsonb and page->'rows'->0->'operation'->'receipt'=captured->'receipt','association selector preserves its immutable creation receipt and withdrawal state');
 perform pg_temp.ok(jsonb_array_length(page2->'rows')=1 and page2->'rows'->0->>'checkId'=association->>'checkId','rich capture remains reusable after association withdrawal');
 perform pg_temp.ok(not controller_security.website_asset139_withdrawn(pg_temp.id(11),'target',t),'association withdrawal never withdraws whole target');
end$$;
set constraints all immediate;
rollback;
