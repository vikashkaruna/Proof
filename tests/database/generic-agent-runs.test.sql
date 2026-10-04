-- Real PostgreSQL authority and lifecycle checks; no source scan or evidence claim.
begin;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('99100400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
insert into auth.users(id,email) select pg_temp.id(n),'generic-sql-'||n||'@example.invalid' from generate_series(1,8) n;
insert into public.users(id,email,is_axiom_internal) select pg_temp.id(n),'generic-sql-'||n||'@example.invalid',n in (4,5,6) from generate_series(1,8) n;
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'generic-a','A'),(pg_temp.id(12),'generic-b','B');
insert into public.tenant_users(tenant_id,user_id,role) values
 (pg_temp.id(11),pg_temp.id(1),'owner'),(pg_temp.id(11),pg_temp.id(2),'admin'),
 (pg_temp.id(11),pg_temp.id(3),'viewer'),(pg_temp.id(11),pg_temp.id(4),'founder'),(pg_temp.id(11),pg_temp.id(5),'axiom_analyst'),
 (pg_temp.id(11),pg_temp.id(7),'founder'),(pg_temp.id(11),pg_temp.id(8),'axiom_analyst');
insert into public.estates(id,tenant_id,slug,name) values(pg_temp.id(21),pg_temp.id(11),'generic-a','A'),(pg_temp.id(22),pg_temp.id(12),'generic-b','B');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('generic-test',now(),'test','Synthetic lifecycle fixture',0);
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values
 (pg_temp.id(31),pg_temp.id(11),pg_temp.id(21),'generic-test','A'),(pg_temp.id(32),pg_temp.id(12),pg_temp.id(22),'generic-test','B');

create function pg_temp.start(o jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb; prior text:=current_user;
begin
 set local role human_action_writer;
 begin r:=public.record_generic_agent_run_start(
  coalesce((o->>'tenant')::uuid,pg_temp.id(11)),coalesce((o->>'actor')::uuid,pg_temp.id(1)),
  coalesce(o->>'agent','drishti'),case when o?'engagement' then (o->>'engagement')::uuid else pg_temp.id(31) end,
  coalesce((o->>'correlation')::uuid,gen_random_uuid()),coalesce(o->>'hash',repeat('a',64)));
 exception when others then execute format('set local role %I',prior);raise;end;
 execute format('set local role %I',prior);return r;
end$$;

create function pg_temp.pair(run_id uuid,s jsonb default '{}',e jsonb default '{}') returns jsonb language plpgsql as $$
declare r public.agent_runs; a jsonb; b jsonb; sid bigint; eid bigint; prior text:=current_user;
begin
 select * into strict r from public.agent_runs where id=run_id;
 a:=jsonb_build_object('tenant',r.tenant_id,'correlation',r.correlation_id,'actor','drishti','action','discovery.started','target',r.engagement_id,
  'result','pending','version','1.0.0','input_hash',repeat('b',64),'output_hash',null,
  'detail',jsonb_build_object('phase','started','run_id',r.id,'request_hash',r.input_redacted_hash))||s;
 if s?'detail' then a:=a||jsonb_build_object('detail',jsonb_build_object('phase','started','run_id',r.id,'request_hash',r.input_redacted_hash)||(s->'detail'));end if;
 set local role agent_ledger_writer;
 sid:=public.append_agent_ledger((a->>'tenant')::uuid,(a->>'correlation')::uuid,'agent',a->>'actor',a->>'version',null,null,
  (a->>'action')::public.ledger_action_type,a->>'target',a->>'input_hash',a->>'output_hash',null,null,null,null,(a->>'result')::public.ledger_result,a->'detail');
 execute format('set local role %I',prior);
 b:=jsonb_build_object('tenant',r.tenant_id,'correlation',r.correlation_id,'actor','drishti','action','discovery.started','target',r.engagement_id,
  'result','success','version','1.0.0','input_hash',repeat('b',64),'output_hash',repeat('c',64),
  'detail',jsonb_build_object('phase','completed','run_id',r.id,'request_hash',r.input_redacted_hash,'started_entry',sid::text))||e;
 if e?'detail' then b:=b||jsonb_build_object('detail',jsonb_build_object('phase','completed','run_id',r.id,'request_hash',r.input_redacted_hash,'started_entry',sid::text)||(e->'detail'));end if;
 set local role agent_ledger_writer;
 eid:=public.append_agent_ledger((b->>'tenant')::uuid,(b->>'correlation')::uuid,'agent',b->>'actor',b->>'version',null,null,
  (b->>'action')::public.ledger_action_type,b->>'target',b->>'input_hash',b->>'output_hash',null,null,null,null,(b->>'result')::public.ledger_result,b->'detail');
 execute format('set local role %I',prior);
 return jsonb_build_object('started',sid::text,'completed',eid::text);
exception when others then execute format('set local role %I',prior);raise;
end$$;
create function pg_temp.finish(run_id uuid,receipts jsonb default '{}',o jsonb default '{}') returns jsonb language plpgsql as $$
declare r public.agent_runs; result jsonb; prior text:=current_user;
begin
 select * into strict r from public.agent_runs where id=run_id;
 set local role human_action_writer;
 begin result:=public.record_generic_agent_run_finish(
  coalesce((o->>'tenant')::uuid,r.tenant_id),coalesce((o->>'actor')::uuid,pg_temp.id(1)),r.id,
  coalesce(o->>'agent',r.agent),case when o?'engagement' then (o->>'engagement')::uuid else r.engagement_id end,
  coalesce((o->>'correlation')::uuid,r.correlation_id),coalesce(o->>'hash',r.input_redacted_hash),coalesce(o->>'status','succeeded'),o->>'error',
  coalesce((o->>'latency')::int,12),coalesce((o->>'input_tokens')::int,1),coalesce((o->>'output_tokens')::int,2),coalesce((o->>'cost')::numeric,0),
  receipts->>'started',receipts->>'completed',case when o?'response_hash' then o->>'response_hash' else repeat('d',64) end);
 exception when others then execute format('set local role %I',prior);raise;end;
 execute format('set local role %I',prior);return result;
end$$;

-- Credentials expose only these two functions, never direct writes.
do $$declare role_name text; signature text;begin
 foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer','human_action_writer'] loop
  perform pg_temp.ok(not has_table_privilege(role_name,'public.agent_runs','INSERT') and not has_table_privilege(role_name,'public.agent_runs','UPDATE') and not has_table_privilege(role_name,'public.agent_runs','DELETE'),'direct DML refused '||role_name);
 end loop;
 for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('record_generic_agent_run_start','record_generic_agent_run_finish') loop
  perform pg_temp.ok(has_function_privilege('human_action_writer',signature,'EXECUTE'),'human writer allowed');
  foreach role_name in array array['anon','authenticated','service_role','agent_ledger_writer','evidence_ingestion_writer','approval_archive_writer','statutory_proof_writer'] loop
   perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'RPC refused '||role_name);
  end loop;
 end loop;
end$$;
select pg_temp.ok(pg_temp.start(jsonb_build_object('actor',pg_temp.id(3)))->>'error'='forbidden','viewer refused');
select pg_temp.ok(pg_temp.start(jsonb_build_object('actor',pg_temp.id(6)))->>'error'='forbidden','internal nonmember refused');
select pg_temp.ok(pg_temp.start(jsonb_build_object('tenant',pg_temp.id(12)))->>'error'='forbidden','foreign tenant refused');
select pg_temp.ok(pg_temp.start(jsonb_build_object('engagement',pg_temp.id(32)))->>'error'='context_refused','foreign engagement refused');
select pg_temp.ok(pg_temp.start('{"agent":"karya"}')->>'error'='invalid_record','Karya gate');
select pg_temp.ok(pg_temp.start('{"agent":"prativedan"}')->>'error'='invalid_record','report gate');
select pg_temp.ok(pg_temp.start('{"agent":"pramaan"}')->>'error'='invalid_record','Pramaan gate');
select pg_temp.ok(pg_temp.start('{"agent":"samadhan"}')->>'error'='invalid_record','Samadhan gate');
select pg_temp.ok(pg_temp.start('{"agent":"lekha"}')->>'error'='forbidden','customer internal agent refused');
select pg_temp.ok(pg_temp.start(jsonb_build_object('agent','lekha','actor',pg_temp.id(5),'engagement',null))->>'created'='true','internal analyst admitted without invented context');
select pg_temp.ok(pg_temp.start('{"hash":"bad"}')->>'error'='invalid_record','hash refused');

-- Role names cannot substitute for the independently revocable internal flag.
do $$declare actor int;agent text;before_runs bigint;before_ledger bigint;r jsonb;begin
 foreach actor in array array[7,8] loop
  foreach agent in array array['drishti','lekha'] loop
   select count(*) into before_runs from public.agent_runs;
   select count(*) into before_ledger from public.audit_ledger;
   r:=pg_temp.start(jsonb_build_object('actor',pg_temp.id(actor),'agent',agent));
   perform pg_temp.ok(r->>'error'='forbidden','false internal flag refused '||actor||' '||agent);
   perform pg_temp.ok((select count(*)=before_runs from public.agent_runs),'flag refusal creates zero runs');
   perform pg_temp.ok((select count(*)=before_ledger from public.audit_ledger),'flag refusal creates zero ledger receipts');
  end loop;
 end loop;
 foreach actor in array array[4,5] loop
  perform pg_temp.ok(pg_temp.start(jsonb_build_object('actor',pg_temp.id(actor)))->>'created'='true','true internal flag ordinary agent allowed');
  perform pg_temp.ok(pg_temp.start(jsonb_build_object('actor',pg_temp.id(actor),'agent','lekha'))->>'created'='true','true internal flag internal agent allowed');
  update public.users set is_axiom_internal=false where id=pg_temp.id(actor);
  select count(*) into before_runs from public.agent_runs;
  select count(*) into before_ledger from public.audit_ledger;
  perform pg_temp.ok(pg_temp.start(jsonb_build_object('actor',pg_temp.id(actor)))->>'error'='forbidden','revoked internal flag refused');
  perform pg_temp.ok((select count(*)=before_runs from public.agent_runs),'revoked flag creates zero runs');
  perform pg_temp.ok((select count(*)=before_ledger from public.audit_ledger),'revoked flag creates zero ledger receipts');
  update public.users set is_axiom_internal=true where id=pg_temp.id(actor);
 end loop;
 foreach actor in array array[1,2] loop
  perform pg_temp.ok(pg_temp.start(jsonb_build_object('actor',pg_temp.id(actor)))->>'created'='true','ordinary owner/admin needs no internal flag');
 end loop;
end$$;

-- The producer credential cannot invent authorization/controller receipts.
do $$declare event text;prior text:=current_user;begin
 foreach event in array array['agent.invocation.requested','agent.invocation.settled'] loop
  set local role agent_ledger_writer;
  begin
   perform public.append_agent_ledger(pg_temp.id(11),gen_random_uuid(),'system','bff-generic-agent-controller',null,null,null,event::public.ledger_action_type,null,null,null,null,null,null,null,'pending','{}');
   raise exception 'unexpected producer authorization';
  exception when insufficient_privilege then null;end;
  execute format('set local role %I',prior);
 end loop;
end$$;

-- One requested event/dispatch per correlation, never silent replay.
do $$declare a jsonb;b jsonb;rid uuid;corr uuid:=gen_random_uuid();receipts jsonb;n int;begin
 a:=pg_temp.start(jsonb_build_object('correlation',corr));rid:=(a->>'run_id')::uuid;
 b:=pg_temp.start(jsonb_build_object('correlation',corr));
 perform pg_temp.ok(a->>'created'='true' and b->>'created'='false' and b->>'run_id'=rid::text,'duplicate dispatch stopped');
 perform pg_temp.ok(pg_temp.start(jsonb_build_object('correlation',corr,'hash',repeat('f',64)))->>'error'='dispatch_conflict','request change refused');
 perform pg_temp.ok(pg_temp.start(jsonb_build_object('correlation',corr,'actor',pg_temp.id(2)))->>'error'='dispatch_conflict','actor change refused');
 select count(*) into n from public.audit_ledger where tenant_id=pg_temp.id(11) and correlation_id=corr and action_type='agent.invocation.requested';
 perform pg_temp.ok(n=1,'one request receipt');
 receipts:=pg_temp.pair(rid);
 -- Historical confirmation survives authority removal, without redispatch.
 delete from public.tenant_users where tenant_id=pg_temp.id(11) and user_id=pg_temp.id(1);
 perform pg_temp.ok(pg_temp.start()->>'error'='forbidden','revoked actor cannot dispatch');
 perform pg_temp.ok(pg_temp.finish(rid,receipts)->>'status'='succeeded','revoked actor past result recorded');
 perform pg_temp.ok(pg_temp.finish(rid,receipts)->>'replayed'='true','matching terminal replay idempotent');
 perform pg_temp.ok(pg_temp.finish(rid,receipts,'{"latency":13}')->>'error'='terminal_conflict','conflicting terminal refused');
 perform pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=pg_temp.id(11) and correlation_id=corr and action_type='agent.invocation.settled'),'one settlement');
 perform pg_temp.ok((select input_redacted_hash=repeat('a',64) and output_redacted_hash=repeat('c',64)
  and metadata->>'runtime_normalized_input_hash'=repeat('b',64) and metadata->>'response_output_hash'=repeat('d',64)
  from public.agent_runs where id=rid),'separate request/normalized/output/response representations');
 insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
end$$;

-- Receipt validation refuses plausible but wrong provenance, independently.
do $$declare change jsonb;rid uuid;receipts jsonb;before_settled int;begin
 for change in select value from jsonb_array_elements(jsonb_build_array(
  jsonb_build_object('actor','vibhaag'),jsonb_build_object('tenant',pg_temp.id(12)),jsonb_build_object('correlation',pg_temp.id(99)),
  jsonb_build_object('target',pg_temp.id(32)),jsonb_build_object('action','classification.started'),
  jsonb_build_object('result','failure'),jsonb_build_object('version','different'),jsonb_build_object('input_hash',repeat('e',64)),
  jsonb_build_object('detail',jsonb_build_object('run_id',pg_temp.id(99))),
  jsonb_build_object('detail',jsonb_build_object('run_id',null)),
  jsonb_build_object('detail',jsonb_build_object('request_hash',repeat('f',64))),
  jsonb_build_object('detail',jsonb_build_object('request_hash',null)),
  jsonb_build_object('detail',jsonb_build_object('started_entry','1')),
  jsonb_build_object('detail',jsonb_build_object('phase','failed')))) loop
  rid:=(pg_temp.start()->>'run_id')::uuid;receipts:=pg_temp.pair(rid,'{}',change);
  perform pg_temp.ok(pg_temp.finish(rid,receipts)->>'error'='receipts_unconfirmed','wrong receipt provenance refused '||change::text);
  perform pg_temp.ok((select status='running' from public.agent_runs where id=rid),'no false terminal status');
 end loop;
 rid:=(pg_temp.start()->>'run_id')::uuid;receipts:=pg_temp.pair(rid);
 perform pg_temp.ok(pg_temp.finish(rid,jsonb_build_object('started',receipts->>'completed','completed',receipts->>'started'))->>'error'='receipts_unconfirmed','reversed receipt order refused');
 perform pg_temp.ok(pg_temp.finish(rid,jsonb_build_object('started',receipts->>'started','completed',receipts->>'started'))->>'error'='receipts_unconfirmed','same receipt refused');
 perform pg_temp.ok(pg_temp.finish(rid,jsonb_build_object('started','mem-1','completed','mem-2'))->>'error'='receipts_unconfirmed','memory receipt refused');
 perform pg_temp.ok(pg_temp.finish(rid,jsonb_build_object('started','9223372036854775808','completed','2'))->>'error'='receipts_unconfirmed','bigint overflow refused');
 for change in select value from jsonb_array_elements(jsonb_build_array(jsonb_build_object('actor',pg_temp.id(2)),jsonb_build_object('tenant',pg_temp.id(12)),jsonb_build_object('agent','sudhaar'),jsonb_build_object('engagement',null),jsonb_build_object('correlation',pg_temp.id(99)),jsonb_build_object('hash',repeat('f',64)))) loop
  perform pg_temp.ok(pg_temp.finish(rid,receipts,change)->>'error'='run_context_conflict','wrong dispatch context refused');
 end loop;
 perform pg_temp.ok(pg_temp.finish(rid,receipts,'{"input_tokens":2147483647,"output_tokens":1}')->>'error'='invalid_record','accounting overflow refused');
 perform pg_temp.ok(pg_temp.finish(rid,receipts,'{"cost":"NaN"}')->>'error'='invalid_record','NaN refused');
 update public.agent_runs set status='cancelled',completed_at=clock_timestamp() where id=rid;
 perform pg_temp.ok(pg_temp.finish(rid,receipts)->>'error'='terminal_conflict','cancelled cannot be rewritten');
end$$;

-- Generic finish cannot settle a dedicated run; legacy Karya finish cannot
-- settle generic telemetry even under the ordinary service credential.
do $$declare rid uuid;receipts jsonb;r jsonb;begin
 rid:=(pg_temp.start()->>'run_id')::uuid;receipts:=pg_temp.pair(rid);
 set local role service_role;
 r:=public.record_karya_run_finish(pg_temp.id(11),rid,'succeeded',null,1,repeat('f',64));
 set local role postgres;
 perform pg_temp.ok(r->>'error'='run_not_running','Karya cannot finish generic row');
 perform pg_temp.ok((select status='running' from public.agent_runs where id=rid),'generic unchanged by dedicated writer');
 update public.agent_runs set metadata=metadata-'lifecycle_writer' where id=rid;
 perform pg_temp.ok(pg_temp.finish(rid,receipts)->>'error'='run_context_conflict','dedicated row cannot use generic lifecycle');
end$$;

-- Transport uncertainty is telemetry, not a proof of agent failure or rollback.
do $$declare rid uuid;r jsonb;begin
 rid:=(pg_temp.start()->>'run_id')::uuid;
 r:=pg_temp.finish(rid,'{}','{"status":"failed","error":"agent_invocation_failed","response_hash":null}');
 perform pg_temp.ok(r->>'status'='failed','controller failure recorded');
 perform pg_temp.ok((select output_redacted_hash is null and metadata->>'runtime_outcome'='unconfirmed' from public.agent_runs where id=rid),'unknown outcome honest');
end$$;

-- Ledger failure rolls back both request creation and terminal update.
create function pg_temp.block_audit() returns trigger language plpgsql as $$begin
 if new.action_type::text=current_setting('axiom.test.block_action',true) then raise exception 'deliberate audit failure';end if;return new;end$$;
create trigger generic_test_audit_failure before insert on public.audit_ledger for each row execute function pg_temp.block_audit();
do $$declare n bigint;rid uuid;receipts jsonb;begin
 select count(*) into n from public.agent_runs;
 perform set_config('axiom.test.block_action','agent.invocation.requested',true);
 begin perform pg_temp.start();raise exception 'expected rollback';exception when others then if sqlerrm<>'deliberate audit failure' then raise;end if;end;
 perform pg_temp.ok((select count(*)=n from public.agent_runs),'request rolls back without ledger');
 perform set_config('axiom.test.block_action','',true);
 rid:=(pg_temp.start()->>'run_id')::uuid;receipts:=pg_temp.pair(rid);
 perform set_config('axiom.test.block_action','agent.invocation.settled',true);
 begin perform pg_temp.finish(rid,receipts);raise exception 'expected rollback';exception when others then if sqlerrm<>'deliberate audit failure' then raise;end if;end;
 perform pg_temp.ok((select status='running' and completed_at is null from public.agent_runs where id=rid),'terminal rolls back without ledger');
end$$;
rollback;
