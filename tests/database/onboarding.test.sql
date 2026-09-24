begin;
create function pg_temp.check_result(actual text,expected text) returns void language plpgsql as $$
begin if actual is distinct from expected then raise exception 'Expected %, got %',expected,actual; end if; end $$;
insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000061','onboard@test.invalid');
insert into public.users(id,email) values('00000000-0000-0000-0000-000000000061','onboard@test.invalid');
-- Publication fixture: completeness, not legal correctness, is under test.
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current)
 values('test-onboarding',now(),'test','fixture',1,true);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('TEST','test-onboarding','Test','Test','GOV','low','[]','[]','[]','{}','{}','test-onboarding');
create function pg_temp.onboard(tier public.tenant_tier default 'growth',library text default 'test-onboarding') returns jsonb language sql as $$
 select public.onboard_organization('00000000-0000-0000-0000-000000000061',gen_random_uuid()::text,'Test org',tier,false,false,false,'DPO','dpo@test.invalid','[{"name":"proposed db"}]',library,gen_random_uuid())
$$;
set local role service_role;
do $$
declare r jsonb; tid uuid;
begin
  perform pg_temp.check_result(pg_temp.onboard()->>'error','onboarding_not_entitled');
  insert into public.onboarding_entitlements(user_id,max_owned_tenants,allowed_tiers,granted_by,grant_reason,valid_until)
    values('00000000-0000-0000-0000-000000000061',1,array['growth']::public.tenant_tier[],'00000000-0000-0000-0000-000000000061','Test approval',now()+interval '1 day');
  perform pg_temp.check_result(pg_temp.onboard('enterprise')->>'error','tier_not_entitled');
  perform pg_temp.check_result(pg_temp.onboard('growth','missing')->>'error','library_not_published');
  update public.onboarding_entitlements set valid_until=now();
  perform pg_temp.check_result(pg_temp.onboard()->>'error','onboarding_not_entitled');
  update public.onboarding_entitlements set valid_until=now()+interval '1 day',revoked_at=now();
  perform pg_temp.check_result(pg_temp.onboard()->>'error','onboarding_not_entitled');
  update public.onboarding_entitlements set revoked_at=null;
  r := pg_temp.onboard();
  if r ? 'error' then raise exception 'Onboarding failed: %',r; end if;
  tid := (r->'tenant'->>'id')::uuid;
  perform pg_temp.check_result((select role::text from public.tenant_users where tenant_id=tid),'owner');
  perform pg_temp.check_result((select library_version from public.engagements where tenant_id=tid),'test-onboarding');
  perform pg_temp.check_result((select dpo_email from public.tenant_onboarding_intakes where tenant_id=tid),'dpo@test.invalid');
  perform pg_temp.check_result((select proposed_systems->0->>'name' from public.tenant_onboarding_intakes where tenant_id=tid),'proposed db');
  perform pg_temp.check_result((select action_type::text from public.audit_ledger where tenant_id=tid),'tenant.created');
  perform pg_temp.check_result(pg_temp.onboard()->>'error','tenant_quota_exceeded');
  perform pg_temp.check_result(public.take_rate_limit('onboard','test',2,3600)->>'allowed','true');
  perform pg_temp.check_result(public.take_rate_limit('onboard','test',2,3600)->>'allowed','true');
  perform pg_temp.check_result(public.take_rate_limit('onboard','test',2,3600)->>'allowed','false');
  update public.request_rate_limits set window_ends_at=now()-interval '1 second' where bucket='onboard';
  perform pg_temp.check_result(public.take_rate_limit('onboard','test',2,3600)->>'allowed','true');
end $$;
reset role;
-- Fault injection: the last write fails, so every earlier write must vanish.
update public.onboarding_entitlements set max_owned_tenants=2;
create function pg_temp.reject_ledger() returns trigger language plpgsql as $$
begin raise exception 'injected ledger failure'; end $$;
create trigger fail_ledger before insert on public.audit_ledger for each row execute function pg_temp.reject_ledger();
set local role service_role;
do $$
declare before_count integer;
begin
  select count(*) into before_count from public.tenants;
  begin
    perform pg_temp.onboard();
    raise exception 'Unexpected success';
  exception when raise_exception then
    if sqlerrm <> 'injected ledger failure' then raise; end if;
  end;
  if (select count(*) from public.tenants) <> before_count then raise exception 'Orphan tenant after ledger failure'; end if;
  if (select count(*) from public.tenant_onboarding_intakes) <> 1 then raise exception 'Orphan intake'; end if;
  if (select count(*) from public.engagements where library_version='test-onboarding') <> 1 then raise exception 'Orphan engagement'; end if;
end $$;
reset role;
do $$ begin
  if has_function_privilege('authenticated','public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid)','execute')
    or has_table_privilege('authenticated','public.onboarding_entitlements','insert')
    or has_table_privilege('authenticated','public.tenant_onboarding_intakes','select') then
    raise exception 'Client can bypass entitlement authority or see DPO intake';
  end if;
end $$;
rollback;
