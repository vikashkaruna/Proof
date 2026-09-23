-- Tenant application registration lifecycle. This does not enroll a SPIRE node
-- or grant connector execution. Existing bindings/statuses remain unchanged.
alter type public.ledger_action_type add value if not exists 'workload.registration_changed';
alter table public.workload_identities
 add column version integer not null default 1 check(version>0),
 add column lifecycle_receipt bigint references public.audit_ledger(id),
 add column updated_at timestamptz not null default now();
revoke insert,update,delete on public.workload_identities from service_role;

create function public.manage_workload_identity(
 p_tenant_id uuid,p_actor_id uuid,p_correlation_id uuid,p_workload_id uuid,
 p_expected_version integer,p_agent text,p_spiffe_id text,p_status text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.workload_identities; actor_role public.user_role; internal_actor boolean;
 receipt bigint; tasks_revoked integer:=0; grants_revoked integer:=0; operation text;
begin
 if p_tenant_id is null or p_actor_id is null or p_correlation_id is null or p_workload_id is null
  or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or p_agent is null or p_agent not in ('drishti','vibhaag','parikshan','saakshi','sudhaar','karya','lekha','nazar','prativedan','sanket')
  or p_spiffe_id is null or length(p_spiffe_id)>2048 or p_status is null or p_status not in ('active','disabled')
 then return jsonb_build_object('error','invalid_registration'); end if;
 select role into actor_role from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal_actor from public.users where id=p_actor_id for share;
 if actor_role is null or not (actor_role in ('owner','admin') or (actor_role='founder' and internal_actor is true))
 then return jsonb_build_object('error','forbidden'); end if;
 -- The absent-row case and concurrent reviewed revisions serialize as well.
 perform pg_advisory_xact_lock(hashtextextended(p_workload_id::text,48));
 select * into w from public.workload_identities where id=p_workload_id for update;
 if found then
  if w.tenant_id<>p_tenant_id then return jsonb_build_object('error','not_found'); end if;
  if w.agent_name<>p_agent or w.spiffe_id<>p_spiffe_id then return jsonb_build_object('error','binding_immutable'); end if;
  -- Immediate lost-response replay cannot reverse a later status transition.
  if w.lifecycle_receipt is not null and w.status=p_status and p_expected_version in (w.version,w.version-1)
  then return jsonb_build_object('tenant_id',w.tenant_id,'workload_id',w.id,'version',w.version,'status',w.status,'receipt',w.lifecycle_receipt::text); end if;
  if p_expected_version<>w.version then return jsonb_build_object('error','version_conflict'); end if;
 else
  if p_expected_version<>0 or p_status<>'disabled' then return jsonb_build_object('error','registration_required'); end if;
 end if;
 -- New registrations and activation use the reviewed ten-agent ID convention.
 -- Legacy malformed bindings can still be disabled; never rewrite their identity.
 if w.id is null or p_status='active' then
  if p_spiffe_id ~ '[[:space:]]' or p_spiffe_id like '%..%'
   or p_spiffe_id !~ ('^spiffe://[a-z0-9]([a-z0-9.-]*[a-z0-9])?/agent/'||p_agent||'$')
  then return jsonb_build_object('error','invalid_registration'); end if;
 end if;
 if w.id is null then
  insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
   values(p_workload_id,p_tenant_id,p_agent,p_spiffe_id,'disabled') returning * into w;
  operation:='register';
 else
  if p_status='disabled' then
   -- Tools/issuance take the registration SHARE lock before these task locks.
   -- Never revive old proofs or grants when this registration is re-enabled.
   perform 1 from public.workload_task_delegations where tenant_id=p_tenant_id and workload_identity_id=w.id
    and revoked_at is null order by run_id for update;
   update public.workload_task_delegations set revoked_at=clock_timestamp()
    where tenant_id=p_tenant_id and workload_identity_id=w.id and revoked_at is null;
   get diagnostics tasks_revoked = row_count;
   update public.connector_grants set revoked_at=clock_timestamp()
    where tenant_id=p_tenant_id and workload_identity_id=w.id and revoked_at is null;
   get diagnostics grants_revoked = row_count;
  end if;
  update public.workload_identities set status=p_status,version=version+1,updated_at=clock_timestamp()
   where id=w.id returning * into w;
  operation:=case when p_status='active' then 'activate' else 'disable' end;
 end if;
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'workload.registration_changed',w.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('operation',operation,'agent',w.agent_name,'spiffe_id',w.spiffe_id,'status',w.status,
   'version',w.version,'tasks_revoked',tasks_revoked,'grants_revoked',grants_revoked));
 update public.workload_identities set lifecycle_receipt=receipt where id=w.id;
 return jsonb_build_object('tenant_id',w.tenant_id,'workload_id',w.id,'version',w.version,'status',w.status,'receipt',receipt::text);
exception when unique_violation then return jsonb_build_object('error','registration_conflict');
end $$;
revoke all on function public.manage_workload_identity(uuid,uuid,uuid,uuid,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_workload_identity(uuid,uuid,uuid,uuid,integer,text,text,text) to service_role;
