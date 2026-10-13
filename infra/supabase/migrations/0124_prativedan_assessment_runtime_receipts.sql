-- Unmounted dedicated-assessment receipt authority. No ledger/table read grants.
create function public.read_prativedan_assessment_runtime_receipts(
 t uuid,k uuid,r uuid,rh text,started bigint,completed bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;s public.prativedan_assessment_sources;
 c public.prativedan_draft_claims;first public.audit_ledger;last public.audit_ledger;
begin
 q:=controller_security.prativedan123_runtime_request(t,k,r,rh);
 perform controller_security.prativedan123_validate(t,k);
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into first from public.audit_ledger where tenant_id=t and id=started;
 select * into last from public.audit_ledger where tenant_id=t and id=completed;
 if controller_security.prativedan123_runtime_valid(t,k,started,completed,last.output_hash) is distinct from true
  or first.output_hash is not null or last.output_hash is null
  or first.model_id is not null or last.model_id is not null
  or first.prompt_hash is not null or last.prompt_hash is not null
  or first.detail is distinct from jsonb_build_object('phase','started','run_id',r,'request_hash',rh,
   'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text))
  or last.detail is distinct from jsonb_build_object('phase','completed','started_entry',started::text,'run_id',r,'request_hash',rh,
   'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text))
 then raise exception 'dedicated runtime receipt proof refused' using errcode='42501';end if;
 return jsonb_build_object(
  'schema_version',2,'tenant_id',t,'engagement_id',s.engagement_id,'source_id',s.source_id,
  'assessment_run_id',s.source_id,'run_id',r,'operation_key',k,
  'source_sha256',s.source_sha256,'request_sha256',q.request_sha256,
  'runtime_normalized_input_sha256',c.runtime_normalized_input_sha256,'runtime_output_sha256',last.output_hash,
  'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text),
  'agent','prativedan','agent_version','0.1.0','correlation_id',k,'target_ref',s.engagement_id::text,
  'requested_receipt',controller_security.prativedan123_receipt(t,q.requested_receipt),
  'claimed_receipt',controller_security.prativedan123_receipt(t,c.claimed_receipt),
  'started_receipt',controller_security.prativedan123_receipt(t,started),
  'completed_receipt',controller_security.prativedan123_receipt(t,completed),
  'claim_expires_at',c.expires_at,'completed_at',last.occurred_at);
end $$;
revoke all on function public.read_prativedan_assessment_runtime_receipts(uuid,uuid,uuid,text,bigint,bigint)
 from public,anon,authenticated,service_role,human_action_writer;
grant execute on function public.read_prativedan_assessment_runtime_receipts(uuid,uuid,uuid,text,bigint,bigint)
 to agent_ledger_writer;
