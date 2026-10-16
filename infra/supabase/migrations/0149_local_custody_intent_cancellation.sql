-- Additive actor-owned intent abandonment only. No policy/head/grant mutation.
alter type public.ledger_action_type add value if not exists 'custody.local_policy_intent_cancelled';
create table public.local_custody_intent_cancellations (
 id uuid primary key,tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,operation_key uuid not null,
 original_operation_key uuid not null,original_request_text text not null check(octet_length(original_request_text) between 2 and 32768),
 original_request_sha256 text not null check(original_request_sha256 ~ '^[a-f0-9]{64}$'),
 cancellation_text text not null check(octet_length(cancellation_text) between 2 and 65000),
 cancellation_sha256 text not null check(cancellation_sha256 ~ '^[a-f0-9]{64}$'),
 session_id uuid not null,challenge_id uuid not null references public.mfa_challenges(id) on delete restrict,
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 check(operation_key<>original_operation_key),unique(tenant_id,actor_id,operation_key),
 unique(tenant_id,actor_id,original_operation_key),unique(challenge_id),unique(tenant_id,receipt_id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict
);
alter table public.local_custody_intent_cancellations enable row level security;
revoke all on public.local_custody_intent_cancellations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier,axiom_local_custody_issuer;
create trigger local149_immutable before update or delete on public.local_custody_intent_cancellations for each row execute function public.evidence_receipt_immutable();
create trigger local149_no_truncate before truncate on public.local_custody_intent_cancellations for each statement execute function public.evidence_receipt_immutable();

create function controller_security.local149_request(p_text text) returns jsonb language plpgsql immutable set search_path='' as $$
declare c jsonb;r jsonb;p jsonb;
begin
 if p_text is null or octet_length(p_text)>65000 then raise exception 'custody cancellation refused' using errcode='22023';end if;
 c:=p_text::jsonb;
 if jsonb_typeof(c) is distinct from 'object' or (select count(*) from jsonb_object_keys(c))<>5
  or c-array['version','operationKey','originalRequestText','reason','confirmed']<>'{}'::jsonb
  or controller_security.canonical_questionnaire_json(c) is distinct from p_text
  or c->'version' is distinct from '1'::jsonb or c->'confirmed' is distinct from 'true'::jsonb
  or jsonb_typeof(c->'reason') is distinct from 'string' or length(c->>'reason') not between 1 and 2000 or c->>'reason' !~ '[^[:space:]]'
  or jsonb_typeof(c->'operationKey') is distinct from 'string' or c->>'operationKey' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  or jsonb_typeof(c->'originalRequestText') is distinct from 'string' or octet_length(c->>'originalRequestText')>32768
 then raise exception 'custody cancellation refused' using errcode='22023';end if;
 r:=(c->>'originalRequestText')::jsonb;p:=controller_security.local143_policy(r->>'policyText');
 if jsonb_typeof(r) is distinct from 'object' or (select count(*) from jsonb_object_keys(r))<>9
  or r-array['version','operationKey','transition','policyText','policySha256','previousEventId','nextReviewDueAt','reason','confirmed']<>'{}'::jsonb
  or controller_security.canonical_questionnaire_json(r) is distinct from c->>'originalRequestText'
  or r->'version' is distinct from '1'::jsonb or r->'confirmed' is distinct from 'true'::jsonb
  or jsonb_typeof(r->'operationKey') is distinct from 'string' or r->>'operationKey' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  or r->>'operationKey'=c->>'operationKey' or r->>'transition' is null or r->>'transition' not in ('request','approve','activate','revoke','review')
  or r->>'policySha256' is distinct from encode(sha256(convert_to(r->>'policyText','UTF8')),'hex')
  or jsonb_typeof(r->'reason') is distinct from 'string' or length(r->>'reason') not between 1 and 2000 or r->>'reason' !~ '[^[:space:]]'
  or (r->>'transition'='request') is distinct from (r->'previousEventId'='null'::jsonb)
  or (r->>'transition'<>'request' and (r->>'previousEventId' is null or r->>'previousEventId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
  or (r->>'transition'='review') is distinct from (jsonb_typeof(r->'nextReviewDueAt')='number')
  or (r->>'transition'<>'review' and r->'nextReviewDueAt' is distinct from 'null'::jsonb)
 then raise exception 'custody original request refused' using errcode='22023';end if;
 if r->>'transition'='review' and ((r->>'nextReviewDueAt')::numeric not between 1 and 9007199254740991 or trunc((r->>'nextReviewDueAt')::numeric)<>(r->>'nextReviewDueAt')::numeric) then raise exception 'custody original reminder refused' using errcode='22023';end if;
 return c;
end $$;
create function controller_security.local149_result(c public.local_custody_intent_cancellations,p_replayed boolean) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state','cancelled','tenantId',c.tenant_id,'actorId',c.actor_id,'operationKey',c.operation_key,'originalOperationKey',c.original_operation_key,'originalRequestText',c.original_request_text,'originalRequestSha256',c.original_request_sha256,'cancellationText',c.cancellation_text,'cancellationSha256',c.cancellation_sha256,'cancellationId',c.id,'receipt',jsonb_build_object('id',l.id::text,'entryHash',l.entry_hash),'replayed',p_replayed) from public.audit_ledger l where l.tenant_id=c.tenant_id and l.id=c.receipt_id
$$;
-- Sanctioned143 writer already holds47 before any row locks. This trigger fences
-- every event insertion and rolls back its same-transaction ledger/version writes.
create function controller_security.local149_event_fence() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text,47));
 if exists(select 1 from public.local_custody_intent_cancellations c where c.tenant_id=new.tenant_id and c.actor_id=new.actor_id and (c.original_operation_key=new.operation_key or c.operation_key=new.operation_key)) then raise exception 'custody intent cancelled' using errcode='23505';end if;
 return new;
end $$;
create trigger local149_event_fence before insert on public.local_custody_policy_events for each row execute function controller_security.local149_event_fence();

create function public.read_local_custody_policy_outcome(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;r jsonb;c public.local_custody_intent_cancellations;
begin
 result:=public.read_local_custody_policy_event(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 if result->>'state'='recorded' then return result;end if;
 r:=p_request_text::jsonb;
 if exists(select 1 from public.local_custody_intent_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(r->>'operationKey')::uuid) then raise exception 'custody operation conflict' using errcode='23505';end if;
 select * into c from public.local_custody_intent_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and original_operation_key=(r->>'operationKey')::uuid;
 if not found then return result;end if;
 if c.original_request_text is distinct from p_request_text then raise exception 'custody operation conflict' using errcode='23505';end if;
 return controller_security.local149_result(c,true);
end $$;
create function public.read_local_custody_policy_cancellation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;result jsonb;saved public.local_custody_intent_cancellations;
begin
 c:=controller_security.local149_request(p_request_text);
 result:=public.read_local_custody_policy_outcome(p_tenant_id,p_actor_id,p_session_id,c->>'originalRequestText');
 if result->>'state'='recorded' then return result;end if;
 if result->>'state'='cancelled' then
  if result->>'cancellationText' is distinct from p_request_text then raise exception 'custody cancellation conflict' using errcode='23505';end if;
  return result;
 end if;
 if exists(select 1 from public.local_custody_policy_events where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(c->>'operationKey')::uuid)
  or exists(select 1 from public.local_custody_intent_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and (operation_key=(c->>'operationKey')::uuid or original_operation_key=(c->>'operationKey')::uuid))
 then raise exception 'custody cancellation operation conflict' using errcode='23505';end if;
 return result;
end $$;
create function public.preflight_local_custody_policy_cancellation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;result jsonb;
begin
 c:=controller_security.local149_request(p_request_text);
 result:=public.read_local_custody_policy_cancellation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 if result->>'state'<>'not_found' then raise exception 'custody cancellation already resolved' using errcode='23505';end if;
 return jsonb_build_object('authorized',true,'tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,'operationKey',c->>'operationKey','requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'));
end $$;
create function public.record_local_custody_policy_cancellation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_challenge_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;r jsonb;p jsonb;result jsonb;challenge public.mfa_challenges;now_at timestamptz;binding text;digest text;original_digest text;receipt bigint;cancel_id uuid;saved public.local_custody_intent_cancellations;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human custody writer required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null then raise exception 'custody actor required' using errcode='42501';end if;
 c:=controller_security.local149_request(p_request_text);r:=(c->>'originalRequestText')::jsonb;p:=controller_security.local143_policy(r->>'policyText');
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 result:=public.read_local_custody_policy_cancellation(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 if result->>'state'<>'not_found' then return result;end if;
 -- Current reader/session validation was repeated under row locks above. No
 -- transition, predecessor, policy existence, active or review-date requirement.
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into challenge from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');original_digest:=encode(sha256(convert_to(c->>'originalRequestText','UTF8')),'hex');
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local-custody.cancel',1,p_tenant_id::text,p_actor_id::text,p_session_id::text,digest)),'UTF8')),'hex');
 if challenge.id is null or challenge.user_id is distinct from p_actor_id or challenge.tenant_id is distinct from p_tenant_id
  or challenge.purpose::text is distinct from 'local_custody_policy' or challenge.bound_resource_ref is distinct from c->>'operationKey'
  or challenge.bound_payload_sha256 is distinct from binding or challenge.consumed_for is distinct from c->>'operationKey'
  or challenge.satisfied_at is null or challenge.consumed_at is null or challenge.created_at>challenge.satisfied_at
  or challenge.expires_at>challenge.created_at+interval '5 minutes' or challenge.satisfied_at>now_at or challenge.satisfied_at<=now_at-interval '5 minutes' or challenge.expires_at<=now_at
  or challenge.consumed_at<challenge.satisfied_at or challenge.consumed_at>now_at
  or not exists(select 1 from public.user_mfa_factors where id=challenge.factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
  or exists(select 1 from public.local_custody_policy_events where challenge_id=p_challenge_id)
  or exists(select 1 from public.local_custody_intent_cancellations where challenge_id=p_challenge_id)
 then raise exception 'fresh custody cancellation MFA required' using errcode='42501';end if;
 -- Session expiry can elapse during a factor/challenge wait.
 if not controller_security.local143_reader(p_tenant_id,p_actor_id,p) or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at)) then raise exception 'custody cancellation authority retired' using errcode='42501';end if;
 cancel_id:=pg_catalog.gen_random_uuid();
 receipt:=public.append_ledger(p_tenant_id,(c->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'custody.local_policy_intent_cancelled',cancel_id::text,digest,original_digest,null,null,null,null,'success',jsonb_build_object('cancellation_id',cancel_id,'original_operation_key',r->>'operationKey','original_request_sha256',original_digest,'reason_sha256',encode(sha256(convert_to(c->>'reason','UTF8')),'hex')));
 insert into public.local_custody_intent_cancellations(id,tenant_id,actor_id,operation_key,original_operation_key,original_request_text,original_request_sha256,cancellation_text,cancellation_sha256,session_id,challenge_id,receipt_id) values(cancel_id,p_tenant_id,p_actor_id,(c->>'operationKey')::uuid,(r->>'operationKey')::uuid,c->>'originalRequestText',original_digest,p_request_text,digest,p_session_id,p_challenge_id,receipt);
 select * into saved from public.local_custody_intent_cancellations where id=cancel_id;
 return controller_security.local149_result(saved,false);
end $$;

create function controller_security.local149_receipt_binding() returns trigger language plpgsql security definer set search_path='' as $$
declare c public.local_custody_intent_cancellations;l public.audit_ledger;r jsonb;o jsonb;
begin
 if tg_table_name='audit_ledger' then
  if new.action_type::text<>'custody.local_policy_intent_cancelled' then return null;end if;
  l:=new;select * into c from public.local_custody_intent_cancellations where tenant_id=l.tenant_id and receipt_id=l.id;
 else c:=new;select * into l from public.audit_ledger where tenant_id=c.tenant_id and id=c.receipt_id;end if;
 if c.id is null or l.id is null then raise exception 'custody cancellation reciprocal receipt missing' using errcode='23514';end if;
 r:=controller_security.local149_request(c.cancellation_text);o:=c.original_request_text::jsonb;
 if r->>'originalRequestText' is distinct from c.original_request_text or r->>'operationKey' is distinct from c.operation_key::text or o->>'operationKey' is distinct from c.original_operation_key::text
  or controller_security.local143_policy(o->>'policyText')->>'tenantId' is distinct from c.tenant_id::text
  or c.cancellation_sha256 is distinct from encode(sha256(convert_to(c.cancellation_text,'UTF8')),'hex') or c.original_request_sha256 is distinct from encode(sha256(convert_to(c.original_request_text,'UTF8')),'hex')
  or exists(select 1 from public.local_custody_policy_events where tenant_id=c.tenant_id and actor_id=c.actor_id and operation_key in(c.original_operation_key,c.operation_key))
  or l.actor_type::text is distinct from 'human' or l.actor_id is distinct from c.actor_id::text or l.correlation_id is distinct from c.operation_key or l.action_type::text is distinct from 'custody.local_policy_intent_cancelled'
  or l.target_ref is distinct from c.id::text or l.input_hash is distinct from c.cancellation_sha256 or l.output_hash is distinct from c.original_request_sha256 or l.result::text is distinct from 'success'
  or l.detail is distinct from jsonb_build_object('cancellation_id',c.id,'original_operation_key',c.original_operation_key,'original_request_sha256',c.original_request_sha256,'reason_sha256',encode(sha256(convert_to(r->>'reason','UTF8')),'hex'))
 then raise exception 'custody cancellation reciprocal receipt refused' using errcode='23514';end if;
 return null;
end $$;
create constraint trigger local149_ledger_binding after insert on public.audit_ledger deferrable initially deferred for each row execute function controller_security.local149_receipt_binding();
create constraint trigger local149_cancel_binding after insert on public.local_custody_intent_cancellations deferrable initially deferred for each row execute function controller_security.local149_receipt_binding();

-- No new agent/service ability to forge a human cancellation receipt.
alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0149;
revoke all on function controller_security.append_agent_ledger_before_0149(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='custody.local_policy_intent_cancelled' then raise exception 'dedicated human cancellation receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0149(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;
do $$declare f record;r record;begin
 for f in select p.oid::regprocedure signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where (n.nspname='controller_security' and p.proname like 'local149_%') or (n.nspname='public' and p.proname in ('read_local_custody_policy_outcome','read_local_custody_policy_cancellation','preflight_local_custody_policy_cancellation','record_local_custody_policy_cancellation')) loop
  execute format('revoke all on function %s from public',f.signature);
  for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop execute format('revoke all on function %s from %I',f.signature,r.rolname);end loop;
 end loop;
end $$;
grant execute on function public.read_local_custody_policy_outcome(uuid,uuid,uuid,text),public.read_local_custody_policy_cancellation(uuid,uuid,uuid,text),public.preflight_local_custody_policy_cancellation(uuid,uuid,uuid,text) to service_role,human_action_writer;
grant execute on function public.record_local_custody_policy_cancellation(uuid,uuid,uuid,text,uuid) to human_action_writer;
