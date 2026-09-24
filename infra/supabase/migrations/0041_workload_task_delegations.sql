-- W4.3 task authority. Identity, task delegation and connector approval are
-- separate gates. This migration exposes no client/worker SQL write capability.
alter type public.ledger_action_type add value if not exists 'workload.task_delegated';
alter type public.ledger_action_type add value if not exists 'workload.task_revoked';

alter table public.agent_runs add constraint agent_runs_tenant_id_agent_unique unique(tenant_id,id,agent);
alter table public.engagements add constraint engagements_tenant_id_unique unique(tenant_id,id);

create table public.workload_task_delegations (
  run_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  workload_identity_id uuid not null,
  agent_name text not null,
  created_by uuid not null references public.users(id) on delete restrict,
  estate_id uuid,
  engagement_id uuid,
  correlation_id uuid not null,
  input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
  proof_hash text not null unique check(proof_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key(tenant_id,run_id,agent_name) references public.agent_runs(tenant_id,id,agent) on delete restrict,
  foreign key(tenant_id,workload_identity_id,agent_name) references public.workload_identities(tenant_id,id,agent_name) on delete restrict,
  foreign key(tenant_id,estate_id) references public.estates(tenant_id,id) on delete restrict,
  foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
  check(expires_at>created_at and expires_at<=created_at+interval '15 minutes'),
  check(revoked_at is null or revoked_at>=created_at),
  check(cardinality(scopes)<=32 and coalesce(array_ndims(scopes),1)=1 and array_position(scopes,null) is null)
);
alter table public.workload_task_delegations enable row level security;
revoke all on public.workload_task_delegations from public,anon,authenticated,service_role;
grant select on public.workload_task_delegations to service_role;
create policy backend_task_read on public.workload_task_delegations for select to service_role using(true);

-- A current tenant membership supplies where the initiator may operate. The
-- internal-only agents additionally require the independently controlled flag.
create function public.workload_task_actor_allowed(p_tenant_id uuid,p_actor_id uuid,p_agent text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id
  where m.tenant_id=p_tenant_id and m.user_id=p_actor_id
  and m.role in ('founder','owner','admin','axiom_analyst')
  and (m.role not in ('founder','axiom_analyst') or u.is_axiom_internal)
  and (p_agent not in ('sanket','nazar','lekha') or (m.role in ('founder','axiom_analyst') and u.is_axiom_internal)))
$$;
revoke all on function public.workload_task_actor_allowed(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.workload_task_actor_allowed(uuid,uuid,text) to service_role;

create function public.delegate_workload_task(
 p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_agent text,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_scopes text[],p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare run public.agent_runs; task public.workload_task_delegations; engagement public.engagements;
begin
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
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'workload.task_delegated',run.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('workload_id',p_workload_id,'agent',p_agent,'estate_id',p_estate_id,'engagement_id',p_engagement_id,'scopes',p_scopes,'expires_at',p_expires_at));
 return jsonb_build_object('run_id',run.id,'expires_at',task.expires_at);
end $$;
revoke all on function public.delegate_workload_task(uuid,uuid,uuid,text,uuid,uuid,uuid,text,text,text[],timestamptz) from public,anon,authenticated;
grant execute on function public.delegate_workload_task(uuid,uuid,uuid,text,uuid,uuid,uuid,text,text,text[],timestamptz) to service_role;

-- Inputs come from the BFF's verified SVID + hashed task proof, never directly
-- from an authenticated browser. The RPC does NOT verify a JWT or tool policy.
create function public.read_workload_task(
 p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_agent text,p_proof_hash text,p_scope text
) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('run_id',t.run_id,'tenant_id',t.tenant_id,'workload_id',t.workload_identity_id,
  'agent_name',t.agent_name,'created_by',t.created_by,'estate_id',t.estate_id,'engagement_id',t.engagement_id,
  'correlation_id',t.correlation_id,'input_hash',t.input_hash,'scopes',t.scopes,'expires_at',t.expires_at)
 from public.workload_task_delegations t
 join public.agent_runs r on (r.tenant_id,r.id,r.agent)=(t.tenant_id,t.run_id,t.agent_name)
 join public.workload_identities w on (w.tenant_id,w.id,w.agent_name)=(t.tenant_id,t.workload_identity_id,t.agent_name)
 where t.tenant_id=p_tenant_id and t.run_id=p_run_id and t.workload_identity_id=p_workload_id and t.agent_name=p_agent
 and t.proof_hash=p_proof_hash and p_scope=any(t.scopes) and t.revoked_at is null and t.expires_at>statement_timestamp()
 and r.status in ('queued','running') and r.completed_at is null and w.status='active'
 and r.correlation_id=t.correlation_id and r.engagement_id is not distinct from t.engagement_id and r.input_redacted_hash=t.input_hash
 and public.workload_task_actor_allowed(t.tenant_id,t.created_by,t.agent_name)
 and exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
 and not exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=t.tenant_id))
 and (t.estate_id is null or exists(select 1 from public.estates e where e.tenant_id=t.tenant_id and e.id=t.estate_id and e.status='active'))
 and (t.engagement_id is null or exists(select 1 from public.engagements e where e.tenant_id=t.tenant_id and e.id=t.engagement_id and e.estate_id is not distinct from t.estate_id and e.status<>'cancelled'))
$$;
revoke all on function public.read_workload_task(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.read_workload_task(uuid,uuid,uuid,text,text,text) to service_role;

create function public.revoke_workload_task(p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.workload_task_delegations; actor_role public.user_role;
begin
 select role into actor_role from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 if not found or actor_role not in ('founder','owner','admin','axiom_analyst') then return jsonb_build_object('error','forbidden'); end if;
 if actor_role in ('founder','axiom_analyst') then
  perform 1 from public.users where id=p_actor_id and is_axiom_internal for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
 end if;
 select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=p_run_id for update;
 if not found then return jsonb_build_object('error','not_found'); end if;
 if actor_role='axiom_analyst' and task.created_by<>p_actor_id then return jsonb_build_object('error','forbidden'); end if;
 if task.revoked_at is not null then return jsonb_build_object('revoked',true); end if;
 update public.workload_task_delegations set revoked_at=clock_timestamp() where run_id=p_run_id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'workload.task_revoked',p_run_id::text,null,null,null,null,null,null,'success',jsonb_build_object('workload_id',task.workload_identity_id));
 return jsonb_build_object('revoked',true);
end $$;
revoke all on function public.revoke_workload_task(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.revoke_workload_task(uuid,uuid,uuid,uuid) to service_role;
