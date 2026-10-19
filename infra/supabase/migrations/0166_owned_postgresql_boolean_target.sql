-- A single reversible setting in an owned synthetic PostgreSQL schema.
-- This is NOT an external/customer connector and does not widen 0163 reads.
-- No role membership, login, credential, enrollment or target row is created.
-- Deployment/enrollment remains an explicit privileged operator procedure.
-- The existing executor must validate the signed approval before this target
-- port is invoked; this port additionally checks its persisted execution fences.
-- Reuse a cluster-wide role only after validating all of its authority flags.
-- No ALTER ROLE or membership grant repairs an unsafe pre-existing identity.
do $owned_role$
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='owned_target_controller') then
  begin
   create role owned_target_controller nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  exception when duplicate_object or unique_violation then
   null;
  end;
 end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='owned_target_controller'
  and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
  and not rolcreaterole and not rolreplication and not rolbypassrls
   and not exists(select 1 from pg_catalog.pg_auth_members membership where membership.member=pg_roles.oid)) then
  raise exception using errcode='42501',message='owned target controller role identity refused';
 end if;
end
$owned_role$;
create schema owned_synthetic;
revoke all on schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;

create table owned_synthetic.resources (
 fixture_id uuid not null, resource_id uuid not null,
 version bigint not null default 0 check(version between 0 and 9007199254740989),
 audit_log_enabled boolean not null default false,
 primary key(fixture_id,resource_id)
);
create table owned_synthetic.bindings (
 id uuid primary key, tenant_id uuid not null references public.tenants(id),
 connector_id uuid not null, engagement_id uuid not null, action_id uuid,
 fixture_id uuid not null, resource_id uuid not null,
 environment text not null check(environment in('local','test')),
 label text not null check(label='Owned synthetic audit configuration'),
 scope text not null check(scope='owned_synthetic_config.audit_log_enable'),
 state text not null default 'active' check(state in('active','revoked')),
 custody_policy_id uuid not null, custody_activation_epoch bigint not null check(custody_activation_epoch>0),
 engine_sha256 text not null check(engine_sha256~'^[a-f0-9]{64}$'),
 capability_sha256 text not null check(capability_sha256='a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9'),
 approval_reference uuid not null, expires_at timestamptz not null,
 unique(tenant_id,id),unique(tenant_id,action_id),unique(fixture_id,resource_id),
 foreign key(fixture_id,resource_id) references owned_synthetic.resources(fixture_id,resource_id),
 foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 foreign key(tenant_id,action_id) references public.remediation_actions(tenant_id,id),
 foreign key(tenant_id,custody_policy_id) references public.local_custody_policy_versions(tenant_id,id)
);
create table owned_synthetic.operations (
 id uuid primary key, tenant_id uuid not null,binding_id uuid not null,
 action_id uuid not null,batch_id uuid not null,approval_token_id uuid not null,
 content_digest text not null check(content_digest~'^[a-f0-9]{64}$'),
 kind text not null check(kind in('forward','rollback')),
 before_snapshot jsonb not null,after_snapshot jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,binding_id,batch_id,kind),
 foreign key(tenant_id,binding_id) references owned_synthetic.bindings(tenant_id,id),
 foreign key(tenant_id,action_id) references public.remediation_actions(tenant_id,id),
 foreign key(tenant_id,batch_id) references public.execution_batches(tenant_id,id),
 foreign key(tenant_id,approval_token_id) references public.approval_tokens(tenant_id,id)
);
alter table owned_synthetic.resources enable row level security;
alter table owned_synthetic.bindings enable row level security;
alter table owned_synthetic.operations enable row level security;
revoke all on all tables in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
create trigger owned166_operation_no_update before update or delete on owned_synthetic.operations for each row execute function public.evidence_receipt_immutable();
create trigger owned166_operation_no_truncate before truncate on owned_synthetic.operations for each statement execute function public.evidence_receipt_immutable();

-- Preserve the privileged registration. Binding an as-yet unbound measured
-- plan is one-way; a different action/resource/tenant cannot replace it later.
create function owned_synthetic.binding_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.state='active' and new.state='revoked' and(to_jsonb(old)-'state')=(to_jsonb(new)-'state') then return new;end if;
 if old.state='active' and old.action_id is null and new.action_id is not null
  and(to_jsonb(old)-'action_id')=(to_jsonb(new)-'action_id') then return new;end if;
 raise exception 'owned target binding immutable' using errcode='42501';
end $$;
create trigger owned166_binding_immutable before update on owned_synthetic.bindings for each row execute function owned_synthetic.binding_immutable();
create trigger owned166_binding_no_delete before delete on owned_synthetic.bindings for each row execute function public.evidence_receipt_immutable();
create trigger owned166_binding_no_truncate before truncate on owned_synthetic.bindings for each statement execute function public.evidence_receipt_immutable();

-- One pure reducer is used for both the measured no-write roundtrip and CAS.
-- Its actual SQL implementation digest is registered and rechecked; it is not
-- represented as the separate Python implementation's source hash.
create function owned_synthetic.project(v jsonb,enabled boolean) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
 if enabled is null or jsonb_typeof(v)<>'object' or not(v?&array['fixture_id','resource_id','version','audit_log_enabled'])
  or v-array['fixture_id','resource_id','version','audit_log_enabled']<>'{}'::jsonb
  or jsonb_typeof(v->'version') is distinct from 'number' or (v->>'version')!~'^[0-9]{1,16}$'
  or (v->>'version')::bigint>9007199254740988 or jsonb_typeof(v->'audit_log_enabled') is distinct from 'boolean'
 then raise exception 'owned target snapshot refused' using errcode='22023';end if;
 return jsonb_build_object('fixture_id',(v->>'fixture_id')::uuid,'resource_id',(v->>'resource_id')::uuid,
  'version',(v->>'version')::bigint+1,'audit_log_enabled',enabled);
end $$;
create function owned_synthetic.engine_sha256() returns text language sql stable set search_path='' as $$
 select encode(sha256(convert_to(pg_get_functiondef('owned_synthetic.project(jsonb,boolean)'::regprocedure),'UTF8')),'hex')
$$;
create function owned_synthetic.snapshot(r owned_synthetic.resources) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('fixture_id',r.fixture_id,'resource_id',r.resource_id,'version',r.version,'audit_log_enabled',r.audit_log_enabled)
$$;
create function owned_synthetic.snapshot_sha256(v jsonb) returns text language sql immutable security definer set search_path='' as $$
 select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(v),'UTF8')),'hex')
$$;
create function owned_synthetic.require_binding(t uuid,b uuid,e uuid) returns owned_synthetic.bindings
language plpgsql volatile security definer set search_path='' as $$
declare v owned_synthetic.bindings;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended(t::text,47));
 select binding.* into v from owned_synthetic.bindings binding
 join public.tenants tenant on tenant.id=binding.tenant_id and tenant.is_demo
 join public.connectors c on(c.tenant_id,c.id)=(binding.tenant_id,binding.connector_id) and c.status='active' and c.target_binding='sandbox'
 join public.estate_systems s on(s.tenant_id,s.id)=(c.tenant_id,c.system_id) and s.status='active'
 join public.estates estate on(estate.tenant_id,estate.id)=(s.tenant_id,s.estate_id) and estate.status='active'
 join public.engagements engagement on(engagement.tenant_id,engagement.id,engagement.estate_id)=(binding.tenant_id,binding.engagement_id,estate.id)
 join public.local_custody_policy_heads h on(h.tenant_id,h.policy_id,h.activation_epoch)=(binding.tenant_id,binding.custody_policy_id,binding.custody_activation_epoch) and h.state='active'
 join public.local_custody_policy_versions p on(p.tenant_id,p.id)=(h.tenant_id,h.policy_id)
 join public.tenant_users m on(m.tenant_id,m.user_id)=(p.tenant_id,p.nominated_operator_id) and m.role in('founder','axiom_analyst')
 join public.users u on u.id=m.user_id and u.is_axiom_internal
 where binding.id=b and binding.tenant_id=t and binding.engagement_id=e and binding.state='active'
 and binding.expires_at>clock_timestamp() and binding.engine_sha256=owned_synthetic.engine_sha256()
 and not exists(select 1 from public.kill_switch_state k where k.engaged and(k.scope='global' or k.tenant_id=t))
 for share of binding;
 if not found then raise exception 'owned synthetic binding refused' using errcode='42501';end if;
 return v;
end $$;
create function public.read_owned_synthetic_target(p_tenant_id uuid,p_binding_id uuid,p_engagement_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b owned_synthetic.bindings;r owned_synthetic.resources;
begin
 b:=owned_synthetic.require_binding(p_tenant_id,p_binding_id,p_engagement_id);
 select * into strict r from owned_synthetic.resources where(fixture_id,resource_id)=(b.fixture_id,b.resource_id) for share;
 return owned_synthetic.snapshot(r);
end $$;
create function public.measure_owned_synthetic_target(p_tenant_id uuid,p_binding_id uuid,p_engagement_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b owned_synthetic.bindings;original jsonb;projected jsonb;restored jsonb;
begin
 b:=owned_synthetic.require_binding(p_tenant_id,p_binding_id,p_engagement_id);
 original:=public.read_owned_synthetic_target(p_tenant_id,p_binding_id,p_engagement_id);
 if (original->>'audit_log_enabled')::boolean then raise exception 'owned target no change' using errcode='22023';end if;
 projected:=owned_synthetic.project(original,true);restored:=owned_synthetic.project(projected,false);
 return jsonb_build_object('engine',jsonb_build_object('engine','owned_boolean_cas_v1','implementation_sha256',b.engine_sha256,
 'capability_sha256',b.capability_sha256,'capabilities',jsonb_build_array('atomic_exact_operation_journal','version_and_snapshot_cas','no_write_roundtrip')),
 'before',original,'projected_after',projected,'restored',restored,'persistent_mutations',0,'resources_measured',1);
end $$;

-- Exact target identity comes exclusively from privileged registration. A caller
-- cannot supply a SQL statement, endpoint, credential, action, batch or token.
-- The existing accepted execution resolves them from this binding's action.
create function public.cas_owned_synthetic_target(p_tenant_id uuid,p_binding_id uuid,p_engagement_id uuid,
 p_operation_id uuid,p_original jsonb,p_enabled boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare binding owned_synthetic.bindings;r owned_synthetic.resources;prior owned_synthetic.operations;applied owned_synthetic.operations;
 a public.remediation_actions;b public.execution_batches;token public.approval_tokens;d public.dry_runs;next_value jsonb;operation_kind text;
begin
 if p_operation_id is null or p_enabled is null then raise exception 'owned target request refused' using errcode='22023';end if;
 binding:=owned_synthetic.require_binding(p_tenant_id,p_binding_id,p_engagement_id);
 lock table public.kill_switch_state in share mode;
 -- Serialize all operations on the exact resource, including conflicting IDs.
 select * into strict r from owned_synthetic.resources where(fixture_id,resource_id)=(binding.fixture_id,binding.resource_id) for update;
 perform owned_synthetic.project(p_original,p_enabled); -- strict original shape
 if (p_original->>'fixture_id')::uuid<>binding.fixture_id or(p_original->>'resource_id')::uuid<>binding.resource_id
 then raise exception 'owned target identity refused' using errcode='42501';end if;
 select * into prior from owned_synthetic.operations where id=p_operation_id;
 if found then
  if(prior.tenant_id,prior.binding_id,prior.before_snapshot,prior.after_snapshot->'audit_log_enabled')
   is distinct from(p_tenant_id,p_binding_id,p_original,to_jsonb(p_enabled)) then raise exception 'owned operation conflict' using errcode='22023';end if;
  return prior.after_snapshot;
 end if;
 select * into a from public.remediation_actions where tenant_id=p_tenant_id and id=binding.action_id for share;
 select * into b from public.execution_batches where tenant_id=p_tenant_id and id=a.execution_batch_id for share;
 select * into token from public.approval_tokens where tenant_id=p_tenant_id and id=b.approval_token_id for share;
 select * into d from public.dry_runs where tenant_id=p_tenant_id and id=a.latest_dry_run_id;
 if a.id is null or b.id is null or token.id is null or a.action_type<>'config.audit_log_enable' or a.parameters<>'{"enabled":true}'::jsonb
  or a.approval_status<>'approved' or token.status<>'consumed' or token.revoked_at is not null or token.expires_at<=clock_timestamp()
  or a.execution_request_key is distinct from b.request_key or a.blast_radius->>'records' is distinct from '1'
  or a.approval_token_id is distinct from token.id or token.plan_id<>a.plan_id or b.plan_id<>a.plan_id
  or not(a.id=any(token.action_ids)) or token.signature='' or token.signed_payload->>'contentDigest' is distinct from b.content_digest
  or public.action_set_content_digest(p_tenant_id,a.plan_id,token.action_ids) is distinct from b.content_digest
  or d.id is null or d.action_id is distinct from a.id or d.plan_id is distinct from a.plan_id or d.status<>'succeeded' or d.expires_at<=clock_timestamp() or not d.renderable
  or d.parameters_hash<>encode(sha256(convert_to(a.parameters::text,'UTF8')),'hex')
  or d.rollback_definition_hash<>encode(sha256(convert_to(a.rollback_definition::text,'UTF8')),'hex')
  or not a.rollback_validated or a.dry_run_status<>'dry_run_complete'
 then raise exception 'owned target approval refused' using errcode='42501';end if;
 select * into applied from owned_synthetic.operations where tenant_id=p_tenant_id and binding_id=p_binding_id and batch_id=b.id and kind='forward';
 if p_enabled then
  operation_kind:='forward';
  if applied.id is not null or b.status not in('dispatched','running') or a.execution_status<>'executing'
   or(p_original->>'audit_log_enabled')::boolean or d.diff->>'source_snapshot_sha256' is distinct from owned_synthetic.snapshot_sha256(p_original)
   or d.diff->>'simulated_from' is distinct from 'owned_fixture_persisted_snapshot'
   or d.diff->>'records_measured' is distinct from '1'
   or a.rollback_definition is distinct from jsonb_build_object('enabled',false,'snapshot_sha256',owned_synthetic.snapshot_sha256(p_original))
  then raise exception 'owned forward authority refused' using errcode='42501';end if;
 else
  operation_kind:='rollback';
  if applied.id is null or applied.action_id<>a.id or applied.approval_token_id<>token.id or applied.after_snapshot<>p_original
   or b.status not in('dispatched','running','completed','partial_failure')
   or a.rollback_definition is distinct from jsonb_build_object('enabled',false,'snapshot_sha256',owned_synthetic.snapshot_sha256(applied.before_snapshot))
  then raise exception 'owned rollback authority refused' using errcode='42501';end if;
 end if;
 if owned_synthetic.snapshot(r)<>p_original or r.audit_log_enabled=p_enabled
 then raise exception 'owned target snapshot changed' using errcode='40001';end if;
 next_value:=owned_synthetic.project(p_original,p_enabled);
 insert into owned_synthetic.operations(id,tenant_id,binding_id,action_id,batch_id,approval_token_id,content_digest,kind,before_snapshot,after_snapshot)
 values(p_operation_id,p_tenant_id,p_binding_id,a.id,b.id,token.id,b.content_digest,operation_kind,p_original,next_value);
 update owned_synthetic.resources set version=(next_value->>'version')::bigint,audit_log_enabled=p_enabled where(fixture_id,resource_id)=(binding.fixture_id,binding.resource_id);
 perform public.append_ledger(p_tenant_id,p_operation_id,'agent','karya',null,null,null,'connector.updated',p_binding_id::text,
 owned_synthetic.snapshot_sha256(p_original),owned_synthetic.snapshot_sha256(next_value),token.id,token.approver_id,
 'owned-synthetic/snapshot/'||owned_synthetic.snapshot_sha256(p_original),'owned-synthetic/snapshot/'||owned_synthetic.snapshot_sha256(next_value),'success',
 jsonb_build_object('provenance','owned_synthetic_postgresql_boolean','operation',operation_kind,'action_id',a.id,'batch_id',b.id,'approval_token_id',token.id,'records_affected',1));
 return next_value;
end $$;
revoke all on all functions in schema owned_synthetic from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,owned_target_controller;
revoke all on function public.read_owned_synthetic_target(uuid,uuid,uuid),public.measure_owned_synthetic_target(uuid,uuid,uuid),
 public.cas_owned_synthetic_target(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_owned_synthetic_target(uuid,uuid,uuid),public.measure_owned_synthetic_target(uuid,uuid,uuid),
 public.cas_owned_synthetic_target(uuid,uuid,uuid,uuid,jsonb,boolean) to owned_target_controller;
