-- Candidate: explicitly authorized local metadata-only coverage reassessment.
-- No runtime is enabled, identity/credential is created, tool scope is added,
-- previous engagement is rewritten or discovery field interpreted as a legal fact.
alter type public.mfa_challenge_purpose add value if not exists 'scheduled_coverage';
-- Fail closed on any unreviewed predecessor; existing interactive bodies/ACLs are preserved.
do $$begin
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.delegate_workload_task(uuid,uuid,uuid,text,uuid,uuid,uuid,text,text,text[],timestamptz)'::regprocedure)is distinct from'd6477ec4841dfc97cb53f995a281ce3447b40e6b3387c00b3553f6f9ff10c29e'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea)'::regprocedure)is distinct from'7ef4d7b8140d8a60d1252777fed0b7b8d68a920d71305859a99ce1c7a5f180c7'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='controller_security.local143_grant_binding()'::regprocedure)is distinct from'ed1aad7179894543265db24a89c3dbb0f4c71c050f99c37c07d31786027e96ae'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure)is distinct from'43630f0bcf79f1b97668245dc4e57673595fa334cf495e0407520f04e5794781'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure)is distinct from'7f0065a27327376a4986d61c2acd5b25a28ab7d838df137bfb0dc6dcdcbada57'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.confirm_workload_assessment(uuid,uuid)'::regprocedure)is distinct from'eeaa7a9f594fe6f978a929001a7c4c9838b1a3bf7c5e2b3cc166a9b089a85972'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
 if(select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_catalog.pg_proc where oid='public.claim_local_assessment_dispatch(uuid,uuid,uuid,text,text)'::regprocedure)is distinct from'4882ec01bccf3da4fbbfca3f0b0004b4dfab1415fcca1559be3744d6e466253a'then raise exception 'reviewed175 predecessor changed'using errcode='55000';end if;
end $$;

create table controller_security.coverage175_decisions (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 binding_sha256 text not null check(binding_sha256~'^[a-f0-9]{64}$'),challenge_id uuid not null unique references public.mfa_challenges(id),factor_id uuid not null references public.user_mfa_factors(id),
 challenge_expires_at timestamptz not null,created_at timestamptz not null,check(challenge_expires_at>created_at and challenge_expires_at<=created_at+interval '5 minutes')
);
create table controller_security.coverage175_scopes (
 id uuid primary key,tenant_id uuid not null references public.tenants(id),schedule_id uuid not null,actor_id uuid not null references public.users(id),session_id uuid not null,
 request_text text not null check(octet_length(request_text)<=20000),request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),source jsonb not null,
 challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,previous_scope_id uuid,
 max_fires integer not null check(max_fires between 1 and 24),expires_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),foreign key(tenant_id,schedule_id)references public.monitoring_schedules(tenant_id,id),foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '1 hour')
);
create table controller_security.coverage175_heads (
 schedule_id uuid primary key,tenant_id uuid not null,scope_id uuid not null,
 foreign key(tenant_id,schedule_id)references public.monitoring_schedules(tenant_id,id),foreign key(tenant_id,scope_id)references controller_security.coverage175_scopes(tenant_id,id)
);
create table controller_security.coverage175_revocations (
 operation_key uuid primary key,tenant_id uuid not null,scope_id uuid not null unique,actor_id uuid not null references public.users(id),session_id uuid not null,
 request_text text not null,request_sha256 text not null,challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,scope_id)references controller_security.coverage175_scopes(tenant_id,id),foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id)
);
create table controller_security.coverage175_fences (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 phase text not null check(phase in('authorize','revoke')),request_text text not null,request_sha256 text not null,receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id)
);
create table controller_security.coverage175_fires (
 id uuid primary key,tenant_id uuid not null,scope_id uuid not null,read_fire_id uuid not null unique,
 discovery_request_id uuid not null unique references public.postgresql_discovery_requests(id),discovery_id uuid not null references public.connector_discovery_runs(id),discovery_result_sha256 text not null check(discovery_result_sha256~'^[a-f0-9]{64}$'),
 discovery_completed_at timestamptz not null,engagement_id uuid not null unique,job_id uuid not null unique,
 input_text text not null,input_sha256 text not null check(input_sha256=encode(sha256(convert_to(input_text,'UTF8')),'hex')),
 state text not null default 'queued'check(state in('queued','handed_off','dispatched','finalized','refused','unconfirmed')),
 run_id uuid unique,run_agent text generated always as('parikshan'::text)stored,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,task_expires_at timestamptz not null,
 handed_off_at timestamptz,reservation_receipt bigint not null,requested_receipt bigint,receipt_id bigint,result_digest text,
 unique(tenant_id,id),foreign key(tenant_id,scope_id)references controller_security.coverage175_scopes(tenant_id,id),foreign key(tenant_id,read_fire_id)references public.monitoring_read_dispatches(tenant_id,id),
 foreign key(tenant_id,engagement_id)references public.engagements(tenant_id,id),foreign key(tenant_id,run_id,run_agent)references public.agent_runs(tenant_id,id,agent),
 foreign key(tenant_id,reservation_receipt)references public.audit_ledger(tenant_id,id),foreign key(tenant_id,requested_receipt)references public.audit_ledger(tenant_id,id),foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '2 minutes'),check(task_expires_at>created_at and task_expires_at<=created_at+interval '5 minutes'),
 check((state not in('dispatched','finalized')or(run_id is not null and requested_receipt is not null))and(state not in('queued','handed_off')or run_id is null)),check((state='finalized')=(result_digest is not null)),check(result_digest is null or result_digest~'^[a-f0-9]{64}$')
);
-- Operational scheduling cursor only; no authority can be changed through it.
create table controller_security.coverage175_cursor(tenant_id uuid primary key references public.tenants(id),last_created_at timestamptz,last_scope_id uuid,check((last_created_at is null)=(last_scope_id is null)));
do $$declare n text;begin
 foreach n in array array['decisions','scopes','heads','revocations','fences','fires','cursor']loop
 execute format('revoke all on controller_security.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier','coverage175_'||n);
 if n in('heads','fires','cursor')then execute format('create trigger coverage175_no_delete before delete on controller_security.%I for each row execute function public.evidence_receipt_immutable()','coverage175_'||n);
 else execute format('create trigger coverage175_immutable before update or delete on controller_security.%I for each row execute function public.evidence_receipt_immutable()','coverage175_'||n);end if;
 execute format('create trigger coverage175_no_truncate before truncate on controller_security.%I for each statement execute function public.evidence_receipt_immutable()','coverage175_'||n);
 end loop;
end $$;

-- Existing database-clock MFA protocol, with its own fixed purpose and immutable factor/session/window pins.
create function public.issue_scheduled_coverage_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_ttl_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;d controller_security.coverage175_decisions;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'scheduled coverage MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'scheduled coverage MFA input refused' using errcode='22023';end if;

 if p_ttl_ms is null or p_ttl_ms not between 1 and 300000 then raise exception 'scheduled coverage MFA TTL refused' using errcode='22023';end if;

 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
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
 then raise exception 'scheduled coverage MFA scope refused' using errcode='42501';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,173));
 if exists(select 1 from controller_security.coverage175_fences where operation_key=p_operation_key) then raise exception 'scope request fenced' using errcode='42501';end if;
 select * into d from controller_security.coverage175_decisions where operation_key=p_operation_key;
 if d.operation_key is not null then
  if (d.tenant_id,d.actor_id,d.session_id,d.binding_sha256,d.factor_id) is distinct from(p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256,p_factor_id) then raise exception 'MFA decision conflict' using errcode='23505';end if;
  select * into c from public.mfa_challenges where id=d.challenge_id;
  return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
 end if;
 insert into public.mfa_challenges(user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at)
 values(p_actor_id,p_tenant_id,p_factor_id,'scheduled_coverage',p_operation_key::text,p_bound_payload_sha256,now_at,now_at+p_ttl_ms*interval '1 millisecond') returning * into c;
 insert into controller_security.coverage175_decisions(operation_key,tenant_id,actor_id,session_id,binding_sha256,challenge_id,factor_id,challenge_expires_at,created_at)values(p_operation_key,p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256,c.id,p_factor_id,c.expires_at,now_at);
 return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
end $$;
revoke all on function public.issue_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer)from public;
create function public.satisfy_scheduled_coverage_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_satisfied_with text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'scheduled coverage MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'scheduled coverage MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_satisfied_with is null or p_satisfied_with not in ('totp','recovery_code') then raise exception 'scheduled coverage MFA input refused' using errcode='22023';end if;

 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,173));
 if exists(select 1 from controller_security.coverage175_fences where operation_key=p_operation_key)
  or not exists(select 1 from controller_security.coverage175_decisions d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id and d.factor_id=p_factor_id)
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id and is_demo) or not(public.is_live_platform_founder(p_actor_id) or exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin','approver')))
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'scheduled coverage MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'scheduled_coverage'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or not exists(select 1 from controller_security.coverage175_decisions d where d.operation_key=p_operation_key and d.factor_id=c.factor_id and d.created_at=c.created_at and d.challenge_expires_at=c.expires_at)
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'scheduled coverage MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is not null or c.satisfied_with is not null then raise exception 'scheduled coverage MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set satisfied_at=now_at,satisfied_with=p_satisfied_with where id=c.id and attempts=p_expected_attempts and satisfied_at is null and consumed_at is null returning * into c;
 if not found then raise exception 'scheduled coverage MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'satisfied_with',c.satisfied_with);
end $$;
revoke all on function public.satisfy_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text)from public;
create function public.consume_scheduled_coverage_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_consumed_for uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'scheduled coverage MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'scheduled coverage MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_consumed_for is null or p_consumed_for is distinct from p_operation_key then raise exception 'scheduled coverage MFA input refused' using errcode='22023';end if;

 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,173));
 if exists(select 1 from controller_security.coverage175_fences where operation_key=p_operation_key)
  or not exists(select 1 from controller_security.coverage175_decisions d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id and d.factor_id=p_factor_id)
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id and is_demo) or not(public.is_live_platform_founder(p_actor_id) or exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in('owner','admin','approver')))
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'scheduled coverage MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'scheduled_coverage'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or not exists(select 1 from controller_security.coverage175_decisions d where d.operation_key=p_operation_key and d.factor_id=c.factor_id and d.created_at=c.created_at and d.challenge_expires_at=c.expires_at)
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'scheduled coverage MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is null or c.satisfied_with not in ('totp','recovery_code') or c.satisfied_with is null
  or c.satisfied_at<c.created_at or c.satisfied_at>now_at or c.satisfied_at<=now_at-interval '5 minutes'
 then raise exception 'scheduled coverage MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set consumed_at=now_at,consumed_for=p_consumed_for::text where id=c.id and attempts=p_expected_attempts and satisfied_at is not null and consumed_at is null returning * into c;
 if not found then raise exception 'scheduled coverage MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'expires_at',c.expires_at,'factor_id',c.factor_id);
end $$;
revoke all on function public.consume_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid)from public;
revoke all on function public.issue_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.issue_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.satisfy_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.satisfy_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) to service_role;
revoke all on function public.consume_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.consume_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;


-- Inherit bounded caller lock waits, including the private polling budget.
create function controller_security.coverage175_source(t uuid,read_scope uuid,baseline uuid,preflight uuid,workload uuid)returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare b public.monitoring_read_scopes;fire public.monitoring_read_dispatches;request public.postgresql_discovery_requests;discovery public.connector_discovery_runs;
 packet public.workload_assessment_packets;lib public.control_libraries;f jsonb;selection uuid;p public.local_custody_policy_versions;h public.local_custody_policy_heads;v jsonb;activation uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 b:=controller_security.scheduled_read171_scope(t,read_scope,true);
 if b.id is null then raise exception 'current scheduled read authority required'using errcode='42501';end if;
 select *into strict fire from public.monitoring_read_dispatches where tenant_id=t and id=preflight and scope_id=b.id for share;
 select *into strict request from public.postgresql_discovery_requests where tenant_id=t and id=fire.request_id for share;
 select *into strict discovery from public.connector_discovery_runs where tenant_id=t and id=request.discovery_run_id for share;
 if fire.state<>'confirmed'or fire.cleanup_confirmed is distinct from true or request.status<>'completed'or request.cleanup_confirmed is distinct from true
 or request.operation<>'enumerate'or request.connector_id<>b.connector_id or request.estate_id<>b.estate_id or request.engagement_id<>b.engagement_id
 then raise exception 'completed supervised technical preflight required'using errcode='42501';end if;
 select *into strict packet from public.workload_assessment_packets where tenant_id=t and run_id=baseline for share;
 if packet.finalized_receipt is null or packet.result_digest is null or not exists(select 1 from public.engagements where tenant_id=t and id=packet.engagement_id and estate_id=b.estate_id)
 then raise exception 'original finalized baseline required'using errcode='42501';end if;
 lock table public.control_libraries in share mode;
 select *into strict lib from public.control_libraries where is_current;
 f:=controller_security.catalogue161_fingerprint(lib.version);
 if not controller_security.catalogue_approved(lib.version,null)then raise exception 'approved current catalogue required'using errcode='42501';end if;
 select operation_key into selection from public.catalogue_current_version_events where library_version=lib.version order by recorded_at desc,operation_key desc limit 1;
 perform 1 from public.workload_identities where tenant_id=t and id=workload and agent_name='parikshan'and spiffe_id='spiffe://local.axiomproof.test/agent/parikshan'and status='active'for share;
 if not found then raise exception 'current existing Parikshan workload required'using errcode='42501';end if;
 select policy.*into strict p from public.local_custody_policy_versions policy join public.local_custody_policy_heads head on(head.tenant_id,head.policy_id)=(policy.tenant_id,policy.id)and head.state='active'
 where policy.tenant_id=t and policy.policy_text::jsonb->>'targetWorkloadId'=workload::text for share of policy;
 select *into strict h from public.local_custody_policy_heads where tenant_id=t and policy_id=p.id for share;
 v:=controller_security.local143_policy(p.policy_text);
 select id into strict activation from public.local_custody_policy_events where tenant_id=t and policy_id=p.id and transition='activate'and activation_epoch=h.activation_epoch;
 if not exists(select 1 from public.tenants where id=t and is_demo)or p.mode not in('local_demo','operator_managed')
 or not controller_security.local143_actor(t,p.nominated_operator_id,'activate',v)
 or not exists(select 1 from public.local_custody_policy_events where tenant_id=t and policy_id=p.id and transition='request'and controller_security.local143_actor(t,actor_id,'request',v))
 or not exists(select 1 from public.local_custody_policy_events where tenant_id=t and policy_id=p.id and transition='approve'and controller_security.local143_actor(t,actor_id,'approve',v))
 then raise exception 'current enrolled local synthetic custody required'using errcode='42501';end if;
 return jsonb_build_object('scheduleId',b.schedule_id,'readScopeId',b.id,'estateId',b.estate_id,'connectorId',b.connector_id,'grantId',b.grant_id,'configurationSha256',b.configuration_sha256,'cadence',b.cadence,
 'workloadId',workload,'custodyPolicyId',p.id,'custodyPolicySha256',p.policy_sha256,'keyPolicySha256',p.key_policy_sha256,'custodyActivationEventId',activation,'custodyEpoch',h.activation_epoch,'deploymentBindingSha256',v->>'deploymentBindingSha256',
 'baselineRunId',baseline,'baselineResultSha256',packet.result_digest,'preflightFireId',preflight,'preflightDiscoveryRequestId',request.id,'preflightDiscoveryId',discovery.id,
 'preflightResultSha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(discovery.result),'UTF8')),'hex'),
 'catalogue',jsonb_build_object('libraryVersion',lib.version,'rowsSha256',f->>'rowsHash','questionnaireDigest',f->>'questionnaireDigest','manifestSha256',f->>'manifestSha256','selectionOperationKey',selection));
end $$;
revoke all on function controller_security.coverage175_source(uuid,uuid,uuid,uuid,uuid)from public;
create function controller_security.coverage175_intent(text_value text)returns jsonb
language plpgsql immutable set search_path='' as $$declare v jsonb;q jsonb;keys text[];begin
 if text_value is null or octet_length(text_value)>20000 then raise exception 'bounded coverage intent required'using errcode='22023';end if;
 v:=text_value::jsonb;q:=v->'request';
 if controller_security.canonical_questionnaire_json(v)is distinct from text_value or jsonb_typeof(v)is distinct from'object'or not v?&array['phase','request']or v-array['phase','request']<>'{}'::jsonb
 or v->>'phase'is null or v->>'phase'not in('authorize','revoke')or jsonb_typeof(q)is distinct from'object' then raise exception 'canonical coverage intent required'using errcode='22023';end if;
 keys:=case when v->>'phase'='authorize'then array['schemaVersion','purpose','operationKey','tenantId','ownerId','previousScopeId','source','expiresAt','maxFires','taskScopes','declarationPolicy','discoveryUse','reason']else array['schemaVersion','operationKey','scopeId','requestSha256','reason']end;
 if not q?&keys or q-keys<>'{}'::jsonb or q->'schemaVersion'is distinct from'1'::jsonb or jsonb_typeof(q->'reason')is distinct from'string'or length(q->>'reason')not between 20 and 2000
 then raise exception 'exact coverage intent required'using errcode='22023';end if;
 if jsonb_typeof(q->'operationKey')is distinct from'string'or q->>'operationKey'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'then raise exception 'coverage operation UUID required'using errcode='22023';end if;
 if v->>'phase'='authorize'then
  if q->>'purpose'is distinct from'axiom.scheduled-coverage.authority.v1'or q->'taskScopes'is distinct from'["control_library.read","findings.write"]'::jsonb
  or q->>'declarationPolicy'is distinct from'all_business_facts_unknown'or q->>'discoveryUse'is distinct from'technical_provenance_only'
  or jsonb_typeof(q->'tenantId')is distinct from'string'or jsonb_typeof(q->'ownerId')is distinct from'string'or jsonb_typeof(q->'expiresAt')is distinct from'string'or jsonb_typeof(q->'maxFires')is distinct from'number'
  or q->>'maxFires'!~'^[1-9][0-9]?$'or(q->>'maxFires')::integer>24 then raise exception 'bounded unknown-only coverage authority required'using errcode='22023';end if;
 else perform(q->>'scopeId')::uuid;if q->>'requestSha256'!~'^[a-f0-9]{64}$'then raise exception 'exact coverage revision required'using errcode='22023';end if;end if;
 return v;
end $$;
revoke all on function controller_security.coverage175_intent(text)from public;
create function public.preflight_scheduled_coverage_scope(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare v jsonb;q jsonb;src jsonb;b public.monitoring_read_scopes;scope controller_security.coverage175_scopes;head uuid;begin
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 v:=controller_security.coverage175_intent(p_intent_text);q:=v->'request';
 if v->>'phase'='authorize'then
  src:=controller_security.coverage175_source(p_tenant_id,(q#>>'{source,readScopeId}')::uuid,(q#>>'{source,baselineRunId}')::uuid,(q#>>'{source,preflightFireId}')::uuid,(q#>>'{source,workloadId}')::uuid);
  b:=controller_security.scheduled_read171_scope(p_tenant_id,(src->>'readScopeId')::uuid,true);
  if q->'source'is distinct from src or(q->>'tenantId')::uuid<>p_tenant_id or(q->>'ownerId')::uuid<>p_actor_id or b.actor_id<>p_actor_id
  or(q->>'expiresAt')::timestamptz<=clock_timestamp()or(q->>'expiresAt')::timestamptz>least(clock_timestamp()+interval '1 hour',b.expires_at)
  then raise exception 'current exact owner coverage scope required'using errcode='42501';end if;
  select scope_id into head from controller_security.coverage175_heads where tenant_id=p_tenant_id and schedule_id=b.schedule_id for update;
  if head is distinct from(q->>'previousScopeId')::uuid then raise exception 'coverage scope superseded'using errcode='40001';end if;
 else
  select *into strict scope from controller_security.coverage175_scopes where tenant_id=p_tenant_id and id=(q->>'scopeId')::uuid for update;
  if scope.actor_id<>p_actor_id or scope.request_sha256 is distinct from q->>'requestSha256'then raise exception 'original owner coverage revision required'using errcode='42501';end if;
 end if;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,'phase',v->>'phase','intent',v,'requestSha256',encode(sha256(convert_to(p_intent_text,'UTF8')),'hex'));
end $$;
revoke all on function public.preflight_scheduled_coverage_scope(uuid,uuid,uuid,text)from public;
create function public.read_scheduled_coverage_scope_operation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare v jsonb;q jsonb;op uuid;digest text;scope controller_security.coverage175_scopes;rev controller_security.coverage175_revocations;fence controller_security.coverage175_fences;ch public.mfa_challenges;binding jsonb;begin
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);v:=controller_security.coverage175_intent(p_intent_text);q:=v->'request';op:=(q->>'operationKey')::uuid;digest:=encode(sha256(convert_to(p_intent_text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(op::text,175));
 binding:=jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'phase',v->>'phase','operationKey',op,'requestSha256',digest);
 if v->>'phase'='authorize'then
  select *into scope from controller_security.coverage175_scopes where id=op;
  if found then
   if(scope.tenant_id,scope.actor_id,scope.request_text)is distinct from(p_tenant_id,p_actor_id,p_intent_text)then raise exception 'coverage operation conflict'using errcode='23505';end if;
   return binding||jsonb_build_object('recorded',true,'scopeId',scope.id,'receiptId',scope.receipt_id::text,'revoked',exists(select 1 from controller_security.coverage175_revocations where scope_id=scope.id));
  end if;
 else
  select *into rev from controller_security.coverage175_revocations where operation_key=op;
  if found then
   if(rev.tenant_id,rev.actor_id,rev.request_text)is distinct from(p_tenant_id,p_actor_id,p_intent_text)then raise exception 'coverage operation conflict'using errcode='23505';end if;
   return binding||jsonb_build_object('recorded',true,'scopeId',rev.scope_id,'receiptId',rev.receipt_id::text,'revoked',true);
  end if;
 end if;
 select *into fence from controller_security.coverage175_fences where operation_key=op;
 if found then
  if(fence.tenant_id,fence.actor_id,fence.phase,fence.request_text)is distinct from(p_tenant_id,p_actor_id,v->>'phase',p_intent_text)then raise exception 'coverage fence conflict'using errcode='23505';end if;
  return binding||jsonb_build_object('recorded',false,'fenced',true,'fenceReceiptId',fence.receipt_id::text,'challengeExpiresAt',null);
 end if;
 select challenge.*into ch from public.mfa_challenges challenge join controller_security.coverage175_decisions decision on decision.challenge_id=challenge.id
 where decision.operation_key=op and decision.tenant_id=p_tenant_id and decision.actor_id=p_actor_id;
 return binding||jsonb_build_object('recorded',false,'fenced',false,'fenceReceiptId',null,'challengeExpiresAt',ch.expires_at);
end $$;
revoke all on function public.read_scheduled_coverage_scope_operation(uuid,uuid,uuid,text)from public;
create function controller_security.coverage175_mfa(t uuid,a uuid,s uuid,op uuid,phase text,digest text,challenge uuid,fresh boolean)returns void
language plpgsql volatile security definer set search_path='' as $$
declare d controller_security.coverage175_decisions;c public.mfa_challenges;binding text;begin
 select *into strict d from controller_security.coverage175_decisions where operation_key=op for share;
 select *into strict c from public.mfa_challenges where id=challenge for share;
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.scheduled-coverage.'||phase,1,t::text,a::text,s::text,digest)),'UTF8')),'hex');
 if(d.tenant_id,d.actor_id,d.session_id,d.challenge_id,d.binding_sha256)is distinct from(t,a,s,challenge,binding)
 or(c.user_id,c.tenant_id,c.factor_id,c.purpose::text,c.bound_resource_ref,c.bound_payload_sha256,c.consumed_for,c.created_at,c.expires_at)is distinct from(a,t,d.factor_id,'scheduled_coverage',op::text,binding,op::text,d.created_at,d.challenge_expires_at)
 or c.satisfied_at is null or c.consumed_at is null or c.satisfied_with is null or c.satisfied_with not in('totp','recovery_code')
 or c.satisfied_at<d.created_at or c.satisfied_at>c.consumed_at or c.consumed_at>=d.challenge_expires_at or c.consumed_at>clock_timestamp()
 or(fresh and d.challenge_expires_at<=clock_timestamp())
 or not exists(select 1 from public.user_mfa_factors where id=d.factor_id and user_id=a and factor_type='totp'and status='active'and revoked_at is null)
 then raise exception 'immutable original coverage MFA proof refused'using errcode='42501';end if;
end $$;
revoke all on function controller_security.coverage175_mfa(uuid,uuid,uuid,uuid,text,text,uuid,boolean)from public;
create function public.record_scheduled_coverage_scope(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text,p_challenge_id uuid)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare previous jsonb;v jsonb;q jsonb;op uuid;digest text;receipt bigint;begin
 if current_setting('role',true)is distinct from 'human_action_writer'then raise exception 'human coverage writer required'using errcode='42501';end if;
 previous:=public.read_scheduled_coverage_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 if(previous->>'recorded')::boolean or(previous->>'fenced')::boolean then return previous;end if;
 perform public.preflight_scheduled_coverage_scope(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 v:=controller_security.coverage175_intent(p_intent_text);q:=v->'request';op:=(q->>'operationKey')::uuid;digest:=encode(sha256(convert_to(p_intent_text,'UTF8')),'hex');
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp'order by id for update;
 perform controller_security.coverage175_mfa(p_tenant_id,p_actor_id,p_session_id,op,v->>'phase',digest,p_challenge_id,true);
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'connector.updated',op::text,digest,null,null,null,null,null,'success',
 jsonb_build_object('phase','scheduled_coverage_'||(v->>'phase'),'scope',q,'declarationPolicy','all_business_facts_unknown','executionAuthorized',false));
 if v->>'phase'='authorize'then
  insert into controller_security.coverage175_scopes(id,tenant_id,schedule_id,actor_id,session_id,request_text,request_sha256,source,challenge_id,receipt_id,previous_scope_id,max_fires,expires_at)
  values(op,p_tenant_id,(q#>>'{source,scheduleId}')::uuid,p_actor_id,p_session_id,p_intent_text,digest,q->'source',p_challenge_id,receipt,(q->>'previousScopeId')::uuid,(q->>'maxFires')::integer,(q->>'expiresAt')::timestamptz);
  insert into controller_security.coverage175_heads(schedule_id,tenant_id,scope_id)values((q#>>'{source,scheduleId}')::uuid,p_tenant_id,op)
  on conflict(schedule_id)do update set scope_id=excluded.scope_id where coverage175_heads.scope_id is not distinct from(q->>'previousScopeId')::uuid;
  if not found then raise exception 'coverage head changed'using errcode='40001';end if;
 else
  insert into controller_security.coverage175_revocations(operation_key,tenant_id,scope_id,actor_id,session_id,request_text,request_sha256,challenge_id,receipt_id)
  values(op,p_tenant_id,(q->>'scopeId')::uuid,p_actor_id,p_session_id,p_intent_text,digest,p_challenge_id,receipt);
 end if;
 perform controller_security.coverage175_mfa(p_tenant_id,p_actor_id,p_session_id,op,v->>'phase',digest,p_challenge_id,true);
 if v->>'phase'='authorize'and(q->>'expiresAt')::timestamptz<=clock_timestamp()then raise exception 'coverage scope expired during recording'using errcode='42501';end if;
 return public.read_scheduled_coverage_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
end $$;
revoke all on function public.record_scheduled_coverage_scope(uuid,uuid,uuid,text,uuid)from public;
create function public.fence_scheduled_coverage_scope(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare original jsonb;v jsonb;q jsonb;op uuid;digest text;receipt bigint;begin
 if current_setting('role',true)is distinct from 'human_action_writer'then raise exception 'human coverage writer required'using errcode='42501';end if;
 original:=public.read_scheduled_coverage_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 if(original->>'recorded')::boolean or(original->>'fenced')::boolean then return original;end if;
 v:=controller_security.coverage175_intent(p_intent_text);q:=v->'request';op:=(q->>'operationKey')::uuid;digest:=encode(sha256(convert_to(p_intent_text,'UTF8')),'hex');
 if v->>'phase'='authorize'and((q->>'tenantId')::uuid<>p_tenant_id or(q->>'ownerId')::uuid<>p_actor_id)then raise exception 'original owner coverage operation required'using errcode='42501';end if;
 if v->>'phase'='revoke'and not exists(select 1 from controller_security.coverage175_scopes where tenant_id=p_tenant_id and id=(q->>'scopeId')::uuid and actor_id=p_actor_id and request_sha256=q->>'requestSha256')then raise exception 'original owner coverage revision required'using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'connector.updated',op::text,digest,null,null,null,null,null,'success',jsonb_build_object('phase','scheduled_coverage_intent_fenced','intentPhase',v->>'phase'));
 insert into controller_security.coverage175_fences(operation_key,tenant_id,actor_id,session_id,phase,request_text,request_sha256,receipt_id)values(op,p_tenant_id,p_actor_id,p_session_id,v->>'phase',p_intent_text,digest,receipt);
 return public.read_scheduled_coverage_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
end $$;
revoke all on function public.fence_scheduled_coverage_scope(uuid,uuid,uuid,text)from public;
create function controller_security.coverage175_live(t uuid,scope_id uuid)returns controller_security.coverage175_scopes
language plpgsql volatile security definer set search_path='' as $$declare scope controller_security.coverage175_scopes;src jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 select *into strict scope from controller_security.coverage175_scopes where tenant_id=t and id=scope_id for share;
 if scope.expires_at<=clock_timestamp()or exists(select 1 from controller_security.coverage175_revocations where tenant_id=t and coverage175_revocations.scope_id=scope.id)
 or not exists(select 1 from controller_security.coverage175_heads where tenant_id=t and schedule_id=scope.schedule_id and coverage175_heads.scope_id=scope.id)
 then raise exception 'coverage revision expired revoked or superseded'using errcode='42501';end if;
 -- Reading recorded session authority does not impersonate its transport/bearer.
 perform controller_security.scheduled_read171_owner(t,scope.actor_id,scope.session_id);
 perform 1 from public.user_mfa_factors where user_id=scope.actor_id and factor_type='totp'order by id for share;
 perform controller_security.coverage175_mfa(t,scope.actor_id,scope.session_id,scope.id,'authorize',scope.request_sha256,scope.challenge_id,false);
 src:=controller_security.coverage175_source(t,(scope.source->>'readScopeId')::uuid,(scope.source->>'baselineRunId')::uuid,(scope.source->>'preflightFireId')::uuid,(scope.source->>'workloadId')::uuid);
 if src is distinct from scope.source or scope.expires_at<=clock_timestamp()then raise exception 'coverage source or expiry changed'using errcode='42501';end if;
 return scope;
end $$;
revoke all on function controller_security.coverage175_live(uuid,uuid)from public;
create function controller_security.coverage175_fire_guard()returns trigger language plpgsql set search_path=''as $$begin
 if(new.id,new.tenant_id,new.scope_id,new.read_fire_id,new.discovery_request_id,new.discovery_id,new.discovery_result_sha256,new.discovery_completed_at,new.engagement_id,new.job_id,new.input_text,new.input_sha256,new.created_at,new.expires_at,new.task_expires_at,new.reservation_receipt)
 is distinct from(old.id,old.tenant_id,old.scope_id,old.read_fire_id,old.discovery_request_id,old.discovery_id,old.discovery_result_sha256,old.discovery_completed_at,old.engagement_id,old.job_id,old.input_text,old.input_sha256,old.created_at,old.expires_at,old.task_expires_at,old.reservation_receipt)
 or not((old.state='queued'and new.state in('handed_off','refused'))or(old.state='handed_off'and new.state in('dispatched','unconfirmed','refused'))or(old.state='dispatched'and new.state in('finalized','unconfirmed'))or(old.state='unconfirmed'and new.state='finalized'))
 or(old.run_id is not null and(new.run_id,new.requested_receipt)is distinct from(old.run_id,old.requested_receipt))
 then raise exception 'coverage fire history immutable'using errcode='23514';end if;return new;
end $$;
revoke all on function controller_security.coverage175_fire_guard()from public;
create trigger coverage175_fire_transition before update on controller_security.coverage175_fires for each row execute function controller_security.coverage175_fire_guard();
create function controller_security.coverage175_fire_live(t uuid,fire_id uuid)returns controller_security.coverage175_fires
language plpgsql volatile security definer set search_path=''as $$
declare fire controller_security.coverage175_fires;scope controller_security.coverage175_scopes;read_fire public.monitoring_read_dispatches;request public.postgresql_discovery_requests;discovery public.connector_discovery_runs;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 select *into strict fire from controller_security.coverage175_fires where tenant_id=t and id=fire_id for update;
 scope:=controller_security.coverage175_live(t,fire.scope_id);
 select *into strict read_fire from public.monitoring_read_dispatches where tenant_id=t and id=fire.read_fire_id for share;
 select *into strict request from public.postgresql_discovery_requests where tenant_id=t and id=fire.discovery_request_id for share;
 select *into strict discovery from public.connector_discovery_runs where tenant_id=t and id=fire.discovery_id for share;
 if read_fire.state<>'confirmed'or read_fire.cleanup_confirmed is distinct from true or read_fire.request_id<>request.id or read_fire.scope_id<>(scope.source->>'readScopeId')::uuid
 or request.status<>'completed'or request.cleanup_confirmed is distinct from true or request.operation<>'enumerate'or request.discovery_run_id<>discovery.id
 or request.connector_id<>(scope.source->>'connectorId')::uuid or request.estate_id<>(scope.source->>'estateId')::uuid
 or fire.discovery_result_sha256<>encode(sha256(convert_to(controller_security.canonical_questionnaire_json(discovery.result),'UTF8')),'hex')
 or fire.task_expires_at<=clock_timestamp()or scope.expires_at<=clock_timestamp()
 or not exists(select 1 from public.engagements where tenant_id=t and id=fire.engagement_id and estate_id=(scope.source->>'estateId')::uuid and library_version=scope.source#>>'{catalogue,libraryVersion}'and status<>'cancelled')
 then raise exception 'frozen scheduled coverage source is no longer current'using errcode='42501';end if;
 return fire;
end $$;
revoke all on function controller_security.coverage175_fire_live(uuid,uuid)from public;
create function controller_security.coverage175_outcome(t uuid,fire_id uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $$declare f controller_security.coverage175_fires;begin
 select *into strict f from controller_security.coverage175_fires where tenant_id=t and id=fire_id;
 return jsonb_build_object('tenantId',t,'fireId',f.id,'state',f.state,'engagementId',f.engagement_id,'jobId',f.job_id,'runId',f.run_id,'receiptId',f.receipt_id::text,'resultDigest',f.result_digest);
end $$;
revoke all on function controller_security.coverage175_outcome(uuid,uuid)from public;
create function public.read_scheduled_coverage_fire(p_tenant_id uuid,p_fire_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare f controller_security.coverage175_fires;packet public.workload_assessment_packets;receipt bigint;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private coverage coordinator required'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 select *into strict f from controller_security.coverage175_fires where tenant_id=p_tenant_id and id=p_fire_id for update;
 if f.state in('queued','handed_off')and f.expires_at<=clock_timestamp()then
  receipt:=public.append_ledger(p_tenant_id,f.id,'agent','scheduled-coverage-coordinator',null,null,null,'connector.updated',f.id::text,null,null,null,null,null,null,'failure',jsonb_build_object('phase','scheduled_coverage_handoff_expired','relaunchPermitted',false,'priorState',f.state));
  update controller_security.coverage175_fires set state=case when f.state='queued'then'refused'else'unconfirmed'end,receipt_id=receipt where id=f.id;
 elsif f.state in('dispatched','unconfirmed')and f.run_id is not null then
  select *into packet from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=f.run_id;
  if packet.finalized_receipt is not null and packet.result_digest is not null then
   update controller_security.coverage175_fires set state='finalized',receipt_id=packet.finalized_receipt,result_digest=packet.result_digest where id=f.id;
  elsif f.state='dispatched'and f.task_expires_at<=clock_timestamp()then
   receipt:=public.append_ledger(p_tenant_id,f.id,'agent','scheduled-coverage-coordinator',null,null,null,'connector.updated',f.id::text,null,null,null,null,null,null,'failure',jsonb_build_object('phase','scheduled_coverage_result_unconfirmed','relaunchPermitted',false,'originalRunId',f.run_id));
   update controller_security.coverage175_fires set state='unconfirmed',receipt_id=receipt where id=f.id;
  end if;
 end if;
 -- Historical original readback does not revive expired/revoked task authority.
 return controller_security.coverage175_outcome(p_tenant_id,f.id);
end $$;
revoke all on function public.read_scheduled_coverage_fire(uuid,uuid)from public;
create function public.reserve_scheduled_coverage_fire(p_tenant_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;read_fire public.monitoring_read_dispatches;request public.postgresql_discovery_requests;discovery public.connector_discovery_runs;
 cursor_at timestamptz;cursor_id uuid;deadline timestamptz;prior_timeout text;fire_id uuid;engagement_id uuid;job_id uuid;input_text text;input_sha text;receipt bigint;task_until timestamptz;
begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private coverage coordinator required'using errcode='42501';end if;
 perform pg_advisory_xact_lock(175,hashtext(p_tenant_id::text));
 select *into f from controller_security.coverage175_fires where tenant_id=p_tenant_id and state in('queued','handed_off','dispatched')order by created_at,id limit 1;
 if f.id is not null then
  perform public.read_scheduled_coverage_fire(p_tenant_id,f.id);
  if exists(select 1 from controller_security.coverage175_fires where id=f.id and state in('queued','handed_off'))then return jsonb_build_object('fires',jsonb_build_array(jsonb_build_object('tenantId',p_tenant_id,'fireId',f.id)));end if;
  if exists(select 1 from controller_security.coverage175_fires where id=f.id and state='dispatched')then return jsonb_build_object('fires','[]'::jsonb);end if;
 end if;
 insert into controller_security.coverage175_cursor values(p_tenant_id,null,null)on conflict(tenant_id)do nothing;
 select last_created_at,last_scope_id into strict cursor_at,cursor_id from controller_security.coverage175_cursor where tenant_id=p_tenant_id;
 deadline:=clock_timestamp()+interval '2 seconds';prior_timeout:=current_setting('lock_timeout');
 for s in select scope.*from controller_security.coverage175_scopes scope join controller_security.coverage175_heads head on(head.tenant_id,head.scope_id)=(scope.tenant_id,scope.id)
 where scope.tenant_id=p_tenant_id and scope.expires_at>clock_timestamp()and not exists(select 1 from controller_security.coverage175_revocations where scope_id=scope.id)
 and not exists(select 1 from controller_security.coverage175_fires where scope_id=scope.id and state='unconfirmed')
 and(select count(*)from controller_security.coverage175_fires where scope_id=scope.id)<scope.max_fires
 order by case when cursor_at is null or(scope.created_at,scope.id)>(cursor_at,cursor_id)then 0 else 1 end,scope.created_at,scope.id limit 32 loop
  exit when clock_timestamp()>=deadline;
  update controller_security.coverage175_cursor set last_created_at=s.created_at,last_scope_id=s.id where tenant_id=p_tenant_id;
  begin
   perform set_config('lock_timeout','50ms',true);perform controller_security.coverage175_live(p_tenant_id,s.id);
  if clock_timestamp()>=deadline then raise exception 'bounded coverage scan elapsed'using errcode='P0175';end if;
  select read.*into read_fire from public.monitoring_read_dispatches read where read.tenant_id=p_tenant_id and read.scope_id=(s.source->>'readScopeId')::uuid
  and read.state='confirmed'and read.cleanup_confirmed and read.finished_at>=s.created_at
  and not exists(select 1 from controller_security.coverage175_fires where read_fire_id=read.id)
  order by read.finished_at,read.id limit 1;
  if read_fire.id is null then perform set_config('lock_timeout',prior_timeout,true);continue;end if;
  select *into strict request from public.postgresql_discovery_requests where tenant_id=p_tenant_id and id=read_fire.request_id for share;
  select *into strict discovery from public.connector_discovery_runs where tenant_id=p_tenant_id and id=request.discovery_run_id for share;
  if request.status<>'completed'or request.cleanup_confirmed is distinct from true or request.operation<>'enumerate'or request.connector_id<>(s.source->>'connectorId')::uuid
  or request.estate_id<>(s.source->>'estateId')::uuid or request.completed_at<clock_timestamp()-interval '5 minutes'then perform set_config('lock_timeout',prior_timeout,true);continue;end if;
  fire_id:=gen_random_uuid();engagement_id:=gen_random_uuid();job_id:=gen_random_uuid();task_until:=least(clock_timestamp()+interval '5 minutes',s.expires_at);
  insert into public.engagements(id,tenant_id,estate_id,library_version,title,lead_reviewer_id,status)
  values(engagement_id,p_tenant_id,(s.source->>'estateId')::uuid,s.source#>>'{catalogue,libraryVersion}','Scheduled coverage reassessment — business facts unknown',s.actor_id,'intake');
  input_text:=controller_security.canonical_questionnaire_json(jsonb_build_object('tenant_id',p_tenant_id,'engagement_id',engagement_id,'library_version',s.source#>>'{catalogue,libraryVersion}',
  'answers','{}'::jsonb,'sdf_self_attested',null,'processes_children',null,'processes_health',null));input_sha:=encode(sha256(convert_to(input_text,'UTF8')),'hex');
  receipt:=public.append_ledger(p_tenant_id,fire_id,'agent','scheduled-coverage-coordinator',null,null,null,'connector.updated',fire_id::text,input_sha,null,null,null,null,null,'pending',
  jsonb_build_object('phase','scheduled_coverage_reserved','scopeId',s.id,'ownerApprovalReceipt',s.receipt_id::text,'engagementId',engagement_id,'baselineRunId',s.source->>'baselineRunId','discoveryFireId',read_fire.id,'discoveryId',discovery.id,'discoveryUse','technical_provenance_only','businessFacts','unknown','relaunchPermitted',false));
  insert into controller_security.coverage175_fires(id,tenant_id,scope_id,read_fire_id,discovery_request_id,discovery_id,discovery_result_sha256,discovery_completed_at,engagement_id,job_id,input_text,input_sha256,expires_at,task_expires_at,reservation_receipt)
  values(fire_id,p_tenant_id,s.id,read_fire.id,request.id,discovery.id,encode(sha256(convert_to(controller_security.canonical_questionnaire_json(discovery.result),'UTF8')),'hex'),request.completed_at,engagement_id,job_id,input_text,input_sha,least(clock_timestamp()+interval '2 minutes',s.expires_at),task_until,receipt);
  perform controller_security.coverage175_fire_live(p_tenant_id,fire_id);
  if clock_timestamp()>=deadline then raise exception 'bounded coverage scan elapsed'using errcode='P0175';end if;
  perform set_config('lock_timeout',prior_timeout,true);
  return jsonb_build_object('fires',jsonb_build_array(jsonb_build_object('tenantId',p_tenant_id,'fireId',fire_id)));
  exception when insufficient_privilege or no_data_found or lock_not_available or sqlstate 'P0175'then perform set_config('lock_timeout',prior_timeout,true);continue;end;
 end loop;
 return jsonb_build_object('fires','[]'::jsonb);
end $$;
revoke all on function public.reserve_scheduled_coverage_fire(uuid)from public;
create function public.claim_scheduled_coverage_fire(p_tenant_id uuid,p_fire_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private coverage producer required'using errcode='42501';end if;
 perform public.read_scheduled_coverage_fire(p_tenant_id,p_fire_id);
 select *into strict f from controller_security.coverage175_fires where tenant_id=p_tenant_id and id=p_fire_id for update;
 if f.state<>'queued'then return controller_security.coverage175_outcome(p_tenant_id,p_fire_id);end if;
 f:=controller_security.coverage175_fire_live(p_tenant_id,p_fire_id);
 select *into strict s from controller_security.coverage175_scopes where id=f.scope_id and tenant_id=p_tenant_id;
 update controller_security.coverage175_fires set state='handed_off',handed_off_at=clock_timestamp()where id=f.id;
 return jsonb_build_object('tenantId',p_tenant_id,'fireId',f.id,'state','runnable','ownerId',s.actor_id,'scopeId',s.id,'scopeReceiptId',s.receipt_id::text,'source',s.source,
 'discoveryFireId',f.read_fire_id,'discoveryRequestId',f.discovery_request_id,'discoveryId',f.discovery_id,'discoveryResultSha256',f.discovery_result_sha256,'discoveryCompletedAt',to_char(f.discovery_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'engagementId',f.engagement_id,'jobId',f.job_id,'expiresAt',to_char(f.task_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'inputText',f.input_text,'inputSha256',f.input_sha256);
end $$;
revoke all on function public.claim_scheduled_coverage_fire(uuid,uuid)from public;

-- Fixed private copies preserve the original interactive kernels byte-for-byte
-- apart from exact175 binding and delegation/ledger agent attribution. No caller
-- principal can invoke these generic signatures; only the fixed wrapper below.
create function controller_security.coverage175_task_binding(fire uuid,t uuid,actor uuid,workload uuid,agent text,estate uuid,engagement uuid,correlation uuid,input_sha text,scopes text[],expires timestamptz)returns void
language plpgsql volatile security definer set search_path=''as $$declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private coverage producer required'using errcode='42501';end if;
 f:=controller_security.coverage175_fire_live(t,fire);select *into strict s from controller_security.coverage175_scopes where tenant_id=t and id=f.scope_id;
 if f.state<>'handed_off'or f.expires_at<=clock_timestamp()or(actor,workload,agent,estate,engagement,correlation,input_sha,scopes,expires)is distinct from
 (s.actor_id,(s.source->>'workloadId')::uuid,'parikshan',(s.source->>'estateId')::uuid,f.engagement_id,f.job_id,f.input_sha256,array['control_library.read','findings.write'],f.task_expires_at)
 then raise exception 'exact original coverage task required'using errcode='42501';end if;
end $$;
revoke all on function controller_security.coverage175_task_binding(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,text,text[],timestamptz)from public;
create function controller_security.coverage175_delegate(
 p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_agent text,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_scopes text[],p_expires_at timestamptz,p_fire_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare run public.agent_runs; task public.workload_task_delegations; engagement public.engagements;
begin
 perform controller_security.coverage175_task_binding(p_fire_id,p_tenant_id,p_actor_id,p_workload_id,p_agent,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_scopes,p_expires_at);
 -- Karya needs the future execution-specific issuance path backed by reviewed
 -- approval/dry-run/rollback. Generic agent invocation cannot delegate it.
 if p_agent is null or p_agent='karya' or not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,p_agent)
 then return jsonb_build_object('error','forbidden'); end if;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,p_agent) then return jsonb_build_object('error','forbidden'); end if;
 if p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '15 minutes'
   or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
   or p_proof_hash is null or p_proof_hash !~ '^[a-f0-9]{64}$' or p_correlation_id is null
   or p_scopes is null or cardinality(p_scopes)>32 or coalesce(array_ndims(p_scopes),1)<>1
   or exists(select 1 from unnest(p_scopes) s where s is null or s !~ '^[a-z][a-z0-9_.]{0,99}$')
   or cardinality(p_scopes)<>(select count(distinct s) from unnest(p_scopes) s)
 then return jsonb_build_object('error','invalid_delegation'); end if;
 if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
   or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then return jsonb_build_object('error','halted'); end if;
 -- Order: membership -> user -> estate -> engagement -> workload -> task/run.
 -- Future mutation RPCs must preserve this order. Reads are fresh snapshots;
 -- they are not a lock spanning external side effects.
 if p_estate_id is not null then
  perform 1 from public.estates where tenant_id=p_tenant_id and id=p_estate_id and status='active' for share;
  if not found then return jsonb_build_object('error','context_refused'); end if;
 end if;
 if p_engagement_id is not null then
  select * into engagement from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for share;
  if not found or engagement.estate_id is distinct from p_estate_id or engagement.status='cancelled'
  then return jsonb_build_object('error','context_refused'); end if;
 end if;
 perform 1 from public.workload_identities where tenant_id=p_tenant_id and id=p_workload_id and agent_name=p_agent and status='active' for share;
 if not found then return jsonb_build_object('error','workload_refused'); end if;
 insert into public.agent_runs(tenant_id,agent,engagement_id,correlation_id,status,input_redacted_hash,metadata)
 values(p_tenant_id,p_agent,p_engagement_id,p_correlation_id,'queued',p_input_hash,jsonb_build_object('requested_by',p_actor_id,'delegated',true)) returning * into run;
 insert into public.workload_task_delegations(run_id,tenant_id,workload_identity_id,agent_name,created_by,
  estate_id,engagement_id,correlation_id,input_hash,proof_hash,scopes,expires_at)
 values(run.id,p_tenant_id,p_workload_id,p_agent,p_actor_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_proof_hash,p_scopes,p_expires_at)
 returning * into task;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'agent','scheduled-coverage-coordinator',null,null,null,
  'workload.task_delegated',run.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('workload_id',p_workload_id,'agent',p_agent,'estate_id',p_estate_id,'engagement_id',p_engagement_id,'scopes',p_scopes,'expires_at',p_expires_at));
 return jsonb_build_object('run_id',run.id,'expires_at',task.expires_at);
end $$;
revoke all on function controller_security.coverage175_delegate(uuid,uuid,uuid,text,uuid,uuid,uuid,text,text,text[],timestamptz,uuid)from public;
create function controller_security.coverage175_enqueue_core(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,p_fire_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.assessment_dispatch_jobs; delegated jsonb; task public.workload_task_delegations;
begin
 perform controller_security.coverage175_task_binding(p_fire_id,p_tenant_id,p_actor_id,p_workload_id,'parikshan',p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,array['control_library.read','findings.write'],p_expires_at);
 if p_job_id is null or p_engagement_id is null then return jsonb_build_object('error','invalid_dispatch'); end if;
 -- Same request serializes before delegation; no second task/audit on retries.
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan')
 then return jsonb_build_object('error','forbidden'); end if;
 select * into job from public.assessment_dispatch_jobs where id=p_job_id;
 if found then
  if job.tenant_id is distinct from p_tenant_id or job.actor_id is distinct from p_actor_id
   or job.workload_id is distinct from p_workload_id or job.estate_id is distinct from p_estate_id
   or job.engagement_id is distinct from p_engagement_id or job.correlation_id is distinct from p_correlation_id
   or job.input_hash is distinct from p_input_hash
  then return jsonb_build_object('error','dispatch_conflict'); end if;
  -- Returning an existing receipt does not revive an expired/revoked task.
  select * into task from public.workload_task_delegations where run_id=job.run_id;
  return jsonb_build_object('job_id',job.id,'run_id',job.run_id,'expires_at',task.expires_at);
 end if;
 delegated:=controller_security.coverage175_delegate(p_tenant_id,p_actor_id,p_workload_id,'parikshan',p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_proof_hash,array['control_library.read','findings.write'],p_expires_at,p_fire_id);
 if delegated ? 'error' then return delegated; end if;
 -- Constraint/audit failure rolls the entire delegation+outbox transaction back.
 insert into public.assessment_dispatch_jobs(id,tenant_id,run_id,actor_id,workload_id,estate_id,engagement_id,
  correlation_id,input_hash,key_ref,nonce,ciphertext,wrapped_key)
 values(p_job_id,p_tenant_id,(delegated->>'run_id')::uuid,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key);
 if p_expires_at<=clock_timestamp() then raise exception 'task_expired' using errcode='42501'; end if;
 return jsonb_build_object('job_id',p_job_id,'run_id',delegated->>'run_id','expires_at',delegated->>'expires_at');
end $$;
revoke all on function controller_security.coverage175_enqueue_core(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,uuid)from public;
create function public.enqueue_scheduled_coverage_dispatch(p_tenant_id uuid,p_fire_id uuid,p_proof_hash text,p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea)returns jsonb
language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;reply jsonb;requested bigint;g public.assessment_local_custody_authorizations;context_text text;begin
 if current_setting('role',true)is distinct from 'agent_ledger_writer'then raise exception 'private scheduled coverage producer required'using errcode='42501';end if;
 perform public.read_scheduled_coverage_fire(p_tenant_id,p_fire_id);
 select *into strict f from controller_security.coverage175_fires where tenant_id=p_tenant_id and id=p_fire_id for update;
 if f.state<>'handed_off'then return controller_security.coverage175_outcome(p_tenant_id,p_fire_id);end if;
 f:=controller_security.coverage175_fire_live(p_tenant_id,p_fire_id);select *into strict s from controller_security.coverage175_scopes where tenant_id=p_tenant_id and id=f.scope_id;
 if f.expires_at<=clock_timestamp()or p_key_ref is distinct from(select policy_text::jsonb#>>'{keyPolicy,primary}'from public.local_custody_policy_versions where tenant_id=p_tenant_id and id=(s.source->>'custodyPolicyId')::uuid)
 then raise exception 'current exact custody wrapping required'using errcode='42501';end if;
 reply:=controller_security.coverage175_enqueue_core(f.job_id,p_tenant_id,s.actor_id,(s.source->>'workloadId')::uuid,(s.source->>'estateId')::uuid,f.engagement_id,f.job_id,f.input_sha256,p_proof_hash,f.task_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,f.id);
 if reply?'error'then raise exception 'scheduled coverage dispatch refused'using errcode='42501';end if;
 requested:=public.append_ledger(p_tenant_id,f.job_id,'agent','scheduled-coverage-coordinator',null,null,null,'assessment.requested',f.job_id::text,f.input_sha256,null,null,null,null,null,'pending',
 jsonb_build_object('purpose','scheduled_coverage_reassessment_v1','job_id',f.job_id,'run_id',reply->>'run_id','workload_id',s.source->>'workloadId','estate_id',s.source->>'estateId','engagement_id',f.engagement_id,
 'library_version',s.source#>>'{catalogue,libraryVersion}','custody_policy_id',s.source->>'custodyPolicyId','custody_policy_sha256',s.source->>'custodyPolicySha256',
 'scopeId',s.id,'ownerApprovalReceipt',s.receipt_id::text,'fireId',f.id,'discoveryId',f.discovery_id,'discoveryResultSha256',f.discovery_result_sha256,'declarationPolicy','all_business_facts_unknown','discoveryUse','technical_provenance_only'));
 update public.agent_runs set metadata=metadata||jsonb_build_object('assessment_request_receipt',requested::text,'request_kind','scheduled_coverage_reassessment_v1','scheduled_coverage_scope_id',s.id,'scheduled_coverage_fire_id',f.id,'delegated_by',s.actor_id)
 where tenant_id=p_tenant_id and id=(reply->>'run_id')::uuid;
 update controller_security.coverage175_fires set state='dispatched',run_id=(reply->>'run_id')::uuid,requested_receipt=requested,receipt_id=requested where id=f.id;
 g.tenant_id:=p_tenant_id;g.job_id:=f.job_id;g.policy_id:=(s.source->>'custodyPolicyId')::uuid;g.activation_event_id:=(s.source->>'custodyActivationEventId')::uuid;g.activation_epoch:=(s.source->>'custodyEpoch')::bigint;g.request_receipt_id:=requested;g.original_expires_at:=f.task_expires_at;
 context_text:=controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.assessment.dispatch.dek',1,f.job_id,p_tenant_id,s.actor_id,(s.source->>'workloadId')::uuid,(s.source->>'estateId')::uuid,f.engagement_id,f.job_id,f.input_sha256));g.context_sha256:=encode(sha256(convert_to(context_text,'UTF8')),'hex');
 g.grant_text:=controller_security.canonical_questionnaire_json(controller_security.local143_job_grant(g));g.grant_sha256:=encode(sha256(convert_to(g.grant_text,'UTF8')),'hex');
 insert into public.assessment_local_custody_authorizations select(g).*;
 perform controller_security.coverage175_fire_live(p_tenant_id,f.id);
 if f.expires_at<=clock_timestamp()then raise exception 'scheduled coverage handoff expired during dispatch'using errcode='42501';end if;
 return controller_security.coverage175_outcome(p_tenant_id,f.id);
end $$;
revoke all on function public.enqueue_scheduled_coverage_dispatch(uuid,uuid,text,text,bytea,bytea,bytea)from public;
-- Only actual175 rows can take this fixed attribution alternative. Every
-- original context/custody/task/receipt condition in the143 trigger remains.
create function controller_security.coverage175_request_actor(job public.assessment_dispatch_jobs,entry public.audit_ledger)returns boolean
language sql stable security definer set search_path=''as $$
 select entry.actor_type::text='agent'and entry.actor_id='scheduled-coverage-coordinator'and entry.action_type::text='assessment.requested'and entry.target_ref=job.id::text and entry.correlation_id=job.correlation_id and entry.input_hash=job.input_hash and entry.output_hash is null and entry.result::text='pending'and entry.detail->>'purpose'='scheduled_coverage_reassessment_v1'
 and exists(select 1 from controller_security.coverage175_fires fire join controller_security.coverage175_scopes scope on(scope.tenant_id,scope.id)=(fire.tenant_id,fire.scope_id)
 where(fire.tenant_id,fire.job_id,fire.run_id,fire.engagement_id,fire.input_sha256,fire.requested_receipt,scope.actor_id)=(job.tenant_id,job.id,job.run_id,job.engagement_id,job.input_hash,entry.id,job.actor_id)
 and fire.run_id is not null and entry.detail->>'scopeId'=scope.id::text and entry.detail->>'fireId'=fire.id::text and entry.detail->>'ownerApprovalReceipt'=scope.receipt_id::text
 and entry.detail->>'discoveryId'=fire.discovery_id::text and entry.detail->>'discoveryResultSha256'=fire.discovery_result_sha256)
$$;
revoke all on function controller_security.coverage175_request_actor(public.assessment_dispatch_jobs,public.audit_ledger)from public;

create or replace function controller_security.local143_grant_binding() returns trigger language plpgsql security definer set search_path='' as $$
declare j public.assessment_dispatch_jobs;t public.workload_task_delegations;e public.local_custody_policy_events;p public.local_custody_policy_versions;l public.audit_ledger;g jsonb;context text;
begin
 select * into j from public.assessment_dispatch_jobs where id=new.job_id and tenant_id=new.tenant_id;
 select * into t from public.workload_task_delegations where run_id=j.run_id and tenant_id=new.tenant_id;
 select * into e from public.local_custody_policy_events where tenant_id=new.tenant_id and id=new.activation_event_id and policy_id=new.policy_id and transition='activate';
 select * into p from public.local_custody_policy_versions where tenant_id=new.tenant_id and id=new.policy_id;
 select * into l from public.audit_ledger where tenant_id=new.tenant_id and id=new.request_receipt_id;
 context:=controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.assessment.dispatch.dek',1,j.id,j.tenant_id,j.actor_id,j.workload_id,j.estate_id,j.engagement_id,j.correlation_id,j.input_hash));
 g:=controller_security.local143_job_grant(new);
 if j.id is null or t.run_id is null or e.id is null or p.id is null or l.id is null or j.key_ref not like 'axiom-local-dispatch://%'
  or new.activation_epoch is distinct from e.activation_epoch
  or new.grant_text is distinct from controller_security.canonical_questionnaire_json(g) or new.grant_sha256 is distinct from encode(sha256(convert_to(new.grant_text,'UTF8')),'hex')
  or new.context_sha256 is distinct from encode(sha256(convert_to(context,'UTF8')),'hex') or new.original_expires_at is distinct from t.expires_at
  or l.action_type::text is distinct from 'assessment.requested' or l.target_ref is distinct from j.id::text or ((l.actor_id is distinct from j.actor_id::text or l.actor_type::text is distinct from 'human') and not coalesce(controller_security.coverage175_request_actor(j,l),false))
  or l.input_hash is distinct from j.input_hash or l.correlation_id is distinct from j.correlation_id
  or l.detail->>'job_id' is distinct from j.id::text or l.detail->>'run_id' is distinct from j.run_id::text or l.detail->>'workload_id' is distinct from j.workload_id::text
  or l.detail->>'custody_policy_id' is distinct from p.id::text or l.detail->>'custody_policy_sha256' is distinct from p.policy_sha256
  or j.created_at<transaction_timestamp() or t.expires_at<=clock_timestamp()
  or not exists(select 1 from public.local_custody_policy_heads h where h.tenant_id=new.tenant_id and h.policy_id=new.policy_id and h.state='active' and h.activation_epoch=new.activation_epoch)
 then raise exception 'local custody accepted grant refused' using errcode='23514';end if;return null;
end $$;
revoke all on function controller_security.local143_grant_binding()from public;
create function controller_security.coverage175_unknown_result(result jsonb,controls jsonb)returns boolean
language plpgsql immutable set search_path=''as $$
declare control jsonb;questions jsonb;rows jsonb:='[]';expected jsonb;total integer;begin
 if jsonb_typeof(result)is distinct from'object'or jsonb_typeof(controls)is distinct from'array'or jsonb_array_length(controls)not between 1 and 500 then return false;end if;
 for control in select value from jsonb_array_elements(controls)order by value->>'id'loop
  select coalesce(jsonb_agg(jsonb_build_object('question_id',q->>'id','declaration','unknown')order by q->>'id'),'[]')into questions
  from jsonb_array_elements(control->'assessment_questions')q where q->>'type'='boolean';
  total:=jsonb_array_length(questions);
  if total>1000 or(select count(distinct q->>'question_id')from jsonb_array_elements(questions)q)<>total
  or exists(select 1 from jsonb_array_elements(questions)q where q->>'question_id'is null or length(q->>'question_id')not between 1 and 200)
  then return false;end if;
  rows:=rows||jsonb_build_array(jsonb_build_object('control_id',control->>'id','questions',questions,'known_boolean_question_count',total,'caller_affirmed_count',0,'caller_denied_count',0,'unknown_count',total,
   'answer_state',case when total=0 then'not_boolean_assessable'else'unknown'end,'applicability_state',case when coalesce((control->>'sdf_only')::boolean,false)or coalesce((control->>'children_only')::boolean,false)then'unknown'else'unconditional'end));
 end loop;
 expected:=jsonb_build_object('version',1,'source_library_version',result->>'library_version','source_library_digest',encode(sha256(convert_to(controls::text,'UTF8')),'hex'),'estimates','provisional','review_required',true,'controls',rows,
 'applicability',jsonb_build_object('sdf_self_attested','{"value":null,"provenance":"unknown"}'::jsonb,'processes_children','{"value":null,"provenance":"unknown"}'::jsonb,'processes_health','{"value":null,"provenance":"unknown"}'::jsonb));
 return coalesce(result->'questionnaire_provenance'=expected,false);
 exception when others then return false;
end $$;
revoke all on function controller_security.coverage175_unknown_result(jsonb,jsonb)from public;
create function controller_security.coverage175_packet_guard()returns trigger
language plpgsql security definer set search_path=''as $$declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;rows jsonb;begin
 select *into f from controller_security.coverage175_fires where tenant_id=new.tenant_id and run_id=new.run_id;
 if f.id is null then return new;end if;
 -- A historical finalized packet is never renewed, reinterpreted or amended.
 if tg_op='UPDATE'and old.finalized_receipt is not null then
  if new is distinct from old then raise exception 'scheduled finalized packet immutable'using errcode='23514';end if;return new;
 end if;
 f:=controller_security.coverage175_fire_live(new.tenant_id,f.id);
 select *into strict s from controller_security.coverage175_scopes where tenant_id=f.tenant_id and id=f.scope_id;
 select jsonb_agg(value-'created_at'order by value->>'id')into rows from jsonb_array_elements(new.controls);
 if(new.engagement_id,new.library_version)is distinct from(f.engagement_id,s.source#>>'{catalogue,libraryVersion}')
 or encode(sha256(convert_to(controller_security.canonical_questionnaire_json(rows),'UTF8')),'hex')is distinct from s.source#>>'{catalogue,rowsSha256}'
 or(new.result is not null and not controller_security.coverage175_unknown_result(new.result,new.controls))
 then raise exception 'frozen unknown-only scheduled result required'using errcode='42501';end if;
 return new;
end $$;
revoke all on function controller_security.coverage175_packet_guard()from public;
create trigger coverage175_packet_before before insert or update on public.workload_assessment_packets for each row execute function controller_security.coverage175_packet_guard();
-- Recheck after all triggers/ledger waits at final transaction clock, not only
-- before a potentially delayed write. Historical finalized readback adds no work.
create function controller_security.coverage175_packet_fence()returns trigger
language plpgsql security definer set search_path=''as $$declare fire uuid;begin
 if tg_op='UPDATE'and old.finalized_receipt is not null then return null;end if;
 select id into fire from controller_security.coverage175_fires where tenant_id=new.tenant_id and run_id=new.run_id;
 if fire is not null then perform controller_security.coverage175_fire_live(new.tenant_id,fire);end if;return null;
end $$;
revoke all on function controller_security.coverage175_packet_fence()from public;
create constraint trigger coverage175_packet_final_clock after insert or update on public.workload_assessment_packets deferrable initially deferred for each row execute function controller_security.coverage175_packet_fence();
create function controller_security.coverage175_job_claim_guard()returns trigger
language plpgsql security definer set search_path=''as $$declare fire uuid;begin
 if old.claimed_at is null and new.claimed_at is not null then
 select id into fire from controller_security.coverage175_fires where tenant_id=new.tenant_id and job_id=new.id;
 if fire is not null then perform controller_security.coverage175_fire_live(new.tenant_id,fire);end if;
 end if;return new;
end $$;
revoke all on function controller_security.coverage175_job_claim_guard()from public;
create trigger coverage175_job_claim before update on public.assessment_dispatch_jobs for each row execute function controller_security.coverage175_job_claim_guard();
create function controller_security.coverage175_finding_guard()returns trigger
language plpgsql security definer set search_path=''as $$declare fire uuid;begin
 select id into fire from controller_security.coverage175_fires where tenant_id=new.tenant_id and engagement_id=new.engagement_id;
 if fire is not null then perform controller_security.coverage175_fire_live(new.tenant_id,fire);end if;return new;
end $$;
revoke all on function controller_security.coverage175_finding_guard()from public;
create trigger coverage175_finding_write before insert on public.findings for each row execute function controller_security.coverage175_finding_guard();
create function public.read_scheduled_coverage_presentation(p_tenant_id uuid,p_run_id uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $$
declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;p public.workload_assessment_packets;j public.assessment_dispatch_jobs;receipt public.audit_ledger;begin
 if current_setting('role',true)is distinct from'service_role'then raise exception 'private coverage read projection required'using errcode='42501';end if;
 select *into strict f from controller_security.coverage175_fires where tenant_id=p_tenant_id and run_id=p_run_id;
 select *into strict s from controller_security.coverage175_scopes where tenant_id=p_tenant_id and id=f.scope_id;
 select *into strict p from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=p_run_id;
 select *into strict j from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=f.job_id;
 select *into strict receipt from public.audit_ledger where tenant_id=p_tenant_id and id=(select(metadata->>'assessment_request_receipt')::bigint from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id);
 if p.finalized_receipt is null or p.result_digest is distinct from encode(sha256(convert_to(p.result::text,'UTF8')),'hex')or not controller_security.coverage175_request_actor(j,receipt)
 or not controller_security.coverage175_unknown_result(p.result,p.controls)then raise exception 'original unknown coverage proof unavailable'using errcode='42501';end if;
 return jsonb_build_object('tenantId',p_tenant_id,'runId',p_run_id,'engagementId',f.engagement_id,'fireId',f.id,'scopeId',s.id,'scopeReceiptId',s.receipt_id::text,'discoveryId',f.discovery_id,'discoveryResultSha256',f.discovery_result_sha256,
 'basis','technical_provenance_only','declarationPolicy','all_business_facts_unknown');
end $$;
revoke all on function public.read_scheduled_coverage_presentation(uuid,uuid)from public;
-- Acquire175 authority before original task/run/packet locks. Trigger-only
-- late acquisition would invert the owner-revocation/assessment lock order.
create function controller_security.coverage175_before_tool(t uuid,run uuid,confirming boolean default false)returns void
language plpgsql volatile security definer set search_path=''as $$declare f controller_security.coverage175_fires;begin
 select *into f from controller_security.coverage175_fires where tenant_id=t and run_id=run;
 if f.id is null then return;end if;
 if confirming and exists(select 1 from public.workload_assessment_packets where tenant_id=t and run_id=run and finalized_receipt is not null)then return;end if;
 perform controller_security.coverage175_fire_live(t,f.id);
end $$;
revoke all on function controller_security.coverage175_before_tool(uuid,uuid,boolean)from public;
create function controller_security.coverage175_before_claim(t uuid,job uuid)returns void
language plpgsql volatile security definer set search_path=''as $$declare fire uuid;begin
 select id into fire from controller_security.coverage175_fires where tenant_id=t and job_id=job;
 if fire is not null then perform controller_security.coverage175_fire_live(t,fire);end if;
end $$;
revoke all on function controller_security.coverage175_before_claim(uuid,uuid)from public;
create or replace function public.start_workload_assessment(p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_input_hash text,p_identity_expires_at timestamptz) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 perform controller_security.coverage175_before_tool(p_tenant_id,p_run_id,false);
 return controller_security.start_workload_assessment(p_tenant_id,p_run_id,p_workload_id,p_proof_hash,p_input_hash,p_identity_expires_at);
end $$;
revoke all on function public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz)from public;
create or replace function public.complete_workload_assessment(p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_library_digest text,p_result jsonb,p_identity_expires_at timestamptz) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 perform controller_security.coverage175_before_tool(p_tenant_id,p_run_id,false);
 return controller_security.complete_workload_assessment(p_tenant_id,p_run_id,p_workload_id,p_proof_hash,p_library_digest,p_result,p_identity_expires_at);
end $$;
revoke all on function public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz)from public;
create or replace function public.confirm_workload_assessment(p_tenant_id uuid,p_run_id uuid) returns jsonb
language plpgsql  security definer set search_path='' as $$
begin
 perform controller_security.require_tenant(p_tenant_id);
 perform controller_security.coverage175_before_tool(p_tenant_id,p_run_id,true);
 return controller_security.confirm_workload_assessment(p_tenant_id,p_run_id);
end $$;
revoke all on function public.confirm_workload_assessment(uuid,uuid)from public;
create or replace function public.claim_local_assessment_dispatch(p_tenant_id uuid,p_job_id uuid,p_custody_policy_id uuid,p_custody_policy_sha256 text,p_key_policy_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.assessment_local_custody_authorizations;j public.assessment_dispatch_jobs;
 t public.workload_task_delegations;p public.local_custody_policy_versions;h public.local_custody_policy_heads;v jsonb;reply jsonb;
begin
 perform controller_security.local147_controller(p_tenant_id);
 perform controller_security.coverage175_before_claim(p_tenant_id,p_job_id);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 select * into g from public.assessment_local_custody_authorizations where tenant_id=p_tenant_id and job_id=p_job_id;
 select * into j from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id;
 select * into t from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=j.run_id;
 select * into p from public.local_custody_policy_versions where tenant_id=p_tenant_id and id=g.policy_id;
 select * into h from public.local_custody_policy_heads where tenant_id=p_tenant_id and policy_id=g.policy_id;
 if g.job_id is null or j.id is null or t.run_id is null or p.id is null or h.policy_id is null
  or g.policy_id is distinct from p_custody_policy_id or p.policy_sha256 is distinct from p_custody_policy_sha256 or p.key_policy_sha256 is distinct from p_key_policy_sha256
  or g.original_expires_at is distinct from t.expires_at or g.original_expires_at<=clock_timestamp() or t.revoked_at is not null
  or h.state not in ('active','revoked')
  or g.grant_text is distinct from controller_security.canonical_questionnaire_json(controller_security.local143_job_grant(g))
  or g.grant_sha256 is distinct from encode(sha256(convert_to(g.grant_text,'UTF8')),'hex')
 then return jsonb_build_object('error','local_dispatch_unavailable');end if;
 v:=controller_security.local143_policy(p.policy_text);
 if not exists(select 1 from jsonb_array_elements_text(v#>'{keyPolicy,readable}') ref where ref=j.key_ref) then return jsonb_build_object('error','local_dispatch_unavailable');end if;
 -- No current policy/head/source freshness is imposed on accepted work. The
 -- original kernel still checks actor, task, workload, stop and one-time claim.
 reply:=public.claim_assessment_dispatch_unfenced(p_tenant_id,p_job_id);
 -- Any refusal after claimed_at must raise, rather than commit an uncertain
 -- claim on behalf of an identity which expired/revoked while waiting.
 perform controller_security.local147_controller(p_tenant_id,true);
 if g.original_expires_at<=clock_timestamp() then raise exception 'task_expired' using errcode='42501';end if;
 if reply?'error' then return reply;end if;
 return reply||jsonb_build_object('local_custody',jsonb_build_object('policy_id',p.id,'policy_sha256',p.policy_sha256,'key_policy_sha256',p.key_policy_sha256,'grant_sha256',g.grant_sha256,'context_sha256',g.context_sha256,'activation_event_id',g.activation_event_id,'activation_epoch',g.activation_epoch,'original_expires_at',g.original_expires_at));
end $$;
revoke all on function public.claim_local_assessment_dispatch(uuid,uuid,uuid,text,text)from public;

create function public.scheduled_coverage_scope_context(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare b public.monitoring_read_scopes;source jsonb;baseline uuid;preflight uuid;workload uuid;head uuid;candidates jsonb:='[]';scopes jsonb;fires jsonb;begin
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 for b in select read.*from public.monitoring_read_scopes read join public.monitoring_schedules schedule on(schedule.tenant_id,schedule.id,schedule.read_scope_id)=(read.tenant_id,read.schedule_id,read.id)
 where read.tenant_id=p_tenant_id and read.actor_id=p_actor_id and read.expires_at>clock_timestamp()and schedule.status='active'order by read.created_at desc,read.id limit 20 loop
  select packet.run_id into baseline from public.workload_assessment_packets packet join public.engagements engagement on(engagement.tenant_id,engagement.id)=(packet.tenant_id,packet.engagement_id)
  where packet.tenant_id=p_tenant_id and engagement.estate_id=b.estate_id and packet.finalized_receipt is not null order by packet.finalized_at desc,packet.run_id limit 1;
  select id into preflight from public.monitoring_read_dispatches where tenant_id=p_tenant_id and scope_id=b.id and state='confirmed'and cleanup_confirmed order by finished_at desc,id limit 1;
  select(policy.policy_text::jsonb->>'targetWorkloadId')::uuid into workload from public.local_custody_policy_versions policy join public.local_custody_policy_heads head on(head.tenant_id,head.policy_id)=(policy.tenant_id,policy.id)where policy.tenant_id=p_tenant_id and head.state='active';
  if baseline is null or preflight is null or workload is null then continue;end if;
  begin source:=controller_security.coverage175_source(p_tenant_id,b.id,baseline,preflight,workload);exception when insufficient_privilege or no_data_found then continue;end;
  select scope_id into head from controller_security.coverage175_heads where tenant_id=p_tenant_id and schedule_id=b.schedule_id;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('source',source,'previousScopeId',head,'maxExpiresAt',to_char(b.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('scopeId',scope.id,'requestSha256',scope.request_sha256,'request',scope.request_text::jsonb->'request','receiptId',scope.receipt_id::text,
 'active',scope.expires_at>clock_timestamp()and head.scope_id=scope.id and rev.scope_id is null,'revoked',rev.scope_id is not null)order by scope.created_at desc,scope.id),'[]'::jsonb)into scopes
 from(select *from controller_security.coverage175_scopes where tenant_id=p_tenant_id and actor_id=p_actor_id order by created_at desc,id limit 100)scope
 left join controller_security.coverage175_heads head on(head.tenant_id,head.schedule_id)=(scope.tenant_id,scope.schedule_id)left join controller_security.coverage175_revocations rev on(rev.tenant_id,rev.scope_id)=(scope.tenant_id,scope.id);
 select coalesce(jsonb_agg(controller_security.coverage175_outcome(p_tenant_id,fire.id)order by fire.created_at desc,fire.id),'[]'::jsonb)into fires from(
 select f.*from controller_security.coverage175_fires f join controller_security.coverage175_scopes scope on(scope.tenant_id,scope.id)=(f.tenant_id,f.scope_id)where f.tenant_id=p_tenant_id and scope.actor_id=p_actor_id order by f.created_at desc,f.id limit 100)fire;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'checkedAt',to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'candidates',candidates,'scopes',scopes,'fires',fires);
end $$;
revoke all on function public.scheduled_coverage_scope_context(uuid,uuid,uuid)from public;

create function public.read_scheduled_coverage_original_request(p_tenant_id uuid,p_job_id uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $$
declare f controller_security.coverage175_fires;s controller_security.coverage175_scopes;j public.assessment_dispatch_jobs;run public.agent_runs;receipt public.audit_ledger;begin
 if current_setting('role',true)is distinct from'service_role'then raise exception 'private coverage read projection required'using errcode='42501';end if;
 select *into strict f from controller_security.coverage175_fires where tenant_id=p_tenant_id and job_id=p_job_id;
 select *into strict s from controller_security.coverage175_scopes where tenant_id=p_tenant_id and id=f.scope_id;
 select *into strict j from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=f.job_id;
 select *into strict run from public.agent_runs where tenant_id=p_tenant_id and id=f.run_id;
 select *into strict receipt from public.audit_ledger where tenant_id=p_tenant_id and id=(run.metadata->>'assessment_request_receipt')::bigint;
 if not coalesce(controller_security.coverage175_request_actor(j,receipt),false)or(run.id,run.engagement_id,run.correlation_id,run.input_redacted_hash)is distinct from(j.run_id,j.engagement_id,j.correlation_id,j.input_hash)
 or run.metadata->>'request_kind'is distinct from'scheduled_coverage_reassessment_v1'or run.metadata->>'scheduled_coverage_scope_id'is distinct from s.id::text or run.metadata->>'scheduled_coverage_fire_id'is distinct from f.id::text
 or(j.actor_id,j.workload_id,j.estate_id,j.engagement_id,j.correlation_id,j.input_hash)is distinct from(s.actor_id,(s.source->>'workloadId')::uuid,(s.source->>'estateId')::uuid,f.engagement_id,f.job_id,f.input_sha256)
 then raise exception 'original scheduled coverage source binding refused'using errcode='42501';end if;
 return jsonb_build_object('tenantId',p_tenant_id,'jobId',j.id,'runId',j.run_id,'ownerId',j.actor_id,'workloadId',j.workload_id,'estateId',j.estate_id,'engagementId',j.engagement_id,'correlationId',j.correlation_id,'inputSha256',j.input_hash,
 'requestedReceipt',receipt.id::text,'libraryVersion',s.source#>>'{catalogue,libraryVersion}','fireId',f.id,'scopeId',s.id,'scopeReceiptId',s.receipt_id::text);
end $$;
revoke all on function public.read_scheduled_coverage_original_request(uuid,uuid)from public;

create function public.scheduled_coverage_writer_check()returns jsonb
language plpgsql stable security definer set search_path=''as $$begin
 if current_setting('role',true)is distinct from'agent_ledger_writer'then raise exception 'private coverage writer required'using errcode='42501';end if;
 return jsonb_build_object('schemaVersion',1,'authority','explicit_owner_scope_required','taskScopes',jsonb_build_array('control_library.read','findings.write'));
end $$;
revoke all on function public.scheduled_coverage_writer_check()from public;

-- Explicit ACLs, no new role/key/identity or generic signing/write authority.
do $$declare f record;begin
 for f in select proc.oid::regprocedure signature from pg_catalog.pg_proc proc join pg_catalog.pg_namespace namespace on namespace.oid=proc.pronamespace
 where(namespace.nspname='controller_security'and proc.proname like'coverage175_%')or(namespace.nspname='public'and proc.proname in('issue_scheduled_coverage_mfa_challenge','satisfy_scheduled_coverage_mfa_challenge','consume_scheduled_coverage_mfa_challenge',
 'preflight_scheduled_coverage_scope','read_scheduled_coverage_scope_operation','record_scheduled_coverage_scope','fence_scheduled_coverage_scope','read_scheduled_coverage_fire','reserve_scheduled_coverage_fire','claim_scheduled_coverage_fire','enqueue_scheduled_coverage_dispatch','read_scheduled_coverage_presentation','scheduled_coverage_scope_context','read_scheduled_coverage_original_request','scheduled_coverage_writer_check'))loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier',f.signature);
 end loop;
end $$;
grant execute on function public.issue_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer),public.satisfy_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text),public.consume_scheduled_coverage_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid),
 public.preflight_scheduled_coverage_scope(uuid,uuid,uuid,text),public.read_scheduled_coverage_scope_operation(uuid,uuid,uuid,text),public.read_scheduled_coverage_presentation(uuid,uuid),public.scheduled_coverage_scope_context(uuid,uuid,uuid),public.read_scheduled_coverage_original_request(uuid,uuid)to service_role;
grant execute on function public.preflight_scheduled_coverage_scope(uuid,uuid,uuid,text),public.read_scheduled_coverage_scope_operation(uuid,uuid,uuid,text),public.record_scheduled_coverage_scope(uuid,uuid,uuid,text,uuid),public.fence_scheduled_coverage_scope(uuid,uuid,uuid,text)to human_action_writer;
grant execute on function public.read_scheduled_coverage_fire(uuid,uuid),public.reserve_scheduled_coverage_fire(uuid),public.claim_scheduled_coverage_fire(uuid,uuid),public.enqueue_scheduled_coverage_dispatch(uuid,uuid,text,text,bytea,bytea,bytea),public.scheduled_coverage_writer_check()to agent_ledger_writer;
