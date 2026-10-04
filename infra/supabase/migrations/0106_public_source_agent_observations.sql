-- A public source dispatch derives all facts from immutable 0105 storage.
-- Existing 0104 human request, runtime completion and confirmed settlement
-- receipts anchor these append-only records. JSONB projection codec is never
-- used in place of a runtime canonical UTF8 input/output commitment.
alter table public.public_source_bindings add constraint public_source_binding_context_identity unique(tenant_id,id,engagement_id);
create table public.public_source_dispatches (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
 engagement_id uuid not null, binding_id uuid not null, agent text not null check(agent in ('drishti','vibhaag')),
 source_observation_id uuid, run_id uuid not null, actor_id uuid not null references public.users(id) on delete restrict,
 request_receipt bigint not null, request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 input jsonb not null, input_utf8 text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,run_id),unique(tenant_id,id,binding_id,engagement_id,agent,run_id),
 check((agent='drishti' and source_observation_id is null) or (agent='vibhaag' and source_observation_id is not null)),
 check(octet_length(input_utf8) between 2 and 131072 and input_utf8::jsonb=input),
 check(request_hash=encode(sha256(convert_to(input_utf8,'UTF8')),'hex')),
 foreign key(tenant_id,binding_id,engagement_id) references public.public_source_bindings(tenant_id,id,engagement_id) on delete restrict,
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 foreign key(tenant_id,run_id,agent) references public.agent_runs(tenant_id,id,agent) on delete restrict,
 foreign key(tenant_id,request_receipt) references public.audit_ledger(tenant_id,id) on delete restrict
);
-- Once-only runtime transport claim survives ambiguous outcomes; no reclaim.
create table public.public_source_dispatch_claims (
 tenant_id uuid not null,dispatch_id uuid not null,run_id uuid not null,engagement_id uuid not null,binding_id uuid not null,
 agent text not null check(agent in ('drishti','vibhaag')),actor_id uuid not null references public.users(id) on delete restrict,
 correlation_id uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),request_receipt bigint not null,
 claimed_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,dispatch_id),unique(tenant_id,run_id),
 foreign key(tenant_id,dispatch_id,binding_id,engagement_id,agent,run_id) references public.public_source_dispatches(tenant_id,id,binding_id,engagement_id,agent,run_id) on delete restrict,
 foreign key(tenant_id,request_receipt) references public.audit_ledger(tenant_id,id) on delete restrict
);
create trigger public_source_dispatch_claim_immutable before update or delete on public.public_source_dispatch_claims for each row execute function public.evidence_receipt_immutable();
alter table public.public_source_dispatch_claims enable row level security;
revoke all on public.public_source_dispatch_claims from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant select on public.public_source_dispatch_claims to service_role;
create policy bff_read on public.public_source_dispatch_claims for select to service_role using(true);

create table public.public_source_observations (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
 engagement_id uuid not null,binding_id uuid not null,agent text not null check(agent in ('drishti','vibhaag')),
 dispatch_id uuid not null,run_id uuid not null,actor_id uuid not null references public.users(id) on delete restrict,
 output jsonb not null,output_utf8 text not null,output_sha256 text not null check(output_sha256 ~ '^[a-f0-9]{64}$'),
 completion_receipt bigint not null,settlement_receipt bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,run_id),unique(tenant_id,binding_id,id),
 check(octet_length(output_utf8) between 2 and 131072 and output_utf8::jsonb=output),
 check(output_sha256=encode(sha256(convert_to(output_utf8,'UTF8')),'hex')),
 foreign key(tenant_id,dispatch_id,binding_id,engagement_id,agent,run_id) references public.public_source_dispatches(tenant_id,id,binding_id,engagement_id,agent,run_id) on delete restrict,
 foreign key(tenant_id,dispatch_id) references public.public_source_dispatch_claims(tenant_id,dispatch_id) on delete restrict,
 foreign key(tenant_id,binding_id,engagement_id) references public.public_source_bindings(tenant_id,id,engagement_id) on delete restrict,
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
 foreign key(tenant_id,run_id,agent) references public.agent_runs(tenant_id,id,agent) on delete restrict,
 foreign key(tenant_id,completion_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
 foreign key(tenant_id,settlement_receipt) references public.audit_ledger(tenant_id,id) on delete restrict
);
alter table public.public_source_dispatches add constraint public_source_dispatch_observation_fk
 foreign key(tenant_id,binding_id,source_observation_id) references public.public_source_observations(tenant_id,binding_id,id) on delete restrict;
create trigger public_source_dispatch_immutable before update or delete on public.public_source_dispatches for each row execute function public.evidence_receipt_immutable();
create trigger public_source_observation_immutable before update or delete on public.public_source_observations for each row execute function public.evidence_receipt_immutable();
alter table public.public_source_dispatches enable row level security;
alter table public.public_source_observations enable row level security;
revoke all on public.public_source_dispatches,public.public_source_observations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant select on public.public_source_dispatches,public.public_source_observations to service_role;
create policy bff_read on public.public_source_dispatches for select to service_role using(true);
create policy bff_read on public.public_source_observations for select to service_role using(true);

-- Lock current human authority before current context, then immutable source.
-- NULL historical estate remains NULL; an explicitly assigned current estate
-- is still revalidated without rewriting the captured source snapshot.
create function public.public_source_context_authorized(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_operator boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role public.user_role;v_internal boolean;e public.engagements;
begin
 if p_tenant_id is null or p_actor_id is null or p_engagement_id is null or p_operator is null then return jsonb_build_object('error','invalid_record');end if;
 select role into v_role from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into v_internal from public.users where id=p_actor_id for share;
 if v_role is null or v_role='agent' or v_internal is null
 or (p_operator and v_role not in ('owner','admin','founder','axiom_analyst'))
 or (v_role in ('founder','axiom_analyst') and v_internal is distinct from true)
 then return jsonb_build_object('error','forbidden');end if;
 select * into e from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id and status<>'cancelled' for share;
 if e.id is null then return jsonb_build_object('error','context_refused');end if;
 if e.estate_id is not null then
  perform 1 from public.estates where tenant_id=p_tenant_id and id=e.estate_id for share;
  if not found then return jsonb_build_object('error','context_refused');end if;
 end if;
 return '{}'::jsonb;
end $$;
revoke all on function public.public_source_context_authorized(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- Private storage-only builder; no raw HTML, URLs, hints or caller facts.
create function public.public_source_agent_input(p_tenant_id uuid,p_engagement_id uuid,p_binding_id uuid,p_agent text,p_observation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.public_source_bindings;o public.public_source_observations;binding jsonb;
begin
 if p_tenant_id is null or p_engagement_id is null or p_binding_id is null or p_agent is null or p_agent not in ('drishti','vibhaag')
 or (p_agent='drishti' and p_observation_id is not null) or (p_agent='vibhaag' and p_observation_id is null)
 then return jsonb_build_object('error','invalid_record');end if;
 select * into b from public.public_source_bindings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and id=p_binding_id for share;
 if not found then return jsonb_build_object('error','source_refused');end if;
 binding:=jsonb_build_object('tenant_id',b.tenant_id,'engagement_id',b.engagement_id,'check_id',b.check_id,'root_content_sha256',b.root_content_sha256,'projection_sha256',b.projection_sha256,'projection_version',b.projection_version);
 if p_agent='drishti' then
  return jsonb_build_object('input',jsonb_build_object('mode','public_website','tenant_id',p_tenant_id,'engagement_id',p_engagement_id,
   'source',jsonb_build_object('version',1,'binding',binding,'pages',b.projection->'pages')),'binding_id',p_binding_id);
 end if;
 select * into o from public.public_source_observations where tenant_id=p_tenant_id and engagement_id=p_engagement_id and binding_id=p_binding_id and id=p_observation_id and agent='drishti' for share;
 if not found then return jsonb_build_object('error','observation_refused');end if;
 return jsonb_build_object('input',jsonb_build_object('mode','public_website','tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'source_binding',binding,'observation',o.output->'observation'),'binding_id',p_binding_id,'observation_id',o.id);
end $$;
revoke all on function public.public_source_agent_input(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.get_public_source_agent_input(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_agent text,p_observation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;
begin
 authority:=public.public_source_context_authorized(p_tenant_id,p_actor_id,p_engagement_id,true);
 if authority?'error' then return authority;end if;
 return public.public_source_agent_input(p_tenant_id,p_engagement_id,p_binding_id,p_agent,p_observation_id);
end $$;
revoke all on function public.get_public_source_agent_input(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.get_public_source_agent_input(uuid,uuid,uuid,uuid,text,uuid) to human_action_writer;

-- Verify the actual generic request receipt as well as its running row.
create function public.public_source_running_request(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_agent text,p_run_id uuid,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.agent_runs;q public.audit_ledger;
begin
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 if not found or r.agent is distinct from p_agent or r.engagement_id is distinct from p_engagement_id
 or r.status<>'running' or r.completed_at is not null
 or r.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
 or r.metadata->>'requested_by' is distinct from p_actor_id::text or r.input_redacted_hash is distinct from p_request_hash
 or r.metadata->>'request_input_hash' is distinct from p_request_hash
 then return jsonb_build_object('error','run_context_conflict');end if;
 select * into q from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->>'request_receipt';
 if q.id is null or q.actor_type<>'human' or q.actor_id is distinct from p_actor_id::text or q.action_type<>'agent.invocation.requested'
 or q.target_ref is distinct from r.id::text or q.correlation_id is distinct from r.correlation_id or q.input_hash is distinct from p_request_hash
 or q.result<>'pending' or q.detail->>'agent' is distinct from p_agent or q.detail->>'engagement_id' is distinct from p_engagement_id::text
 then return jsonb_build_object('error','request_unconfirmed');end if;
 return jsonb_build_object('request_receipt',q.id::text);
end $$;
revoke all on function public.public_source_running_request(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.record_public_source_dispatch(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_agent text,p_observation_id uuid,p_run_id uuid,p_input jsonb,p_input_utf8 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prepared jsonb;proof jsonb;parsed jsonb;digest text;d public.public_source_dispatches;
begin
 if p_run_id is null or p_input is null or p_input_utf8 is null or octet_length(p_input_utf8) not between 2 and 131072
 then return jsonb_build_object('error','invalid_record');end if;
 begin parsed:=p_input_utf8::jsonb;exception when data_exception then return jsonb_build_object('error','invalid_record');end;
 if parsed is distinct from p_input then return jsonb_build_object('error','input_refused');end if;
 prepared:=public.get_public_source_agent_input(p_tenant_id,p_actor_id,p_engagement_id,p_binding_id,p_agent,p_observation_id);
 if prepared?'error' then return prepared;end if;
 if prepared->'input' is distinct from p_input then return jsonb_build_object('error','input_refused');end if;
 digest:=encode(sha256(convert_to(p_input_utf8,'UTF8')),'hex');
 proof:=public.public_source_running_request(p_tenant_id,p_actor_id,p_engagement_id,p_agent,p_run_id,digest);
 if proof?'error' then return proof;end if;
 select * into d from public.public_source_dispatches where tenant_id=p_tenant_id and run_id=p_run_id;
 if found then
  if d.actor_id is distinct from p_actor_id or d.binding_id is distinct from p_binding_id or d.engagement_id is distinct from p_engagement_id
  or d.agent is distinct from p_agent or d.source_observation_id is distinct from p_observation_id or d.input is distinct from p_input
  or d.input_utf8 is distinct from p_input_utf8 or d.request_hash is distinct from digest
  then return jsonb_build_object('error','dispatch_conflict');end if;
  return jsonb_build_object('dispatch_id',d.id,'created',false,'replayed',true);
 end if;
 insert into public.public_source_dispatches(tenant_id,engagement_id,binding_id,agent,source_observation_id,run_id,actor_id,request_receipt,request_hash,input,input_utf8)
 values(p_tenant_id,p_engagement_id,p_binding_id,p_agent,p_observation_id,p_run_id,p_actor_id,(proof->>'request_receipt')::bigint,digest,p_input,p_input_utf8) returning * into d;
 return jsonb_build_object('dispatch_id',d.id,'created',true,'replayed',false);
end $$;
revoke all on function public.record_public_source_dispatch(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.record_public_source_dispatch(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,text) to human_action_writer;

-- Producer sees only an already linked human request and storage-derived input.
create function public.get_public_source_dispatch_input(p_tenant_id uuid,p_run_id uuid,p_agent text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.public_source_dispatches;prepared jsonb;proof jsonb;v_engagement uuid;v_actor uuid;
begin
 if p_tenant_id is null or p_run_id is null or p_correlation_id is null or p_agent is null or p_agent not in ('drishti','vibhaag') then return jsonb_build_object('error','invalid_record');end if;
 -- Initial unlocked immutable identifiers let all calls preserve lock order.
 select engagement_id,actor_id into v_engagement,v_actor from public.public_source_dispatches where tenant_id=p_tenant_id and run_id=p_run_id and agent=p_agent;
 if not found then return jsonb_build_object('error','dispatch_refused');end if;
 prepared:=public.public_source_context_authorized(p_tenant_id,v_actor,v_engagement,true);
 if prepared?'error' then return prepared;end if;
 select * into d from public.public_source_dispatches where tenant_id=p_tenant_id and run_id=p_run_id and agent=p_agent for share;
 prepared:=public.public_source_agent_input(p_tenant_id,d.engagement_id,d.binding_id,p_agent,d.source_observation_id);
 if prepared?'error' then return prepared;end if;
 if prepared->'input' is distinct from d.input then return jsonb_build_object('error','input_refused');end if;
 proof:=public.public_source_running_request(p_tenant_id,d.actor_id,d.engagement_id,p_agent,p_run_id,d.request_hash);
 if proof?'error' then return proof;end if;
 if (select correlation_id from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id) is distinct from p_correlation_id then return jsonb_build_object('error','run_context_conflict');end if;
 if proof->>'request_receipt' is distinct from d.request_receipt::text then return jsonb_build_object('error','request_unconfirmed');end if;
 return jsonb_build_object('dispatch_id',d.id,'input',prepared->'input','request_hash',d.request_hash);
end $$;
revoke all on function public.get_public_source_dispatch_input(uuid,uuid,text,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.get_public_source_dispatch_input(uuid,uuid,text,uuid) to agent_ledger_writer;

-- Must be called only after runtime independently hashes its normalized input.
-- The locked generic run serializes simultaneous deliveries; the immutable
-- unique claim prevents any later re-execution even when outcome is unknown.
create function public.claim_public_source_dispatch(p_tenant_id uuid,p_run_id uuid,p_agent text,p_correlation_id uuid,p_dispatch_id uuid,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare loaded jsonb;d public.public_source_dispatches;claimed uuid;
begin
 if p_dispatch_id is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then return jsonb_build_object('error','invalid_record');end if;
 loaded:=public.get_public_source_dispatch_input(p_tenant_id,p_run_id,p_agent,p_correlation_id);
 if loaded?'error' then return loaded;end if;
 if loaded->>'dispatch_id' is distinct from p_dispatch_id::text then return jsonb_build_object('error','dispatch_refused');end if;
 if loaded->>'request_hash' is distinct from p_request_hash then return jsonb_build_object('error','input_refused');end if;
 select * into d from public.public_source_dispatches where tenant_id=p_tenant_id and id=(loaded->>'dispatch_id')::uuid;
 insert into public.public_source_dispatch_claims(tenant_id,dispatch_id,run_id,engagement_id,binding_id,agent,actor_id,correlation_id,request_hash,request_receipt)
 values(p_tenant_id,d.id,p_run_id,d.engagement_id,d.binding_id,d.agent,d.actor_id,p_correlation_id,p_request_hash,d.request_receipt)
 on conflict(tenant_id,dispatch_id) do nothing returning dispatch_id into claimed;
 return jsonb_build_object('claimed',claimed is not null,'dispatch_id',d.id);
end $$;
revoke all on function public.claim_public_source_dispatch(uuid,uuid,text,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.claim_public_source_dispatch(uuid,uuid,text,uuid,uuid,text) to agent_ledger_writer;

-- Deterministic structural projection of these two actual public agents. This
-- is an acceptance guard, not an execution or a fake runtime completion.
create function public.public_source_expected_output(p_input jsonb,p_agent text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare page jsonb;form jsonb;control jsonb;pages jsonb:='[]';indicators jsonb:='[]';unexamined jsonb:='[]';unavailable jsonb:='[]';private_facts jsonb:='{"hosting_region":"unknown","backend_personal_data":"unknown","cross_border_processing":"unknown"}';state text;
begin
 if p_agent='drishti' then
  for page in select value from jsonb_array_elements(p_input->'source'->'pages') loop
   state:=case when page->>'status'='unavailable' then 'unavailable' when page?'form_metadata' then 'observed' else 'unexamined' end;
   pages:=pages||jsonb_build_array(page||jsonb_build_object('form_state',state));
  end loop;
  return jsonb_build_object('mode','public_website','observation',jsonb_build_object('version',1,'binding',p_input->'source'->'binding','pages',pages,'private_facts',private_facts,'requires_human_review',true));
 elsif p_agent='vibhaag' then
  for page in select value from jsonb_array_elements(p_input->'observation'->'pages') loop
   if page->>'form_state'='unavailable' then unavailable:=unavailable||jsonb_build_array(page->>'page');
   elsif page->>'form_state'='unexamined' then unexamined:=unexamined||jsonb_build_array(page->>'page');
   else
    for form in select value from jsonb_array_elements(page->'form_metadata'->'forms') loop
     for control in select value from jsonb_array_elements(form->'controls') loop
      if control->>'element'='input' and control->>'inputType' in ('email','tel') then
       indicators:=indicators||jsonb_build_array(jsonb_build_object('page',page->>'page','content_sha256',page->>'content_sha256','form_ordinal',form->'ordinal','control_ordinal',control->'ordinal','input_type',control->>'inputType','indicator','potential_contact_collection','requires_human_review',true));
      end if;
     end loop;
    end loop;
   end if;
  end loop;
  return jsonb_build_object('mode','public_website','source_binding',p_input->'source_binding','indicators',indicators,'private_facts',private_facts,'unexamined_pages',unexamined,'unavailable_pages',unavailable,'scope_limited',true);
 end if;
 return null;
end $$;
revoke all on function public.public_source_expected_output(jsonb,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.record_public_source_observation(p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_output jsonb,p_output_utf8 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.public_source_dispatches;r public.agent_runs;c public.audit_ledger;s public.audit_ledger;o public.public_source_observations;authority jsonb;parsed jsonb;digest text;v_engagement uuid;
begin
 if p_tenant_id is null or p_actor_id is null or p_run_id is null or p_output is null or p_output_utf8 is null or octet_length(p_output_utf8) not between 2 and 131072 then return jsonb_build_object('error','invalid_record');end if;
 begin parsed:=p_output_utf8::jsonb;exception when data_exception then return jsonb_build_object('error','invalid_record');end;
 if parsed is distinct from p_output then return jsonb_build_object('error','output_refused');end if;
 select engagement_id into v_engagement from public.public_source_dispatches where tenant_id=p_tenant_id and run_id=p_run_id;
 if not found then return jsonb_build_object('error','dispatch_refused');end if;
 authority:=public.public_source_context_authorized(p_tenant_id,p_actor_id,v_engagement,true);
 if authority?'error' then return authority;end if;
 select * into d from public.public_source_dispatches where tenant_id=p_tenant_id and run_id=p_run_id for share;
 if d.actor_id is distinct from p_actor_id then return jsonb_build_object('error','run_context_conflict');end if;
 perform 1 from public.public_source_dispatch_claims where tenant_id=p_tenant_id and dispatch_id=d.id and run_id=p_run_id
  and actor_id=p_actor_id and request_hash=d.request_hash and request_receipt=d.request_receipt;
 if not found then return jsonb_build_object('error','dispatch_unclaimed');end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 digest:=encode(sha256(convert_to(p_output_utf8,'UTF8')),'hex');
 if not found or r.agent is distinct from d.agent or r.engagement_id is distinct from d.engagement_id or r.status<>'succeeded' or r.completed_at is null
 or r.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1' or r.metadata->>'requested_by' is distinct from p_actor_id::text
 or r.metadata->>'request_receipt' is distinct from d.request_receipt::text or r.input_redacted_hash is distinct from d.request_hash
 or r.metadata->>'runtime_outcome' is distinct from 'receipt_confirmed'
 or r.metadata->>'runtime_normalized_input_hash' is distinct from d.request_hash
 or r.output_redacted_hash is distinct from digest or r.metadata->>'runtime_output_hash' is distinct from digest
 or r.metadata->>'response_output_hash' is distinct from digest or r.metadata->'settlement'->>'response_hash' is distinct from digest
 then return jsonb_build_object('error','completion_unconfirmed');end if;
 select * into c from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->'settlement'->>'completed_receipt';
 select * into s from public.audit_ledger where tenant_id=p_tenant_id and id::text=r.metadata->>'settlement_receipt';
 if c.id is null or s.id is null or c.actor_type<>'agent' or c.actor_id is distinct from d.agent
 or c.action_type::text is distinct from (case d.agent when 'drishti' then 'discovery.started' else 'classification.started' end)
 or c.result<>'success' or c.target_ref is distinct from d.engagement_id::text or c.correlation_id is distinct from r.correlation_id
 or c.input_hash is distinct from d.request_hash or c.output_hash is distinct from digest or c.detail->>'phase' is distinct from 'completed'
 or c.detail->>'run_id' is distinct from p_run_id::text or c.detail->>'request_hash' is distinct from d.request_hash
 or s.action_type<>'agent.invocation.settled' or s.actor_type<>'system' or s.actor_id<>'bff-generic-agent-controller'
 or s.target_ref is distinct from p_run_id::text or s.correlation_id is distinct from r.correlation_id or s.result<>'success'
 or s.input_hash is distinct from d.request_hash or s.output_hash is distinct from digest
 or s.detail->>'requested_by' is distinct from p_actor_id::text or s.detail->>'agent' is distinct from d.agent
 or s.detail->>'runtime_outcome' is distinct from 'receipt_confirmed' or s.detail->>'completed_receipt' is distinct from c.id::text
 or s.sequence_no<=c.sequence_no
 then return jsonb_build_object('error','completion_unconfirmed');end if;
 if p_output is distinct from public.public_source_expected_output(d.input,d.agent) then return jsonb_build_object('error','output_refused');end if;
 select * into o from public.public_source_observations where tenant_id=p_tenant_id and run_id=p_run_id;
 if found then
  if o.actor_id is distinct from p_actor_id or o.dispatch_id is distinct from d.id or o.output is distinct from p_output or o.output_utf8 is distinct from p_output_utf8 or o.output_sha256 is distinct from digest
  then return jsonb_build_object('error','observation_conflict');end if;
  return jsonb_build_object('observation_id',o.id,'dispatch_id',o.dispatch_id,'created',false,'replayed',true,'output_sha256',o.output_sha256,'completion_receipt',o.completion_receipt::text);
 end if;
 insert into public.public_source_observations(tenant_id,engagement_id,binding_id,agent,dispatch_id,run_id,actor_id,output,output_utf8,output_sha256,completion_receipt,settlement_receipt)
 values(p_tenant_id,d.engagement_id,d.binding_id,d.agent,d.id,p_run_id,p_actor_id,p_output,p_output_utf8,digest,c.id,s.id) returning * into o;
 return jsonb_build_object('observation_id',o.id,'dispatch_id',o.dispatch_id,'created',true,'replayed',false,'output_sha256',o.output_sha256,'completion_receipt',o.completion_receipt::text);
end $$;
revoke all on function public.record_public_source_observation(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.record_public_source_observation(uuid,uuid,uuid,jsonb,text) to human_action_writer;

create function public.get_public_source_observation(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_observation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;o public.public_source_observations;
begin
 if p_observation_id is null then return jsonb_build_object('error','invalid_record');end if;
 authority:=public.public_source_context_authorized(p_tenant_id,p_actor_id,p_engagement_id,false);
 if authority?'error' then return authority;end if;
 select * into o from public.public_source_observations where tenant_id=p_tenant_id and engagement_id=p_engagement_id and id=p_observation_id for share;
 if not found then return jsonb_build_object('error','observation_refused');end if;
 return jsonb_build_object('observation_id',o.id,'dispatch_id',o.dispatch_id,'binding_id',o.binding_id,'agent',o.agent,'run_id',o.run_id,'output',o.output,'output_sha256',o.output_sha256,'completion_receipt',o.completion_receipt::text);
end $$;
revoke all on function public.get_public_source_observation(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.get_public_source_observation(uuid,uuid,uuid,uuid) to human_action_writer,service_role;
