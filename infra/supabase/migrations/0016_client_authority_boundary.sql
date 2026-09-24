-- W0 / R-01, R-02: browser credentials are not backend write credentials.
-- 0015 is reserved for the analyst enum change already in progress.
-- Applied forward only; do not edit the original migration history.
begin;

-- RLS does not protect TRUNCATE and a permissive FOR ALL policy also grants
-- visibility. Close privileges as well as policies, including future objects.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema auth from anon, authenticated, ledger_writer;
revoke all on all sequences in schema auth from anon, authenticated, ledger_writer;
alter default privileges in schema auth revoke all on tables from anon, authenticated, ledger_writer;

-- An internal employee flag is NOT cross-client authority. All tenant reads
-- require an explicit membership, independent of the active-tenant JWT claim.
create or replace function public.has_tenant_role(check_tenant uuid, allowed_roles user_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_users
    where tenant_id = check_tenant and user_id = auth.uid() and role = any(allowed_roles)
  );
$$;

-- Replace tenant-domain policies, including old FOR ALL policies whose USING
-- clauses unintentionally exposed rows outside a user's memberships.
do $$
declare t text; p record;
begin
  foreach t in array array[
    'engagements', 'findings', 'evidence', 'finding_evidence',
    'remediation_plans', 'remediation_actions', 'approval_tokens',
    'audit_ledger', 'tenant_ledger_counters', 'agent_runs', 'dsars',
    'breaches', 'reports', 'compliance_events'
  ] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy tenant_member_read on public.%I for select to authenticated using (public.is_tenant_member(tenant_id))', t);
  end loop;
end $$;

drop policy tenants_select_member on public.tenants;
drop policy tenants_insert_axiom_only on public.tenants;
drop policy tenants_update_axiom_or_owner on public.tenants;
create policy tenants_member_read on public.tenants for select to authenticated
  using (public.is_tenant_member(id));

drop policy tenant_users_select_member on public.tenant_users;
drop policy tenant_users_modify_axiom_or_owner on public.tenant_users;
create policy tenant_users_member_read on public.tenant_users for select to authenticated
  using (user_id = auth.uid() or public.is_tenant_member(tenant_id));

drop policy users_select_self_or_tenant_member on public.users;
drop policy users_update_self_or_axiom on public.users;
create policy users_read_self_or_colleague on public.users for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.tenant_users membership
    where membership.user_id = users.id and public.is_tenant_member(membership.tenant_id)
  )
);
create policy users_update_self on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Profile bootstrap is the only direct client write retained. Column privileges
-- protect the internal flag on INSERT as well as UPDATE, including upserts.
grant insert (id, email, full_name), update (id, email, full_name) on public.users to authenticated;

drop policy approval_token_usages_select_member on public.approval_token_usages;
drop policy approval_token_usages_insert_system on public.approval_token_usages;
create policy token_usages_member_read on public.approval_token_usages for select to authenticated using (
  exists (select 1 from public.approval_tokens t where t.id = token_id and public.is_tenant_member(t.tenant_id))
);

-- Privileged metadata and reference publication always go through the API.
-- Leaving their old write policies in place would be misleading even though
-- table privileges already deny the operation.
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and tablename <> 'users'
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

grant select on all tables in schema public to authenticated;
grant select on public.controls, public.control_libraries to anon;
grant execute on function public.is_tenant_member(uuid), public.is_axiom_internal(),
  public.current_tenant_id(), public.current_tenant_roles(), public.has_role(user_role[]),
  public.has_tenant_role(uuid, user_role[]), public.storage_path_tenant(text) to authenticated;

-- No authenticated storage mutations bypass the BFF permission gate either.
drop policy tenant_logos_write_member on storage.objects;
drop policy report_attachments_write_reviewer on storage.objects;
drop policy marketing_write_axiom on storage.objects;
revoke insert, update, delete, truncate on storage.objects from anon, authenticated;

-- append_ledger remains the sole backend ledger mutation path. Preserve the
-- dedicated INSERT-only ledger_writer role and the SECURITY DEFINER function.
revoke insert, update, delete, truncate on public.audit_ledger from service_role;
revoke all on public.tenant_ledger_counters from service_role;
grant select on public.tenant_ledger_counters to service_role;
grant execute on all functions in schema public to service_role;

commit;
