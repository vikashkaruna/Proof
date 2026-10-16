-- STAGED/UNAPPLIED. Independent local custody authority; no provider activation,
-- application mount, credential provisioning or historical job adoption.
alter type public.mfa_challenge_purpose add value if not exists 'local_custody_policy';
alter type public.ledger_action_type add value if not exists 'custody.local_policy_requested';
alter type public.ledger_action_type add value if not exists 'custody.local_policy_approved';
alter type public.ledger_action_type add value if not exists 'custody.local_policy_activated';
alter type public.ledger_action_type add value if not exists 'custody.local_policy_revoked';
alter type public.ledger_action_type add value if not exists 'custody.local_policy_reviewed';

create table public.local_custody_policy_versions (
 id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete restrict,
 codec text not null check(codec='axiom-local-custody-policy-canonical-json-1'),
 policy_text text not null check(octet_length(policy_text) between 2 and 16384),
 policy_sha256 text not null check(policy_sha256 ~ '^[a-f0-9]{64}$'),
 key_policy_sha256 text not null check(key_policy_sha256 ~ '^[a-f0-9]{64}$'),
 nominated_operator_id uuid not null references public.users(id) on delete restrict,
 mode text not null check(mode in ('local_demo','operator_managed')),
 unique(tenant_id,id), unique(tenant_id,id,policy_sha256)
);
create table public.local_custody_policy_events (
 id uuid primary key,tenant_id uuid not null,policy_id uuid not null,actor_id uuid not null references public.users(id) on delete restrict,
 operation_key uuid not null,review_due_at_ms bigint not null check(review_due_at_ms between 1 and 9007199254740991),activation_epoch bigint not null check(activation_epoch between 0 and 9007199254740991),transition text not null check(transition in ('request','approve','activate','revoke','review')),
 previous_event_id uuid,session_id uuid not null,challenge_id uuid not null references public.mfa_challenges(id) on delete restrict,
 request_text text not null check(octet_length(request_text) between 2 and 32768),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,actor_id,operation_key),unique(tenant_id,receipt_id),
 foreign key(tenant_id,policy_id) references public.local_custody_policy_versions(tenant_id,id) on delete restrict,
 foreign key(tenant_id,previous_event_id) references public.local_custody_policy_events(tenant_id,id) on delete restrict,
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict
);
create table public.local_custody_policy_heads (
 tenant_id uuid not null,policy_id uuid not null,event_id uuid not null,state text not null check(state in ('requested','approved','active','revoked')),
 activation_epoch bigint not null check(activation_epoch between 0 and 9007199254740991),review_due_at_ms bigint not null check(review_due_at_ms between 1 and 9007199254740991),primary key(tenant_id,policy_id),
 foreign key(tenant_id,policy_id) references public.local_custody_policy_versions(tenant_id,id) on delete restrict,
 foreign key(tenant_id,event_id) references public.local_custody_policy_events(tenant_id,id) on delete restrict
);
-- A future atomic NEW local enqueue may populate this private sidecar. There is
-- intentionally NO callable insertion/backfill API in this foundation.
create trigger local_custody143_head_no_delete before delete on public.local_custody_policy_heads for each row execute function public.evidence_receipt_immutable();
create trigger local_custody143_head_no_truncate before truncate on public.local_custody_policy_heads for each statement execute function public.evidence_receipt_immutable();
create table public.assessment_local_custody_authorizations (
 tenant_id uuid not null,job_id uuid primary key,policy_id uuid not null,activation_event_id uuid not null,
 activation_epoch bigint not null check(activation_epoch between 1 and 9007199254740991),grant_text text not null check(octet_length(grant_text) between 2 and 16384),
 grant_sha256 text not null check(grant_sha256 ~ '^[a-f0-9]{64}$'),context_sha256 text not null check(context_sha256 ~ '^[a-f0-9]{64}$'),
 request_receipt_id bigint not null,original_expires_at timestamptz not null,
 foreign key(tenant_id,policy_id) references public.local_custody_policy_versions(tenant_id,id) on delete restrict,
 foreign key(tenant_id,activation_event_id) references public.local_custody_policy_events(tenant_id,id) on delete restrict,
 foreign key(tenant_id,request_receipt_id) references public.audit_ledger(tenant_id,id) on delete restrict,
 foreign key(job_id) references public.assessment_dispatch_jobs(id) on delete restrict
);

do $$declare t text;begin
 foreach t in array array['local_custody_policy_versions','local_custody_policy_events','assessment_local_custody_authorizations'] loop
  execute format('create trigger local_custody143_immutable before update or delete on public.%I for each row execute function public.evidence_receipt_immutable()',t);
  execute format('create trigger local_custody143_no_truncate before truncate on public.%I for each statement execute function public.evidence_receipt_immutable()',t);
 end loop;
 foreach t in array array['local_custody_policy_versions','local_custody_policy_events','local_custody_policy_heads','assessment_local_custody_authorizations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller',t);
 end loop;
end $$;

create function controller_security.local143_policy(p_text text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare p jsonb;refs text[];ref text;fingerprint text;k text;
begin
 if p_text is null or octet_length(p_text)>16384 then raise exception 'local custody policy refused' using errcode='22023';end if;
 p:=p_text::jsonb;
 if controller_security.canonical_questionnaire_json(p) is distinct from p_text
  or jsonb_typeof(p) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p))<>16
  or p-array['version','policyId','tenantId','mode','nominatedOperatorId','targetWorkloadId','servicePrincipals','validity','actionClass','keyPolicy','keyPolicySha256','deploymentBindingSha256','reason','acceptedLimitations','statutoryComplianceAsserted','ownershipVerified']<>'{}'::jsonb
  or p->'version' is distinct from '1'::jsonb or (p->>'mode' is null or p->>'mode' not in ('local_demo','operator_managed'))
  or p->>'actionClass' is distinct from 'assessment_dispatch_key_custody'
  or p->'statutoryComplianceAsserted' is distinct from 'false'::jsonb or p->'ownershipVerified' is distinct from 'false'::jsonb
  or jsonb_typeof(p->'reason') is distinct from 'string' or length(p->>'reason') not between 1 and 2000 or p->>'reason' !~ '[^[:space:]]'
 then raise exception 'local custody policy refused' using errcode='22023';end if;
 foreach k in array array['policyId','tenantId','nominatedOperatorId','targetWorkloadId'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then raise exception 'local custody identity refused' using errcode='22023';end if;
 end loop;
 foreach k in array array['keyPolicySha256','deploymentBindingSha256'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~ '^[a-f0-9]{64}$' then raise exception 'local custody hash refused' using errcode='22023';end if;
 end loop;
 if jsonb_typeof(p->'servicePrincipals') is distinct from 'object' or (p->'servicePrincipals')-array['producer','controller']<>'{}'::jsonb
  or jsonb_typeof(p#>'{servicePrincipals,producer}') is distinct from 'string' or p#>>'{servicePrincipals,producer}' !~ '^spiffe://[a-z0-9]([a-z0-9.-]*[a-z0-9])?/service/assessment-dispatch-producer$'
  or jsonb_typeof(p#>'{servicePrincipals,controller}') is distinct from 'string' or p#>>'{servicePrincipals,controller}' !~ '^spiffe://[a-z0-9]([a-z0-9.-]*[a-z0-9])?/controller/assessment$'
  or length(split_part(p#>>'{servicePrincipals,producer}','/',3)) not between 1 and 255
  or length(split_part(p#>>'{servicePrincipals,controller}','/',3)) not between 1 and 255
  or position('..' in split_part(p#>>'{servicePrincipals,producer}','/',3))>0
  or position('..' in split_part(p#>>'{servicePrincipals,controller}','/',3))>0
  or length(p#>>'{servicePrincipals,producer}')>2048 or length(p#>>'{servicePrincipals,controller}')>2048
  or jsonb_typeof(p->'validity') is distinct from 'object' or (p->'validity')-array['kind','reviewDueAt']<>'{}'::jsonb
  or p#>>'{validity,kind}' is distinct from 'until_revoked' or jsonb_typeof(p#>'{validity,reviewDueAt}') is distinct from 'number'
  or (p#>>'{validity,reviewDueAt}')::numeric not between 1 and 9007199254740991
  or trunc((p#>>'{validity,reviewDueAt}')::numeric)<>(p#>>'{validity,reviewDueAt}')::numeric
  or jsonb_typeof(p->'acceptedLimitations') is distinct from 'array' or jsonb_array_length(p->'acceptedLimitations') not between 1 and 4
  or exists(select 1 from jsonb_array_elements(p->'acceptedLimitations') x(v) where jsonb_typeof(v)<>'string' or v#>>'{}' not in ('regional_custody_unavailable','hardware_backing_unverified','disaster_recovery_unverified','physical_custody_operator_managed'))
  or (select count(distinct v) from jsonb_array_elements(p->'acceptedLimitations') x(v))<>jsonb_array_length(p->'acceptedLimitations')
  or jsonb_typeof(p->'keyPolicy') is distinct from 'object' or (p->'keyPolicy')-array['primary','readable']<>'{}'::jsonb
  or jsonb_typeof(p#>'{keyPolicy,primary}') is distinct from 'string' or jsonb_typeof(p#>'{keyPolicy,readable}') is distinct from 'array'
  or jsonb_array_length(p#>'{keyPolicy,readable}') not between 1 and 10
 then raise exception 'local custody scope refused' using errcode='22023';end if;
 select array_agg(v#>>'{}' order by v#>>'{}' collate "C") into refs from jsonb_array_elements(p#>'{keyPolicy,readable}') x(v) where jsonb_typeof(v)='string';
 if cardinality(refs) is distinct from jsonb_array_length(p#>'{keyPolicy,readable}') or cardinality(refs)<>(select count(distinct x) from unnest(refs)x)
  or not coalesce((p#>>'{keyPolicy,primary}')=any(refs),false) then raise exception 'local custody refs refused' using errcode='22023';end if;
 foreach ref in array refs loop
  if ref !~ ('^axiom-local-dispatch://'||(p->>'tenantId')||'/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/versions/[1-9][0-9]{0,8}$') then raise exception 'local custody refs refused' using errcode='22023';end if;
 end loop;
 fingerprint:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local.dispatch.policy',1,p->>'tenantId',p->>'policyId',p->>'mode',p->'validity',p#>>'{keyPolicy,primary}',to_jsonb(refs))),'UTF8')),'hex');
 if fingerprint is distinct from p->>'keyPolicySha256' then raise exception 'local key fingerprint refused' using errcode='22023';end if;
 return p;
end $$;

create function controller_security.local143_result(e public.local_custody_policy_events,replayed boolean) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state','recorded','tenantId',e.tenant_id,'actorId',e.actor_id,'operationKey',e.operation_key,'policyId',e.policy_id,'transition',e.transition,'eventId',e.id,'activationEpoch',e.activation_epoch,'reviewDueAt',e.review_due_at_ms,'previousEventId',e.previous_event_id,'requestText',e.request_text,'requestSha256',e.request_sha256,'policySha256',p.policy_sha256,'keyPolicySha256',p.key_policy_sha256,'receipt',jsonb_build_object('id',l.id::text,'entryHash',l.entry_hash),'replayed',replayed)
 from public.local_custody_policy_versions p join public.audit_ledger l on l.id=e.receipt_id and l.tenant_id=e.tenant_id where p.id=e.policy_id and p.tenant_id=e.tenant_id
$$;

create function controller_security.local143_actor(t uuid,a uuid,transition text,p jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id join public.tenants tenant on tenant.id=m.tenant_id
 where m.tenant_id=t and m.user_id=a and case transition
  when 'request' then m.role='owner' or (p->>'mode'='local_demo' and tenant.is_demo and m.role='founder' and u.is_axiom_internal)
  when 'approve' then m.role='founder' and u.is_axiom_internal
  when 'activate' then a=(p->>'nominatedOperatorId')::uuid and m.role in ('founder','axiom_analyst') and u.is_axiom_internal
  when 'revoke' then m.role='owner' or (m.role='founder' and u.is_axiom_internal)
  when 'review' then m.role='owner' or (m.role='founder' and u.is_axiom_internal)
  else false end)
$$;

create function controller_security.local143_reader(t uuid,a uuid,p jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id where m.tenant_id=t and m.user_id=a and (m.role='owner' or (m.role='founder' and u.is_axiom_internal) or (m.user_id=(p->>'nominatedOperatorId')::uuid and m.role='axiom_analyst' and u.is_axiom_internal)))
$$;

create function public.record_local_custody_policy_event(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;p jsonb;v public.local_custody_policy_versions;h public.local_custody_policy_heads;e public.local_custody_policy_events;previous public.local_custody_policy_events;
 challenge public.mfa_challenges;digest text;binding text;policy_sha text;receipt bigint;event_id uuid;state text;epoch bigint;review_due bigint;action public.ledger_action_type;now_at timestamptz;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human custody writer required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_request_text is null or octet_length(p_request_text)>32768 then raise exception 'local custody request refused' using errcode='22023';end if;
 r:=p_request_text::jsonb;p:=controller_security.local143_policy(r->>'policyText');
 if controller_security.canonical_questionnaire_json(r) is distinct from p_request_text or jsonb_typeof(r) is distinct from 'object'
 or (select count(*) from jsonb_object_keys(r))<>9 or r-array['version','operationKey','transition','policyText','policySha256','previousEventId','nextReviewDueAt','reason','confirmed']<>'{}'::jsonb
 or r->'version' is distinct from '1'::jsonb or r->'confirmed' is distinct from 'true'::jsonb
 or r->>'transition' not in ('request','approve','activate','revoke','review') or jsonb_typeof(r->'reason') is distinct from 'string'
 or length(r->>'reason') not between 1 and 2000 or r->>'reason' !~ '[^[:space:]]'
 or r->>'operationKey' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or p->>'tenantId' is distinct from p_tenant_id::text then raise exception 'local custody request refused' using errcode='22023';end if;
 if (r->>'transition'='review') is distinct from (jsonb_typeof(r->'nextReviewDueAt')='number') or (r->>'transition'<>'review' and r->'nextReviewDueAt' is distinct from 'null'::jsonb) then raise exception 'local custody review reminder refused' using errcode='22023';end if;
 policy_sha:=encode(sha256(convert_to(r->>'policyText','UTF8')),'hex');digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 if r->>'policySha256' is distinct from policy_sha or ((r->>'transition'='request') is distinct from (r->'previousEventId'='null'::jsonb)) then raise exception 'local custody binding refused' using errcode='22023';end if;
 -- Same serialization family as assessment NEW acceptance. Never users ->47.
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id in (select p_actor_id union select (p->>'nominatedOperatorId')::uuid union select actor_id from public.local_custody_policy_events where tenant_id=p_tenant_id and policy_id=(p->>'policyId')::uuid and transition in ('request','approve')) order by user_id for share;
 perform 1 from public.users where id in (select p_actor_id union select (p->>'nominatedOperatorId')::uuid union select actor_id from public.local_custody_policy_events where tenant_id=p_tenant_id and policy_id=(p->>'policyId')::uuid and transition in ('request','approve')) order by id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 if not controller_security.local143_reader(p_tenant_id,p_actor_id,p)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>clock_timestamp()))
 then raise exception 'local custody authority refused' using errcode='42501';end if;
 select * into e from public.local_custody_policy_events where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(r->>'operationKey')::uuid;
 if found then
  if e.request_text is distinct from p_request_text then raise exception 'local custody operation conflict' using errcode='23505';end if;
  return controller_security.local143_result(e,true);
 end if;
 if not controller_security.local143_actor(p_tenant_id,p_actor_id,r->>'transition',p) or (r->>'transition' in ('request','approve','activate') and p->>'mode'='local_demo' and not exists(select 1 from public.tenants where id=p_tenant_id and is_demo)) then raise exception 'new local custody authority refused' using errcode='42501';end if;
 if r->>'transition' in ('request','approve','activate') and not controller_security.local143_actor(p_tenant_id,(p->>'nominatedOperatorId')::uuid,'activate',p) then raise exception 'nominated current internal operator required' using errcode='42501';end if;
 select * into v from public.local_custody_policy_versions where tenant_id=p_tenant_id and id=(p->>'policyId')::uuid;
 select * into h from public.local_custody_policy_heads where tenant_id=p_tenant_id and policy_id=(p->>'policyId')::uuid for update;
 if r->>'transition'='request' then
  if v.id is not null or h.policy_id is not null then raise exception 'local custody policy already exists' using errcode='23505';end if;
  state:='requested';epoch:=0;review_due:=(p#>>'{validity,reviewDueAt}')::bigint;
 else
  if v.id is null or v.policy_text is distinct from r->>'policyText' or v.policy_sha256 is distinct from policy_sha or h.event_id is distinct from (r->>'previousEventId')::uuid then raise exception 'local custody predecessor conflict' using errcode='23505';end if;
  select * into previous from public.local_custody_policy_events where tenant_id=p_tenant_id and id=h.event_id;
  if (r->>'transition'='approve' and (h.state<>'requested' or previous.transition<>'request'))
   or (r->>'transition'='activate' and (h.state<>'approved' or previous.transition<>'approve'))
   or (r->>'transition'='revoke' and h.state='revoked') or (r->>'transition'='review' and h.state<>'active')
  then raise exception 'local custody transition refused' using errcode='23514';end if;
  if r->>'transition' in ('approve','activate') then
   if not exists(select 1 from public.local_custody_policy_events origin where origin.tenant_id=p_tenant_id and origin.policy_id=v.id and origin.transition='request' and controller_security.local143_actor(p_tenant_id,origin.actor_id,'request',p)) then raise exception 'local custody owner request retired' using errcode='42501';end if;
  end if;
  if r->>'transition'='activate' then
   -- Approval must still be held by a current internal founder at activation.
   perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=previous.actor_id for share;
   perform 1 from public.users where id=previous.actor_id for share;
   if not controller_security.local143_actor(p_tenant_id,previous.actor_id,'approve',p) then raise exception 'local custody approval retired' using errcode='42501';end if;
  end if;
  state:=case r->>'transition' when 'approve' then 'approved' when 'activate' then 'active' when 'revoke' then 'revoked' else h.state end;
  epoch:=h.activation_epoch;review_due:=h.review_due_at_ms;
  if r->>'transition'='review' then
   if (r->>'nextReviewDueAt')::numeric not between 1 and 9007199254740991 or trunc((r->>'nextReviewDueAt')::numeric)<>(r->>'nextReviewDueAt')::numeric or (r->>'nextReviewDueAt')::numeric<=extract(epoch from clock_timestamp())*1000 then raise exception 'next periodic review must be future reminder' using errcode='22023';end if;
   review_due:=(r->>'nextReviewDueAt')::bigint;
  end if;
  if r->>'transition'='activate' then
   if exists(select 1 from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id)
    or exists(select 1 from public.local_custody_policy_heads other_head where other_head.tenant_id=p_tenant_id and other_head.policy_id<>v.id and other_head.state='active')
   then raise exception 'unsupported custody provider transition' using errcode='23514';end if;
   select coalesce(max(activation_epoch),0)+1 into epoch from public.local_custody_policy_heads where tenant_id=p_tenant_id;
  end if;
 end if;
 -- User -> factors -> challenge, matching factor replacement. Original wall
 -- clock freshness is checked AFTER locks; a wait never renews the challenge.
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into challenge from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.local-custody.transition',1,p_tenant_id::text,p_actor_id::text,p_session_id::text,digest)),'UTF8')),'hex');
 if challenge.id is null or challenge.user_id is distinct from p_actor_id or challenge.tenant_id is distinct from p_tenant_id
  or challenge.purpose::text is distinct from 'local_custody_policy' or challenge.bound_resource_ref is distinct from r->>'operationKey'
  or challenge.bound_payload_sha256 is distinct from binding or challenge.consumed_for is distinct from r->>'operationKey'
  or challenge.satisfied_at is null or challenge.consumed_at is null or challenge.created_at>challenge.satisfied_at
  or challenge.expires_at>challenge.created_at+interval '5 minutes'
  or challenge.satisfied_at>now_at or challenge.satisfied_at<=now_at-interval '5 minutes' or challenge.expires_at<=now_at
  or challenge.consumed_at<challenge.satisfied_at or challenge.consumed_at>now_at
  or not exists(select 1 from public.user_mfa_factors where id=challenge.factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
  or exists(select 1 from public.local_custody_policy_events where challenge_id=p_challenge_id)
 then raise exception 'fresh custody MFA required' using errcode='42501';end if;
 event_id:=pg_catalog.gen_random_uuid();
 action:=(case r->>'transition' when 'request' then 'custody.local_policy_requested' when 'approve' then 'custody.local_policy_approved' when 'activate' then 'custody.local_policy_activated' when 'revoke' then 'custody.local_policy_revoked' else 'custody.local_policy_reviewed' end)::public.ledger_action_type;
 receipt:=public.append_ledger(p_tenant_id,(r->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,action,event_id::text,digest,policy_sha,null,null,null,null,'success',jsonb_build_object('policy_id',p->>'policyId','policy_sha256',policy_sha,'key_policy_sha256',p->>'keyPolicySha256','event_id',event_id,'activation_epoch',epoch,'review_due_at_ms',review_due,'previous_event_id',r->'previousEventId','reason_sha256',encode(sha256(convert_to(r->>'reason','UTF8')),'hex')));
 if r->>'transition'='request' then insert into public.local_custody_policy_versions values((p->>'policyId')::uuid,p_tenant_id,'axiom-local-custody-policy-canonical-json-1',r->>'policyText',policy_sha,p->>'keyPolicySha256',(p->>'nominatedOperatorId')::uuid,p->>'mode');end if;
 insert into public.local_custody_policy_events(id,tenant_id,policy_id,actor_id,operation_key,review_due_at_ms,activation_epoch,transition,previous_event_id,session_id,challenge_id,request_text,request_sha256,receipt_id) values(event_id,p_tenant_id,(p->>'policyId')::uuid,p_actor_id,(r->>'operationKey')::uuid,review_due,epoch,r->>'transition',(r->>'previousEventId')::uuid,p_session_id,p_challenge_id,p_request_text,digest,receipt);
 insert into public.local_custody_policy_heads values(p_tenant_id,(p->>'policyId')::uuid,event_id,state,epoch,review_due) on conflict(tenant_id,policy_id) do update set event_id=excluded.event_id,state=excluded.state,activation_epoch=excluded.activation_epoch,review_due_at_ms=excluded.review_due_at_ms;
 select * into e from public.local_custody_policy_events actual_event where actual_event.id=event_id;
 return controller_security.local143_result(e,false);
end $$;

create function controller_security.local143_receipt_binding() returns trigger language plpgsql security definer set search_path='' as $$
declare e public.local_custody_policy_events;v public.local_custody_policy_versions;l public.audit_ledger;r jsonb;action text;
begin
 if tg_table_name='audit_ledger' then
  if new.action_type::text not in ('custody.local_policy_requested','custody.local_policy_approved','custody.local_policy_activated','custody.local_policy_revoked','custody.local_policy_reviewed') then return null;end if;
  l:=new;select * into e from public.local_custody_policy_events where tenant_id=l.tenant_id and receipt_id=l.id;
 else e:=new;select * into l from public.audit_ledger where tenant_id=e.tenant_id and id=e.receipt_id;end if;
 select * into v from public.local_custody_policy_versions where tenant_id=e.tenant_id and id=e.policy_id;
 if e.id is null or l.id is null or v.id is null then raise exception 'local custody reciprocal receipt missing' using errcode='23514';end if;
 r:=e.request_text::jsonb;action:=case e.transition when 'request' then 'custody.local_policy_requested' when 'approve' then 'custody.local_policy_approved' when 'activate' then 'custody.local_policy_activated' when 'revoke' then 'custody.local_policy_revoked' when 'review' then 'custody.local_policy_reviewed' end;
 if controller_security.canonical_questionnaire_json(r) is distinct from e.request_text
  or encode(sha256(convert_to(e.request_text,'UTF8')),'hex') is distinct from e.request_sha256
  or r->>'policyText' is distinct from v.policy_text or r->>'policySha256' is distinct from v.policy_sha256
  or r->>'transition' is distinct from e.transition or r->>'operationKey' is distinct from e.operation_key::text
  or (r->>'previousEventId')::uuid is distinct from e.previous_event_id
  or l.actor_type::text is distinct from 'human' or l.actor_id is distinct from e.actor_id::text or l.correlation_id is distinct from e.operation_key
  or l.action_type::text is distinct from action or l.target_ref is distinct from e.id::text or l.input_hash is distinct from e.request_sha256
  or l.output_hash is distinct from v.policy_sha256 or l.result::text is distinct from 'success'
  or l.detail is distinct from jsonb_build_object('policy_id',e.policy_id,'policy_sha256',v.policy_sha256,'key_policy_sha256',v.key_policy_sha256,'event_id',e.id,'activation_epoch',e.activation_epoch,'review_due_at_ms',e.review_due_at_ms,'previous_event_id',e.previous_event_id,'reason_sha256',encode(sha256(convert_to(r->>'reason','UTF8')),'hex'))
 then raise exception 'local custody reciprocal receipt refused' using errcode='23514';end if;
 if e.previous_event_id is not null and not exists(select 1 from public.local_custody_policy_events prior where prior.tenant_id=e.tenant_id and prior.policy_id=e.policy_id and prior.id=e.previous_event_id and prior.created_at<=e.created_at) then raise exception 'local custody predecessor refused' using errcode='23514';end if;
 return null;
end $$;
create constraint trigger local_custody143_ledger_binding after insert on public.audit_ledger deferrable initially deferred for each row execute function controller_security.local143_receipt_binding();
create constraint trigger local_custody143_event_binding after insert on public.local_custody_policy_events deferrable initially deferred for each row execute function controller_security.local143_receipt_binding();

create function controller_security.local143_policy_binding() returns trigger language plpgsql security definer set search_path='' as $$
declare p jsonb;
begin
 p:=controller_security.local143_policy(new.policy_text);
 if p->>'tenantId' is distinct from new.tenant_id::text or p->>'policyId' is distinct from new.id::text or p->>'mode' is distinct from new.mode
  or p->>'nominatedOperatorId' is distinct from new.nominated_operator_id::text or p->>'keyPolicySha256' is distinct from new.key_policy_sha256
  or encode(sha256(convert_to(new.policy_text,'UTF8')),'hex') is distinct from new.policy_sha256
  or not exists(select 1 from public.local_custody_policy_events e where e.tenant_id=new.tenant_id and e.policy_id=new.id and e.transition='request' and e.previous_event_id is null)
 then raise exception 'local custody version binding refused' using errcode='23514';end if;return null;
end $$;
create constraint trigger local_custody143_policy_binding after insert on public.local_custody_policy_versions deferrable initially deferred for each row execute function controller_security.local143_policy_binding();
create unique index local_custody143_single_challenge on public.local_custody_policy_events(challenge_id);
create unique index local_custody143_single_request on public.local_custody_policy_events(policy_id) where transition='request';

create function public.read_local_custody_policy_event(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;p jsonb;e public.local_custody_policy_events;
begin
 if p_request_text is null or octet_length(p_request_text)>32768 then raise exception 'local custody read refused' using errcode='22023';end if;
 r:=p_request_text::jsonb;p:=controller_security.local143_policy(r->>'policyText');
 if controller_security.canonical_questionnaire_json(r) is distinct from p_request_text or p->>'tenantId' is distinct from p_tenant_id::text
  or not controller_security.local143_reader(p_tenant_id,p_actor_id,p)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>clock_timestamp()))
 then raise exception 'local custody read refused' using errcode='42501';end if;
 select * into e from public.local_custody_policy_events where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(r->>'operationKey')::uuid;
 if not found then return jsonb_build_object('state','not_found');end if;
 if e.request_text is distinct from p_request_text then raise exception 'local custody operation conflict' using errcode='23505';end if;
 return controller_security.local143_result(e,true);
end $$;
create function public.preflight_local_custody_policy_event(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;p jsonb;h public.local_custody_policy_heads;
begin
 perform public.read_local_custody_policy_event(p_tenant_id,p_actor_id,p_session_id,p_request_text);
 r:=p_request_text::jsonb;p:=controller_security.local143_policy(r->>'policyText');
 if not controller_security.local143_actor(p_tenant_id,p_actor_id,r->>'transition',p) then raise exception 'local custody transition refused' using errcode='42501';end if;
 if r->>'transition' in ('request','approve','activate') and p->>'mode'='local_demo' and not exists(select 1 from public.tenants where id=p_tenant_id and is_demo) then raise exception 'demo tenant required' using errcode='42501';end if;
 select * into h from public.local_custody_policy_heads where tenant_id=p_tenant_id and policy_id=(p->>'policyId')::uuid;
 if (r->>'transition'='request' and h.policy_id is not null) or (r->>'transition'<>'request' and (h.policy_id is null or h.event_id is distinct from (r->>'previousEventId')::uuid)) then raise exception 'local custody predecessor conflict' using errcode='23505';end if;
 return jsonb_build_object('authorized',true,'tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,'operationKey',r->>'operationKey','requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'));
end $$;

-- A separate least-privilege signed credential namespace. No issuer/credential
-- creation RPC is granted or mounted by this migration. No raw JWT/key is stored.
do $$begin
 -- Existing least-privilege roles may be preprovisioned by a trusted privileged
 -- bootstrap. A non-superuser migration must not repeat a role GRANT without
 -- ADMIN OPTION, and may never retain its implicit creator ADMIN membership.
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_verifier') then
  create role axiom_local_custody_verifier nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  grant axiom_local_custody_verifier to authenticator with admin false, inherit false, set true;
 end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_verifier' and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member where r.rolname='axiom_local_custody_verifier')
  or not exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member_role on member_role.oid=m.member where r.rolname='axiom_local_custody_verifier' and member_role.rolname='authenticator' and not m.admin_option and not m.inherit_option and m.set_option)
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member_role on member_role.oid=m.member where r.rolname='axiom_local_custody_verifier' and (member_role.rolname<>'authenticator' or m.admin_option or m.inherit_option or not m.set_option))
 then raise exception 'privileged custody verifier preprovisioning required' using errcode='42501';end if;
end $$;
grant usage on schema public to axiom_local_custody_verifier;
create table controller_security.local_custody_credentials (
 id uuid primary key,tenant_id uuid not null references public.tenants(id) on delete restrict,
 workload_id uuid not null,configuration_sha256 text not null check(configuration_sha256 ~ '^[a-f0-9]{64}$'),service_principal text not null check(length(service_principal) between 1 and 2048),principal_kind text not null check(principal_kind in ('operator','producer','controller')),
 operator_id uuid references public.users(id) on delete restrict,
 expires_at timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 check(expires_at>created_at and expires_at<=created_at+interval '24 hours'),
 check((principal_kind='operator')=(operator_id is not null))
);
revoke all on controller_security.local_custody_credentials from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller,axiom_local_custody_verifier;
create function controller_security.local143_credential() returns controller_security.local_custody_credentials language plpgsql stable security definer set search_path='' as $$
declare claims jsonb;c controller_security.local_custody_credentials;i numeric;x numeric;
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_local_custody_verifier' and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member where r.rolname='axiom_local_custody_verifier')
  or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member_role on member_role.oid=m.member where r.rolname='axiom_local_custody_verifier' and member_role.rolname<>'authenticator')
 then raise exception 'unsafe custody verifier role' using errcode='42501';end if;
 if current_setting('role',true) is distinct from 'axiom_local_custody_verifier' then raise exception 'custody verifier identity refused' using errcode='42501';end if;
 claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 if claims->>'role' is distinct from 'axiom_local_custody_verifier' or jsonb_typeof(claims->'iat') is distinct from 'number' or jsonb_typeof(claims->'exp') is distinct from 'number' then raise exception 'custody verifier identity refused' using errcode='42501';end if;
 i:=(claims->>'iat')::numeric;x:=(claims->>'exp')::numeric;
 if i<>trunc(i) or x<>trunc(x) or i>extract(epoch from clock_timestamp()) or x<=extract(epoch from clock_timestamp()) or x<=i or x-i>3600 then raise exception 'custody verifier identity expired' using errcode='42501';end if;
 select * into c from controller_security.local_custody_credentials where id=(claims->>'sub')::uuid and tenant_id=(claims->>'tenant_id')::uuid and workload_id=(claims->>'workload_id')::uuid and principal_kind=claims->>'principal_kind' and service_principal=claims->>'service_principal' and configuration_sha256=claims->>'configuration_sha256' and revoked_at is null and expires_at>clock_timestamp() and extract(epoch from expires_at)>=x;
 if c.id is null then raise exception 'custody verifier identity refused' using errcode='42501';end if;return c;
end $$;

create function controller_security.local143_job_grant(grantrow public.assessment_local_custody_authorizations) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'tenantId',j.tenant_id,'jobId',j.id,'runId',j.run_id,'actorId',j.actor_id,'workloadId',j.workload_id,'estateId',j.estate_id,'engagementId',j.engagement_id,'correlationId',j.correlation_id,'inputHash',j.input_hash,'proofHash',t.proof_hash,'keyRef',j.key_ref,'policyId',grantrow.policy_id,'policySha256',p.policy_sha256,'keyPolicySha256',p.key_policy_sha256,'activationEventId',e.id,'activationEpoch',grantrow.activation_epoch,'originalExpiresAt',floor(extract(epoch from t.expires_at)*1000)::bigint,'requestReceiptId',l.id::text,'requestReceiptHash',l.entry_hash) from public.assessment_dispatch_jobs j
 join public.workload_task_delegations t on t.run_id=j.run_id and t.tenant_id=j.tenant_id
 join public.local_custody_policy_versions p on p.id=grantrow.policy_id and p.tenant_id=j.tenant_id
 join public.local_custody_policy_events e on e.id=grantrow.activation_event_id and e.policy_id=p.id and e.tenant_id=p.tenant_id and e.transition='activate'
 join public.audit_ledger l on l.id=grantrow.request_receipt_id and l.tenant_id=j.tenant_id
 where j.id=grantrow.job_id and j.tenant_id=grantrow.tenant_id
$$;

create function controller_security.local143_grant_binding() returns trigger language plpgsql security definer set search_path='' as $$
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
  or l.action_type::text is distinct from 'assessment.requested' or l.target_ref is distinct from j.id::text or l.actor_id is distinct from j.actor_id::text or l.actor_type::text is distinct from 'human'
  or l.input_hash is distinct from j.input_hash or l.correlation_id is distinct from j.correlation_id
  or l.detail->>'job_id' is distinct from j.id::text or l.detail->>'run_id' is distinct from j.run_id::text or l.detail->>'workload_id' is distinct from j.workload_id::text
  or l.detail->>'custody_policy_id' is distinct from p.id::text or l.detail->>'custody_policy_sha256' is distinct from p.policy_sha256
  or j.created_at<transaction_timestamp() or t.expires_at<=clock_timestamp()
  or not exists(select 1 from public.local_custody_policy_heads h where h.tenant_id=new.tenant_id and h.policy_id=new.policy_id and h.state='active' and h.activation_epoch=new.activation_epoch)
 then raise exception 'local custody accepted grant refused' using errcode='23514';end if;return null;
end $$;
create constraint trigger local_custody143_grant_binding after insert on public.assessment_local_custody_authorizations deferrable initially deferred for each row execute function controller_security.local143_grant_binding();

create function public.read_local_custody_admission(p_tenant_id uuid,p_policy_id uuid,p_operation text,p_key_ref text,p_context_text text,p_deadline_ms bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c controller_security.local_custody_credentials;p public.local_custody_policy_versions;h public.local_custody_policy_heads;v jsonb;context jsonb;digest text;g public.assessment_local_custody_authorizations;j public.assessment_dispatch_jobs;t public.workload_task_delegations;kind text;demo boolean;accepted_grant jsonb;until_ms bigint;
begin
 c:=controller_security.local143_credential();
 if p_tenant_id is null or p_policy_id is null or p_tenant_id is distinct from c.tenant_id or p_operation is null or p_operation not in ('provision','wrap','unwrap')
  or p_key_ref is null or length(p_key_ref)>500 or p_deadline_ms is null or p_deadline_ms<=floor(extract(epoch from clock_timestamp())*1000) or p_deadline_ms>floor(extract(epoch from clock_timestamp())*1000)+5000
  or (p_operation='provision') is distinct from (p_context_text is null)
 then raise exception 'local custody admission refused' using errcode='42501';end if;
 if p_context_text is not null then
  if octet_length(p_context_text)>4096 then raise exception 'local custody context refused' using errcode='42501';end if;
  context:=p_context_text::jsonb;
  if jsonb_typeof(context) is distinct from 'array' or jsonb_array_length(context)<>10 or controller_security.canonical_questionnaire_json(context) is distinct from p_context_text
   or context->>0 is distinct from 'axiom.assessment.dispatch.dek' or context->1 is distinct from '1'::jsonb
   or context->>3 is distinct from c.tenant_id::text or context->>5 is distinct from c.workload_id::text or context->>9 !~ '^[a-f0-9]{64}$'
  then raise exception 'local custody context refused' using errcode='42501';end if;
  digest:=encode(sha256(convert_to(p_context_text,'UTF8')),'hex');
 end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 if p_operation='unwrap' then perform pg_advisory_xact_lock(hashtextextended(context->>2,44));end if;
 lock table public.kill_switch_state in share mode;
 if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then raise exception 'local custody stopped' using errcode='42501';end if;
 select * into p from public.local_custody_policy_versions where tenant_id=p_tenant_id and id=p_policy_id;
 select * into h from public.local_custody_policy_heads where tenant_id=p_tenant_id and policy_id=p_policy_id;
 if p.id is null or h.policy_id is null then raise exception 'local custody policy unavailable' using errcode='42501';end if;
 v:=controller_security.local143_policy(p.policy_text);
 if not exists(select 1 from jsonb_array_elements_text(v#>'{keyPolicy,readable}') x(ref) where ref=p_key_ref) then raise exception 'local custody key refused' using errcode='42501';end if;
 select is_demo into demo from public.tenants where id=p_tenant_id;
 if c.configuration_sha256 is distinct from v->>'deploymentBindingSha256' then raise exception 'custody deployment binding refused' using errcode='42501';end if;
 if c.workload_id is distinct from (v->>'targetWorkloadId')::uuid then raise exception 'custody target workload refused' using errcode='42501';end if;
 if p_operation='provision' then
  if c.principal_kind<>'operator' or c.service_principal is distinct from ('operator:'||p.nominated_operator_id::text) or c.operator_id is distinct from p.nominated_operator_id or not controller_security.local143_actor(p_tenant_id,c.operator_id,'activate',v) then raise exception 'local custody operator refused' using errcode='42501';end if;
 else
  if c.principal_kind is distinct from (case p_operation when 'wrap' then 'producer' else 'controller' end)
   or c.service_principal is distinct from (v->'servicePrincipals'->>c.principal_kind)
   or not exists(select 1 from public.workload_identities where tenant_id=p_tenant_id and id=c.workload_id and agent_name='parikshan' and status='active')
  then raise exception 'local custody workload refused' using errcode='42501';end if;
 end if;
 if p_operation='unwrap' then
  select * into g from public.assessment_local_custody_authorizations where tenant_id=p_tenant_id and job_id=(context->>2)::uuid and policy_id=p_policy_id;
  select * into j from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=g.job_id;
  select * into t from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=j.run_id;
  if g.job_id is null or j.id is null or t.run_id is null or g.context_sha256 is distinct from digest
   or g.grant_text is distinct from controller_security.canonical_questionnaire_json(controller_security.local143_job_grant(g))
   or g.grant_sha256 is distinct from encode(sha256(convert_to(g.grant_text,'UTF8')),'hex')
   or j.workload_id is distinct from c.workload_id
   or j.key_ref is distinct from p_key_ref or g.original_expires_at<=clock_timestamp() or t.expires_at is distinct from g.original_expires_at or t.revoked_at is not null
   or h.state not in ('active','revoked')
  then raise exception 'original accepted custody grant required' using errcode='42501';end if;
  kind:='accepted_job';
  accepted_grant:=jsonb_build_object('jobId',j.id,'runId',j.run_id,'contextSha256',g.context_sha256,'grantSha256',g.grant_sha256,'originalExpiresAt',floor(extract(epoch from g.original_expires_at)*1000)::bigint,'activationEventId',g.activation_event_id,'activationEpoch',g.activation_epoch);
 else
  if h.state<>'active' or (p.mode='local_demo' and demo is distinct from true) or (p_operation='wrap' and p_key_ref is distinct from v#>>'{keyPolicy,primary}') then raise exception 'new local custody authority refused' using errcode='42501';end if;
  if p_operation='wrap' and not public.workload_task_actor_allowed(p_tenant_id,(context->>4)::uuid,'parikshan') then raise exception 'local custody initiator refused' using errcode='42501';end if;
  kind:='new_authority';accepted_grant:=null;
 end if;
 -- Recheck credential expiry/revocation after waits without changing policy or
 -- accepted task lifetime. Periodic review is a reminder, never a stop gate.
 c:=controller_security.local143_credential();
 until_ms:=least(p_deadline_ms,floor(extract(epoch from c.expires_at)*1000)::bigint,case when kind='accepted_job' then floor(extract(epoch from g.original_expires_at)*1000)::bigint else p_deadline_ms end);
 if until_ms<=floor(extract(epoch from clock_timestamp())*1000) then raise exception 'local custody request expired' using errcode='42501';end if;
 return jsonb_build_object('version',1,'tenantId',p.tenant_id,'policyId',p.id,'policySha256',p.policy_sha256,'keyPolicySha256',p.key_policy_sha256,'mode',p.mode,'operation',p_operation,'keyRef',p_key_ref,'workloadId',c.workload_id,'principalKind',c.principal_kind,'servicePrincipal',c.service_principal,'contextSha256',digest,'kind',kind,'policyState',h.state,'currentIsDemo',demo,'reviewDueAt',h.review_due_at_ms,'reviewOverdue',h.review_due_at_ms<floor(extract(epoch from clock_timestamp())*1000),'verifiedUntil',until_ms,'policyText',p.policy_text,'grant',accepted_grant);
end $$;

create function controller_security.local143_credential_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'UPDATE' or (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
  or old.revoked_at is not null or new.revoked_at is null or new.revoked_at<old.created_at or new.revoked_at>clock_timestamp()
 then raise exception 'custody credential mutation refused' using errcode='42501';end if;return new;
end $$;
create trigger local_custody143_credential_immutable before update or delete on controller_security.local_custody_credentials for each row execute function controller_security.local143_credential_immutable();
create trigger local_custody143_credential_no_truncate before truncate on controller_security.local_custody_credentials for each statement execute function public.evidence_receipt_immutable();

create function controller_security.local143_job_binding() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.key_ref like 'axiom-local-dispatch://%' and not exists(select 1 from public.assessment_local_custody_authorizations g where g.tenant_id=new.tenant_id and g.job_id=new.id) then raise exception 'local job lacks atomic custody grant' using errcode='23514';end if;return null;
end $$;
create constraint trigger local_custody143_job_binding after insert on public.assessment_dispatch_jobs deferrable initially deferred for each row execute function controller_security.local143_job_binding();

create function controller_security.local143_head_binding() returns trigger language plpgsql security definer set search_path='' as $$
declare e public.local_custody_policy_events;
begin
 select * into e from public.local_custody_policy_events where tenant_id=new.tenant_id and policy_id=new.policy_id and id=new.event_id;
 if e.id is null or new.activation_epoch is distinct from e.activation_epoch or new.review_due_at_ms is distinct from e.review_due_at_ms or new.state is distinct from (case e.transition when 'request' then 'requested' when 'approve' then 'approved' when 'activate' then 'active' when 'review' then 'active' when 'revoke' then 'revoked' end) then raise exception 'local custody head binding refused' using errcode='23514';end if;return null;
end $$;
create constraint trigger local_custody143_head_binding after insert or update on public.local_custody_policy_heads deferrable initially deferred for each row execute function controller_security.local143_head_binding();

-- Explicit grants only. Private helper execution is revoked even if a previous
-- migration installed broad default ACLs. No table/credential/sidecar writer.
do $$declare f record;r record;begin
 for f in select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='controller_security' and p.proname like 'local143_%') or (n.nspname='public' and p.proname in ('record_local_custody_policy_event','read_local_custody_policy_event','preflight_local_custody_policy_event','read_local_custody_admission')) loop
  execute format('revoke all on function %s from public',f.signature);
  for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop execute format('revoke all on function %s from %I',f.signature,r.rolname);end loop;
 end loop;
end $$;
grant execute on function public.record_local_custody_policy_event(uuid,uuid,uuid,text,uuid) to human_action_writer;
grant execute on function public.read_local_custody_policy_event(uuid,uuid,uuid,text),public.preflight_local_custody_policy_event(uuid,uuid,uuid,text) to service_role,human_action_writer;
grant execute on function public.read_local_custody_admission(uuid,uuid,text,text,text,bigint) to axiom_local_custody_verifier;

alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0143;
revoke all on function controller_security.append_agent_ledger_before_0143(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
 p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text in ('custody.local_policy_requested','custody.local_policy_approved','custody.local_policy_activated','custody.local_policy_revoked','custody.local_policy_reviewed') then raise exception 'dedicated human custody receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0143(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

revoke all on public.local_custody_policy_versions,public.local_custody_policy_events,public.local_custody_policy_heads,public.assessment_local_custody_authorizations from axiom_local_custody_verifier;
