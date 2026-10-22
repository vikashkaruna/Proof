-- W4.7 authenticated (signed-in) website connector. A human-triggered,
-- read-only crawl of a reviewed site behind a login, using a credential held
-- only in protected deployment configuration. Like public website checks, raw
-- HTML and field values are never retained: only page paths, titles, content
-- digests, form field names and observed rights/consent links.
alter table public.connector_descriptors drop constraint if exists connector_descriptors_transport_check;
alter table public.connector_descriptors add constraint connector_descriptors_transport_check
  check (transport in ('rest','sql','graphql','mcp','web'));

create table public.authenticated_website_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  connector_id uuid not null,
  actor_id uuid not null,
  correlation_id uuid not null,
  base_url text not null check (length(base_url) between 1 and 2048),
  status text not null check (status in ('checked','failed')),
  result jsonb,
  error_code text check (error_code ~ '^[a-z0-9_]{1,80}$'),
  checked_at timestamptz not null default now(),
  unique (tenant_id,correlation_id),
  foreign key (tenant_id,connector_id) references public.connectors(tenant_id,id) on delete restrict,
  check (
    (status='checked' and jsonb_typeof(result)='object' and error_code is null)
    or (status='failed' and result is null and error_code is not null)
  ),
  check (
    status='failed' or (
      result ?& array['version','baseUrl','authMode','pages','skipped','evidence']
      and result->>'version'='authenticated-website-scan/1'
      and result->>'baseUrl'=base_url
      and result->>'authMode' in ('form_login','bearer','basic')
      and case when jsonb_typeof(result->'pages')='array'
        then jsonb_array_length(result->'pages') between 1 and 25 else false end
      and case when jsonb_typeof(result->'skipped')='array'
        then jsonb_array_length(result->'skipped')<=200 else false end
      and jsonb_typeof(result->'evidence')='object'
    )
  ),
  check (result is null or octet_length(result::text) <= 131072)
);
create index authenticated_website_checks_recent
  on public.authenticated_website_checks(tenant_id,connector_id,checked_at desc);
alter table public.authenticated_website_checks enable row level security;
revoke all on public.authenticated_website_checks from public,anon,authenticated,service_role,human_action_writer;
grant select on public.authenticated_website_checks to service_role;
create policy bff_read on public.authenticated_website_checks for select to service_role using (true);
-- Same reviewed global-founder read as every other tenant relation (0181),
-- through the same predicate; the table still has no browser grant.
create policy founder181_global_read on public.authenticated_website_checks
  for select to authenticated using (public.platform_founder_visibility_allowed());
create trigger authenticated_website_no_update before update on public.authenticated_website_checks
  for each row execute function public.evidence_receipt_immutable();
create trigger authenticated_website_no_delete before delete on public.authenticated_website_checks
  for each row execute function public.evidence_receipt_immutable();
create trigger authenticated_website_no_truncate before truncate on public.authenticated_website_checks
  for each statement execute function public.evidence_receipt_immutable();

create function public.record_authenticated_website_check(
  p_tenant_id uuid,p_actor_id uuid,p_connector_id uuid,p_correlation_id uuid,
  p_base_url text,p_status text,p_result jsonb,p_error_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.authenticated_website_checks;
begin
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin') for share;
  if not found then raise exception 'connector manager required' using errcode='42501'; end if;
  -- Only an active registration of a reviewed web descriptor can carry a check.
  perform 1 from public.connectors c
    join public.connector_descriptors d on d.id=c.descriptor_id and d.target_binding=c.target_binding
    join public.estate_systems s on (s.tenant_id,s.id)=(c.tenant_id,c.system_id)
    join public.estates e on (e.tenant_id,e.id)=(s.tenant_id,s.estate_id)
    where c.tenant_id=p_tenant_id and c.id=p_connector_id and c.status='active'
      and s.status='active' and e.status='active' and d.transport='web'
    for share of c;
  if not found then raise exception 'active website connector required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('checked','failed') then
    raise exception 'invalid website check status' using errcode='22023';
  end if;
  insert into public.authenticated_website_checks
    (tenant_id,connector_id,actor_id,correlation_id,base_url,status,result,error_code)
    values(p_tenant_id,p_connector_id,p_actor_id,p_correlation_id,p_base_url,p_status,p_result,p_error_code)
    returning * into r;
  perform public.append_ledger(
    p_tenant_id,p_correlation_id,'human'::public.actor_type,p_actor_id::text,null,null,null,
    'connector.website.checked'::public.ledger_action_type,r.id::text,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_base_url,'UTF8')),'hex'),
    case when p_result is null then null else
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_result::text,'UTF8')),'hex') end,
    null,null,null,null,
    (case when p_status='checked' then 'success' else 'failure' end)::public.ledger_result,
    jsonb_build_object('status',p_status,'error_code',p_error_code,'connector_id',p_connector_id,
      'kind','authenticated_website')
  );
  return to_jsonb(r);
end $$;
revoke all on function public.record_authenticated_website_check(uuid,uuid,uuid,uuid,text,text,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_authenticated_website_check(uuid,uuid,uuid,uuid,text,text,jsonb,text)
  to human_action_writer;
