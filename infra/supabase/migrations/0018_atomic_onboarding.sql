-- W0 SEC-5/SEC-10: only explicitly entitled humans may create organizations.
-- Creation, owner membership, intake, engagement and genesis ledger are atomic.
begin;
create table public.onboarding_entitlements (
  user_id uuid primary key references public.users(id) on delete restrict,
  max_owned_tenants integer not null check (max_owned_tenants between 1 and 100),
  allowed_tiers public.tenant_tier[] not null check (
    cardinality(allowed_tiers) > 0 and array_position(allowed_tiers,null) is null and not ('free'::public.tenant_tier = any(allowed_tiers))
  ),
  granted_by uuid not null references public.users(id) on delete restrict,
  grant_reason text not null check (length(trim(grant_reason)) >= 8),
  valid_until timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.tenant_onboarding_intakes (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  submitted_by uuid not null references public.users(id) on delete restrict,
  dpo_name text,
  dpo_email text,
  -- Proposed inventory only. W3 normalizes and verifies these into estate
  -- systems; accepting a name here never claims the system is connected.
  proposed_systems jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_systems) = 'array'),
  created_at timestamptz not null default now()
);
create table public.request_rate_limits (
  bucket text not null,
  subject text not null,
  attempts integer not null check (attempts > 0),
  window_ends_at timestamptz not null,
  primary key (bucket, subject)
);
alter table public.onboarding_entitlements enable row level security;
alter table public.tenant_onboarding_intakes enable row level security;
alter table public.request_rate_limits enable row level security;
revoke all on public.onboarding_entitlements, public.tenant_onboarding_intakes, public.request_rate_limits from public, anon, authenticated;
grant select,insert,update on public.onboarding_entitlements to service_role;
grant select,insert on public.tenant_onboarding_intakes to service_role;
grant select,insert,update,delete on public.request_rate_limits to service_role;

-- Each call commits independently of the business transaction, so failing
-- business requests count too. Parameters come from the BFF, never the client.
create function public.take_rate_limit(p_bucket text,p_subject text,p_limit integer,p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.request_rate_limits; v_now timestamptz := clock_timestamp();
begin
  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400
     or length(p_bucket) not between 1 and 100 or length(p_subject) not between 1 and 256 then
    raise exception 'Invalid rate limit configuration';
  end if;
  insert into public.request_rate_limits as limits(bucket,subject,attempts,window_ends_at)
    values(p_bucket,p_subject,1,v_now+make_interval(secs=>p_window_seconds))
    on conflict (bucket,subject) do update set
      attempts = case when limits.window_ends_at <= v_now then 1 else least(limits.attempts+1,p_limit+1) end,
      window_ends_at = case when limits.window_ends_at <= v_now then v_now+make_interval(secs=>p_window_seconds) else limits.window_ends_at end
    returning * into r;
  return jsonb_build_object('allowed',r.attempts <= p_limit,'retry_after',greatest(1,ceil(extract(epoch from r.window_ends_at-v_now))));
end $$;

create function public.onboard_organization(
  p_user_id uuid,p_slug text,p_name text,p_tier public.tenant_tier,
  p_is_sdf boolean,p_processes_health_data boolean,p_processes_children_data boolean,
  p_dpo_name text,p_dpo_email text,p_systems jsonb,p_library_version text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare entitlement public.onboarding_entitlements; tenant public.tenants; engagement public.engagements;
begin
  -- Lock the entitlement before counting, so simultaneous requests with
  -- DIFFERENT idempotency keys cannot both consume the last quota slot.
  select * into entitlement from public.onboarding_entitlements where user_id=p_user_id for update;
  if not found or entitlement.revoked_at is not null or entitlement.valid_until <= now() then
    return jsonb_build_object('error','onboarding_not_entitled');
  end if;
  if p_tier is null or not (p_tier = any(entitlement.allowed_tiers)) then
    return jsonb_build_object('error','tier_not_entitled');
  end if;
  if (select count(*) from public.tenant_users where user_id=p_user_id and role='owner') >= entitlement.max_owned_tenants then
    return jsonb_build_object('error','tenant_quota_exceeded');
  end if;
  -- Match the deployed library exactly; never silently pin a stale baseline
  -- or create a tenant without its initial assessment.
  if not exists (select 1 from public.control_libraries l where l.version=p_library_version and l.is_current
      and l.control_count > 0 and l.control_count=(select count(*) from public.controls c where c.library_version=l.version)) then
    return jsonb_build_object('error','library_not_published');
  end if;
  insert into public.tenants(slug,name,tier,is_sdf,processes_health_data,processes_children_data)
    values(p_slug,p_name,p_tier,p_is_sdf,p_processes_health_data,p_processes_children_data) returning * into tenant;
  insert into public.tenant_users(tenant_id,user_id,role,accepted_at)
    values(tenant.id,p_user_id,'owner',now());
  insert into public.engagements(tenant_id,library_version,title,lead_reviewer_id)
    values(tenant.id,p_library_version,p_name || ' — DPDPA Statutory Assessment',p_user_id) returning * into engagement;
  insert into public.tenant_onboarding_intakes(tenant_id,submitted_by,dpo_name,dpo_email,proposed_systems)
    values(tenant.id,p_user_id,p_dpo_name,p_dpo_email,coalesce(p_systems,'[]'::jsonb));
  perform public.append_ledger(tenant.id,p_correlation_id,'human',p_user_id::text,null,null,null,
    'tenant.created',tenant.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('tier',p_tier,'engagement_id',engagement.id,'library_version',p_library_version,
      'entitlement_granted_by',entitlement.granted_by,'proposed_system_count',jsonb_array_length(coalesce(p_systems,'[]'::jsonb))));
  return jsonb_build_object('tenant',to_jsonb(tenant),'engagement',to_jsonb(engagement),
    'intake',jsonb_build_object('proposed_system_count',jsonb_array_length(coalesce(p_systems,'[]'::jsonb)),'status','pending_estate_setup'));
end $$;
revoke all on function public.take_rate_limit(text,text,integer,integer),
  public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.take_rate_limit(text,text,integer,integer),
  public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid) to service_role;
commit;
