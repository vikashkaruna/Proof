-- Historical Pramaan dossiers were created from caller metadata, without an
-- evidence source or Object Lock receipt. Preserve them for internal review,
-- but prohibit new synthetic seals and external dispatch through this path.
revoke execute on function public.seal_pramaan_dossier(uuid,uuid,uuid,text,uuid)
  from service_role;
revoke execute on function public.record_report_email_dispatch(uuid,uuid,uuid,text,text,text,uuid,uuid)
  from service_role;
revoke insert, update on public.pramaan_dossiers from service_role;
revoke insert, update on public.report_email_dispatches from service_role;

-- Old rows lack a trustworthy creator identifier. Internal tenant founders
-- alone may inspect their metadata until source-bound revisions exist.
create function public.pramaan_history_visible(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_users tu
    join public.users u on u.id=tu.user_id
    where tu.tenant_id=p_tenant_id and tu.user_id=auth.uid()
      and tu.role='founder' and u.is_axiom_internal=true
  );
$$;
revoke all on function public.pramaan_history_visible(uuid) from public, anon, service_role;
grant execute on function public.pramaan_history_visible(uuid) to authenticated;

drop policy pramaan_dossiers_tenant_select on public.pramaan_dossiers;
create policy pramaan_dossiers_founder_read on public.pramaan_dossiers
  for select to authenticated using (public.pramaan_history_visible(tenant_id));

drop policy report_email_tenant_select on public.report_email_dispatches;
create policy report_email_founder_read on public.report_email_dispatches
  for select to authenticated using (public.pramaan_history_visible(tenant_id));

drop policy pramaan_dossiers_service_all on public.pramaan_dossiers;
create policy pramaan_dossiers_service_read on public.pramaan_dossiers
  for select to service_role using (true);
drop policy report_email_service_all on public.report_email_dispatches;
create policy report_email_service_read on public.report_email_dispatches
  for select to service_role using (true);
