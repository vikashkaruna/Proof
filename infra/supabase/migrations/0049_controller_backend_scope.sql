-- Tenant-bound controller credentials. The trusted external issuer signs only
-- short-lived JWTs for this role; signing keys never reach controller hosts.
-- Provision/revoke credential records through reviewed DB administration, never
-- through service_role, controller startup, a worker, or a public RPC.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='axiom_assessment_controller') then
  create role axiom_assessment_controller nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='axiom_assessment_controller'
  and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='axiom_assessment_controller')
 then raise exception 'controller role attributes refused'; end if;
end $$;
grant axiom_assessment_controller to authenticator;
grant usage on schema public to axiom_assessment_controller;
create schema controller_security;
revoke all on schema controller_security from public,anon,authenticated,service_role,axiom_assessment_controller;
create table controller_security.credentials (
 id uuid primary key,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 check(expires_at>created_at and expires_at<=created_at+interval '24 hours')
);
revoke all on controller_security.credentials from public,anon,authenticated,service_role,axiom_assessment_controller;

-- PostgREST verifies the signature/exp and sets the SQL role. Neither a forged
-- request claim under another role nor a copied foreign tenant field suffices.
create function public.current_assessment_controller_tenant() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare claims jsonb; tenant uuid; issued numeric; expiry numeric;
begin
 if current_setting('role',true) is distinct from 'axiom_assessment_controller' then return null; end if;
 claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 if claims->>'role' is distinct from 'axiom_assessment_controller'
  or jsonb_typeof(claims->'iat') is distinct from 'number'
  or jsonb_typeof(claims->'exp') is distinct from 'number' then return null; end if;
 issued:=(claims->>'iat')::numeric; expiry:=(claims->>'exp')::numeric;
 if issued<>trunc(issued) or expiry<>trunc(expiry) or issued>extract(epoch from statement_timestamp())
  or expiry<=extract(epoch from statement_timestamp()) or expiry<=issued or expiry-issued>3600 then return null; end if;
 select c.tenant_id into tenant from controller_security.credentials c
 where c.id=(claims->>'sub')::uuid and c.tenant_id=(claims->>'tenant_id')::uuid
  and c.revoked_at is null and c.expires_at>statement_timestamp()
  and extract(epoch from c.expires_at)>=expiry;
 return tenant;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;
revoke all on function public.current_assessment_controller_tenant() from public,anon,authenticated,service_role;
grant execute on function public.current_assessment_controller_tenant() to axiom_assessment_controller;

create function controller_security.require_tenant(p_tenant_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 -- Existing backend/admin invocations retain their existing ACLs. The wrapper
 -- is the only additional controller grant; private originals remain revoked.
 if current_setting('role',true)='axiom_assessment_controller' and
  (p_tenant_id is null or p_tenant_id is distinct from public.current_assessment_controller_tenant())
 then raise exception 'controller tenant refused' using errcode='42501'; end if;
end $$;
revoke all on function controller_security.require_tenant(uuid) from public,anon,authenticated,service_role,axiom_assessment_controller;

-- Only the precise read columns used by registration, policy and opaque
-- reconciliation. Ciphertext/proof is delivered solely by the fenced claim RPC.
grant select(id,tenant_id,agent_name,spiffe_id,status) on public.workload_identities to axiom_assessment_controller;
grant select(tenant_id,revision,fingerprint) on public.assessment_dispatch_key_policies to axiom_assessment_controller;
grant select(id,tenant_id,run_id,engagement_id,correlation_id,input_hash,claimed_at) on public.assessment_dispatch_jobs to axiom_assessment_controller;
create policy controller_registration_read on public.workload_identities for select to axiom_assessment_controller using(tenant_id=(select public.current_assessment_controller_tenant()));
create policy controller_policy_read on public.assessment_dispatch_key_policies for select to axiom_assessment_controller using(tenant_id=(select public.current_assessment_controller_tenant()));
create policy controller_dispatch_read on public.assessment_dispatch_jobs for select to axiom_assessment_controller using(tenant_id=(select public.current_assessment_controller_tenant()));

alter function public.read_workload_task(uuid,uuid,uuid,text,text,text) set schema controller_security;
revoke all on function controller_security.read_workload_task(uuid,uuid,uuid,text,text,text) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.read_workload_task(p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_agent text,p_proof_hash text,p_scope text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.read_workload_task(p_tenant_id,p_run_id,p_workload_id,p_agent,p_proof_hash,p_scope);
end $$;
revoke all on function public.read_workload_task(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.read_workload_task(uuid,uuid,uuid,text,text,text) to service_role,axiom_assessment_controller;

alter function public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz) set schema controller_security;
revoke all on function controller_security.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.start_workload_assessment(p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_input_hash text,p_identity_expires_at timestamptz) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.start_workload_assessment(p_tenant_id,p_run_id,p_workload_id,p_proof_hash,p_input_hash,p_identity_expires_at);
end $$;
revoke all on function public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz) to service_role,axiom_assessment_controller;

alter function public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz) set schema controller_security;
revoke all on function controller_security.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.complete_workload_assessment(p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_library_digest text,p_result jsonb,p_identity_expires_at timestamptz) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.complete_workload_assessment(p_tenant_id,p_run_id,p_workload_id,p_proof_hash,p_library_digest,p_result,p_identity_expires_at);
end $$;
revoke all on function public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz) to service_role,axiom_assessment_controller;

alter function public.confirm_workload_assessment(uuid,uuid) set schema controller_security;
revoke all on function controller_security.confirm_workload_assessment(uuid,uuid) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.confirm_workload_assessment(p_tenant_id uuid,p_run_id uuid) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.confirm_workload_assessment(p_tenant_id,p_run_id);
end $$;
revoke all on function public.confirm_workload_assessment(uuid,uuid) from public,anon,authenticated;
grant execute on function public.confirm_workload_assessment(uuid,uuid) to service_role,axiom_assessment_controller;

alter function public.claim_assessment_dispatch(uuid,uuid,integer,text) set schema controller_security;
revoke all on function controller_security.claim_assessment_dispatch(uuid,uuid,integer,text) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.claim_assessment_dispatch(p_tenant_id uuid,p_job_id uuid,p_policy_revision integer default null,p_policy_fingerprint text default null) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.claim_assessment_dispatch(p_tenant_id,p_job_id,p_policy_revision,p_policy_fingerprint);
end $$;
revoke all on function public.claim_assessment_dispatch(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.claim_assessment_dispatch(uuid,uuid,integer,text) to service_role,axiom_assessment_controller;

alter function public.reserve_assessment_schedules(text,uuid,integer) set schema controller_security;
revoke all on function controller_security.reserve_assessment_schedules(text,uuid,integer) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.reserve_assessment_schedules(p_namespace text,p_tenant_id uuid default null,p_limit integer default 1) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.reserve_assessment_schedules(p_namespace,p_tenant_id,p_limit);
end $$;
revoke all on function public.reserve_assessment_schedules(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_assessment_schedules(text,uuid,integer) to service_role,axiom_assessment_controller;

alter function public.acknowledge_assessment_schedule(uuid,uuid,uuid,text,text,uuid) set schema controller_security;
revoke all on function controller_security.acknowledge_assessment_schedule(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role,axiom_assessment_controller;
create function public.acknowledge_assessment_schedule(p_tenant_id uuid,p_job_id uuid,p_lease_id uuid,p_namespace text,p_workflow_id text,p_workflow_run_id uuid) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 return controller_security.acknowledge_assessment_schedule(p_tenant_id,p_job_id,p_lease_id,p_namespace,p_workflow_id,p_workflow_run_id);
end $$;
revoke all on function public.acknowledge_assessment_schedule(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.acknowledge_assessment_schedule(uuid,uuid,uuid,text,text,uuid) to service_role,axiom_assessment_controller;

