-- ─────────────────────────────────────────────────────────────────────
-- reset-demo-sectors.sql
--
-- Removes the three fictitious demo companies written by
-- seed-demo-sectors.sql, and nothing else, so they can be re-seeded after
-- a schema or fixture change. LOCAL / DEV DATABASES ONLY; run through
-- `scripts/seed-demo-sectors.sh --reset`.
--
-- The demo tenants carry append-only ledger rows and immutable receipts,
-- which the database protects with triggers. This script disables triggers
-- for its own transaction (session_replication_role = replica) and deletes
-- ONLY rows whose tenant_id is a demo tenant (slug 'demo-%' AND is_demo).
-- Never adapt it for a tenant that holds real data.
-- ─────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;

do $$
declare
  ids uuid[];
  r record;
  n bigint;
begin
  select array_agg(id) into ids from public.tenants
   where slug in ('demo-kosha-bfsi', 'demo-sanjeevani-health', 'demo-nimbus-saas') and is_demo;
  if ids is null then
    raise notice 'no demo tenants present; nothing to reset';
    return;
  end if;
  for r in
    select c.table_schema, c.table_name
      from information_schema.columns c
      join information_schema.tables t using (table_schema, table_name)
     where c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
       and c.table_schema in ('public', 'controller_security')
       and c.table_name <> 'tenants'
  loop
    execute format('delete from %I.%I where tenant_id = any($1)', r.table_schema, r.table_name) using ids;
    get diagnostics n = row_count;
    if n > 0 then raise notice 'removed % row(s) from %.%', n, r.table_schema, r.table_name; end if;
  end loop;
  delete from public.tenants where id = any(ids);
  raise notice 'removed % demo tenant(s)', array_length(ids, 1);
end $$;

commit;
