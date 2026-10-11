-- Real PostgreSQL source-bound authority, commitment and reload assertions.
-- Synthetic producer receipts deliberately exercise UTF8 commitment separately
-- from PostgreSQL projection codec; no actual runtime work is claimed here.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99100600-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'source-observation-'||n||'@example.invalid' from generate_series(1,6)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'source-observation-'||n||'@example.invalid',n=4 from generate_series(1,6)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'source-observation-a','A'),(pg_temp.id(12),'source-observation-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'admin'),(pg_temp.id(11),pg_temp.id(3),'viewer'),(pg_temp.id(11),pg_temp.id(4),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(5),'axiom_analyst'),(pg_temp.id(12),pg_temp.id(1),'owner');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'source-observation-a','A'),(pg_temp.id(22),pg_temp.id(12),'source-observation-b','B');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('source-observation-test',now(),'test','Synthetic fixture',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(31),pg_temp.id(11),null,'source-observation-test','Unassigned A'),(pg_temp.id(32),pg_temp.id(12),null,'source-observation-test','Unassigned B'),(pg_temp.id(33),pg_temp.id(11),pg_temp.id(21),'source-observation-test','Assigned A');
create function pg_temp.metadata() returns jsonb language sql as $$select jsonb_build_object('version',1,'scope','static_html_form_descendants','sourceSha256',repeat('b',64),'observedFormCount',1,'formsTruncated',false,'forms',jsonb_build_array(jsonb_build_object('ordinal',1,'method','post','observedControlCount',3,'excludedControlCount',0,'controlsTruncated',false,'controls',jsonb_build_array('{"ordinal":1,"element":"input","inputType":"email","requiredAttribute":true,"disabledAttribute":false}'::jsonb,'{"ordinal":2,"element":"input","inputType":"text","requiredAttribute":false,"disabledAttribute":false}'::jsonb,'{"ordinal":3,"element":"input","inputType":"tel","requiredAttribute":false,"disabledAttribute":true}'::jsonb))))$$;
insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,final_url,status,result) values(pg_temp.id(41),pg_temp.id(11),pg_temp.id(1),pg_temp.id(141),'https://example.invalid/','https://example.invalid/','checked',jsonb_build_object('requestedUrl','https://example.invalid/','finalUrl','https://example.invalid/','checkedAt',now(),'status','checked','httpStatus',200,'bytes',3,'contentSha256',repeat('a',64),'title','Never a private fact','headings','[]'::jsonb,'publicLinks','[]'::jsonb,'auditPages',jsonb_build_array(jsonb_build_object('kind','contact','status','checked','contentSha256',repeat('b',64),'formMetadata',pg_temp.metadata()),jsonb_build_object('kind','privacy','status','unavailable'))));
create function pg_temp.bind() returns uuid language plpgsql as $$declare v jsonb;r jsonb;prior text:=current_user;begin set local role human_action_writer;v:=public.get_public_source_projection(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(41));r:=public.record_public_source_binding(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(41),v->'runtime_binding'->>'root_content_sha256',v->'runtime_binding'->>'projection_sha256',pg_temp.id(101));execute format('set local role %I',prior);return (r->>'binding_id')::uuid;exception when others then execute format('set local role %I',prior);raise;end$$;
create temporary table source_fixture(k text primary key,v jsonb);
grant select on source_fixture to human_action_writer,agent_ledger_writer,service_role;
insert into source_fixture values('binding',to_jsonb(pg_temp.bind()));
create function pg_temp.binding() returns uuid language sql as $$select (v#>>'{}')::uuid from source_fixture where k='binding'$$;
create function pg_temp.load(o jsonb default '{}') returns jsonb language plpgsql as $$declare r jsonb;prior text:=current_user;begin set local role human_action_writer;r:=public.get_public_source_agent_input(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),coalesce((o->>'binding')::uuid,pg_temp.binding()),coalesce(o->>'agent','drishti'),(o->>'observation')::uuid);execute format('set local role %I',prior);return r;exception when others then execute format('set local role %I',prior);raise;end$$;

create function pg_temp.start(o jsonb default '{}') returns uuid language plpgsql as $$declare r jsonb;v jsonb;prior text:=current_user;begin v:=pg_temp.load(o);set local role human_action_writer;r:=public.record_generic_agent_run_start(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),coalesce(o->>'agent','drishti'),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),coalesce((o->>'correlation')::uuid,gen_random_uuid()),coalesce(o->>'hash',encode(sha256(convert_to((v->'input')::text,'UTF8')),'hex')));execute format('set local role %I',prior);return (r->>'run_id')::uuid;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.dispatch(rid uuid,o jsonb default '{}') returns jsonb language plpgsql as $$declare r jsonb;v jsonb;prior text:=current_user;begin v:=pg_temp.load(o);set local role human_action_writer;r:=public.record_public_source_dispatch(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),coalesce((o->>'binding')::uuid,pg_temp.binding()),coalesce(o->>'agent','drishti'),(o->>'observation')::uuid,rid,coalesce(o->'input',v->'input'),coalesce(o->>'bytes',(v->'input')::text));execute format('set local role %I',prior);return r;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.runtime(rid uuid,o jsonb default '{}') returns jsonb language plpgsql as $$declare r jsonb;c uuid;prior text:=current_user;begin select correlation_id into c from public.agent_runs where id=rid;set local role agent_ledger_writer;r:=public.get_public_source_dispatch_input(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),rid,coalesce(o->>'agent','drishti'),coalesce((o->>'correlation')::uuid,c));execute format('set local role %I',prior);return r;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.claim(rid uuid,o jsonb default '{}') returns jsonb language plpgsql as $$declare r jsonb;d public.public_source_dispatches;c uuid;prior text:=current_user;begin select * into d from public.public_source_dispatches where run_id=rid;select correlation_id into c from public.agent_runs where id=rid;set local role agent_ledger_writer;r:=public.claim_public_source_dispatch(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),rid,coalesce(o->>'agent',d.agent),coalesce((o->>'correlation')::uuid,c),coalesce((o->>'dispatch')::uuid,d.id),coalesce(o->>'hash',d.request_hash));execute format('set local role %I',prior);return r;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.expected(input jsonb,agent text) returns jsonb language plpgsql as $$declare source jsonb;begin
if agent='drishti' then source:=input->'source';return jsonb_build_object('mode','public_website','observation',jsonb_build_object('version',1,'binding',source->'binding','pages',jsonb_build_array(source->'pages'->0||'{"form_state":"unexamined"}',source->'pages'->1||'{"form_state":"observed"}',source->'pages'->2||'{"form_state":"unavailable"}'),'private_facts','{"hosting_region":"unknown","backend_personal_data":"unknown","cross_border_processing":"unknown"}'::jsonb,'requires_human_review',true));end if;
return jsonb_build_object('mode','public_website','source_binding',input->'source_binding','private_facts','{"hosting_region":"unknown","backend_personal_data":"unknown","cross_border_processing":"unknown"}'::jsonb,'scope_limited',true,'unexamined_pages','["root"]'::jsonb,'unavailable_pages','["privacy"]'::jsonb,'indicators',jsonb_build_array(jsonb_build_object('page','contact','content_sha256',repeat('b',64),'form_ordinal',1,'control_ordinal',1,'input_type','email','indicator','potential_contact_collection','requires_human_review',true),jsonb_build_object('page','contact','content_sha256',repeat('b',64),'form_ordinal',1,'control_ordinal',3,'input_type','tel','indicator','potential_contact_collection','requires_human_review',true)));
end$$;
create function pg_temp.complete(rid uuid,output jsonb,bytes text default null,o jsonb default '{}') returns jsonb language plpgsql as $$declare r public.agent_runs;sid bigint;eid bigint;result jsonb;prior text:=current_user;action public.ledger_action_type;digest text;begin select * into strict r from public.agent_runs where id=rid;action:=(case r.agent when 'drishti' then 'discovery.started' else 'classification.started' end)::public.ledger_action_type;digest:=encode(sha256(convert_to(coalesce(bytes,output::text),'UTF8')),'hex');set local role agent_ledger_writer;
sid:=public.append_agent_ledger(r.tenant_id,r.correlation_id,'agent',r.agent,'1.0.0',null,null,action,r.engagement_id::text,r.input_redacted_hash,null,null,null,null,null,'pending',jsonb_build_object('phase','started','run_id',r.id,'request_hash',r.input_redacted_hash));
eid:=public.append_agent_ledger(r.tenant_id,r.correlation_id,'agent',r.agent,'1.0.0',null,null,action,r.engagement_id::text,r.input_redacted_hash,digest,null,null,null,null,'success',jsonb_build_object('phase','completed','run_id',r.id,'request_hash',r.input_redacted_hash,'started_entry',sid::text));
set local role human_action_writer;result:=public.record_generic_agent_run_finish(r.tenant_id,pg_temp.id(1),r.id,r.agent,r.engagement_id,r.correlation_id,r.input_redacted_hash,'succeeded',null,1,0,0,0,sid::text,eid::text,coalesce(o->>'response_hash',digest));execute format('set local role %I',prior);return result;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.observe(rid uuid,output jsonb,bytes text default null,o jsonb default '{}') returns jsonb language plpgsql as $$declare r jsonb;prior text:=current_user;begin set local role human_action_writer;r:=public.record_public_source_observation(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),rid,output,coalesce(bytes,output::text));execute format('set local role %I',prior);return r;exception when others then execute format('set local role %I',prior);raise;end$$;
create function pg_temp.read(oid uuid,o jsonb default '{}') returns jsonb language plpgsql as $$declare r jsonb;prior text:=current_user;begin set local role service_role;r:=public.get_public_source_observation(coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(3)),coalesce((o->>'engagement')::uuid,pg_temp.id(31)),oid);execute format('set local role %I',prior);return r;exception when others then execute format('set local role %I',prior);raise;end$$;
-- Every role must be unable to bypass narrow RPCs or immutable tables.
do $$declare role_name text;signature text;t text;begin
foreach t in array array['public.public_source_dispatches','public.public_source_observations','public.public_source_dispatch_claims'] loop
foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','evidence_ingestion_writer'] loop
perform pg_temp.ok(not has_table_privilege(role_name,t,'INSERT') and not has_table_privilege(role_name,t,'UPDATE') and not has_table_privilege(role_name,t,'DELETE'),'no broad DML '||t||role_name);end loop;
perform pg_temp.ok((select relrowsecurity from pg_class where oid=t::regclass),'RLS '||t);end loop;
for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('public_source_context_authorized','public_source_agent_input','public_source_running_request','public_source_expected_output') loop
foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'private helper '||signature||role_name);end loop;end loop;
foreach role_name in array array['anon','authenticated','service_role','human_action_writer'] loop
perform pg_temp.ok(not has_function_privilege(role_name,'public.get_public_source_dispatch_input(uuid,uuid,text,uuid)','EXECUTE'),'runtime-only loader '||role_name);end loop;
perform pg_temp.ok(has_function_privilege('agent_ledger_writer','public.get_public_source_dispatch_input(uuid,uuid,text,uuid)','EXECUTE'),'runtime loader allowed');
foreach role_name in array array['anon','authenticated','service_role','human_action_writer'] loop perform pg_temp.ok(not has_function_privilege(role_name,'public.claim_public_source_dispatch(uuid,uuid,text,uuid,uuid,text)','EXECUTE'),'claim credential isolated '||role_name);end loop;
perform pg_temp.ok(has_function_privilege('agent_ledger_writer','public.claim_public_source_dispatch(uuid,uuid,text,uuid,uuid,text)','EXECUTE'),'claim writer allowed');
for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('get_public_source_agent_input','record_public_source_dispatch','record_public_source_observation') loop
perform pg_temp.ok(has_function_privilege('human_action_writer',signature,'EXECUTE'),'human RPC allowed');
foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer'] loop
perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'human-only RPC '||signature||role_name);end loop;end loop;
end$$;
select pg_temp.ok(pg_temp.load()->'input'->>'mode'='public_website','stored source input');
select pg_temp.ok(not pg_temp.load()?'observation_id','Drishti no invented observation');
select pg_temp.ok(pg_temp.load(jsonb_build_object('actor',pg_temp.id(3)))->>'error'='forbidden','viewer cannot prepare');
select pg_temp.ok(pg_temp.load(jsonb_build_object('actor',pg_temp.id(5)))->>'error'='forbidden','false internal denied');
select pg_temp.ok(pg_temp.load(jsonb_build_object('tenant',pg_temp.id(12)))->>'error'='context_refused','foreign tenant context denied');
select pg_temp.ok(pg_temp.load(jsonb_build_object('engagement',pg_temp.id(32)))->>'error'='context_refused','foreign NULL-estate context denied');
select pg_temp.ok(pg_temp.load(jsonb_build_object('binding',pg_temp.id(999)))->>'error'='source_refused','unknown binding');
select pg_temp.ok(pg_temp.load('{"agent":"karya"}')->>'error'='invalid_record','Karya no public bypass');
select pg_temp.ok(pg_temp.load('{"agent":"prativedan"}')->>'error'='invalid_record','report no public bypass');
select pg_temp.ok(pg_temp.load('{"agent":"vibhaag"}')->>'error'='invalid_record','Vibhaag needs persisted observation');
select pg_temp.ok(pg_temp.load(jsonb_build_object('agent','vibhaag','observation',pg_temp.id(999)))->>'error'='observation_refused','Vibhaag arbitrary observation denied');
-- A second immutable source in the same engagement cannot consume the first
-- source's discovery observation, even though its tenant/context are valid.
insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,final_url,status,result)
select pg_temp.id(43),tenant_id,actor_id,pg_temp.id(143),requested_url,final_url,status,jsonb_set(result,'{contentSha256}',to_jsonb(repeat('c',64))) from public.public_website_checks where id=pg_temp.id(41);
do $$declare preview jsonb;r jsonb;prior text:=current_user;begin set local role human_action_writer;preview:=public.get_public_source_projection(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(43));r:=public.record_public_source_binding(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(43),preview->'runtime_binding'->>'root_content_sha256',preview->'runtime_binding'->>'projection_sha256',pg_temp.id(103));execute format('set local role %I',prior);insert into source_fixture values('other_binding',r->'binding_id');end$$;
-- A generic running row alone never grants public source transport.
insert into source_fixture values('run',to_jsonb(pg_temp.start()));
create function pg_temp.run() returns uuid language sql as $$select (v#>>'{}')::uuid from source_fixture where k='run'$$;
select pg_temp.ok(pg_temp.runtime(pg_temp.run())->>'error'='dispatch_refused','unlinked generic row denied');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),'{"bytes":"{"}')->>'error'='invalid_record','malformed input bytes safely refused');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),jsonb_build_object('bytes',repeat(' ',131073)))->>'error'='invalid_record','oversize input safely refused');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),'{"bytes":"null"}')->>'error'='input_refused','null input bytes safely refused');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),jsonb_build_object('input',(pg_temp.load()->'input')||'{"hints":{"region":"Mumbai"}}','bytes',((pg_temp.load()->'input')||'{"hints":{"region":"Mumbai"}}')::text))->>'error'='input_refused','caller hints refused');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),jsonb_build_object('actor',pg_temp.id(2)))->>'error'='run_context_conflict','another operator cannot claim run');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),jsonb_build_object('bytes',E'\n'||(pg_temp.load()->'input')::text))->>'error'='run_context_conflict','different exact bytes hash denied');
insert into source_fixture values('dispatch',pg_temp.dispatch(pg_temp.run()));
select pg_temp.ok((select v->'created'='true'::jsonb and v->'replayed'='false'::jsonb from source_fixture where k='dispatch'),'created flags actual booleans');
select pg_temp.ok(pg_temp.dispatch(pg_temp.run())->'replayed'='true'::jsonb,'exact running dispatch replay');
select pg_temp.ok(pg_temp.runtime(pg_temp.run())->'input'=pg_temp.load()->'input','runtime loads same stored facts');
select pg_temp.ok(pg_temp.runtime(pg_temp.run(),jsonb_build_object('correlation',pg_temp.id(999)))->>'error'='run_context_conflict','wrong runtime correlation denied');
select pg_temp.ok(pg_temp.runtime(pg_temp.run(),'{"agent":"vibhaag"}')->>'error'='dispatch_refused','wrong runtime agent denied');
select pg_temp.ok(pg_temp.runtime(pg_temp.run(),jsonb_build_object('tenant',pg_temp.id(12)))->>'error'='dispatch_refused','foreign runtime tenant denied');
-- Authority is checked again immediately before transport.
update public.users set is_axiom_internal=false where id=pg_temp.id(4);
select pg_temp.ok(pg_temp.load(jsonb_build_object('actor',pg_temp.id(4)))->>'error'='forbidden','revoked internal flag denied');
update public.users set is_axiom_internal=true where id=pg_temp.id(4);
update public.tenant_users set role='viewer' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
select pg_temp.ok(pg_temp.runtime(pg_temp.run())->>'error'='forbidden','revoked operator before transport');
update public.tenant_users set role='owner' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
update public.engagements set status='cancelled' where id=pg_temp.id(31);
select pg_temp.ok(pg_temp.runtime(pg_temp.run())->>'error'='context_refused','cancelled context before transport');
update public.engagements set status='intake',estate_id=pg_temp.id(21) where id=pg_temp.id(31);
select pg_temp.ok(not pg_temp.runtime(pg_temp.run())?'error','explicit current estate validated');
select pg_temp.ok((select estate_id is null from public.public_source_bindings where id=pg_temp.binding()),'captured NULL estate never rewritten');
select pg_temp.ok(pg_temp.claim(pg_temp.run(),jsonb_build_object('dispatch',pg_temp.id(999)))->>'error'='dispatch_refused','wrong claim dispatch refused');
select pg_temp.ok(pg_temp.claim(pg_temp.run(),jsonb_build_object('hash',repeat('f',64)))->>'error'='input_refused','wrong claim commitment refused');
select pg_temp.ok(pg_temp.claim(pg_temp.run())->'claimed'='true'::jsonb,'first once-only claim');
select pg_temp.ok(pg_temp.claim(pg_temp.run())->'claimed'='false'::jsonb,'second claim denied under unknown outcome');
insert into source_fixture values('output',pg_temp.expected(pg_temp.load()->'input','drishti'));
create function pg_temp.output() returns jsonb language sql as $$select v from source_fixture where k='output'$$;
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output())->>'error'='completion_unconfirmed','running output not confirmed');
select pg_temp.ok(pg_temp.complete(pg_temp.run(),pg_temp.output(),E'\n'||pg_temp.output()::text)->>'status'='succeeded','actual pair confirms generic settlement');
select pg_temp.ok(pg_temp.runtime(pg_temp.run())->>'error'='run_context_conflict','terminal run cannot transport again');
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output())->>'error'='completion_unconfirmed','JSONB text is not runtime bytes commitment');
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output(),'{')->>'error'='invalid_record','malformed output safely refused');
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output(),'null')->>'error'='output_refused','null output safely refused');
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output(),E'\n'||pg_temp.output()::text,jsonb_build_object('actor',pg_temp.id(2)))->>'error'='run_context_conflict','wrong observation actor');
insert into source_fixture values('observation',pg_temp.observe(pg_temp.run(),pg_temp.output(),E'\n'||pg_temp.output()::text));
create function pg_temp.observation() returns uuid language sql as $$select (v->>'observation_id')::uuid from source_fixture where k='observation'$$;
select pg_temp.ok((select v->'created'='true'::jsonb and v->'replayed'='false'::jsonb from source_fixture where k='observation'),'observation created flags');
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output(),E'\n'||pg_temp.output()::text)->'replayed'='true'::jsonb,'exact observation replay no duplicate');
select pg_temp.ok(pg_temp.read(pg_temp.observation())->'output'=pg_temp.output(),'viewer reload persisted confirmed output');
select pg_temp.ok(pg_temp.read(pg_temp.observation(),jsonb_build_object('engagement',pg_temp.id(33)))->>'error'='observation_refused','wrong read context');
select pg_temp.ok(pg_temp.read(pg_temp.observation(),jsonb_build_object('tenant',pg_temp.id(12),'engagement',pg_temp.id(32),'actor',pg_temp.id(1)))->>'error'='observation_refused','foreign tenant read');
select pg_temp.ok(pg_temp.load(jsonb_build_object('agent','vibhaag','observation',pg_temp.observation(),'binding',(select v#>>'{}' from source_fixture where k='other_binding')))->>'error'='observation_refused','discovery cannot cross immutable source bindings');
-- Vibhaag can derive only the persisted Drishti observation from this source.
insert into source_fixture values('vibhaag_input',pg_temp.load(jsonb_build_object('agent','vibhaag','observation',pg_temp.observation()))->'input');
select pg_temp.ok((select v->'observation'=pg_temp.output()->'observation' from source_fixture where k='vibhaag_input'),'Vibhaag exact persisted discovery');
do $$declare rid uuid;input jsonb;output jsonb;r jsonb;begin
input:=(select v from source_fixture where k='vibhaag_input');rid:=pg_temp.start(jsonb_build_object('agent','vibhaag','observation',pg_temp.observation()));
r:=pg_temp.dispatch(rid,jsonb_build_object('agent','vibhaag','observation',pg_temp.observation()));perform pg_temp.ok(r->'created'='true'::jsonb,'Vibhaag dispatch');
perform pg_temp.ok(pg_temp.runtime(rid,'{"agent":"vibhaag"}')->'input'=input,'Vibhaag runtime input');perform pg_temp.ok(pg_temp.claim(rid)->'claimed'='true'::jsonb,'Vibhaag once-only claim');output:=pg_temp.expected(input,'vibhaag');
perform pg_temp.ok(pg_temp.complete(rid,output)->>'status'='succeeded','Vibhaag confirmed');r:=pg_temp.observe(rid,output);perform pg_temp.ok(r->'created'='true'::jsonb,'Vibhaag persisted');
perform pg_temp.ok(pg_temp.read((r->>'observation_id')::uuid)->'output'->'indicators'=output->'indicators','Vibhaag reload safe potential indicators');
perform pg_temp.ok(pg_temp.load(jsonb_build_object('agent','vibhaag','observation',r->>'observation_id'))->>'error'='observation_refused','classification cannot replace discovery');
end$$;
-- A real receipt commitment to poisoned output still cannot persist false facts.
do $$declare bad jsonb;rid uuid;r jsonb;begin
for bad in select value from jsonb_array_elements(jsonb_build_array(
jsonb_set(pg_temp.output(),'{observation,private_facts,hosting_region}','"Mumbai"'),
jsonb_set(pg_temp.output(),'{observation,requires_human_review}','false'),
jsonb_set(pg_temp.output(),'{observation,pages,0,content_sha256}',to_jsonb(repeat('f',64))),
jsonb_set(pg_temp.output(),'{observation,binding,engagement_id}',to_jsonb(pg_temp.id(33)::text)),
pg_temp.output()||'{"raw_html":"secret"}'::jsonb,
jsonb_set(pg_temp.output(),'{observation,pages,1,form_state}','"unexamined"')
)) loop rid:=pg_temp.start();r:=pg_temp.dispatch(rid);perform pg_temp.ok(r->'created'='true'::jsonb,'poison attempt real source dispatch');r:=pg_temp.claim(rid);perform pg_temp.ok(r->'claimed'='true'::jsonb,'poison attempt real claim');r:=pg_temp.complete(rid,bad);perform pg_temp.ok(r->>'status'='succeeded','poison has actual matching receipts');perform pg_temp.ok(pg_temp.observe(rid,bad)->>'error'='output_refused','false public facts refused despite committed bytes');end loop;
end$$;
-- Even valid completion receipts cannot persist an unclaimed dispatch.
do $$declare rid uuid;r jsonb;begin rid:=pg_temp.start();r:=pg_temp.dispatch(rid);r:=pg_temp.complete(rid,pg_temp.output());perform pg_temp.ok(pg_temp.observe(rid,pg_temp.output())->>'error'='dispatch_unclaimed','unclaimed output never persisted');end$$;
-- Classification cannot invent or suppress locators or private facts.
do $$declare bad jsonb;input jsonb;output jsonb;rid uuid;r jsonb;begin
input:=(select v from source_fixture where k='vibhaag_input');output:=pg_temp.expected(input,'vibhaag');
for bad in select value from jsonb_array_elements(jsonb_build_array(
jsonb_set(output,'{private_facts,backend_personal_data}','false'),jsonb_set(output,'{scope_limited}','false'),
jsonb_set(output,'{indicators,0,content_sha256}',to_jsonb(repeat('f',64))),jsonb_set(output,'{indicators,0,control_ordinal}','2'),
jsonb_set(output,'{indicators,0,indicator}','"confirmed_collection"'),jsonb_set(output,'{indicators}','[]'),
jsonb_set(output,'{unexamined_pages}','[]'),output||'{"confidence":0.99}'
)) loop rid:=pg_temp.start(jsonb_build_object('agent','vibhaag','observation',pg_temp.observation()));r:=pg_temp.dispatch(rid,jsonb_build_object('agent','vibhaag','observation',pg_temp.observation()));r:=pg_temp.claim(rid);r:=pg_temp.complete(rid,bad);perform pg_temp.ok(pg_temp.observe(rid,bad)->>'error'='output_refused','poison classification committed but not accepted');end loop;
end$$;
-- Fresh running inputs also recheck a creator whose internal flag was revoked.
do $$declare rid uuid;r jsonb;begin rid:=pg_temp.start(jsonb_build_object('actor',pg_temp.id(4)));r:=pg_temp.dispatch(rid,jsonb_build_object('actor',pg_temp.id(4)));update public.users set is_axiom_internal=false where id=pg_temp.id(4);perform pg_temp.ok(pg_temp.runtime(rid)->>'error'='forbidden','runtime rechecks current internal flag');perform pg_temp.ok(pg_temp.claim(rid)->>'error'='forbidden','claim rechecks current internal flag');update public.users set is_axiom_internal=true where id=pg_temp.id(4);end$$;
-- A corrupted runtime request receipt cannot grant transport even when row
-- metadata otherwise looks like an ordinary running lifecycle row.
do $$declare rid uuid;r jsonb;begin rid:=pg_temp.start();r:=pg_temp.dispatch(rid);update public.agent_runs set metadata=jsonb_set(metadata,'{request_receipt}',to_jsonb('999999999'::text)) where id=rid;perform pg_temp.ok(pg_temp.runtime(rid)->>'error'='request_unconfirmed','actual request receipt required');end$$;
-- Response-level commitment mismatch cannot become a confirmed observation.
do $$declare rid uuid;r jsonb;begin rid:=pg_temp.start();r:=pg_temp.dispatch(rid);r:=pg_temp.claim(rid);r:=pg_temp.complete(rid,pg_temp.output(),null,jsonb_build_object('response_hash',repeat('f',64)));perform pg_temp.ok(pg_temp.observe(rid,pg_temp.output())->>'error'='completion_unconfirmed','response output hash mismatch');end$$;
-- NULL/type/invalid Unicode/over-range JSON failures remain controlled RPC data.
do $$declare r jsonb;prior text:=current_user;begin set local role human_action_writer;r:=public.record_public_source_observation(null,null,null,null,null);perform pg_temp.ok(r->>'error'='invalid_record','NULL observation controlled');r:=public.record_public_source_dispatch(null,null,null,null,null,null,null,null,null);perform pg_temp.ok(r->>'error'='invalid_record','NULL dispatch controlled');execute format('set local role %I',prior);end$$;
-- Invalid Unicode and giant JSON exponents return controlled errors.
select pg_temp.ok(pg_temp.dispatch(pg_temp.run(),jsonb_build_object('bytes','{"a":"\u0000"}'))->>'error'='invalid_record','unsupported JSON Unicode safely refused');
select pg_temp.ok(pg_temp.observe(pg_temp.run(),pg_temp.output(),'{"a":1e1000000}')->>'error'='invalid_record','out-of-range JSON number safely refused');
-- A once-only claim cannot be mutated or removed to retry an unknown outcome.
do $$begin
begin update public.public_source_dispatch_claims set request_hash=repeat('f',64) where run_id=pg_temp.run();raise exception 'mutable claim';exception when sqlstate '42501' then null;end;
begin delete from public.public_source_dispatch_claims where run_id=pg_temp.run();raise exception 'deletable claim';exception when sqlstate '42501' then null;end;
end$$;
-- Triggers and composite tenant/context identities remain effective for admin.
do $$declare oid uuid:=pg_temp.observation();d public.public_source_dispatches;begin
begin update public.public_source_observations set output='{}' where id=oid;raise exception 'mutable observation';exception when sqlstate '42501' then null;end;
begin delete from public.public_source_observations where id=oid;raise exception 'deletable observation';exception when sqlstate '42501' then null;end;
begin update public.public_source_dispatches set actor_id=pg_temp.id(2) where run_id=pg_temp.run();raise exception 'mutable dispatch';exception when sqlstate '42501' then null;end;
select * into d from public.public_source_dispatches where run_id=pg_temp.run();
begin insert into public.public_source_dispatches(id,tenant_id,engagement_id,binding_id,agent,run_id,actor_id,request_receipt,request_hash,input,input_utf8) values(gen_random_uuid(),d.tenant_id,pg_temp.id(32),d.binding_id,d.agent,pg_temp.start(),d.actor_id,d.request_receipt,d.request_hash,d.input,d.input_utf8);raise exception 'foreign context via NULL estate';exception when foreign_key_violation then null;end;
end$$;
select pg_temp.ok((select count(*)=2 from public.public_source_observations where tenant_id=pg_temp.id(11)),'only valid Drishti/Vibhaag observations stored');
select pg_temp.ok(not exists(select 1 from public.verify_ledger(pg_temp.id(11))),'append-only chain valid');
rollback;
