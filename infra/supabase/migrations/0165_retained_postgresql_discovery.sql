-- New-family operation-scoped wrapper;0163 and production cloud-IAM resolver
-- remain unchanged. A read grant may allow listing without allowing samples.
create function public.resolve_sandbox_postgresql_read_grant_for_operation(
 p_tenant_id uuid,p_estate_id uuid,p_connector_id uuid,p_spiffe_id text,p_configuration_sha256 text,p_operation text
) returns jsonb language sql stable security definer set search_path='' as $$
 select resolved.value from (select public.resolve_sandbox_postgresql_read_grant(p_tenant_id,p_estate_id,p_connector_id,p_spiffe_id,p_configuration_sha256) value) resolved
 where p_operation in('enumerate','sample') and exists(select 1 from public.connector_grants g
 where g.tenant_id=p_tenant_id and g.id=(resolved.value->>'grantId')::uuid
 and (case p_operation when 'enumerate' then 'sql.enumerate' else 'sql.sample' end)=any(g.target_scopes))
$$;
revoke all on function public.resolve_sandbox_postgresql_read_grant_for_operation(uuid,uuid,uuid,text,text,text) from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.resolve_sandbox_postgresql_read_grant_for_operation(uuid,uuid,uuid,text,text,text) to service_role;

-- Human-triggered local synthetic read discovery. No external write approval,
-- no worker database credential, and no reuse of generic agent success receipts.
create table public.postgresql_discovery_requests (
 id uuid primary key,tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id),connector_id uuid not null,
 estate_id uuid not null,engagement_id uuid not null,
 configuration_sha256 text not null check(configuration_sha256~'^[a-f0-9]{64}$'),
 operation text not null check(operation in('enumerate','sample')),
 resource text,cursor text,sample_limit integer,
 status text not null default 'queued' check(status in('queued','claimed','read_completed','completed','failed','unconfirmed')),
 requested_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 claimed_at timestamptz,discovery_run_id uuid references public.connector_discovery_runs(id),
 completed_at timestamptz,cleanup_confirmed boolean,error_code text,
 check((operation='sample')=(resource is not null and sample_limit is not null)),
 check(resource is null or resource~'^[a-z_][a-z0-9_$]{0,62}\.[a-z_][a-z0-9_$]{0,62}$'),
 check(sample_limit is null or sample_limit between 1 and 200),
 check(cursor is null or length(cursor) between 1 and 500),
 foreign key(tenant_id,connector_id) references public.connectors(tenant_id,id),
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id)
);
alter table public.postgresql_discovery_requests enable row level security;
revoke all on public.postgresql_discovery_requests from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant select on public.postgresql_discovery_requests to service_role,authenticated;
create policy discovery165_backend_read on public.postgresql_discovery_requests for select to service_role using(true);
create policy discovery165_tenant_read on public.postgresql_discovery_requests for select to authenticated using(public.is_tenant_member(tenant_id));
create trigger discovery165_no_delete before delete on public.postgresql_discovery_requests for each row execute function public.evidence_receipt_immutable();
create trigger discovery165_no_truncate before truncate on public.postgresql_discovery_requests for each statement execute function public.evidence_receipt_immutable();

create function controller_security.discovery165_live(t uuid,j uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.postgresql_discovery_requests r
 join public.tenant_users m on m.tenant_id=r.tenant_id and m.user_id=r.actor_id and m.role in('founder','owner','admin')
 where r.tenant_id=t and r.id=j and r.expires_at>statement_timestamp()
 and public.resolve_sandbox_postgresql_read_grant_for_operation(r.tenant_id,r.estate_id,r.connector_id,'spiffe://local.axiomproof.test/agent/drishti',r.configuration_sha256,r.operation) is not null)
$$;
revoke all on function controller_security.discovery165_live(uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.request_postgresql_discovery(t uuid,a uuid,c uuid,j uuid,e uuid,engagement uuid,op text,resource text,lim integer,cursor text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.postgresql_discovery_requests; digest text;
begin
 perform 1 from public.tenant_users where tenant_id=t and user_id=a and role in('founder','owner','admin') for share;
 if not found then return jsonb_build_object('error','forbidden');end if;
 if op is null or op not in('enumerate','sample') or (op='sample') is distinct from (resource is not null and lim is not null)
  or (resource is not null and resource!~'^[a-z_][a-z0-9_$]{0,62}\.[a-z_][a-z0-9_$]{0,62}$')
  or (lim is not null and lim not between 1 and 200) or (cursor is not null and length(cursor) not between 1 and 500)
  or not exists(select 1 from public.engagements where tenant_id=t and id=engagement and estate_id=e)
 then return jsonb_build_object('error','context_refused');end if;
 perform pg_advisory_xact_lock(hashtextextended(j::text,165));
 select * into r from public.postgresql_discovery_requests where id=j;
 if found then
  if (r.tenant_id,r.actor_id,r.connector_id,r.estate_id,r.engagement_id,r.operation,r.resource,r.sample_limit,r.cursor)
    is distinct from (t,a,c,e,engagement,op,resource,lim,cursor) then return jsonb_build_object('error','request_conflict');end if;
  return jsonb_build_object('requestId',r.id,'status',r.status,'replayed',true);
 end if;
 select approved.configuration_sha256 into digest from public.postgresql_sandbox_deployments approved
 where approved.tenant_id=t and approved.connector_id=c
 and public.resolve_sandbox_postgresql_read_grant_for_operation(t,e,c,'spiffe://local.axiomproof.test/agent/drishti',approved.configuration_sha256,op) is not null
 order by approved.expires_at desc limit 1;
 if digest is null then return jsonb_build_object('error','discovery_unavailable');end if;
 insert into public.postgresql_discovery_requests(id,tenant_id,actor_id,connector_id,estate_id,engagement_id,configuration_sha256,operation,resource,sample_limit,cursor,expires_at)
 values(j,t,a,c,e,engagement,digest,op,resource,lim,cursor,clock_timestamp()+interval '2 minutes') returning * into r;
 perform public.append_ledger(t,j,'human',a::text,null,null,null,'connector.updated',c::text,null,null,null,null,null,null,'pending',jsonb_build_object('phase','discovery_requested','request_id',j,'operation',op));
 return jsonb_build_object('requestId',r.id,'status',r.status,'replayed',false);
end $$;
revoke all on function public.request_postgresql_discovery(uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text) from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.request_postgresql_discovery(uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text) to human_action_writer;

create function public.claim_postgresql_discovery(t uuid,j uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.postgresql_discovery_requests;
begin
 select * into r from public.postgresql_discovery_requests where tenant_id=t and id=j for update;
 if not found or r.status<>'queued' or not controller_security.discovery165_live(t,j) then return null;end if;
 update public.postgresql_discovery_requests set status='claimed',claimed_at=clock_timestamp() where id=j returning * into r;
 return jsonb_build_object('tenantId',r.tenant_id,'requestId',r.id,'connectorId',r.connector_id,'estateId',r.estate_id,'configurationSha256',r.configuration_sha256,
 'operation',r.operation,'resource',r.resource,'limit',r.sample_limit,'cursor',r.cursor,'expiresAt',r.expires_at);
end $$;
revoke all on function public.claim_postgresql_discovery(uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.claim_postgresql_discovery(uuid,uuid) to service_role;

create function public.retain_postgresql_discovery(t uuid,j uuid,discovery uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.postgresql_discovery_requests;d public.connector_discovery_runs;
begin
 select * into r from public.postgresql_discovery_requests where tenant_id=t and id=j for update;
 select * into d from public.connector_discovery_runs where tenant_id=t and id=discovery;
 if r.id is null or r.status<>'claimed' or not controller_security.discovery165_live(t,j)
  or d.id is null or d.connector_id<>r.connector_id or d.correlation_id<>r.id or d.created_at<r.claimed_at
  or d.operation<>r.operation or d.resource is distinct from r.resource then return null;end if;
 update public.postgresql_discovery_requests set status='read_completed',discovery_run_id=d.id where id=j;
 return jsonb_build_object('requestId',j,'discoveryRunId',d.id);
end $$;
revoke all on function public.retain_postgresql_discovery(uuid,uuid,uuid) from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.retain_postgresql_discovery(uuid,uuid,uuid) to service_role;

create function public.finish_postgresql_discovery(t uuid,a uuid,j uuid,clean boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.postgresql_discovery_requests;next_status text;
begin
 select * into r from public.postgresql_discovery_requests where tenant_id=t and actor_id=a and id=j for update;
 if not found or not exists(select 1 from public.tenant_users where tenant_id=t and user_id=a and role in('founder','owner','admin')) then return null;end if;
 if r.status in('completed','failed','unconfirmed') then return jsonb_build_object('requestId',j,'status',r.status);end if;
 next_status:=case when clean is true and r.status='read_completed' and controller_security.discovery165_live(t,j)
 and exists(select 1 from public.connector_discovery_runs d join public.connector_grants g on g.id=d.grant_id and g.tenant_id=d.tenant_id
  join public.workload_identities w on w.id=g.workload_identity_id and w.tenant_id=g.tenant_id
  where d.id=r.discovery_run_id and d.tenant_id=t and d.connector_id=r.connector_id and d.correlation_id=j
   and d.spiffe_id=w.spiffe_id and w.status='active' and g.revoked_at is null and g.expires_at>statement_timestamp())
 then 'completed' else 'unconfirmed' end;
 update public.postgresql_discovery_requests set status=next_status,completed_at=clock_timestamp(),cleanup_confirmed=clean,
 error_code=case when next_status='completed' then null else 'discovery_unconfirmed' end where id=j;
 perform public.append_ledger(t,j,'human',a::text,null,null,null,'connector.updated',r.connector_id::text,null,null,null,null,null,null,
 case when next_status='completed' then 'success'::public.ledger_result else 'failure'::public.ledger_result end,
 jsonb_build_object('phase','discovery_finished','request_id',j,'status',next_status,'cleanup_confirmed',clean));
 return jsonb_build_object('requestId',j,'status',next_status);
end $$;
revoke all on function public.finish_postgresql_discovery(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.finish_postgresql_discovery(uuid,uuid,uuid,boolean) to human_action_writer;

-- A stored read is not a supervised completed request. Preserve historical
-- independent discovery visibility while gating the new retained correlations.
drop policy tenant_member_read on public.connector_discovery_runs;
create policy tenant_member_read on public.connector_discovery_runs for select to authenticated
 using(public.is_tenant_member(tenant_id) and not exists(
  select 1 from public.postgresql_discovery_requests request
  where request.tenant_id=connector_discovery_runs.tenant_id and request.id=connector_discovery_runs.correlation_id
   and (request.status<>'completed' or request.cleanup_confirmed is distinct from true)
 ));
