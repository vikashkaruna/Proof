-- Revision 110: 0079 accepted arbitrary caller-authored statutory content
-- and attributed it to the reporting agent. Its PDF attachment RPC recorded
-- only a hash/size, without retaining or verifying an Object Lock version.
-- Close these service-role paths until a source-bound exact-byte workflow
-- replaces them. Existing rows remain for historical review; 0081 already
-- refuses publication of their unverified generated artifacts.

revoke execute on function public.record_statutory_report_draft(uuid,uuid,uuid,text,text,text,text,text,uuid) from service_role;
revoke execute on function public.attach_statutory_report_pdf(uuid,uuid,uuid,text,bigint,uuid) from service_role;
revoke insert, update on public.statutory_report_artifacts from service_role;

-- Direct authenticated reads must honor the same draft boundary as reports.
drop policy if exists statutory_artifacts_tenant_select on public.statutory_report_artifacts;
create policy statutory_artifacts_tenant_select on public.statutory_report_artifacts
  for select to authenticated
  using (
    exists (
      select 1 from public.reports r
      where r.tenant_id = statutory_report_artifacts.tenant_id
        and r.id = statutory_report_artifacts.report_id
        and public.report_visible(r.tenant_id, r.created_by, r.status)
    )
  );
