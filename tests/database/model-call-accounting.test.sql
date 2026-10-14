-- Actual PostgreSQL contracts/ACLs/receipts; no live provider or workload proof.
begin;
-- Disposable transaction-only custody; never a production membership grant.
grant axiom_model_accounting_controller to postgres with set true;
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('99102800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
create function pg_temp.denied(command text,expected text default null) returns boolean language plpgsql as $$begin execute command;return false;exception when others then if sqlstate='42601' then raise;end if;return expected is null or sqlerrm=expected;end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'accounting-owner@example.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'accounting-owner@example.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(2),'accounting-a','Accounting A'),(pg_temp.id(3),'accounting-b','Accounting B');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(2),pg_temp.id(1),'owner'),(pg_temp.id(3),pg_temp.id(1),'owner');
create function pg_temp.open_run(t uuid default pg_temp.id(2)) returns jsonb language plpgsql as $$
declare started jsonb; r public.agent_runs;s bigint;loaded jsonb;
begin
 set local role human_action_writer;
 started:=public.record_generic_agent_run_start(t,pg_temp.id(1),'drishti',null,gen_random_uuid(),repeat('a',64));
 reset role;
 select * into strict r from public.agent_runs where id=(started->>'run_id')::uuid;
 set local role agent_ledger_writer;
 s:=public.append_agent_ledger(t,r.correlation_id,'agent','drishti','0.1.0',null,null,
  'discovery.started',null,repeat('b',64),null,null,null,null,null,'pending',
  jsonb_build_object('phase','started','run_id',r.id,'request_hash',repeat('a',64)));
 reset role;
 set local role axiom_model_accounting_controller;
 loaded:=public.load_model_accounting_dispatch(t,r.id,repeat('a',64));
 reset role;
 return loaded||jsonb_build_object('started',s::text);
end $$;
create function pg_temp.complete_run(run jsonb) returns text language plpgsql as $$
declare receipt bigint;
begin
 set local role agent_ledger_writer;
 receipt:=public.append_agent_ledger((run->>'tenant_id')::uuid,(run->>'correlation_id')::uuid,'agent','drishti','0.1.0',null,null,
  'discovery.started',null,repeat('b',64),encode(sha256(convert_to('{"ok":true}','UTF8')),'hex'),null,null,null,null,'success',
  jsonb_build_object('phase','completed','run_id',run->>'run_id','request_hash',repeat('a',64),'started_entry',run->>'started'));
 reset role;return receipt::text;
end $$;
create function pg_temp.fail_run(run jsonb) returns text language plpgsql as $$
declare receipt bigint;
begin
 set local role agent_ledger_writer;
 receipt:=public.append_agent_ledger((run->>'tenant_id')::uuid,(run->>'correlation_id')::uuid,'agent','drishti','0.1.0',null,null,
  'discovery.started',null,repeat('b',64),null,null,null,null,null,'failure',
  jsonb_build_object('phase','failed','run_id',run->>'run_id','request_hash',repeat('a',64),'started_entry',run->>'started','failure_code','agent_failed'));
 reset role;return receipt::text;
end $$;
create function pg_temp.packet(run jsonb, callid uuid default gen_random_uuid()) returns jsonb language sql as $$
 select (run-array['requested_receipt','started','claimed'])||jsonb_build_object('call_id',callid,
  'request_json_sha256',repeat('b',64),'request_json_basis','canonical_decoded_request_not_http_wire',
  'template_sha256',repeat('c',64),'model_selector','fast','task','reasoning',
  'state','completed','failure_code',null,'content_sha256',repeat('d',64),
  'planned',jsonb_build_object('provider','self_hosted','model','qwen/Qwen3'),
  'serving',jsonb_build_object('provider','self_hosted','model','qwen/Qwen3','reported_model',null),
  'commitments',jsonb_build_object('composed_sha256',repeat('e',64),'transport_prompt_sha256',repeat('f',64),'sdk_handoff_sha256',repeat('1',64),'basis','sdk_handoff_not_http_wire'),
  'attempts',jsonb_build_array(jsonb_build_object('provider','self_hosted','model','qwen/Qwen3','outcome','succeeded')),
  'usage',jsonb_build_object('availability','reported','input_tokens',4,'output_tokens',6,'total_tokens',10),
  'pricing',jsonb_build_object('basis','configuration_estimate','scope','successful_response_only','config_sha256',repeat('2',64),'estimate_usd','0.000000000001'))
$$;
create function pg_temp.begin_call(p jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
 set local role axiom_model_accounting_controller;
 result:=public.begin_model_accounting_call((p->>'tenant_id')::uuid,(p->>'run_id')::uuid,p->>'request_sha256',(p->>'call_id')::uuid,
  (p-array['state','failure_code','content_sha256','planned','serving','commitments','attempts','usage','pricing'])::text);
 reset role;return result;
end $$;
create function pg_temp.finish_call(p jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
 set local role axiom_model_accounting_controller;
 result:=public.finish_model_accounting_call((p->>'tenant_id')::uuid,(p->>'run_id')::uuid,p->>'request_sha256',(p->>'call_id')::uuid,p::text);
 reset role;return result;
end $$;

create function pg_temp.settle(run jsonb,completed text,i integer,o integer,c numeric,status text default 'succeeded') returns jsonb language plpgsql as $$
declare result jsonb;
begin
 set local role human_action_writer;
 result:=public.record_generic_agent_run_finish((run->>'tenant_id')::uuid,pg_temp.id(1),(run->>'run_id')::uuid,'drishti',null,
  (run->>'correlation_id')::uuid,run->>'request_sha256',status,case when status='failed' then 'agent_reported_failure' else null end,
  1,i,o,c,run->>'started',completed,case when status='succeeded' then repeat('d',64) else null end);
 reset role;return result;
end $$;

-- No shared human/agent/service credential can access either journal or RPCs.
do $$declare role_name text; name text;signature text;begin
 foreach role_name in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer','evidence_ingestion_writer'] loop
  foreach name in array array['model_accounting_runs','model_accounting_call_starts','model_accounting_call_outcomes','model_accounting_seals'] loop
   perform pg_temp.ok(not has_table_privilege(role_name,'public.'||name,'SELECT,INSERT,UPDATE,DELETE'),'shared role journal denied '||role_name||' '||name);
  end loop;
  for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and p.proname in ('load_model_accounting_dispatch','begin_model_accounting_call','finish_model_accounting_call','read_model_accounting_run','seal_model_accounting_run') loop
   perform pg_temp.ok(not has_function_privilege(role_name,signature,'EXECUTE'),'shared role RPC denied '||role_name);
  end loop;
 end loop;
 perform pg_temp.ok((select not rolcanlogin and not rolinherit and not rolbypassrls from pg_roles where rolname='axiom_model_accounting_controller'),'controller custody only');
end $$;

-- Physical source-parent constraints reject orphan and mismatched origin rows.
create function pg_temp.integrity_denied(command text,code text) returns boolean language plpgsql as $$begin
 execute command;return false;exception when others then return sqlstate=code;end $$;
do $$declare run jsonb;begin
 run:=pg_temp.open_run();
 perform pg_temp.ok(pg_temp.integrity_denied(format($cmd$insert into public.model_accounting_runs
  select %L::uuid,tenant_id,binding,requested_receipt,requested_receipt,requested_receipt,'generic',%L::uuid,null
  from public.model_accounting_runs where run_id=%L::uuid$cmd$,pg_temp.id(999),pg_temp.id(999),run->>'run_id'),'23503'),'orphan generic parent refused by FK');
 perform pg_temp.ok(pg_temp.integrity_denied(format($cmd$insert into public.model_accounting_runs
  select %L::uuid,tenant_id,binding,requested_receipt,requested_receipt,requested_receipt,'generic',run_id,null
  from public.model_accounting_runs where run_id=%L::uuid$cmd$,pg_temp.id(998),run->>'run_id'),'23514'),'wrong source parent ID refused by CHECK');
 perform pg_temp.ok(pg_temp.integrity_denied(format($cmd$insert into public.model_accounting_runs
  select %L::uuid,tenant_id,binding,requested_receipt,requested_receipt,requested_receipt,'prativedan_assessment',run_id,null
  from public.model_accounting_runs where run_id=%L::uuid$cmd$,pg_temp.id(997),run->>'run_id'),'23514'),'cross-origin parent refused by CHECK');
end $$;

-- Independently loaded closed empty journal; bare scalar zeros are not accepted.
do $$declare run jsonb;result jsonb;e text;begin
 run:=pg_temp.open_run();e:=pg_temp.complete_run(run);
 set local role axiom_model_accounting_controller;
 result:=public.seal_model_accounting_run((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256',run->>'started',e);
 reset role;
 perform pg_temp.ok(public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256')->'seal'=result,'independent full seal read matches retained source');
 raise notice 'ACCOUNTING_RESULT_INTEROP=%',public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256');
 raise notice 'ACCOUNTING_INTEROP=%',jsonb_build_object('binding',run-array['requested_receipt','started','claimed'],'requestedReceipt',run->'requested_receipt','agentStartedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,(run->>'started')::bigint),'agentCompletedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,e::bigint),'seal',result);
 perform pg_temp.ok(pg_temp.settle(run,e,0,0,0)->>'status'='succeeded','sealed no_model settlement succeeds');
 perform pg_temp.ok((select metadata->>'model_accounting_status'='sealed_observed_journal' from public.agent_runs where id=(run->>'run_id')::uuid),'actual new settlement carries independent journal status');
 perform pg_temp.ok(result->'summary'->>'basis'='no_model','sealed observed empty journal');
 perform pg_temp.ok(result->'summary'->>'estimate_usd'='0','empty known estimate');
 perform pg_temp.ok(result->>'calls_sha256'=controller_security.prativedan123_hash(result->>'calls_text'),'retained canonical packet hash');
 perform pg_temp.ok(result->'accounting_receipt'->>'id'<>result->'requested_receipt'->>'id','separate actual append receipt');
 set constraints all immediate;set constraints all deferred;
end $$;

-- Exact replay, tiny nonzero estimate, frozen callset and ledger chain.
do $$declare run jsonb;p jsonb;claim jsonb;recorded jsonb;result jsonb;e text;before_count bigint;begin
 run:=pg_temp.open_run();p:=pg_temp.packet(run);
 select count(*) into before_count from public.audit_ledger;
 set local role axiom_model_accounting_controller;
 perform pg_temp.ok(public.load_model_accounting_dispatch((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256')->>'claimed'='false','open replay never reauthorizes computation');
 reset role;
 perform pg_temp.ok((select count(*)=before_count from public.audit_ledger),'open replay has no new receipt');
 claim:=pg_temp.begin_call(p);perform pg_temp.ok(claim->>'claimed'='true','first call claimed');
 select count(*) into before_count from public.audit_ledger;
 perform pg_temp.ok(pg_temp.begin_call(p)->>'claimed'='false','replay never authorizes provider');
 perform pg_temp.ok((select count(*)=before_count from public.audit_ledger),'exact begin replay no new receipt');
 recorded:=pg_temp.finish_call(p);select count(*) into before_count from public.audit_ledger;
 perform pg_temp.ok(pg_temp.finish_call(p)=recorded,'exact outcome replay');
 perform pg_temp.ok((select count(*)=before_count from public.audit_ledger),'exact finish replay no new receipt');
 perform pg_temp.ok(pg_temp.denied(format('select pg_temp.finish_call(%L::jsonb)',jsonb_set(p,'{content_sha256}',to_jsonb(repeat('9',64)))), 'accounting observation replay conflict'),'changed observation refused');
 e:=pg_temp.complete_run(run);
 set local role axiom_model_accounting_controller;
 result:=public.seal_model_accounting_run((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256',run->>'started',e);
 perform pg_temp.ok(public.seal_model_accounting_run((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256',run->>'started',e)=result,'seal exact replay');
 reset role;
 perform pg_temp.ok(public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256')->'seal'=result,'independent full seal read matches retained source');
 raise notice 'ACCOUNTING_RESULT_INTEROP=%',public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256');
 raise notice 'ACCOUNTING_INTEROP=%',jsonb_build_object('binding',run-array['requested_receipt','started','claimed'],'requestedReceipt',run->'requested_receipt','agentStartedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,(run->>'started')::bigint),'agentCompletedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,e::bigint),'seal',result);
 perform pg_temp.ok(pg_temp.settle(run,e,0,0,0)->>'error'='model_accounting_projection_conflict','invented scalar zeros cannot settle known observed usage');
 perform pg_temp.ok(pg_temp.settle(run,e,4,6,0)->>'status'='succeeded','honest6dp tiny projection settles separately from exact estimate');
 perform pg_temp.ok(result->'summary'->>'basis'='all_known','single response all usage known');
 perform pg_temp.ok(result->'summary'->>'estimate_usd'='0.000000000001','tiny retained estimate unchanged');
 perform pg_temp.ok(round((result->'summary'->>'estimate_usd')::numeric,6)=0,'legacy projection zero is not no_model');
 perform pg_temp.ok(pg_temp.denied(format('select pg_temp.begin_call(%L::jsonb)',pg_temp.packet(run))),'closed callset refuses new provider claim');
 set constraints all immediate;set constraints all deferred;
end $$;

-- Pending call cannot seal; unknown failed attempts never invent total usage.
do $$declare run jsonb;p jsonb;result jsonb;e text;begin
 run:=pg_temp.open_run();p:=pg_temp.packet(run);perform pg_temp.begin_call(p);
 perform pg_temp.ok(pg_temp.settle(run,null,0,0,0)->>'error'='model_accounting_unsealed','public finalizer cannot bypass pending accounting');
 perform pg_temp.ok(controller_security.generic_finish_before_119((run->>'tenant_id')::uuid,pg_temp.id(1),(run->>'run_id')::uuid,'drishti',null,(run->>'correlation_id')::uuid,run->>'request_sha256','succeeded',null,1,0,0,0,run->>'started',null,repeat('d',64))->>'error'='model_accounting_unsealed','actual private nested sink cannot bypass pending accounting');
 e:=pg_temp.complete_run(run);
 perform pg_temp.ok(pg_temp.denied(format('select public.seal_model_accounting_run(%L::uuid,%L::uuid,%L,%L,%L)',run->>'tenant_id',run->>'run_id',run->>'request_sha256',run->>'started',e)),'pending call cannot seal');
 p:=p||jsonb_build_object('state','failed','failure_code','gateway_unavailable','content_sha256',null,'planned',null,'serving',null,'commitments',null,'attempts',null,
  'usage',jsonb_build_object('availability','unavailable','input_tokens',null,'output_tokens',null,'total_tokens',null),
  'pricing',jsonb_build_object('basis','unavailable','scope','successful_response_only','config_sha256',null,'estimate_usd',null));
 perform pg_temp.finish_call(p);
 perform pg_temp.ok(pg_temp.denied(format('select public.seal_model_accounting_run(%L::uuid,%L::uuid,%L,%L,%L)',run->>'tenant_id',run->>'run_id',run->>'request_sha256',run->>'started',e)),'late observed outcome cannot claim earlier runtime completion');
 perform pg_temp.ok(controller_security.accounting128_summary(jsonb_build_array(p))->>'basis'='unknown','failed provider accounting unknown');
 perform pg_temp.ok(controller_security.accounting128_summary(jsonb_build_array(p))->'total_tokens'='null'::jsonb,'unknown usage remains null');
end $$;

-- A halt/revocation blocks new transport but cannot erase an already observed
-- failure. Its real failed terminal receipt can close an unknown-usage journal.
do $$declare run jsonb;p jsonb;result jsonb;e text;count_before bigint;begin
 run:=pg_temp.open_run();p:=pg_temp.packet(run);perform pg_temp.begin_call(p);
 insert into public.kill_switch_state(scope_key,scope,tenant_id,engaged) values(run->>'tenant_id','tenant',(run->>'tenant_id')::uuid,true);
 select count(*) into count_before from public.audit_ledger;
 perform pg_temp.ok(pg_temp.denied(format('select pg_temp.begin_call(%L::jsonb)',pg_temp.packet(run)),'accounting dispatch stopped'),'halt refuses next transport');
 perform pg_temp.ok((select count(*)=count_before from public.audit_ledger),'halt refusal no new receipt');
 update public.kill_switch_state set engaged=false where tenant_id=(run->>'tenant_id')::uuid;
 update public.tenant_users set role='viewer' where tenant_id=(run->>'tenant_id')::uuid and user_id=pg_temp.id(1);
 perform pg_temp.ok(pg_temp.denied(format('select pg_temp.begin_call(%L::jsonb)',pg_temp.packet(run)),'accounting actor refused'),'revoked role refuses next transport');
 p:=p||jsonb_build_object('state','failed','failure_code','gateway_unavailable','content_sha256',null,'planned',null,'serving',null,'commitments',null,'attempts',null,
  'usage',jsonb_build_object('availability','unavailable','input_tokens',null,'output_tokens',null,'total_tokens',null),
  'pricing',jsonb_build_object('basis','unavailable','scope','successful_response_only','config_sha256',null,'estimate_usd',null));
 perform pg_temp.finish_call(p);e:=pg_temp.fail_run(run);
 result:=public.seal_model_accounting_run((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256',run->>'started',e);
 perform pg_temp.ok(pg_temp.settle(run,e,0,0,0,'failed')->>'error'='model_accounting_projection_conflict','failed unknown usage cannot be forged aszero');
 perform pg_temp.ok(pg_temp.settle(run,e,null,null,null,'failed')->>'status'='failed','honest nullable failure settlement succeeds');
 perform pg_temp.ok((select input_tokens is null and output_tokens is null and total_tokens is null and cost_usd is null from public.agent_runs where id=(run->>'run_id')::uuid),'retained row preserves unknown counters');
 perform pg_temp.ok(result->'summary'->>'basis'='unknown','real failed terminal preserves unknown accounting');
 perform pg_temp.ok(result->'summary'->'total_tokens'='null'::jsonb and result->'summary'->'estimate_usd'='null'::jsonb,'failed usage and pricing remain null');
 perform pg_temp.ok(public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256')->'seal'=result,'independent full seal read matches retained source');
 raise notice 'ACCOUNTING_RESULT_INTEROP=%',public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256');
 raise notice 'ACCOUNTING_INTEROP=%',jsonb_build_object('binding',run-array['requested_receipt','started','claimed'],'requestedReceipt',run->'requested_receipt','agentStartedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,(run->>'started')::bigint),'agentCompletedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,e::bigint),'seal',result);
 update public.tenant_users set role='owner' where tenant_id=(run->>'tenant_id')::uuid and user_id=pg_temp.id(1);
 set constraints all immediate;set constraints all deferred;
end $$;

-- A completed provider response without vendor counters is functional output,
-- but still has unknown usage/cost. Success must retain nullable accounting.
do $$declare run jsonb;p jsonb;result jsonb;e text;begin
 run:=pg_temp.open_run();p:=pg_temp.packet(run);perform pg_temp.begin_call(p);
 p:=p||jsonb_build_object('usage',jsonb_build_object('availability','unavailable','input_tokens',null,'output_tokens',null,'total_tokens',null),
  'pricing',jsonb_build_object('basis','unavailable','scope','successful_response_only','config_sha256',repeat('2',64),'estimate_usd',null));
 perform pg_temp.finish_call(p);e:=pg_temp.complete_run(run);
 result:=public.seal_model_accounting_run((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256',run->>'started',e);
 perform pg_temp.ok(result->'summary'->>'basis'='unknown','missing vendor usage remains unknown on success');
 perform pg_temp.ok(pg_temp.settle(run,e,0,0,0)->>'error'='model_accounting_projection_conflict','completed response cannot invent missing usage aszero');
 perform pg_temp.ok(pg_temp.settle(run,e,null,null,null)->>'status'='succeeded','successful unknown counters settle asnullable');
 perform pg_temp.ok((select status='succeeded' and input_tokens is null and output_tokens is null and total_tokens is null and cost_usd is null from public.agent_runs where id=(run->>'run_id')::uuid),'successful retained row keeps unavailable counters null');
 perform pg_temp.ok(public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256')->'seal'=result,'independent full seal read matches retained source');
 raise notice 'ACCOUNTING_RESULT_INTEROP=%',public.read_model_accounting_result((run->>'tenant_id')::uuid,(run->>'run_id')::uuid,run->>'request_sha256');
 raise notice 'ACCOUNTING_INTEROP=%',jsonb_build_object('binding',run-array['requested_receipt','started','claimed'],'requestedReceipt',run->'requested_receipt','agentStartedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,(run->>'started')::bigint),'agentCompletedReceipt',controller_security.accounting128_receipt((run->>'tenant_id')::uuid,e::bigint),'seal',result);
 set constraints all immediate;set constraints all deferred;
end $$;

-- Schema null/bool/PII and mismatched source are refused before any append.
do $$declare run jsonb;p jsonb;x jsonb;before_count bigint;begin
 run:=pg_temp.open_run();p:=pg_temp.packet(run);select count(*) into before_count from public.audit_ledger;
 foreach x in array array[
  p||'{"state":null}'::jsonb,p||'{"failure_code":null,"state":"failed"}'::jsonb,
  p||'{"prompt":"accounting-secret@example.invalid"}'::jsonb,
  jsonb_set(p,'{usage,input_tokens}','true'::jsonb),jsonb_set(p,'{usage,total_tokens}','11'::jsonb),
  jsonb_set(p,'{serving,model}',to_jsonb('secret@example.invalid'::text)),
  jsonb_set(p,'{pricing,estimate_usd}',to_jsonb('0.0000000000010'::text))] loop
  perform pg_temp.ok(controller_security.accounting128_outcome(x) is distinct from true,'strict metadata codec refusal');
 end loop;
 perform pg_temp.ok(pg_temp.denied(format('select pg_temp.begin_call(%L::jsonb)',jsonb_set(p,'{tenant_id}',to_jsonb(pg_temp.id(3)::text))), 'accounting dispatch refused'),'cross-tenant run refused');
 perform pg_temp.ok((select count(*)=before_count from public.audit_ledger),'refusal appends zero');
end $$;

-- Direct append cannot claim a call without its owned durable row.
do $$begin
 perform pg_temp.ok(pg_temp.denied($cmd$do $inner$ begin
  perform public.append_ledger(pg_temp.id(2),gen_random_uuid(),'system','model-accounting-controller',null,null,null,
   'agent.model.call.started',gen_random_uuid()::text,repeat('a',64),null,null,null,null,null,'pending','{}');
  set constraints all immediate;
 end $inner$;$cmd$,'accounting orphan receipt refused'),'orphan ledger append refused');
end $$;
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.id(2))),'actual chain integrity tenant A');
select pg_temp.ok((select count(*)=0 from public.verify_ledger(pg_temp.id(3))),'actual chain integrity tenant B');
set constraints all immediate;
rollback;
