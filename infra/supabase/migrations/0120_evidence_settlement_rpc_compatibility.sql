-- Restore the named PostgREST contract used by legacy human evidence uploads.
-- 0119 is immutable. Its source isolation checks remain unchanged.
begin;
alter function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid)
  set schema controller_security;
alter function controller_security.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid)
  rename to settle_evidence_ingest_before_120;
revoke all on function controller_security.settle_evidence_ingest_before_120(uuid,uuid,uuid,jsonb,uuid)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create function public.settle_evidence_ingest(p_tenant_id uuid,p_actor_id uuid,p_operation_id uuid,p_receipt jsonb,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r public.evidence_ingestions;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden');end if;
 select * into r from public.evidence_ingestions where tenant_id=p_tenant_id and id=p_operation_id for update;
 if not found then return jsonb_build_object('error','operation_not_found');end if;
 if exists(select 1 from public.saakshi119_sources where operation_id=p_operation_id) then return jsonb_build_object('error','dedicated_saakshi_finalizer_required');end if;
 return controller_security.settle_evidence_ingest_before_119(p_tenant_id,p_actor_id,p_operation_id,p_receipt,p_correlation_id);
end $$;

revoke all on function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) to evidence_ingestion_writer;

-- Keep the security definer owned by the same migration authority.
do $$
declare owner_name text;
begin
 select pg_get_userbyid(proowner) into owner_name from pg_proc
 where oid='controller_security.settle_evidence_ingest_before_120(uuid,uuid,uuid,jsonb,uuid)'::regprocedure;
 execute format('alter function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) owner to %I',owner_name);
end $$;
notify pgrst, 'reload schema';
commit;
