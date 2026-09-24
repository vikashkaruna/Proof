-- W0.1 — the minimum a self-hosted Supabase needs before GoTrue starts.
--
-- On Supabase Cloud the platform creates the roles and the `auth` schema
-- before GoTrue ever runs. Self-hosting against a plain managed Postgres means
-- we do it, and the ORDER matters more than it looks:
--
--   1. this file          roles, and an EMPTY `auth` schema
--   2. GoTrue starts      runs its own 54 migrations and owns `auth`
--   3. the series         0000's `create table if not exists auth.users`
--                         is then a no-op over GoTrue's own definition
--   4. PostgREST starts
--
-- Migration 0000 is written for "vanilla Cloud SQL / onprem PostgreSQL" and
-- creates a hand-rolled `auth.users` itself, which is right when there is no
-- GoTrue — the SQL test harness has none. It is wrong when there is one:
-- GoTrue then finds tables it did not create and its own migration chain
-- fails partway. Running GoTrue first makes both paths work without changing
-- an applied migration.
--
-- GoTrue's connection MUST carry `search_path=auth`. Its MFA migration creates
-- the `factor_type` and `factor_status` enums UNQUALIFIED, so without it they
-- are created in `public` and a later migration fails on
-- `type "auth.factor_type" does not exist`, having already created sixteen
-- tables. That failure is silent about its cause and looks like a schema
-- conflict rather than a search_path one.
begin;

do $$ begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'authenticator') then
    create role authenticator nologin noinherit;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'ledger_writer') then
    create role ledger_writer nologin;
  end if;
end $$;

grant anon to authenticator;
grant authenticated to authenticator;
grant service_role to authenticator;

-- Empty. GoTrue fills it.
create schema if not exists auth;

-- ─── The storage contract migration 0007 writes against ──────────────
-- Migration 0007 inserts bucket rows and defines RLS policies on
-- `storage.objects`. On Supabase Cloud those tables come from the Storage
-- service; self-hosting does not deploy it, so without this the series stops
-- at 0007 with `relation "storage.buckets" does not exist`.
--
-- These are the same minimal definitions the SQL test harness uses. They are a
-- SCHEMA CONTRACT, not a storage backend: nothing serves these buckets until
-- supabase/storage-api is deployed alongside GoTrue and PostgREST. The
-- evidence vault is unaffected — it writes to GCS through the S3 API and never
-- touches Supabase Storage.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text
);

alter table storage.objects enable row level security;

commit;
