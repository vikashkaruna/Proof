-- Public website content checks are human-triggered, tenant-scoped observations.
-- Raw HTML is never retained; the bounded metadata and content digest are.
alter type public.ledger_action_type add value if not exists 'connector.website.checked';

create table public.public_website_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  actor_id uuid not null,
  correlation_id uuid not null,
  requested_url text not null check (length(requested_url) between 1 and 2048),
  final_url text check (final_url is null or length(final_url) between 1 and 2048),
  status text not null check (status in ('checked','failed')),
  result jsonb,
  error_code text check (error_code ~ '^[a-z0-9_]{1,80}$'),
  checked_at timestamptz not null default now(),
  unique (tenant_id,correlation_id),
  check (
    (status='checked' and jsonb_typeof(result)='object' and error_code is null and final_url is not null)
    or (status='failed' and result is null and error_code is not null)
  ),
  check (result is null or octet_length(result::text) <= 32768)
);
create index public_website_checks_recent on public.public_website_checks(tenant_id,checked_at desc);
alter table public.public_website_checks enable row level security;
revoke all on public.public_website_checks from public,anon,authenticated,service_role,human_action_writer;
grant select on public.public_website_checks to service_role;
create policy bff_read on public.public_website_checks for select to service_role using (true);

create function public.record_public_website_check(
  p_tenant_id uuid,p_actor_id uuid,p_correlation_id uuid,p_requested_url text,
  p_final_url text,p_status text,p_result jsonb,p_error_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.public_website_checks;
begin
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then raise exception 'connector manager required' using errcode='42501'; end if;
  if p_status not in ('checked','failed') or p_status is null then
    raise exception 'invalid website check status' using errcode='22023';
  end if;
  insert into public.public_website_checks
    (tenant_id,actor_id,correlation_id,requested_url,final_url,status,result,error_code)
    values(p_tenant_id,p_actor_id,p_correlation_id,p_requested_url,p_final_url,p_status,p_result,p_error_code)
    returning * into r;
  perform public.append_ledger(
    p_tenant_id,p_correlation_id,'human'::public.actor_type,p_actor_id::text,null,null,null,
    'connector.website.checked'::public.ledger_action_type,r.id::text,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_requested_url,'UTF8')),'hex'),
    case when p_result is null then null else
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_result::text,'UTF8')),'hex') end,
    null,null,null,null,
    (case when p_status='checked' then 'success' else 'failure' end)::public.ledger_result,
    jsonb_build_object('status',p_status,'error_code',p_error_code)
  );
  return to_jsonb(r);
end $$;
revoke all on function public.record_public_website_check(uuid,uuid,uuid,text,text,text,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_public_website_check(uuid,uuid,uuid,text,text,text,jsonb,text)
  to human_action_writer;
