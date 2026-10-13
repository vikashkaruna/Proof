-- Unmounted dedicated controller foundation. No credential records, role
-- memberships, network channel or worker credentials are provisioned here.
-- PostgreSQL locks persisted authority. The trusted controller MUST verify the
-- real JWT-SVID and current human session; external trust/session revocation
-- continuity is not proved by caller metadata or this transaction.
do $$begin
 if not exists(select 1 from pg_roles where rolname='axiom_prativedan_controller') then
  create role axiom_prativedan_controller nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
end $$;

-- PostgreSQL 17 may give the migration creator ADMIN-only membership. That
-- cannot assume or inherit the role; every other inbound membership is refused.
create function controller_security.prativedan126_role_safe() returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from pg_catalog.pg_roles where rolname='axiom_prativedan_controller'
  and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
 and not exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member
  where r.rolname='axiom_prativedan_controller')
 and not exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid
  where r.rolname='axiom_prativedan_controller' and
   (m.set_option or m.inherit_option or not m.admin_option or
    m.member<>(select oid from pg_catalog.pg_roles where rolname=current_user)))
$$;
do $$begin
 if controller_security.prativedan126_role_safe() is distinct from true
 then raise exception 'Prativedan controller role refused';end if;
end $$;

grant usage on schema public to axiom_prativedan_controller;
create table controller_security.prativedan_credentials (
 id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,revoked_at timestamptz,
 check(expires_at>created_at and expires_at<=created_at+interval '24 hours')
);
revoke all on controller_security.prativedan_credentials from public,anon,authenticated,service_role,
 human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;

create function controller_security.prativedan126_credential(t uuid) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare claims jsonb;credential controller_security.prativedan_credentials;issued numeric;expiry numeric;
begin
 if current_setting('role',true) is distinct from 'axiom_prativedan_controller'
 then raise exception 'exclusive controller required' using errcode='42501';end if;
 claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 if claims->>'role' is distinct from 'axiom_prativedan_controller'
  or jsonb_typeof(claims->'iat') is distinct from 'number' or jsonb_typeof(claims->'exp') is distinct from 'number'
  or claims->>'tenant_id' is distinct from t::text then raise exception 'controller credential refused' using errcode='42501';end if;
 issued:=(claims->>'iat')::numeric;expiry:=(claims->>'exp')::numeric;
 if issued<>trunc(issued) or expiry<>trunc(expiry) or issued>extract(epoch from clock_timestamp())
  or expiry<=extract(epoch from clock_timestamp()) or expiry<=issued or expiry-issued>3600
 then raise exception 'controller credential expiry refused' using errcode='42501';end if;
 select * into credential from controller_security.prativedan_credentials where id=(claims->>'sub')::uuid for share;
 if not found or credential.tenant_id is distinct from t or credential.revoked_at is not null
  or credential.expires_at<=clock_timestamp() or extract(epoch from credential.expires_at)<expiry
 then raise exception 'controller credential registry refused' using errcode='42501';end if;
 return to_timestamp(expiry::double precision);
exception when invalid_text_representation or numeric_value_out_of_range then
 raise exception 'controller credential refused' using errcode='42501';
end $$;

create table public.prativedan_controller_admissions (
 tenant_id uuid not null,operation_key uuid not null,
 actor_id uuid not null references public.users(id) on delete restrict,
 session_id uuid not null,workload_id uuid not null references public.workload_identities(id) on delete restrict,
 registration_version integer not null check(registration_version>0),subject text not null,
 svid_expires_at timestamptz not null,
 primary key(tenant_id,operation_key),
 foreign key(tenant_id,operation_key) references public.prativedan_draft_claims(tenant_id,operation_key) on delete restrict
);
create table public.prativedan_controller_phases (
 tenant_id uuid not null,operation_key uuid not null,phase text not null check(phase in ('started','completed')),
 receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 observed_at timestamptz not null default clock_timestamp(),output_sha256 text,
 primary key(tenant_id,operation_key,phase),
 foreign key(tenant_id,operation_key) references public.prativedan_controller_admissions(tenant_id,operation_key) on delete restrict,
 check((phase='started' and output_sha256 is null) or
  (phase='completed' and output_sha256 is not null and output_sha256 ~ '^[a-f0-9]{64}$'))
);

-- Only the exclusive credential custodian can supply this verified identity
-- context. It is NOT an SVID verifier or an auth-session authority in SQL.
create function controller_security.prativedan126_authorize(t uuid,k uuid,r uuid,rh text,authority jsonb)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;s public.prativedan_assessment_sources;
 w public.workload_identities;att public.mfa_session_attestations;factor public.user_mfa_factors;
 credential_expiry timestamptz;identity_expiry timestamptz;admission public.prativedan_controller_admissions;
 actor uuid;session uuid;
begin
 credential_expiry:=controller_security.prativedan126_credential(t);
 if jsonb_typeof(authority) is distinct from 'object'
  or not(authority ?& array['actor_id','session_id','workload_id','registration_version','subject','svid_expires_at'])
  or (authority-array['actor_id','session_id','workload_id','registration_version','subject','svid_expires_at'])<>'{}'
  or jsonb_typeof(authority->'registration_version') is distinct from 'number'
  or authority->>'registration_version' !~ '^[1-9][0-9]*$'
 then raise exception 'verified controller context required' using errcode='42501';end if;
 actor:=(authority->>'actor_id')::uuid;session:=(authority->>'session_id')::uuid;
 identity_expiry:=(authority->>'svid_expires_at')::timestamptz;
 if actor is null or session is null or actor='00000000-0000-0000-0000-000000000000'
  or session='00000000-0000-0000-0000-000000000000' or identity_expiry is null
  or identity_expiry<=clock_timestamp() or identity_expiry>clock_timestamp()+interval '5 minutes'
 then raise exception 'verified identity expiry refused' using errcode='42501';end if;
 select * into w from public.workload_identities where id=(authority->>'workload_id')::uuid for share;
 if not found or w.tenant_id is distinct from t or w.agent_name is distinct from 'prativedan'
  or w.status is distinct from 'active' or w.version::text is distinct from authority->>'registration_version'
  or w.spiffe_id is distinct from authority->>'subject'
  or w.spiffe_id !~ '^spiffe://[a-z0-9]([a-z0-9.-]*[a-z0-9])?/agent/prativedan$'
 then raise exception 'live registration refused' using errcode='42501';end if;
 if not controller_security.prativedan123_authority(t,actor)
 then raise exception 'live founder authority refused' using errcode='42501';end if;
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k for share;
 if not found or q.actor_id is distinct from actor or q.run_id is distinct from r or q.request_sha256 is distinct from rh
 then raise exception 'original reviewed request refused' using errcode='42501';end if;
 -- Lock the authenticator before its attestation, matching factor retirement.
 select * into factor from public.user_mfa_factors where user_id=actor and factor_type='totp' and status='active' for share;
 if not found or factor.revoked_at is not null then raise exception 'active MFA factor refused' using errcode='42501';end if;
 select * into att from public.mfa_session_attestations where user_id=actor and session_id=session::text
  and factor_id=factor.id and revoked_at is null and expires_at>clock_timestamp()
 order by expires_at desc limit 1 for share;
 if not found or att.satisfied_at>clock_timestamp() then raise exception 'live session MFA refused' using errcode='42501';end if;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 if not found or controller_security.prativedan123_input(t,s.engagement_id,s.source_id) is distinct from s.renderer_input_projection
 then raise exception 'frozen assessment authority changed' using errcode='42501';end if;
 select * into admission from public.prativedan_controller_admissions where tenant_id=t and operation_key=k;
 if found and (admission.actor_id is distinct from actor or admission.session_id is distinct from session
  or admission.workload_id is distinct from w.id or admission.registration_version is distinct from w.version
  or admission.subject is distinct from w.spiffe_id)
 then raise exception 'claimed identity scope changed' using errcode='42501';end if;
 return least(credential_expiry,identity_expiry,att.expires_at);
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
 raise exception 'verified controller context refused' using errcode='42501';
end $$;

-- Existing private source/settlement validators are preserved. Old public
-- signatures will have no EXECUTE grants; only context-bearing wrappers call them.
create or replace function controller_security.prativedan123_runtime_request(t uuid,k uuid,r uuid,rh text)
returns public.prativedan_draft_requests language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;
begin
 perform controller_security.prativedan126_credential(t);
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 if not found or q.run_id is distinct from r or q.request_sha256 is distinct from rh
  or not controller_security.prativedan123_authority(t,q.actor_id)
 then raise exception 'recorded request authority refused' using errcode='42501';end if;
 return q;
end $$;

create function public.load_prativedan_assessment_dispatch(t uuid,k uuid,r uuid,rh text,authority jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 return controller_security.prativedan123_read(t,k);
end $$;
create function public.claim_prativedan_assessment_draft(t uuid,k uuid,r uuid,rh text,input_text text,authority jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare q public.prativedan_draft_requests;s public.prativedan_assessment_sources;c public.prativedan_draft_claims;
 deadline timestamptz;stamp timestamptz;receipt bigint;ih text;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 deadline:=controller_security.prativedan126_authorize(t,k,r,rh,authority);
 q:=controller_security.prativedan123_runtime_request(t,k,r,rh);
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 if controller_security.prativedan123_json(input_text,1048576) is distinct from s.renderer_input_projection
 then raise exception 'normalized source projection refused' using errcode='42501';end if;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 if found then
  if c.normalized_input_text is distinct from input_text then raise exception 'claim input conflict' using errcode='42501';end if;
  return jsonb_build_object('claimed',false,'invocation_uncertain',true,'readback',controller_security.prativedan123_read(t,k));
 end if;
 stamp:=clock_timestamp();deadline:=least(deadline,stamp+interval '5 minutes');ih:=controller_security.prativedan123_hash(input_text);
 if deadline<=stamp then raise exception 'claim authority expired' using errcode='42501';end if;
 receipt:=public.append_ledger(t,k,'system','prativedan-draft-controller','0.1.0',null,null,'prativedan.draft.claimed',r::text,
  ih,null,null,null,null,null,'pending',jsonb_build_object('run_id',r,'request_hash',rh,'source_sha256',s.source_sha256,
   'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text),'one_shot',true));
 if deadline<=clock_timestamp() then raise exception 'claim authority expired during receipt' using errcode='42501';end if;
 insert into public.prativedan_draft_claims(tenant_id,operation_key,normalized_input_text,runtime_normalized_input_sha256,claimed_receipt,claimed_at,expires_at)
 values(t,k,input_text,ih,receipt,stamp,deadline);
 insert into public.prativedan_controller_admissions(tenant_id,operation_key,actor_id,session_id,workload_id,registration_version,subject,svid_expires_at)
 values(t,k,(authority->>'actor_id')::uuid,(authority->>'session_id')::uuid,(authority->>'workload_id')::uuid,
  (authority->>'registration_version')::integer,authority->>'subject',(authority->>'svid_expires_at')::timestamptz);
 return jsonb_build_object('claimed',true,'expires_at',deadline,'readback',controller_security.prativedan123_read(t,k));
end $$;

create function controller_security.prativedan126_phase_valid(t uuid,k uuid,phase_name text) returns boolean
language plpgsql security definer set search_path='' as $$
declare p public.prativedan_controller_phases;entry public.audit_ledger;q public.prativedan_draft_requests;
 c public.prativedan_draft_claims;s public.prativedan_assessment_sources;started bigint;expected jsonb;
begin
 select * into p from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase=phase_name;
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 select * into entry from public.audit_ledger where tenant_id=t and id=p.receipt;
 if p.receipt is null or q.run_id is null or c.claimed_receipt is null or entry.id is null
  or p.observed_at<c.claimed_at or p.observed_at>c.expires_at or c.claimed_receipt>=p.receipt
  or entry.actor_type is distinct from 'agent' or entry.actor_id is distinct from 'prativedan'
  or entry.agent_version is distinct from '0.1.0' or entry.action_type::text is distinct from 'report.generated'
  or entry.correlation_id is distinct from k or entry.target_ref is distinct from s.engagement_id::text
  or entry.input_hash is distinct from c.runtime_normalized_input_sha256
  or entry.model_id is not null or entry.prompt_hash is not null
  or entry.approval_token_id is not null or entry.approver_id is not null
  or entry.pre_state_ref is not null or entry.post_state_ref is not null
 then return false;end if;
 expected:=jsonb_build_object('phase',phase_name,'run_id',q.run_id,'request_hash',q.request_sha256,
  'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text));
 if phase_name='started' then
  return entry.result='pending' and entry.output_hash is null and entry.detail=expected;
 end if;
 select phase_row.receipt into started from public.prativedan_controller_phases phase_row where phase_row.tenant_id=t and phase_row.operation_key=k and phase_row.phase='started';
 return coalesce(started<p.receipt and entry.result='success'
  and entry.output_hash=p.output_sha256
  and entry.detail=expected||jsonb_build_object('started_entry',started::text),false);
end $$;

create function public.record_prativedan_assessment_phase(t uuid,k uuid,r uuid,rh text,phase_name text,output_hash text,authority jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare q public.prativedan_draft_requests;c public.prativedan_draft_claims;s public.prativedan_assessment_sources;
 old public.prativedan_controller_phases;receipt bigint;started bigint;detail jsonb;deadline timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 deadline:=controller_security.prativedan126_authorize(t,k,r,rh,authority);
 q:=controller_security.prativedan123_runtime_request(t,k,r,rh);
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 if c.claimed_receipt is null or phase_name is null or phase_name not in ('started','completed')
  or not exists(select 1 from public.prativedan_controller_admissions where tenant_id=t and operation_key=k)
  or (phase_name='started' and output_hash is not null) or (phase_name='completed' and output_hash is null)
 then raise exception 'dedicated phase refused' using errcode='42501';end if;
 select * into old from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase=phase_name;
 if found then
  if old.output_sha256 is distinct from output_hash or controller_security.prativedan126_phase_valid(t,k,phase_name) is distinct from true
  then raise exception 'phase replay conflict' using errcode='42501';end if;
  return controller_security.prativedan123_receipt(t,old.receipt);
 end if;
 deadline:=least(deadline,c.expires_at);
 if deadline<=clock_timestamp() then raise exception 'phase authority expired' using errcode='42501';end if;
 detail:=jsonb_build_object('phase',phase_name,'run_id',r,'request_hash',rh,
  'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text));
 if phase_name='completed' then
  if output_hash !~ '^[a-f0-9]{64}$' or controller_security.prativedan126_phase_valid(t,k,'started') is distinct from true
  then raise exception 'dedicated completion refused' using errcode='42501';end if;
  select phase_row.receipt into started from public.prativedan_controller_phases phase_row where phase_row.tenant_id=t and phase_row.operation_key=k and phase_row.phase='started';
  detail:=detail||jsonb_build_object('started_entry',started::text);
 end if;
 receipt:=public.append_ledger(t,k,'agent','prativedan','0.1.0',null,null,'report.generated',s.engagement_id::text,
  c.runtime_normalized_input_sha256,output_hash,
  null,null,null,null,case when phase_name='started' then 'pending'::public.ledger_result else 'success'::public.ledger_result end,detail);
 if deadline<=clock_timestamp() then raise exception 'phase expired during receipt' using errcode='42501';end if;
 insert into public.prativedan_controller_phases(tenant_id,operation_key,phase,receipt,output_sha256)
 values(t,k,phase_name,receipt,output_hash);
 return controller_security.prativedan123_receipt(t,receipt);
end $$;

create function public.read_prativedan_assessment_runtime_receipts(t uuid,k uuid,r uuid,rh text,started bigint,completed bigint,authority jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 if controller_security.prativedan126_phase_valid(t,k,'started') is distinct from true
  or controller_security.prativedan126_phase_valid(t,k,'completed') is distinct from true
  or not exists(select 1 from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase='started' and receipt=started)
  or not exists(select 1 from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase='completed' and receipt=completed)
 then raise exception 'exclusive runtime receipts refused' using errcode='42501';end if;
 return public.read_prativedan_assessment_runtime_receipts(t,k,r,rh,started,completed);
end $$;
create function public.settle_prativedan_assessment_draft(t uuid,k uuid,r uuid,rh text,input_hash text,
 config_text text,output_text text,response_text text,started bigint,completed bigint,authority jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 perform public.read_prativedan_assessment_runtime_receipts(t,k,r,rh,started,completed,authority);
 if not exists(select 1 from public.prativedan_controller_phases where tenant_id=t and operation_key=k
  and phase='completed' and receipt=completed and output_sha256=controller_security.prativedan123_hash(output_text))
 then raise exception 'recorded completion bytes refused' using errcode='42501';end if;
 return public.settle_prativedan_assessment_draft(t,k,r,rh,input_hash,config_text,output_text,response_text,started,completed);
end $$;

-- A second unreferenced dedicated phase cannot masquerade as a valid receipt.
create function controller_security.prativedan126_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare t uuid;k uuid;phase_name text;
begin
 if tg_table_name='prativedan_controller_phases' then
  t:=new.tenant_id;k:=new.operation_key;phase_name:=new.phase;
 else
  select tenant_id,operation_key into t,k from public.prativedan_draft_requests
   where tenant_id=new.tenant_id and run_id::text=new.detail->>'run_id';
  if not found then return null;end if;
  select phase into phase_name from public.prativedan_controller_phases where tenant_id=t and operation_key=k and receipt=new.id;
 end if;
 if phase_name is null or controller_security.prativedan126_phase_valid(t,k,phase_name) is distinct from true
 then raise exception 'exclusive phase receipt binding refused' using errcode='23514';end if;
 return null;
end $$;
create constraint trigger prativedan_controller_phase_binding after insert on public.prativedan_controller_phases
 deferrable initially deferred for each row execute function controller_security.prativedan126_binding();
create constraint trigger prativedan_controller_ledger_binding after insert on public.audit_ledger
 deferrable initially deferred for each row when(new.action_type::text='report.generated')
 execute function controller_security.prativedan126_binding();

-- Preserve generic and legacy Board report behavior; refuse only dedicated
-- draft events and report phases naming a recorded dedicated draft run.
alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0126;
revoke all on function controller_security.append_agent_ledger_before_0126(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
 p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text in ('prativedan.draft.requested','prativedan.draft.claimed','prativedan.draft.settled','prativedan.draft.reviewed')
  or (p_action_type::text='report.generated' and exists(select 1 from public.prativedan_draft_requests
   where tenant_id=p_tenant_id and run_id::text=p_detail->>'run_id'))
 then raise exception 'dedicated controller receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0126(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
  p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

do $$declare tab text;f record;begin
 foreach tab in array array['prativedan_controller_admissions','prativedan_controller_phases'] loop
  execute format('alter table public.%I enable row level security',tab);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller',tab);
  execute format('create trigger immutable_controller_record before update or delete on public.%I for each row execute function public.evidence_receipt_immutable()',tab);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='controller_security' and (p.proname like 'prativedan126_%' or p.proname='prativedan123_runtime_request') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller',f.signature);
 end loop;
 -- Revoke every old overload, not just grant the replacement to a new role.
 for f in select p.oid::regprocedure signature,p.proname,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('load_prativedan_assessment_dispatch','claim_prativedan_assessment_draft',
   'read_prativedan_assessment_runtime_receipts','settle_prativedan_assessment_draft','record_prativedan_assessment_phase') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller',f.signature);
  if (f.proname='load_prativedan_assessment_dispatch' and f.pronargs=5)
   or (f.proname='claim_prativedan_assessment_draft' and f.pronargs=6)
   or (f.proname='read_prativedan_assessment_runtime_receipts' and f.pronargs=7)
   or (f.proname='settle_prativedan_assessment_draft' and f.pronargs=11)
   or (f.proname='record_prativedan_assessment_phase' and f.pronargs=7)
  then execute format('grant execute on function %s to axiom_prativedan_controller',f.signature);end if;
 end loop;
end $$;
