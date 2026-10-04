-- Actual DB source/authority/immutability assertions. Synthetic static facts.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99100500-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'public-source-'||n||'@example.invalid' from generate_series(1,8)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'public-source-'||n||'@example.invalid',n in(4,5,6) from generate_series(1,8)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'public-source-a','A'),(pg_temp.id(12),'public-source-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'admin'),(pg_temp.id(11),pg_temp.id(3),'viewer'),
(pg_temp.id(11),pg_temp.id(4),'founder'),(pg_temp.id(11),pg_temp.id(5),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(7),'founder'),(pg_temp.id(11),pg_temp.id(8),'axiom_analyst'),
(pg_temp.id(12),pg_temp.id(1),'owner');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'public-source-a','A'),(pg_temp.id(22),pg_temp.id(12),'public-source-b','B');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('public-source-test',now(),'test','Synthetic fixture',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values
(pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'public-source-test','A'),(pg_temp.id(32),pg_temp.id(12),pg_temp.id(22),'public-source-test','B'),
(pg_temp.id(33),pg_temp.id(11),pg_temp.id(21),'public-source-test','Another A'),
(pg_temp.id(34),pg_temp.id(11),null,'public-source-test','Unassigned intake A'),(pg_temp.id(35),pg_temp.id(12),null,'public-source-test','Unassigned intake B');
create function pg_temp.result(o jsonb default '{}') returns jsonb language sql as $$select jsonb_build_object('requestedUrl','https://example.invalid/','finalUrl','https://example.invalid/','checkedAt',now(),'status','checked','httpStatus',200,'bytes',3,'contentSha256',repeat('a',64),'title','Private-looking title discarded','headings',jsonb_build_array('Discarded heading'),'publicLinks','[]'::jsonb)||o$$;
insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,final_url,status,result) values
(pg_temp.id(41),pg_temp.id(11),pg_temp.id(1),pg_temp.id(141),'https://example.invalid/','https://example.invalid/','checked',pg_temp.result()),
(pg_temp.id(42),pg_temp.id(12),pg_temp.id(1),pg_temp.id(142),'https://example.invalid/','https://example.invalid/','checked',pg_temp.result());
create function pg_temp.zero(d text default repeat('a',64)) returns jsonb language sql as $$select jsonb_build_object('version',1,'scope','static_html_form_descendants','sourceSha256',d,'observedFormCount',0,'formsTruncated',false,'forms','[]'::jsonb)$$;
create function pg_temp.control(o jsonb default '{}') returns jsonb language sql as $$select '{"ordinal":1,"element":"input","inputType":"email","requiredAttribute":true,"disabledAttribute":false}'::jsonb||o$$;
create function pg_temp.form(o jsonb default '{}') returns jsonb language sql as $$select jsonb_build_object('ordinal',1,'method','post','observedControlCount',2,'excludedControlCount',1,'controlsTruncated',false,'controls',jsonb_build_array(pg_temp.control()))||o$$;
create function pg_temp.metadata(o jsonb default '{}') returns jsonb language sql as $$select pg_temp.zero()||jsonb_build_object('observedFormCount',1,'forms',jsonb_build_array(pg_temp.form()))||o$$;
create function pg_temp.preview(o jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;prior text:=current_user;
begin set local role human_action_writer;
r:=public.get_public_source_projection(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),coalesce((o->>'check')::uuid,pg_temp.id(41)));
execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.bind(o jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;v jsonb;prior text:=current_user;
begin v:=pg_temp.preview(o);set local role human_action_writer;
r:=public.record_public_source_binding(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),coalesce((o->>'check')::uuid,pg_temp.id(41)),coalesce(o->>'root',v->'runtime_binding'->>'root_content_sha256',repeat('a',64)),coalesce(o->>'projection',v->'runtime_binding'->>'projection_sha256',repeat('b',64)),coalesce((o->>'correlation')::uuid,pg_temp.id(101)));
execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;end$$;
-- Privileges: read-scoped preview, human-only creation; no direct writes.
do $$declare role_name text;signature text;begin
foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','evidence_ingestion_writer'] loop
perform pg_temp.ok(not has_table_privilege(role_name,'public.public_source_bindings','INSERT') and not has_table_privilege(role_name,'public.public_source_bindings','UPDATE') and not has_table_privilege(role_name,'public.public_source_bindings','DELETE'),'no direct DML '||role_name);
end loop;
perform pg_temp.ok(has_table_privilege('service_role','public.public_source_bindings','SELECT'),'service read only');
perform pg_temp.ok(not has_table_privilege('authenticated','public.public_source_bindings','SELECT'),'user direct read refused');
perform pg_temp.ok((select relrowsecurity from pg_class where oid='public.public_source_bindings'::regclass),'RLS enabled');
foreach signature in array array['public.public_source_count_valid(jsonb)','public.public_source_form_metadata_valid(jsonb,text)'] loop
foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'validator private');end loop;end loop;
foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer','evidence_ingestion_writer','statutory_proof_writer','approval_archive_writer'] loop
perform pg_temp.ok(not has_function_privilege(role_name,'public.record_public_source_binding(uuid,uuid,uuid,uuid,text,text,uuid)','EXECUTE'),'creation scoped '||role_name);end loop;
perform pg_temp.ok(has_function_privilege('human_action_writer','public.record_public_source_binding(uuid,uuid,uuid,uuid,text,text,uuid)','EXECUTE'),'human create');
end$$;
-- Read is scoped by live human membership, user flags, estate and engagement.
select pg_temp.ok(not pg_temp.preview(jsonb_build_object('actor',pg_temp.id(3)))?'error','viewer preview');
select pg_temp.ok(pg_temp.bind(jsonb_build_object('actor',pg_temp.id(3)))->>'error'='forbidden','viewer cannot bind');
select pg_temp.ok(pg_temp.preview(jsonb_build_object('actor',pg_temp.id(6)))->>'error'='forbidden','absent member');
select pg_temp.ok(pg_temp.preview(jsonb_build_object('check',pg_temp.id(42)))->>'error'='source_refused','foreign check');
select pg_temp.ok(pg_temp.preview(jsonb_build_object('engagement',pg_temp.id(32)))->>'error'='context_refused','foreign context');
-- Existing tenant-safe estate FK also rejects a forged estate association.
do $$begin
begin update public.engagements set estate_id=pg_temp.id(22) where id=pg_temp.id(31);raise exception 'foreign estate accepted';exception when foreign_key_violation or check_violation then null;end;
end$$;
update public.engagements set status='cancelled' where id=pg_temp.id(31);
select pg_temp.ok(pg_temp.preview()->>'error'='context_refused','cancelled context');
update public.engagements set status='intake' where id=pg_temp.id(31);
delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(2);
select pg_temp.ok(pg_temp.bind(jsonb_build_object('actor',pg_temp.id(2)))->>'error'='forbidden','revoked membership');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(2),'admin');
do $$declare a integer;begin foreach a in array array[7,8] loop
perform pg_temp.ok(pg_temp.preview(jsonb_build_object('actor',pg_temp.id(a)))->>'error'='forbidden','false internal read');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('actor',pg_temp.id(a)))->>'error'='forbidden','false internal create');end loop;
foreach a in array array[4,5] loop
perform pg_temp.ok(not pg_temp.preview(jsonb_build_object('actor',pg_temp.id(a)))?'error','internal read');
update public.users set is_axiom_internal=false where id=pg_temp.id(a);
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('actor',pg_temp.id(a)))->>'error'='forbidden','revoked flag create');
update public.users set is_axiom_internal=true where id=pg_temp.id(a);end loop;end$$;
-- Root legacy absence, explicit zero, unavailable and truncation remain distinct.
do $$declare v jsonb;begin
v:=pg_temp.preview();perform pg_temp.ok(jsonb_array_length(v->'projection'->'pages')=1 and not v->'projection'->'pages'->0?'form_metadata','legacy is unexamined');
perform pg_temp.ok(v->'runtime_binding'->>'projection_sha256'=encode(sha256(convert_to((v->'projection')::text,'UTF8')),'hex'),'database codec');
perform pg_temp.ok((v->'projection')-array['version','pages']='{}'::jsonb and (v->'projection'->'pages'->0)-array['page','status','content_sha256']='{}'::jsonb,'no URLs HTML titles headings');
end$$;
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('formMetadata',pg_temp.zero(),'auditPages',jsonb_build_array(jsonb_build_object('kind','contact','status','unavailable','requestedUrl','https://discard.invalid/')))) where id=pg_temp.id(41);
select pg_temp.ok(pg_temp.preview()->'projection'->'pages'->0->'form_metadata'->>'observedFormCount'='0','zero explicitly observed');
select pg_temp.ok(pg_temp.preview()->'projection'->'pages'->1='{"page":"contact","status":"unavailable"}'::jsonb,'unavailable no invented digest or zero');
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('formMetadata',pg_temp.metadata())) where id=pg_temp.id(41);
select pg_temp.ok(not pg_temp.preview()?'error','bounded eligible metadata accepted');
-- Poisoned retained metadata is refused, including private fields and page SHA.
do $$declare bad jsonb;n bigint;begin
select count(*) into n from public.audit_ledger;
for bad in select value from jsonb_array_elements(jsonb_build_array(
'null'::jsonb,'[]'::jsonb,pg_temp.zero()||'{"value":"secret"}',pg_temp.zero(repeat('b',64)),pg_temp.zero()||'{"version":2}',pg_temp.zero()||'{"formsTruncated":"false"}',pg_temp.zero()||'{"observedFormCount":-1}',pg_temp.zero()||'{"observedFormCount":524289}',pg_temp.zero()||'{"observedFormCount":0.5}',pg_temp.zero()||'{"scope":"other"}',pg_temp.zero()||'{"forms":{}}',
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form('{"name":"private"}')))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form('{"ordinal":2}')))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form('{"excludedControlCount":3}')))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form('{"controlsTruncated":true}')))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form('{"method":"put"}')))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control('{"value":"PII"}'))))))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control('{"ordinal":0}'))))))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control('{"ordinal":3}'))))))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control('{"requiredAttribute":"false"}'))))))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control('{"inputType":"password"}'))))))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control()-'inputType')))))),
pg_temp.metadata(jsonb_build_object('forms',jsonb_build_array(pg_temp.form(jsonb_build_object('controls',jsonb_build_array(pg_temp.control('{"element":"select"}')))))))
)) loop
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('formMetadata',bad)) where id=pg_temp.id(41);
perform pg_temp.ok(pg_temp.preview()->>'error'='source_refused','strict metadata poison refused '||bad::text);
perform pg_temp.ok(pg_temp.bind()->>'error'='source_refused','poison cannot bind');end loop;
for bad in select value from jsonb_array_elements(jsonb_build_array(
'null'::jsonb,'{}'::jsonb,'[{}]'::jsonb,
jsonb_build_array(jsonb_build_object('kind','contact','status','checked')),
jsonb_build_array(jsonb_build_object('kind','contact','status','checked','contentSha256',repeat('b',64),'formMetadata',pg_temp.zero())),
jsonb_build_array(jsonb_build_object('kind','root','status','checked','contentSha256',repeat('b',64))),
jsonb_build_array(jsonb_build_object('kind','contact','status','unavailable','formMetadata',null)),
jsonb_build_array(jsonb_build_object('kind','contact','status','unavailable','contentSha256',repeat('b',64))),
jsonb_build_array(jsonb_build_object('kind','contact','status','unavailable'),jsonb_build_object('kind','contact','status','unavailable')),
jsonb_build_array(jsonb_build_object('kind','contact','status','unavailable'),jsonb_build_object('kind','privacy','status','unavailable'),jsonb_build_object('kind','terms','status','unavailable'),jsonb_build_object('kind','contact','status','unavailable'))
)) loop
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('auditPages',bad)) where id=pg_temp.id(41);
perform pg_temp.ok(pg_temp.preview()->>'error'='source_refused','child poison refused');end loop;
perform pg_temp.ok((select count(*)=n from public.audit_ledger),'preview/refused writes have no ledger');end$$;
-- Numeric JSON integer equivalents match the shared schema; SHA must be string.
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('formMetadata',pg_temp.zero()||'{"observedFormCount":0.0}')) where id=pg_temp.id(41);
select pg_temp.ok(not pg_temp.preview()?'error','numeric integer equivalent accepted');
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('contentSha256',to_jsonb(repeat('1',64)::numeric))) where id=pg_temp.id(41);
select pg_temp.ok(pg_temp.preview()->>'error'='source_refused','numeric digest refused');
-- Full bounded truncation and known select/textarea without inputType.
do $$declare controls jsonb;form jsonb;forms jsonb;begin
select jsonb_agg(pg_temp.control(jsonb_build_object('ordinal',n)) order by n) into controls from generate_series(1,12)n;
form:=pg_temp.form(jsonb_build_object('observedControlCount',20,'excludedControlCount',1,'controlsTruncated',true,'controls',controls));
forms:=jsonb_build_array(form,form||'{"ordinal":2}',form||'{"ordinal":3}');
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('formMetadata',pg_temp.metadata(jsonb_build_object('observedFormCount',4,'formsTruncated',true,'forms',forms)))) where id=pg_temp.id(41);
perform pg_temp.ok(not pg_temp.preview()?'error','both truncation caps accepted');
form:=pg_temp.form(jsonb_build_object('controls',jsonb_build_array((pg_temp.control()-'inputType')||'{"element":"textarea"}')));
update public.public_website_checks set result=pg_temp.result(jsonb_build_object('auditPages',jsonb_build_array(jsonb_build_object('kind','contact','status','checked','contentSha256',repeat('b',64),'formMetadata',pg_temp.metadata(jsonb_build_object('sourceSha256',repeat('b',64),'forms',jsonb_build_array(form))))))) where id=pg_temp.id(41);
perform pg_temp.ok(not pg_temp.preview()?'error','own child digest accepted, textarea valid');end$$;
-- Stale expectation, immutable identity, exact replay and actor/correlation conflicts.
do $$declare a jsonb;b jsonb;v jsonb;receipt bigint;begin
v:=pg_temp.preview();
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('root',repeat('f',64)))->>'error'='stale_source','expected root enforced');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('projection',repeat('f',64)))->>'error'='stale_source','expected projection enforced');
a:=pg_temp.bind();b:=pg_temp.bind();receipt:=(a->>'creation_receipt')::bigint;
perform pg_temp.ok(a->>'created'='true' and b->>'replayed'='true' and a->>'binding_id'=b->>'binding_id' and a->>'creation_receipt'=b->>'creation_receipt','exact replay');
perform pg_temp.ok(pg_temp.preview(jsonb_build_object('actor',pg_temp.id(3)))->>'binding_id'=a->>'binding_id','viewer reload sees existing ID');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('actor',pg_temp.id(2)))->>'error'='binding_conflict','actor replay change');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('engagement',pg_temp.id(33)))->>'error'='binding_conflict','correlation context change');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('correlation',pg_temp.id(102)))->>'error'='binding_conflict','snapshot new correlation refused');
perform pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='public_source.bound'),'one receipt');
perform pg_temp.ok((select actor_type='human' and actor_id=pg_temp.id(1)::text and target_ref=a->>'binding_id' and input_hash=v->'runtime_binding'->>'root_content_sha256' and output_hash=v->'runtime_binding'->>'projection_sha256' from public.audit_ledger where id=receipt),'human receipt source-bound');
begin update public.public_source_bindings set root_content_sha256=repeat('f',64) where id=(a->>'binding_id')::uuid;raise exception 'update succeeded';exception when insufficient_privilege then perform pg_temp.ok(sqlerrm='evidence_receipt_immutable','update immutable trigger');end;
begin delete from public.public_source_bindings where id=(a->>'binding_id')::uuid;raise exception 'delete succeeded';exception when insufficient_privilege then perform pg_temp.ok(sqlerrm='evidence_receipt_immutable','delete immutable trigger');end;
perform pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.id(11))),'ledger chain intact');
end$$;
-- Actual service role sees immutable records under RLS but cannot mutate them.
do $$declare prior text:=current_user;n integer;begin
set local role service_role;
select count(*) into n from public.public_source_bindings where tenant_id=pg_temp.id(11);
perform pg_temp.ok(n=1,'service SELECT through enabled RLS');
begin update public.public_source_bindings set actor_id=pg_temp.id(2);raise exception 'service update accepted';exception when insufficient_privilege then null;end;
begin delete from public.public_source_bindings;raise exception 'service delete accepted';exception when insufficient_privilege then null;end;
execute format('set local role %I',prior);end$$;
-- Producer-role spoof cannot forge the recorded human snapshot action.
do $$declare prior text:=current_user;begin
set local role agent_ledger_writer;
begin perform public.append_agent_ledger(pg_temp.id(11),gen_random_uuid(),'system','fake',null,null,null,'public_source.bound',null,null,null,null,null,null,null,'success','{}');raise exception 'producer forged action';exception when insufficient_privilege then null;end;
execute format('set local role %I',prior);end$$;
-- Missing estate is an observed intake context, never inferred or assigned.
do $$declare v jsonb;a jsonb;b jsonb;r public.public_source_bindings;begin
v:=pg_temp.preview(jsonb_build_object('engagement',pg_temp.id(34)));
perform pg_temp.ok(not v?'error' and not(v->'runtime_binding')?'estate_id','null estate preview without invented estate');
perform pg_temp.ok(pg_temp.preview(jsonb_build_object('engagement',pg_temp.id(35)))->>'error'='context_refused','foreign null estate context refused');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('engagement',pg_temp.id(35),'correlation',pg_temp.id(105)))->>'error'='context_refused','foreign null estate creation refused');
a:=pg_temp.bind(jsonb_build_object('engagement',pg_temp.id(34),'correlation',pg_temp.id(104)));
b:=pg_temp.bind(jsonb_build_object('engagement',pg_temp.id(34),'correlation',pg_temp.id(104)));
perform pg_temp.ok(a->>'created'='true' and b->>'replayed'='true' and a->>'creation_receipt'=b->>'creation_receipt','null estate creation and exact replay');
select * into strict r from public.public_source_bindings where id=(a->>'binding_id')::uuid;
perform pg_temp.ok(r.estate_id is null and (select estate_id is null from public.engagements where id=pg_temp.id(34)),'no estate assignment or forged verification');
-- A nullable triple FK must never replace independent tenant+engagement safety.
begin
insert into public.public_source_bindings(id,tenant_id,engagement_id,estate_id,check_id,projection_version,root_content_sha256,projection,projection_sha256,actor_id,correlation_id,creation_receipt)
values(pg_temp.id(201),r.tenant_id,pg_temp.id(35),null,r.check_id,r.projection_version,r.root_content_sha256,r.projection,r.projection_sha256,r.actor_id,pg_temp.id(205),r.creation_receipt);
raise exception 'ASSERTION: independent tenant engagement FK missing';
exception when foreign_key_violation then null;end;
begin update public.public_source_bindings set estate_id=pg_temp.id(21) where id=r.id;raise exception 'snapshot estate rewritten';exception when insufficient_privilege then perform pg_temp.ok(sqlerrm='evidence_receipt_immutable','null estate snapshot immutable');end;
-- Later explicit same-tenant assignment cannot rewrite historical absence.
update public.engagements set estate_id=pg_temp.id(21) where id=pg_temp.id(34);
perform pg_temp.ok(pg_temp.preview(jsonb_build_object('engagement',pg_temp.id(34)))->>'binding_id'=r.id::text and (select estate_id is null from public.public_source_bindings where id=r.id),'historical null estate preserved');
perform pg_temp.ok(pg_temp.bind(jsonb_build_object('engagement',pg_temp.id(34),'correlation',pg_temp.id(104)))->>'replayed'='true','historical null estate replay remains exact');
perform pg_temp.ok((select count(*)=2 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='public_source.bound'),'null estate has one human creation receipt');
end$$;
-- Ledger failure cannot leave an unreceipted snapshot.
create function pg_temp.block_audit() returns trigger language plpgsql as $$begin if new.action_type::text='public_source.bound' then raise exception 'deliberate source audit failure';end if;return new;end$$;
create trigger source_test_failure before insert on public.audit_ledger for each row execute function pg_temp.block_audit();
do $$declare n bigint;begin
select count(*) into n from public.public_source_bindings;
begin perform pg_temp.bind(jsonb_build_object('engagement',pg_temp.id(33),'correlation',pg_temp.id(103)));raise exception 'expected audit failure';exception when others then if sqlerrm<>'deliberate source audit failure' then raise;end if;end;
perform pg_temp.ok((select count(*)=n from public.public_source_bindings),'ledger failure atomic');end$$;
rollback;
