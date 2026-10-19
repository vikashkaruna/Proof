-- Explicit protected deployment enrollment, never an application feature flag.
-- Does not widen the cloud-IAM resolver or enable connector writes.
-- Roles are cluster-wide: another application database may already have
-- created this same narrow role. Reuse only its exact nonprivileged identity.
do $sandbox_role$
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_sandbox_connector_operator') then
  begin
   create role axiom_sandbox_connector_operator nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  exception when duplicate_object or unique_violation then
   null; -- Concurrent database bootstrap; verify committed identity below.
  end;
 end if;
 if not exists(select 1 from pg_catalog.pg_roles
  where rolname='axiom_sandbox_connector_operator'
   and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
   and not rolcreaterole and not rolreplication and not rolbypassrls
   and not exists(select 1 from pg_catalog.pg_auth_members membership where membership.member=pg_roles.oid)) then
  raise exception using errcode='42501',message='sandbox operator role identity refused';
 end if;
end
$sandbox_role$;
create table public.postgresql_sandbox_deployments (
 configuration_sha256 text not null check(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 tenant_id uuid not null references public.tenants(id),
 connector_id uuid not null,
 descriptor_sha256 text not null check(descriptor_sha256 ~ '^[a-f0-9]{64}$'),
 endpoint_ref text not null,
 environment text not null check(environment in ('local','test')),
 disposable_target boolean not null check(disposable_target),
 approval_reference uuid not null,
 custody_policy_id uuid not null,
 custody_activation_epoch bigint not null check(custody_activation_epoch>0),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 primary key(configuration_sha256,tenant_id,connector_id),
 foreign key(tenant_id,custody_policy_id) references public.local_custody_policy_versions(tenant_id,id),
 foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id)
);
alter table public.postgresql_sandbox_deployments enable row level security;
revoke all on public.postgresql_sandbox_deployments from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant select,insert,update on public.postgresql_sandbox_deployments to axiom_sandbox_connector_operator;
create policy sandbox_operator on public.postgresql_sandbox_deployments to axiom_sandbox_connector_operator using(true) with check(true);
create function public.resolve_sandbox_postgresql_read_grant(
 p_tenant_id uuid,p_estate_id uuid,p_connector_id uuid,p_spiffe_id text,p_configuration_sha256 text
) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('grantId',g.id,'workloadId',w.id,'agentName',g.agent_name,'spiffeId',w.spiffe_id,
 'systemId',s.id,'grantExpiresAt',least(g.expires_at,approved.expires_at),'connectorVersion',c.version,
 'descriptorSha256',d.content_sha256,'endpointRef',c.endpoint_ref,'targetBinding',c.target_binding)
 from public.connector_grants g
 join public.workload_identities w on(w.tenant_id,w.id,w.agent_name)=(g.tenant_id,g.workload_identity_id,g.agent_name)
 join public.connectors c on(c.tenant_id,c.id)=(g.tenant_id,g.connector_id)
 join public.estate_systems s on(s.tenant_id,s.id)=(c.tenant_id,c.system_id)
 join public.estates e on(e.tenant_id,e.id)=(s.tenant_id,s.estate_id)
 join public.tenants t on t.id=e.tenant_id and t.is_demo
 join public.connector_descriptors d on d.id=c.descriptor_id and d.target_binding=c.target_binding
 join public.postgresql_sandbox_deployments approved on approved.tenant_id=c.tenant_id and approved.connector_id=c.id
  and approved.configuration_sha256=p_configuration_sha256 and approved.descriptor_sha256=d.content_sha256
  and approved.endpoint_ref=c.endpoint_ref and approved.environment in('local','test') and approved.disposable_target
  and approved.revoked_at is null and approved.expires_at>statement_timestamp()
 join public.local_custody_policy_heads custody on custody.tenant_id=approved.tenant_id and custody.policy_id=approved.custody_policy_id
  and custody.state='active' and custody.activation_epoch=approved.custody_activation_epoch
 join public.local_custody_policy_versions policy on policy.tenant_id=custody.tenant_id and policy.id=custody.policy_id
 join public.tenant_users operator_member on operator_member.tenant_id=policy.tenant_id and operator_member.user_id=policy.nominated_operator_id
  and operator_member.role in('founder','axiom_analyst')
 join public.users operator_user on operator_user.id=operator_member.user_id and operator_user.is_axiom_internal
 where g.tenant_id=p_tenant_id and e.id=p_estate_id and c.id=p_connector_id
 and g.internal_scope='connector.read' and g.agent_name='drishti'
 and d.transport='sql' and d.manifest->>'target'='postgresql' and d.manifest->>'auth'='legacy_static' and c.target_binding='sandbox'
 and w.spiffe_id=p_spiffe_id and w.status='active' and g.revoked_at is null and g.expires_at>statement_timestamp()
 and c.status='active' and s.status='active' and e.status='active'
 and not exists(select 1 from public.kill_switch_state ks where ks.engaged and(ks.scope='global' or ks.tenant_id=p_tenant_id))
 order by g.expires_at desc limit 1
$$;
revoke all on function public.resolve_sandbox_postgresql_read_grant(uuid,uuid,uuid,text,text) from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.resolve_sandbox_postgresql_read_grant(uuid,uuid,uuid,text,text) to service_role;

-- Deployment approval history is immutable apart from one-way revocation. No
-- shared application role can write it; privileged operator bootstrap is explicit.
create function controller_security.sandbox163_enrollment_audit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' and not exists(
  select 1 from public.local_custody_policy_heads h
  join public.local_custody_policy_versions p on p.tenant_id=h.tenant_id and p.id=h.policy_id
  join public.tenant_users m on m.tenant_id=p.tenant_id and m.user_id=p.nominated_operator_id and m.role in('founder','axiom_analyst')
  join public.users u on u.id=m.user_id and u.is_axiom_internal
  join public.tenants t on t.id=p.tenant_id and t.is_demo
  where h.tenant_id=new.tenant_id and h.policy_id=new.custody_policy_id
   and h.activation_epoch=new.custody_activation_epoch and h.state='active'
 ) then raise exception 'sandbox enrollment authority refused' using errcode='42501';end if;
 if tg_op='UPDATE' and (old.revoked_at is not null or new.revoked_at is null
  or (to_jsonb(old)-'revoked_at') is distinct from (to_jsonb(new)-'revoked_at')) then
  raise exception 'sandbox enrollment immutable' using errcode='42501';
 end if;
 perform public.append_ledger(new.tenant_id,new.approval_reference,'system','sandbox-connector-operator',null,null,null,
  'connector.updated',new.connector_id::text,null,new.configuration_sha256,null,null,null,null,'success',
  jsonb_build_object('deployment_kind','local_synthetic_postgresql','transition',case when tg_op='INSERT' then 'enrolled' else 'revoked' end,
   'configuration_sha256',new.configuration_sha256,'custody_policy_id',new.custody_policy_id,'custody_activation_epoch',new.custody_activation_epoch));
 return new;
end $$;
revoke all on function controller_security.sandbox163_enrollment_audit() from public,anon,authenticated,service_role;
create trigger sandbox163_enrollment_audit before insert or update on public.postgresql_sandbox_deployments
 for each row execute function controller_security.sandbox163_enrollment_audit();
create trigger sandbox163_no_delete before delete on public.postgresql_sandbox_deployments for each row execute function public.evidence_receipt_immutable();
create trigger sandbox163_no_truncate before truncate on public.postgresql_sandbox_deployments for each statement execute function public.evidence_receipt_immutable();
