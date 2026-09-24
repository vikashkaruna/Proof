-- Managed/self-hosted PostgreSQL creates service_role WITHOUT BYPASSRLS.
-- Explicit policies provide the BFF's existing administrative data authority
-- without requiring a superuser attribute. No client receives new privileges.
-- Ledger INSERT/UPDATE/DELETE remain revoked by 0016; policies cannot grant
-- a table privilege. append_ledger remains the sole ledger mutation path.
begin;
do $$
declare target record;
begin
  for target in
    select n.nspname, c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('create policy bff_service_access on %I.%I for all to service_role using (true) with check (true)',
      target.nspname, target.relname);
  end loop;
end $$;
commit;
