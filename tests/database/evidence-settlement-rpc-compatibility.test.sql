-- PostgREST resolves RPCs by argument names, not just positional signatures.
begin;
do $$
declare f pg_proc; r text;
begin
 select * into f from pg_proc where oid='public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid)'::regprocedure;
 if f.proargnames is distinct from array['p_tenant_id','p_actor_id','p_operation_id','p_receipt','p_correlation_id']::text[] then
  raise exception 'Legacy PostgREST parameter names changed';
 end if;
 if not f.prosecdef or not ('search_path=""'=any(f.proconfig)) or not ('lock_timeout=5s'=any(f.proconfig)) then
  raise exception 'Settlement security settings changed';
 end if;
 if f.proowner is distinct from (select proowner from pg_proc where oid='controller_security.settle_evidence_ingest_before_120(uuid,uuid,uuid,jsonb,uuid)'::regprocedure) then
  raise exception 'Settlement owner changed';
 end if;
 foreach r in array array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer'] loop
  if has_function_privilege(r,f.oid,'execute') or has_function_privilege(r,'controller_security.settle_evidence_ingest_before_120(uuid,uuid,uuid,jsonb,uuid)','execute') then
   raise exception 'Unscoped settlement execution granted to %',r;
  end if;
 end loop;
 if not has_function_privilege('evidence_ingestion_writer',f.oid,'execute') or has_function_privilege('evidence_ingestion_writer','controller_security.settle_evidence_ingest_before_120(uuid,uuid,uuid,jsonb,uuid)','execute') then
  raise exception 'Evidence writer boundary changed';
 end if;
end $$;
set local role evidence_ingestion_writer;
do $$
begin
 if public.settle_evidence_ingest(
  p_tenant_id=> '99200000-0000-4000-8000-000000000001'::uuid,
  p_actor_id=> '99200000-0000-4000-8000-000000000002'::uuid,
  p_operation_id=> '99200000-0000-4000-8000-000000000003'::uuid,
  p_receipt=> '{}'::jsonb,
  p_correlation_id=> '99200000-0000-4000-8000-000000000004'::uuid
 )->>'error' is distinct from 'forbidden' then
  raise exception 'Named RPC bypassed current actor authority';
 end if;
end $$;
rollback;
