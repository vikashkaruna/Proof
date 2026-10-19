-- Exact, immutable onboarding outcomes. Legacy 0017/0176 entry points remain unchanged.
begin;
create table controller_security.onboarding178_operations (
 actor_id uuid not null references public.users(id), operation_key uuid not null,
 request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),
 -- Creation receipts pin the original admitted session; fences pin their own
 -- current recording session, never pretend to reconstruct a legacy session.
 recording_session_id uuid not null, claim_id uuid references public.idempotency_keys(id),
 claim_request_sha256 text check(claim_request_sha256~'^[a-f0-9]{64}$'),
 claim_authority_sha256 text check(claim_authority_sha256~'^[a-f0-9]{64}$'),
 state text not null check(state in('recorded','fenced')),
 tenant_id uuid references public.tenants(id), engagement_id uuid references public.engagements(id),
 intake_tenant_id uuid references public.tenant_onboarding_intakes(tenant_id),
 library_version text references public.control_libraries(version), ledger_id bigint references public.audit_ledger(id),
 ledger_sha256 text check(ledger_sha256~'^[a-f0-9]{64}$'), created_at timestamptz not null default clock_timestamp(),
 primary key(actor_id,operation_key),
 check((state='fenced' and tenant_id is null and engagement_id is null and intake_tenant_id is null and library_version is null and ledger_id is null and ledger_sha256 is null)
 or(state='recorded' and claim_id is not null and claim_request_sha256 is not null and claim_authority_sha256 is not null and tenant_id is not null and tenant_id=intake_tenant_id and engagement_id is not null and library_version is not null and ledger_id is not null and ledger_sha256 is not null))
);
alter table controller_security.onboarding178_operations enable row level security;
revoke all on controller_security.onboarding178_operations from public,anon,authenticated,service_role,human_action_writer;
create trigger onboarding178_immutable before update or delete on controller_security.onboarding178_operations
 for each row execute function public.evidence_receipt_immutable();
create trigger onboarding178_no_truncate before truncate on controller_security.onboarding178_operations
 for each statement execute function public.evidence_receipt_immutable();

-- Lock protocol: 0176 global founder mutex -> actor/op mutex -> original 0017
-- claim row -> unchanged 0176 entitlement/user/designation/source/ledger locks.
-- 0017 claim/complete hold only the claim row in separate brief transactions.
-- Fencing and readback use the same first two locks; no absent observation can
-- race a delayed new-protocol creation. No legacy operation is reconstructed.
create function controller_security.onboarding178_lock(a uuid,s uuid,k uuid)returns void
 language plpgsql volatile security definer set search_path=''as $$begin
 if a is null or s is null or k is null then raise exception 'onboarding authority refused'using errcode='42501';end if;
 perform public.lock_platform_founder_membership_authority();
 perform pg_catalog.pg_advisory_xact_lock(178,pg_catalog.hashtext(a::text||':'||k::text));
 if not public.mfa_recovery_live_session(a,s)or public.mfa_recovery_open_case(a)is not null
  or not exists(select 1 from public.users where id=a)then raise exception 'current onboarding session required'using errcode='42501';end if;
end $$;
create function controller_security.onboarding178_projection(a uuid,k uuid,h text)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare r controller_security.onboarding178_operations;base jsonb;begin
 base:=jsonb_build_object('actorId',a,'operationKey',k,'requestSha256',h);
 select *into r from controller_security.onboarding178_operations where actor_id=a and operation_key=k;
 if not found then return base||jsonb_build_object('state','unconfirmed');end if;
 if r.request_sha256 is distinct from h then raise exception 'original onboarding operation refused'using errcode='42501';end if;
 if r.state='fenced'then return base||jsonb_build_object('state','fenced');end if;
 -- Recovery is not a new read grant after offboarding. A current session of
 -- the original actor may inspect only the exact receipt's authorized tenant.
 if not exists(select 1 from public.tenant_users m where m.user_id=a and m.tenant_id=r.tenant_id
   and(m.membership_source<>'platform_founder'or public.is_live_platform_founder(a)))then
  return base||jsonb_build_object('state','recorded_access_withdrawn');end if;
 return base||jsonb_build_object('state','recorded','tenantId',r.tenant_id,'engagementId',r.engagement_id,
 'intakeTenantId',r.intake_tenant_id,'libraryVersion',r.library_version,'ledgerId',r.ledger_id::text,'ledgerSha256',r.ledger_sha256,'createdAt',r.created_at);
end $$;
create function public.read_onboarding_operation(p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_request_sha256 text)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$begin
 if p_request_sha256 is null or p_request_sha256!~'^[a-f0-9]{64}$'then raise exception 'original onboarding operation refused'using errcode='42501';end if;
 perform controller_security.onboarding178_lock(p_actor_id,p_session_id,p_operation_key);
 return controller_security.onboarding178_projection(p_actor_id,p_operation_key,p_request_sha256);
end $$;
create function public.fence_onboarding_operation(p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_request_sha256 text,p_original_body text default null)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare r jsonb;claim public.idempotency_keys;body jsonb;begin
 r:=public.read_onboarding_operation(p_actor_id,p_session_id,p_operation_key,p_request_sha256);
 if r->>'state'<>'unconfirmed'then return r;end if;
 -- Locks the original create claim, not the fence HTTP request's claim.
 select *into claim from public.idempotency_keys where user_id=p_actor_id and tenant_id is null
  and path='/v1/organizations/onboard'and method='POST'and key=p_operation_key::text for update;
 if found then
  -- The generic claim binds exact wire bytes, not a canonical semantic hash.
  -- Require the original payload transiently before asserting a matching
  -- definite fence. Never reconstruct it from tenant names or personal data.
  if p_original_body is null or octet_length(p_original_body)>524288 then return r;end if;
  begin body:=p_original_body::jsonb;exception when others then return r;end;
  if jsonb_typeof(body)is distinct from'object'or not body?&array['operationKey','request']or body-array['operationKey','request']<>'{}'::jsonb
   or body->>'operationKey'is distinct from p_operation_key::text
   or encode(sha256(convert_to(controller_security.canonical_questionnaire_json(body->'request'),'UTF8')),'hex')is distinct from p_request_sha256
   or claim.request_sha256 is distinct from encode(sha256(convert_to('['||to_json(''::text)::text||','||to_json(p_original_body)::text||']','UTF8')),'hex')then return r;end if;
 end if;
 insert into controller_security.onboarding178_operations(actor_id,operation_key,request_sha256,recording_session_id,claim_id,claim_request_sha256,claim_authority_sha256,state)
 values(p_actor_id,p_operation_key,p_request_sha256,p_session_id,claim.id,claim.request_sha256,claim.authority_sha256,'fenced');
 return controller_security.onboarding178_projection(p_actor_id,p_operation_key,p_request_sha256);
end $$;
create function public.onboard_organization_exact(
 p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_claim_id uuid,p_claim_request_sha256 text,p_claim_authority_sha256 text,
 p_request_text text,p_raw_body text,p_library_version text
)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare req jsonb;body jsonb;h text;claim public.idempotency_keys;existing jsonb;outcome jsonb;t uuid;e uuid;l public.audit_ledger;x jsonb;begin
 if p_request_text is null or p_raw_body is null or octet_length(p_request_text)>262144 or octet_length(p_raw_body)>524288 then raise exception 'onboarding request too large'using errcode='22023';end if;
 req:=p_request_text::jsonb;body:=p_raw_body::jsonb;
 if jsonb_typeof(req)is distinct from'object'or not req?&array['name','slug','tier','is_sdf','processes_health_data','processes_children_data','dpo_name','dpo_email','systems']
  or req-array['name','slug','tier','is_sdf','processes_health_data','processes_children_data','dpo_name','dpo_email','systems']<>'{}'::jsonb
  or controller_security.canonical_questionnaire_json(req)is distinct from p_request_text
  or body is distinct from jsonb_build_object('operationKey',p_operation_key,'request',req)
  or jsonb_typeof(req->'name')is distinct from'string'or length(req->>'name')not between 2 and 100
  or req->>'name'<>btrim(req->>'name')or jsonb_typeof(req->'tier')is distinct from'string'or req->>'tier'not in('essential','growth','enterprise')
  or jsonb_typeof(req->'is_sdf')is distinct from'boolean'or jsonb_typeof(req->'processes_health_data')is distinct from'boolean'
  or jsonb_typeof(req->'processes_children_data')is distinct from'boolean'
  or jsonb_typeof(req->'systems')is distinct from'array'or jsonb_array_length(req->'systems')>100
  or not((req->'slug'='null'::jsonb)or(jsonb_typeof(req->'slug')='string'and length(req->>'slug')between 2 and 60))
  or not((req->'dpo_name'='null'::jsonb)or(jsonb_typeof(req->'dpo_name')='string'and length(req->>'dpo_name')between 1 and 200))
  or not((req->'dpo_email'='null'::jsonb)or(jsonb_typeof(req->'dpo_email')='string'and length(req->>'dpo_email')between 3 and 320))then
  raise exception 'invalid exact onboarding request'using errcode='22023';end if;
 for x in select value from jsonb_array_elements(req->'systems')loop
  if jsonb_typeof(x)is distinct from'object'or not x?&array['name','type','description','hosts_personal_data','region','data_categories']
   or x-array['name','type','description','hosts_personal_data','region','data_categories']<>'{}'::jsonb
   or jsonb_typeof(x->'name')is distinct from'string'or length(x->>'name')not between 1 and 200
   or jsonb_typeof(x->'type')is distinct from'string'or length(x->>'type')not between 1 and 100
   or jsonb_typeof(x->'hosts_personal_data')is distinct from'boolean'
   or jsonb_typeof(x->'region')is distinct from'string'or length(x->>'region')not between 1 and 100
   or not((x->'description'='null'::jsonb)or(jsonb_typeof(x->'description')='string'and length(x->>'description')<=2000))
   or jsonb_typeof(x->'data_categories')is distinct from'array'or jsonb_array_length(x->'data_categories')>50
   or exists(select 1 from jsonb_array_elements(x->'data_categories')c where jsonb_typeof(c)is distinct from'string'or length(c#>>'{}')not between 1 and 100)then
   raise exception 'invalid proposed system'using errcode='22023';end if;
 end loop;
 h:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 perform controller_security.onboarding178_lock(p_actor_id,p_session_id,p_operation_key);
 existing:=controller_security.onboarding178_projection(p_actor_id,p_operation_key,h);
 if existing->>'state'<>'unconfirmed'then return existing;end if;
 select *into claim from public.idempotency_keys where id=p_claim_id for update;
 if not found or claim.user_id is distinct from p_actor_id or claim.tenant_id is not null or claim.path<>'/v1/organizations/onboard'
  or claim.method<>'POST'or claim.key is distinct from p_operation_key::text or claim.status<>'in_progress'
  or claim.request_sha256 is distinct from p_claim_request_sha256 or claim.authority_sha256 is distinct from p_claim_authority_sha256
  or claim.request_sha256 is distinct from encode(sha256(convert_to('['||to_json(''::text)::text||','||to_json(p_raw_body)::text||']','UTF8')),'hex')
  or claim.authority_sha256 is distinct from encode(sha256(convert_to('{"role":null,"scopes":[],"session":'||to_json(p_session_id::text)::text||'}','UTF8')),'hex')then
  raise exception 'original onboarding claim refused'using errcode='42501';end if;
 outcome:=public.onboard_organization(p_actor_id,
  coalesce(nullif(left(trim(both'-'from regexp_replace(lower(coalesce(req->>'slug',req->>'name')),'[^a-z0-9]+','-','g')),45),''),'organization')||'-'||p_operation_key::text,
  req->>'name',(req->>'tier')::public.tenant_tier,(req->>'is_sdf')::boolean,(req->>'processes_health_data')::boolean,(req->>'processes_children_data')::boolean,
  req->>'dpo_name',req->>'dpo_email',req->'systems',p_library_version,p_operation_key);
 if outcome?'error'then return outcome;end if;
 t:=(outcome->'tenant'->>'id')::uuid;e:=(outcome->'engagement'->>'id')::uuid;
 select *into strict l from public.audit_ledger where tenant_id=t and correlation_id=p_operation_key
  and actor_type='human'and actor_id=p_actor_id::text and action_type='tenant.created'and target_ref=t::text and detail->>'engagement_id'=e::text;
 if not exists(select 1 from public.engagements where id=e and tenant_id=t and library_version=p_library_version)
  or not exists(select 1 from public.tenant_onboarding_intakes where tenant_id=t and submitted_by=p_actor_id)then
  raise exception 'onboarding source receipt mismatch'using errcode='42501';end if;
 insert into controller_security.onboarding178_operations(actor_id,operation_key,request_sha256,recording_session_id,claim_id,claim_request_sha256,claim_authority_sha256,state,tenant_id,engagement_id,intake_tenant_id,library_version,ledger_id,ledger_sha256)
 values(p_actor_id,p_operation_key,h,p_session_id,claim.id,claim.request_sha256,claim.authority_sha256,'recorded',t,e,t,p_library_version,l.id,l.entry_hash);
 return controller_security.onboarding178_projection(p_actor_id,p_operation_key,h);
end $$;
revoke all on function controller_security.onboarding178_lock(uuid,uuid,uuid),controller_security.onboarding178_projection(uuid,uuid,text)from public,anon,authenticated,service_role,human_action_writer;
revoke all on function public.read_onboarding_operation(uuid,uuid,uuid,text),public.fence_onboarding_operation(uuid,uuid,uuid,text,text),public.onboard_organization_exact(uuid,uuid,uuid,uuid,text,text,text,text,text)from public,anon,authenticated,service_role,human_action_writer;
grant execute on function public.read_onboarding_operation(uuid,uuid,uuid,text),public.fence_onboarding_operation(uuid,uuid,uuid,text,text),public.onboard_organization_exact(uuid,uuid,uuid,uuid,text,text,text,text,text)to human_action_writer;
commit;
