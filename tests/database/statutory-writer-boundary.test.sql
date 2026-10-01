-- Shared agent-runtime service_role may read source-bound evidence, but cannot
-- fabricate review, storage receipts, release, or Pramaan seals by direct RPC.
begin;
do $$
declare
  signature text;
  functions text[] := array[
    'public.request_dpb_report(uuid,uuid,uuid,uuid,uuid,text,uuid)',
    'public.record_dpb_report_draft(uuid,uuid,uuid,text,uuid)',
    'public.begin_dpb_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid)',
    'public.settle_dpb_artifact_version(uuid,uuid,uuid,text,jsonb,uuid)',
    'public.note_dpb_artifact_failure(uuid,uuid,uuid,text,uuid)',
    'public.release_dpb_report(uuid,uuid,uuid,text,text,uuid)',
    'public.request_technical_report(uuid,uuid,uuid,uuid,text,uuid)',
    'public.record_technical_report_draft(uuid,uuid,uuid,text,uuid)',
    'public.begin_technical_artifact_build(uuid,uuid,uuid,uuid,jsonb,uuid)',
    'public.settle_technical_artifact_version(uuid,uuid,uuid,text,jsonb,uuid)',
    'public.note_technical_artifact_failure(uuid,uuid,uuid,text,uuid)',
    'public.release_technical_report(uuid,uuid,uuid,text,text,uuid)',
    'public.release_report(uuid,uuid,uuid,text,text,uuid)',
    'public.begin_auditor_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)',
    'public.settle_auditor_pramaan(uuid,uuid,uuid,jsonb,uuid)',
    'public.note_auditor_pramaan_failure(uuid,uuid,uuid,text,uuid)',
    'public.seal_auditor_pramaan(uuid,uuid,uuid,text,uuid)',
    'public.begin_technical_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)',
    'public.settle_technical_pramaan(uuid,uuid,uuid,jsonb,uuid)',
    'public.note_technical_pramaan_failure(uuid,uuid,uuid,text,uuid)',
    'public.seal_technical_pramaan(uuid,uuid,uuid,text,uuid)',
    'public.begin_dpb_pramaan(uuid,uuid,uuid,uuid,text,jsonb,uuid)',
    'public.settle_dpb_pramaan(uuid,uuid,uuid,jsonb,uuid)',
    'public.note_dpb_pramaan_failure(uuid,uuid,uuid,text,uuid)',
    'public.seal_dpb_pramaan(uuid,uuid,uuid,text,uuid)'
  ];
begin
  foreach signature in array functions loop
    if to_regprocedure(signature) is null then
      raise exception 'Missing mutation RPC: %', signature;
    end if;
    if has_function_privilege('service_role',signature,'EXECUTE')
       or has_function_privilege('authenticated',signature,'EXECUTE')
       or has_function_privilege('anon',signature,'EXECUTE') then
      raise exception 'Untrusted role retains mutation RPC EXECUTE: %', signature;
    end if;
    if not has_function_privilege('statutory_proof_writer',signature,'EXECUTE') then
      raise exception 'Statutory proof writer lacks mutation RPC EXECUTE: %', signature;
    end if;
  end loop;
  if pg_has_role('service_role','statutory_proof_writer','MEMBER') then
    raise exception 'service_role inherited statutory proof writer';
  end if;
end $$;
rollback;
