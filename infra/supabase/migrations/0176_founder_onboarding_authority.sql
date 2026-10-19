-- Preserve live founder access during atomic onboarding. The 0151 tenant
-- trigger derives founder memberships before the 0018 owner insert runs.
-- This append-only repair keeps those rows derived and accounts for founder
-- creations independently of global access. No historical membership rewrite,
-- founder designation, client-owner acceptance, or approval bypass occurs.
begin;

alter table public.tenant_onboarding_intakes
  add column creation_authority text not null default 'owner'
  check (creation_authority in ('owner','platform_founder'));

-- Existing intake rows were created through the ordinary owner path; preserve
-- that history. New founder-created receipts cannot be rewritten/deleted to
-- recover a creation quota slot. Other existing intake fields remain separate.
create function public.guard_onboarding_creation_authority()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then
    if old.creation_authority='platform_founder' then
      raise exception 'founder onboarding creation receipt is retained' using errcode='42501';
    end if;
    return old;
  end if;
  if new.creation_authority is distinct from old.creation_authority
    or new.submitted_by is distinct from old.submitted_by
    or new.tenant_id is distinct from old.tenant_id then
    raise exception 'onboarding creation authority is immutable' using errcode='42501';
  end if;
  return new;
end $$;
create trigger tenant_onboarding_creation_authority_guard
  before update or delete on public.tenant_onboarding_intakes
  for each row execute function public.guard_onboarding_creation_authority();
revoke all on function public.guard_onboarding_creation_authority() from public,anon,authenticated,service_role;

create or replace function public.onboard_organization(
  p_user_id uuid,p_slug text,p_name text,p_tier public.tenant_tier,
  p_is_sdf boolean,p_processes_health_data boolean,p_processes_children_data boolean,
  p_dpo_name text,p_dpo_email text,p_systems jsonb,p_library_version text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  entitlement public.onboarding_entitlements;
  tenant public.tenants;
  engagement public.engagements;
  actor_internal boolean;
  actor_designated boolean;
  actor_founder boolean;
  creation_authority text;
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
  -- Pin the actor's real designation and profile until transaction completion.
  -- A revoked designation/internal-flag withdrawal serializes behind these
  -- locks; an internal flag alone never becomes founder authority.
  select u.is_axiom_internal into actor_internal
    from public.users u where u.id=p_user_id for share;
  select f.revoked_at is null into actor_designated
    from public.platform_founders f where f.user_id=p_user_id for share;
  actor_founder := coalesce(actor_internal and actor_designated, false);
  creation_authority := case when actor_founder then 'platform_founder' else 'owner' end;

  -- Ordinary owners keep the current-owner quota semantics. A founder's
  -- global derived access consumes no creation slots, but their own retained
  -- creations do, even after designation revocation/internal-flag withdrawal.
  -- UNION deduplicates an independently accepted owner membership later.
  if (select count(*) from (
      select m.tenant_id from public.tenant_users m where m.user_id=p_user_id and m.role='owner'
      union
      select i.tenant_id from public.tenant_onboarding_intakes i
        where i.submitted_by=p_user_id and i.creation_authority='platform_founder'
    ) owned_or_created) >= entitlement.max_owned_tenants then
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
  if actor_founder then
    -- 0151 has already derived this row from the actual live designation.
    -- Preserve founder report/review authority and its live-revocation source.
    -- Never turn access derivation into explicit client ownership/consent.
    if not exists (select 1 from public.tenant_users m
      where m.tenant_id=tenant.id and m.user_id=p_user_id
        and m.role='founder' and m.membership_source='platform_founder') then
      raise exception 'onboarding founder membership derivation not confirmed' using errcode='42501';
    end if;
  else
    -- No generic conflict suppression: a contradictory membership is refused
    -- and the entire tenant/intake/engagement/ledger transaction rolls back.
    insert into public.tenant_users(tenant_id,user_id,role,accepted_at)
      values(tenant.id,p_user_id,'owner',now());
  end if;
  insert into public.engagements(tenant_id,library_version,title,lead_reviewer_id)
    values(tenant.id,p_library_version,p_name || ' — DPDPA Statutory Assessment',p_user_id) returning * into engagement;
  insert into public.tenant_onboarding_intakes(tenant_id,submitted_by,dpo_name,dpo_email,proposed_systems,creation_authority)
    values(tenant.id,p_user_id,p_dpo_name,p_dpo_email,coalesce(p_systems,'[]'::jsonb),creation_authority);
  perform public.append_ledger(tenant.id,p_correlation_id,'human',p_user_id::text,null,null,null,
    'tenant.created',tenant.id::text,null,null,null,null,null,null,'success',
    jsonb_build_object('tier',p_tier,'engagement_id',engagement.id,'library_version',p_library_version,
      'creation_authority',creation_authority,
      'entitlement_granted_by',entitlement.granted_by,'proposed_system_count',jsonb_array_length(coalesce(p_systems,'[]'::jsonb))));
  return jsonb_build_object('tenant',to_jsonb(tenant),'engagement',to_jsonb(engagement),
    'intake',jsonb_build_object('proposed_system_count',jsonb_array_length(coalesce(p_systems,'[]'::jsonb)),'status','pending_estate_setup'));
end $$;
revoke all on function public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid)
  to human_action_writer;
commit;
