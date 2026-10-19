-- Explicit local synthetic enrollment. No role grant, target row, credential,
-- SPIRE registration or deployment is created by applying this migration.
-- A short installer token has a distinct signed domain from remediation; the
-- immutable approved scope has its separately signed <=24h manifest expiry.
alter type public.mfa_challenge_purpose add value if not exists 'owned_synthetic_enrollment';
alter type public.mfa_challenge_purpose add value if not exists 'owned_synthetic_revocation';
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
 signed_token jsonb not null,role_graph jsonb not null,preflight_sha256 text not null check(preflight_sha256~'^[a-f0-9]{64}$'),
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
 phase text not null check(phase in('request','preflight','challenge','verify','approve','install','fence','revoke_challenge','revoke_verify','revoke')),
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
 request_id uuid not null,target_phase text not null check(target_phase in('request','preflight','decision','revocation')),
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
  and f.target_phase=case when phase in('challenge','verify','approve') then 'decision' when phase in('revoke_challenge','revoke_verify','revoke') then 'revocation' else phase end)
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
declare request_id_value uuid;r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;d owned_synthetic.deployment_decisions;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service refused' using errcode='42501';end if;
 select * into d from owned_synthetic.deployment_decisions where(tenant_id,actor_id,operation_key,session_id,bound_payload_sha256)=(t,a,op,s,digest);
 request_id_value:=d.request_id;
 if request_id_value is null then raise exception 'owned deployment MFA source refused' using errcode='42501';end if;
 perform owned_synthetic.deployment_unfenced(t,a,request_id_value,'approve',op);
 select * into strict r from owned_synthetic.deployment_requests where id=request_id_value and tenant_id=t;
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=request_id_value for share;
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
declare h owned_synthetic.deployment_heads;a owned_synthetic.deployment_approvals;steps jsonb;effective text;authority jsonb;credential_expiry timestamptz;
begin
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id;
 if h.approval_id is not null then select * into strict a from owned_synthetic.deployment_approvals where id=h.approval_id;end if;
 effective:=case when h.state='revoked' then 'revoked' when r.expires_at<=clock_timestamp() then 'expired'
 when not exists(select 1 from public.local_custody_policy_heads where(tenant_id,policy_id,activation_epoch)=(r.tenant_id,r.custody_policy_id,r.custody_epoch) and state='active') then 'revoked' else h.state end;
 select max(credential.expires_at) into credential_expiry from owned_synthetic.deployment_credentials credential where credential.request_id=r.id and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=credential.id);
 authority:=jsonb_build_object('state',case when effective='unconfirmed' then 'unconfirmed' else 'inactive' end,'detail','This installation record does not by itself establish usable execution authority.','credentialExpiresAt',credential_expiry);
 if effective='active' and credential_expiry>clock_timestamp() and a.scope_expires_at>clock_timestamp()
 and exists(select 1 from public.platform_founders f join public.users u on u.id=f.user_id where f.user_id=a.actor_id and f.revoked_at is null and u.is_axiom_internal)
 and exists(select 1 from owned_synthetic.bindings where(tenant_id,id)=(r.tenant_id,r.binding_id) and state='active' and expires_at>clock_timestamp()) then
  begin
   perform owned_synthetic.deployment_require_role_graph(a.role_graph);
   authority:=jsonb_build_object('state','valid_recorded_scope','detail','Current database scope and issued credential are recorded. Live transport availability is checked separately.','credentialExpiresAt',credential_expiry);
  exception when others then authority:=jsonb_build_object('state','unconfirmed','detail','Current authority checks could not be confirmed; execution remains gated.','credentialExpiresAt',credential_expiry);end;
 elsif effective='active' then
  authority:=jsonb_build_object('state','inactive','detail','Current issued credential or original approval authority is inactive; this is a historical installation record.','credentialExpiresAt',credential_expiry);
 end if;
 select jsonb_agg(jsonb_build_object('step',fixed.step,'state',coalesce(latest.transition,'pending'),'receiptId',latest.receipt_id::text,
 'detail',case when latest.transition='confirmed' then 'Independent readback recorded' when latest.transition='unconfirmed' then 'Effect remains unconfirmed; automatic retry refused' else null end) order by fixed.ordinal)
 into steps from unnest(array['enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope']) with ordinality fixed(step,ordinal)
 left join lateral(select * from owned_synthetic.deployment_steps s where s.request_id=r.id and s.step=fixed.step order by s.sequence desc limit 1) latest on true;
 return jsonb_build_object('requestId',r.id,'tenantId',r.tenant_id,'actorId',r.actor_id,'engagementId',r.engagement_id,'connectorId',r.connector_id,
 'state',effective,'currentAuthority',authority,'manifestSha256',r.manifest_sha256,'environment','local','label','Owned synthetic audit configuration','scope','owned_synthetic_config.audit_log_enable',
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
 if p_phase not in('request','preflight','challenge','verify','approve','install','fence','revoke_challenge','revoke_verify','revoke') or p_operation_key is null
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
 or p_request#>>'{target,phase}' is null or p_request#>>'{target,phase}' not in('request','preflight','decision','revocation')
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
  if target_kind<>'revocation' and exists(select 1 from owned_synthetic.deployment_approvals where request_id=p_request_id)
  then raise exception 'owned deployment approval already recorded' using errcode='42501';end if;
  if target_kind<>'revocation' and(exists(select 1 from owned_synthetic.deployment_steps where request_id=p_request_id)
   or exists(select 1 from owned_synthetic.deployment_operations where tenant_id=p_tenant_id and request_id=p_request_id and(phase='install' or outcome='unconfirmed')))
  then raise exception 'owned deployment effect unresolved' using errcode='42501';end if;
 end if;
 select * into target from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,operation_key)=(p_tenant_id,p_actor_id,p_request_id,oldkey)
 and case when target_kind='decision' then deployment_operations.phase in('challenge','verify','approve') when target_kind='revocation' then deployment_operations.phase in('revoke_challenge','revoke_verify','revoke') else deployment_operations.phase=target_kind end
 and intent_sha256=p_request#>>'{target,canonicalRequestHash}' order by case deployment_operations.phase when 'approve' then 3 when 'verify' then 2 else 1 end desc limit 1;
 if target.operation_key is null and exists(select 1 from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,operation_key)=(p_tenant_id,p_actor_id,p_request_id,oldkey)
 and case when target_kind='decision' then deployment_operations.phase in('challenge','verify','approve') when target_kind='revocation' then deployment_operations.phase in('revoke_challenge','revoke_verify','revoke') else deployment_operations.phase=target_kind end)
 then raise exception 'owned deployment fence intent changed' using errcode='23505';end if;
 if oldfence.operation_key is not null and oldfence.target_sha256 is distinct from p_request#>>'{target,canonicalRequestHash}'
 then raise exception 'owned deployment fence intent changed' using errcode='23505';end if;
 if target_kind='revocation' then
  if exists(select 1 from owned_synthetic.deployment_operations where tenant_id=p_tenant_id and request_id=p_request_id and phase='revoke' and operation_key=oldkey) then raise exception 'owned deployment stop already recorded' using errcode='42501';end if;
  if p_request->>'reason'='expired' and exists(select 1 from public.mfa_challenges where user_id=p_actor_id and tenant_id=p_tenant_id and purpose::text='owned_synthetic_revocation' and bound_resource_ref=oldkey::text and expires_at>clock_timestamp() and attempts<max_attempts and consumed_at is null) then raise exception 'owned deployment stop decision remains live' using errcode='42501';end if;
 elsif target_kind='decision' then
  perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);
  if p_request->>'reason'='expired' and exists(select 1 from public.mfa_challenges where user_id=p_actor_id and tenant_id=p_tenant_id and purpose::text='owned_synthetic_enrollment'
    and bound_resource_ref=oldkey::text and expires_at>clock_timestamp() and attempts<max_attempts and consumed_at is null)
  then raise exception 'owned deployment decision remains live' using errcode='42501';end if;
 end if;
 select * into h from owned_synthetic.deployment_heads where request_id=p_request_id for update;
 needs_preflight:=case when target_kind='revocation' then false else h.preflight is null or(h.preflight->>'expiresAt')::timestamptz<=clock_timestamp() or h.preflight->'dryRunCompleted' is distinct from 'true'::jsonb or h.preflight->'rollbackValidated' is distinct from 'true'::jsonb end;
 previous:=case when target.operation_key is null then 'not_recorded' when target_kind in('decision','revocation') then 'expired_decision' else 'recorded_readonly_no_effect' end;
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
 -- One claim UUID denotes one original task across BOTH task kinds, even when
 -- an earlier HTTP request is still committing after its caller timed out.
 perform pg_advisory_xact_lock(hashtextextended(p_claim_id::text,16901));
 if exists(select 1 from owned_synthetic.deployment_installation_claims where claim_id=p_claim_id)
 or exists(select 1 from owned_synthetic.deployment_preflight_claims where claim_id=p_claim_id and task_id<>p_task_id)
 then raise exception 'owned deployment claim belongs to another task' using errcode='42501';end if;
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
-- Pure fixed-state transition shared by no-write deployment rollback validation
-- and effect readback. Rollback disables only newly enrolled authority and
-- deliberately retains the synthetic resource, journals and shared identities.
create function owned_synthetic.deployment_project(v jsonb,enabled boolean) returns jsonb
language plpgsql immutable set search_path='' as $$begin
 if enabled is null or jsonb_typeof(v) is distinct from 'object'
 or not(v?&array['bindingState','credentialActive','resourceRetained','journalsRetained','sharedRoleRetained','sharedIdentityRetained'])
 or v-array['bindingState','credentialActive','resourceRetained','journalsRetained','sharedRoleRetained','sharedIdentityRetained']<>'{}'::jsonb
 or v->>'bindingState' is null or v->>'bindingState' not in('absent','active','revoked')
 or jsonb_typeof(v->'credentialActive') is distinct from 'boolean' or jsonb_typeof(v->'resourceRetained') is distinct from 'boolean'
 or v->'journalsRetained' is distinct from 'true'::jsonb or v->'sharedRoleRetained' is distinct from 'true'::jsonb or v->'sharedIdentityRetained' is distinct from 'true'::jsonb
 then raise exception 'owned deployment projection refused' using errcode='22023';end if;
 return jsonb_build_object('bindingState',case when enabled then 'active' when v->>'bindingState'='absent' then 'absent' else 'revoked' end,
 'credentialActive',enabled,'resourceRetained',enabled or(v->>'resourceRetained')::boolean,'journalsRetained',true,'sharedRoleRetained',true,'sharedIdentityRetained',true);
end $$;
create table owned_synthetic.deployment_observations (
 task_id uuid primary key references owned_synthetic.deployment_preflight_tasks(id),
 claim_id uuid not null references owned_synthetic.deployment_preflight_claims(claim_id),
 host_observation jsonb not null,host_sha256 text not null check(host_sha256~'^[a-f0-9]{64}$'),
 database_observation jsonb not null,rollback_observation jsonb not null,
 preflight jsonb not null,observed_at timestamptz not null,receipt_id bigint not null references public.audit_ledger(id)
);
alter table owned_synthetic.deployment_observations enable row level security;
revoke all on owned_synthetic.deployment_observations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create trigger owned169_observation_retained before update or delete on owned_synthetic.deployment_observations for each row execute function public.evidence_receipt_immutable();
create trigger owned169_observation_no_truncate before truncate on owned_synthetic.deployment_observations for each statement execute function public.evidence_receipt_immutable();

create function public.record_owned_deployment_preflight(p_task_id uuid,p_claim_id uuid,p_host jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare task owned_synthetic.deployment_preflight_tasks;r owned_synthetic.deployment_requests;
 h owned_synthetic.deployment_heads;old owned_synthetic.deployment_observations;hosthash text;db jsonb;rollback jsonb;
 beforestate jsonb;afterstate jsonb;restored jsonb;proof jsonb;proofhash text;rollbackhash text;receipt bigint;stamp timestamptz;identity jsonb;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment observation transport refused' using errcode='42501';end if;
 select * into strict task from owned_synthetic.deployment_preflight_tasks where id=p_task_id;
 perform pg_advisory_xact_lock_shared(hashtextextended(task.tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(task.tenant_id,task.actor_id,task.request_id,'preflight',task.id);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(task.tenant_id,task.request_id) for share;
 perform owned_synthetic.deployment_actor_authority(task.tenant_id,task.actor_id,task.session_id);
 perform owned_synthetic.deployment_live_source(r);
 hosthash:=owned_synthetic.snapshot_sha256(p_host);
 select * into old from owned_synthetic.deployment_observations where task_id=task.id;
 if found then
  if old.claim_id is distinct from p_claim_id or old.host_sha256 is distinct from hosthash or old.host_observation is distinct from p_host
  then raise exception 'owned deployment observation conflict' using errcode='23505';end if;
  return owned_synthetic.deployment_summary(r);
 end if;
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for update;
 if task.expires_at<=clock_timestamp() or h.state<>'requested' or h.preflight_key is distinct from task.id
 or h.approval_id is not null or h.installation_key is not null or task.manifest_sha256<>r.manifest_sha256
 or not exists(select 1 from owned_synthetic.deployment_preflight_claims where(task_id,claim_id)=(task.id,p_claim_id))
 then raise exception 'owned deployment observation current source refused' using errcode='42501';end if;
 if jsonb_typeof(p_host) is distinct from 'object' or not(p_host?&array['hostInstallerSha256','images','bffContainerId','workloadApiVolume','nodeId','karyaIdentity','persistentMutations','runtime','credentialRoot','controller'])
 or p_host-array['hostInstallerSha256','images','bffContainerId','workloadApiVolume','nodeId','karyaIdentity','persistentMutations','runtime','credentialRoot','controller']<>'{}'::jsonb
 or p_host->>'hostInstallerSha256' is distinct from r.manifest#>>'{source,hostInstallerSha256}'
 or p_host->'images' is distinct from jsonb_build_object('controllerImage',r.manifest#>'{deployment,controllerImage}','workerImage',r.manifest#>'{deployment,workerImage}','bffImage',r.manifest#>'{deployment,bffImage}')
 or p_host->'bffContainerId' is distinct from r.manifest#>'{deployment,bffContainerId}'
 or p_host->'workloadApiVolume' is distinct from r.manifest#>'{deployment,workloadApiVolume}'
 or p_host->'nodeId' is distinct from r.manifest#>'{deployment,nodeId}' or p_host->'persistentMutations' is distinct from '0'::jsonb
 then raise exception 'owned deployment host observation refused' using errcode='42501';end if;
 if jsonb_typeof(p_host->'runtime') is distinct from 'object'
 or not((p_host->'runtime')?&array['containerId','image','socketVolume','socketGroup','adapterEnabled'])
 or(p_host->'runtime')-array['containerId','image','socketVolume','socketGroup','adapterEnabled']<>'{}'::jsonb
 or jsonb_typeof(p_host#>'{runtime,containerId}') is distinct from 'string'
 or jsonb_typeof(p_host#>'{runtime,image}') is distinct from 'string'
 or p_host#>>'{runtime,containerId}' !~ '^[a-f0-9]{64}$'
 or p_host#>>'{runtime,image}' !~ '^sha256:[a-f0-9]{64}$'
 or p_host#>>'{runtime,socketVolume}' is distinct from(r.manifest#>>'{deployment,controllerName}')||'-socket'
 or p_host#>'{runtime,socketGroup}' is distinct from '20113'::jsonb or p_host#>'{runtime,adapterEnabled}' is distinct from 'true'::jsonb
 or p_host->'credentialRoot' is distinct from jsonb_build_object('path','/var/lib/axiom/owned-target-credentials','ownerUid',0,'mode','0700','storage','container_layer')
 then raise exception 'owned deployment runtime observation refused' using errcode='42501';end if;
 if p_host->'controller' is distinct from 'null'::jsonb and(
 jsonb_typeof(p_host->'controller') is distinct from 'object'
 or not((p_host->'controller')?&array['containerId','configurationSha256'])
 or(p_host->'controller')-array['containerId','configurationSha256']<>'{}'::jsonb
 or jsonb_typeof(p_host#>'{controller,containerId}') is distinct from 'string'
 or jsonb_typeof(p_host#>'{controller,configurationSha256}') is distinct from 'string'
 or p_host#>>'{controller,containerId}' !~ '^[a-f0-9]{64}$'
 or p_host#>>'{controller,configurationSha256}' !~ '^[a-f0-9]{64}$')
 then raise exception 'owned deployment existing controller observation refused' using errcode='42501';end if;
 identity:=p_host->'karyaIdentity';
 if identity is distinct from 'null'::jsonb and(jsonb_typeof(identity) is distinct from 'object'
 or not(identity?&array['entryId','spiffeId','parentId','workerUid']) or identity-array['entryId','spiffeId','parentId','workerUid']<>'{}'::jsonb
 or jsonb_typeof(identity->'entryId') is distinct from 'string' or identity->>'entryId' !~ '^[A-Za-z0-9_-]{1,128}$'
 or identity->'spiffeId' is distinct from r.manifest#>'{deployment,spiffeId}' or identity->'parentId' is distinct from r.manifest#>'{deployment,nodeId}'
 or identity->'workerUid' is distinct from '20005'::jsonb)
 then raise exception 'owned deployment workload observation refused' using errcode='42501';end if;
 -- No target writes or new authority: inspect the exact existing graph and new
 -- dedicated identifiers. A pre-existing foreign grant is never repaired.
 if not exists(select 1 from pg_catalog.pg_roles role where rolname='owned_target_controller'
 and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls
 and not exists(select 1 from pg_catalog.pg_auth_members edge where edge.member=role.oid)
 and not exists(select 1 from pg_catalog.pg_auth_members edge join pg_catalog.pg_roles member on member.oid=edge.member where edge.roleid=role.oid and member.rolname<>'authenticator' and not member.rolsuper and member.oid<>(select nspowner from pg_catalog.pg_namespace where nspname='owned_synthetic')))
 or not exists(select 1 from pg_catalog.pg_roles where rolname='authenticator' and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls)
 or exists(select 1 from owned_synthetic.bindings where id=r.binding_id or(fixture_id,resource_id)=(r.fixture_id,r.resource_id))
 or exists(select 1 from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id))
 then raise exception 'owned deployment database scope refused' using errcode='42501';end if;
 db:=jsonb_build_object('roleGraph',owned_synthetic.deployment_role_graph(),'engineSha256',owned_synthetic.engine_sha256(),'newDedicatedResource',true,'roleFlagsSafe',true,'outgoingRoleMemberships',0,
 'karyaRegistration',(select jsonb_build_object('id',w.id,'status',w.status,'version',w.version) from public.workload_identities w where w.tenant_id=r.tenant_id and w.spiffe_id='spiffe://local.axiomproof.test/agent/karya'),'incomingRoleNames',coalesce((select jsonb_agg(member.rolname order by member.rolname) from pg_catalog.pg_auth_members edge join pg_catalog.pg_roles role on role.oid=edge.roleid join pg_catalog.pg_roles member on member.oid=edge.member where role.rolname='owned_target_controller'),'[]'::jsonb),'persistentMutations',0);
 perform owned_synthetic.deployment_require_role_graph(owned_synthetic.deployment_role_graph());
 beforestate:='{"bindingState":"absent","credentialActive":false,"resourceRetained":false,"journalsRetained":true,"sharedRoleRetained":true,"sharedIdentityRetained":true}'::jsonb;
 afterstate:=owned_synthetic.deployment_project(beforestate,true);restored:=owned_synthetic.deployment_project(afterstate,false);
 if restored->>'bindingState'<>'revoked' or restored->'credentialActive'<>'false'::jsonb or restored->'resourceRetained'<>'true'::jsonb
 then raise exception 'owned deployment rollback validation refused' using errcode='42501';end if;
 rollback:=jsonb_build_object('domain','axiom.owned-synthetic.enrollment-rollback.v1','manifestSha256',r.manifest_sha256,
 'implementationSha256',encode(sha256(convert_to(pg_get_functiondef('owned_synthetic.deployment_project(jsonb,boolean)'::regprocedure),'UTF8')),'hex'),
 'before',beforestate,'projected',afterstate,'restored',restored,'persistentMutations',0,'targetSettingUndoRequiresFreshApproval',true);
 rollbackhash:=owned_synthetic.snapshot_sha256(rollback);stamp:=clock_timestamp();
 proof:=jsonb_build_object('domain','axiom.owned-synthetic.enrollment-preflight.v1','taskId',task.id,'claimId',p_claim_id,'manifestSha256',r.manifest_sha256,
 'host',p_host,'database',db,'rollback',rollback,'observedAt',stamp);
 proofhash:=owned_synthetic.snapshot_sha256(proof);
 receipt:=public.append_ledger(task.tenant_id,task.id,'system','owned-synthetic-readonly-preflight',null,null,null,'deployment.owned_preflight',r.id::text,task.intent_sha256,proofhash,null,null,null,null,'success',jsonb_build_object('stage','completed_readonly_observation','target_mutations',0,'rollback_sha256',rollbackhash));
 proof:=jsonb_build_object('sha256',proofhash,'completedAt',stamp,'expiresAt',least(stamp+interval '5 minutes',r.expires_at),'rollbackSha256',rollbackhash,'dryRunCompleted',true,'rollbackValidated',true,
 'checks',jsonb_build_array(jsonb_build_object('name','Pinned host images, source and workload parent','outcome','passed','detail','Actual read-only host metadata, bound to the single claimed task'),
 jsonb_build_object('name','New dedicated resource and restricted role graph','outcome','passed','detail','Actual database source and role graph inspected; no grant or target write'),
 jsonb_build_object('name','Deployment rollback projection','outcome','passed','detail','Executed fixed no-write reducer; revokes new execution authority and retains resources and journals; target undo needs fresh approval')),'receiptId',receipt::text);
 if task.expires_at<=clock_timestamp() then raise exception 'owned deployment observation deadline elapsed' using errcode='42501';end if;
 perform owned_synthetic.deployment_live_source(r);
 insert into owned_synthetic.deployment_observations(task_id,claim_id,host_observation,host_sha256,database_observation,rollback_observation,preflight,observed_at,receipt_id)
 values(task.id,p_claim_id,p_host,hosthash,db,rollback,proof,stamp,receipt);
 update owned_synthetic.deployment_heads set state='preflight_ready',preflight=proof where request_id=r.id;
 update owned_synthetic.deployment_operations set outcome='recorded',result=owned_synthetic.deployment_summary(r),receipt_id=receipt where(tenant_id,actor_id,request_id,phase,operation_key)=(task.tenant_id,task.actor_id,r.id,'preflight',task.id);
 return owned_synthetic.deployment_summary(r);
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.record_owned_deployment_preflight(uuid,uuid,jsonb) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.record_owned_deployment_preflight(uuid,uuid,jsonb) to service_role;
create function owned_synthetic.deployment_action_id(r uuid,step text) returns uuid
language plpgsql immutable set search_path='' as $$
declare b bytea;h text;begin
 if step not in('enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope') then raise exception 'owned deployment step refused' using errcode='22023';end if;
 b:=decode(owned_synthetic.snapshot_sha256(jsonb_build_object('domain','axiom.owned-synthetic.enrollment-action.v1','requestId',r,'step',step)),'hex');
 b:=set_byte(b,6,(get_byte(b,6)&15)|128);b:=set_byte(b,8,(get_byte(b,8)&63)|128);h:=encode(substring(b from 1 for 16),'hex');
 return(substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21))::uuid;
end $$;
create function public.read_owned_deployment_source(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare r owned_synthetic.deployment_requests;begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));perform owned_synthetic.deployment_lock(p_tenant_id,p_request_id);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 perform owned_synthetic.deployment_live_source(r);
 return jsonb_build_object('summary',owned_synthetic.deployment_summary(r),'manifest',r.manifest);
end $$;
create function public.record_owned_deployment_mfa_phase(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_phase text,p_decision jsonb,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d owned_synthetic.deployment_decisions;r owned_synthetic.deployment_requests;c public.mfa_challenges;
 prior owned_synthetic.deployment_operations;intent jsonb;digest text;result jsonb;op uuid;receipt bigint;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);
 if p_phase not in('challenge','verify') or p_challenge_id is null then raise exception 'owned deployment MFA phase refused' using errcode='22023';end if;
 op:=(p_decision->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,p_phase,op);
 intent:=jsonb_build_object('phase',p_phase,'request',p_decision);
 if p_phase='verify' then intent:=intent||jsonb_build_object('challengeId',p_challenge_id);end if;
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,p_request_id,op,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,p_phase,op);
 if found then
  if prior.intent_sha256<>digest or prior.intent<>intent then raise exception 'owned deployment MFA operation conflict' using errcode='23505';end if;
  return prior.phase_result;
 end if;
 select * into strict d from owned_synthetic.deployment_decisions where(tenant_id,actor_id,operation_key,request_id,session_id)=(p_tenant_id,p_actor_id,op,p_request_id,p_session_id) for share;
 if d.decision is distinct from p_decision then raise exception 'owned deployment decision changed' using errcode='42501';end if;
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 perform owned_synthetic.deployment_live_source(r);
 select * into c from public.mfa_challenges where id=p_challenge_id for share;
 if c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id or c.purpose::text is distinct from 'owned_synthetic_enrollment'
 or c.bound_resource_ref is distinct from op::text or c.bound_payload_sha256 is distinct from d.bound_payload_sha256
 or c.created_at>clock_timestamp() or c.expires_at<=clock_timestamp() or c.consumed_at is not null or c.attempts>c.max_attempts
 or(p_phase='verify' and(c.satisfied_at is null or c.satisfied_with is null))
 then raise exception 'owned deployment MFA phase source refused' using errcode='42501';end if;
 result:=case when p_phase='challenge' then jsonb_build_object('phase','challenge','challenge',jsonb_build_object('challengeId',c.id,'expiresAt',c.expires_at,'maxAttempts',c.max_attempts))
 else jsonb_build_object('phase','verify','verified',true) end;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_requested',r.id::text,digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage',p_phase,'target_mutations',0));
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,result,phase_result,receipt_id)
 values(p_tenant_id,p_actor_id,r.id,p_phase,op,intent,digest,'recorded',owned_synthetic.deployment_summary(r),result,receipt);
 return result;
end $$;
create function public.record_owned_deployment_approval(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_decision jsonb,p_challenge_id uuid,p_token jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d owned_synthetic.deployment_decisions;r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;
 prior owned_synthetic.deployment_operations;c public.mfa_challenges;op uuid;intent jsonb;digest text;receipt bigint;approval uuid;conditions jsonb;spec jsonb;expected_actions jsonb;answer jsonb;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);
 op:=(p_decision->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,'approve',op);
 intent:=jsonb_build_object('phase','approve','request',p_decision,'challengeId',p_challenge_id);
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,p_request_id,op,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,'approve',op);
 if found then
  if prior.intent_sha256<>digest or prior.intent<>intent then raise exception 'owned deployment approval operation conflict' using errcode='23505';end if;
  return prior.result;
 end if;
 select * into strict d from owned_synthetic.deployment_decisions where(tenant_id,actor_id,operation_key,request_id,session_id)=(p_tenant_id,p_actor_id,op,p_request_id,p_session_id) for share;
 if d.decision is distinct from p_decision then raise exception 'owned deployment decision changed' using errcode='42501';end if;
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for update;
 if h.state<>'preflight_ready' or h.approval_id is not null or h.installation_key is not null
 or p_decision->>'expectedManifestSha256' is distinct from r.manifest_sha256
 or p_decision->>'expectedPreflightSha256' is distinct from h.preflight->>'sha256'
 or p_decision->>'expectedRollbackSha256' is distinct from h.preflight->>'rollbackSha256'
 or h.preflight->'dryRunCompleted' is distinct from 'true'::jsonb or h.preflight->'rollbackValidated' is distinct from 'true'::jsonb
 or(h.preflight->>'expiresAt')::timestamptz<=clock_timestamp()
 or not exists(select 1 from owned_synthetic.deployment_observations observation where observation.task_id=h.preflight_key and observation.preflight=h.preflight)
 then raise exception 'owned deployment approval current proof refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for share;
 if c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id or c.purpose::text is distinct from 'owned_synthetic_enrollment'
 or c.bound_resource_ref is distinct from op::text or c.bound_payload_sha256 is distinct from d.bound_payload_sha256
 or c.consumed_for is distinct from op::text or c.consumed_at is null or c.satisfied_at is null or c.satisfied_with is null
 or c.expires_at<=clock_timestamp() or c.created_at>clock_timestamp() or c.attempts>c.max_attempts
 or not exists(select 1 from public.user_mfa_factors f where f.id=c.factor_id and f.user_id=p_actor_id and f.factor_type='totp' and f.status='active' and f.revoked_at is null)
 then raise exception 'owned deployment approval fresh MFA refused' using errcode='42501';end if;
 conditions:=jsonb_build_object('purpose','owned_synthetic_enrollment_v1','tenantId',r.tenant_id,'enrollmentId',r.id,'bindingId',r.binding_id,
 'manifestSha256',r.manifest_sha256,'preflightSha256',h.preflight->>'sha256','rollbackSha256',h.preflight->>'rollbackSha256',
 'custodyPolicyId',r.custody_policy_id,'custodyEpoch',r.custody_epoch,'scopeExpiresAt',r.manifest->>'expiresAt','decisionSha256',owned_synthetic.snapshot_sha256(p_decision));
 select jsonb_agg(owned_synthetic.deployment_action_id(r.id,step) order by owned_synthetic.deployment_action_id(r.id,step)) into expected_actions from unnest(array['enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope']) with ordinality fixed(step,ordinal);
 spec:=p_token->'spec';
 if jsonb_typeof(p_token) is distinct from 'object' or not(p_token?&array['spec','signature']) or p_token-array['spec','signature']<>'{}'::jsonb
 or jsonb_typeof(p_token->'signature') is distinct from 'string' or p_token->>'signature' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(spec) is distinct from 'object' or not(spec?&array['planId','actionIds','approverId','mode','concurrency','stopOnFailure','expiresAt','nonce','conditions','contentDigest'])
 or spec-array['planId','actionIds','approverId','mode','concurrency','stopOnFailure','expiresAt','nonce','conditions','contentDigest']<>'{}'::jsonb
 or spec->>'planId' is distinct from r.id::text or spec->>'approverId' is distinct from p_actor_id::text
 or spec->>'mode' is distinct from 'batch' or spec->'concurrency' is distinct from '1'::jsonb or spec->'stopOnFailure' is distinct from 'true'::jsonb
 or spec->'actionIds' is distinct from expected_actions or spec->'conditions' is distinct from conditions
 or spec->>'contentDigest' is distinct from owned_synthetic.snapshot_sha256(jsonb_build_object('domain','owned_synthetic_enrollment_v1','manifest',r.manifest,'conditions',conditions))
 or jsonb_typeof(spec->'nonce') is distinct from 'string' or spec->>'nonce' !~ '^[a-f0-9]{32}$'
 or jsonb_typeof(spec->'expiresAt') is distinct from 'string' or(spec->>'expiresAt')::timestamptz<=clock_timestamp()
 or(spec->>'expiresAt')::timestamptz>least(clock_timestamp()+interval '15 minutes',(h.preflight->>'expiresAt')::timestamptz,r.expires_at)
 then raise exception 'owned deployment signed scope refused' using errcode='42501';end if;
 approval:=gen_random_uuid();
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_approved',r.id::text,digest,owned_synthetic.snapshot_sha256(p_token),null,null,null,null,'success',jsonb_build_object('approval_id',approval,'purpose','owned_synthetic_enrollment_v1','target_mutations',0));
 insert into owned_synthetic.deployment_approvals(id,tenant_id,request_id,actor_id,session_id,operation_key,challenge_id,decision,decision_sha256,signed_token,role_graph,preflight_sha256,rollback_sha256,scope_expires_at,receipt_id)
 values(approval,p_tenant_id,r.id,p_actor_id,p_session_id,op,p_challenge_id,p_decision,d.bound_payload_sha256,p_token,(select database_observation->'roleGraph' from owned_synthetic.deployment_observations where task_id=h.preflight_key),h.preflight->>'sha256',h.preflight->>'rollbackSha256',r.expires_at,receipt);
 update owned_synthetic.deployment_heads set state='approved',approval_id=approval where request_id=r.id;
 answer:=owned_synthetic.deployment_summary(r);
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,result,receipt_id)
 values(p_tenant_id,p_actor_id,r.id,'approve',op,intent,digest,'recorded',answer,receipt);
 return answer;
end $$;
create function public.read_owned_deployment_installer_source(p_tenant_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment installer transport refused' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));perform owned_synthetic.deployment_lock(p_tenant_id,p_request_id);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 perform owned_synthetic.deployment_live_source(r);
 select approval.* into strict a from owned_synthetic.deployment_approvals approval join owned_synthetic.deployment_heads h on h.approval_id=approval.id where h.request_id=r.id and h.state in('approved','installing','active');
 if a.scope_expires_at<=clock_timestamp() then raise exception 'owned deployment approved scope expired' using errcode='42501';end if;
 return jsonb_build_object('source',jsonb_build_object('summary',owned_synthetic.deployment_summary(r),'manifest',r.manifest),'decision',a.decision,'token',a.signed_token);
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.read_owned_deployment_source(uuid,uuid,uuid,uuid),public.record_owned_deployment_mfa_phase(uuid,uuid,uuid,uuid,text,jsonb,uuid),public.record_owned_deployment_approval(uuid,uuid,uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.read_owned_deployment_source(uuid,uuid,uuid,uuid),public.record_owned_deployment_mfa_phase(uuid,uuid,uuid,uuid,text,jsonb,uuid),public.record_owned_deployment_approval(uuid,uuid,uuid,uuid,jsonb,uuid,jsonb) to human_action_writer;
revoke all on function public.read_owned_deployment_installer_source(uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.read_owned_deployment_installer_source(uuid,uuid) to service_role;
-- JTI reservations are append-only and can mint only one exact short-lived
-- credential for a retained, currently approved enrollment. No signing key lives
-- in these tables, BFF route responses to humans, or the host poller.
create table owned_synthetic.deployment_credential_reservations (
 id uuid primary key,tenant_id uuid not null,request_id uuid not null,binding_id uuid not null,
 approval_id uuid not null,custody_epoch bigint not null,reservation_sha256 text not null check(reservation_sha256~'^[a-f0-9]{64}$'),
 metadata jsonb not null,issued_at timestamptz not null,expires_at timestamptz not null,receipt_id bigint not null,
 check(expires_at>issued_at and expires_at<=issued_at+interval '15 minutes'),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id),
 foreign key(tenant_id,approval_id) references owned_synthetic.deployment_approvals(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
alter table owned_synthetic.deployment_credential_reservations enable row level security;
revoke all on owned_synthetic.deployment_credential_reservations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create trigger owned169_reservation_retained before update or delete on owned_synthetic.deployment_credential_reservations for each row execute function public.evidence_receipt_immutable();
create trigger owned169_reservation_no_truncate before truncate on owned_synthetic.deployment_credential_reservations for each statement execute function public.evidence_receipt_immutable();

create function owned_synthetic.deployment_current_approval(t uuid,rid uuid) returns owned_synthetic.deployment_approvals
language plpgsql security definer set search_path='' as $$
declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;h owned_synthetic.deployment_heads;begin
 perform pg_advisory_xact_lock_shared(hashtextextended(t::text,47));perform owned_synthetic.deployment_lock(t,rid);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(t,rid) for share;
 perform owned_synthetic.deployment_live_source(r);
 select * into strict h from owned_synthetic.deployment_heads where request_id=rid for share;
 select * into strict a from owned_synthetic.deployment_approvals where(tenant_id,id,request_id)=(t,h.approval_id,rid) for share;
 perform owned_synthetic.deployment_require_role_graph(a.role_graph);
 perform 1 from public.platform_founders founder join public.users u on u.id=founder.user_id
 where founder.user_id=a.actor_id and founder.revoked_at is null and u.is_axiom_internal for share of founder,u;
 if not found then raise exception 'owned deployment approving founder revoked' using errcode='42501';end if;

 if h.state not in('approved','installing','active') or a.scope_expires_at<=clock_timestamp() or a.scope_expires_at<>r.expires_at
 or a.preflight_sha256 is distinct from h.preflight->>'sha256' or a.rollback_sha256 is distinct from h.preflight->>'rollbackSha256'
 or not exists(select 1 from public.platform_founders founder join public.users u on u.id=founder.user_id where founder.user_id=a.actor_id and founder.revoked_at is null and u.is_axiom_internal)
 then raise exception 'owned deployment current approval refused' using errcode='42501';end if;
 return a;
end $$;
-- Final checks are repeated after waits/effects, close to transaction return.
-- A pre-lock timestamp or earlier service HMAC check cannot extend expiry.
create function owned_synthetic.deployment_write_fence(t uuid,rid uuid,installer boolean) returns void
language plpgsql security definer set search_path='' as $$declare a owned_synthetic.deployment_approvals;begin
 a:=owned_synthetic.deployment_current_approval(t,rid);
 if installer and(a.signed_token#>>'{spec,expiresAt}')::timestamptz<=clock_timestamp()
 then raise exception 'owned deployment installer expired before publication' using errcode='42501';end if;
end $$;
create function public.reserve_owned_deployment_credential(p_tenant_id uuid,p_request_id uuid,p_credential_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare a owned_synthetic.deployment_approvals;r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;
 prior owned_synthetic.deployment_credential_reservations;stamp timestamptz;expiry timestamptz;metadata jsonb;digest text;receipt bigint;
begin
 if current_setting('role',true) is distinct from 'service_role' or p_credential_id is null then raise exception 'owned deployment credential transport refused' using errcode='42501';end if;
 a:=owned_synthetic.deployment_current_approval(p_tenant_id,p_request_id);
 select * into strict r from owned_synthetic.deployment_requests where id=p_request_id;
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id;
 if h.state<>'active' and(h.state<>'installing' or(a.signed_token#>>'{spec,expiresAt}')::timestamptz<=clock_timestamp()
 or not exists(select 1 from owned_synthetic.deployment_steps s where s.request_id=r.id and s.step='publish_scoped_credential' and s.transition='authorized')
 or exists(select 1 from owned_synthetic.deployment_steps s where s.request_id=r.id and s.step='publish_scoped_credential' and s.transition in('unconfirmed','revoked')))
 then raise exception 'owned deployment credential installation scope refused' using errcode='42501';end if;
 select * into prior from owned_synthetic.deployment_credential_reservations where id=p_credential_id;
 if found then
  if(prior.tenant_id,prior.request_id,prior.binding_id,prior.approval_id,prior.custody_epoch) is distinct from(p_tenant_id,r.id,r.binding_id,a.id,r.custody_epoch)
  or prior.expires_at<=clock_timestamp() then raise exception 'owned deployment credential reservation refused' using errcode='42501';end if;
  perform owned_synthetic.deployment_write_fence(p_tenant_id,r.id,h.state<>'active');
  return prior.metadata||jsonb_build_object('reservationSha256',prior.reservation_sha256);
 end if;
 stamp:=to_timestamp(floor(extract(epoch from clock_timestamp())));
 expiry:=to_timestamp(floor(extract(epoch from least(stamp+make_interval(secs=>(r.manifest#>>'{deployment,credentialLifetimeSeconds}')::int),r.expires_at))));
 if expiry<=stamp then raise exception 'owned deployment credential expired' using errcode='42501';end if;
 metadata:=jsonb_build_object('tenantId',p_tenant_id,'bindingId',r.binding_id,'enrollmentId',r.id,'credentialId',p_credential_id,'custodyEpoch',r.custody_epoch,
 'manifestSha256',r.manifest_sha256,'issuerConfigurationSha256',r.manifest#>>'{source,issuerConfigurationSha256}',
 'issuedAt',extract(epoch from stamp)::bigint,'expiresAtSeconds',extract(epoch from expiry)::bigint,'expiresAt',to_char(expiry at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
 'scopeExpiresAtSeconds',floor(extract(epoch from r.expires_at))::bigint,'hostInstallerSha256',r.manifest#>>'{source,hostInstallerSha256}',
 'bffContainerId',r.manifest#>>'{deployment,bffContainerId}','bffImage',r.manifest#>>'{deployment,bffImage}');
 digest:=owned_synthetic.snapshot_sha256(metadata);
 receipt:=public.append_ledger(p_tenant_id,p_credential_id,'system','owned-synthetic-scoped-issuer',null,null,null,'deployment.owned_credential',r.id::text,r.manifest_sha256,digest,null,null,null,null,'pending',jsonb_build_object('stage','reserved_jti','credential_id',p_credential_id,'target_mutations',0));
 insert into owned_synthetic.deployment_credential_reservations(id,tenant_id,request_id,binding_id,approval_id,custody_epoch,reservation_sha256,metadata,issued_at,expires_at,receipt_id)
 values(p_credential_id,p_tenant_id,r.id,r.binding_id,a.id,r.custody_epoch,digest,metadata,stamp,expiry,receipt);
 perform owned_synthetic.deployment_write_fence(p_tenant_id,r.id,h.state<>'active');
 if expiry<=clock_timestamp() then raise exception 'owned deployment credential expired before publication' using errcode='42501';end if;
 return metadata||jsonb_build_object('reservationSha256',digest);
end $$;
create function owned_synthetic.deployment_claims(t uuid,b uuid,allow_reserved boolean default false) returns owned_synthetic.deployment_credential_reservations
language plpgsql security definer set search_path='' as $$
declare claims jsonb;reserved owned_synthetic.deployment_credential_reservations;a owned_synthetic.deployment_approvals;r owned_synthetic.deployment_requests;begin
 if current_setting('role',true) is distinct from 'owned_target_controller' then raise exception 'owned target credential role refused' using errcode='42501';end if;
 begin claims:=current_setting('request.jwt.claims',true)::jsonb;exception when others then raise exception 'owned target credential claims refused' using errcode='42501';end;
 if claims is null or jsonb_typeof(claims) is distinct from 'object' or claims->>'role' is distinct from 'owned_target_controller'
 or claims->>'owned_target_purpose' is distinct from 'owned_synthetic_target_v1'
 or claims->>'tenant_id' is distinct from t::text or claims->>'binding_id' is distinct from b::text
 or jsonb_typeof(claims->'jti') is distinct from 'string' or claims->>'jti' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 then raise exception 'owned target credential scope refused' using errcode='42501';end if;
 select * into reserved from owned_synthetic.deployment_credential_reservations where id=(claims->>'jti')::uuid;
 if reserved.id is null or(reserved.tenant_id,reserved.binding_id) is distinct from(t,b)
 or claims->>'enrollment_id' is distinct from reserved.request_id::text or claims->'custody_epoch' is distinct from to_jsonb(reserved.custody_epoch)
 or claims->'iat' is distinct from to_jsonb(extract(epoch from reserved.issued_at)::bigint)
 or claims->'exp' is distinct from to_jsonb(extract(epoch from reserved.expires_at)::bigint)
 or reserved.issued_at>clock_timestamp() or reserved.expires_at<=clock_timestamp()
 or exists(select 1 from owned_synthetic.deployment_credential_revocations where credential_id=reserved.id)
 then raise exception 'owned target credential current claims refused' using errcode='42501';end if;
 a:=owned_synthetic.deployment_current_approval(t,reserved.request_id);
 select * into strict r from owned_synthetic.deployment_requests where id=reserved.request_id;
 if reserved.approval_id<>a.id or reserved.custody_epoch<>r.custody_epoch or reserved.expires_at>a.scope_expires_at
 or(not allow_reserved and(not exists(select 1 from owned_synthetic.deployment_credentials c where(c.id,c.tenant_id,c.request_id,c.binding_id,c.approval_id,c.custody_epoch)=(reserved.id,t,r.id,b,a.id,r.custody_epoch))
 or not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and state='active')))
 then raise exception 'owned target credential enrollment refused' using errcode='42501';end if;
 return reserved;
end $$;
-- A real signed PostgREST call to this read-only function proves that its JWT
-- cryptography and authenticator role switch work before private publication.
-- Reserved credentials cannot read/change the synthetic target through it.
create function public.verify_owned_target_transport(p_tenant_id uuid,p_binding_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare c owned_synthetic.deployment_credential_reservations;begin
 c:=owned_synthetic.deployment_claims(p_tenant_id,p_binding_id,true);
 return jsonb_build_object('tenantId',c.tenant_id,'bindingId',c.binding_id,'enrollmentId',c.request_id,'credentialId',c.id,'custodyEpoch',c.custody_epoch,'reservationSha256',c.reservation_sha256,'transportVerified',true);
end $$;
create function public.complete_owned_deployment_credential(p_tenant_id uuid,p_request_id uuid,p_credential_id uuid,p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare reserved owned_synthetic.deployment_credential_reservations;a owned_synthetic.deployment_approvals;r owned_synthetic.deployment_requests;old owned_synthetic.deployment_credentials;receipt bigint;begin
 if current_setting('role',true) is distinct from 'service_role' or p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment credential completion refused' using errcode='42501';end if;
 a:=owned_synthetic.deployment_current_approval(p_tenant_id,p_request_id);
 select * into strict r from owned_synthetic.deployment_requests where id=p_request_id;
 select * into strict reserved from owned_synthetic.deployment_credential_reservations where(id,tenant_id,request_id,binding_id,approval_id,custody_epoch)=(p_credential_id,p_tenant_id,r.id,r.binding_id,a.id,r.custody_epoch);
 if reserved.expires_at<=clock_timestamp() then raise exception 'owned deployment credential expired' using errcode='42501';end if;
 select * into old from owned_synthetic.deployment_credentials where id=reserved.id;
 if found then
  if old.token_sha256<>p_token_sha256 then raise exception 'owned deployment credential conflict' using errcode='23505';end if;
 else
  receipt:=public.append_ledger(p_tenant_id,reserved.id,'system','owned-synthetic-scoped-issuer',null,null,null,'deployment.owned_credential',r.id::text,reserved.reservation_sha256,p_token_sha256,null,null,null,null,'success',jsonb_build_object('stage','crypto_transport_verified','credential_id',reserved.id,'target_mutations',0));
  insert into owned_synthetic.deployment_credentials(id,tenant_id,request_id,binding_id,approval_id,custody_epoch,token_sha256,issued_at,expires_at,receipt_id)
  values(reserved.id,p_tenant_id,r.id,r.binding_id,a.id,r.custody_epoch,p_token_sha256,reserved.issued_at,reserved.expires_at,receipt);
 end if;
 perform owned_synthetic.deployment_write_fence(p_tenant_id,r.id,not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and state='active'));
 if reserved.expires_at<=clock_timestamp() then raise exception 'owned deployment credential expired before completion' using errcode='42501';end if;
 return jsonb_build_object('credentialId',reserved.id,'active',true,'tokenSha256',p_token_sha256);
end $$;
-- Upgrade every environment, including test. Previously arbitrary registration
-- UUIDs confer no authority; only retained exact founder-approved enrollment can
-- support a binding. No fixture/demo bypass or automatic grant is introduced.
alter function owned_synthetic.require_binding(uuid,uuid,uuid) rename to require_binding_before169;
create function owned_synthetic.require_binding(t uuid,b uuid,e uuid) returns owned_synthetic.bindings
language plpgsql volatile security definer set search_path='' as $$
declare binding owned_synthetic.bindings;r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;begin
 binding:=owned_synthetic.require_binding_before169(t,b,e);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,binding_id)=(t,b);
 a:=owned_synthetic.deployment_current_approval(t,r.id);
 if(binding.approval_reference,binding.custody_policy_id,binding.custody_activation_epoch,binding.fixture_id,binding.resource_id,binding.expires_at)
 is distinct from(a.id,r.custody_policy_id,r.custody_epoch,r.fixture_id,r.resource_id,r.expires_at)
 or not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and state='active')
 then raise exception 'owned target approved binding refused' using errcode='42501';end if;
 -- A target credential cannot reinterpret enrollment or another domain's
 -- accepted token as remediation merely by matching the action/batch UUIDs.
 if binding.action_id is not null and exists(select 1 from public.remediation_actions action join public.approval_tokens token on(token.tenant_id,token.id)=(action.tenant_id,action.approval_token_id)
 where(action.tenant_id,action.id)=(t,binding.action_id) and token.signed_payload?'conditions'
 and(jsonb_typeof(token.signed_payload->'conditions') is distinct from 'object'
 or((token.signed_payload->'conditions')?'purpose' and token.signed_payload#>'{conditions,purpose}' is distinct from '"remediation_execution_v1"'::jsonb)))
 then raise exception 'owned target remediation purpose refused' using errcode='42501';end if;
 if current_setting('role',true)='owned_target_controller' then perform owned_synthetic.deployment_claims(t,b,false);end if;
 return binding;
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.reserve_owned_deployment_credential(uuid,uuid,uuid),public.complete_owned_deployment_credential(uuid,uuid,uuid,text) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.reserve_owned_deployment_credential(uuid,uuid,uuid),public.complete_owned_deployment_credential(uuid,uuid,uuid,text) to service_role;
revoke all on function public.verify_owned_target_transport(uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.verify_owned_target_transport(uuid,uuid) to owned_target_controller;
create function public.prepare_owned_deployment_install(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;h owned_synthetic.deployment_heads;prior owned_synthetic.deployment_operations;op uuid;intent jsonb;digest text;receipt bigint;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if jsonb_typeof(p_request) is distinct from 'object' or not(p_request?&array['operationKey','expectedManifestSha256','expectedApprovalId'])
 or p_request-array['operationKey','expectedManifestSha256','expectedApprovalId']<>'{}'::jsonb
 then raise exception 'owned deployment install intent refused' using errcode='22023';end if;
 op:=(p_request->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));perform owned_synthetic.deployment_lock(p_tenant_id,p_request_id);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 intent:=jsonb_build_object('phase','install','request',p_request);digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,r.id,op,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,r.id,'install',op);
 if found then
  if prior.intent<>intent or prior.intent_sha256<>digest then raise exception 'owned deployment install conflict' using errcode='23505';end if;
  return owned_synthetic.deployment_summary(r);
 end if;
 a:=owned_synthetic.deployment_current_approval(p_tenant_id,r.id);
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for update;
 if h.state<>'approved' or h.installation_key is not null or(a.signed_token#>>'{spec,expiresAt}')::timestamptz<=clock_timestamp()
 or p_request->>'expectedManifestSha256' is distinct from r.manifest_sha256 or p_request->>'expectedApprovalId' is distinct from a.id::text
 then raise exception 'owned deployment install current approval refused' using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_step',r.id::text,digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage','installation_queued','target_mutations',0));
 update owned_synthetic.deployment_heads set state='installing',installation_key=op,installation_receipt=receipt where request_id=r.id;
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,receipt_id)
 values(p_tenant_id,p_actor_id,r.id,'install',op,intent,digest,'pending',receipt);
 return owned_synthetic.deployment_summary(r);
end $$;
create function owned_synthetic.deployment_step_source(t uuid,rid uuid,step_name text,signed_token jsonb) returns owned_synthetic.deployment_requests
language plpgsql security definer set search_path='' as $$
declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;h owned_synthetic.deployment_heads;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment step transport refused' using errcode='42501';end if;
 a:=owned_synthetic.deployment_current_approval(t,rid);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(t,rid) for share;
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for update;
 if h.state not in('installing','unconfirmed','active') or h.installation_key is null or a.signed_token is distinct from signed_token
 or(signed_token#>>'{spec,expiresAt}')::timestamptz<=clock_timestamp()
 or not((signed_token#>'{spec,actionIds}')?owned_synthetic.deployment_action_id(r.id,step_name)::text)
 or not exists(select 1 from owned_synthetic.deployment_observations o where o.task_id=h.preflight_key and o.preflight=h.preflight
 and o.preflight->>'sha256'=a.preflight_sha256 and o.preflight->>'rollbackSha256'=a.rollback_sha256)
 then raise exception 'owned deployment step signed source refused' using errcode='42501';end if;
 return r;
end $$;
create function owned_synthetic.deployment_step_receipt(r owned_synthetic.deployment_requests,step_name text,state text,readback jsonb) returns bigint
language plpgsql security definer set search_path='' as $$declare receipt bigint;op uuid;begin
 op:=owned_synthetic.deployment_action_id(r.id,step_name);
 receipt:=public.append_ledger(r.tenant_id,op,'system','owned-synthetic-fixed-installer',null,null,null,'deployment.owned_step',r.id::text,r.manifest_sha256,owned_synthetic.snapshot_sha256(readback),null,null,null,null,
 case when state='confirmed' then 'success' when state='unconfirmed' then 'failure' else 'pending' end::public.ledger_result,
 jsonb_build_object('step',step_name,'transition',state,'operation_key',op));
 insert into owned_synthetic.deployment_steps(id,tenant_id,request_id,step,transition,operation_key,readback,receipt_id)
 values(gen_random_uuid(),r.tenant_id,r.id,step_name,state,op,readback,receipt);
 return receipt;
end $$;
create function public.authorize_owned_deployment_step(p_tenant_id uuid,p_request_id uuid,p_step text,p_signed_token jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;previous owned_synthetic.deployment_steps;ordinal int;required text;receipt bigint;readback jsonb;role_oid oid;begin
 -- BFF MUST independently verify the exact HMAC on every invocation before this
 -- RPC; this fixed SQL transport additionally binds retained source/CAS/expiry.
 r:=owned_synthetic.deployment_step_source(p_tenant_id,p_request_id,p_step,p_signed_token);
 select * into strict a from owned_synthetic.deployment_approvals where request_id=r.id;
 select n into ordinal from unnest(array['enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope']) with ordinality fixed(step,n) where step=p_step;
 if ordinal is null then raise exception 'owned deployment step refused' using errcode='22023';end if;
 select * into previous from owned_synthetic.deployment_steps where request_id=r.id and step=p_step order by sequence desc limit 1;
 if found then return jsonb_build_object('step',p_step,'state',previous.transition,'newAuthorization',false,'receiptId',previous.receipt_id::text,'readback',previous.readback);end if;
 if ordinal>1 then
  select fixed.step into required from unnest(array['enroll_synthetic_resource','authorize_role_switch','publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope']) with ordinality fixed(step,n) where n=ordinal-1;
  select * into previous from owned_synthetic.deployment_steps where request_id=r.id and step=required order by sequence desc limit 1;
  if previous.transition is distinct from 'confirmed' then raise exception 'owned deployment previous step unconfirmed' using errcode='42501';end if;
 end if;
 receipt:=owned_synthetic.deployment_step_receipt(r,p_step,'authorized',jsonb_build_object('manifestSha256',r.manifest_sha256));
 if p_step='enroll_synthetic_resource' then
  if exists(select 1 from owned_synthetic.bindings where id=r.binding_id or(fixture_id,resource_id)=(r.fixture_id,r.resource_id))
  or exists(select 1 from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id))
  then raise exception 'owned deployment dedicated resource conflict' using errcode='42501';end if;
  insert into owned_synthetic.resources(fixture_id,resource_id) values(r.fixture_id,r.resource_id);
  insert into owned_synthetic.bindings(id,tenant_id,connector_id,engagement_id,fixture_id,resource_id,environment,label,scope,custody_policy_id,custody_activation_epoch,engine_sha256,capability_sha256,approval_reference,expires_at)
  values(r.binding_id,r.tenant_id,r.connector_id,r.engagement_id,r.fixture_id,r.resource_id,'local','Owned synthetic audit configuration','owned_synthetic_config.audit_log_enable',r.custody_policy_id,r.custody_epoch,r.manifest#>>'{source,engineSha256}',r.manifest#>>'{source,capabilitySha256}',a.id,r.expires_at);
  readback:=jsonb_build_object('fixtureId',r.fixture_id,'resourceId',r.resource_id,'bindingId',r.binding_id,'approvalId',a.id,'auditLogEnabled',(select audit_log_enabled from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id)),'version',(select version from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id)));
 elsif p_step='authorize_role_switch' then
  select oid into role_oid from pg_catalog.pg_roles where rolname='owned_target_controller' and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls;
  if role_oid is null or exists(select 1 from pg_catalog.pg_auth_members where member=role_oid)
  or exists(select 1 from pg_catalog.pg_auth_members edge join pg_catalog.pg_roles member on member.oid=edge.member where edge.roleid=role_oid and member.rolname<>'authenticator' and not member.rolsuper and member.oid<>(select nspowner from pg_catalog.pg_namespace where nspname='owned_synthetic'))
  then raise exception 'owned deployment role graph refused' using errcode='42501';end if;
  if not exists(select 1 from pg_catalog.pg_auth_members edge join pg_catalog.pg_roles member on member.oid=edge.member where edge.roleid=role_oid and member.rolname='authenticator') then
   grant owned_target_controller to authenticator with admin false,inherit false,set true;
  end if;
  if not pg_has_role('authenticator','owned_target_controller','MEMBER') then raise exception 'owned deployment role switch readback refused' using errcode='42501';end if;
  readback:=jsonb_build_object('role','owned_target_controller','member','authenticator','membershipConfirmed',true,'outgoingRoleMemberships',0);
 end if;
 if readback is not null then
  receipt:=owned_synthetic.deployment_step_receipt(r,p_step,'confirmed',readback);
  perform owned_synthetic.deployment_write_fence(r.tenant_id,r.id,true);
  return jsonb_build_object('step',p_step,'state','confirmed','newAuthorization',false,'receiptId',receipt::text,'readback',readback);
 end if;
 perform owned_synthetic.deployment_write_fence(r.tenant_id,r.id,true);
 return jsonb_build_object('step',p_step,'state','authorized','newAuthorization',true,'receiptId',receipt::text,'readback',null);
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.prepare_owned_deployment_install(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.prepare_owned_deployment_install(uuid,uuid,uuid,uuid,jsonb) to human_action_writer;
revoke all on function public.authorize_owned_deployment_step(uuid,uuid,text,jsonb) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.authorize_owned_deployment_step(uuid,uuid,text,jsonb) to service_role;
create function public.verify_owned_deployment_founder(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 perform owned_synthetic.deployment_founder(p_tenant_id,p_actor_id,p_session_id);
 return '{"verified":true}'::jsonb;
end $$;
revoke all on function public.verify_owned_deployment_founder(uuid,uuid,uuid) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.verify_owned_deployment_founder(uuid,uuid,uuid) to human_action_writer;
create function public.confirm_owned_deployment_step(p_tenant_id uuid,p_request_id uuid,p_step text,p_signed_token jsonb,p_readback jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;previous owned_synthetic.deployment_steps;receipt bigint;credential owned_synthetic.deployment_credentials;
 observed owned_synthetic.deployment_observations;registration public.workload_identities;expected_registration jsonb;controller jsonb;published jsonb;karya jsonb;
 begin
 r:=owned_synthetic.deployment_step_source(p_tenant_id,p_request_id,p_step,p_signed_token);
 select * into previous from owned_synthetic.deployment_steps where request_id=r.id and step=p_step order by sequence desc limit 1;
 if previous.transition='confirmed' then
  if previous.readback is distinct from p_readback then raise exception 'owned deployment readback conflict' using errcode='23505';end if;
  return jsonb_build_object('step',p_step,'state','confirmed','receiptId',previous.receipt_id::text);
 end if;
 if previous.transition is null or previous.transition not in('authorized','unconfirmed') or p_step not in('publish_scoped_credential','register_karya_identity','stage_owned_controller','verify_installed_scope')
 or jsonb_typeof(p_readback) is distinct from 'object'
 then raise exception 'owned deployment readback scope refused' using errcode='42501';end if;
 if p_step='publish_scoped_credential' then
  if not(p_readback?&array['credentialId','credentialSha256','filePublished']) or p_readback-array['credentialId','credentialSha256','filePublished']<>'{}'::jsonb
  or p_readback->'filePublished' is distinct from 'true'::jsonb then raise exception 'owned deployment credential readback refused' using errcode='42501';end if;
  select * into credential from owned_synthetic.deployment_credentials where id=(p_readback->>'credentialId')::uuid and tenant_id=r.tenant_id and request_id=r.id and binding_id=r.binding_id and custody_epoch=r.custody_epoch;
  if credential.id is null or credential.token_sha256 is distinct from p_readback->>'credentialSha256' or credential.expires_at<=clock_timestamp()
  or exists(select 1 from owned_synthetic.deployment_credential_revocations where credential_id=credential.id)
  then raise exception 'owned deployment credential readback refused' using errcode='42501';end if;
 elsif p_step='register_karya_identity' then
  if not(p_readback?&array['entryId','spiffeId','parentId','workerUid']) or p_readback-array['entryId','spiffeId','parentId','workerUid']<>'{}'::jsonb
  or jsonb_typeof(p_readback->'entryId') is distinct from 'string' or p_readback->>'entryId' !~ '^[A-Za-z0-9_-]{1,128}$'
  or p_readback->'spiffeId' is distinct from r.manifest#>'{deployment,spiffeId}' or p_readback->'parentId' is distinct from r.manifest#>'{deployment,nodeId}'
  or p_readback->'workerUid' is distinct from '20005'::jsonb then raise exception 'owned deployment identity readback refused' using errcode='42501';end if;
  select observation.* into strict observed from owned_synthetic.deployment_observations observation join owned_synthetic.deployment_heads h on h.preflight_key=observation.task_id where h.request_id=r.id;
  expected_registration:=observed.database_observation->'karyaRegistration';
  select * into registration from public.workload_identities where tenant_id=r.tenant_id and spiffe_id='spiffe://local.axiomproof.test/agent/karya' for update;
  if expected_registration is distinct from 'null'::jsonb and expected_registration is distinct from jsonb_build_object('id',registration.id,'status',registration.status,'version',registration.version)
  or(expected_registration='null'::jsonb and registration.id is not null)
  then raise exception 'owned deployment application registration changed since review' using errcode='42501';end if;
  -- Exact founder-reviewed application registration only; connector grants and
  -- old workload tasks are never revived by this activation.
  if registration.id is null then
   insert into public.workload_identities(tenant_id,agent_name,spiffe_id,status) values(r.tenant_id,'karya','spiffe://local.axiomproof.test/agent/karya','active') returning * into registration;
  elsif registration.agent_name<>'karya' then raise exception 'owned deployment application identity refused' using errcode='42501';
  elsif registration.status='disabled' then
   update public.workload_identities set status='active',version=version+1,updated_at=clock_timestamp() where id=registration.id returning * into registration;
  end if;
 elsif p_step='stage_owned_controller' then
  select observation.* into strict observed from owned_synthetic.deployment_observations observation join owned_synthetic.deployment_heads h on h.preflight_key=observation.task_id where h.request_id=r.id;
  if observed.host_observation->'controller' is distinct from 'null'::jsonb
  and p_readback->'containerId' is distinct from observed.host_observation#>'{controller,containerId}'
  then raise exception 'owned deployment reviewed controller replacement refused' using errcode='42501';end if;
  if not(p_readback?&array['containerId','controllerName','controllerImage','workerImage','workerUid','controllerUid','socketGid','bffContainerId','bffImage','socketReady'])
  or p_readback-array['containerId','controllerName','controllerImage','workerImage','workerUid','controllerUid','socketGid','bffContainerId','bffImage','socketReady']<>'{}'::jsonb
  or jsonb_typeof(p_readback->'containerId') is distinct from 'string' or p_readback->>'containerId' !~ '^[a-f0-9]{64}$'
  or p_readback->'controllerName' is distinct from r.manifest#>'{deployment,controllerName}'
  or p_readback->'controllerImage' is distinct from r.manifest#>'{deployment,controllerImage}'
  or p_readback->'workerImage' is distinct from r.manifest#>'{deployment,workerImage}'
  or p_readback->'workerUid' is distinct from '20005'::jsonb or p_readback->'controllerUid' is distinct from '20106'::jsonb or p_readback->'socketGid' is distinct from '20113'::jsonb
  or p_readback->'bffContainerId' is distinct from r.manifest#>'{deployment,bffContainerId}' or p_readback->'bffImage' is distinct from r.manifest#>'{deployment,bffImage}'
  or p_readback->'socketReady' is distinct from 'true'::jsonb then raise exception 'owned deployment controller readback refused' using errcode='42501';end if;
 else
  if not(p_readback?&array['credential','identity','controller','cryptoTransportVerified','allSixReadBack'])
  or p_readback-array['credential','identity','controller','cryptoTransportVerified','allSixReadBack']<>'{}'::jsonb
  or p_readback->'cryptoTransportVerified' is distinct from 'true'::jsonb or p_readback->'allSixReadBack' is distinct from 'true'::jsonb
  then raise exception 'owned deployment final readback refused' using errcode='42501';end if;
  select readback into published from owned_synthetic.deployment_steps where request_id=r.id and step='publish_scoped_credential' and transition='confirmed' order by sequence desc limit 1;
  select readback into karya from owned_synthetic.deployment_steps where request_id=r.id and step='register_karya_identity' and transition='confirmed' order by sequence desc limit 1;
  select readback into controller from owned_synthetic.deployment_steps where request_id=r.id and step='stage_owned_controller' and transition='confirmed' order by sequence desc limit 1;
  if published is null or karya is null or controller is null or p_readback->'credential' is distinct from published or p_readback->'identity' is distinct from karya or p_readback->'controller' is distinct from controller
  or not exists(select 1 from public.workload_identities where tenant_id=r.tenant_id and agent_name='karya' and spiffe_id='spiffe://local.axiomproof.test/agent/karya' and status='active')
  or not exists(select 1 from owned_synthetic.deployment_credentials c where c.id=(published->>'credentialId')::uuid and c.request_id=r.id and c.token_sha256=published->>'credentialSha256' and c.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=c.id))
  or not exists(select 1 from owned_synthetic.bindings where(tenant_id,id,fixture_id,resource_id)=(r.tenant_id,r.binding_id,r.fixture_id,r.resource_id) and state='active' and expires_at>clock_timestamp())
  or not pg_has_role('authenticator','owned_target_controller','MEMBER')
  then raise exception 'owned deployment independent final scope readback refused' using errcode='42501';end if;
 end if;
 receipt:=owned_synthetic.deployment_step_receipt(r,p_step,'confirmed',p_readback);
 if p_step='register_karya_identity' then update public.workload_identities set lifecycle_receipt=receipt where id=registration.id;end if;
 if p_step='verify_installed_scope' then
  receipt:=public.append_ledger(r.tenant_id,r.id,'system','owned-synthetic-fixed-installer',null,null,null,'deployment.owned_active',r.id::text,r.manifest_sha256,owned_synthetic.snapshot_sha256(p_readback),null,null,null,null,'success',jsonb_build_object('binding_id',r.binding_id,'scope_expires_at',r.expires_at,'production_connector_ready',false));
  update owned_synthetic.deployment_heads set state='active',installation_receipt=receipt where request_id=r.id;
  update owned_synthetic.deployment_operations set outcome='recorded',result=owned_synthetic.deployment_summary(r),receipt_id=receipt where tenant_id=r.tenant_id and request_id=r.id and phase='install';
 end if;
 perform owned_synthetic.deployment_write_fence(r.tenant_id,r.id,true);
 if p_step='verify_installed_scope' and not exists(select 1 from owned_synthetic.deployment_credentials c where c.id=(published->>'credentialId')::uuid and c.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=c.id)) then raise exception 'owned deployment final credential expired' using errcode='42501';end if;
 return jsonb_build_object('step',p_step,'state','confirmed','receiptId',receipt::text);
end $$;
create function public.record_owned_deployment_step_unconfirmed(p_tenant_id uuid,p_request_id uuid,p_step text,p_signed_token jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r owned_synthetic.deployment_requests;prior owned_synthetic.deployment_steps;receipt bigint;begin
 r:=owned_synthetic.deployment_step_source(p_tenant_id,p_request_id,p_step,p_signed_token);
 select * into prior from owned_synthetic.deployment_steps where request_id=r.id and step=p_step order by sequence desc limit 1;
 if prior.transition='confirmed' then return jsonb_build_object('step',p_step,'state','confirmed','receiptId',prior.receipt_id::text);end if;
 if prior.transition is null or prior.transition not in('authorized','unconfirmed') then raise exception 'owned deployment unconfirmed source refused' using errcode='42501';end if;
 if prior.transition='unconfirmed' then receipt:=prior.receipt_id;else receipt:=owned_synthetic.deployment_step_receipt(r,p_step,'unconfirmed',jsonb_build_object('effect','unknown','automaticRetry',false));end if;
 update owned_synthetic.deployment_heads set state='unconfirmed' where request_id=r.id;
 update owned_synthetic.deployment_operations set outcome='unconfirmed' where tenant_id=r.tenant_id and request_id=r.id and phase='install';
 return jsonb_build_object('step',p_step,'state','unconfirmed','receiptId',receipt::text);
end $$;
create function public.rollback_owned_deployment_authority(p_tenant_id uuid,p_request_id uuid,p_signed_token jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;beforestate jsonb;projected jsonb;actual jsonb;receipt bigint;issued_credential owned_synthetic.deployment_credentials;begin
 r:=owned_synthetic.deployment_step_source(p_tenant_id,p_request_id,'enroll_synthetic_resource',p_signed_token);
 beforestate:=jsonb_build_object('bindingState',(select state from owned_synthetic.bindings where(tenant_id,id)=(r.tenant_id,r.binding_id)),
 'credentialActive',exists(select 1 from owned_synthetic.deployment_credentials c where c.request_id=r.id and c.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=c.id)),
 'resourceRetained',exists(select 1 from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id)),'journalsRetained',true,'sharedRoleRetained',true,'sharedIdentityRetained',true);
 projected:=owned_synthetic.deployment_project(beforestate,false);
 update owned_synthetic.bindings set state='revoked' where(tenant_id,id)=(r.tenant_id,r.binding_id) and state='active';
 receipt:=public.append_ledger(r.tenant_id,r.id,'system','owned-synthetic-fixed-installer',null,null,null,'deployment.owned_revoked',r.id::text,r.manifest_sha256,owned_synthetic.snapshot_sha256(projected),null,null,null,null,'rolled_back',jsonb_build_object('scope','new_binding_and_credentials_only','target_setting_unchanged',true,'shared_role_and_identity_retained',true));
 for issued_credential in select * from owned_synthetic.deployment_credentials where request_id=r.id loop
  insert into owned_synthetic.deployment_credential_revocations(credential_id,tenant_id,receipt_id) values(issued_credential.id,r.tenant_id,receipt) on conflict do nothing;
 end loop;
 actual:=jsonb_build_object('bindingState',(select state from owned_synthetic.bindings where(tenant_id,id)=(r.tenant_id,r.binding_id)),
 'credentialActive',exists(select 1 from owned_synthetic.deployment_credentials c where c.request_id=r.id and c.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=c.id)),
 'resourceRetained',exists(select 1 from owned_synthetic.resources where(fixture_id,resource_id)=(r.fixture_id,r.resource_id)),'journalsRetained',true,'sharedRoleRetained',true,'sharedIdentityRetained',true);
 if actual is distinct from projected then raise exception 'owned deployment rollback readback refused' using errcode='42501';end if;
 update owned_synthetic.deployment_heads set state='revoked' where request_id=r.id;
 perform owned_synthetic.deployment_step_receipt(r,'enroll_synthetic_resource','revoked',actual);
 return jsonb_build_object('state','revoked','receiptId',receipt::text,'readback',actual);
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.confirm_owned_deployment_step(uuid,uuid,text,jsonb,jsonb),public.record_owned_deployment_step_unconfirmed(uuid,uuid,text,jsonb),public.rollback_owned_deployment_authority(uuid,uuid,jsonb) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.confirm_owned_deployment_step(uuid,uuid,text,jsonb,jsonb),public.record_owned_deployment_step_unconfirmed(uuid,uuid,text,jsonb),public.rollback_owned_deployment_authority(uuid,uuid,jsonb) to service_role;
create table owned_synthetic.deployment_installation_claims (
 request_id uuid primary key references owned_synthetic.deployment_requests(id),claim_id uuid not null unique,
 claimed_at timestamptz not null default clock_timestamp(),receipt_id bigint not null references public.audit_ledger(id)
);
alter table owned_synthetic.deployment_installation_claims enable row level security;
revoke all on owned_synthetic.deployment_installation_claims from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create trigger owned169_install_claim_retained before update or delete on owned_synthetic.deployment_installation_claims for each row execute function public.evidence_receipt_immutable();
create trigger owned169_install_claim_no_truncate before truncate on owned_synthetic.deployment_installation_claims for each statement execute function public.evidence_receipt_immutable();
create function public.claim_next_owned_deployment_task(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;task owned_synthetic.deployment_preflight_tasks;existing uuid;answer jsonb;a owned_synthetic.deployment_approvals;receipt bigint;begin
 if current_setting('role',true) is distinct from 'service_role' or p_claim_id is null then raise exception 'owned deployment task transport refused' using errcode='42501';end if;
 -- Lock precedes tenant/request locks; no tenant-held path acquires this
 -- independent claim namespace. Exact retries resolve their original task.
 perform pg_advisory_xact_lock(hashtextextended(p_claim_id::text,16901));
 select task_id into existing from owned_synthetic.deployment_preflight_claims where claim_id=p_claim_id;
 if found then return jsonb_build_object('kind','preflight','task',public.claim_owned_deployment_preflight(existing,p_claim_id));end if;
 select request_id into existing from owned_synthetic.deployment_installation_claims where claim_id=p_claim_id;
 if found then
  select * into strict r from owned_synthetic.deployment_requests where id=existing;
  a:=owned_synthetic.deployment_current_approval(r.tenant_id,r.id);
  if(a.signed_token#>>'{spec,expiresAt}')::timestamptz<=clock_timestamp() then raise exception 'owned deployment task expired' using errcode='42501';end if;
  return jsonb_build_object('kind','installation','task',jsonb_build_object('taskId',r.id,'claimId',p_claim_id,'requestId',r.id,'tenantId',r.tenant_id,'manifest',r.manifest,'manifestSha256',r.manifest_sha256,'expiresAt',a.signed_token#>>'{spec,expiresAt}'));
 end if;
 for task in select candidate.* from owned_synthetic.deployment_preflight_tasks candidate join owned_synthetic.deployment_heads head on head.preflight_key=candidate.id and head.state='requested'
 where candidate.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_preflight_claims where task_id=candidate.id)
 and not exists(select 1 from owned_synthetic.deployment_fences fence where(fence.tenant_id,fence.actor_id,fence.request_id,fence.target_phase,fence.target_operation_key)=(candidate.tenant_id,candidate.actor_id,candidate.request_id,'preflight',candidate.id))
 order by candidate.created_at limit 1 loop
  return jsonb_build_object('kind','preflight','task',public.claim_owned_deployment_preflight(task.id,p_claim_id));
 end loop;
 for r in select request.* from owned_synthetic.deployment_requests request join owned_synthetic.deployment_heads head on head.request_id=request.id and head.state='installing'
 join owned_synthetic.deployment_approvals approved on approved.id=head.approval_id
 where request.expires_at>clock_timestamp() and(approved.signed_token#>>'{spec,expiresAt}')::timestamptz>clock_timestamp()
 and not exists(select 1 from owned_synthetic.deployment_installation_claims where request_id=request.id)
 order by request.created_at limit 1 loop
  a:=owned_synthetic.deployment_current_approval(r.tenant_id,r.id);
  if exists(select 1 from owned_synthetic.deployment_installation_claims where request_id=r.id) then raise exception 'owned deployment task already claimed' using errcode='42501';end if;
  receipt:=public.append_ledger(r.tenant_id,p_claim_id,'system','owned-synthetic-fixed-installer',null,null,null,'deployment.owned_step',r.id::text,r.manifest_sha256,null,null,null,null,null,'pending',jsonb_build_object('stage','installation_claimed','target_mutations',0));
  insert into owned_synthetic.deployment_installation_claims(request_id,claim_id,receipt_id) values(r.id,p_claim_id,receipt);
  return jsonb_build_object('kind','installation','task',jsonb_build_object('taskId',r.id,'claimId',p_claim_id,'requestId',r.id,'tenantId',r.tenant_id,'manifest',r.manifest,'manifestSha256',r.manifest_sha256,'expiresAt',a.signed_token#>>'{spec,expiresAt}'));
 end loop;
 return jsonb_build_object('kind','idle','task',null);
end $$;
create function public.read_owned_deployment_step_source(p_tenant_id uuid,p_request_id uuid,p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if current_setting('role',true) is distinct from 'service_role' or not exists(select 1 from owned_synthetic.deployment_installation_claims where(request_id,claim_id)=(p_request_id,p_claim_id))
 then raise exception 'owned deployment installation claim refused' using errcode='42501';end if;
 return public.read_owned_deployment_installer_source(p_tenant_id,p_request_id);
end $$;
create function public.read_owned_deployment_credential_scope(p_tenant_id uuid,p_binding_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;c owned_synthetic.deployment_credentials;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment credential reader refused' using errcode='42501';end if;
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,binding_id)=(p_tenant_id,p_binding_id);
 a:=owned_synthetic.deployment_current_approval(p_tenant_id,r.id);
 if not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and state='active') then raise exception 'owned deployment credential inactive' using errcode='42501';end if;
 select credential.* into strict c from owned_synthetic.deployment_credentials credential where credential.request_id=r.id and credential.expires_at>clock_timestamp()
 and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=credential.id) order by credential.issued_at desc,credential.receipt_id desc limit 1;
 return jsonb_build_object('scope',jsonb_build_object('tenantId',r.tenant_id,'bindingId',r.binding_id,'enrollmentId',r.id,'credentialId',c.id,'custodyEpoch',r.custody_epoch,'expiresAt',to_char(c.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),'credentialSha256',c.token_sha256);
end $$;
create function public.read_owned_deployment_action_binding(p_tenant_id uuid,p_plan_id uuid,p_action_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare b owned_synthetic.bindings;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment action binding reader refused' using errcode='42501';end if;
 select binding.* into strict b from owned_synthetic.bindings binding join public.remediation_actions action on(action.tenant_id,action.id)=(binding.tenant_id,binding.action_id)
 where(binding.tenant_id,binding.action_id,action.plan_id)=(p_tenant_id,p_action_id,p_plan_id) and action.action_type='config.audit_log_enable';
 perform owned_synthetic.require_binding(b.tenant_id,b.id,b.engagement_id);
 return jsonb_build_object('tenantId',b.tenant_id,'bindingId',b.id);
end $$;
revoke all on function public.claim_next_owned_deployment_task(uuid),public.read_owned_deployment_step_source(uuid,uuid,uuid),public.read_owned_deployment_credential_scope(uuid,uuid),public.read_owned_deployment_action_binding(uuid,uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.claim_next_owned_deployment_task(uuid),public.read_owned_deployment_step_source(uuid,uuid,uuid),public.read_owned_deployment_credential_scope(uuid,uuid),public.read_owned_deployment_action_binding(uuid,uuid,uuid) to service_role;
create function public.read_owned_deployment_credential_reservation(p_tenant_id uuid,p_request_id uuid,p_credential_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a owned_synthetic.deployment_approvals;r owned_synthetic.deployment_requests;c owned_synthetic.deployment_credential_reservations;filehash text;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment issuer transport refused' using errcode='42501';end if;
 a:=owned_synthetic.deployment_current_approval(p_tenant_id,p_request_id);
 select * into strict r from owned_synthetic.deployment_requests where id=p_request_id;
 select * into strict c from owned_synthetic.deployment_credential_reservations where(id,tenant_id,request_id,binding_id,approval_id,custody_epoch)=(p_credential_id,p_tenant_id,r.id,r.binding_id,a.id,r.custody_epoch);
 if c.expires_at<=clock_timestamp() or exists(select 1 from owned_synthetic.deployment_credential_revocations where credential_id=c.id)
 then raise exception 'owned deployment issuer reservation expired' using errcode='42501';end if;
 select token_sha256 into filehash from owned_synthetic.deployment_credentials where id=c.id;
 return jsonb_build_object('metadata',c.metadata||jsonb_build_object('reservationSha256',c.reservation_sha256),'credentialSha256',filehash);
end $$;
revoke all on function public.read_owned_deployment_credential_reservation(uuid,uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.read_owned_deployment_credential_reservation(uuid,uuid,uuid) to service_role;

create function owned_synthetic.deployment_role_graph() returns jsonb
language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('schemaOwnerOid',(select nspowner from pg_catalog.pg_namespace where nspname='owned_synthetic'),
 'databaseOwnerOid',(select datdba from pg_catalog.pg_database where datname=current_database()),
 'roles',(select jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.rolname,'login',r.rolcanlogin,'inherit',r.rolinherit,'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'replication',r.rolreplication,'bypassrls',r.rolbypassrls) order by r.rolname) from pg_catalog.pg_roles r where r.rolname in('owned_target_controller','authenticator')),
 'edges',coalesce((select jsonb_agg(jsonb_build_object('roleOid',e.roleid,'roleName',r.rolname,'roleSuperuser',r.rolsuper,'roleLogin',r.rolcanlogin,'roleInherit',r.rolinherit,'roleCreateRole',r.rolcreaterole,'roleCreateDb',r.rolcreatedb,'roleReplication',r.rolreplication,'roleBypassRls',r.rolbypassrls,'memberOid',e.member,'memberName',m.rolname,'memberSuperuser',m.rolsuper,'memberLogin',m.rolcanlogin,'memberInherit',m.rolinherit,'memberCreateRole',m.rolcreaterole,'memberCreateDb',m.rolcreatedb,'memberReplication',m.rolreplication,'memberBypassRls',m.rolbypassrls,'grantorOid',e.grantor,'admin',e.admin_option,'inherit',e.inherit_option,'set',e.set_option) order by e.roleid,e.member,e.grantor) from pg_catalog.pg_auth_members e join pg_catalog.pg_roles r on r.oid=e.roleid join pg_catalog.pg_roles m on m.oid=e.member where r.rolname in('owned_target_controller','authenticator') or m.rolname in('owned_target_controller','authenticator')),'[]'::jsonb))
$$;
create function owned_synthetic.deployment_require_role_graph(expected jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare actual jsonb;expected_edges jsonb;actual_edges jsonb;auth_expected jsonb;auth_actual jsonb;begin
 actual:=owned_synthetic.deployment_role_graph();
 select coalesce(jsonb_agg(e order by e->>'roleOid',e->>'memberOid',e->>'grantorOid'),'[]'::jsonb) into expected_edges from jsonb_array_elements(expected->'edges') e where not(e->>'roleName'='owned_target_controller' and e->>'memberName'='authenticator');
 select coalesce(jsonb_agg(e order by e->>'roleOid',e->>'memberOid',e->>'grantorOid'),'[]'::jsonb) into actual_edges from jsonb_array_elements(actual->'edges') e where not(e->>'roleName'='owned_target_controller' and e->>'memberName'='authenticator');
 select e into auth_expected from jsonb_array_elements(expected->'edges') e where e->>'roleName'='owned_target_controller' and e->>'memberName'='authenticator';
 select e into auth_actual from jsonb_array_elements(actual->'edges') e where e->>'roleName'='owned_target_controller' and e->>'memberName'='authenticator';
 if expected is null or actual-'edges' is distinct from expected-'edges' or actual_edges is distinct from expected_edges
 or(auth_expected is not null and auth_actual is distinct from auth_expected)
 or(auth_actual is not null and(auth_actual->'admin' is distinct from 'false'::jsonb or auth_actual->'inherit' is distinct from 'false'::jsonb or auth_actual->'set' is distinct from 'true'::jsonb))
 then raise exception 'owned deployment reviewed role graph changed' using errcode='42501';end if;
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
-- A fresh human stop is deliberately separate from installer approval. It may
-- disable the exact recorded scope after the short installer token expired;
-- it never issues/replaces approval, grants a role, deploys, or changes target data.
create table owned_synthetic.deployment_revocation_intents (
 tenant_id uuid not null,actor_id uuid not null references public.users(id),request_id uuid not null,
 operation_key uuid not null,session_id uuid not null,request jsonb not null,
 bound_payload_sha256 text not null check(bound_payload_sha256~'^[a-f0-9]{64}$'),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,actor_id,operation_key),
 foreign key(tenant_id,request_id) references owned_synthetic.deployment_requests(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
alter table owned_synthetic.deployment_revocation_intents enable row level security;
revoke all on owned_synthetic.deployment_revocation_intents from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create trigger owned169_stop_intent_retained before update or delete on owned_synthetic.deployment_revocation_intents for each row execute function public.evidence_receipt_immutable();
create trigger owned169_stop_intent_no_truncate before truncate on owned_synthetic.deployment_revocation_intents for each statement execute function public.evidence_receipt_immutable();
create function owned_synthetic.deployment_stop_source(t uuid,rid uuid) returns owned_synthetic.deployment_requests
language plpgsql security definer set search_path='' as $$
declare r owned_synthetic.deployment_requests;a owned_synthetic.deployment_approvals;h owned_synthetic.deployment_heads;begin
 perform pg_advisory_xact_lock_shared(hashtextextended(t::text,47));perform owned_synthetic.deployment_lock(t,rid);
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(t,rid) for share;
 select * into strict h from owned_synthetic.deployment_heads where request_id=r.id for update;
 select * into strict a from owned_synthetic.deployment_approvals where(tenant_id,id,request_id)=(t,h.approval_id,r.id) for share;
 if r.manifest_sha256 is distinct from owned_synthetic.snapshot_sha256(r.manifest)
 or exists(select 1 from owned_synthetic.bindings b where b.id=r.binding_id and(b.tenant_id,b.fixture_id,b.resource_id,b.approval_reference) is distinct from(t,r.fixture_id,r.resource_id,a.id))
 then raise exception 'owned deployment stop scope refused' using errcode='42501';end if;
 return r;
end $$;
create function public.prepare_owned_deployment_revocation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;prior owned_synthetic.deployment_revocation_intents;op uuid;digest text;receipt bigint;begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if jsonb_typeof(p_request) is distinct from 'object' or not(p_request?&array['operationKey','expectedManifestSha256','expectedApprovalId','reason','acknowledgeOwnedSynthetic'])
 or p_request-array['operationKey','expectedManifestSha256','expectedApprovalId','reason','acknowledgeOwnedSynthetic']<>'{}'::jsonb
 or p_request->'acknowledgeOwnedSynthetic' is distinct from 'true'::jsonb
 or jsonb_typeof(p_request->'reason') is distinct from 'string' or length(p_request->>'reason') not between 20 and 2000 or p_request->>'reason'<>btrim(p_request->>'reason')
 then raise exception 'owned deployment stop intent refused' using errcode='22023';end if;
 op:=(p_request->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,'revoke',op);
 r:=owned_synthetic.deployment_stop_source(p_tenant_id,p_request_id);
 if p_request->>'expectedManifestSha256' is distinct from r.manifest_sha256
 or not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and approval_id=(p_request->>'expectedApprovalId')::uuid)
 then raise exception 'owned deployment stop source changed' using errcode='42501';end if;
 digest:=owned_synthetic.snapshot_sha256(jsonb_build_object('domain','axiom.owned-synthetic.enrollment-revocation.v1','tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,'requestId',r.id,'request',p_request));
 select * into prior from owned_synthetic.deployment_revocation_intents where(tenant_id,actor_id,operation_key)=(p_tenant_id,p_actor_id,op);
 if found then
  if(prior.request_id,prior.session_id,prior.request,prior.bound_payload_sha256) is distinct from(r.id,p_session_id,p_request,digest)
  then raise exception 'owned deployment stop intent conflict' using errcode='23505';end if;
 else
  receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_requested',r.id::text,digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage','human_stop_prepared','target_mutations',0));
  insert into owned_synthetic.deployment_revocation_intents(tenant_id,actor_id,request_id,operation_key,session_id,request,bound_payload_sha256,receipt_id)
  values(p_tenant_id,p_actor_id,r.id,op,p_session_id,p_request,digest,receipt);
 end if;
 return jsonb_build_object('requestId',r.id,'operationKey',op,'boundPayloadSha256',digest,'purpose','owned_synthetic_revocation');
end $$;
create function owned_synthetic.deployment_revocation_mfa_authority(t uuid,a uuid,s uuid,op uuid,digest text) returns void
language plpgsql security definer set search_path='' as $$
declare intent owned_synthetic.deployment_revocation_intents;r owned_synthetic.deployment_requests;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment stop MFA transport refused' using errcode='42501';end if;
 select * into strict intent from owned_synthetic.deployment_revocation_intents where(tenant_id,actor_id,operation_key,session_id,bound_payload_sha256)=(t,a,op,s,digest);
 perform pg_advisory_xact_lock_shared(hashtextextended(t::text,47));
 perform owned_synthetic.deployment_unfenced(t,a,intent.request_id,'revoke',op);
 perform owned_synthetic.deployment_actor_authority(t,a,s);
 r:=owned_synthetic.deployment_stop_source(t,intent.request_id);
 if intent.request->>'expectedManifestSha256' is distinct from r.manifest_sha256
 or not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and approval_id=(intent.request->>'expectedApprovalId')::uuid)
 then raise exception 'owned deployment stop MFA current source refused' using errcode='42501';end if;
end $$;

create function public.issue_owned_deployment_revocation_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_ttl_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 if p_ttl_ms is null or p_ttl_ms not between 1 and 300000 then raise exception 'owned deployment MFA TTL refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_revocation_mfa_authority(p_tenant_id,p_actor_id,p_session_id,p_operation_key,p_bound_payload_sha256);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;

 now_at:=clock_timestamp();

 if not exists(select 1 from public.users where id=p_actor_id)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'owned deployment MFA scope refused' using errcode='42501';end if;

 select * into c from public.mfa_challenges where user_id=p_actor_id and tenant_id=p_tenant_id and purpose::text='owned_synthetic_revocation'
 and bound_resource_ref=p_operation_key::text and bound_payload_sha256=p_bound_payload_sha256 order by created_at desc limit 1 for update;
 if found then
  if c.factor_id is distinct from p_factor_id or c.consumed_at is not null or c.expires_at<=now_at then
   raise exception 'owned deployment decision requires explicit fence' using errcode='42501';
  end if;
  return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
 end if;
 insert into public.mfa_challenges(user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at)
 values(p_actor_id,p_tenant_id,p_factor_id,'owned_synthetic_revocation',p_operation_key::text,p_bound_payload_sha256,now_at,now_at+p_ttl_ms*interval '1 millisecond') returning * into c;
 return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
end $$;
create function public.satisfy_owned_deployment_revocation_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_satisfied_with text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_satisfied_with is null or p_satisfied_with not in ('totp','recovery_code') then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_revocation_mfa_authority(p_tenant_id,p_actor_id,p_session_id,p_operation_key,p_bound_payload_sha256);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.users where id=p_actor_id)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'owned deployment MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'owned_synthetic_revocation'
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
create function public.consume_owned_deployment_revocation_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_consumed_for uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_consumed_for is null or p_consumed_for is distinct from p_operation_key then raise exception 'owned deployment MFA input refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_revocation_mfa_authority(p_tenant_id,p_actor_id,p_session_id,p_operation_key,p_bound_payload_sha256);
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.users where id=p_actor_id)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'owned deployment MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'owned_synthetic_revocation'
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
revoke all on function public.issue_owned_deployment_revocation_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.issue_owned_deployment_revocation_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.satisfy_owned_deployment_revocation_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.satisfy_owned_deployment_revocation_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) to service_role;
revoke all on function public.consume_owned_deployment_revocation_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.consume_owned_deployment_revocation_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.prepare_owned_deployment_revocation(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.prepare_owned_deployment_revocation(uuid,uuid,uuid,uuid,jsonb) to human_action_writer;

create function public.record_owned_deployment_revocation_mfa_phase(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_phase text,p_request jsonb,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d owned_synthetic.deployment_revocation_intents;r owned_synthetic.deployment_requests;c public.mfa_challenges;
 prior owned_synthetic.deployment_operations;intent jsonb;digest text;result jsonb;op uuid;receipt bigint;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_phase not in('revoke_challenge','revoke_verify') or p_challenge_id is null then raise exception 'owned deployment MFA phase refused' using errcode='22023';end if;
 op:=(p_request->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,p_phase,op);
 intent:=jsonb_build_object('phase',p_phase,'request',p_request);
 if p_phase='revoke_verify' then intent:=intent||jsonb_build_object('challengeId',p_challenge_id);end if;
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,p_request_id,op,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,p_phase,op);
 if found then
  if prior.intent_sha256<>digest or prior.intent<>intent then raise exception 'owned deployment MFA operation conflict' using errcode='23505';end if;
  return prior.phase_result;
 end if;
 select * into strict d from owned_synthetic.deployment_revocation_intents where(tenant_id,actor_id,operation_key,request_id,session_id)=(p_tenant_id,p_actor_id,op,p_request_id,p_session_id) for share;
 if d.request is distinct from p_request then raise exception 'owned deployment decision changed' using errcode='42501';end if;
 select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(p_tenant_id,p_request_id) for share;
 r:=owned_synthetic.deployment_stop_source(p_tenant_id,p_request_id);
 select * into c from public.mfa_challenges where id=p_challenge_id for share;
 if c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id or c.purpose::text is distinct from 'owned_synthetic_revocation'
 or c.bound_resource_ref is distinct from op::text or c.bound_payload_sha256 is distinct from d.bound_payload_sha256
 or c.created_at>clock_timestamp() or c.expires_at<=clock_timestamp() or c.consumed_at is not null or c.attempts>c.max_attempts
 or(p_phase='revoke_verify' and(c.satisfied_at is null or c.satisfied_with is null))
 then raise exception 'owned deployment MFA phase source refused' using errcode='42501';end if;
 result:=case when p_phase='revoke_challenge' then jsonb_build_object('phase','revoke_challenge','challenge',jsonb_build_object('challengeId',c.id,'expiresAt',c.expires_at,'maxAttempts',c.max_attempts))
 else jsonb_build_object('phase','revoke_verify','verified',true) end;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_requested',r.id::text,digest,r.manifest_sha256,null,null,null,null,'pending',jsonb_build_object('stage',p_phase,'target_mutations',0));
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,result,phase_result,receipt_id)
 values(p_tenant_id,p_actor_id,r.id,p_phase,op,intent,digest,'recorded',owned_synthetic.deployment_summary(r),result,receipt);
 return result;
end $$;
create function public.record_owned_deployment_revocation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_request jsonb,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.deployment_requests;d owned_synthetic.deployment_revocation_intents;c public.mfa_challenges;
 prior owned_synthetic.deployment_operations;op uuid;intent jsonb;digest text;receipt bigint;
 beforestate jsonb;projected jsonb;actual jsonb;credential owned_synthetic.deployment_credentials;target_before jsonb;target_after jsonb;answer jsonb;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 op:=(p_request->>'operationKey')::uuid;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform owned_synthetic.deployment_unfenced(p_tenant_id,p_actor_id,p_request_id,'revoke',op);
 intent:=jsonb_build_object('phase','revoke','request',p_request,'challengeId',p_challenge_id);
 digest:=owned_synthetic.deployment_operation_sha256(p_tenant_id,p_actor_id,p_request_id,op,intent);
 select * into prior from owned_synthetic.deployment_operations where(tenant_id,actor_id,request_id,phase,operation_key)=(p_tenant_id,p_actor_id,p_request_id,'revoke',op);
 if found then
  if prior.intent is distinct from intent or prior.intent_sha256 is distinct from digest then raise exception 'owned deployment stop operation conflict' using errcode='23505';end if;
  return prior.result;
 end if;
 select * into strict d from owned_synthetic.deployment_revocation_intents where(tenant_id,actor_id,request_id,operation_key,session_id)=(p_tenant_id,p_actor_id,p_request_id,op,p_session_id) for share;
 if d.request is distinct from p_request then raise exception 'owned deployment stop decision changed' using errcode='42501';end if;
 r:=owned_synthetic.deployment_stop_source(p_tenant_id,p_request_id);
 if p_request->>'expectedManifestSha256' is distinct from r.manifest_sha256 or not exists(select 1 from owned_synthetic.deployment_heads where request_id=r.id and approval_id=(p_request->>'expectedApprovalId')::uuid)
 then raise exception 'owned deployment stop current source refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for share;
 if c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id or c.purpose::text is distinct from 'owned_synthetic_revocation'
 or c.bound_resource_ref is distinct from op::text or c.bound_payload_sha256 is distinct from d.bound_payload_sha256
 or c.consumed_for is distinct from op::text or c.consumed_at is null or c.satisfied_at is null or c.satisfied_with is null
 or c.created_at>clock_timestamp() or c.expires_at<=clock_timestamp() or c.attempts>c.max_attempts
 or not exists(select 1 from public.user_mfa_factors factor where factor.id=c.factor_id and factor.user_id=p_actor_id and factor.factor_type='totp' and factor.status='active' and factor.revoked_at is null)
 then raise exception 'owned deployment stop fresh MFA refused' using errcode='42501';end if;
 select owned_synthetic.snapshot(resource) into target_before from owned_synthetic.resources resource where(fixture_id,resource_id)=(r.fixture_id,r.resource_id) for share;
 beforestate:=jsonb_build_object('bindingState',coalesce((select state from owned_synthetic.bindings where(tenant_id,id)=(r.tenant_id,r.binding_id)),'absent'),
 'credentialActive',exists(select 1 from owned_synthetic.deployment_credentials issued where issued.request_id=r.id and issued.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=issued.id)),
 'resourceRetained',target_before is not null,'journalsRetained',true,'sharedRoleRetained',true,'sharedIdentityRetained',true);
 projected:=owned_synthetic.deployment_project(beforestate,false);
 update owned_synthetic.bindings set state='revoked' where(tenant_id,id)=(r.tenant_id,r.binding_id) and state='active';
 receipt:=public.append_ledger(r.tenant_id,op,'human',p_actor_id::text,null,null,null,'deployment.owned_revoked',r.id::text,digest,owned_synthetic.snapshot_sha256(projected),null,null,null,null,'rolled_back',jsonb_build_object('scope','new_binding_and_credentials_only','purpose','owned_synthetic_revocation','target_setting_unchanged',true,'shared_role_and_identity_retained',true,'installation_outcome','stopped_by_human_scope_revocation','prior_unknown_effects_retained',true));
 for credential in select * from owned_synthetic.deployment_credentials where request_id=r.id loop
  insert into owned_synthetic.deployment_credential_revocations(credential_id,tenant_id,receipt_id) values(credential.id,r.tenant_id,receipt) on conflict do nothing;
 end loop;
 select owned_synthetic.snapshot(resource) into target_after from owned_synthetic.resources resource where(fixture_id,resource_id)=(r.fixture_id,r.resource_id) for share;
 actual:=jsonb_build_object('bindingState',coalesce((select state from owned_synthetic.bindings where(tenant_id,id)=(r.tenant_id,r.binding_id)),'absent'),
 'credentialActive',exists(select 1 from owned_synthetic.deployment_credentials issued where issued.request_id=r.id and issued.expires_at>clock_timestamp() and not exists(select 1 from owned_synthetic.deployment_credential_revocations revoked where revoked.credential_id=issued.id)),
 'resourceRetained',target_after is not null,'journalsRetained',true,'sharedRoleRetained',true,'sharedIdentityRetained',true);
 if actual is distinct from projected or target_before is distinct from target_after then raise exception 'owned deployment stop independent readback refused' using errcode='42501';end if;
 perform owned_synthetic.deployment_actor_authority(p_tenant_id,p_actor_id,p_session_id);
 if c.expires_at<=clock_timestamp() then raise exception 'owned deployment stop MFA expired before publication' using errcode='42501';end if;
 update owned_synthetic.deployment_heads set state='revoked' where request_id=r.id;
 perform owned_synthetic.deployment_step_receipt(r,'enroll_synthetic_resource','revoked',actual);
 answer:=owned_synthetic.deployment_summary(r);
 update owned_synthetic.deployment_operations set outcome='recorded',result=answer,receipt_id=receipt where tenant_id=r.tenant_id and request_id=r.id and phase='install' and outcome in('pending','unconfirmed');
 insert into owned_synthetic.deployment_operations(tenant_id,actor_id,request_id,phase,operation_key,intent,intent_sha256,outcome,result,receipt_id)
 values(p_tenant_id,p_actor_id,r.id,'revoke',op,intent,digest,'recorded',answer,receipt);
 return answer;
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.record_owned_deployment_revocation_mfa_phase(uuid,uuid,uuid,uuid,text,jsonb,uuid),public.record_owned_deployment_revocation(uuid,uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.record_owned_deployment_revocation_mfa_phase(uuid,uuid,uuid,uuid,text,jsonb,uuid),public.record_owned_deployment_revocation(uuid,uuid,uuid,uuid,jsonb,uuid) to human_action_writer;

-- Private read-only copy of exactly the host facts covered by the founder's
-- preflight digest. A current local configuration can never substitute them.
create function public.read_owned_deployment_reviewed_host(p_tenant_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare approved owned_synthetic.deployment_approvals;answer jsonb;begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'owned deployment host readback transport refused' using errcode='42501';end if;
 approved:=owned_synthetic.deployment_current_approval(p_tenant_id,p_request_id);
 select o.host_observation into strict answer from owned_synthetic.deployment_observations o
 join owned_synthetic.deployment_heads h on h.preflight_key=o.task_id
 where h.request_id=p_request_id and o.preflight->>'sha256'=approved.preflight_sha256
 and o.preflight->>'rollbackSha256'=approved.rollback_sha256;
 return answer;
end $$;
revoke all on function public.read_owned_deployment_reviewed_host(uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.read_owned_deployment_reviewed_host(uuid,uuid) to service_role;

-- Metadata-only recovery of one captured host claim. It grants no installation,
-- credential issuance, target operation, or retry authority, including after
-- original start authority expires. Missing/intermediate state remains unknown.
create function public.read_owned_deployment_task_receipt(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare rid uuid;tid uuid;kind text;taskid uuid;r owned_synthetic.deployment_requests;h owned_synthetic.deployment_heads;
 terminal text:='blocked';receipt bigint;hosthash text;steps jsonb:='[]'::jsonb;
begin
 if current_setting('role',true) is distinct from 'service_role' or p_claim_id is null then raise exception 'owned deployment receipt transport refused' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_claim_id::text,16901));
 select task.request_id,task.tenant_id,task.id into rid,tid,taskid from owned_synthetic.deployment_preflight_claims claim join owned_synthetic.deployment_preflight_tasks task on task.id=claim.task_id where claim.claim_id=p_claim_id;
 if found then kind:='preflight';else
  select request.id,request.tenant_id,request.id into rid,tid,taskid from owned_synthetic.deployment_installation_claims claim join owned_synthetic.deployment_requests request on request.id=claim.request_id where claim.claim_id=p_claim_id;
  if found then kind:='installation';else kind:='absent';end if;
 end if;
 if kind<>'absent' then
  perform pg_advisory_xact_lock_shared(hashtextextended(tid::text,47));perform owned_synthetic.deployment_lock(tid,rid);
  select * into strict r from owned_synthetic.deployment_requests where(tenant_id,id)=(tid,rid) for share;
  select * into strict h from owned_synthetic.deployment_heads where request_id=rid for share;
  if kind='preflight' then
   select o.receipt_id,o.host_sha256 into receipt,hosthash from owned_synthetic.deployment_observations o where(o.task_id,o.claim_id)=(taskid,p_claim_id);
   if found then terminal:='readonly_observation_recorded';end if;
  else
   select coalesce(jsonb_agg(jsonb_build_object('step',latest.step,'state',latest.transition,'receiptId',latest.receipt_id::text) order by latest.step),'[]'::jsonb) into steps
   from(select distinct on(s.step) s.step,s.transition,s.receipt_id from owned_synthetic.deployment_steps s where(s.tenant_id,s.request_id)=(tid,rid) order by s.step,s.sequence desc) latest;
   -- A later human stop proves only authority revocation. It cannot claim a
   -- successful installation, no target effect, or a paused/stopped worker.
   select op.receipt_id into receipt from owned_synthetic.deployment_operations op join public.audit_ledger ledger on(ledger.tenant_id,ledger.id)=(op.tenant_id,op.receipt_id)
   where(op.tenant_id,op.request_id,op.phase,op.outcome)=(tid,rid,'revoke','recorded') and op.result->>'state'='revoked'
   and ledger.actor_type='human' and ledger.action_type='deployment.owned_revoked' and ledger.target_ref=rid::text order by op.receipt_id desc limit 1;
   if found and h.state='revoked' then terminal:='authority_revoked_with_original_effect_history';
   elsif h.state='active' and jsonb_array_length(steps)=6 and not exists(select 1 from jsonb_array_elements(steps) v where v->>'state'<>'confirmed')
   then terminal:='installation_confirmed_history';receipt:=h.installation_receipt;
   else receipt:=null;end if;
  end if;
 end if;
 return jsonb_build_object('claimId',p_claim_id,'kind',kind,'tenantId',tid,'requestId',rid,'taskId',taskid,'manifestSha256',r.manifest_sha256,
 'terminal',terminal,'receiptId',receipt::text,'hostSha256',hosthash,'stepReceipts',steps);
end $$;
revoke all on function public.read_owned_deployment_task_receipt(uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,owned_target_controller;
grant execute on function public.read_owned_deployment_task_receipt(uuid) to service_role;
