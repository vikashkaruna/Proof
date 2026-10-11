-- Durable operator navigation and reconciliation are READ ONLY. A request key
-- identifies a recorded human attempt; it never starts, claims or retries one.
create index public_source_observations_newest on public.public_source_observations(tenant_id,engagement_id,binding_id,created_at desc,id desc);
create index public_source_engagement_choices on public.engagements(tenant_id,created_at desc,id desc) where status<>'cancelled';

create function public.public_source_read_member(p_tenant_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.user_role;i boolean;
begin
 if p_tenant_id is null or p_actor_id is null then return jsonb_build_object('error','invalid_record');end if;
 select role into r from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into i from public.users where id=p_actor_id for share;
 if r is null or r='agent' or i is null or (r in ('founder','axiom_analyst') and i is distinct from true)
 then return jsonb_build_object('error','forbidden');end if;
 return '{}'::jsonb;
end $$;
revoke all on function public.public_source_read_member(uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.public_source_observation_metadata(o public.public_source_observations)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('observation_id',o.id,'dispatch_id',o.dispatch_id,'run_id',o.run_id,'tenant_id',o.tenant_id,'engagement_id',o.engagement_id,'binding_id',o.binding_id,'agent',o.agent,'output_sha256',o.output_sha256,'completion_receipt',o.completion_receipt::text,'created_at',o.created_at)
$$;
revoke all on function public.public_source_observation_metadata(public.public_source_observations) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.list_public_source_engagements(p_tenant_id uuid,p_actor_id uuid,p_limit integer,p_cursor_created_at timestamptz,p_cursor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;e public.engagements;estate_name text;items jsonb:='[]';n integer:=0;more boolean:=false;last_cursor jsonb;
begin
 if p_limit is null or p_limit not between 1 and 50 or (p_cursor_created_at is null)<>(p_cursor_id is null)
 then return jsonb_build_object('error','invalid_record');end if;
 authority:=public.public_source_read_member(p_tenant_id,p_actor_id);
 if authority?'error' then return authority;end if;
 for e in select * from public.engagements where tenant_id=p_tenant_id and status<>'cancelled'
  and (p_cursor_id is null or (created_at,id)<(p_cursor_created_at,p_cursor_id))
  order by created_at desc,id desc limit p_limit+1 for share loop
  n:=n+1;if n>p_limit then more:=true;exit;end if;
  estate_name:=null;
  if e.estate_id is not null then
   select name into estate_name from public.estates where tenant_id=p_tenant_id and id=e.estate_id for share;
   if not found then return jsonb_build_object('error','context_refused');end if;
  end if;
  items:=items||jsonb_build_array(jsonb_build_object('id',e.id,'tenant_id',e.tenant_id,'title',e.title,'status',e.status,'library_version',e.library_version,'created_at',e.created_at,
   'estate',case when e.estate_id is null then null else jsonb_build_object('id',e.estate_id,'name',estate_name) end));
  last_cursor:=jsonb_build_object('created_at',e.created_at,'id',e.id);
 end loop;
 return jsonb_build_object('tenant_id',p_tenant_id,'data',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then last_cursor else null end);
end $$;
revoke all on function public.list_public_source_engagements(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.list_public_source_engagements(uuid,uuid,integer,timestamptz,uuid) to human_action_writer;

create function public.list_public_source_observations(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_limit integer,p_cursor_created_at timestamptz,p_cursor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;o public.public_source_observations;items jsonb:='[]';n integer:=0;more boolean:=false;last_cursor jsonb;
begin
 if p_binding_id is null or p_limit is null or p_limit not between 1 and 50 or (p_cursor_created_at is null)<>(p_cursor_id is null)
 then return jsonb_build_object('error','invalid_record');end if;
 authority:=public.public_source_context_authorized(p_tenant_id,p_actor_id,p_engagement_id,false);
 if authority?'error' then return authority;end if;
 perform 1 from public.public_source_bindings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and id=p_binding_id for share;
 if not found then return jsonb_build_object('error','source_refused');end if;
 for o in select * from public.public_source_observations where tenant_id=p_tenant_id and engagement_id=p_engagement_id and binding_id=p_binding_id
  and (p_cursor_id is null or (created_at,id)<(p_cursor_created_at,p_cursor_id))
  order by created_at desc,id desc limit p_limit+1 for share loop
  n:=n+1;if n>p_limit then more:=true;exit;end if;
  items:=items||jsonb_build_array(public.public_source_observation_metadata(o));
  last_cursor:=jsonb_build_object('created_at',o.created_at,'id',o.id);
 end loop;
 return jsonb_build_object('tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'binding_id',p_binding_id,'data',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then last_cursor else null end);
end $$;
revoke all on function public.list_public_source_observations(uuid,uuid,uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.list_public_source_observations(uuid,uuid,uuid,uuid,integer,timestamptz,uuid) to human_action_writer;

create function public.reconcile_public_source_request(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_agent text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;r public.agent_runs;d public.public_source_dispatches;claim public.public_source_dispatch_claims;
 q public.audit_ledger;a public.audit_ledger;c public.audit_ledger;s public.audit_ledger;o public.public_source_observations;
 context jsonb;unknown jsonb;prepared jsonb;expected_action text;
begin
 if p_binding_id is null or p_agent is null or p_agent not in ('drishti','vibhaag') or p_correlation_id is null
 then return jsonb_build_object('error','invalid_record');end if;
 authority:=public.public_source_context_authorized(p_tenant_id,p_actor_id,p_engagement_id,false);
 if authority?'error' then return authority;end if;
 perform 1 from public.public_source_bindings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and id=p_binding_id for share;
 if not found then return jsonb_build_object('error','source_refused');end if;
 context:=jsonb_build_object('tenant_id',p_tenant_id,'actor_id',p_actor_id,'engagement_id',p_engagement_id,'binding_id',p_binding_id,'agent',p_agent,'correlation_id',p_correlation_id);
 select * into r from public.agent_runs where tenant_id=p_tenant_id and agent=p_agent and correlation_id=p_correlation_id
  and metadata->>'lifecycle_writer'='generic_agent_rpc_v1' and metadata->>'requested_by'=p_actor_id::text for share;
 if not found then return context||jsonb_build_object('outcome',jsonb_build_object('state','not_found'));end if;
 if r.engagement_id is distinct from p_engagement_id then return jsonb_build_object('error','request_context_conflict');end if;
 unknown:=context||jsonb_build_object('outcome',jsonb_build_object('state','unknown','run_id',r.id));
 select * into q from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->>'request_receipt';
 if q.id is null or q.actor_type<>'human' or q.actor_id is distinct from p_actor_id::text or q.action_type<>'agent.invocation.requested'
 or q.target_ref is distinct from r.id::text or q.correlation_id is distinct from r.correlation_id
 or q.input_hash is distinct from r.input_redacted_hash or q.input_hash is null or q.input_hash !~ '^[a-f0-9]{64}$'
 or r.metadata->>'request_input_hash' is distinct from q.input_hash or q.result<>'pending'
 or q.detail->>'agent' is distinct from p_agent or q.detail->>'engagement_id' is distinct from p_engagement_id::text then return unknown;end if;
 select * into d from public.public_source_dispatches where tenant_id=p_tenant_id and run_id=r.id for share;
 if d.id is null then return unknown;end if;
 if d.binding_id is distinct from p_binding_id then return jsonb_build_object('error','request_context_conflict');end if;
 unknown:=context||jsonb_build_object('outcome',jsonb_build_object('state','unknown','run_id',r.id,'dispatch_id',d.id));
 if d.engagement_id is distinct from p_engagement_id or d.agent is distinct from p_agent or d.actor_id is distinct from p_actor_id
 or d.request_receipt is distinct from q.id or d.request_hash is distinct from q.input_hash then return unknown;end if;
 prepared:=public.public_source_agent_input(p_tenant_id,p_engagement_id,p_binding_id,p_agent,d.source_observation_id);
 if prepared?'error' or prepared->'input' is distinct from d.input then return unknown;end if;
 select * into claim from public.public_source_dispatch_claims where tenant_id=p_tenant_id and dispatch_id=d.id for share;
 if claim.dispatch_id is null or claim.run_id is distinct from r.id or claim.engagement_id is distinct from p_engagement_id
 or claim.binding_id is distinct from p_binding_id or claim.agent is distinct from p_agent or claim.actor_id is distinct from p_actor_id
 or claim.correlation_id is distinct from p_correlation_id or claim.request_hash is distinct from d.request_hash or claim.request_receipt is distinct from q.id
 then return unknown;end if;
 expected_action:=case p_agent when 'drishti' then 'discovery.started' else 'classification.started' end;
 if r.status='running' and r.completed_at is null and not (r.metadata?'settlement') then
  -- A durable completion contradicts a still-running generic row; its outcome
  -- awaits confirmation rather than being reported as currently executing.
  perform 1 from public.audit_ledger where tenant_id=p_tenant_id and actor_type='agent' and actor_id=p_agent
   and correlation_id=p_correlation_id and detail->>'run_id'=r.id::text and detail->>'phase' in ('completed','failed');
  if found then return unknown;end if;
  return context||jsonb_build_object('outcome',jsonb_build_object('state','running','run_id',r.id,'dispatch_id',d.id));
 end if;
 select * into s from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->>'settlement_receipt';
 if s.id is null or s.actor_type<>'system' or s.actor_id<>'bff-generic-agent-controller' or s.action_type<>'agent.invocation.settled'
 or s.target_ref is distinct from r.id::text or s.correlation_id is distinct from p_correlation_id or s.input_hash is distinct from d.request_hash
 or s.detail->>'requested_by' is distinct from p_actor_id::text or s.detail->>'agent' is distinct from p_agent
 or s.detail->>'runtime_outcome' is distinct from r.metadata->>'runtime_outcome' or s.sequence_no<=q.sequence_no or r.completed_at is null
 then return unknown;end if;
 if r.status='failed' and r.error='agent_reported_failure' and r.metadata->>'runtime_outcome'='runtime_reported_failure'
 and r.metadata->'settlement'->>'status'='failed' and r.metadata->'settlement'->>'error'='agent_reported_failure'
 and s.result='failure' and s.output_hash is null and r.output_redacted_hash is null then
  perform 1 from public.audit_ledger where tenant_id=p_tenant_id and actor_type='agent' and actor_id=p_agent
   and correlation_id=p_correlation_id and detail->>'run_id'=r.id::text and detail->>'phase'='completed' and result='success';
  if found then return unknown;end if;
  return context||jsonb_build_object('outcome',jsonb_build_object('state','confirmed_failed','run_id',r.id,'dispatch_id',d.id,'settlement_receipt',s.id::text,'error_code','agent_reported_failure'));
 end if;
 if r.status<>'succeeded' or r.error is not null or r.metadata->>'runtime_outcome' is distinct from 'receipt_confirmed'
 or r.metadata->'settlement'->>'status' is distinct from 'succeeded' or r.metadata->'settlement'->>'error' is not null
 or s.result<>'success' or r.output_redacted_hash is null or r.output_redacted_hash !~ '^[a-f0-9]{64}$'
 or r.metadata->>'runtime_normalized_input_hash' is distinct from d.request_hash
 or r.metadata->>'runtime_output_hash' is distinct from r.output_redacted_hash or r.metadata->>'response_output_hash' is distinct from r.output_redacted_hash
 or r.metadata->'settlement'->>'response_hash' is distinct from r.output_redacted_hash or s.output_hash is distinct from r.output_redacted_hash
 then return unknown;end if;
 select * into a from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->'settlement'->>'started_receipt';
 select * into c from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->'settlement'->>'completed_receipt';
 if a.id is null or c.id is null or a.actor_type<>'agent' or c.actor_type<>'agent' or a.actor_id is distinct from p_agent or c.actor_id is distinct from p_agent
 or a.action_type::text is distinct from expected_action or c.action_type::text is distinct from expected_action
 or a.result<>'pending' or c.result<>'success' or a.target_ref is distinct from p_engagement_id::text or c.target_ref is distinct from p_engagement_id::text
 or a.correlation_id is distinct from p_correlation_id or c.correlation_id is distinct from p_correlation_id
 or a.agent_version is null or a.agent_version is distinct from c.agent_version
 or a.input_hash is distinct from d.request_hash or c.input_hash is distinct from d.request_hash or c.output_hash is distinct from r.output_redacted_hash
 or a.detail->>'phase' is distinct from 'started' or c.detail->>'phase' is distinct from 'completed'
 or a.detail->>'run_id' is distinct from r.id::text or c.detail->>'run_id' is distinct from r.id::text
 or a.detail->>'request_hash' is distinct from d.request_hash or c.detail->>'request_hash' is distinct from d.request_hash
 or c.detail->>'started_entry' is distinct from a.id::text
 or s.detail->>'started_receipt' is distinct from a.id::text or s.detail->>'completed_receipt' is distinct from c.id::text
 or a.sequence_no<=q.sequence_no or c.sequence_no<=a.sequence_no or s.sequence_no<=c.sequence_no then return unknown;end if;
 select * into o from public.public_source_observations where tenant_id=p_tenant_id and run_id=r.id for share;
 if not found then
  return context||jsonb_build_object('outcome',jsonb_build_object('state','completed_without_observation','run_id',r.id,'dispatch_id',d.id,'output_sha256',r.output_redacted_hash,'completion_receipt',c.id::text));
 end if;
 if o.dispatch_id is distinct from d.id or o.binding_id is distinct from p_binding_id or o.engagement_id is distinct from p_engagement_id or o.agent is distinct from p_agent
 or o.actor_id is distinct from p_actor_id or o.output_sha256 is distinct from r.output_redacted_hash or o.completion_receipt is distinct from c.id or o.settlement_receipt is distinct from s.id
 or encode(sha256(convert_to(o.output_utf8,'UTF8')),'hex') is distinct from o.output_sha256
 or o.output is distinct from public.public_source_expected_output(d.input,p_agent) then return unknown;end if;
 return context||jsonb_build_object('outcome',jsonb_build_object('state','retained','observation',public.public_source_observation_metadata(o)));
end $$;
revoke all on function public.reconcile_public_source_request(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.reconcile_public_source_request(uuid,uuid,uuid,uuid,text,uuid) to human_action_writer;
