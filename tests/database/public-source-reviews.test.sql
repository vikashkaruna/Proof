-- Synthetic stored-source/receipt fixtures; no live website work is claimed.
begin;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$select ('99100900-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
insert into auth.users(id,email) select pg_temp.id(n),'source-review-'||n||'@example.invalid' from generate_series(1,6)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'source-review-'||n||'@example.invalid',n=4 from generate_series(1,6)n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'source-review-a','A'),(pg_temp.id(12),'source-review-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'admin'),(pg_temp.id(11),pg_temp.id(3),'viewer'),(pg_temp.id(11),pg_temp.id(4),'axiom_analyst'),(pg_temp.id(11),pg_temp.id(5),'axiom_analyst'),(pg_temp.id(12),pg_temp.id(1),'owner');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'source-review-a','A'),(pg_temp.id(22),pg_temp.id(12),'source-review-b','B');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('source-review-test',now(),'test','Synthetic fixture',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(31),pg_temp.id(11),null,'source-review-test','Unassigned A'),(pg_temp.id(32),pg_temp.id(12),null,'source-review-test','Unassigned B'),(pg_temp.id(33),pg_temp.id(11),pg_temp.id(21),'source-review-test','Assigned A');
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

-- A reviewer is intentionally not the person who invoked either source agent.
insert into auth.users(id,email) select pg_temp.id(n),'source-review-extra-'||n||'@example.invalid' from generate_series(7,10)n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'source-review-extra-'||n||'@example.invalid',n=9 from generate_series(7,10)n;
insert into public.tenant_users(tenant_id,user_id,role) values
 (pg_temp.id(11),pg_temp.id(7),'reviewer'),(pg_temp.id(11),pg_temp.id(8),'partner'),(pg_temp.id(11),pg_temp.id(10),'agent');
create function pg_temp.make(agent text,source_id uuid default null, binding_id uuid default null) returns uuid language plpgsql as $$
declare opts jsonb;rid uuid;input jsonb;output jsonb;r jsonb;
begin
 opts:=jsonb_build_object('agent',agent,'observation',source_id,'binding',coalesce(binding_id,pg_temp.binding()));
 input:=pg_temp.load(opts)->'input';rid:=pg_temp.start(opts);
 r:=pg_temp.dispatch(rid,opts);perform pg_temp.ok(not r?'error','fixture dispatch');
 r:=pg_temp.claim(rid);perform pg_temp.ok(r->>'claimed'='true','fixture once-only claim');
 output:=public.public_source_expected_output(input,agent);
 r:=pg_temp.complete(rid,output);perform pg_temp.ok(r->>'status'='succeeded','fixture completion');
 r:=pg_temp.observe(rid,output);perform pg_temp.ok(not r?'error','fixture immutable observation');
 return (r->>'observation_id')::uuid;
end $$;
insert into source_fixture values('drishti',to_jsonb(pg_temp.make('drishti')));
insert into source_fixture values('vibhaag',to_jsonb(pg_temp.make('vibhaag',(select (v#>>'{}')::uuid from source_fixture where k='drishti'))));
create function pg_temp.observation(kind text default 'vibhaag') returns uuid language sql as $$
 select (v#>>'{}')::uuid from source_fixture where k=kind;
$$;
create function pg_temp.review(opts jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;o public.public_source_observations;b public.public_source_bindings;fallback_sha text;prior text:=current_user;
begin
 select * into o from public.public_source_observations where id=coalesce((opts->>'observation')::uuid,pg_temp.observation());
 select * into b from public.public_source_bindings where id=coalesce(o.binding_id,pg_temp.binding());
 select output_sha256 into fallback_sha from public.public_source_observations where id=pg_temp.observation();
 set local role human_action_writer;
 r:=public.submit_public_source_review(coalesce((opts->>'tenant')::uuid,pg_temp.id(11)),coalesce((opts->>'actor')::uuid,pg_temp.id(7)),
 coalesce((opts->>'engagement')::uuid,pg_temp.id(31)),coalesce((opts->>'binding')::uuid,o.binding_id,pg_temp.binding()),coalesce((opts->>'observation')::uuid,o.id),
 coalesce(opts->>'output_sha256',o.output_sha256,fallback_sha),coalesce(opts->>'projection_sha256',b.projection_sha256),
 coalesce(opts->>'target_kind','whole_observation'),opts->>'page',(opts->>'form_ordinal')::integer,(opts->>'control_ordinal')::integer,opts->>'content_sha256',
 coalesce(opts->>'decision','acknowledged'),coalesce(opts->>'justification','I reviewed the retained public HTML structure only.'),
 (opts->>'previous')::uuid,coalesce((opts->>'key')::uuid,gen_random_uuid()));
 execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;
end $$;
create function pg_temp.history(opts jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;prior text:=current_user;
begin
 set local role human_action_writer;
 r:=public.list_public_source_reviews(coalesce((opts->>'tenant')::uuid,pg_temp.id(11)),coalesce((opts->>'actor')::uuid,pg_temp.id(3)),
 coalesce((opts->>'engagement')::uuid,pg_temp.id(31)),coalesce((opts->>'binding')::uuid,pg_temp.binding()),coalesce((opts->>'observation')::uuid,pg_temp.observation()),
 coalesce((opts->>'limit')::integer,20),(opts->>'created_at')::timestamptz,(opts->>'id')::uuid);
 execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;
end $$;
create function pg_temp.reconcile(key uuid,opts jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;prior text:=current_user;
begin
 set local role human_action_writer;
 r:=public.reconcile_public_source_review(coalesce((opts->>'tenant')::uuid,pg_temp.id(11)),coalesce((opts->>'actor')::uuid,pg_temp.id(7)),
 coalesce((opts->>'engagement')::uuid,pg_temp.id(31)),coalesce((opts->>'binding')::uuid,pg_temp.binding()),coalesce((opts->>'observation')::uuid,pg_temp.observation()),key);
 execute format('set local role %I',prior);return r;
exception when others then execute format('set local role %I',prior);raise;
end $$;
-- A second binding has no observed contact controls; empty indicators are not a no-PII verdict.
insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,final_url,status,result)
 select pg_temp.id(42),tenant_id,actor_id,pg_temp.id(142),requested_url,final_url,status,result-'auditPages'
 from public.public_website_checks where id=pg_temp.id(41);
do $$declare preview jsonb;bound jsonb;begin
 preview:=public.get_public_source_projection(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(42));
 bound:=public.record_public_source_binding(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),pg_temp.id(42),
 preview->'runtime_binding'->>'root_content_sha256',preview->'runtime_binding'->>'projection_sha256',pg_temp.id(102));
 insert into source_fixture values('zero_binding',bound->'binding_id');
end $$;
insert into source_fixture values('zero_drishti',to_jsonb(pg_temp.make('drishti',null,(select (v#>>'{}')::uuid from source_fixture where k='zero_binding'))));
insert into source_fixture values('zero_vibhaag',to_jsonb(pg_temp.make('vibhaag',pg_temp.observation('zero_drishti'),(select (v#>>'{}')::uuid from source_fixture where k='zero_binding'))));
insert into source_fixture values('original_sources',(select jsonb_agg(to_jsonb(o) order by id) from public.public_source_observations o where tenant_id=pg_temp.id(11)));
-- Review tests start here; the race harness reuses only the fixture above.
do $$declare role_name text;signature text;begin
 foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','evidence_ingestion_writer'] loop
  perform pg_temp.ok(not has_table_privilege(role_name,'public.public_source_reviews','SELECT') and not has_table_privilege(role_name,'public.public_source_reviews','INSERT') and not has_table_privilege(role_name,'public.public_source_reviews','UPDATE') and not has_table_privilege(role_name,'public.public_source_reviews','DELETE'),'review has no raw read or DML '||role_name);
 end loop;
 perform pg_temp.ok((select relrowsecurity from pg_class where oid='public.public_source_reviews'::regclass),'reviews have RLS');
 for signature in select p.oid::regprocedure::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('submit_public_source_review','list_public_source_reviews','reconcile_public_source_review') loop
  perform pg_temp.ok(has_function_privilege('human_action_writer',signature,'EXECUTE'),'restricted BFF credential');
  foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer','evidence_ingestion_writer'] loop
   perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'review RPC forbids '||role_name);
  end loop;
 end loop;
 for signature in select p.oid::regprocedure::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('public_source_review_context','public_source_review_metadata','public_source_review_source') loop
  foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
   perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'private helper '||role_name);
  end loop;
 end loop;
end $$;
select pg_temp.ok(pg_temp.history()->'data'='[]'::jsonb,'empty read creates no review');
select pg_temp.ok(pg_temp.reconcile(pg_temp.id(300))->'outcome'->>'state'='not_found','unrecorded request not found');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(3)))->>'error'='forbidden','viewer write denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(5)))->>'error'='forbidden','false internal analyst denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(6)))->>'error'='forbidden','absent member denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(9)))->>'error'='forbidden','internal without membership denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(8)))->>'error'='forbidden','partner write denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(10)))->>'error'='forbidden','agent write denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('tenant',pg_temp.id(12)))->>'error'='forbidden','foreign reviewer denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('engagement',pg_temp.id(32)))->>'error'='context_refused','foreign engagement denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('binding',pg_temp.id(999)))->>'error'='source_refused','unknown binding denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('observation',pg_temp.id(999)))->>'error'='observation_refused','unknown observation denied');
select pg_temp.ok(pg_temp.review(jsonb_build_object('output_sha256',repeat('f',64)))->>'error'='digest_mismatch','stale canonical output refused');
select pg_temp.ok(pg_temp.review(jsonb_build_object('projection_sha256',repeat('f',64)))->>'error'='digest_mismatch','stale projection refused');
select pg_temp.ok(pg_temp.review('{"decision":"confirmed"}')->>'error'='invalid_record','classification verdict not allowed');
select pg_temp.ok(pg_temp.review('{"justification":"  "}')->>'error'='invalid_record','justification required');
select pg_temp.ok(pg_temp.review(jsonb_build_object('justification',E' \t\n'))->>'error'='invalid_record','whitespace-only justification refused');
select pg_temp.ok(pg_temp.review(jsonb_build_object('justification',repeat('x',2001)))->>'error'='invalid_record','justification bounded');
select pg_temp.ok(pg_temp.review(jsonb_build_object('justification',repeat(' ',2001)||'reason'))->>'error'='invalid_record','raw justification length bounded before trimming');
select pg_temp.ok(pg_temp.review('{"page":"contact"}')->>'error'='invalid_record','whole locator injection refused');
select pg_temp.ok(pg_temp.review(jsonb_build_object('target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',2,'content_sha256',repeat('b',64)))->>'error'='target_refused','unclassified text control not selectable');
select pg_temp.ok(pg_temp.review(jsonb_build_object('target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',1,'content_sha256',repeat('f',64)))->>'error'='target_refused','wrong indicator content refused');
select pg_temp.ok(pg_temp.review(jsonb_build_object('target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',1,'content_sha256',repeat('b',64),'observation',pg_temp.observation('drishti')))->>'error'='target_refused','Drishti cannot have Vibhaag indicator target');
-- Isolate the exact locator boundary with a trusted test-only dependency seam.
-- The real source validator also rejects ambiguous outputs. Restore its exact
-- definition in this transaction; retained source rows are never rewritten.
do $$declare definition text;source jsonb;duplicate jsonb;begin
 definition:=pg_get_functiondef('public.public_source_review_source(uuid,uuid,uuid,uuid,boolean)'::regprocedure);
 source:=public.public_source_review_source(pg_temp.id(11),pg_temp.id(31),pg_temp.observation('binding'),pg_temp.observation('vibhaag'),true);
 select item into duplicate from jsonb_array_elements(source->'output'->'indicators') item where item->>'control_ordinal'='1';
 perform pg_temp.ok(duplicate is not null,'duplicate locator fixture is real retained indicator');
 source:=jsonb_set(source,'{output,indicators}',(source->'output'->'indicators')||jsonb_build_array(duplicate));
 execute format('create or replace function public.public_source_review_source(p_tenant_id uuid,p_engagement_id uuid,p_binding_id uuid,p_observation_id uuid,p_lock boolean) returns jsonb language sql security definer set search_path='''' as %L', 'select '||quote_literal(source::text)||'::jsonb');
 perform pg_temp.ok(pg_temp.review(jsonb_build_object('target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',1,'content_sha256',repeat('b',64)))->>'error'='target_refused','ambiguous locator refused even beyond source validation');
 execute definition;
end $$;
select pg_temp.ok((select count(*)=0 from public.public_source_reviews where tenant_id=pg_temp.id(11)),'refusals append no reviews');
select pg_temp.ok((select count(*)=0 from public.audit_ledger where tenant_id=pg_temp.id(11) and action_type='classification.reviewed'),'refusals append no human receipt');
insert into source_fixture values('first_review',pg_temp.review(jsonb_build_object('key',pg_temp.id(300))));
select pg_temp.ok((select v->>'created'='true' from source_fixture where k='first_review'),'reviewer can review another actor work');
select pg_temp.ok((select v->'data'->>'reviewed_by'=pg_temp.id(7)::text and v->'data'->'estate_id'='null'::jsonb from source_fixture where k='first_review'),'exact reviewer and NULL captured estate');
select pg_temp.ok((select v->'data'->>'source_observation_id'=pg_temp.observation('drishti')::text from source_fixture where k='first_review'),'original Drishti linkage retained');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->>'replayed'='true','same actor body replay once');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300),'actor',pg_temp.id(1)))->>'error'='idempotency_conflict','other actor key reuse conflicts');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300),'decision','disputed'))->>'error'='idempotency_conflict','same key changed body conflicts');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300),'justification',' I reviewed the retained public HTML structure only.'))->>'error'='idempotency_conflict','same key added justification space conflicts');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300),'justification','I reviewed the retained public HTML structure only. '))->>'error'='idempotency_conflict','same key appended justification space conflicts');
select pg_temp.ok(pg_temp.reconcile(pg_temp.id(300))->'outcome'->>'state'='retained','lost response read finds retained review');
select pg_temp.ok(pg_temp.reconcile(pg_temp.id(300),jsonb_build_object('actor',pg_temp.id(1)))->'outcome'->>'state'='not_found','other actor read does not leak review key');
select pg_temp.ok(pg_temp.review()->>'error'='stale_review','new correction requires predecessor');
-- Simulate wall-clock rollback without rewriting any retained judgment.
alter table public.public_source_reviews alter column created_at set default '2000-01-01T00:00:00Z'::timestamptz;
insert into source_fixture values('second_review',pg_temp.review(jsonb_build_object('key',pg_temp.id(301),'actor',pg_temp.id(1),'decision','disputed','previous',(select v->'data'->>'review_id' from source_fixture where k='first_review'))));
alter table public.public_source_reviews alter column created_at set default clock_timestamp();
select pg_temp.ok((select v->>'created'='true' and v->'data'->>'decision'='disputed' from source_fixture where k='second_review'),'new correction appends');
select pg_temp.ok((select (s.v->'data'->>'created_at')::timestamptz<(f.v->'data'->>'created_at')::timestamptz from source_fixture s,source_fixture f where s.k='second_review' and f.k='first_review'),'clock rollback does not choose the review head');
select pg_temp.ok(pg_temp.review(jsonb_build_object('previous',(select v->'data'->>'review_id' from source_fixture where k='first_review')))->>'error'='stale_review','stale predecessor refused');
alter table public.public_source_reviews alter column created_at set default '2001-01-01T00:00:00Z'::timestamptz;
insert into source_fixture values('third_review',pg_temp.review(jsonb_build_object('key',pg_temp.id(302),'previous',(select v->'data'->>'review_id' from source_fixture where k='second_review'))));
alter table public.public_source_reviews alter column created_at set default clock_timestamp();
select pg_temp.ok((select v->>'created'='true' and v->'data'->>'is_current'='true' from source_fixture where k='third_review'),'actual chain leaf remains correct after clock rollback');
select pg_temp.ok(pg_temp.history('{"limit":1}')->'data'->0->>'is_current'='false' and pg_temp.history('{"limit":1}')->'data'->0->>'review_id'=(select v->'data'->>'review_id' from source_fixture where k='first_review'),'timestamp page does not pretend an old judgment is current');
select pg_temp.ok(pg_temp.reconcile(pg_temp.id(302))->'outcome'->'review'->>'is_current'='true','lost-response read identifies true leaf outside timestamp page');
select pg_temp.ok(pg_temp.review(jsonb_build_object('previous',(select v->'data'->>'review_id' from source_fixture where k='second_review')))->>'error'='stale_review','child cannot branch from superseded predecessor');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->>'replayed'='true' and pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->'data'->>'is_current'='false','original replay survives later correction without reviving old judgment');
insert into source_fixture values('spaced_review',pg_temp.review(jsonb_build_object('key',pg_temp.id(304),'target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',1,'content_sha256',repeat('b',64),'actor',pg_temp.id(4),'justification',E'  Public email input observed. \n')));
select pg_temp.ok((select v->>'created'='true' and v->'data'->>'justification'=E'  Public email input observed. \n' from source_fixture where k='spaced_review'),'current analyst retains exact human justification bytes');
select pg_temp.ok((select justification=E'  Public email input observed. \n' and request_body->>'justification'=justification from public.public_source_reviews where operation_key=pg_temp.id(304)),'stored and committed justification preserve original bytes');
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(304),'target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',1,'content_sha256',repeat('b',64),'actor',pg_temp.id(4),'justification',E'Public email input observed. \n'))->>'error'='idempotency_conflict','same key removed surrounding spaces conflicts');
select pg_temp.ok(pg_temp.review(jsonb_build_object('observation',pg_temp.observation('drishti'),'actor',pg_temp.id(2)))->>'created'='true','admin acknowledges whole Drishti');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(9),'founder');
select pg_temp.ok(pg_temp.review(jsonb_build_object('target_kind','vibhaag_indicator','page','contact','form_ordinal',1,'control_ordinal',3,'content_sha256',repeat('b',64),'actor',pg_temp.id(9)))->>'created'='true','current internal founder with membership reviews structure');
select pg_temp.ok(pg_temp.review(jsonb_build_object('observation',pg_temp.observation('zero_vibhaag')))->>'created'='true','whole empty-indicator observation can be reviewed without classification');
-- Physical chain constraints also fail closed if a privileged importer errs.
do $$declare r public.public_source_reviews;begin
 select * into r from public.public_source_reviews where operation_key=pg_temp.id(300);
 r.id:=pg_temp.id(700);r.operation_key:=pg_temp.id(700);
 begin insert into public.public_source_reviews select r.*;raise exception 'second first review allowed';exception when unique_violation then null;end;
 select * into r from public.public_source_reviews where operation_key=pg_temp.id(301);
 r.id:=pg_temp.id(701);r.operation_key:=pg_temp.id(701);
 begin insert into public.public_source_reviews select r.*;raise exception 'predecessor branching allowed';exception when unique_violation then null;end;
 select * into r from public.public_source_reviews where observation_id=pg_temp.observation('drishti');
 r.id:=pg_temp.id(702);r.operation_key:=pg_temp.id(702);
 r.previous_review_id:=(select (v->'data'->>'review_id')::uuid from source_fixture where k='third_review');
 begin insert into public.public_source_reviews select r.*;raise exception 'foreign target predecessor allowed';exception when foreign_key_violation then null;end;
 select * into r from public.public_source_reviews where tenant_id=pg_temp.id(11) and target_kind='vibhaag_indicator' and control_ordinal=1;
 r.id:=pg_temp.id(703);r.operation_key:=pg_temp.id(703);
 r.previous_review_id:=(select (v->'data'->>'review_id')::uuid from source_fixture where k='third_review');
 begin insert into public.public_source_reviews select r.*;raise exception 'same observation different target predecessor allowed';exception when foreign_key_violation then null;end;
end $$;

select pg_temp.ok(jsonb_array_length(pg_temp.history('{"limit":1}')->'data')=1 and pg_temp.history('{"limit":1}')->>'has_more'='true','bounded history with next cursor');
select pg_temp.ok(jsonb_array_length(pg_temp.history(pg_temp.history('{"limit":1}')->'next_cursor'||'{"limit":1}')->'data')=1,'microsecond cursor advances');
select pg_temp.ok(pg_temp.history('{"limit":51}')->>'error'='invalid_record','limit bounded');
select pg_temp.ok(pg_temp.history(jsonb_build_object('id',pg_temp.id(300)))->>'error'='invalid_record','half cursor refused');
select pg_temp.ok(pg_temp.history(jsonb_build_object('actor',pg_temp.id(8)))->'data' is not null,'partner posture read allowed');
select pg_temp.ok(pg_temp.history(jsonb_build_object('actor',pg_temp.id(10)))->>'error'='forbidden','agent posture read refused');
update public.tenant_users set role='approver' where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(10);
select pg_temp.ok(pg_temp.history(jsonb_build_object('actor',pg_temp.id(10)))->'data' is not null,'approver posture read allowed');
select pg_temp.ok(pg_temp.review(jsonb_build_object('actor',pg_temp.id(10)))->>'error'='forbidden','approver has no assessment review authority');
do $$declare actor integer;begin foreach actor in array array[1,2,3,4,7,8,9] loop perform pg_temp.ok(pg_temp.history(jsonb_build_object('actor',pg_temp.id(actor)))->'data' is not null,'posture read parity actor '||actor);end loop;end $$;
update public.engagements set estate_id=pg_temp.id(21) where id=pg_temp.id(31);
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->>'replayed'='true','historical NULL preserved with revalidated current estate');
select pg_temp.ok((select estate_id is null from public.public_source_reviews where operation_key=pg_temp.id(300)),'no retroactive estate inference');
update public.engagements set status='cancelled' where id=pg_temp.id(31);
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->>'error'='context_refused','cancelled context refuses replay');
select pg_temp.ok(pg_temp.reconcile(pg_temp.id(300))->>'error'='context_refused','cancelled context refuses reconciliation');
update public.engagements set status='intake' where id=pg_temp.id(31);
delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(7);
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->>'error'='forbidden','revoked reviewer cannot replay');
select pg_temp.ok(pg_temp.reconcile(pg_temp.id(300))->>'error'='forbidden','revoked reviewer cannot reconcile');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(7),'reviewer');
do $$begin
 begin update public.public_source_reviews set justification='rewritten' where operation_key=pg_temp.id(300);raise exception 'review UPDATE was allowed';exception when insufficient_privilege then null;end;
 begin delete from public.public_source_reviews where operation_key=pg_temp.id(300);raise exception 'review DELETE was allowed';exception when insufficient_privilege then null;end;
end $$;
delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
select pg_temp.ok(pg_temp.review(jsonb_build_object('key',pg_temp.id(300)))->>'replayed'='true','current reviewer does not inherit revoked invoker authority');
select pg_temp.ok((select count(*)=7 from public.public_source_reviews where tenant_id=pg_temp.id(11)),'all human judgments retained without overwrite');
select pg_temp.ok((select count(*)=7 from public.audit_ledger l join public.public_source_reviews r on r.tenant_id=l.tenant_id and r.review_receipt=l.id
 where r.tenant_id=pg_temp.id(11) and l.actor_type='human' and l.actor_id=r.reviewed_by::text and l.action_type='classification.reviewed'
 and l.target_ref=r.id::text and l.correlation_id=r.operation_key and l.input_hash=r.output_sha256 and l.output_hash=r.request_body_sha256),'exactly one source-bound human receipt per review');
select pg_temp.ok((select v=(select jsonb_agg(to_jsonb(o) order by id) from public.public_source_observations o where tenant_id=pg_temp.id(11)) from source_fixture where k='original_sources'),'all source outputs and private unknowns unchanged');
select pg_temp.ok((select count(*)=0 from public.classification_reviews where tenant_id=pg_temp.id(11)),'legacy declarations untouched');
select pg_temp.ok(not exists(select 1 from public.verify_ledger(pg_temp.id(11),1)),'complete ledger chain intact');
rollback;
