-- 0176 SQL authority/atomicity fixtures only. No real auth browser, customer
-- ownership consent, completed assessment, report generation or provider claim.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.u(n integer) returns uuid language sql immutable as $$
 select ('00000000-0000-0000-0176-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.onboard(n integer, tier public.tenant_tier default 'growth', library text default 'onboarding-176')
returns jsonb language plpgsql as $$
declare result jsonb;
begin
 set local role human_action_writer;
 begin
  result:=public.onboard_organization(pg_temp.u(n),gen_random_uuid()::text,'Synthetic onboarding176',tier,
   false,false,false,'Synthetic DPO','fixture176@test.invalid','[]',library,gen_random_uuid());
 exception when others then reset role; raise; end;
 reset role;
 return result;
end $$;
insert into auth.users(id,email) select pg_temp.u(n),'fixture176-'||n||'@test.invalid' from generate_series(1,8) n;
insert into public.users(id,email,is_axiom_internal)
 select pg_temp.u(n),'fixture176-'||n||'@test.invalid',n in(1,2,4,5,6) from generate_series(1,8) n;
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current)
 values('onboarding-176',now(),'test','synthetic SQL fixture, not catalogue approval',1,true);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('ONBOARD176','onboarding-176','Test','Test','GOV','low','[]','[]','[]','{}','{}','onboarding-176');
select public.designate_platform_founder(pg_temp.u(1),'test','synthetic founder176 one');
select public.designate_platform_founder(pg_temp.u(2),'test','synthetic founder176 two');
insert into public.onboarding_entitlements(user_id,max_owned_tenants,allowed_tiers,granted_by,grant_reason,valid_until)
 select pg_temp.u(n),1,array['growth']::public.tenant_tier[],pg_temp.u(1),'Synthetic entitled onboarding176',now()+interval '1 day'
 from generate_series(1,7) n;

-- An ordinary customer remains owner, while both default founders can access
-- the tenant without consuming either founder's own creation allowance.
do $$ declare r jsonb; t uuid; begin
 r:=pg_temp.onboard(3); t:=(r->'tenant'->>'id')::uuid;
 perform pg_temp.assert_true(not(r?'error'),'ordinary owner onboarding succeeds');
 perform pg_temp.assert_true((select role='owner' and membership_source='explicit' from public.tenant_users where tenant_id=t and user_id=pg_temp.u(3)), 'customer explicit owner retained');
 perform pg_temp.assert_true((select count(*)=2 from public.tenant_users where tenant_id=t and role='founder' and membership_source='platform_founder'),'both founders derived on customer tenant');
 perform pg_temp.assert_true((select creation_authority='owner' from public.tenant_onboarding_intakes where tenant_id=t),'ordinary owner marker');
 perform pg_temp.assert_true(pg_temp.onboard(3)->>'error'='tenant_quota_exceeded','normal owner quota unchanged');
 perform set_config('test.onboard176.customer',t::text,true);
end $$;

-- No special entitlement, tier or published-library exemption for founders.
select pg_temp.assert_true(pg_temp.onboard(8)->>'error'='onboarding_not_entitled','unentitled refuses');
select pg_temp.assert_true(pg_temp.onboard(1,'enterprise')->>'error'='tier_not_entitled','founder tier refuses');
select pg_temp.assert_true(pg_temp.onboard(1,'growth','missing176')->>'error'='library_not_published','founder library refuses');
update public.onboarding_entitlements set revoked_at=now() where user_id=pg_temp.u(1);
select pg_temp.assert_true(pg_temp.onboard(1)->>'error'='onboarding_not_entitled','revoked entitlement refuses founder');
update public.onboarding_entitlements set revoked_at=null,valid_until=now() where user_id=pg_temp.u(1);
select pg_temp.assert_true(pg_temp.onboard(1)->>'error'='onboarding_not_entitled','expired entitlement refuses founder');
update public.onboarding_entitlements set valid_until=now()+interval '1 day' where user_id=pg_temp.u(1);

do $$ declare r jsonb;t uuid;begin
 r:=pg_temp.onboard(1);t:=(r->'tenant'->>'id')::uuid;
 perform pg_temp.assert_true(not(r?'error'),'founder onboarding no unique conflict');
 perform pg_temp.assert_true((select count(*)=2 from public.tenant_users where tenant_id=t and role='founder' and membership_source='platform_founder'),'creator and other founder remain derived');
 perform pg_temp.assert_true(not exists(select 1 from public.tenant_users where tenant_id=t and role='owner'),'no fabricated client owner/consent');
 perform pg_temp.assert_true((select creation_authority='platform_founder' and submitted_by=pg_temp.u(1) from public.tenant_onboarding_intakes where tenant_id=t),'founder creation quota marker');
 perform pg_temp.assert_true((select count(*)=1 from public.engagements where tenant_id=t),'one initial engagement');
 perform pg_temp.assert_true((select count(*)=1 from public.audit_ledger where tenant_id=t and action_type='tenant.created' and detail->>'creation_authority'='platform_founder'),'one actual genesis ledger receipt');
 perform pg_temp.assert_true(public.report_founder_allowed(t,pg_temp.u(1)) and public.report_founder_allowed(t,pg_temp.u(2)),'existing founder report review authority preserved');
 perform pg_temp.assert_true(pg_temp.onboard(1)->>'error'='tenant_quota_exceeded','derived global access not used as unlimited quota');
 perform set_config('test.onboard176.founder',t::text,true);
end $$;
-- Actual RLS helper with authenticated SQL JWT stand-in; not GoTrue/MFA proof.
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(2),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.assert_true(public.has_tenant_role(current_setting('test.onboard176.founder')::uuid,array['founder']::public.user_role[]),'other founder resolves in newly onboarded tenant');
select pg_temp.assert_true(public.report_visible(current_setting('test.onboard176.founder')::uuid,pg_temp.u(1),'draft'),'other founder may read draft reports from creator');
select pg_temp.assert_true(exists(select 1 from public.tenants where id=current_setting('test.onboard176.founder')::uuid),'tenant selection is visible through RLS');
reset role;

-- Creator accounting survives live designation revocation; it never creates
-- an owner fallback. Existing explicit membership history remains byte equal.
create temp table explicit176_before as select to_jsonb(m) value from public.tenant_users m where user_id=pg_temp.u(3);
select public.revoke_platform_founder(pg_temp.u(1),'test','synthetic revoke176');
select pg_temp.assert_true(not exists(select 1 from public.tenant_users where tenant_id=current_setting('test.onboard176.founder')::uuid and user_id=pg_temp.u(1)),'creator derived access withdrawn');
select pg_temp.assert_true(pg_temp.onboard(1)->>'error'='tenant_quota_exceeded','creator quota survives founder revocation');
select pg_temp.assert_true((select value from explicit176_before)=(select to_jsonb(m) from public.tenant_users m where user_id=pg_temp.u(3)),'existing explicit membership unchanged');

-- De-duplicated owner+creation receipt consumes one slot, not two. The source
-- owner membership below is administrative fixture setup, NOT client consent.
insert into public.tenant_users(tenant_id,user_id,role,accepted_at)
 values(current_setting('test.onboard176.founder')::uuid,pg_temp.u(1),'owner',now());
update public.onboarding_entitlements set max_owned_tenants=2 where user_id=pg_temp.u(1);
select pg_temp.assert_true(not(pg_temp.onboard(1)?'error'),'union deduplicates explicit owner and retained founder creation');
select pg_temp.assert_true(pg_temp.onboard(1)->>'error'='tenant_quota_exceeded','deduplicated quota bounded');

select public.designate_platform_founder(pg_temp.u(4),'test','flag withdrawal fixture176');
select pg_temp.assert_true(not(pg_temp.onboard(4)?'error'),'second independent founder creates');
update public.users set is_axiom_internal=false where id=pg_temp.u(4);
select pg_temp.assert_true(pg_temp.onboard(4)->>'error'='tenant_quota_exceeded','creation quota survives internal-flag withdrawal');
select pg_temp.assert_true(not exists(select 1 from public.tenant_users where user_id=pg_temp.u(4)),'flag withdrawal removes only derived access');
-- Internal alone remains an ordinary entitled owner, with no founder marker.
select pg_temp.assert_true(not(pg_temp.onboard(6)?'error'),'internal nondesignated onboarding');
select pg_temp.assert_true((select bool_and(role='owner' and membership_source='explicit') from public.tenant_users where user_id=pg_temp.u(6)),'internal flag never grants founder');

-- No source mutation can erase or relabel founder creation history.
do $$ begin
 begin
  update public.tenant_onboarding_intakes set creation_authority='owner' where tenant_id=current_setting('test.onboard176.founder')::uuid;
  raise exception 'marker rewrite unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
 begin
  delete from public.tenant_onboarding_intakes where tenant_id=current_setting('test.onboard176.founder')::uuid;
  raise exception 'marker deletion unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
end $$;

-- Corrupting the derived result cannot be hidden by generic ON CONFLICT.
-- Test-only privileged trigger alters this new tenant; transaction must abort.
select public.designate_platform_founder(pg_temp.u(5),'test','forged membership fixture176');
create function pg_temp.corrupt_founder176() returns trigger language plpgsql as $$
begin
 perform set_config('axiom.platform_founder_sync','on',true);
 update public.tenant_users set role='owner',membership_source='explicit' where tenant_id=new.id and user_id=pg_temp.u(5);
 perform set_config('axiom.platform_founder_sync','off',true);
 return null;
end $$;
create trigger zz_corrupt_founder176 after insert on public.tenants for each row execute function pg_temp.corrupt_founder176();
do $$ declare before_count bigint;begin
 select count(*) into before_count from public.tenants;
 begin
  perform pg_temp.onboard(5);
  raise exception 'corrupt membership accepted';
 exception when insufficient_privilege then null;end;
 perform pg_temp.assert_true((select count(*) from public.tenants)=before_count,'corrupt founder result leaves no partial tenant');
end $$;
drop trigger zz_corrupt_founder176 on public.tenants;

-- Failure of the LAST ledger append rolls back tenant, both derived founders,
-- intake marker and engagement together. No ledger history is altered.
create function pg_temp.reject_genesis176() returns trigger language plpgsql as $$
begin raise exception 'injected176 ledger failure'; end $$;
create trigger reject_genesis176 before insert on public.audit_ledger for each row execute function pg_temp.reject_genesis176();
do $$ declare nt bigint; nm bigint; ni bigint; ne bigint; nl bigint;begin
 select count(*) into nt from public.tenants;select count(*) into nm from public.tenant_users;
 select count(*) into ni from public.tenant_onboarding_intakes;select count(*) into ne from public.engagements;
 select count(*) into nl from public.audit_ledger;
 begin perform pg_temp.onboard(5);raise exception 'injected failure not seen';
 exception when raise_exception then if sqlerrm<>'injected176 ledger failure' then raise;end if;end;
 perform pg_temp.assert_true((select count(*) from public.tenants)=nt and (select count(*) from public.tenant_users)=nm
  and (select count(*) from public.tenant_onboarding_intakes)=ni and (select count(*) from public.engagements)=ne
  and (select count(*) from public.audit_ledger)=nl,'last-write failure atomicity preserves all histories');
end $$;
reset role;
select pg_temp.assert_true(not has_function_privilege('authenticated','public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid)','execute')
 and not has_function_privilege('service_role','public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid)','execute')
 and has_function_privilege('human_action_writer','public.onboard_organization(uuid,text,text,public.tenant_tier,boolean,boolean,boolean,text,text,jsonb,text,uuid)','execute'),'existing trusted human writer authority unchanged');
rollback;
