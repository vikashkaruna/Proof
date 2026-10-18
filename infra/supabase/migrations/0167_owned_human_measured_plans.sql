-- Normal human plan creation for one enrolled synthetic boolean resource only.
-- No enrollment, credentials, approvals, execution, finding closure or cloud writes.
alter type public.ledger_action_type add value if not exists 'plan.owned_request.prepared';
alter type public.ledger_action_type add value if not exists 'plan.owned_request.cancelled';

create table owned_synthetic.human_requests (
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id),session_id uuid not null,
 request jsonb not null,request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 binding_id uuid not null references owned_synthetic.bindings(id),
 engagement_id uuid not null, state text not null default 'pending' check(state in('pending','recorded','cancelled')),
 prepared_receipt bigint not null unique references public.audit_ledger(id),
 roundtrip jsonb,receipt jsonb,cancellation_key uuid unique,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 check((state='pending' and roundtrip is null and receipt is null and cancellation_key is null)
 or(state='recorded' and roundtrip is not null and receipt is not null and cancellation_key is null)
 or(state='cancelled' and roundtrip is null and receipt is not null and cancellation_key is not null))
);
revoke all on owned_synthetic.human_requests from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create function owned_synthetic.human_request_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'UPDATE' then raise exception 'owned human journal is retained' using errcode='42501';end if;
 if old.state<>'pending' or new.state not in('recorded','cancelled')
 or(new.operation_key,new.tenant_id,new.actor_id,new.session_id,new.request,new.request_hash,new.binding_id,new.engagement_id,new.prepared_receipt,new.created_at)
 is distinct from(old.operation_key,old.tenant_id,old.actor_id,old.session_id,old.request,old.request_hash,old.binding_id,old.engagement_id,old.prepared_receipt,old.created_at)
 then raise exception 'owned human journal is immutable' using errcode='42501';end if;
 return new;
end $$;
create trigger owned_human_update before update or delete on owned_synthetic.human_requests for each row execute function owned_synthetic.human_request_guard();
create trigger owned_human_truncate before truncate on owned_synthetic.human_requests for each statement execute function owned_synthetic.human_request_guard();

create function owned_synthetic.human_authority(t uuid,a uuid,s uuid) returns void
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 if current_setting('role',true) is distinct from 'human_action_writer' or t is null or a is null or s is null
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
create function public.verify_owned_human_plan_authority(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 return '{"verified":true}'::jsonb;
end $$;
create function public.verify_owned_human_stop_authority(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 return '{"verified":true}'::jsonb;
end $$;
create function owned_synthetic.binding_json(b owned_synthetic.bindings) returns jsonb
language sql immutable set search_path='' as $$select jsonb_build_object(
 'id',b.id,'tenantId',b.tenant_id,'engagementId',b.engagement_id,'fixtureId',b.fixture_id,'resourceId',b.resource_id,
 'registeredEngineHash',b.engine_sha256,'registeredCapabilitiesHash',b.capability_sha256,'scope',b.scope,'state',b.state)$$;
create function owned_synthetic.human_source(r owned_synthetic.human_requests,b owned_synthetic.bindings) returns jsonb
language sql immutable set search_path='' as $$select jsonb_build_object('tenantId',r.tenant_id,'actorId',r.actor_id,
 'operationKey',r.operation_key,'requestHash',r.request_hash,'binding',owned_synthetic.binding_json(b),'state',r.state,
 'recorded',r.receipt,'recordedValidation',r.roundtrip)$$;

create function public.read_owned_human_targets(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_engagement_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare b owned_synthetic.bindings;s jsonb;targets jsonb:='[]';
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if not exists(select 1 from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id)
 then raise exception 'owned engagement refused' using errcode='42501';end if;
 for b in select * from owned_synthetic.bindings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and state='active' and action_id is null order by id limit 20 loop
  -- Skip expired/revoked custody candidates; do not publish a browser-supplied identity.
  begin
   s:=public.read_owned_synthetic_target(p_tenant_id,b.id,p_engagement_id);
  exception when insufficient_privilege then continue;
  end;
  targets:=targets||jsonb_build_array(jsonb_build_object('bindingId',b.id,'engagementId',b.engagement_id,'label',b.label,'scope',b.scope,
   'auditLogEnabled',(s->>'audit_log_enabled')::boolean,'currentVersion',(s->>'version')::bigint,'snapshotHash',owned_synthetic.snapshot_sha256(s)));
 end loop;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'engagementId',p_engagement_id,'targets',targets);
end $$;

create function public.prepare_owned_human_plan(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_request jsonb,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.human_requests;b owned_synthetic.bindings;digest text;receipt bigint;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_operation_key is null or p_request is null or jsonb_typeof(p_request)<>'object'
 or p_request-'operationKey'-'bindingId'-'engagementId'-'expectedSnapshotHash'-'reason'-'acknowledgeOwnedSynthetic'-'actionType'-'desiredEnabled'<>'{}'::jsonb
 or not(p_request ?& array['operationKey','bindingId','engagementId','expectedSnapshotHash','reason','acknowledgeOwnedSynthetic','actionType','desiredEnabled'])
 or p_request->>'operationKey' is distinct from p_operation_key::text
 or jsonb_typeof(p_request->'bindingId') is distinct from 'string' or jsonb_typeof(p_request->'engagementId') is distinct from 'string'
 or jsonb_typeof(p_request->'expectedSnapshotHash') is distinct from 'string' or p_request->>'expectedSnapshotHash' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(p_request->'reason') is distinct from 'string' or length(p_request->>'reason') not between 20 and 2000 or p_request->>'reason'<>btrim(p_request->>'reason')
 or p_request->'acknowledgeOwnedSynthetic' is distinct from 'true'::jsonb or p_request->>'actionType' is distinct from 'config.audit_log_enable'
 or p_request->'desiredEnabled' is distinct from 'true'::jsonb
 then raise exception 'owned human request refused' using errcode='22023';end if;
 digest:=owned_synthetic.snapshot_sha256(jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'request',p_request));
 if digest is distinct from p_request_hash then raise exception 'owned human digest refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,167));
 select * into r from owned_synthetic.human_requests where operation_key=p_operation_key for update;
 if found then
  if(r.tenant_id,r.actor_id,r.request,r.request_hash) is distinct from(p_tenant_id,p_actor_id,p_request,p_request_hash)
  then raise exception 'owned human operation conflict' using errcode='23505';end if;
  if r.state='cancelled' then raise exception 'owned human request cancelled' using errcode='42501';end if;
  -- Recovery retains original measured proof; it never creates a replacement plan.
  select * into strict b from owned_synthetic.bindings where id=r.binding_id;
  return owned_synthetic.human_source(r,b);
 end if;
 lock table public.kill_switch_state in share mode;
 b:=owned_synthetic.require_binding(p_tenant_id,(p_request->>'bindingId')::uuid,(p_request->>'engagementId')::uuid);
 if b.action_id is not null then raise exception 'owned target already bound' using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,p_operation_key,'human',p_actor_id::text,null,null,null,'plan.owned_request.prepared',b.id::text,
 digest,null,null,null,null,null,'pending',jsonb_build_object('provenance','owned_synthetic_postgresql_boolean','binding_id',b.id,'engagement_id',b.engagement_id,'execution_allowed',false));
 insert into owned_synthetic.human_requests(operation_key,tenant_id,actor_id,session_id,request,request_hash,binding_id,engagement_id,prepared_receipt)
 values(p_operation_key,p_tenant_id,p_actor_id,p_session_id,p_request,digest,b.id,b.engagement_id,receipt) returning * into r;
 return owned_synthetic.human_source(r,b);
end $$;

create function public.record_owned_measured_plan(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_request_hash text,
 p_binding_id uuid,p_engagement_id uuid,p_roundtrip jsonb,p_validation_hash text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.human_requests;b owned_synthetic.bindings;resource owned_synthetic.resources;proof jsonb;original jsonb;diff jsonb;rollback jsonb;
 plan uuid:=gen_random_uuid();action uuid:=gen_random_uuid();receipt bigint;result jsonb;library text;recorded jsonb;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,167));
 select * into r from owned_synthetic.human_requests where operation_key=p_operation_key for update;
 if r.operation_key is null or(r.tenant_id,r.actor_id,r.request_hash,r.binding_id,r.engagement_id)
 is distinct from(p_tenant_id,p_actor_id,p_request_hash,p_binding_id,p_engagement_id)
 then raise exception 'owned human source refused' using errcode='42501';end if;
 if r.state='recorded' then
  if r.roundtrip is distinct from p_roundtrip or r.receipt->>'validationHash' is distinct from p_validation_hash
  then raise exception 'owned human proof conflict' using errcode='23505';end if;
  return r.receipt;
 end if;
 if r.state<>'pending' then raise exception 'owned human request cancelled' using errcode='42501';end if;
 -- Preserve the custody lock order, then lock this binding exclusively
 -- before require_binding takes its shared lock. Competing human requests
 -- cannot both promote a shared binding lock and deadlock one another.
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 lock table public.kill_switch_state in share mode;
 select * into strict b from owned_synthetic.bindings where id=p_binding_id and tenant_id=p_tenant_id and engagement_id=p_engagement_id for update;
 b:=owned_synthetic.require_binding(p_tenant_id,p_binding_id,p_engagement_id);
 -- Plan, action and same-database source remain one atomic transaction.
 select * into strict resource from owned_synthetic.resources where(fixture_id,resource_id)=(b.fixture_id,b.resource_id) for update;
 if b.action_id is not null then raise exception 'owned target already bound' using errcode='42501';end if;
 proof:=public.measure_owned_synthetic_target(p_tenant_id,p_binding_id,p_engagement_id);
 original:=proof->'before';
 if proof is distinct from p_roundtrip or owned_synthetic.snapshot_sha256(proof) is distinct from p_validation_hash
 or owned_synthetic.snapshot_sha256(original) is distinct from r.request->>'expectedSnapshotHash'
 then raise exception 'owned measured source changed' using errcode='40001';end if;
 select library_version into strict library from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for share;
 rollback:=jsonb_build_object('enabled',false,'snapshot_sha256',owned_synthetic.snapshot_sha256(original));
 diff:=jsonb_build_object('simulated_from','owned_fixture_persisted_snapshot','source_snapshot_sha256',owned_synthetic.snapshot_sha256(original),
 'source_content_sha256',owned_synthetic.snapshot_sha256(jsonb_build_object('audit_log_enabled',false)),'source_version',original->'version',
 'records_measured',1,'changes',jsonb_build_array(jsonb_build_object('field','audit_log_enabled','before',false,'after',true)),
 'rollback_simulation',jsonb_build_object('method','read_only_boolean_schema_and_original_snapshot','restores_snapshot_sha256',owned_synthetic.snapshot_sha256(original)));
 insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title,description,status,purpose,generated_by_agent,aggregate_blast_radius)
 values(plan,p_tenant_id,p_engagement_id,library,'Owned synthetic audit configuration',
 'Human requested demonstration: one boolean in a dedicated local synthetic schema. No customer connector or compliance closure.','review','remediation','human','{"records":1}');
 insert into public.remediation_actions(id,tenant_id,plan_id,sequence,action_type,parameters,description,risk_class,risk_score,blast_radius,rollback_definition,rollback_validated,rollback_validated_at)
 values(action,p_tenant_id,plan,1,'config.audit_log_enable','{"enabled":true}',
 'Enable only the enrolled synthetic audit boolean; independent verification is required.','low',1,'{"records":1}',rollback,true,clock_timestamp());
 update owned_synthetic.bindings set action_id=action where id=b.id;
 recorded:=public.record_dry_run(p_tenant_id,action,'succeeded',diff,null,'owned-postgresql-measurement','{"enabled":true}',rollback,p_operation_key);
 if not(recorded ? 'dryRun') then raise exception 'owned measured dry run refused' using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,p_operation_key,'human',p_actor_id::text,null,null,null,'plan.generated',plan::text,
 r.request_hash,p_validation_hash,null,null,null,null,'success',jsonb_build_object('provenance','owned_synthetic_postgresql_boolean','binding_id',b.id,
 'engagement_id',b.engagement_id,'action_id',action,'action_count',1,'closes_finding_count',0,'execution_allowed',false,'prepared_receipt',r.prepared_receipt::text,'reason',r.request->>'reason'));
 result:=jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'operationKey',p_operation_key,'requestHash',r.request_hash,
 'bindingId',b.id,'engagementId',b.engagement_id,'planId',plan,'actionId',action,'purpose','remediation','generatedBy','human','status','review',
 'actionCount',1,'closesFindingCount',0,'approvalTokenId',null,'executionAllowed',false,'humanReceipt',receipt::text,
 'snapshotHash',owned_synthetic.snapshot_sha256(original),'validationHash',p_validation_hash);
 update owned_synthetic.human_requests set state='recorded',roundtrip=proof,receipt=result where operation_key=p_operation_key;
 return result;
end $$;

create function public.cancel_owned_human_request(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_request_hash text,p_cancellation_key uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r owned_synthetic.human_requests;receipt bigint;result jsonb;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_cancellation_key is null or p_reason is null or length(p_reason) not between 20 and 2000 or p_reason<>btrim(p_reason)
 then raise exception 'owned cancellation refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,167));
 select * into r from owned_synthetic.human_requests where operation_key=p_operation_key for update;
 if r.operation_key is null or(r.tenant_id,r.actor_id,r.request_hash) is distinct from(p_tenant_id,p_actor_id,p_request_hash)
 then raise exception 'owned cancellation source refused' using errcode='42501';end if;
 if r.state='cancelled' then
  if r.cancellation_key<>p_cancellation_key or r.receipt->>'reason'<>p_reason
  then raise exception 'owned cancellation conflict' using errcode='23505';end if;
  return r.receipt;
 end if;
 if r.state<>'pending' then raise exception 'recorded plan cannot be cancelled here' using errcode='42501';end if;
 receipt:=public.append_ledger(p_tenant_id,p_cancellation_key,'human',p_actor_id::text,null,null,null,'plan.owned_request.cancelled',p_operation_key::text,
 p_request_hash,null,null,null,null,null,'success',jsonb_build_object('provenance','owned_synthetic_postgresql_boolean','operation_key',p_operation_key,'reason',p_reason,'execution_allowed',false));
 result:=jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'operationKey',p_operation_key,'requestHash',p_request_hash,
 'cancellationKey',p_cancellation_key,'reason',p_reason,'state','cancelled','humanReceipt',receipt::text,'planId',null,'executionAllowed',false);
 update owned_synthetic.human_requests set state='cancelled',cancellation_key=p_cancellation_key,receipt=result where operation_key=p_operation_key;
 return result;
end $$;
create function public.read_owned_human_request_outcome(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_operation_key uuid,p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r owned_synthetic.human_requests;
begin
 perform owned_synthetic.human_authority(p_tenant_id,p_actor_id,p_session_id);
 select * into r from owned_synthetic.human_requests where operation_key=p_operation_key and tenant_id=p_tenant_id and actor_id=p_actor_id and request_hash=p_request_hash;
 if not found then raise exception 'owned human outcome refused' using errcode='42501';end if;
 return jsonb_build_object('state',r.state,'receipt',r.receipt);
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.verify_owned_human_plan_authority(uuid,uuid,uuid),public.verify_owned_human_stop_authority(uuid,uuid,uuid),
 public.read_owned_human_targets(uuid,uuid,uuid,uuid),public.prepare_owned_human_plan(uuid,uuid,uuid,uuid,jsonb,text),
 public.record_owned_measured_plan(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,text),public.cancel_owned_human_request(uuid,uuid,uuid,uuid,text,uuid,text),
 public.read_owned_human_request_outcome(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role,agent_ledger_writer,owned_target_controller;
grant execute on function public.verify_owned_human_plan_authority(uuid,uuid,uuid),public.verify_owned_human_stop_authority(uuid,uuid,uuid),
 public.read_owned_human_targets(uuid,uuid,uuid,uuid),public.prepare_owned_human_plan(uuid,uuid,uuid,uuid,jsonb,text),
 public.record_owned_measured_plan(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,text),public.cancel_owned_human_request(uuid,uuid,uuid,uuid,text,uuid,text),
 public.read_owned_human_request_outcome(uuid,uuid,uuid,uuid,text) to human_action_writer;
