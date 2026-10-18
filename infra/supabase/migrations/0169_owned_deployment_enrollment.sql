-- Explicit local synthetic enrollment. No role grant, target row, credential,
-- SPIRE registration or deployment is created by applying this migration.
-- A short installer token has a distinct signed domain from remediation; the
-- immutable approved scope has its separately signed <=24h manifest expiry.
alter type public.mfa_challenge_purpose add value if not exists 'owned_synthetic_enrollment';
alter type public.ledger_action_type add value if not exists 'deployment.owned_requested';
alter type public.ledger_action_type add value if not exists 'deployment.owned_preflight';
alter type public.ledger_action_type add value if not exists 'deployment.owned_approved';
alter type public.ledger_action_type add value if not exists 'deployment.owned_step';
alter type public.ledger_action_type add value if not exists 'deployment.owned_active';
alter type public.ledger_action_type add value if not exists 'deployment.owned_fenced';
alter type public.ledger_action_type add value if not exists 'deployment.owned_revoked';
alter type public.ledger_action_type add value if not exists 'deployment.owned_credential';

create table owned_synthetic.deployment_requests (
 id uuid primary key, tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id),session_id uuid not null,
 request jsonb not null,request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),
 manifest jsonb not null,manifest_sha256 text not null check(manifest_sha256~'^[a-f0-9]{64}$'),
 engagement_id uuid not null,connector_id uuid not null,binding_id uuid not null unique,
 fixture_id uuid not null,resource_id uuid not null,
 custody_policy_id uuid not null,custody_epoch bigint not null check(custody_epoch between 1 and 9007199254740991),
 created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 receipt_id bigint not null,
 unique(tenant_id,id),unique(fixture_id,resource_id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id),
 foreign key(tenant_id,custody_policy_id) references public.local_custody_policy_versions(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table owned_synthetic.deployment_approvals (
 id uuid primary key,tenant_id uuid not null,request_id uuid not null unique,
 actor_id uuid not null references public.users(id),session_id uuid not null,
 operation_key uuid not null,challenge_id uuid not null references public.mfa_challenges(id),
 decision jsonb not null,decision_sha256 text not null check(decision_sha256~'^[a-f0-9]{64}$'),
 signed_token jsonb not null,preflight_sha256 text not null check(preflight_sha256~'^[a-f0-9]{64}$'),
 rollback_sha256 text not null check(rollback_sha256~'^[a-f0-9]{64}$'),
 approved_at timestamptz not null default clock_timestamp(),scope_expires_at timestamptz not null,
 receipt_id bigint not null,
 unique(tenant_id,id),unique(tenant_id,actor_id,operation_key),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table owned_synthetic.deployment_decisions (
 tenant_id uuid not null,actor_id uuid not null references public.users(id),operation_key uuid not null,
 request_id uuid not null,session_id uuid not null,decision jsonb not null,
 receipt_id bigint not null references public.audit_ledger(id),
 bound_payload_sha256 text not null check(bound_payload_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,actor_id,operation_key),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id)
);
create table owned_synthetic.deployment_heads (
 request_id uuid primary key references owned_synthetic.deployment_requests(id),
 state text not null check(state in('requested','preflight_ready','preflight_refused','approved','installing','active','unconfirmed','revoked','expired')),
 preflight jsonb,preflight_key uuid,approval_id uuid references owned_synthetic.deployment_approvals(id),
 installation_key uuid,installation_receipt bigint references public.audit_ledger(id)
);
create table owned_synthetic.deployment_operations (
 tenant_id uuid not null,actor_id uuid not null references public.users(id),request_id uuid not null,
 phase text not null check(phase in('request','preflight','challenge','verify','approve','install','fence')),
 operation_key uuid not null,intent jsonb not null,intent_sha256 text not null check(intent_sha256~'^[a-f0-9]{64}$'),
 outcome text not null check(outcome in('pending','recorded','unconfirmed')),
 result jsonb,phase_result jsonb,receipt_id bigint,
 primary key(tenant_id,actor_id,request_id,phase,operation_key),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
 -- request_id intentionally lacks an FK: fencing an unrecorded initial request
 -- must win serialization against its late arrival without inventing a request.
);
create table owned_synthetic.deployment_fences (
 tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),
 request_id uuid not null,target_phase text not null check(target_phase in('request','preflight','decision')),
 target_operation_key uuid not null,target_sha256 text not null check(target_sha256~'^[a-f0-9]{64}$'),
 operation_key uuid not null,receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,actor_id,request_id,target_phase,target_operation_key),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table owned_synthetic.deployment_steps (
 sequence bigint generated always as identity unique,
 id uuid primary key,tenant_id uuid not null,request_id uuid not null,
 step text not null check(step in('enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope')),
 transition text not null check(transition in('authorized','confirmed','unconfirmed','revoked')),
 operation_key uuid not null,readback jsonb,receipt_id bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table owned_synthetic.deployment_credentials (
 id uuid primary key,tenant_id uuid not null,request_id uuid not null,
 binding_id uuid not null,approval_id uuid not null,custody_epoch bigint not null check(custody_epoch>0),
 token_sha256 text not null check(token_sha256~'^[a-f0-9]{64}$'),
 issued_at timestamptz not null,expires_at timestamptz not null,receipt_id bigint not null,
 check(expires_at>issued_at and expires_at<=issued_at+interval '15 minutes'),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id),
 foreign key(tenant_id,approval_id) references owned_synthetic.deployment_approvals(tenant_id,id),
 foreign key(tenant_id,binding_id) references owned_synthetic.bindings(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table owned_synthetic.deployment_credential_revocations (
 credential_id uuid primary key references owned_synthetic.deployment_credentials(id),
 tenant_id uuid not null,receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
-- Read-only task intent and its single host claim are retained independently.
-- A queued task is NOT a completed dry-run or validated rollback.
create table owned_synthetic.deployment_preflight_tasks (
 id uuid primary key,tenant_id uuid not null,request_id uuid not null,actor_id uuid not null,
 session_id uuid not null,intent_sha256 text not null check(intent_sha256~'^[a-f0-9]{64}$'),
 manifest_sha256 text not null check(manifest_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 receipt_id bigint not null,
 check(expires_at>created_at and expires_at<=created_at+interval '5 minutes'),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id)
);
create table owned_synthetic.deployment_preflight_claims (
 task_id uuid primary key references owned_synthetic.deployment_preflight_tasks(id),
 claim_id uuid not null unique,receipt_id bigint not null references public.audit_ledger(id),claimed_at timestamptz not null default clock_timestamp()
);
do $$declare name text;begin
 foreach name in array array['deployment_preflight_tasks','deployment_preflight_claims','deployment_requests','deployment_decisions','deployment_approvals','deployment_operations','deployment_fences','deployment_steps','deployment_credentials','deployment_credential_revocations','deployment_heads'] loop
  execute format('alter table owned_synthetic.%I enable row level security',name);
  execute format('revoke all on owned_synthetic.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller',name);
  if name not in('deployment_operations','deployment_heads') then
   execute format('create trigger owned169_retained before update or delete on owned_synthetic.%I for each row execute function public.evidence_receipt_immutable()',name);
  else
   execute format('create trigger owned169_no_delete before delete on owned_synthetic.%I for each row execute function public.evidence_receipt_immutable()',name);
  end if;
  execute format('create trigger owned169_no_truncate before truncate on owned_synthetic.%I for each statement execute function public.evidence_receipt_immutable()',name);
 end loop;
end $$;

-- Shared serialization key: request/challenge/verify/approve/install/fence all
-- take this lock BEFORE observing no receipt or changing durable authority.
create function owned_synthetic.deployment_lock(t uuid,r uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if t is null or r is null then raise exception 'owned deployment source refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||r::text,169));
end $$;
create function owned_synthetic.deployment_unfenced(t uuid,a uuid,r uuid,phase text,op uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 perform owned_synthetic.deployment_lock(t,r);
 if exists(select 1 from owned_synthetic.deployment_fences f where(f.tenant_id,f.actor_id,f.request_id,f.target_operation_key)=(t,a,r,op)
  and f.target_phase=case when phase in('challenge','verify','approve') then 'decision' else phase end)
 then raise exception 'owned deployment intent fenced' using errcode='42501';end if;
end $$;
create function owned_synthetic.deployment_operation_sha256(t uuid,a uuid,r uuid,op uuid,intent jsonb) returns text
language sql immutable set search_path='' as $$select owned_synthetic.snapshot_sha256(jsonb_build_object(
 'domain','axiom.owned-synthetic.deployment-operation.v1','tenantId',t,'actorId',a,'requestId',r,'operationKey',op,'intent',intent))$$;
-- Private current-human-source check shared by service transport callbacks.
-- It has no EXECUTE grants; public human RPCs retain their transport role gate.
create function owned_synthetic.deployment_actor_authority(t uuid,a uuid,s uuid) returns void
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 if t is null or a is null or s is null
 then raise exception 'owned human authority refused' using errcode='42501';end if;
 perform 1 from public.tenants where id=t for share;
 if not found then raise exception 'owned human tenant refused' using errcode='42501';end if;
 -- Match both existing PLAN_CREATE and PLAN_EXECUTE capabilities. Internal
 -- employment and the analyst/reviewer/approver roles confer no write source.
 -- A protected live founder designation grants cross-company access even
 -- when derived membership is absent. Lock the actual source of authority.
 perform 1 from public.platform_founders f join public.users u on u.id=f.user_id
 where f.user_id=a and f.revoked_at is null and u.is_axiom_internal for share of f,u;
 if not found then
  perform 1 from public.tenant_users m join public.users u on u.id=m.user_id
  where m.tenant_id=t and m.user_id=a and m.role in('owner','admin') for share of m,u;
  if not found then raise exception 'owned human membership refused' using errcode='42501';end if;
 end if;
 perform public.assert_mfa_recovery_session_actor(a,s);
 perform 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp()) for share;
 if not found then raise exception 'owned human session refused' using errcode='42501';end if;
 perform 1 from public.mfa_session_attestations m join public.user_mfa_factors f on f.id=m.factor_id and f.user_id=m.user_id
 where m.user_id=a and m.session_id=s::text and m.revoked_at is null and m.expires_at>clock_timestamp()
 and f.factor_type='totp' and f.status='active' and f.revoked_at is null for share of m,f;
 if not found then raise exception 'owned human MFA refused' using errcode='42501';end if;
end $$;
create function owned_synthetic.deployment_founder(t uuid,a uuid,s uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 perform owned_synthetic.deployment_actor_authority(t,a,s);
 perform 1 from public.platform_founders f join public.users u on u.id=f.user_id
 where f.user_id=a and f.revoked_at is null and u.is_axiom_internal for share of f,u;
 if not found then raise exception 'owned deployment founder required' using errcode='42501';end if;
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;

-- Trusted BFF verifies actual TOTP/counters/rate limits. These DB-clock RPCs
-- bind that verification to a prepared immutable founder decision. A service
-- credential, login-MFA attestation, or arbitrary operation UUID is insufficient.
create function owned_synthetic.deployment_mfa_authority(t uuid,a uuid,s uuid,op uuid,digest text) returns void
language plpgsql security definer set search_path='' as $$
declare request uuid;r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;d owned_synthetic.deployment_decisions;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service refused' using errcode='42501';end if;
 select * into d from owned_synthetic.deployment_decisions where(tenant_id,actor_id,operation_key,session_id,bound_payload_sha256)=(t,a,op,s,digest);
 request:=d.request_id;
 if request is null then raise exception 'owned deployment MFA source refused' using errcode='42501';end if;
 perform owned_synthetic.deployment_unfenced(t,a,request,'approve',op);
 select * into strict r from owned_synthetic.deployment_requests where id=request and tenant_id=t;
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=request for share;
 if h.state<>'preflight_ready' or d.decision->>'expectedManifestSha256' is distinct from r.manifest_sha256
 or d.decision->>'expectedPreflightSha256' is distinct from h.preflight->>'sha256'
 or d.decision->>'expectedRollbackSha256' is distinct from h.preflight->>'rollbackSha256'
 or h.preflight->'dryRunCompleted' is distinct from 'true'::jsonb
 or h.preflight->'rollbackValidated' is distinct from 'true'::jsonb
 or h.preflight->>'expiresAt' is null or(h.preflight->>'expiresAt')::timestamptz<=clock_timestamp()
 or jsonb_typeof(h.preflight->'checks') is distinct from 'array'
 or jsonb_array_length(h.preflight->'checks') not between 1 and 30
 or exists(select 1 from jsonb_array_elements(h.preflight->'checks') c where c->>'outcome' is distinct from 'passed')
 then raise exception 'owned deployment MFA preflight refused' using errcode='42501';end if;
 perform 1 from public.platform_founders f join public.users u on u.id=f.user_id where f.user_id=a and f.revoked_at is null and u.is_axiom_internal for share of f,u;
 if not found then raise exception 'owned deployment founder refused' using errcode='42501';end if;
 if not exists(select 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp()))
 then raise exception 'owned deployment session refused' using errcode='42501';end if;
end $$;
create function public.issue_owned_deployment_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_ttl_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 if p_ttl_ms is null or p_ttl_ms not between 1 and 300000 then raise exception 'owned deployment MFA TTL refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_mfa_authority(p_tenant_id,p_actor_id,p_session_id,p_operation_key,p_bound_payload_sha256);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;

 now_at:=clock_timestamp();

 if not exists(select 1 from public.platform_founders f join public.users u on u.id=f.user_id where f.user_id=p_actor_id and f.revoked_at is null and u.is_axiom_internal)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'owned deployment MFA scope refused' using errcode='42501';end if;

 select * into c from public.mfa_challenges where user_id=p_actor_id and tenant_id=p_tenant_id and purpose::text='owned_synthetic_enrollment'
 and bound_resource_ref=p_operation_key::text and bound_payload_sha256=p_bound_payload_sha256 order by created_at desc limit 1 for update;
 if found then
  if c.factor_id is distinct from p_factor_id or c.consumed_at is not null or c.expires_at<=now_at then
   raise exception 'owned deployment decision requires explicit fence' using errcode='42501';
  end if;
  return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
 end if;
 insert into public.mfa_challenges(user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at)
 values(p_actor_id,p_tenant_id,p_factor_id,'owned_synthetic_enrollment',p_operation_key::text,p_bound_payload_sha256,now_at,now_at+p_ttl_ms*interval '1 millisecond') returning * into c;
 return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
end $$;
create function public.satisfy_owned_deployment_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_satisfied_with text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_satisfied_with is null or p_satisfied_with not in ('totp','recovery_code') then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_mfa_authority(p_tenant_id,p_actor_id,p_session_id,p_operation_key,p_bound_payload_sha256);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.platform_founders f join public.users u on u.id=f.user_id where f.user_id=p_actor_id and f.revoked_at is null and u.is_axiom_internal)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'owned deployment MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'owned_synthetic_enrollment'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'owned deployment MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is not null or c.satisfied_with is not null then raise exception 'owned deployment MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set satisfied_at=now_at,satisfied_with=p_satisfied_with where id=c.id and attempts=p_expected_attempts and satisfied_at is null and consumed_at is null returning * into c;
 if not found then raise exception 'owned deployment MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'satisfied_with',c.satisfied_with);
end $$;
create function public.consume_owned_deployment_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_consumed_for uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_consumed_for is null or p_consumed_for is distinct from p_operation_key then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_mfa_authority(p_tenant_id,p_actor_id,p_session_id,p_operation_key,p_bound_payload_sha256);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.platform_founders f join public.users u on u.id=f.user_id where f.user_id=p_actor_id and f.revoked_at is null and u.is_axiom_internal)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'owned deployment MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'owned_synthetic_enrollment'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'owned deployment MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is null or c.satisfied_with not in ('totp','recovery_code') or c.satisfied_with is null
  or c.satisfied_at<c.created_at or c.satisfied_at>now_at or c.satisfied_at<=now_at-interval '5 minutes'
 then raise exception 'owned deployment MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set consumed_at=now_at,consumed_for=p_consumed_for::text where id=c.id and attempts=p_expected_attempts and satisfied_at is not null and consumed_at is null returning * into c;
 if not found then raise exception 'owned deployment MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'expires_at',c.expires_at,'factor_id',c.factor_id);
end $$;
revoke all on function public.issue_owned_deployment_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.issue_owned_deployment_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.satisfy_owned_deployment_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.satisfy_owned_deployment_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) to service_role;
revoke all on function public.consume_owned_deployment_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.consume_owned_deployment_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;


revoke all on function owned_synthetic.deployment_mfa_authority(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;

create function owned_synthetic.deployment_manifest(v jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare key text;
begin
 if v is null or jsonb_typeof(v) is distinct from 'object'
 or not(v?&array['schemaVersion','purpose','environment','tenantId','engagementId','connectorId','fixtureId','resourceId','bindingId','custodyPolicyId','custodyEpoch','scope','label','source','deployment','rollback','reviewedAt','expiresAt','limitations'])
 or v-array['schemaVersion','purpose','environment','tenantId','engagementId','connectorId','fixtureId','resourceId','bindingId','custodyPolicyId','custodyEpoch','scope','label','source','deployment','rollback','reviewedAt','expiresAt','limitations']<>'{}'::jsonb
 or v->'schemaVersion' is distinct from '1'::jsonb or v->>'purpose' is distinct from 'owned_synthetic_enrollment_v1'
 or v->>'environment' is distinct from 'local' or v->>'scope' is distinct from 'owned_synthetic_config.audit_log_enable'
 or v->>'label' is distinct from 'Owned synthetic audit configuration'
 then raise exception 'owned deployment manifest refused' using errcode='22023';end if;
 foreach key in array array['tenantId','engagementId','connectorId','fixtureId','resourceId','bindingId','custodyPolicyId'] loop
  if jsonb_typeof(v->key) is distinct from 'string' or v->>key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  then raise exception 'owned deployment identity refused' using errcode='22023';end if;
 end loop;
 if v->>'fixtureId'=v->>'resourceId' or v->>'fixtureId'=v->>'bindingId' or v->>'bindingId'=v->>'resourceId'
 or jsonb_typeof(v->'custodyEpoch') is distinct from 'number' or v->>'custodyEpoch' !~ '^[1-9][0-9]{0,15}$' or(v->>'custodyEpoch')::bigint>9007199254740991
 or jsonb_typeof(v->'source') is distinct from 'object' or(v->'source')-array['engineSha256','capabilitySha256','hostInstallerSha256','issuerConfigurationSha256']<>'{}'::jsonb
 or jsonb_typeof(v#>'{source,hostInstallerSha256}') is distinct from 'string' or v#>>'{source,hostInstallerSha256}' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(v#>'{source,issuerConfigurationSha256}') is distinct from 'string' or v#>>'{source,issuerConfigurationSha256}' !~ '^[a-f0-9]{64}$'
 or v#>>'{source,engineSha256}' is distinct from owned_synthetic.engine_sha256()
 or v#>>'{source,capabilitySha256}' is distinct from 'a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9'
 or jsonb_typeof(v->'deployment') is distinct from 'object'
 or(v->'deployment')-array['controllerName','controllerImage','workerImage','bffImage','bffContainerId','workloadApiVolume','nodeId','spiffeId','workerUid','controllerUid','socketGid','dockerGid','brokerPort','role','authenticator','credentialLifetimeSeconds']<>'{}'::jsonb
 or not((v->'deployment')?&array['controllerName','controllerImage','workerImage','bffImage','bffContainerId','workloadApiVolume','nodeId','spiffeId','workerUid','controllerUid','socketGid','dockerGid','brokerPort','role','authenticator','credentialLifetimeSeconds'])
 or v#>>'{deployment,controllerName}' !~ '^axiom-proof-local-owned-execution-controller(-[a-z0-9]{1,12})?$'
 or v#>>'{deployment,workloadApiVolume}' !~ '^axiom-workload-api-[a-z0-9-]{1,64}$'
 or v#>>'{deployment,nodeId}' !~ '^spiffe://local\.axiomproof\.test/spire/agent/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)+$'
 or jsonb_typeof(v#>'{deployment,bffContainerId}') is distinct from 'string' or v#>>'{deployment,bffContainerId}' !~ '^[a-f0-9]{64}$'
 or v#>>'{deployment,spiffeId}' is distinct from 'spiffe://local.axiomproof.test/agent/karya'
 or v#>'{deployment,workerUid}' is distinct from '20005'::jsonb or v#>'{deployment,controllerUid}' is distinct from '20106'::jsonb
 or v#>'{deployment,socketGid}' is distinct from '20113'::jsonb or v#>>'{deployment,role}' is distinct from 'owned_target_controller'
 or v#>>'{deployment,authenticator}' is distinct from 'authenticator'
 or v->'rollback' is distinct from '{"revokeNewBindingAndCredential":true,"retainResourcesAndJournals":true,"retainSharedRoleAndIdentity":true,"deleteAuditOrEvidence":false,"reverseTargetSetting":false,"requiresFreshRemediationApprovalForTargetUndo":true}'::jsonb
 then raise exception 'owned deployment scope refused' using errcode='22023';end if;
 foreach key in array array['controllerName','workloadApiVolume','nodeId','spiffeId','role','authenticator'] loop
  if jsonb_typeof(v#>array['deployment',key]) is distinct from 'string'
  then raise exception 'owned deployment scope type refused' using errcode='22023';end if;
 end loop;
 if jsonb_typeof(v->'reviewedAt') is distinct from 'string' or jsonb_typeof(v->'expiresAt') is distinct from 'string'
 then raise exception 'owned deployment time type refused' using errcode='22023';end if;
 foreach key in array array['controllerImage','workerImage','bffImage'] loop
  if jsonb_typeof(v#>array['deployment',key]) is distinct from 'string' or v#>>array['deployment',key] !~ '^sha256:[a-f0-9]{64}$'
  then raise exception 'owned deployment image refused' using errcode='22023';end if;
 end loop;
 foreach key in array array['dockerGid','brokerPort','credentialLifetimeSeconds'] loop
  if jsonb_typeof(v#>array['deployment',key]) is distinct from 'number' or v#>>array['deployment',key] !~ '^[0-9]{1,10}$'
  then raise exception 'owned deployment bound refused' using errcode='22023';end if;
 end loop;
 if(v#>>'{deployment,dockerGid}')::bigint>2147483647 or(v#>>'{deployment,brokerPort}')::int not between 1 and 65535
 or(v#>>'{deployment,credentialLifetimeSeconds}')::int not between 60 and 900
 or(v->>'reviewedAt')::timestamptz>clock_timestamp() or(v->>'expiresAt')::timestamptz<=clock_timestamp()
 or(v->>'expiresAt')::timestamptz<=(v->>'reviewedAt')::timestamptz
 or(v->>'expiresAt')::timestamptz>(v->>'reviewedAt')::timestamptz+interval '24 hours'
 or jsonb_typeof(v->'limitations') is distinct from 'array' or jsonb_array_length(v->'limitations') not between 1 and 10
 or exists(select 1 from jsonb_array_elements(v->'limitations') x where jsonb_typeof(x) is distinct from 'string' or length(x#>>'{}') not between 1 and 300)
 then raise exception 'owned deployment validity refused' using errcode='22023';end if;
 return v;
end $$;
create function owned_synthetic.deployment_live_source(r owned_synthetic.deployment_requests) returns void
language plpgsql security definer set search_path='' as $$begin
 perform pg_advisory_xact_lock_shared(hashtextextended(r.tenant_id::text,47));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenants t
 join public.connectors c on c.tenant_id=t.id and c.id=r.connector_id and c.status='active' and c.target_binding='sandbox'
 join public.estate_systems s on(s.tenant_id,s.id)=(c.tenant_id,c.system_id) and s.status='active'
 join public.estates estate on(estate.tenant_id,estate.id)=(s.tenant_id,s.estate_id) and estate.status='active'
 join public.engagements e on(e.tenant_id,e.id,e.estate_id)=(t.id,r.engagement_id,estate.id)
 join public.local_custody_policy_heads h on h.tenant_id=t.id and h.policy_id=r.custody_policy_id and h.activation_epoch=r.custody_epoch and h.state='active'
 join public.local_custody_policy_versions p on(p.tenant_id,p.id)=(h.tenant_id,h.policy_id)
 join public.tenant_users m on(m.tenant_id,m.user_id)=(p.tenant_id,p.nominated_operator_id) and m.role in('founder','axiom_analyst')
 join public.users u on u.id=m.user_id and u.is_axiom_internal
 where t.id=r.tenant_id and t.is_demo and r.expires_at>clock_timestamp()
 and not exists(select 1 from public.kill_switch_state k where k.engaged and(k.scope='global' or k.tenant_id=t.id))
 for share of t,c,s,estate,e,h,p,m,u;
 if not found or r.manifest_sha256 is distinct from owned_synthetic.snapshot_sha256(r.manifest)
 or r.manifest#>>'{source,engineSha256}' is distinct from owned_synthetic.engine_sha256()
 then raise exception 'owned deployment current source refused' using errcode='42501';end if;
end $$;

revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;

create function owned_synthetic.deployment_summary(r owned_synthetic.deployment_requests) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h owned_synthetic.deployment_heads;a owned_synthetic.deployment_approvals;steps jsonb;effective text;
begin
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id;
 if h.approval_id is not null then select * into strict a from owned_synthetic.deployment_approvals where id=h.approval_id;end if;
 effective:=case when r.expires_at<=clock_timestamp() then 'expired'
 when not exists(select 1 from public.local_custody_policy_heads where(tenant_id,policy_id,activation_epoch)=(r.tenant_id,r.custody_policy_id,r.custody_epoch) and state='active') then 'revoked' else h.state end;
 select jsonb_agg(jsonb_build_object('step',fixed.step,'state',coalesce(latest.transition,'pending'),'receiptId',latest.receipt_id::text,
 'detail',case when latest.transition='confirmed' then 'Independent readback recorded' when latest.transition='unconfirmed' then 'Effect remains unconfirmed; automatic retry refused' else null end) order by fixed.ordinal)
 into steps from unnest(array['enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope']) with ordinality fixed(step,ordinal)
 left join lateral(select * from owned_synthetic.deployment_steps s where s.request_id=r.id and s.step=fixed.step order by s.sequence desc limit 1) latest on true;
 return jsonb_build_object('requestId',r.id,'tenantId',r.tenant_id,'actorId',r.actor_id,'engagementId',r.engagement_id,'connectorId',r.connector_id,
 'state',effective,'manifestSha256',r.manifest_sha256,'environment','local','label','Owned synthetic audit configuration','scope','owned_synthetic_config.audit_log_enable',
 'fixtureId',r.fixture_id,'resourceId',r.resource_id,'bindingId',r.binding_id,'custodyPolicyId',r.custody_policy_id,'custodyEpoch',r.custody_epoch,
 'requestedAt',r.created_at,'expiresAt',r.expires_at,'reason',r.request->>'reason','preflight',h.preflight,
 'approval',case when a.id is null then null else jsonb_build_object('approvalId',a.id,'approvedBy',a.actor_id,'approvedAt',a.approved_at,'expiresAt',a.scope_expires_at,'receiptId',a.receipt_id::text) end,
 'installation',case when h.installation_key is null then null else jsonb_build_object('operationKey',h.installation_key,'steps',steps,'receiptId',h.installation_receipt::text) end,
 'limitations',r.manifest->'limitations');
end $$;

create function public.prepare_owned_deployment_request(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request jsonb,p_manifest jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;manifest jsonb;op uuid;digest text;receipt bigint;intent jsonb;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if jsonb_typeof(p_request) is distinct from 'object' or not(p_request?&array['operationKey','engagementId','connectorId','manifestSha256','reason','acknowledgeOwnedSynthetic'])
 or p_request-array['operationKey','engagementId','connectorId','manifestSha256','reason','acknowledgeOwnedSynthetic']<>'{}'::jsonb
 or p_request->'acknowledgeOwnedSynthetic' is distinct from 'true'::jsonb
 or jsonb_typeof(p_request->'reason') is distinct from 'string' or length(p_request->>'reason') not between 20 and 2000 or p_request->>'reason'<>btrim(p_request->>'reason')
 then raise exception 'owned deployment request refused' using errcode='22023';end if;
 op:=(p_request->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,op,'request',op);
 manifest:=owned_synthetic.deployment_manifest(p_manifest);
 if manifest->>'tenantId' is distinct from p_tenant_id::text or manifest->>'engagementId' is distinct from p_request->>'engagementId'
 or manifest->>'connectorId' is distinct from p_request->>'connectorId' or owned_synthetic.snapshot_sha256(manifest) is distinct from p_request->>'manifestSha256'
 then raise exception 'owned deployment manifest changed' using errcode='42501';end if;
 intent:=jsonb_build_object('phase','request','request',p_request);
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,op,op,intent);
 select * into r from owned_synthetic.deployment_requests where id=op for share;
 if found then
  if(r.tenant_id,r.actor_id,r.request,r.manifest,r.request_sha256) is distinct from(p_tenant_id,p_actor_id,p_request,manifest,digest)
  then raise exception 'owned deployment operation conflict' using errcode='23505';end if;
  return owned_synthetic.deployment_summary(r);
 end if;
 r.id:=op;r.tenant_id:=p_tenant_id;r.actor_id:=p_actor_id;r.session_id:=p_session_id;r.request:=p_request;r.request_sha256:=digest;
 r.manifest:=manifest;r.manifest_sha256:=p_request->>'manifestSha256';r.engagement_id:=(manifest->>'engagementId')::uuid;r.connector_id:=(manifest->>'connectorId')::uuid;
 r.binding_id:=(manifest->>'bindingId')::uuid;r.fixture_id:=(manifest->>'fixtureId')::uuid;r.resource_id:=(manifest->>'resourceId')::uuid;
 r.custody_policy_id:=(manifest->>'custodyPolicyId')::uuid;r.custody_epoch:=(manifest->>'custodyEpoch')::bigint;r.expires_at:=(manifest->>'expiresAt')::timestamptz;
 perform owned_synthetic.deployment_live_source(r);
 if exists(select 1 from owned_synthetic.bindings where id=r.binding_id or(fixture_id,resource_id)=(r.fixture_id,r.resource_id))
 or exists(select 1 from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id))
 then raise exception 'owned deployment requires a new dedicated synthetic resource' using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_requested',op::text,
 digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('provenance','owned_synthetic_enrollment','binding_id',r.binding_id,'target_mutations',0));
 r.receipt_id:=receipt;r.created_at:=clock_timestamp();
 insert into owned_synthetic.deployment_requests select(r).*;
 insert into owned_synthetic.deployment_heads(request_id,state) values(op,'requested');
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,result,receipt_id)
 values(p_tenant_id,p_actor_id,op,'request',op,intent,digest,'recorded',owned_synthetic.deployment_summary(r),receipt);
 return owned_synthetic.deployment_summary(r);
end $$;
create function public.read_owned_deployment_requests(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb:='[]';r owned_synthetic.deployment_requests;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 for r in select * from owned_synthetic.deployment_requests where tenant_id=p_tenant_id and(p_request_id is null or id=p_request_id) order by created_at desc limit 100 loop
  result:=result||jsonb_build_array(owned_synthetic.deployment_summary(r));
 end loop;
 return result;
end $$;
revoke all on function public.prepare_owned_deployment_request(uuid,uuid,uuid,jsonb,jsonb),public.read_owned_deployment_requests(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.prepare_owned_deployment_request(uuid,uuid,uuid,jsonb,jsonb),public.read_owned_deployment_requests(uuid,uuid,uuid,uuid) to human_action_writer;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;

create function public.read_owned_deployment_operation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_phase text,p_operation_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op owned_synthetic.deployment_operations;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_phase not in('request','preflight','challenge','verify','approve','install','fence') or p_operation_key is null
 then raise exception 'owned deployment operation refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_lock(p_tenant_id,p_request_id);
 select * into op from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,p_phase,p_operation_key);
 return jsonb_build_object('data',jsonb_build_object('requestId',p_request_id,'tenantId',p_tenant_id,'actorId',p_actor_id,'operationKey',p_operation_key,'phase',p_phase,
 'outcome',case when op.operation_key is null then 'not_recorded' when op.outcome='pending' then 'unconfirmed' else op.outcome end,
 'canonicalRequestHash',op.intent_sha256,'intent',op.intent,'receiptId',op.receipt_id::text,'result',op.result,'phaseResult',op.phase_result));
end $$;
create function public.fence_owned_deployment_intent(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare opkey uuid;oldkey uuid;target_kind text;digest text;intent jsonb;prior owned_synthetic.deployment_operations;
 target owned_synthetic.deployment_operations;r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;
 oldfence owned_synthetic.deployment_fences;receipt bigint;answer jsonb;previous text;needs_preflight boolean;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if jsonb_typeof(p_request) is distinct from 'object' or not(p_request?&array['operationKey','target','reason'])
 or p_request-array['operationKey','target','reason']<>'{}'::jsonb or p_request->>'reason' is null or p_request->>'reason' not in('expired','superseded_after_no_effect')
 or jsonb_typeof(p_request->'target') is distinct from 'object' or(p_request->'target')-array['phase','operationKey','canonicalRequestHash']<>'{}'::jsonb
 or not((p_request->'target')?&array['phase','operationKey','canonicalRequestHash'])
 or p_request#>>'{target,phase}' is null or p_request#>>'{target,phase}' not in('request','preflight','decision')
 or jsonb_typeof(p_request#>'{target,canonicalRequestHash}') is distinct from 'string' or p_request#>>'{target,canonicalRequestHash}' !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment fence refused' using errcode='22023';end if;
 opkey:=(p_request->>'operationKey')::uuid;oldkey:=(p_request#>>'{target,operationKey}')::uuid;target_kind:=p_request#>>'{target,phase}';
 if opkey is null or oldkey is null or opkey=oldkey or(target_kind='request' and oldkey<>p_request_id)
 then raise exception 'owned deployment fence key refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_lock(p_tenant_id,p_request_id);
 intent:=jsonb_build_object('phase','fence','request',p_request);
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,p_request_id,opkey,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,'fence',opkey) for update;
 if found then
  if prior.intent is distinct from intent or prior.intent_sha256 is distinct from digest or prior.outcome<>'recorded'
  then raise exception 'owned deployment fence conflict' using errcode='23505';end if;
  return prior.phase_result->'receipt';
 end if;
 select * into r from owned_synthetic.deployment_requests where id=p_request_id for share;
 if found and(r.tenant_id<>p_tenant_id or(target_kind='request' and r.actor_id<>p_actor_id))
 then raise exception 'owned deployment fence source refused' using errcode='42501';end if;
 select * into oldfence from owned_synthetic.deployment_fences where(tenant_id,actor_id,request_id,target_phase,target_operation_key)=(p_tenant_id,p_actor_id,p_request_id,target_kind,oldkey);
 -- A fresh explicit fence operation may acknowledge an existing tombstone;
 -- it appends a new receipt without changing or deleting the original fence.
 if oldfence.operation_key is null then
  if exists(select 1 from owned_synthetic.deployment_approvals where request_id=p_request_id)
  then raise exception 'owned deployment approval already recorded' using errcode='42501';end if;
  if exists(select 1 from owned_synthetic.deployment_steps where request_id=p_request_id)
   or exists(select 1 from owned_synthetic.deployment_operations where tenant_id=p_tenant_id and request_id=p_request_id and(phase='install' or outcome='unconfirmed'))
  then raise exception 'owned deployment effect unresolved' using errcode='42501';end if;
 end if;
 select * into target from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,operation_key)=(p_tenant_id,p_actor_id,p_request_id,oldkey)
 and case when target_kind='decision' then deployment_operations.phase in('challenge','verify','approve') else deployment_operations.phase=target_kind end
 and intent_sha256=p_request#>>'{target,canonicalRequestHash}' order by case deployment_operations.phase when 'approve' then 3 when 'verify' then 2 else 1 end desc limit 1;
 if target.operation_key is null and exists(select 1 from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,operation_key)=(p_tenant_id,p_actor_id,p_request_id,oldkey)
 and case when target_kind='decision' then deployment_operations.phase in('challenge','verify','approve') else deployment_operations.phase=target_kind end)
 then raise exception 'owned deployment fence intent changed' using errcode='23505';end if;
 if oldfence.operation_key is not null and oldfence.target_sha256 is distinct from p_request#>>'{target,canonicalRequestHash}'
 then raise exception 'owned deployment fence intent changed' using errcode='23505';end if;
 if target_kind='decision' then
  perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);
  if p_request->>'reason'='expired' and exists(select 1 from public.mfa_challenges where user_id=p_actor_id and tenant_id=p_tenant_id and purpose::text='owned_synthetic_enrollment'
    and bound_resource_ref=oldkey::text and expires_at>clock_timestamp() and attempts<max_attempts and consumed_at is null)
  then raise exception 'owned deployment decision remains live' using errcode='42501';end if;
 end if;
 select * into h from owned_synthetic.deployment_heads where request_id=p_request_id for update;
 needs_preflight:=h.preflight is null or(h.preflight->>'expiresAt')::timestamptz<=clock_timestamp() or h.preflight->'dryRunCompleted' is distinct from 'true'::jsonb or h.preflight->'rollbackValidated' is distinct from 'true'::jsonb;
 previous:=case when target.operation_key is null then 'not_recorded' when target_kind='decision' then 'expired_decision' else 'recorded_readonly_no_effect' end;
 receipt:=public.append_ledger(p_tenant_id,opkey,'human',p_actor_id::text,null,null,null,'deployment.owned_fenced',p_request_id::text,
 digest,p_request#>>'{target,canonicalRequestHash}',null,null,null,null,'success',jsonb_build_object('target_phase',target_kind,'target_operation_key',oldkey,'previous_fence_receipt',oldfence.receipt_id,'target_mutations',0));
 answer:=jsonb_build_object('requestId',p_request_id,'tenantId',p_tenant_id,'actorId',p_actor_id,'operationKey',opkey,'target',p_request->'target',
 'disposition','fenced_no_mutation','previousState',previous,'requiresPreflight',coalesce(needs_preflight,true),'fenceReceiptId',receipt::text);
 insert into owned_synthetic.deployment_fences(tenant_id,actor_id,request_id,target_phase,target_operation_key,target_sha256,operation_key,receipt_id)
 values(p_tenant_id,p_actor_id,p_request_id,target_kind,oldkey,p_request#>>'{target,canonicalRequestHash}',opkey,receipt) on conflict do nothing;
 if target_kind='request' and h.request_id is not null then update owned_synthetic.deployment_heads set state='revoked' where request_id=p_request_id;end if;
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,phase_result,receipt_id)
 values(p_tenant_id,p_actor_id,p_request_id,'fence',opkey,intent,digest,'recorded',jsonb_build_object('phase','fence','receipt',answer),receipt);
 return answer;
end $$;
revoke all on function public.read_owned_deployment_operation(uuid,uuid,uuid,uuid,text,uuid),public.fence_owned_deployment_intent(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.read_owned_deployment_operation(uuid,uuid,uuid,uuid,text,uuid),public.fence_owned_deployment_intent(uuid,uuid,uuid,uuid,jsonb) to human_action_writer;

-- Normal human request queues only a read-only observation. Exact retries recover
-- the same pending operation; no caller can manufacture a ready preflight.
create function public.prepare_owned_deployment_preflight(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;
 prior owned_synthetic.deployment_operations;op uuid;intent jsonb;digest text;stamp timestamptz;receipt bigint;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if jsonb_typeof(p_request) is distinct from 'object' or not(p_request?&array['operationKey','expectedManifestSha256'])
 or p_request-array['operationKey','expectedManifestSha256']<>'{}'::jsonb
 or jsonb_typeof(p_request->'operationKey') is distinct from 'string'
 or jsonb_typeof(p_request->'expectedManifestSha256') is distinct from 'string'
 or p_request->>'expectedManifestSha256' !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment preflight intent refused' using errcode='22023';end if;
 op:=(p_request->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,'preflight',op);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 if r.actor_id<>p_actor_id then perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);end if;
 if r.manifest_sha256 is distinct from p_request->>'expectedManifestSha256'
 then raise exception 'owned deployment manifest changed' using errcode='42501';end if;
 intent:=jsonb_build_object('phase','preflight','request',p_request);
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,p_request_id,op,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,'preflight',op);
 if found then
  if prior.intent_sha256<>digest or prior.intent<>intent then raise exception 'owned deployment preflight conflict' using errcode='23505';end if;
  return owned_synthetic.deployment_summary(r);
 end if;
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for update;
 if h.state not in('requested','preflight_ready','preflight_refused') or h.approval_id is not null or h.installation_key is not null
 then raise exception 'owned deployment preflight state refused' using errcode='42501';end if;
 if exists(select 1 from owned_synthetic.deployment_preflight_tasks task
 where task.request_id=r.id and task.id=h.preflight_key and task.expires_at>clock_timestamp()
 and not exists(select 1 from owned_synthetic.deployment_fences f where(f.tenant_id,f.actor_id,f.request_id,f.target_phase,f.target_operation_key)=(task.tenant_id,task.actor_id,task.request_id,'preflight',task.id))
 and exists(select 1 from owned_synthetic.deployment_operations o where(o.tenant_id,o.actor_id,o.request_id,o.phase,o.operation_key)=(task.tenant_id,task.actor_id,task.request_id,'preflight',task.id) and o.outcome='pending'))
 then raise exception 'owned deployment preflight pending' using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_preflight',r.id::text,digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage','queued','target_mutations',0));
 stamp:=clock_timestamp();
 insert into owned_synthetic.deployment_preflight_tasks(id,tenant_id,request_id,actor_id,session_id,intent_sha256,manifest_sha256,created_at,expires_at,receipt_id)
 values(op,p_tenant_id,r.id,p_actor_id,p_session_id,digest,r.manifest_sha256,stamp,least(stamp+interval '5 minutes',r.expires_at),receipt);
 update owned_synthetic.deployment_heads set state='requested',preflight=null,preflight_key=op where request_id=r.id;
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,receipt_id)
 values(p_tenant_id,p_actor_id,r.id,'preflight',op,intent,digest,'pending',receipt);
 return owned_synthetic.deployment_summary(r);
end $$;
revoke all on function public.prepare_owned_deployment_preflight(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.prepare_owned_deployment_preflight(uuid,uuid,uuid,uuid,jsonb) to human_action_writer;

-- Private BFF calls this only after exact protected operator transport auth.
-- The service role can claim a read-only task, never issue an approval or turn
-- this receipt into authority to install. Claims cannot be reassigned/retried.
create function public.claim_owned_deployment_preflight(p_task_id uuid,p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare task owned_synthetic.deployment_preflight_tasks;r owned_synthetic.deployment_requests;
 claim owned_synthetic.deployment_preflight_claims;h owned_synthetic.deployment_heads;receipt bigint;
begin
 if p_task_id is null or p_claim_id is null then raise exception 'owned deployment claim refused' using errcode='22023';end if;
 select * into strict task from owned_synthetic.deployment_preflight_tasks where id=p_task_id;
 perform pg_advisory_xact_lock_shared(hashtextextended(task.tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(task.tenant_id,task.actor_id,task.request_id,'preflight',task.id);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(task.tenant_id,task.request_id) for share;
 perform owned_synthetic.deployment_actor_authority(task.tenant_id,task.actor_id,task.session_id);
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for share;
 if task.expires_at<=clock_timestamp() or h.state<>'requested' or h.preflight_key is distinct from task.id
 or h.approval_id is not null or h.installation_key is not null or task.manifest_sha256<>r.manifest_sha256
 then raise exception 'owned deployment claim current source refused' using errcode='42501';end if;
 select * into claim from owned_synthetic.deployment_preflight_claims where task_id=task.id;
 if found and claim.claim_id<>p_claim_id then raise exception 'owned deployment task already claimed' using errcode='42501';end if;
 if claim.task_id is null then
  receipt:=public.append_ledger(task.tenant_id,p_claim_id,'system','owned-synthetic-readonly-preflight',null,null,null,'deployment.owned_preflight',r.id::text,task.intent_sha256,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage','claimed','task_id',task.id,'target_mutations',0));
  insert into owned_synthetic.deployment_preflight_claims(task_id,claim_id,receipt_id) values(task.id,p_claim_id,receipt);
 end if;
 return jsonb_build_object('taskId',task.id,'claimId',p_claim_id,'requestId',r.id,'tenantId',r.tenant_id,'manifest',r.manifest,
 'manifestSha256',r.manifest_sha256,'canonicalRequestHash',task.intent_sha256,'expiresAt',task.expires_at,'persistentMutations',0);
end $$;
revoke all on function public.claim_owned_deployment_preflight(uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.claim_owned_deployment_preflight(uuid,uuid) to service_role;

-- Preparing a founder decision grants no installer authority. Only a fresh
-- completed observation and validated rollback can be bound to its MFA purpose.
create function public.prepare_owned_deployment_decision(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_decision jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;
 prior owned_synthetic.deployment_decisions;op uuid;digest text;receipt bigint;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);
 if jsonb_typeof(p_decision) is distinct from 'object'
 or not(p_decision?&array['operationKey','expectedManifestSha256','expectedPreflightSha256','expectedRollbackSha256','reason','acknowledgeOwnedSynthetic'])
 or p_decision-array['operationKey','expectedManifestSha256','expectedPreflightSha256','expectedRollbackSha256','reason','acknowledgeOwnedSynthetic']<>'{}'::jsonb
 or p_decision->'acknowledgeOwnedSynthetic' is distinct from 'true'::jsonb
 or jsonb_typeof(p_decision->'reason') is distinct from 'string' or length(p_decision->>'reason') not between 20 and 2000
 or p_decision->>'reason'<>btrim(p_decision->>'reason')
 or jsonb_typeof(p_decision->'operationKey') is distinct from 'string'
 or p_decision->>'expectedManifestSha256' !~ '^[a-f0-9]{64}$'
 or p_decision->>'expectedPreflightSha256' !~ '^[a-f0-9]{64}$'
 or p_decision->>'expectedRollbackSha256' !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment decision refused' using errcode='22023';end if;
 op:=(p_decision->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,'approve',op);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for share;
 if h.state<>'preflight_ready' or h.approval_id is not null or h.installation_key is not null
 or p_decision->>'expectedManifestSha256' is distinct from r.manifest_sha256
 or p_decision->>'expectedPreflightSha256' is distinct from h.preflight->>'sha256'
 or p_decision->>'expectedRollbackSha256' is distinct from h.preflight->>'rollbackSha256'
 or h.preflight->'dryRunCompleted' is distinct from 'true'::jsonb
 or h.preflight->'rollbackValidated' is distinct from 'true'::jsonb
 or h.preflight->>'expiresAt' is null or(h.preflight->>'expiresAt')::timestamptz<=clock_timestamp()
 or jsonb_typeof(h.preflight->'checks') is distinct from 'array'
 or jsonb_array_length(h.preflight->'checks') not between 1 and 30
 or exists(select 1 from jsonb_array_elements(h.preflight->'checks') c where c->>'outcome' is distinct from 'passed')
 then raise exception 'owned deployment decision requires fresh measured preflight and rollback' using errcode='42501';end if;
 digest:=owned_synthetic.snapshot_sha256(jsonb_build_object('domain','owned_synthetic_enrollment_v1','tenantId',p_tenant_id,
 'actorId',p_actor_id,'sessionId',p_session_id,'requestId',p_request_id,'decision',p_decision));
 select * into prior from owned_synthetic.deployment_decisions where(tenant_id,actor_id,operation_key)=(p_tenant_id,p_actor_id,op);
 if found then
  if(prior.request_id,prior.session_id,prior.decision,prior.bound_payload_sha256) is distinct from(p_request_id,p_session_id,p_decision,digest)
  then raise exception 'owned deployment decision conflict' using errcode='23505';end if;
 else
  receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_requested',r.id::text,digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage','founder_decision_prepared','target_mutations',0));
  insert into owned_synthetic.deployment_decisions(tenant_id,actor_id,operation_key,request_id,session_id,decision,bound_payload_sha256,receipt_id)
  values(p_tenant_id,p_actor_id,op,r.id,p_session_id,p_decision,digest,receipt);
 end if;
 return jsonb_build_object('requestId',r.id,'operationKey',op,'boundPayloadSha256',digest,'purpose','owned_synthetic_enrollment');
end $$;
revoke all on function public.prepare_owned_deployment_decision(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.prepare_owned_deployment_decision(uuid,uuid,uuid,uuid,jsonb) to human_action_writer;
