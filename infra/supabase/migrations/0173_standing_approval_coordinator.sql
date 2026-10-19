-- Default-off standing approval issuance for one enrolled measured synthetic action.
-- Existing human/legacy approval behavior is preserved; no executor is started.
alter type public.mfa_challenge_purpose add value if not exists 'standing_policy_revision';

-- Fail closed if the existing atomic kernel was changed independently. The
-- default branch below is byte-identical after removing only the fixed173
-- guard and attribution selection; tests compare both source and behavior.
do $$begin
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_catalog.pg_proc where oid='public.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid)'::regprocedure) is distinct from '194cc18bf8ee2f21c2f3816b7254656db7534ebdc4f17d4d5377930701feb2cd'
 then raise exception 'reviewed atomic issuer source changed' using errcode='55000';end if;
end $$;
alter function public.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid) set schema controller_security;
alter function controller_security.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid) rename to issue_plan_approval_before173;

create function controller_security.issue_plan_approval173(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_ids uuid[],
  p_approver_id uuid,
  p_mode text,
  p_concurrency integer,
  p_stop_on_failure boolean,
  p_signature text,
  p_signed_payload jsonb,
  p_nonce text,
  p_expires_at timestamptz,
  p_reason text,
  p_conditions jsonb,
  p_challenge_id uuid,
  p_expected_digest text,
  -- The step-up attestation the route assembled: which challenge, when it was
  -- satisfied, what binding it carried. FR-7.3 asks for the approver's
  -- identity; a user id alone records whose session it was, and these record
  -- that the human re-authenticated and against what.
  p_mfa_detail jsonb,
  p_correlation_id uuid,
  p_coordinator_fire_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_locked integer;
  v_digest text;
  v_token_id uuid;
  v_expires timestamptz;
begin
  if p_coordinator_fire_id is not null then
    perform controller_security.standing173_assert_issuance(p_coordinator_fire_id,p_tenant_id,p_plan_id,p_action_ids,p_approver_id,p_mode,p_concurrency,p_stop_on_failure,p_signed_payload,p_nonce,p_expires_at,p_expected_digest,p_conditions,p_mfa_detail,p_correlation_id);
  end if;
  if coalesce(cardinality(p_action_ids), 0) = 0
     or exists (select 1 from unnest(p_action_ids) id where id is null)
     or cardinality(p_action_ids) <> (select count(distinct id) from unnest(p_action_ids) id) then
    return jsonb_build_object('decision', 'invalid_actions');
  end if;

  -- Same lock order as claim_plan_execution and reconcile_execution_dispatch:
  -- plan first, then actions by id. An approval and a claim for the same plan
  -- cannot interleave.
  perform 1 from public.remediation_plans
   where id = p_plan_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('decision', 'plan_not_found');
  end if;

  perform 1 from public.remediation_actions
   where tenant_id = p_tenant_id and plan_id = p_plan_id and id = any(p_action_ids)
   order by id for update;
  get diagnostics v_locked = row_count;
  if v_locked <> cardinality(p_action_ids) then
    return jsonb_build_object('decision', 'actions_not_found');
  end if;

  -- Work already in flight or already finished is not approvable again.
  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and a.execution_status in ('executing', 'succeeded', 'failed', 'rolled_back')
  ) then
    return jsonb_build_object('decision', 'actions_in_flight');
  end if;

  -- Eligibility, rechecked under the locks. The route checks these too; reads
  -- there can go stale before the write lands.
  if exists (
    select 1 from public.remediation_actions a
    where a.tenant_id = p_tenant_id and a.plan_id = p_plan_id and a.id = any(p_action_ids)
      and (a.dry_run_status <> 'dry_run_complete'
           or not a.rollback_validated
           or a.dry_run_expires_at is null
           or a.dry_run_expires_at <= clock_timestamp())
  ) then
    return jsonb_build_object('decision', 'actions_not_ready');
  end if;

  -- The content that is about to be approved must be the content that was
  -- verified against the step-up binding.
  v_digest := public.action_set_content_digest(p_tenant_id, p_plan_id, p_action_ids);
  if p_expected_digest is null or v_digest is distinct from p_expected_digest then
    return jsonb_build_object('decision', 'content_changed');
  end if;

  insert into public.approval_tokens(
    tenant_id, plan_id, action_ids, approver_id, mode, concurrency, stop_on_failure,
    signature, signed_payload, nonce, expires_at, reason, conditions, status)
  values (
    p_tenant_id, p_plan_id, p_action_ids, p_approver_id, p_mode, p_concurrency, p_stop_on_failure,
    p_signature, p_signed_payload, p_nonce, p_expires_at, p_reason,
    coalesce(p_conditions, '{}'::jsonb), 'issued')
  returning id, expires_at into v_token_id, v_expires;

  -- The trail runs both ways: token → challenge → factor → user.
  if p_challenge_id is not null then
    update public.mfa_challenges
       set consumed_for = v_token_id::text
     where id = p_challenge_id and user_id = p_approver_id;
  end if;

  update public.remediation_actions
     set approval_status = 'approved',
         approval_token_id = v_token_id,
         approved_by = p_approver_id,
         approved_at = now(),
         final_outcome = null
   where tenant_id = p_tenant_id and plan_id = p_plan_id and id = any(p_action_ids);

  update public.remediation_plans
     set status = 'approved'
   where id = p_plan_id and tenant_id = p_tenant_id;

  -- In the same transaction, so authority cannot exist without the record of
  -- who granted it. A ledger outage rolls the whole issuance back.
  perform public.append_ledger(
    p_tenant_id, p_correlation_id, case when p_coordinator_fire_id is null then 'human'::public.actor_type else 'agent'::public.actor_type end,
    case when p_coordinator_fire_id is null then p_approver_id::text else 'standing-policy-coordinator' end,
    null, null, null, 'approval.token.issued', p_plan_id::text,
    null, null, v_token_id, p_approver_id, null, null, 'success',
    jsonb_build_object(
      'actionIds', to_jsonb(p_action_ids),
      'mode', p_mode,
      'concurrency', p_concurrency,
      'stopOnFailure', p_stop_on_failure,
      'expiresAt', p_expires_at,
      'reason', p_reason,
      'contentDigest', v_digest,
      'mfaChallengeId', p_challenge_id)
    || coalesce(p_mfa_detail, '{}'::jsonb));

  return jsonb_build_object(
    'decision', 'issued',
    'token_id', v_token_id,
    'expires_at', v_expires,
    'content_digest', v_digest);
end $$;

create function public.issue_plan_approval(
  p_tenant_id uuid,
  p_plan_id uuid,
  p_action_ids uuid[],
  p_approver_id uuid,
  p_mode text,
  p_concurrency integer,
  p_stop_on_failure boolean,
  p_signature text,
  p_signed_payload jsonb,
  p_nonce text,
  p_expires_at timestamptz,
  p_reason text,
  p_conditions jsonb,
  p_challenge_id uuid,
  p_expected_digest text,
  -- The step-up attestation the route assembled: which challenge, when it was
  -- satisfied, what binding it carried. FR-7.3 asks for the approver's
  -- identity; a user id alone records whose session it was, and these record
  -- that the human re-authenticated and against what.
  p_mfa_detail jsonb,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
 return controller_security.issue_plan_approval173(p_tenant_id,p_plan_id,p_action_ids,p_approver_id,p_mode,p_concurrency,p_stop_on_failure,p_signature,p_signed_payload,p_nonce,p_expires_at,p_reason,p_conditions,p_challenge_id,p_expected_digest,p_mfa_detail,p_correlation_id,null);
end $$;

-- Neither the historical kernel nor the extended core is callable directly
-- by any API/backend/worker principal. Existing owner-defined wrappers only.
do $$declare r record;begin
 for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop
  execute format('revoke all on function controller_security.issue_plan_approval_before173(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid) from %I',r.rolname);
  execute format('revoke all on function controller_security.issue_plan_approval173(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,uuid) from %I',r.rolname);
  execute format('revoke all on function public.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid) from %I',r.rolname);
 end loop;
end $$;
revoke all on function controller_security.issue_plan_approval_before173(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid),controller_security.issue_plan_approval173(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid,uuid),public.issue_plan_approval(uuid,uuid,uuid[],uuid,text,integer,boolean,text,jsonb,text,timestamptz,text,jsonb,uuid,text,jsonb,uuid) from public;

-- New explicit human decisions only. Legacy0068 rows confer no eligibility.
create table controller_security.standing173_requests (
 id uuid primary key,tenant_id uuid not null,policy_id uuid not null,
 owner_id uuid not null references public.users(id),reviewer_id uuid not null references public.users(id),session_id uuid not null,
 request_text text not null check(octet_length(request_text)<=20000),request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),
 challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,
 source jsonb not null,previous_revision_id uuid,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 unique(tenant_id,id),foreign key(tenant_id,policy_id) references public.standing_approval_policies(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id),
 check(owner_id<>reviewer_id and expires_at>created_at and expires_at<=created_at+interval '1 hour')
);
create table controller_security.standing173_reviews (
 operation_key uuid primary key,tenant_id uuid not null,revision_id uuid not null unique,
 actor_id uuid not null references public.users(id),session_id uuid not null,
 decision_text text not null,decision_sha256 text not null check(decision_sha256~'^[a-f0-9]{64}$'),
 challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,revision_id) references controller_security.standing173_requests(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table controller_security.standing173_seals (
 revision_id uuid primary key,tenant_id uuid not null,delegation_text text not null,delegation_sha256 text not null check(delegation_sha256~'^[a-f0-9]{64}$'),
 signature text not null check(signature~'^[a-f0-9]{64}$'),receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,revision_id) references controller_security.standing173_requests(tenant_id,id),foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table controller_security.standing173_heads (
 policy_id uuid primary key,tenant_id uuid not null,revision_id uuid not null,
 foreign key(tenant_id,policy_id) references public.standing_approval_policies(tenant_id,id),
 foreign key(tenant_id,revision_id) references controller_security.standing173_requests(tenant_id,id)
);
create table controller_security.standing173_revocations (
 operation_key uuid primary key,tenant_id uuid not null,revision_id uuid not null unique,
 actor_id uuid not null references public.users(id),session_id uuid not null,decision_text text not null,decision_sha256 text not null,
 challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,revision_id) references controller_security.standing173_requests(tenant_id,id),foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table controller_security.standing173_decisions (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 binding_sha256 text not null check(binding_sha256~'^[a-f0-9]{64}$'),challenge_id uuid not null unique references public.mfa_challenges(id),factor_id uuid not null references public.user_mfa_factors(id),challenge_expires_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),check(challenge_expires_at>created_at and challenge_expires_at<=created_at+interval '5 minutes')
);
create table controller_security.standing173_fences (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 phase text not null check(phase in('request','approve','revoke')),intent_text text not null,intent_sha256 text not null,receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table controller_security.standing173_work (
 id uuid primary key,tenant_id uuid not null,revision_id uuid not null,kind text not null check(kind in('seal','approval')),
 state text not null default 'queued' check(state in('queued','claimed','sealed','issued','refused','escalated','unconfirmed')),
 nonce text,token_expires_at timestamptz,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 claimed_at timestamptz,finished_at timestamptz,token_id uuid,receipt_id bigint,reservation_receipt bigint not null,
 unique(revision_id,kind),unique(tenant_id,id),
 foreign key(tenant_id,revision_id) references controller_security.standing173_requests(tenant_id,id),
 foreign key(tenant_id,token_id) references public.approval_tokens(tenant_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id),foreign key(tenant_id,reservation_receipt) references public.audit_ledger(tenant_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '2 minutes'),
 check((kind='approval')=(nonce is not null and token_expires_at is not null)),
 check(nonce is null or nonce~'^[a-f0-9]{32}$'),
 check((state='issued')=(token_id is not null)),check(state not in('sealed','issued') or(receipt_id is not null and finished_at is not null))
);
create table controller_security.standing173_suspensions (
 revision_id uuid primary key,tenant_id uuid not null,work_id uuid not null,receipt_id bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,revision_id) references controller_security.standing173_requests(tenant_id,id),
 foreign key(tenant_id,work_id) references controller_security.standing173_work(tenant_id,id),foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
-- No API/backend caller has direct table privileges or a mutable authority row.
do $$declare n text;begin
 foreach n in array array['requests','reviews','seals','heads','revocations','decisions','fences','work','suspensions'] loop
  execute format('revoke all on controller_security.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,owned_target_controller','standing173_'||n);
  if n not in('heads','work') then execute format('create trigger standing173_immutable before update or delete on controller_security.%I for each row execute function public.evidence_receipt_immutable()','standing173_'||n);
  else execute format('create trigger standing173_no_delete before delete on controller_security.%I for each row execute function public.evidence_receipt_immutable()','standing173_'||n);end if;
  execute format('create trigger standing173_no_truncate before truncate on controller_security.%I for each statement execute function public.evidence_receipt_immutable()','standing173_'||n);
 end loop;
end $$;

create function controller_security.standing173_work_guard() returns trigger language plpgsql set search_path='' as $$begin
 if(new.id,new.tenant_id,new.revision_id,new.kind,new.nonce,new.token_expires_at,new.created_at,new.expires_at,new.reservation_receipt)
 is distinct from(old.id,old.tenant_id,old.revision_id,old.kind,old.nonce,old.token_expires_at,old.created_at,old.expires_at,old.reservation_receipt)
 or not((old.state='queued' and new.state in('claimed','refused')) or(old.state='claimed' and new.state in('sealed','issued','refused','escalated','unconfirmed')))
 then raise exception 'standing work history immutable' using errcode='23514';end if;return new;end $$;
create trigger standing173_work_transition before update on controller_security.standing173_work for each row execute function controller_security.standing173_work_guard();

create function controller_security.standing173_human(t uuid,a uuid,s uuid) returns void
language plpgsql volatile security definer set search_path='' as $$begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 perform 1 from public.users where id=a for no key update;
 perform 1 from public.tenants where id=t and is_demo for share;
 if not found or not(public.is_live_platform_founder(a) or exists(select 1 from public.tenant_users where tenant_id=t and user_id=a and role in('owner','admin','approver')))
 then raise exception 'current standing human authority required' using errcode='42501';end if;
 perform public.assert_mfa_recovery_session_actor(a,s);
 perform 1 from public.tenant_users where tenant_id=t and user_id=a for share;
 perform 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp()) for share;
 if not found then raise exception 'current standing human session required' using errcode='42501';end if;
end $$;
create function controller_security.standing173_parties(t uuid,owner_id uuid,reviewer uuid,initiator uuid) returns void
language plpgsql volatile security definer set search_path='' as $$begin
 perform 1 from public.users where id in(owner_id,reviewer,initiator) order by id for no key update;
 perform 1 from public.tenant_users where tenant_id=t and user_id=owner_id and role='owner' for share;
 if not found or reviewer is null or reviewer=owner_id or reviewer=initiator then raise exception 'standing maker checker refused' using errcode='42501';end if;
 perform 1 from public.platform_founders where user_id=reviewer for share;
 perform 1 from public.tenant_users where tenant_id=t and user_id=reviewer for share;
 if not public.is_live_platform_founder(reviewer) and not exists(select 1 from public.tenant_users where tenant_id=t and user_id=reviewer and role in('owner','admin','approver')
 and(cardinality(approval_scopes)=0 or 'config.audit_log_enable'=any(approval_scopes)))
 then raise exception 'current scoped standing reviewer required' using errcode='42501';end if;
 if public.mfa_recovery_open_case(owner_id) is not null or public.mfa_recovery_open_case(reviewer) is not null then raise exception 'standing actor recovery pending' using errcode='42501';end if;
end $$;

create function public.issue_standing_policy_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_ttl_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;d controller_security.standing173_decisions;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'standing policy MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'standing policy MFA input refused' using errcode='22023';end if;

 if p_ttl_ms is null or p_ttl_ms not between 1 and 300000 then raise exception 'standing policy MFA TTL refused' using errcode='22023';end if;

 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;

 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id and is_demo) or not(public.is_live_platform_founder(p_actor_id) or exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin','approver')))
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'standing policy MFA scope refused' using errcode='42501';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,173));
 if exists(select 1 from controller_security.standing173_fences where operation_key=p_operation_key) then raise exception 'scope request fenced' using errcode='42501';end if;
 select * into d from controller_security.standing173_decisions where operation_key=p_operation_key;
 if d.operation_key is not null then
  if (d.tenant_id,d.actor_id,d.session_id,d.binding_sha256,d.factor_id) is distinct from(p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256,p_factor_id) then raise exception 'MFA decision conflict' using errcode='23505';end if;
  select * into c from public.mfa_challenges where id=d.challenge_id;
  return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
 end if;
 insert into public.mfa_challenges(user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at)
 values(p_actor_id,p_tenant_id,p_factor_id,'standing_policy_revision',p_operation_key::text,p_bound_payload_sha256,now_at,now_at+p_ttl_ms*interval '1 millisecond') returning * into c;
 insert into controller_security.standing173_decisions(operation_key,tenant_id,actor_id,session_id,binding_sha256,challenge_id,factor_id,challenge_expires_at,created_at)values(p_operation_key,p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256,c.id,p_factor_id,c.expires_at,now_at);
 return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
end $$;
create function public.satisfy_standing_policy_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_satisfied_with text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'standing policy MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'standing policy MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_satisfied_with is null or p_satisfied_with not in ('totp','recovery_code') then raise exception 'standing policy MFA input refused' using errcode='22023';end if;

 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,173));
 if exists(select 1 from controller_security.standing173_fences where operation_key=p_operation_key)
  or not exists(select 1 from controller_security.standing173_decisions d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id and d.factor_id=p_factor_id)
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id and is_demo) or not(public.is_live_platform_founder(p_actor_id) or exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin','approver')))
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'standing policy MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'standing_policy_revision'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or not exists(select 1 from controller_security.standing173_decisions d where d.operation_key=p_operation_key and d.factor_id=c.factor_id and d.created_at=c.created_at and d.challenge_expires_at=c.expires_at)
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'standing policy MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is not null or c.satisfied_with is not null then raise exception 'standing policy MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set satisfied_at=now_at,satisfied_with=p_satisfied_with where id=c.id and attempts=p_expected_attempts and satisfied_at is null and consumed_at is null returning * into c;
 if not found then raise exception 'standing policy MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'satisfied_with',c.satisfied_with);
end $$;
create function public.consume_standing_policy_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_consumed_for uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'standing policy MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'standing policy MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_consumed_for is null or p_consumed_for is distinct from p_operation_key then raise exception 'standing policy MFA input refused' using errcode='22023';end if;

 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,173));
 if exists(select 1 from controller_security.standing173_fences where operation_key=p_operation_key)
  or not exists(select 1 from controller_security.standing173_decisions d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id and d.factor_id=p_factor_id)
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id and is_demo) or not(public.is_live_platform_founder(p_actor_id) or exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin','approver')))
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'standing policy MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'standing_policy_revision'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or not exists(select 1 from controller_security.standing173_decisions d where d.operation_key=p_operation_key and d.factor_id=c.factor_id and d.created_at=c.created_at and d.challenge_expires_at=c.expires_at)
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'standing policy MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is null or c.satisfied_with not in ('totp','recovery_code') or c.satisfied_with is null
  or c.satisfied_at<c.created_at or c.satisfied_at>now_at or c.satisfied_at<=now_at-interval '5 minutes'
 then raise exception 'standing policy MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set consumed_at=now_at,consumed_for=p_consumed_for::text where id=c.id and attempts=p_expected_attempts and satisfied_at is not null and consumed_at is null returning * into c;
 if not found then raise exception 'standing policy MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'expires_at',c.expires_at,'factor_id',c.factor_id);
end $$;
revoke all on function public.issue_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.issue_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.satisfy_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.satisfy_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) to service_role;
revoke all on function public.consume_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.consume_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;


create function controller_security.standing173_policy_sha(p public.standing_approval_policies) returns text
language sql immutable set search_path='' as $$select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_object(
 'id',p.id,'tenantId',p.tenant_id,'name',p.name,'version',p.version,'scope',p.scope,'ownerId',p.created_by,'reviewerId',p.approved_by,
 'expiresAt',to_char(p.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),'UTF8')),'hex')$$;

-- Real same-database measured source only. No caller source/environment flag
-- can enroll a target, invent a dry-run, or refresh its expiry.
create function controller_security.standing173_source(t uuid,plan uuid,policy uuid,accepted_token uuid default null) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare p public.remediation_plans;pol public.standing_approval_policies;a public.remediation_actions;
 b owned_synthetic.bindings;d owned_synthetic.deployment_requests;approval owned_synthetic.deployment_approvals;
 human owned_synthetic.human_requests;h public.local_custody_policy_heads;v public.local_custody_policy_versions;activation uuid;proof jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 lock table public.kill_switch_state in share mode;
 select * into p from public.remediation_plans where tenant_id=t and id=plan for update;
 select * into pol from public.standing_approval_policies where tenant_id=t and id=policy for update;
 if p.id is null or pol.id is null or p.generated_by_agent is distinct from 'human' or p.purpose is distinct from 'remediation' or p.status not in('review','approved')
 or pol.status<>'active' or pol.expires_at<=clock_timestamp() or not public.standing_policy_scope_is_valid(pol.scope)
 or not exists(select 1 from jsonb_array_elements_text(pol.scope->'action_types')x where x='config.audit_log_enable')
 then raise exception 'current measured standing source required' using errcode='42501';end if;
 if(select count(*) from public.remediation_actions where tenant_id=t and plan_id=plan)<>1 then raise exception 'one measured action required' using errcode='42501';end if;
 select * into strict a from public.remediation_actions where tenant_id=t and plan_id=plan for update;
 if a.action_type<>'config.audit_log_enable' or a.parameters is distinct from '{"enabled":true}'::jsonb or coalesce(cardinality(a.closes_finding_ids),0)<>0
 or cardinality(public.action_row_approval_blockers(a))<>0
 or exists(select 1 from public.approval_tokens tok where(tok.tenant_id,tok.id)=(t,a.approval_token_id) and tok.status not in('revoked','expired') and tok.id is distinct from accepted_token)
 then raise exception 'fresh BR2 measured action required' using errcode='42501';end if;
 select * into strict b from owned_synthetic.bindings where tenant_id=t and action_id=a.id;
 b:=owned_synthetic.require_binding(t,b.id,p.engagement_id);
 select * into strict d from owned_synthetic.deployment_requests where(tenant_id,binding_id)=(t,b.id);
 approval:=owned_synthetic.deployment_current_approval(t,d.id);
 select * into strict human from owned_synthetic.human_requests where tenant_id=t and state='recorded' and binding_id=b.id
 and receipt->>'planId'=p.id::text and receipt->>'actionId'=a.id::text and receipt->>'bindingId'=b.id::text;
 perform controller_security.standing173_parties(t,pol.created_by,pol.approved_by,human.actor_id);
 perform 1 from public.workload_identities where tenant_id=t and agent_name='karya' and spiffe_id='spiffe://local.axiomproof.test/agent/karya' and status='active' for share;
 if not found then raise exception 'current Karya workload registration required' using errcode='42501';end if;
 if pol.scope?'environments' and not exists(select 1 from jsonb_array_elements_text(pol.scope->'environments')x where x=b.environment)
 then raise exception 'standing environment scope refused' using errcode='42501';end if;
 proof:=public.measure_owned_synthetic_target(t,b.id,p.engagement_id);
 if proof is distinct from human.roundtrip or proof->'persistent_mutations' is distinct from '0'::jsonb or proof->'resources_measured' is distinct from '1'::jsonb
 or proof#>'{before,audit_log_enabled}' is distinct from 'false'::jsonb or proof#>'{projected_after,audit_log_enabled}' is distinct from 'true'::jsonb
 or proof#>'{restored,audit_log_enabled}' is distinct from 'false'::jsonb
 or a.rollback_definition is distinct from jsonb_build_object('enabled',false,'snapshot_sha256',owned_synthetic.snapshot_sha256(proof->'before'))
 or a.dry_run_result->>'source_snapshot_sha256' is distinct from owned_synthetic.snapshot_sha256(proof->'before')
 then raise exception 'actual standing preflight rollback refused' using errcode='42501';end if;
 select * into strict h from public.local_custody_policy_heads where tenant_id=t and policy_id=b.custody_policy_id;
 select * into strict v from public.local_custody_policy_versions where tenant_id=t and id=b.custody_policy_id;
 select id into strict activation from public.local_custody_policy_events where tenant_id=t and policy_id=b.custody_policy_id and transition='activate' and activation_epoch=b.custody_activation_epoch;
 return jsonb_build_object('policyId',pol.id,'policyVersion',pol.version,'policySha256',controller_security.standing173_policy_sha(pol),
 'policyExpiresAt',to_char(pol.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'planId',p.id,'planVersion',p.version,'actionId',a.id,'contentDigest',public.action_set_content_digest(t,p.id,array[a.id]),
 'bindingId',b.id,'connectorId',b.connector_id,'engagementId',p.engagement_id,'fixtureId',b.fixture_id,'resourceId',b.resource_id,
 'deploymentRequestId',d.id,'deploymentApprovalId',approval.id,'deploymentExpiresAt',to_char(d.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'environment',b.environment,'engineSha256',b.engine_sha256,'capabilitySha256',b.capability_sha256,
 'snapshotSha256',owned_synthetic.snapshot_sha256(proof->'before'),'rollbackSha256',owned_synthetic.snapshot_sha256(a.rollback_definition),'roundtripSha256',owned_synthetic.snapshot_sha256(proof),
 'dryRunId',a.latest_dry_run_id,'dryRunExpiresAt',to_char(a.dry_run_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'custodyPolicyId',b.custody_policy_id,'custodyEpoch',b.custody_activation_epoch,'custodyActivationEventId',activation,'nominatedOperatorId',v.nominated_operator_id,'planInitiatorId',human.actor_id,
 'actionType','config.audit_log_enable','desiredEnabled',true);
end $$;

-- The canonical intent contains the phase; approval and revocation cannot
-- share an MFA digest even when all decision fields are identical.
create function controller_security.standing173_intent(r text) returns jsonb
language plpgsql immutable set search_path='' as $$declare v jsonb;q jsonb;begin
 if r is null or octet_length(r)>20000 then raise exception 'bounded standing intent required' using errcode='22023';end if;
 v:=r::jsonb;q:=v->'request';
 if controller_security.canonical_questionnaire_json(v) is distinct from r
 or jsonb_typeof(v) is distinct from 'object' or(select array_agg(key order by key)from jsonb_object_keys(v)key)is distinct from array['phase','request']::text[]
 or v->>'phase' is null or v->>'phase' not in('request','approve','revoke') or jsonb_typeof(q)is distinct from 'object'
 or q->'schemaVersion' is distinct from '1'::jsonb or q->>'operationKey' is null
 or jsonb_typeof(q->'reason')is distinct from 'string' or length(btrim(q->>'reason'))not between 20 and 2000
 then raise exception 'canonical phased standing intent required' using errcode='22023';end if;
 perform(q->>'operationKey')::uuid;
 if v->>'phase'='request' then
  if(select array_agg(key order by key)from jsonb_object_keys(q)key)is distinct from
  array['concurrency','expiresAt','maxAuthorizations','mode','operationKey','ownerId','previousRevisionId','reason','reviewerId','schemaVersion','source','stopOnFailure','tenantId']::text[]
  or q->'maxAuthorizations' is distinct from '1'::jsonb or q->'concurrency'is distinct from '1'::jsonb or q->'stopOnFailure'is distinct from 'true'::jsonb or q->>'mode'is distinct from 'individual'
  then raise exception 'one action standing request required' using errcode='22023';end if;
 else
  if(select array_agg(key order by key)from jsonb_object_keys(q)key)is distinct from array['operationKey','reason','requestSha256','revisionId','schemaVersion']::text[]
  or q->>'requestSha256' !~ '^[a-f0-9]{64}$' then raise exception 'exact standing decision required' using errcode='22023';end if;
  perform(q->>'revisionId')::uuid;
 end if;return v;
end $$;

create function public.preflight_standing_policy_revision(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare v jsonb;q jsonb;src jsonb;r controller_security.standing173_requests;head uuid;expires timestamptz;
begin
 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 v:=controller_security.standing173_intent(p_intent_text);q:=v->'request';
 if v->>'phase'='request' then
  src:=controller_security.standing173_source(p_tenant_id,(q#>>'{source,planId}')::uuid,(q#>>'{source,policyId}')::uuid);
  if q->'source' is distinct from src or(q->>'tenantId')::uuid is distinct from p_tenant_id or(q->>'ownerId')::uuid is distinct from p_actor_id
  or not exists(select 1 from public.standing_approval_policies where(tenant_id,id,created_by,approved_by)=(p_tenant_id,(src->>'policyId')::uuid,p_actor_id,(q->>'reviewerId')::uuid))
  then raise exception 'exact current standing source and owner required' using errcode='42501';end if;
  select revision_id into head from controller_security.standing173_heads where tenant_id=p_tenant_id and policy_id=(src->>'policyId')::uuid for update;
  if head is distinct from(q->>'previousRevisionId')::uuid then raise exception 'standing revision changed' using errcode='40001';end if;
  expires:=(q->>'expiresAt')::timestamptz;
  if expires<=clock_timestamp() or expires>least(clock_timestamp()+interval '1 hour',(src->>'policyExpiresAt')::timestamptz,(src->>'deploymentExpiresAt')::timestamptz,(src->>'dryRunExpiresAt')::timestamptz)
  then raise exception 'bounded standing expiry required' using errcode='42501';end if;
 else
  select * into r from controller_security.standing173_requests where tenant_id=p_tenant_id and id=(q->>'revisionId')::uuid for update;
  if r.id is null or r.request_sha256 is distinct from q->>'requestSha256' then raise exception 'exact standing revision required' using errcode='42501';end if;
  if v->>'phase'='approve' then
   if r.reviewer_id is distinct from p_actor_id or r.expires_at<=clock_timestamp() or exists(select 1 from controller_security.standing173_revocations where revision_id=r.id)
   then raise exception 'current named standing reviewer required' using errcode='42501';end if;
   src:=controller_security.standing173_source(p_tenant_id,(r.source->>'planId')::uuid,r.policy_id);
   if src is distinct from r.source then raise exception 'standing source changed' using errcode='42501';end if;
  elsif p_actor_id not in(r.owner_id,r.reviewer_id) then raise exception 'standing revocation actor refused' using errcode='42501';
  elsif p_actor_id=r.owner_id then
   if not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role='owner') then raise exception 'current standing owner required' using errcode='42501';end if;
  else perform controller_security.standing173_parties(p_tenant_id,r.owner_id,r.reviewer_id,(r.source->>'planInitiatorId')::uuid);
  end if;
 end if;
 return jsonb_build_object('intent',v,'tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,
 'requestSha256',encode(sha256(convert_to(p_intent_text,'UTF8')),'hex'),'phase',v->>'phase');
end $$;

create function public.read_standing_policy_revision_operation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare v jsonb;q jsonb;r controller_security.standing173_requests;x controller_security.standing173_reviews;
 z controller_security.standing173_revocations;f controller_security.standing173_fences;d controller_security.standing173_decisions;c public.mfa_challenges;
 op uuid;digest text;revision uuid;receipt bigint;recorded_actor uuid;original text;st text;binding text;
begin
 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 v:=controller_security.standing173_intent(p_intent_text);q:=v->'request';op:=(q->>'operationKey')::uuid;digest:=encode(sha256(convert_to(p_intent_text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(op::text,173));
 select * into r from controller_security.standing173_requests where id=op;
 select * into x from controller_security.standing173_reviews where operation_key=op;
 select * into z from controller_security.standing173_revocations where operation_key=op;
 if r.id is not null then revision:=r.id;receipt:=r.receipt_id;recorded_actor:=r.owner_id;original:=r.request_text;st:='requested';
 elsif x.operation_key is not null then revision:=x.revision_id;receipt:=x.receipt_id;recorded_actor:=x.actor_id;original:=x.decision_text;st:='reviewed';
 elsif z.operation_key is not null then revision:=z.revision_id;receipt:=z.receipt_id;recorded_actor:=z.actor_id;original:=z.decision_text;st:='revoked';end if;
 if revision is not null then
  if recorded_actor is distinct from p_actor_id or original is distinct from p_intent_text or not exists(select 1 from controller_security.standing173_requests where tenant_id=p_tenant_id and id=revision)
  then raise exception 'standing operation conflict' using errcode='23505';end if;
  if exists(select 1 from controller_security.standing173_revocations where revision_id=revision) then st:='revoked';
  elsif exists(select 1 from controller_security.standing173_suspensions where revision_id=revision)then st:='unconfirmed';
  elsif exists(select 1 from controller_security.standing173_requests where id=revision and expires_at<=clock_timestamp())then st:='expired';
  elsif exists(select 1 from controller_security.standing173_seals where revision_id=revision)then st:='sealed';end if;
  return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'phase',v->>'phase','operationKey',op)||jsonb_build_object('recorded',true,'requestSha256',digest,'revisionId',revision,'state',st,'receiptId',receipt::text);
 end if;
 select * into f from controller_security.standing173_fences where operation_key=op;
 if f.operation_key is not null then
  if(f.tenant_id,f.actor_id,f.intent_text)is distinct from(p_tenant_id,p_actor_id,p_intent_text)then raise exception 'standing fence conflict' using errcode='23505';end if;
  return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'phase',v->>'phase','operationKey',op)||jsonb_build_object('recorded',false,'requestSha256',digest,'fenced',true,'fenceReceiptId',f.receipt_id::text,'challengeExpiresAt',null);
 end if;
 select * into d from controller_security.standing173_decisions where operation_key=op;
 if d.operation_key is not null then
  binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.standing-policy.'||(v->>'phase'),1,p_tenant_id::text,p_actor_id::text,d.session_id::text,digest)),'UTF8')),'hex');
  if(d.tenant_id,d.actor_id,d.binding_sha256)is distinct from(p_tenant_id,p_actor_id,binding)then raise exception 'standing MFA operation conflict' using errcode='23505';end if;
  select * into c from public.mfa_challenges where id=d.challenge_id;
 end if;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'phase',v->>'phase','operationKey',op)||jsonb_build_object('recorded',false,'requestSha256',digest,'fenced',false,'fenceReceiptId',null,'challengeExpiresAt',c.expires_at);
end $$;

create function public.record_standing_policy_revision(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text,p_challenge_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare proof jsonb;v jsonb;q jsonb;old jsonb;digest text;binding text;ch public.mfa_challenges;receipt bigint;revision uuid;op uuid;phase text;now_at timestamptz;r controller_security.standing173_requests;retired uuid;
begin
 if current_setting('role',true)is distinct from 'human_action_writer' then raise exception 'human standing writer required' using errcode='42501';end if;
 old:=public.read_standing_policy_revision_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 if old->>'recorded'='true' then return old;end if;
 if old->>'fenced'='true' then raise exception 'standing intent fenced' using errcode='42501';end if;
 proof:=public.preflight_standing_policy_revision(p_tenant_id,p_actor_id,p_session_id,p_intent_text);v:=proof->'intent';q:=v->'request';digest:=proof->>'requestSha256';phase:=v->>'phase';op:=(q->>'operationKey')::uuid;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into ch from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.standing-policy.'||phase,1,p_tenant_id::text,p_actor_id::text,p_session_id::text,digest)),'UTF8')),'hex');
 if ch.id is null or(ch.user_id,ch.tenant_id,ch.purpose::text,ch.bound_resource_ref,ch.bound_payload_sha256,ch.consumed_for)is distinct from
 (p_actor_id,p_tenant_id,'standing_policy_revision',op::text,binding,op::text)
 or ch.satisfied_at is null or ch.consumed_at is null or ch.created_at>ch.satisfied_at or ch.satisfied_at>ch.consumed_at or ch.satisfied_at<=now_at-interval '5 minutes' or ch.consumed_at>now_at or ch.expires_at<=now_at or ch.expires_at>ch.created_at+interval '5 minutes'
 or not exists(select 1 from public.user_mfa_factors where id=ch.factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 or not exists(select 1 from controller_security.standing173_decisions where operation_key=op and(tenant_id,actor_id,session_id,binding_sha256,challenge_id,factor_id,created_at,challenge_expires_at)=(p_tenant_id,p_actor_id,p_session_id,binding,ch.id,ch.factor_id,ch.created_at,ch.expires_at))
 or exists(select 1 from controller_security.standing173_requests where challenge_id=ch.id)
 or exists(select 1 from controller_security.standing173_reviews where challenge_id=ch.id)
 or exists(select 1 from controller_security.standing173_revocations where challenge_id=ch.id)
 then raise exception 'fresh exact standing MFA required' using errcode='42501';end if;
 proof:=public.preflight_standing_policy_revision(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 revision:=case when phase='request'then op else(q->>'revisionId')::uuid end;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'connector.updated',revision::text,digest,null,null,null,null,null,'success',
 jsonb_build_object('phase','standing_revision_'||phase,'revisionId',revision,'targetMutation',false,'executionRequested',false));
 if phase='request' then
  insert into controller_security.standing173_requests(id,tenant_id,policy_id,owner_id,reviewer_id,session_id,request_text,request_sha256,challenge_id,receipt_id,source,previous_revision_id,expires_at)
  values(op,p_tenant_id,(q#>>'{source,policyId}')::uuid,p_actor_id,(q->>'reviewerId')::uuid,p_session_id,p_intent_text,digest,ch.id,receipt,q->'source',(q->>'previousRevisionId')::uuid,(q->>'expiresAt')::timestamptz);
 elsif phase='approve' then
  insert into controller_security.standing173_reviews(operation_key,tenant_id,revision_id,actor_id,session_id,decision_text,decision_sha256,challenge_id,receipt_id)
  values(op,p_tenant_id,revision,p_actor_id,p_session_id,p_intent_text,digest,ch.id,receipt);
 else
  insert into controller_security.standing173_revocations(operation_key,tenant_id,revision_id,actor_id,session_id,decision_text,decision_sha256,challenge_id,receipt_id)
  values(op,p_tenant_id,revision,p_actor_id,p_session_id,p_intent_text,digest,ch.id,receipt);
  -- The revision is ineligible immediately. Only unconsumed tokens created by
  -- its own completed fire are revoked; consumed dispatch recovery is retained.
  perform 1 from public.remediation_plans where tenant_id=p_tenant_id and id=(select(source->>'planId')::uuid from controller_security.standing173_requests where id=revision)for update;
  for retired in update public.approval_tokens set status='revoked',revoked_at=clock_timestamp()where tenant_id=p_tenant_id and status='issued'and id in(select token_id from controller_security.standing173_work where revision_id=revision and state='issued')returning id loop
   perform public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'approval.token.revoked',retired::text,null,null,retired,p_actor_id,null,null,'success',jsonb_build_object('phase','standing173_revision_revoked','revisionId',revision,'consumedRecoveryRetained',true));
  end loop;
 end if;
 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 if ch.expires_at<=clock_timestamp() or(phase<>'revoke'and(q->>'expiresAt')is not null and(q->>'expiresAt')::timestamptz<=clock_timestamp())then raise exception 'standing decision expired during recording' using errcode='42501';end if;
 if phase='approve'and exists(select 1 from controller_security.standing173_requests where id=revision and expires_at<=clock_timestamp())then raise exception 'standing approval expired during recording' using errcode='42501';end if;
 return public.read_standing_policy_revision_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
end $$;

create function public.fence_standing_policy_revision(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare v jsonb;q jsonb;old jsonb;receipt bigint;digest text;begin
 if current_setting('role',true)is distinct from 'human_action_writer'then raise exception 'human standing fence writer required' using errcode='42501';end if;
 old:=public.read_standing_policy_revision_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 if old->>'recorded'='true'or old->>'fenced'='true'then return old;end if;
 v:=controller_security.standing173_intent(p_intent_text);q:=v->'request';digest:=old->>'requestSha256';
 receipt:=public.append_ledger(p_tenant_id,(q->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'connector.updated',null,digest,null,null,null,null,null,'success',jsonb_build_object('phase','standing_intent_fenced','decisionPhase',v->>'phase'));
 insert into controller_security.standing173_fences(operation_key,tenant_id,actor_id,session_id,phase,intent_text,intent_sha256,receipt_id)
 values((q->>'operationKey')::uuid,p_tenant_id,p_actor_id,p_session_id,v->>'phase',p_intent_text,digest,receipt);
 return public.read_standing_policy_revision_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
end $$;

create function controller_security.standing173_delegation(t uuid,revision uuid)returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r controller_security.standing173_requests;a controller_security.standing173_reviews;begin
 select * into strict r from controller_security.standing173_requests where tenant_id=t and id=revision;
 select * into strict a from controller_security.standing173_reviews where tenant_id=t and revision_id=revision;
 return jsonb_build_object('schemaVersion',1,'purpose','axiom.standing-policy-delegation.v1','tenantId',t,'revisionId',r.id,'requestSha256',r.request_sha256,
 'request',r.request_text::jsonb->'request','ownerDecision',jsonb_build_object('actorId',r.owner_id,'challengeId',r.challenge_id,'receiptId',r.receipt_id::text),
 'reviewerDecision',jsonb_build_object('actorId',r.reviewer_id,'challengeId',a.challenge_id,'receiptId',a.receipt_id::text));
end $$;

create function controller_security.standing173_live(t uuid,revision uuid,sealing boolean default false,accepted_token uuid default null)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare r controller_security.standing173_requests;a controller_security.standing173_reviews;ch public.mfa_challenges;src jsonb;decision controller_security.standing173_decisions;expected_actor uuid;expected_session uuid;expected_phase text;expected_sha text;expected_challenge uuid;expected_binding text;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 select * into strict r from controller_security.standing173_requests where tenant_id=t and id=revision for update;
 select * into strict a from controller_security.standing173_reviews where tenant_id=t and revision_id=revision;
 if r.expires_at<=clock_timestamp()or exists(select 1 from controller_security.standing173_revocations where revision_id=revision)
 or exists(select 1 from controller_security.standing173_suspensions where revision_id=revision)
 then raise exception 'standing revision is ineligible' using errcode='42501';end if;
 perform 1 from public.user_mfa_factors where user_id in(r.owner_id,r.reviewer_id) and factor_type='totp' order by id for update;
 if(select count(*)from controller_security.standing173_decisions where operation_key in(r.id,a.operation_key))<>2 then raise exception 'two immutable standing MFA decisions required'using errcode='42501';end if;
 for decision in select *from controller_security.standing173_decisions where operation_key in(r.id,a.operation_key)order by operation_key for share loop
  if decision.operation_key=r.id then expected_actor:=r.owner_id;expected_session:=r.session_id;expected_phase:='request';expected_sha:=r.request_sha256;expected_challenge:=r.challenge_id;
  else expected_actor:=r.reviewer_id;expected_session:=a.session_id;expected_phase:='approve';expected_sha:=a.decision_sha256;expected_challenge:=a.challenge_id;end if;
  expected_binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.standing-policy.'||expected_phase,1,t::text,expected_actor::text,expected_session::text,expected_sha)),'UTF8')),'hex');
  select *into strict ch from public.mfa_challenges where id=expected_challenge for share;
  if(decision.tenant_id,decision.actor_id,decision.session_id,decision.binding_sha256,decision.challenge_id)is distinct from(t,expected_actor,expected_session,expected_binding,expected_challenge)
  or(ch.user_id,ch.tenant_id,ch.factor_id,ch.purpose::text,ch.bound_resource_ref,ch.bound_payload_sha256,ch.consumed_for,ch.created_at,ch.expires_at)is distinct from
  (expected_actor,t,decision.factor_id,'standing_policy_revision',decision.operation_key::text,expected_binding,decision.operation_key::text,decision.created_at,decision.challenge_expires_at)
  or ch.satisfied_at is null or ch.consumed_at is null or ch.satisfied_with is null or ch.satisfied_with not in('totp','recovery_code')
  or ch.satisfied_at<decision.created_at or ch.satisfied_at>ch.consumed_at or ch.consumed_at>=decision.challenge_expires_at
  or not exists(select 1 from public.user_mfa_factors where id=decision.factor_id and user_id=expected_actor and factor_type='totp'and status='active'and revoked_at is null)
  or(sealing and decision.challenge_expires_at<=clock_timestamp())then raise exception 'standing delegation immutable MFA proof is not current' using errcode='42501';end if;
 end loop;
 if not sealing and not exists(select 1 from controller_security.standing173_heads where tenant_id=t and policy_id=r.policy_id and revision_id=r.id)
 then raise exception 'standing revision superseded' using errcode='42501';end if;
 src:=controller_security.standing173_source(t,(r.source->>'planId')::uuid,r.policy_id,accepted_token);
 if src is distinct from r.source or r.expires_at<=clock_timestamp()then raise exception 'standing source changed or expired' using errcode='42501';end if;
 return src;
end $$;

create function controller_security.standing173_response(t uuid,work uuid)returns jsonb
language plpgsql stable security definer set search_path='' as $$declare w controller_security.standing173_work;begin
 select * into strict w from controller_security.standing173_work where tenant_id=t and id=work;
 return jsonb_build_object('tenantId',t,'workId',w.id,'kind',w.kind,'state',case when w.state in('queued','claimed')then 'unconfirmed'else w.state end,'receiptId',w.receipt_id::text,'tokenId',w.token_id);
end $$;

create function public.read_standing_policy_work(p_tenant_id uuid,p_work_id uuid)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;receipt bigint;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 select * into strict w from controller_security.standing173_work where tenant_id=p_tenant_id and id=p_work_id for update;
 if w.state in('queued','claimed')and w.expires_at<=clock_timestamp()then
  receipt:=public.append_ledger(p_tenant_id,w.id,'agent','standing-policy-coordinator',null,null,null,'connector.updated',w.revision_id::text,null,null,null,null,null,null,'failure',
   jsonb_build_object('phase','standing_work_expired','priorState',w.state,'relaunchPermitted',false,'outcome','unconfirmed'));
  update controller_security.standing173_work set state=case when w.state='queued'then 'refused'else 'unconfirmed'end,receipt_id=receipt,finished_at=clock_timestamp()where id=w.id;
  insert into controller_security.standing173_suspensions(revision_id,tenant_id,work_id,receipt_id)values(w.revision_id,p_tenant_id,w.id,receipt)on conflict(revision_id)do nothing;
 end if;
 return controller_security.standing173_response(p_tenant_id,p_work_id);
end $$;

create function public.reserve_standing_policy_work()returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;r controller_security.standing173_requests;work uuid;receipt bigint;work_kind text;deadline timestamptz;
begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 -- One global bounded assignment. Restart always recovers a prior claimed row;
 -- it never creates another nonce while a handoff is uncertain.
 perform pg_advisory_xact_lock(173,173);
 select * into w from controller_security.standing173_work where state in('queued','claimed')order by created_at,id limit 1;
 if w.id is not null then
  perform public.read_standing_policy_work(w.tenant_id,w.id);
  if exists(select 1 from controller_security.standing173_work where id=w.id and state in('queued','claimed'))then
   return jsonb_build_object('work',jsonb_build_array(jsonb_build_object('tenantId',w.tenant_id,'workId',w.id,'kind',w.kind)));
  end if;
  return jsonb_build_object('work','[]'::jsonb);
 end if;
 for r in select request.* from controller_security.standing173_requests request join controller_security.standing173_reviews review on(review.tenant_id,review.revision_id)=(request.tenant_id,request.id)
 where request.expires_at>clock_timestamp()and not exists(select 1 from controller_security.standing173_revocations where revision_id=request.id)
 and not exists(select 1 from controller_security.standing173_suspensions where revision_id=request.id)
 and not exists(select 1 from controller_security.standing173_work where revision_id=request.id and kind='approval')
 order by request.created_at,request.id limit 32 loop
  work_kind:=case when exists(select 1 from controller_security.standing173_seals where revision_id=r.id)then 'approval'else 'seal'end;
  if exists(select 1 from controller_security.standing173_work where revision_id=r.id and standing173_work.kind=work_kind)then continue;end if;
  -- Authority drift does not become a polling exception or a new reservation.
  begin perform controller_security.standing173_live(r.tenant_id,r.id,work_kind='seal');exception when insufficient_privilege or no_data_found then continue;end;
  deadline:=least(clock_timestamp()+interval '2 minutes',r.expires_at);
  if deadline<=clock_timestamp()then continue;end if;
  work:=pg_catalog.gen_random_uuid();
  receipt:=public.append_ledger(r.tenant_id,work,'agent','standing-policy-coordinator',null,null,null,'connector.updated',r.id::text,null,null,null,null,null,null,'success',jsonb_build_object('phase','standing_'||work_kind||'_reserved','maxAuthorizations',1,'executionRequested',false));
  insert into controller_security.standing173_work(id,tenant_id,revision_id,kind,nonce,token_expires_at,expires_at,reservation_receipt)
  values(work,r.tenant_id,r.id,work_kind,case when work_kind='approval'then replace(pg_catalog.gen_random_uuid()::text,'-','')end,
   case when work_kind='approval'then least(clock_timestamp()+interval '5 minutes',r.expires_at)end,deadline,receipt);
  return jsonb_build_object('work',jsonb_build_array(jsonb_build_object('tenantId',r.tenant_id,'workId',work,'kind',work_kind)));
 end loop;
 return jsonb_build_object('work','[]'::jsonb);
end $$;

create function public.claim_standing_policy_work(p_tenant_id uuid,p_work_id uuid)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;src jsonb;d jsonb;seal controller_security.standing173_seals;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 perform public.read_standing_policy_work(p_tenant_id,p_work_id);
 select * into strict w from controller_security.standing173_work where tenant_id=p_tenant_id and id=p_work_id for update;
 if w.state<>'queued'then return controller_security.standing173_response(p_tenant_id,p_work_id);end if;
 src:=controller_security.standing173_live(p_tenant_id,w.revision_id,w.kind='seal');
 d:=controller_security.standing173_delegation(p_tenant_id,w.revision_id);
 update controller_security.standing173_work set state='claimed',claimed_at=clock_timestamp()where id=w.id;
 if w.kind='seal'then return jsonb_build_object('tenantId',p_tenant_id,'workId',w.id,'kind',w.kind,'state','claimed','delegation',d);end if;
 select * into strict seal from controller_security.standing173_seals where tenant_id=p_tenant_id and revision_id=w.revision_id;
 if seal.delegation_text is distinct from controller_security.canonical_questionnaire_json(d)then raise exception 'standing delegation changed'using errcode='42501';end if;
 return jsonb_build_object('tenantId',p_tenant_id,'workId',w.id,'kind',w.kind,'state','claimed','delegation',d,'delegationSignature',seal.signature,'currentSource',src,'nonce',w.nonce,
 'tokenExpiresAt',to_char(w.token_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

create function public.seal_standing_policy_delegation(p_tenant_id uuid,p_work_id uuid,p_signature text)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;r controller_security.standing173_requests;d jsonb;encoded text;digest text;receipt bigint;head uuid;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 perform public.read_standing_policy_work(p_tenant_id,p_work_id);
 select * into strict w from controller_security.standing173_work where tenant_id=p_tenant_id and id=p_work_id for update;
 if w.state<>'claimed'then return controller_security.standing173_response(p_tenant_id,p_work_id);end if;
 if w.kind<>'seal'or p_signature is null or p_signature!~'^[a-f0-9]{64}$'then raise exception 'exact standing seal required'using errcode='42501';end if;
 perform controller_security.standing173_live(p_tenant_id,w.revision_id,true);
 select * into strict r from controller_security.standing173_requests where tenant_id=p_tenant_id and id=w.revision_id;
 select revision_id into head from controller_security.standing173_heads where tenant_id=p_tenant_id and policy_id=r.policy_id for update;
 if head is distinct from r.previous_revision_id then raise exception 'standing revision superseded'using errcode='40001';end if;
 d:=controller_security.standing173_delegation(p_tenant_id,w.revision_id);encoded:=controller_security.canonical_questionnaire_json(d);digest:=encode(sha256(convert_to(encoded,'UTF8')),'hex');
 receipt:=public.append_ledger(p_tenant_id,w.id,'agent','standing-policy-coordinator',null,null,null,'connector.updated',w.revision_id::text,digest,null,null,null,null,null,'success',jsonb_build_object('phase','standing_delegation_sealed','ownerReceiptId',d#>>'{ownerDecision,receiptId}','reviewerReceiptId',d#>>'{reviewerDecision,receiptId}','executionRequested',false));
 insert into controller_security.standing173_seals(revision_id,tenant_id,delegation_text,delegation_sha256,signature,receipt_id)values(w.revision_id,p_tenant_id,encoded,digest,p_signature,receipt);
 insert into controller_security.standing173_heads(policy_id,tenant_id,revision_id)values(r.policy_id,p_tenant_id,r.id)
 on conflict(policy_id)do update set revision_id=excluded.revision_id where standing173_heads.revision_id is not distinct from r.previous_revision_id;
 if not found then raise exception 'standing head changed'using errcode='40001';end if;
 update controller_security.standing173_work set state='sealed',finished_at=clock_timestamp(),receipt_id=receipt where id=w.id;
 perform controller_security.standing173_live(p_tenant_id,w.revision_id,true);
 if w.expires_at<=clock_timestamp()then raise exception 'standing seal expired during recording'using errcode='42501';end if;
 return controller_security.standing173_response(p_tenant_id,p_work_id);
end $$;

create function public.refuse_standing_policy_work(p_tenant_id uuid,p_work_id uuid,p_reason text)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;receipt bigint;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 perform public.read_standing_policy_work(p_tenant_id,p_work_id);
 select * into strict w from controller_security.standing173_work where tenant_id=p_tenant_id and id=p_work_id for update;
 if w.state<>'claimed'then return controller_security.standing173_response(p_tenant_id,p_work_id);end if;
 if p_reason is null or p_reason not in('delegation_signature_refused','source_changed','br2_refused')then raise exception 'standing refusal reason refused'using errcode='22023';end if;
 receipt:=public.append_ledger(p_tenant_id,w.id,'agent','standing-policy-coordinator',null,null,null,'connector.updated',w.revision_id::text,null,null,null,null,null,null,'failure',jsonb_build_object('phase','standing_work_refused','reason',p_reason,'relaunchPermitted',false));
 update controller_security.standing173_work set state='escalated',finished_at=clock_timestamp(),receipt_id=receipt where id=w.id;
 insert into controller_security.standing173_suspensions(revision_id,tenant_id,work_id,receipt_id)values(w.revision_id,p_tenant_id,w.id,receipt)on conflict(revision_id)do nothing;
 return controller_security.standing173_response(p_tenant_id,p_work_id);
end $$;

create function controller_security.standing173_conditions(t uuid,work uuid)returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w controller_security.standing173_work;r controller_security.standing173_requests;s controller_security.standing173_seals;d jsonb;begin
 select * into strict w from controller_security.standing173_work where tenant_id=t and id=work;
 select * into strict r from controller_security.standing173_requests where tenant_id=t and id=w.revision_id;
 select * into strict s from controller_security.standing173_seals where tenant_id=t and revision_id=r.id;
 d:=controller_security.standing173_delegation(t,r.id);
 return jsonb_build_object('purpose','remediation_execution_v1','standingPolicy',jsonb_build_object('id',r.policy_id,'version',(r.source->>'policyVersion')::integer,
 'revisionId',r.id,'delegationSha256',s.delegation_sha256,'ownerReceiptId',d#>>'{ownerDecision,receiptId}','reviewerReceiptId',d#>>'{reviewerDecision,receiptId}','fireId',w.id));
end $$;
create function controller_security.standing173_mfa_detail(t uuid,work uuid)returns jsonb
language plpgsql stable security definer set search_path='' as $$declare w controller_security.standing173_work;d jsonb;begin
 select * into strict w from controller_security.standing173_work where tenant_id=t and id=work;
 d:=controller_security.standing173_delegation(t,w.revision_id);
 return jsonb_build_object('standingPolicyRevisionId',w.revision_id,'standingPolicyFireId',w.id,'delegationPurpose','axiom.standing-policy-delegation.v1',
 'ownerDecision',d->'ownerDecision','reviewerDecision',d->'reviewerDecision','transportActor','standing-policy-coordinator');
end $$;

-- Only the fixed private coordinator branch can select agent attribution.
-- All execution token fields are derived from the frozen reviewed delegation.
create function controller_security.standing173_assert_issuance(fire uuid,t uuid,plan uuid,actions uuid[],approver uuid,mode text,concurrency integer,stop boolean,
 payload jsonb,nonce text,expires timestamptz,digest text,conditions jsonb,mfa_detail jsonb,correlation uuid)returns void
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;r controller_security.standing173_requests;expected jsonb;src jsonb;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 select * into strict w from controller_security.standing173_work where tenant_id=t and id=fire for update;
 if w.kind<>'approval'or w.state<>'claimed'or w.expires_at<=clock_timestamp()or w.token_expires_at<=clock_timestamp()
 then raise exception 'one current standing fire required'using errcode='42501';end if;
 select * into strict r from controller_security.standing173_requests where tenant_id=t and id=w.revision_id;
 src:=controller_security.standing173_live(t,r.id);
 expected:=jsonb_build_object('planId',src->>'planId','actionIds',jsonb_build_array(src->>'actionId'),'approverId',r.reviewer_id,
 'mode','individual','concurrency',1,'stopOnFailure',true,'expiresAt',to_char(w.token_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'nonce',w.nonce,'contentDigest',src->>'contentDigest','conditions',controller_security.standing173_conditions(t,fire));
 if(plan,actions,approver,mode,concurrency,stop,nonce,expires,digest,correlation)is distinct from
 ((src->>'planId')::uuid,array[(src->>'actionId')::uuid],r.reviewer_id,'individual',1,true,w.nonce,w.token_expires_at,src->>'contentDigest',fire)
 or payload is distinct from expected or conditions is distinct from expected->'conditions' or mfa_detail is distinct from controller_security.standing173_mfa_detail(t,fire)
 then raise exception 'exact signed standing delegation required'using errcode='42501';end if;
end $$;

create function public.issue_standing_policy_approval(p_tenant_id uuid,p_work_id uuid,p_signature text,p_signed_payload jsonb)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare w controller_security.standing173_work;r controller_security.standing173_requests;result jsonb;token uuid;receipt bigint;src jsonb;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private standing coordinator required'using errcode='42501';end if;
 perform public.read_standing_policy_work(p_tenant_id,p_work_id);
 select * into strict w from controller_security.standing173_work where tenant_id=p_tenant_id and id=p_work_id for update;
 if w.state<>'claimed'then return controller_security.standing173_response(p_tenant_id,p_work_id);end if;
 if w.kind<>'approval'or p_signature is null or p_signature!~'^[a-f0-9]{64}$'then raise exception 'exact standing approval signature required'using errcode='42501';end if;
 select * into strict r from controller_security.standing173_requests where tenant_id=p_tenant_id and id=w.revision_id;
 src:=r.source;
 result:=controller_security.issue_plan_approval173(p_tenant_id,(src->>'planId')::uuid,array[(src->>'actionId')::uuid],r.reviewer_id,'individual',1,true,
 p_signature,p_signed_payload,w.nonce,w.token_expires_at,'Explicit human reviewed standing delegation',controller_security.standing173_conditions(p_tenant_id,w.id),null,
 src->>'contentDigest',controller_security.standing173_mfa_detail(p_tenant_id,w.id),w.id,w.id);
 if result->>'decision'is distinct from 'issued'then raise exception 'standing BR2 issuance refused'using errcode='42501';end if;
 token:=(result->>'token_id')::uuid;
 -- No expiry/authority drift during a ledger or trigger wait may commit an
 -- approval. Re-read under the original locks, allowing ONLY this new token.
 perform controller_security.standing173_live(p_tenant_id,r.id,false,token);
 if w.expires_at<=clock_timestamp()or w.token_expires_at<=clock_timestamp()then raise exception 'standing fire expired during issuance'using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,w.id,'agent','standing-policy-coordinator',null,null,null,'connector.updated',r.id::text,null,null,token,r.reviewer_id,null,null,'success',
 jsonb_build_object('phase','standing_approval_issued','originalOwnerId',r.owner_id,'namedApproverId',r.reviewer_id,'revisionId',r.id,'delegationSha256',(select delegation_sha256 from controller_security.standing173_seals where revision_id=r.id),'executionRequested',false));
 update controller_security.standing173_work set state='issued',token_id=token,receipt_id=receipt,finished_at=clock_timestamp()where id=w.id;
 -- The final clock follows the final append-only receipt as well.
 if w.expires_at<=clock_timestamp()or w.token_expires_at<=clock_timestamp()then raise exception 'standing receipt expired during issuance'using errcode='42501';end if;
 return controller_security.standing173_response(p_tenant_id,p_work_id);
end $$;

-- Explicit ACLs, including future overload protection, no additional role or
-- credential. Human decisions use only the sanctioned narrow writer; technical
-- work uses only the existing private BFF agent writer.
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where(n.nspname='controller_security'and(p.proname like 'standing173_%'or p.proname in('issue_plan_approval173','issue_plan_approval_before173')))
 or(n.nspname='public'and p.proname in('issue_standing_policy_mfa_challenge','satisfy_standing_policy_mfa_challenge','consume_standing_policy_mfa_challenge',
 'preflight_standing_policy_revision','read_standing_policy_revision_operation','record_standing_policy_revision','fence_standing_policy_revision',
 'read_standing_policy_work','reserve_standing_policy_work','claim_standing_policy_work','seal_standing_policy_delegation','refuse_standing_policy_work','issue_standing_policy_approval'))loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,owned_target_controller',f.signature);
 end loop;
end $$;
grant execute on function public.preflight_standing_policy_revision(uuid,uuid,uuid,text),public.read_standing_policy_revision_operation(uuid,uuid,uuid,text),
 public.issue_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer),public.satisfy_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text),
 public.consume_standing_policy_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid)to service_role;
grant execute on function public.record_standing_policy_revision(uuid,uuid,uuid,text,uuid),public.fence_standing_policy_revision(uuid,uuid,uuid,text),
 public.preflight_standing_policy_revision(uuid,uuid,uuid,text),public.read_standing_policy_revision_operation(uuid,uuid,uuid,text)to human_action_writer;
grant execute on function public.read_standing_policy_work(uuid,uuid),public.reserve_standing_policy_work(),public.claim_standing_policy_work(uuid,uuid),
 public.seal_standing_policy_delegation(uuid,uuid,text),public.refuse_standing_policy_work(uuid,uuid,text),public.issue_standing_policy_approval(uuid,uuid,text,jsonb)to agent_ledger_writer;

create function public.standing_policy_revision_context(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''set lock_timeout='5s' as $$
declare candidate record;r controller_security.standing173_requests;src jsonb;candidates jsonb:='[]';revisions jsonb:='[]';st text;head uuid;
begin
 perform controller_security.standing173_human(p_tenant_id,p_actor_id,p_session_id);
 for candidate in select pol.id policy_id,pol.name,pol.created_by,pol.approved_by,p.id plan_id
 from public.standing_approval_policies pol join public.remediation_plans p on p.tenant_id=pol.tenant_id
 join owned_synthetic.human_requests h on h.tenant_id=p.tenant_id and h.state='recorded'and h.receipt->>'planId'=p.id::text
 where pol.tenant_id=p_tenant_id and pol.status='active'and pol.expires_at>clock_timestamp()and p.generated_by_agent='human'and p.purpose='remediation'and p.status in('review','approved')
 and pol.created_by=p_actor_id order by p.created_at desc,pol.id limit 20 loop
  begin src:=controller_security.standing173_source(p_tenant_id,candidate.plan_id,candidate.policy_id);
  exception when insufficient_privilege or no_data_found then continue;end;
  select revision_id into head from controller_security.standing173_heads where tenant_id=p_tenant_id and policy_id=candidate.policy_id;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('policyName',candidate.name,'ownerId',candidate.created_by,'reviewerId',candidate.approved_by,'previousRevisionId',head,'source',src));
 end loop;
 for r in select * from controller_security.standing173_requests where tenant_id=p_tenant_id and p_actor_id in(owner_id,reviewer_id)order by created_at desc,id limit 100 loop
  st:=case when exists(select 1 from controller_security.standing173_revocations where revision_id=r.id)then 'revoked'
   when exists(select 1 from controller_security.standing173_suspensions where revision_id=r.id)then 'unconfirmed'
   when exists(select 1 from controller_security.standing173_work where revision_id=r.id and state='issued')then 'issued'
   when r.expires_at<=clock_timestamp()then 'expired'
   when exists(select 1 from controller_security.standing173_seals where revision_id=r.id)then 'sealed'
   when exists(select 1 from controller_security.standing173_reviews where revision_id=r.id)then 'reviewed'else 'requested'end;
  revisions:=revisions||jsonb_build_array(jsonb_build_object('revisionId',r.id,'requestSha256',r.request_sha256,'request',r.request_text::jsonb->'request','state',st,'ownerReceiptId',r.receipt_id::text,
   'reviewerReceiptId',(select receipt_id::text from controller_security.standing173_reviews where revision_id=r.id)));
 end loop;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'checkedAt',to_char(clock_timestamp()at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'candidates',candidates,'revisions',revisions);
end $$;
revoke all on function public.standing_policy_revision_context(uuid,uuid,uuid)from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,owned_target_controller;
grant execute on function public.standing_policy_revision_context(uuid,uuid,uuid)to service_role;

-- Revoking the original policy also reduces any outstanding173 authority.
-- Legacy tokens and consumed execution history retain their original semantics.
do $$begin
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.revoke_standing_policy(uuid,uuid,uuid,uuid)'::regprocedure)is distinct from '242b2d01bd24632e800cb80c82f4cb862de2d4e6ef28a27514626be93c1b7849'
 then raise exception 'reviewed policy revoke source changed'using errcode='55000';end if;
end $$;
alter function public.revoke_standing_policy(uuid,uuid,uuid,uuid)set schema controller_security;
alter function controller_security.revoke_standing_policy(uuid,uuid,uuid,uuid)rename to revoke_standing_policy_before173;
create function public.revoke_standing_policy(p_tenant_id uuid,p_policy_id uuid,p_revoked_by uuid,p_correlation_id uuid)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='5s' as $$
declare result jsonb;retired uuid;begin
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 -- Matches173 issuance: tenant47, sorted plans, then original policy. Atomic
 -- execution claims serialize on the same plan lock before consuming a token.
 perform 1 from public.remediation_plans p where p.tenant_id=p_tenant_id and exists(
 select 1 from controller_security.standing173_requests r join controller_security.standing173_work w on(w.tenant_id,w.revision_id)=(r.tenant_id,r.id)
 join public.approval_tokens tok on(tok.tenant_id,tok.id)=(w.tenant_id,w.token_id)
 where r.tenant_id=p_tenant_id and r.policy_id=p_policy_id and w.state='issued'and tok.status='issued'and tok.plan_id=p.id)order by p.id for update;
 result:=controller_security.revoke_standing_policy_before173(p_tenant_id,p_policy_id,p_revoked_by,p_correlation_id);
 if result#>>'{policy,status}'='revoked'then
  for retired in update public.approval_tokens tok set status='revoked',revoked_at=clock_timestamp()
  where tok.tenant_id=p_tenant_id and tok.status='issued'and exists(select 1 from controller_security.standing173_work w join controller_security.standing173_requests r on(r.tenant_id,r.id)=(w.tenant_id,w.revision_id)
   where w.tenant_id=p_tenant_id and w.state='issued'and w.token_id=tok.id and r.policy_id=p_policy_id)returning tok.id loop
   perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_revoked_by::text,null,null,null,'approval.token.revoked',retired::text,null,null,retired,p_revoked_by,null,null,'success',jsonb_build_object('phase','standing173_base_policy_revoked','policyId',p_policy_id,'consumedRecoveryRetained',true));
  end loop;
 end if;
 return result;
end $$;
do $$declare r record;begin
 for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop
  execute format('revoke all on function controller_security.revoke_standing_policy_before173(uuid,uuid,uuid,uuid),public.revoke_standing_policy(uuid,uuid,uuid,uuid)from %I',r.rolname);
 end loop;
end $$;
revoke all on function controller_security.revoke_standing_policy_before173(uuid,uuid,uuid,uuid),public.revoke_standing_policy(uuid,uuid,uuid,uuid)from public;
grant execute on function public.revoke_standing_policy(uuid,uuid,uuid,uuid)to human_action_writer;
