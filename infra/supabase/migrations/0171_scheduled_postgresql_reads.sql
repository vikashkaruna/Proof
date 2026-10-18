-- Optional, explicitly approved local synthetic PostgreSQL enumeration only.
-- Existing human discovery history remains unchanged; scheduled work records
-- schedule attribution and never fabricates a browser identity or approval.
alter type public.mfa_challenge_purpose add value if not exists 'monitoring_read_scope';

create table public.monitoring_read_scopes (
 id uuid primary key,tenant_id uuid not null references public.tenants(id),schedule_id uuid not null,
 actor_id uuid not null references public.users(id),session_id uuid not null,
 estate_id uuid not null,engagement_id uuid not null,connector_id uuid not null,grant_id uuid not null,
 configuration_sha256 text not null check(configuration_sha256~'^[a-f0-9]{64}$'),cadence text not null,
 preflight_request_id uuid not null references public.postgresql_discovery_requests(id),
 preflight_discovery_id uuid not null references public.connector_discovery_runs(id),
 preflight_result_sha256 text not null check(preflight_result_sha256~'^[a-f0-9]{64}$'),
 request_text text not null,request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),
 challenge_id uuid not null unique references public.mfa_challenges(id),
 expires_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),
 receipt_id bigint not null unique references public.audit_ledger(id),
 unique(tenant_id,id),foreign key(tenant_id,schedule_id) references public.monitoring_schedules(tenant_id,id),
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id),
 foreign key(tenant_id,grant_id) references public.connector_grants(tenant_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '1 hour')
);
alter table public.monitoring_schedules add column read_scope_id uuid references public.monitoring_read_scopes(id);
alter table public.monitoring_schedules add constraint monitoring_read171_tenant_scope foreign key(tenant_id,read_scope_id) references public.monitoring_read_scopes(tenant_id,id);
create table public.monitoring_read_revocations (
 operation_key uuid primary key,tenant_id uuid not null,scope_id uuid not null unique,
 actor_id uuid not null references public.users(id),session_id uuid not null,
 request_text text not null,request_sha256 text not null,
 challenge_id uuid not null unique references public.mfa_challenges(id),
 receipt_id bigint not null unique references public.audit_ledger(id),created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,scope_id) references public.monitoring_read_scopes(tenant_id,id)
);
create table public.monitoring_read_dispatches (
 id uuid primary key,tenant_id uuid not null,scope_id uuid not null,schedule_id uuid not null,
 due_at timestamptz not null,request_id uuid unique references public.postgresql_discovery_requests(id),
 state text not null default 'queued' check(state in('queued','handed_off','confirmed','unconfirmed','refused')),
 created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 handed_off_at timestamptz,finished_at timestamptz,cleanup_confirmed boolean,
 fire_receipt_id bigint not null unique references public.audit_ledger(id),receipt_id bigint unique references public.audit_ledger(id),
 unique(tenant_id,id),unique(tenant_id,schedule_id,due_at),
 foreign key(tenant_id,scope_id) references public.monitoring_read_scopes(tenant_id,id),
 foreign key(tenant_id,schedule_id) references public.monitoring_schedules(tenant_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '2 minutes'),
 check(state='refused' or request_id is not null),
 check((state='confirmed') is not true or(cleanup_confirmed is true and receipt_id is not null and finished_at is not null))
);
-- Backend consumers have no direct mutation grant. SQL receipts are the only
-- authority; tenant readers see metadata, never credentials or sampled values.
do $$declare n text;begin
 foreach n in array array['monitoring_read_scopes','monitoring_read_revocations','monitoring_read_dispatches'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller',n);
  execute format('grant select on public.%I to authenticated,service_role',n);
  execute format('create policy scheduled_read171_tenant on public.%I for select to authenticated using(public.is_tenant_member(tenant_id))',n);
  execute format('create policy scheduled_read171_backend on public.%I for select to service_role using(true)',n);
  execute format('create trigger scheduled_read171_no_delete before delete on public.%I for each row execute function public.evidence_receipt_immutable()',n);
  execute format('create trigger scheduled_read171_no_truncate before truncate on public.%I for each statement execute function public.evidence_receipt_immutable()',n);
 end loop;
end $$;
create trigger scheduled_read171_scope_immutable before update on public.monitoring_read_scopes for each row execute function public.evidence_receipt_immutable();
create trigger scheduled_read171_revocation_immutable before update on public.monitoring_read_revocations for each row execute function public.evidence_receipt_immutable();

-- Challenges and cancellation fences survive lost replies. They carry no
-- connector secret and confer no read authority until scope recording succeeds.
create table public.monitoring_read_decisions (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 binding_sha256 text not null check(binding_sha256~'^[a-f0-9]{64}$'),challenge_id uuid not null unique references public.mfa_challenges(id),created_at timestamptz not null default clock_timestamp()
);
create table public.monitoring_read_fences (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 phase text not null check(phase in('authorize','revoke')),request_text text not null,request_sha256 text not null,
 receipt_id bigint not null unique references public.audit_ledger(id),created_at timestamptz not null default clock_timestamp()
);
do $$declare n text;begin
 foreach n in array array['monitoring_read_decisions','monitoring_read_fences'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller',n);
  execute format('create trigger scheduled_read171_immutable before update or delete on public.%I for each row execute function public.evidence_receipt_immutable()',n);
  execute format('create trigger scheduled_read171_no_truncate before truncate on public.%I for each statement execute function public.evidence_receipt_immutable()',n);
 end loop;
end $$;

create function controller_security.scheduled_read171_owner(t uuid,a uuid,s uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 perform 1 from public.tenant_users where tenant_id=t and user_id=a for share;
 perform 1 from public.users where id=a for no key update;
 perform 1 from public.tenants where id=t for share;
 perform 1 from auth.sessions where id=s and user_id=a for share;
 if t is null or a is null or s is null
  or not exists(select 1 from public.tenant_users m join public.tenants n on n.id=m.tenant_id where m.tenant_id=t and m.user_id=a and m.role='owner' and n.is_demo)
  or not exists(select 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp()))
 then raise exception 'current demo owner session required' using errcode='42501';end if;
end $$;

create function controller_security.scheduled_read171_scope(t uuid,id uuid,do_lock boolean default false)
returns public.monitoring_read_scopes language plpgsql volatile security definer set search_path='' as $$
declare b public.monitoring_read_scopes;s public.monitoring_schedules;g jsonb;
begin
 if do_lock then select * into b from public.monitoring_read_scopes where tenant_id=t and monitoring_read_scopes.id=scheduled_read171_scope.id for share;
 else select * into b from public.monitoring_read_scopes where tenant_id=t and monitoring_read_scopes.id=scheduled_read171_scope.id;end if;
 if b.id is null then return null;end if;
 if do_lock then
  select * into s from public.monitoring_schedules where tenant_id=t and monitoring_schedules.id=b.schedule_id for share;
  perform 1 from public.tenant_users where tenant_id=t and user_id=b.actor_id for share;
  perform 1 from public.connector_grants where tenant_id=t and connector_grants.id=b.grant_id for share;
  perform 1 from public.workload_identities w join public.connector_grants grantrow on grantrow.workload_identity_id=w.id and grantrow.tenant_id=w.tenant_id where grantrow.tenant_id=t and grantrow.id=b.grant_id for share of w;
 else select * into s from public.monitoring_schedules where tenant_id=t and monitoring_schedules.id=b.schedule_id;end if;
 if s.id is null or s.status<>'active' or s.kind<>'rediscovery' or s.read_scope_id is distinct from b.id
  or s.estate_id<>b.estate_id or s.cadence<>b.cadence or b.expires_at<=clock_timestamp()
  or exists(select 1 from public.monitoring_read_revocations where tenant_id=t and scope_id=b.id)
  or not exists(select 1 from public.tenant_users where tenant_id=t and user_id=b.actor_id and role='owner')
  or not exists(select 1 from public.engagements where tenant_id=t and engagements.id=b.engagement_id and estate_id=b.estate_id)
 then return null;end if;
 g:=public.resolve_sandbox_postgresql_read_grant_for_operation(t,b.estate_id,b.connector_id,'spiffe://local.axiomproof.test/agent/drishti',b.configuration_sha256,'enumerate');
 if g is null or g->>'grantId' is distinct from b.grant_id::text or (g->>'grantExpiresAt')::timestamptz<=clock_timestamp() or b.expires_at>(g->>'grantExpiresAt')::timestamptz then return null;end if;
 return b;
end $$;

create function controller_security.scheduled_read171_preflight(t uuid,a uuid,s uuid,r text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v jsonb;sch public.monitoring_schedules;p public.postgresql_discovery_requests;d public.connector_discovery_runs;g jsonb;
begin
 perform controller_security.scheduled_read171_owner(t,a,s);
 if r is null or octet_length(r)>16384 then raise exception 'bounded scope required' using errcode='22023';end if;
 v:=r::jsonb;
 if controller_security.canonical_questionnaire_json(v) is distinct from r then raise exception 'canonical scope required' using errcode='22023';end if;
 if jsonb_typeof(v) is distinct from 'object' or (select array_agg(key order by key) from jsonb_object_keys(v)key) is distinct from
  array['cadence','configurationSha256','connectorId','engagementId','estateId','expiresAt','grantId','operationKey','preflightRequestId','previousScopeId','reason','scheduleId','schemaVersion']::text[]
  or v->'schemaVersion' is distinct from '1'::jsonb or jsonb_typeof(v->'reason') is distinct from 'string' or length(btrim(v->>'reason')) not between 20 and 2000
  or v->>'configurationSha256' !~ '^[a-f0-9]{64}$' or jsonb_typeof(v->'cadence') is distinct from 'string'
 then raise exception 'scope shape refused' using errcode='22023';end if;
 select * into sch from public.monitoring_schedules where tenant_id=t and id=(v->>'scheduleId')::uuid for update;
 if sch.id is null or sch.status<>'active' or sch.kind<>'rediscovery' or sch.estate_id is distinct from (v->>'estateId')::uuid or sch.cadence is distinct from v->>'cadence'
  or sch.read_scope_id is distinct from (v->>'previousScopeId')::uuid
  or not exists(select 1 from public.engagements where tenant_id=t and id=(v->>'engagementId')::uuid and estate_id=sch.estate_id)
 then raise exception 'current rediscovery scope required' using errcode='42501';end if;
 select * into p from public.postgresql_discovery_requests where tenant_id=t and id=(v->>'preflightRequestId')::uuid;
 select * into d from public.connector_discovery_runs where tenant_id=t and id=p.discovery_run_id;
 if p.id is null or p.actor_id<>a or p.connector_id<>(v->>'connectorId')::uuid or p.estate_id<>sch.estate_id
  or p.engagement_id<>(v->>'engagementId')::uuid or p.operation<>'enumerate' or p.status<>'completed' or p.cleanup_confirmed is distinct from true
  or p.configuration_sha256<>v->>'configurationSha256' or p.completed_at<=clock_timestamp()-interval '5 minutes'
  or d.id is null or d.correlation_id<>p.id or d.operation<>'enumerate' or d.grant_id<>(v->>'grantId')::uuid
 then raise exception 'actual supervised enumeration preflight required' using errcode='42501';end if;
 g:=public.resolve_sandbox_postgresql_read_grant_for_operation(t,sch.estate_id,p.connector_id,'spiffe://local.axiomproof.test/agent/drishti',p.configuration_sha256,'enumerate');
 if g is null or g->>'grantId' is distinct from v->>'grantId' or (v->>'expiresAt')::timestamptz<=clock_timestamp()
  or (v->>'expiresAt')::timestamptz>least(clock_timestamp()+interval '1 hour',(g->>'grantExpiresAt')::timestamptz)
 then raise exception 'bounded current read grant required' using errcode='42501';end if;
 return jsonb_build_object('request',v,'preflightDiscoveryId',d.id,'preflightResultSha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(d.result),'UTF8')),'hex'));
end $$;

-- The same reviewed database-clock step-up protocol, a separate purpose.
create function public.issue_monitoring_read_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_ttl_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;d public.monitoring_read_decisions;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'monitoring read MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'monitoring read MFA input refused' using errcode='22023';end if;

 if p_ttl_ms is null or p_ttl_ms not between 1 and 300000 then raise exception 'monitoring read MFA TTL refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;

 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id join public.tenants t on t.id=m.tenant_id where m.tenant_id=p_tenant_id and m.user_id=p_actor_id and m.role='owner' and t.is_demo)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'monitoring read MFA scope refused' using errcode='42501';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,171));
 if exists(select 1 from public.monitoring_read_fences where operation_key=p_operation_key) then raise exception 'scope request fenced' using errcode='42501';end if;
 select * into d from public.monitoring_read_decisions where operation_key=p_operation_key;
 if d.operation_key is not null then
  if (d.tenant_id,d.actor_id,d.session_id,d.binding_sha256) is distinct from(p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256) then raise exception 'MFA decision conflict' using errcode='23505';end if;
  select * into c from public.mfa_challenges where id=d.challenge_id;
  return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
 end if;
 insert into public.mfa_challenges(user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at)
 values(p_actor_id,p_tenant_id,p_factor_id,'monitoring_read_scope',p_operation_key::text,p_bound_payload_sha256,now_at,now_at+p_ttl_ms*interval '1 millisecond') returning * into c;
 insert into public.monitoring_read_decisions(operation_key,tenant_id,actor_id,session_id,binding_sha256,challenge_id)values(p_operation_key,p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256,c.id);
 return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
end $$;
create function public.satisfy_monitoring_read_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_satisfied_with text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'monitoring read MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'monitoring read MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_satisfied_with is null or p_satisfied_with not in ('totp','recovery_code') then raise exception 'monitoring read MFA input refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,171));
 if exists(select 1 from public.monitoring_read_fences where operation_key=p_operation_key)
  or not exists(select 1 from public.monitoring_read_decisions d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id)
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id join public.tenants t on t.id=m.tenant_id where m.tenant_id=p_tenant_id and m.user_id=p_actor_id and m.role='owner' and t.is_demo)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'monitoring read MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'monitoring_read_scope'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'monitoring read MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is not null or c.satisfied_with is not null then raise exception 'monitoring read MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set satisfied_at=now_at,satisfied_with=p_satisfied_with where id=c.id and attempts=p_expected_attempts and satisfied_at is null and consumed_at is null returning * into c;
 if not found then raise exception 'monitoring read MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'satisfied_with',c.satisfied_with);
end $$;
create function public.consume_monitoring_read_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_consumed_for uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'monitoring read MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'monitoring read MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_consumed_for is null or p_consumed_for is distinct from p_operation_key then raise exception 'monitoring read MFA input refused' using errcode='22023';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,171));
 if exists(select 1 from public.monitoring_read_fences where operation_key=p_operation_key)
  or not exists(select 1 from public.monitoring_read_decisions d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id)
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id join public.tenants t on t.id=m.tenant_id where m.tenant_id=p_tenant_id and m.user_id=p_actor_id and m.role='owner' and t.is_demo)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'monitoring read MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'monitoring_read_scope'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'monitoring read MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is null or c.satisfied_with not in ('totp','recovery_code') or c.satisfied_with is null
  or c.satisfied_at<c.created_at or c.satisfied_at>now_at or c.satisfied_at<=now_at-interval '5 minutes'
 then raise exception 'monitoring read MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set consumed_at=now_at,consumed_for=p_consumed_for::text where id=c.id and attempts=p_expected_attempts and satisfied_at is not null and consumed_at is null returning * into c;
 if not found then raise exception 'monitoring read MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'expires_at',c.expires_at,'factor_id',c.factor_id);
end $$;
revoke all on function public.issue_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.issue_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.satisfy_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.satisfy_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) to service_role;
revoke all on function public.consume_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.consume_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;

create function public.read_monitoring_read_scope_operation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v jsonb;b public.monitoring_read_scopes;x public.monitoring_read_revocations;digest text;f public.monitoring_read_fences;d public.monitoring_read_decisions;c public.mfa_challenges;binding text;
begin
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 if p_request_text is null or octet_length(p_request_text)>16384 then raise exception 'bounded scope required' using errcode='22023';end if;
 v:=p_request_text::jsonb;digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text then raise exception 'canonical scope required' using errcode='22023';end if;
 select * into b from public.monitoring_read_scopes where tenant_id=p_tenant_id and id=(v->>'operationKey')::uuid;
 if b.id is not null then
  if b.actor_id<>p_actor_id or b.request_text<>p_request_text then raise exception 'scope operation conflict' using errcode='23505';end if;
  return jsonb_build_object('recorded',true,'scopeId',b.id,'receiptId',b.receipt_id::text,'requestSha256',digest,'revoked',exists(select 1 from public.monitoring_read_revocations where scope_id=b.id));
 end if;
 select * into x from public.monitoring_read_revocations where tenant_id=p_tenant_id and operation_key=(v->>'operationKey')::uuid;
 if x.operation_key is not null then
  if x.actor_id<>p_actor_id or x.request_text<>p_request_text then raise exception 'scope operation conflict' using errcode='23505';end if;
  return jsonb_build_object('recorded',true,'scopeId',x.scope_id,'receiptId',x.receipt_id::text,'requestSha256',digest,'revoked',true);
 end if;
 select * into f from public.monitoring_read_fences where operation_key=(v->>'operationKey')::uuid;
 if f.operation_key is not null then
  if (f.tenant_id,f.actor_id,f.request_text) is distinct from(p_tenant_id,p_actor_id,p_request_text) then raise exception 'scope fence conflict' using errcode='23505';end if;
  return jsonb_build_object('recorded',false,'requestSha256',digest,'challengeExpiresAt',null,'fenced',true,'fenceReceiptId',f.receipt_id::text);
 end if;
 select * into d from public.monitoring_read_decisions where operation_key=(v->>'operationKey')::uuid;
 if d.operation_key is not null then
  binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.monitoring-read.'||case when v?'scopeId' then 'revoke' else 'authorize' end,1,p_tenant_id::text,p_actor_id::text,d.session_id::text,digest)),'UTF8')),'hex');
  if d.tenant_id<>p_tenant_id or d.actor_id<>p_actor_id or d.binding_sha256<>binding then raise exception 'scope decision conflict' using errcode='23505';end if;
  select * into c from public.mfa_challenges where id=d.challenge_id;
 end if;
 return jsonb_build_object('recorded',false,'requestSha256',digest,'challengeExpiresAt',c.expires_at,'fenced',false,'fenceReceiptId',null);
end $$;

create function public.preflight_monitoring_read_scope(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_phase text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare proof jsonb;v jsonb;b public.monitoring_read_scopes;digest text;
begin
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 if p_request_text is null or octet_length(p_request_text)>16384 or p_phase is null or p_phase not in('authorize','revoke') then raise exception 'bounded scope required' using errcode='22023';end if;
 v:=p_request_text::jsonb;
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text then raise exception 'canonical scope required' using errcode='22023';end if;
 if p_phase='authorize' then
  proof:=controller_security.scheduled_read171_preflight(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 else
  if jsonb_typeof(v) is distinct from 'object' or v->'schemaVersion' is distinct from '1'::jsonb
   or (select array_agg(key order by key) from jsonb_object_keys(v)key) is distinct from array['operationKey','reason','schemaVersion','scopeId']::text[]
   or jsonb_typeof(v->'reason') is distinct from 'string' or length(btrim(v->>'reason')) not between 20 and 2000
  then raise exception 'revocation shape refused' using errcode='22023';end if;
  select * into b from public.monitoring_read_scopes where tenant_id=p_tenant_id and id=(v->>'scopeId')::uuid;
  if b.id is null then raise exception 'scope not found' using errcode='42501';end if;
  proof:=jsonb_build_object('request',v);
 end if;
 digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 return proof||jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,'phase',p_phase,'requestSha256',digest,
  'scopeRevocationAvailable',to_regprocedure('public.record_monitoring_read_scope(uuid,uuid,uuid,text,text,uuid)') is not null);
end $$;

create function public.record_monitoring_read_scope(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_phase text,p_challenge_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare proof jsonb;v jsonb;digest text;binding text;ch public.mfa_challenges;receipt bigint;old jsonb;now_at timestamptz;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human scope writer required' using errcode='42501';end if;
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 if p_phase is null or p_phase not in('authorize','revoke') then raise exception 'scope phase refused' using errcode='22023';end if;
 old:=public.read_monitoring_read_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 if old->>'recorded'='true' then return old;end if;
 if old->>'fenced'='true' then raise exception 'scope request fenced' using errcode='42501';end if;
 proof:=public.preflight_monitoring_read_scope(p_tenant_id,p_actor_id,p_session_id,p_request_text,p_phase);v:=proof->'request';digest:=proof->>'requestSha256';
 perform pg_advisory_xact_lock(hashtextextended(v->>'operationKey',171));
 old:=public.read_monitoring_read_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 if old->>'recorded'='true' then return old;end if;
 if old->>'fenced'='true' then raise exception 'scope request fenced' using errcode='42501';end if;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into ch from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.monitoring-read.'||p_phase,1,p_tenant_id::text,p_actor_id::text,p_session_id::text,digest)),'UTF8')),'hex');
 if ch.id is null or ch.user_id is distinct from p_actor_id or ch.tenant_id is distinct from p_tenant_id or ch.purpose::text is distinct from 'monitoring_read_scope'
  or ch.bound_resource_ref is distinct from v->>'operationKey' or ch.bound_payload_sha256 is distinct from binding or ch.consumed_for is distinct from v->>'operationKey'
  or ch.satisfied_at is null or ch.consumed_at is null or ch.created_at>ch.satisfied_at or ch.satisfied_at>ch.consumed_at
  or ch.satisfied_at<=now_at-interval '5 minutes' or ch.consumed_at>now_at or ch.expires_at<=now_at or ch.expires_at>ch.created_at+interval '5 minutes'
  or not exists(select 1 from public.user_mfa_factors where id=ch.factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
  or not exists(select 1 from public.monitoring_read_decisions d where d.operation_key=(v->>'operationKey')::uuid and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=binding and d.challenge_id=ch.id)
  or exists(select 1 from public.monitoring_read_scopes where challenge_id=ch.id) or exists(select 1 from public.monitoring_read_revocations where challenge_id=ch.id)
 then raise exception 'fresh exact scope MFA required' using errcode='42501';end if;
 -- Recheck technical source/expiry after all authority locks and waits.
 proof:=public.preflight_monitoring_read_scope(p_tenant_id,p_actor_id,p_session_id,p_request_text,p_phase);
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'connector.updated',(v->>'scheduleId'),digest,null,null,null,null,null,'success',
  jsonb_build_object('phase','scheduled_read_'||p_phase,'scope_id',case when p_phase='authorize' then v->>'operationKey' else v->>'scopeId' end,'operation','enumerate','target_mutation',false));
 if p_phase='authorize' then
  insert into public.monitoring_read_scopes(id,tenant_id,schedule_id,actor_id,session_id,estate_id,engagement_id,connector_id,grant_id,configuration_sha256,cadence,preflight_request_id,preflight_discovery_id,preflight_result_sha256,request_text,request_sha256,challenge_id,expires_at,receipt_id)
  values((v->>'operationKey')::uuid,p_tenant_id,(v->>'scheduleId')::uuid,p_actor_id,p_session_id,(v->>'estateId')::uuid,(v->>'engagementId')::uuid,(v->>'connectorId')::uuid,(v->>'grantId')::uuid,v->>'configurationSha256',v->>'cadence',(v->>'preflightRequestId')::uuid,(proof->>'preflightDiscoveryId')::uuid,proof->>'preflightResultSha256',p_request_text,digest,ch.id,(v->>'expiresAt')::timestamptz,receipt);
  update public.monitoring_schedules set read_scope_id=(v->>'operationKey')::uuid where tenant_id=p_tenant_id and id=(v->>'scheduleId')::uuid and read_scope_id is not distinct from (v->>'previousScopeId')::uuid;
  if not found then raise exception 'scope snapshot changed' using errcode='40001';end if;
 else
  insert into public.monitoring_read_revocations(operation_key,tenant_id,scope_id,actor_id,session_id,request_text,request_sha256,challenge_id,receipt_id)
  values((v->>'operationKey')::uuid,p_tenant_id,(v->>'scopeId')::uuid,p_actor_id,p_session_id,p_request_text,digest,ch.id,receipt);
  update public.monitoring_schedules set read_scope_id=null where tenant_id=p_tenant_id and read_scope_id=(v->>'scopeId')::uuid;
 end if;
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 if ch.expires_at<=clock_timestamp() or(p_phase='authorize' and (v->>'expiresAt')::timestamptz<=clock_timestamp()) then raise exception 'scope expired during recording' using errcode='42501';end if;
 return public.read_monitoring_read_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
end $$;

create function controller_security.scheduled_read171_response(t uuid,f uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d public.monitoring_read_dispatches;
begin
 select * into d from public.monitoring_read_dispatches where tenant_id=t and id=f;
 if d.id is null then return jsonb_build_object('tenantId',t,'fireId',f,'state','unconfirmed','cleanupConfirmed',null,'receiptId',null);end if;
 if d.receipt_id is not null and not exists(select 1 from public.audit_ledger l where l.tenant_id=t and l.id=d.receipt_id and l.correlation_id=d.id and l.action_type='monitoring.schedule.fired' and l.detail->>'fire_id'=d.id::text)
 then raise exception 'scheduled read receipt unavailable' using errcode='23514';end if;
 return jsonb_build_object('tenantId',t,'fireId',f,'state',case when d.state in('queued','handed_off') then 'unconfirmed' else d.state end,
  'cleanupConfirmed',d.cleanup_confirmed,'receiptId',d.receipt_id::text);
end $$;

create function public.read_monitoring_read_dispatch(p_tenant_id uuid,p_fire_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare d public.monitoring_read_dispatches;receipt bigint;
begin
 perform controller_security.local147_controller(p_tenant_id,true);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 select * into d from public.monitoring_read_dispatches where tenant_id=p_tenant_id and id=p_fire_id for update;
 -- A crashed scheduler/controller never causes a second worker launch. Once the
 -- original bound deadline passes, preserve uncertainty and disable only its
 -- original binding. This is no claim that a lost worker was cleaned up.
 if d.state='handed_off' and d.expires_at<=clock_timestamp() then
  receipt:=public.append_ledger(p_tenant_id,d.id,'agent','continuous-compliance-scheduler',null,null,null,'monitoring.schedule.fired',d.schedule_id::text,null,null,null,null,null,null,'failure',jsonb_build_object('phase','scheduled_read_orphan_unconfirmed','fire_id',d.id,'scope_id',d.scope_id,'cleanup_confirmed',false));
  update public.monitoring_read_dispatches set state='unconfirmed',finished_at=clock_timestamp(),cleanup_confirmed=false,receipt_id=receipt where tenant_id=p_tenant_id and id=d.id;
  update public.postgresql_discovery_requests set status='unconfirmed',completed_at=clock_timestamp(),cleanup_confirmed=false,error_code='schedule_handoff_unconfirmed' where tenant_id=p_tenant_id and id=d.request_id and status in('queued','claimed','read_completed');
  update public.monitoring_schedules set read_scope_id=null where tenant_id=p_tenant_id and id=d.schedule_id and read_scope_id=d.scope_id;
 end if;
 perform controller_security.local147_controller(p_tenant_id,true);
 return controller_security.scheduled_read171_response(p_tenant_id,p_fire_id);
end $$;

create function public.reserve_monitoring_read_dispatch(p_tenant_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' set timezone='UTC' as $$
declare sch public.monitoring_schedules;b public.monitoring_read_scopes;d public.monitoring_read_dispatches;
 fire_id uuid;request_id uuid;receipt bigint;expires timestamptz;now_at timestamptz;next_at timestamptz;accepted boolean;
begin
 perform controller_security.local147_controller(p_tenant_id,true);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 -- Existing queued work is returned unchanged. Claim is a distinct one-shot
 -- operation; no poll lease confers authority or resets uncertain work.
 select * into d from public.monitoring_read_dispatches where tenant_id=p_tenant_id and state in('queued','handed_off') order by created_at,id for update limit 1;
 if d.id is not null then return jsonb_build_object('fires',jsonb_build_array(jsonb_build_object('tenantId',p_tenant_id,'fireId',d.id)));end if;
 select * into sch from public.monitoring_schedules where tenant_id=p_tenant_id and status='active' and kind='rediscovery'
  and read_scope_id is not null and next_run_at<=clock_timestamp() order by next_run_at,id for update skip locked limit 1;
 if sch.id is null then return jsonb_build_object('fires','[]'::jsonb);end if;
 select * into d from public.monitoring_read_dispatches where tenant_id=p_tenant_id and schedule_id=sch.id and due_at=sch.next_run_at;
 if d.id is not null then return jsonb_build_object('fires','[]'::jsonb);end if;
 b:=controller_security.scheduled_read171_scope(p_tenant_id,sch.read_scope_id,true);
 now_at:=clock_timestamp();next_at:=controller_security.monitoring_cron_next(sch.cadence,now_at);
 accepted:=b.id is not null and next_at is not null;
 -- A deterministic, config-bound reference is stable across lost replies.
 fire_id:=(substr(encode(sha256(convert_to(p_tenant_id::text||':'||sch.id::text||':'||sch.read_scope_id::text||':'||to_char(sch.next_run_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'UTF8')),'hex'),1,8)||'-'||
  substr(encode(sha256(convert_to(sch.id::text||':'||sch.read_scope_id::text||':'||sch.next_run_at::text,'UTF8')),'hex'),9,4)||'-8'||substr(encode(sha256(convert_to(sch.id::text||sch.next_run_at::text,'UTF8')),'hex'),14,3)||'-8'||substr(encode(sha256(convert_to(sch.read_scope_id::text||sch.next_run_at::text,'UTF8')),'hex'),18,3)||'-'||substr(encode(sha256(convert_to(p_tenant_id::text||sch.id::text||sch.next_run_at::text,'UTF8')),'hex'),21,12))::uuid;
 request_id:=case when accepted then fire_id else null end;
 expires:=case when accepted then least(now_at+interval '2 minutes',b.expires_at) else now_at+interval '2 minutes' end;
 if accepted then
  insert into public.postgresql_discovery_requests(id,tenant_id,actor_id,connector_id,estate_id,engagement_id,configuration_sha256,operation,expires_at)
  values(request_id,p_tenant_id,b.actor_id,b.connector_id,b.estate_id,b.engagement_id,b.configuration_sha256,'enumerate',expires);
 end if;
 receipt:=public.append_ledger(p_tenant_id,fire_id,'agent','continuous-compliance-scheduler',null,null,null,'monitoring.schedule.fired',sch.id::text,null,null,null,null,null,null,
  case when accepted then 'pending'::public.ledger_result else 'failure'::public.ledger_result end,
  jsonb_build_object('phase','scheduled_read_fire','fire_id',fire_id,'schedule_id',sch.id,'scope_id',sch.read_scope_id,'due_at',sch.next_run_at,'request_id',request_id,'operation','enumerate','outcome',case when accepted then 'queued' else 'authority_refused' end));
 insert into public.monitoring_read_dispatches(id,tenant_id,scope_id,schedule_id,due_at,request_id,state,created_at,expires_at,finished_at,fire_receipt_id,receipt_id)
 values(fire_id,p_tenant_id,sch.read_scope_id,sch.id,sch.next_run_at,request_id,case when accepted then 'queued' else 'refused' end,now_at,expires,
  case when accepted then null else now_at end,receipt,case when accepted then null else receipt end);
 -- Invalid/expired authority disables this read binding. It never enables
 -- another connector, samples values, or adopts a human dispatch history.
 update public.monitoring_schedules set last_run_at=now_at,next_run_at=coalesce(next_at,now_at+interval '1 day'),updated_at=now_at,
  read_scope_id=case when accepted then read_scope_id else null end where tenant_id=p_tenant_id and id=sch.id;
 perform controller_security.local147_controller(p_tenant_id,true);
 if not accepted then return jsonb_build_object('fires','[]'::jsonb);end if;
 -- Wall-clock expiry can occur while retaining receipts; roll back every write.
 if expires<=clock_timestamp() or(controller_security.scheduled_read171_scope(p_tenant_id,b.id,false)).id is null then raise exception 'scheduled read expired during reserve' using errcode='42501';end if;
 return jsonb_build_object('fires',jsonb_build_array(jsonb_build_object('tenantId',p_tenant_id,'fireId',fire_id)));
end $$;

create function public.claim_monitoring_read_dispatch(p_tenant_id uuid,p_fire_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare d public.monitoring_read_dispatches;b public.monitoring_read_scopes;receipt bigint;
begin
 perform controller_security.local147_controller(p_tenant_id,true);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 select * into d from public.monitoring_read_dispatches where tenant_id=p_tenant_id and id=p_fire_id for update;
 if d.id is null or d.state<>'queued' then return public.read_monitoring_read_dispatch(p_tenant_id,p_fire_id);end if;
 b:=controller_security.scheduled_read171_scope(p_tenant_id,d.scope_id,true);
 if b.id is null or d.expires_at<=clock_timestamp() or not exists(select 1 from public.postgresql_discovery_requests r where r.tenant_id=p_tenant_id and r.id=d.request_id and r.status='queued' and r.operation='enumerate'
  and r.actor_id=b.actor_id and r.connector_id=b.connector_id and r.configuration_sha256=b.configuration_sha256 and r.estate_id=b.estate_id and r.engagement_id=b.engagement_id and r.expires_at=d.expires_at)
 then
  receipt:=public.append_ledger(p_tenant_id,d.id,'agent','continuous-compliance-scheduler',null,null,null,'monitoring.schedule.fired',d.schedule_id::text,null,null,null,null,null,null,'failure',jsonb_build_object('phase','scheduled_read_claim_refused','fire_id',d.id,'scope_id',d.scope_id));
  update public.monitoring_read_dispatches set state='refused',finished_at=clock_timestamp(),receipt_id=receipt where id=d.id;
  update public.postgresql_discovery_requests set status='failed',completed_at=clock_timestamp(),cleanup_confirmed=false,error_code='schedule_authority_refused' where id=d.request_id and tenant_id=p_tenant_id and status='queued';
  perform controller_security.local147_controller(p_tenant_id,true);
  return controller_security.scheduled_read171_response(p_tenant_id,p_fire_id);
 end if;
 update public.monitoring_read_dispatches set state='handed_off',handed_off_at=clock_timestamp() where id=d.id;
 perform controller_security.local147_controller(p_tenant_id,true);
 if d.expires_at<=clock_timestamp() or(controller_security.scheduled_read171_scope(p_tenant_id,b.id,false)).id is null then raise exception 'scheduled handoff expired' using errcode='42501';end if;
 return jsonb_build_object('tenantId',p_tenant_id,'fireId',p_fire_id,'state','runnable','requestId',d.request_id);
end $$;

-- Preserve every existing human request rule, while requiring scheduled reads
-- to carry their own current explicit authority at Drishti claim AND retention.
create or replace function controller_security.discovery165_live(t uuid,j uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.postgresql_discovery_requests r
 join public.tenant_users m on m.tenant_id=r.tenant_id and m.user_id=r.actor_id and m.role in('founder','owner','admin')
 where r.tenant_id=t and r.id=j and r.expires_at>statement_timestamp()
 and public.resolve_sandbox_postgresql_read_grant_for_operation(r.tenant_id,r.estate_id,r.connector_id,'spiffe://local.axiomproof.test/agent/drishti',r.configuration_sha256,r.operation) is not null
 and (not exists(select 1 from public.monitoring_read_dispatches f where f.tenant_id=t and f.request_id=j)
  or exists(select 1 from public.monitoring_read_dispatches f where f.tenant_id=t and f.request_id=j and f.state='handed_off' and f.expires_at>clock_timestamp()
   and (controller_security.scheduled_read171_scope(t,f.scope_id,false)).id is not null)))
$$;

create function public.settle_monitoring_read_dispatch(p_tenant_id uuid,p_fire_id uuid,p_request_id uuid,p_worker_status text,p_cleanup_confirmed boolean)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare f public.monitoring_read_dispatches;r public.postgresql_discovery_requests;b public.monitoring_read_scopes;receipt bigint;ok boolean;
begin
 perform controller_security.local147_controller(p_tenant_id,true);
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 if p_worker_status is null or p_worker_status not in('read_completed','failed','unconfirmed') or p_cleanup_confirmed is null then raise exception 'supervisor outcome required' using errcode='22023';end if;
 select * into f from public.monitoring_read_dispatches where tenant_id=p_tenant_id and id=p_fire_id for update;
 if f.id is null or f.request_id is distinct from p_request_id then raise exception 'scheduled request binding refused' using errcode='42501';end if;
 if f.state<>'handed_off' then return controller_security.scheduled_read171_response(p_tenant_id,p_fire_id);end if;
 select * into r from public.postgresql_discovery_requests where tenant_id=p_tenant_id and id=p_request_id for update;
 b:=controller_security.scheduled_read171_scope(p_tenant_id,f.scope_id,true);
 ok:=b.id is not null and f.expires_at>clock_timestamp() and r.status='read_completed' and p_worker_status='read_completed' and p_cleanup_confirmed
  and r.operation='enumerate' and r.actor_id=b.actor_id and r.estate_id=b.estate_id and r.engagement_id=b.engagement_id and r.connector_id=b.connector_id and r.configuration_sha256=b.configuration_sha256
  and exists(select 1 from public.connector_discovery_runs d where d.tenant_id=p_tenant_id and d.id=r.discovery_run_id and d.correlation_id=r.id and d.grant_id=b.grant_id and d.connector_id=b.connector_id and d.operation='enumerate' and d.spiffe_id='spiffe://local.axiomproof.test/agent/drishti' and d.created_at>=r.claimed_at);
 receipt:=public.append_ledger(p_tenant_id,f.id,'agent','continuous-compliance-scheduler',null,null,null,'monitoring.schedule.fired',f.schedule_id::text,null,null,null,null,null,null,
  case when ok then 'success'::public.ledger_result else 'failure'::public.ledger_result end,
  jsonb_build_object('phase','scheduled_read_settled','fire_id',f.id,'scope_id',f.scope_id,'request_id',r.id,'outcome',case when ok then 'confirmed' else 'unconfirmed' end,'cleanup_confirmed',p_cleanup_confirmed));
 update public.postgresql_discovery_requests set status=case when ok then 'completed' else 'unconfirmed' end,completed_at=clock_timestamp(),cleanup_confirmed=p_cleanup_confirmed,error_code=case when ok then null else 'scheduled_read_unconfirmed' end where tenant_id=p_tenant_id and id=r.id;
 update public.monitoring_read_dispatches set state=case when ok then 'confirmed' else 'unconfirmed' end,finished_at=clock_timestamp(),cleanup_confirmed=p_cleanup_confirmed,receipt_id=receipt where id=f.id;
 perform controller_security.local147_controller(p_tenant_id,true);
 if ok and(f.expires_at<=clock_timestamp() or(controller_security.scheduled_read171_scope(p_tenant_id,b.id,false)).id is null) then raise exception 'scheduled read expired during settlement' using errcode='42501';end if;
 return controller_security.scheduled_read171_response(p_tenant_id,p_fire_id);
end $$;

-- The legacy bookkeeping loop cannot steal a due slot from an approved live
-- consumer. Historical fire readbacks and all unbound schedules remain intact.
alter function public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid) rename to fire_monitoring_schedule_legacy171;
alter function public.fire_monitoring_schedule_legacy171(uuid,uuid,uuid,text,text,timestamptz,uuid) set schema controller_security;
create function public.fire_monitoring_schedule(p_tenant_id uuid,p_schedule_id uuid,p_estate_id uuid,p_expected_kind text,p_expected_cadence text,p_expected_due_at timestamptz,p_correlation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare s public.monitoring_schedules;
begin
 select * into s from public.monitoring_schedules where tenant_id=p_tenant_id and id=p_schedule_id for update;
 if s.read_scope_id is not null and s.kind='rediscovery' and not exists(select 1 from public.monitoring_schedule_fires f where f.tenant_id=p_tenant_id and f.schedule_id=p_schedule_id and f.due_at=p_expected_due_at)
 then return jsonb_build_object('error','schedule_snapshot_changed');end if;
 return controller_security.fire_monitoring_schedule_legacy171(p_tenant_id,p_schedule_id,p_estate_id,p_expected_kind,p_expected_cadence,p_expected_due_at,p_correlation_id);
end $$;

create function controller_security.scheduled_read171_immutable_fire() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.id,new.tenant_id,new.scope_id,new.schedule_id,new.due_at,new.request_id,new.created_at,new.expires_at,new.fire_receipt_id)
  is distinct from(old.id,old.tenant_id,old.scope_id,old.schedule_id,old.due_at,old.request_id,old.created_at,old.expires_at,old.fire_receipt_id)
  or not((old.state='queued' and new.state in('handed_off','refused')) or(old.state='handed_off' and new.state in('confirmed','unconfirmed')))
 then raise exception 'scheduled read history immutable' using errcode='23514';end if;
 return new;
end $$;
create trigger scheduled_read171_identity before update on public.monitoring_read_dispatches for each row execute function controller_security.scheduled_read171_immutable_fire();

-- All capabilities are explicit. Private helper functions and the renamed
-- legacy implementation are not PostgREST or browser-callable bypasses.
do $$declare f record;r record;begin
 for f in select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where(n.nspname='controller_security' and(p.proname like 'scheduled_read171_%' or p.proname='fire_monitoring_schedule_legacy171'))
   or(n.nspname='public' and p.proname in('read_monitoring_read_scope_operation','preflight_monitoring_read_scope','record_monitoring_read_scope','read_monitoring_read_dispatch','reserve_monitoring_read_dispatch','claim_monitoring_read_dispatch','settle_monitoring_read_dispatch','issue_monitoring_read_mfa_challenge','satisfy_monitoring_read_mfa_challenge','consume_monitoring_read_mfa_challenge')) loop
  execute format('revoke all on function %s from public',f.signature);
  for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop execute format('revoke all on function %s from %I',f.signature,r.rolname);end loop;
 end loop;
end $$;
grant execute on function public.issue_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer),public.satisfy_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text),public.consume_monitoring_read_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;
grant execute on function public.read_monitoring_read_scope_operation(uuid,uuid,uuid,text),public.preflight_monitoring_read_scope(uuid,uuid,uuid,text,text) to service_role,human_action_writer;
grant execute on function public.record_monitoring_read_scope(uuid,uuid,uuid,text,text,uuid) to human_action_writer;
grant execute on function public.reserve_monitoring_read_dispatch(uuid),public.read_monitoring_read_dispatch(uuid,uuid),public.claim_monitoring_read_dispatch(uuid,uuid),public.settle_monitoring_read_dispatch(uuid,uuid,uuid,text,boolean) to axiom_assessment_controller;
revoke all on function public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid) to service_role;

create function public.monitoring_read_scope_context(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_schedule_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare sch public.monitoring_schedules;scopes jsonb;fires jsonb;targets jsonb;checks jsonb;engagements jsonb;
begin
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 select * into sch from public.monitoring_schedules where tenant_id=p_tenant_id and id=p_schedule_id;
 if sch.id is null then raise exception 'schedule required' using errcode='42501';end if;
 select coalesce(jsonb_agg(v.value order by v.created_at desc),'[]') into scopes from (
  select b.created_at,jsonb_build_object('scopeId',b.id,'expiresAt',b.expires_at,'receiptId',b.receipt_id::text,'reason',b.request_text::jsonb->>'reason','active',(controller_security.scheduled_read171_scope(b.tenant_id,b.id,false)).id is not null,
   'revoked',exists(select 1 from public.monitoring_read_revocations x where x.tenant_id=b.tenant_id and x.scope_id=b.id)) value
  from public.monitoring_read_scopes b where b.tenant_id=p_tenant_id and b.schedule_id=p_schedule_id order by b.created_at desc limit 20
 )v;
 select coalesce(jsonb_agg(v.value order by v.created_at desc),'[]') into fires from (
  select f.created_at,jsonb_build_object('fireId',f.id,'dueAt',f.due_at,'expiresAt',f.expires_at,'state',f.state,'cleanupConfirmed',f.cleanup_confirmed,'requestId',f.request_id,'receiptId',f.receipt_id::text) value
  from public.monitoring_read_dispatches f where f.tenant_id=p_tenant_id and f.schedule_id=p_schedule_id order by f.created_at desc limit 20
 )v;
 select coalesce(jsonb_agg(v.value),'[]') into targets from (
  select jsonb_build_object('connectorId',c.id,'name',c.name,'configurationSha256',d.configuration_sha256,'grantId',g.value->>'grantId','maxExpiresAt',g.value->>'grantExpiresAt') value
  from public.connectors c join public.postgresql_sandbox_deployments d on d.tenant_id=c.tenant_id and d.connector_id=c.id
  join lateral(select public.resolve_sandbox_postgresql_read_grant_for_operation(p_tenant_id,sch.estate_id,c.id,'spiffe://local.axiomproof.test/agent/drishti',d.configuration_sha256,'enumerate')value)g on g.value is not null
  where c.tenant_id=p_tenant_id order by c.id limit 20
 )v;
 select coalesce(jsonb_agg(v.value order by v.completed_at desc),'[]') into checks from (
  select r.completed_at,jsonb_build_object('requestId',r.id,'connectorId',r.connector_id,'engagementId',r.engagement_id,'configurationSha256',r.configuration_sha256,'grantId',d.grant_id,'completedAt',r.completed_at) value
  from public.postgresql_discovery_requests r join public.connector_discovery_runs d on d.tenant_id=r.tenant_id and d.id=r.discovery_run_id
  where r.tenant_id=p_tenant_id and r.actor_id=p_actor_id and r.estate_id=sch.estate_id and r.operation='enumerate' and r.status='completed' and r.cleanup_confirmed and r.completed_at>clock_timestamp()-interval '5 minutes'
   and d.correlation_id=r.id and d.operation='enumerate'
  order by r.completed_at desc limit 20
 )v;
 select coalesce(jsonb_agg(v.value),'[]') into engagements from(select jsonb_build_object('id',e.id,'title',e.title)value from public.engagements e where e.tenant_id=p_tenant_id and e.estate_id=sch.estate_id and e.status<>'cancelled' order by e.created_at desc limit 20)v;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'scheduleId',sch.id,'estateId',sch.estate_id,'cadence',sch.cadence,'kind',sch.kind,'status',sch.status,'scopeId',sch.read_scope_id,
  'scopes',scopes,'fires',fires,'targets',targets,'preflights',checks,'engagements',engagements);
end $$;
revoke all on function public.monitoring_read_scope_context(uuid,uuid,uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.monitoring_read_scope_context(uuid,uuid,uuid,uuid) to service_role;

create function public.fence_monitoring_read_scope(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_phase text)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare v jsonb;old jsonb;receipt bigint;d public.monitoring_read_decisions;digest text;binding text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human scope fence writer required' using errcode='42501';end if;
 perform controller_security.scheduled_read171_owner(p_tenant_id,p_actor_id,p_session_id);
 if p_phase is null or p_phase not in('authorize','revoke') or p_request_text is null or octet_length(p_request_text)>16384 then raise exception 'scope intent required' using errcode='22023';end if;
 v:=p_request_text::jsonb;digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text or v->'schemaVersion' is distinct from '1'::jsonb or v->>'operationKey' is null then raise exception 'canonical scope intent required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(v->>'operationKey',171));
 old:=public.read_monitoring_read_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 if old->>'recorded'='true' or old->>'fenced'='true' then return old;end if;
 select * into d from public.monitoring_read_decisions where operation_key=(v->>'operationKey')::uuid;
 if d.operation_key is not null then
  binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.monitoring-read.'||p_phase,1,p_tenant_id::text,p_actor_id::text,d.session_id::text,digest)),'UTF8')),'hex');
  if d.tenant_id<>p_tenant_id or d.actor_id<>p_actor_id or d.binding_sha256<>binding then raise exception 'scope decision differs' using errcode='23505';end if;
 end if;
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'connector.updated',null,digest,null,null,null,null,null,'success',jsonb_build_object('phase','scheduled_read_intent_fenced','request_sha256',digest,'scope_phase',p_phase));
 insert into public.monitoring_read_fences(operation_key,tenant_id,actor_id,session_id,phase,request_text,request_sha256,receipt_id)
 values((v->>'operationKey')::uuid,p_tenant_id,p_actor_id,p_session_id,p_phase,p_request_text,digest,receipt);
 return public.read_monitoring_read_scope_operation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
end $$;
revoke all on function public.fence_monitoring_read_scope(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.fence_monitoring_read_scope(uuid,uuid,uuid,text,text) to human_action_writer;
