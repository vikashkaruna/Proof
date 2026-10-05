-- Human judgments about retained public HTML structure. No classification,
-- assessment closure, private fact, execution approval or source overwrite.
alter table public.public_source_observations add constraint public_source_review_observation_context
  unique(tenant_id,id,engagement_id,binding_id,agent,dispatch_id,run_id);

create table public.public_source_reviews (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  engagement_id uuid not null, binding_id uuid not null, observation_id uuid not null,
  agent text not null check(agent in ('drishti','vibhaag')), dispatch_id uuid not null, run_id uuid not null,
  source_observation_id uuid, source_observation_sha256 text, estate_id uuid,
  check_id uuid not null, projection_version integer not null check(projection_version=1),
  root_content_sha256 text not null check(root_content_sha256 ~ '^[a-f0-9]{64}$'),
  projection_sha256 text not null check(projection_sha256 ~ '^[a-f0-9]{64}$'),
  output_sha256 text not null check(output_sha256 ~ '^[a-f0-9]{64}$'),
  source_request_sha256 text not null check(source_request_sha256 ~ '^[a-f0-9]{64}$'),
  source_creation_receipt bigint not null, completion_receipt bigint not null, settlement_receipt bigint not null,
  target_kind text not null check(target_kind in ('whole_observation','vibhaag_indicator')),
  page text, form_ordinal integer, control_ordinal integer, content_sha256 text, source_indicator jsonb,
  target_key text not null, decision text not null check(decision in ('acknowledged','disputed')),
  justification text not null check(length(justification) between 1 and 2000 and justification ~ '[^[:space:]]'),
  reviewed_by uuid not null references public.users(id) on delete restrict,
  operation_key uuid not null, previous_review_id uuid, review_receipt bigint not null,
  request_body jsonb not null, request_body_sha256 text not null
    check(request_body_sha256=encode(sha256(convert_to(request_body::text,'UTF8')),'hex')),
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,id), unique(tenant_id,id,observation_id,target_key),
  unique(tenant_id,operation_key), unique(tenant_id,previous_review_id),
  foreign key(tenant_id,observation_id,engagement_id,binding_id,agent,dispatch_id,run_id)
    references public.public_source_observations(tenant_id,id,engagement_id,binding_id,agent,dispatch_id,run_id) on delete restrict,
  foreign key(tenant_id,binding_id,source_observation_id) references public.public_source_observations(tenant_id,binding_id,id) on delete restrict,
  foreign key(tenant_id,engagement_id,estate_id) references public.engagements(tenant_id,id,estate_id) on delete restrict,
  foreign key(tenant_id,check_id) references public.public_website_checks(tenant_id,id) on delete restrict,
  foreign key(tenant_id,previous_review_id,observation_id,target_key)
    references public.public_source_reviews(tenant_id,id,observation_id,target_key) on delete restrict,
  foreign key(tenant_id,source_creation_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
  foreign key(tenant_id,completion_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
  foreign key(tenant_id,settlement_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
  foreign key(tenant_id,review_receipt) references public.audit_ledger(tenant_id,id) on delete restrict,
  check((agent='drishti' and source_observation_id is null and source_observation_sha256 is null)
    or (agent='vibhaag' and source_observation_id is not null and source_observation_sha256 is not null and source_observation_sha256 ~ '^[a-f0-9]{64}$')),
  check((target_kind='whole_observation' and page is null and form_ordinal is null and control_ordinal is null
      and content_sha256 is null and source_indicator is null and target_key='whole_observation')
    or (target_kind='vibhaag_indicator' and agent='vibhaag' and page is not null and form_ordinal is not null and control_ordinal is not null and content_sha256 is not null and page in ('root','privacy','contact','terms')
      and form_ordinal between 1 and 3 and control_ordinal between 1 and 524288
      and content_sha256 ~ '^[a-f0-9]{64}$' and source_indicator is not null
      and target_key=page||'/'||form_ordinal::text||'/'||control_ordinal::text))
);
create unique index public_source_review_first_target on public.public_source_reviews(tenant_id,observation_id,target_key)
  where previous_review_id is null;
create index public_source_reviews_history on public.public_source_reviews(tenant_id,engagement_id,binding_id,observation_id,created_at desc,id desc);
create trigger public_source_review_immutable before update or delete on public.public_source_reviews
  for each row execute function public.evidence_receipt_immutable();
alter table public.public_source_reviews enable row level security;
revoke all on public.public_source_reviews from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- ASSESSMENT_RUN permits a reviewer to judge another actor's retained work.
-- Lock order: current membership, user flag, engagement, current estate;
-- then immutable binding and observation. No original-invoker authority reuse.
create function public.public_source_review_context(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_write boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.user_role;i boolean;e public.engagements;
begin
  if p_tenant_id is null or p_actor_id is null or p_engagement_id is null or p_write is null
    then return jsonb_build_object('error','invalid_record');end if;
  select role into r from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
  select is_axiom_internal into i from public.users where id=p_actor_id for share;
  if r is null or i is null or r not in ('founder','axiom_analyst','owner','admin','approver','reviewer','viewer','partner')
    or (p_write and r not in ('founder','axiom_analyst','owner','admin','reviewer'))
    or (r in ('founder','axiom_analyst') and i is distinct from true)
    then return jsonb_build_object('error','forbidden');end if;
  select * into e from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id and status<>'cancelled' for share;
  if not found then return jsonb_build_object('error','context_refused');end if;
  if e.estate_id is not null then
    perform 1 from public.estates where tenant_id=p_tenant_id and id=e.estate_id for share;
    if not found then return jsonb_build_object('error','context_refused');end if;
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.public_source_review_context(uuid,uuid,uuid,boolean)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- Stored canonical output UTF8 commitment stays distinct from JSONB projection
-- codec version1. All receipt/source identities are derived from closed storage.
create function public.public_source_review_source(p_tenant_id uuid,p_engagement_id uuid,p_binding_id uuid,p_observation_id uuid,p_lock boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.public_source_bindings;o public.public_source_observations;d public.public_source_dispatches;
  original public.public_source_observations;r public.agent_runs;c public.audit_ledger;s public.audit_ledger;prepared jsonb;
begin
  if p_binding_id is null or p_observation_id is null or p_lock is null then return jsonb_build_object('error','invalid_record');end if;
  select * into b from public.public_source_bindings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and id=p_binding_id for share;
  if not found then return jsonb_build_object('error','source_refused');end if;
  if b.estate_id is not null and not exists(select 1 from public.engagements
    where tenant_id=p_tenant_id and id=p_engagement_id and estate_id=b.estate_id)
    then return jsonb_build_object('error','context_refused');end if;
  if p_lock then
    select * into o from public.public_source_observations where tenant_id=p_tenant_id and engagement_id=p_engagement_id
      and binding_id=p_binding_id and id=p_observation_id for update;
  else
    select * into o from public.public_source_observations where tenant_id=p_tenant_id and engagement_id=p_engagement_id
      and binding_id=p_binding_id and id=p_observation_id for share;
  end if;
  if not found then return jsonb_build_object('error','observation_refused');end if;
  select * into d from public.public_source_dispatches where tenant_id=p_tenant_id and id=o.dispatch_id;
  select * into r from public.agent_runs where tenant_id=p_tenant_id and id=o.run_id;
  select * into c from public.audit_ledger where tenant_id=p_tenant_id and id=o.completion_receipt;
  select * into s from public.audit_ledger where tenant_id=p_tenant_id and id=o.settlement_receipt;
  prepared:=public.public_source_agent_input(p_tenant_id,p_engagement_id,p_binding_id,o.agent,d.source_observation_id);
  if d.id is null or prepared?'error' or d.input is distinct from prepared->'input'
    or d.request_hash is distinct from encode(sha256(convert_to(d.input_utf8,'UTF8')),'hex')
    or d.input is distinct from d.input_utf8::jsonb
    or o.output_sha256 is distinct from encode(sha256(convert_to(o.output_utf8,'UTF8')),'hex')
    or o.output is distinct from o.output_utf8::jsonb or o.output is distinct from public.public_source_expected_output(d.input,o.agent)
    or b.projection_sha256 is distinct from encode(sha256(convert_to(b.projection::text,'UTF8')),'hex')
    or r.id is null or r.status<>'succeeded' or r.completed_at is null
    or r.output_redacted_hash is distinct from o.output_sha256 or r.input_redacted_hash is distinct from d.request_hash
    or c.id is null or c.actor_type<>'agent' or c.actor_id is distinct from o.agent
    or c.action_type::text is distinct from (case o.agent when 'drishti' then 'discovery.started' else 'classification.started' end)
    or c.result<>'success' or c.target_ref is distinct from p_engagement_id::text or c.correlation_id is distinct from r.correlation_id
    or c.input_hash is distinct from d.request_hash or c.output_hash is distinct from o.output_sha256
    or c.detail->>'phase' is distinct from 'completed' or c.detail->>'run_id' is distinct from r.id::text
    or s.id is null or s.actor_type<>'system' or s.actor_id<>'bff-generic-agent-controller'
    or s.action_type<>'agent.invocation.settled' or s.target_ref is distinct from r.id::text
    or s.correlation_id is distinct from r.correlation_id or s.result<>'success'
    or s.input_hash is distinct from d.request_hash or s.output_hash is distinct from o.output_sha256
    or s.detail->>'completed_receipt' is distinct from c.id::text or s.sequence_no<=c.sequence_no
    then return jsonb_build_object('error','observation_refused');end if;
  if o.agent='vibhaag' then
    select * into original from public.public_source_observations where tenant_id=p_tenant_id and engagement_id=p_engagement_id
      and binding_id=p_binding_id and id=d.source_observation_id and agent='drishti' for share;
    if not found or original.output_sha256 is distinct from encode(sha256(convert_to(original.output_utf8,'UTF8')),'hex')
      then return jsonb_build_object('error','observation_refused');end if;
  end if;
  return jsonb_build_object('tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'binding_id',p_binding_id,
    'observation_id',o.id,'agent',o.agent,'dispatch_id',d.id,'run_id',r.id,'source_observation_id',d.source_observation_id,
    'source_observation_sha256',original.output_sha256,'estate_id',b.estate_id,'check_id',b.check_id,'projection_version',b.projection_version,
    'root_content_sha256',b.root_content_sha256,'projection_sha256',b.projection_sha256,'output_sha256',o.output_sha256,
    'source_request_sha256',d.request_hash,'source_creation_receipt',b.creation_receipt::text,
    'completion_receipt',o.completion_receipt::text,'settlement_receipt',o.settlement_receipt::text,'output',o.output);
end $$;
revoke all on function public.public_source_review_source(uuid,uuid,uuid,uuid,boolean)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.public_source_review_metadata(r public.public_source_reviews)
returns jsonb language sql stable set search_path='' as $$
  select (to_jsonb(r)-'id'-'request_body'-'request_body_sha256'-'target_key')||jsonb_build_object(
    'review_id',r.id,'is_current',not exists(select 1 from public.public_source_reviews child
      where child.tenant_id=r.tenant_id and child.observation_id=r.observation_id
        and child.target_key=r.target_key and child.previous_review_id=r.id),
    'created_at',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'source_creation_receipt',r.source_creation_receipt::text,
    'completion_receipt',r.completion_receipt::text,'settlement_receipt',r.settlement_receipt::text,'review_receipt',r.review_receipt::text)
$$;
revoke all on function public.public_source_review_metadata(public.public_source_reviews)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.submit_public_source_review(
  p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_observation_id uuid,
  p_expected_output_sha256 text,p_expected_projection_sha256 text,p_target_kind text,p_page text,
  p_form_ordinal integer,p_control_ordinal integer,p_expected_content_sha256 text,
  p_decision text,p_justification text,p_expected_previous_review_id uuid,p_operation_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;source jsonb;body jsonb;body_hash text;v_target_key text;indicator jsonb;indicator_count integer;
  old public.public_source_reviews;head_id uuid;rid uuid:=gen_random_uuid();receipt bigint;review public.public_source_reviews;context jsonb;
begin
  if p_binding_id is null or p_observation_id is null or p_operation_key is null
    or p_expected_output_sha256 is null or p_expected_output_sha256 !~ '^[a-f0-9]{64}$'
    or p_expected_projection_sha256 is null or p_expected_projection_sha256 !~ '^[a-f0-9]{64}$'
    or p_target_kind is null or p_target_kind not in ('whole_observation','vibhaag_indicator')
    or p_decision is null or p_decision not in ('acknowledged','disputed')
    or p_justification is null or length(p_justification) not between 1 and 2000 or p_justification !~ '[^[:space:]]'
    or (p_target_kind='whole_observation' and (p_page is not null or p_form_ordinal is not null or p_control_ordinal is not null or p_expected_content_sha256 is not null))
    or (p_target_kind='vibhaag_indicator' and (p_page is null or p_page not in ('root','privacy','contact','terms')
      or p_form_ordinal is null or p_form_ordinal not between 1 and 3 or p_control_ordinal is null or p_control_ordinal not between 1 and 524288
      or p_expected_content_sha256 is null or p_expected_content_sha256 !~ '^[a-f0-9]{64}$'))
    then return jsonb_build_object('error','invalid_record');end if;
  authority:=public.public_source_review_context(p_tenant_id,p_actor_id,p_engagement_id,true);
  if authority?'error' then return authority;end if;
  -- Fixed namespace and fixture-independent UUIDs; hash collisions only serialize.
  -- Lock current authority BEFORE operation replay, then the source. All targets
  -- on one observation serialize, preventing forked/stale correction histories.
  perform pg_advisory_xact_lock(hashtextextended('public_source_review:'||p_tenant_id::text||':'||p_operation_key::text,0));
  source:=public.public_source_review_source(p_tenant_id,p_engagement_id,p_binding_id,p_observation_id,true);
  if source?'error' then return source;end if;
  if source->>'output_sha256' is distinct from p_expected_output_sha256
    or source->>'projection_sha256' is distinct from p_expected_projection_sha256
    then return jsonb_build_object('error','digest_mismatch');end if;
  v_target_key:='whole_observation';
  if p_target_kind='vibhaag_indicator' then
    if source->>'agent'<>'vibhaag' then return jsonb_build_object('error','target_refused');end if;
    select count(*) into indicator_count from jsonb_array_elements(source->'output'->'indicators') item
      where item->>'page'=p_page and (item->>'form_ordinal')::integer=p_form_ordinal
        and (item->>'control_ordinal')::integer=p_control_ordinal and item->>'content_sha256'=p_expected_content_sha256;
    if indicator_count<>1 then return jsonb_build_object('error','target_refused');end if;
    select item into indicator from jsonb_array_elements(source->'output'->'indicators') item
      where item->>'page'=p_page and (item->>'form_ordinal')::integer=p_form_ordinal
        and (item->>'control_ordinal')::integer=p_control_ordinal and item->>'content_sha256'=p_expected_content_sha256;
    v_target_key:=p_page||'/'||p_form_ordinal::text||'/'||p_control_ordinal::text;
  end if;
  body:=jsonb_build_object('engagement_id',p_engagement_id,'binding_id',p_binding_id,'observation_id',p_observation_id,
    'expected_output_sha256',p_expected_output_sha256,'expected_projection_sha256',p_expected_projection_sha256,
    'target_kind',p_target_kind,'page',p_page,'form_ordinal',p_form_ordinal,'control_ordinal',p_control_ordinal,
    'expected_content_sha256',p_expected_content_sha256,'decision',p_decision,'justification',p_justification,
    'previous_review_id',p_expected_previous_review_id);
  body_hash:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
  context:=jsonb_build_object('tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'binding_id',p_binding_id,'observation_id',p_observation_id);
  select * into old from public.public_source_reviews where tenant_id=p_tenant_id and operation_key=p_operation_key;
  if found then
    if old.reviewed_by is distinct from p_actor_id or old.request_body is distinct from body
      then return jsonb_build_object('error','idempotency_conflict');end if;
    return context||jsonb_build_object('data',public.public_source_review_metadata(old),'created',false,'replayed',true);
  end if;
  select r.id into head_id from public.public_source_reviews r where r.tenant_id=p_tenant_id
    and r.observation_id=p_observation_id and r.target_key=v_target_key and not exists(select 1 from public.public_source_reviews next
      where next.tenant_id=r.tenant_id and next.previous_review_id=r.id);
  if head_id is distinct from p_expected_previous_review_id then return jsonb_build_object('error','stale_review');end if;
  receipt:=public.append_ledger(p_tenant_id,p_operation_key,'human',p_actor_id::text,null,null,null,'classification.reviewed',rid::text,
    p_expected_output_sha256,body_hash,null,null,null,null,'success',
    (source-'output')||jsonb_build_object('scope','retained_public_structure','target_kind',p_target_kind,'source_indicator',indicator,
      'decision',p_decision,'previous_review_id',p_expected_previous_review_id,'request_body_sha256',body_hash));
  insert into public.public_source_reviews(id,tenant_id,engagement_id,binding_id,observation_id,agent,dispatch_id,run_id,
    source_observation_id,source_observation_sha256,estate_id,check_id,projection_version,root_content_sha256,projection_sha256,output_sha256,
    source_request_sha256,source_creation_receipt,completion_receipt,settlement_receipt,target_kind,page,form_ordinal,control_ordinal,
    content_sha256,source_indicator,target_key,decision,justification,reviewed_by,operation_key,previous_review_id,review_receipt,request_body,request_body_sha256)
  values(rid,p_tenant_id,p_engagement_id,p_binding_id,p_observation_id,source->>'agent',(source->>'dispatch_id')::uuid,(source->>'run_id')::uuid,
    (source->>'source_observation_id')::uuid,source->>'source_observation_sha256',(source->>'estate_id')::uuid,(source->>'check_id')::uuid,
    (source->>'projection_version')::integer,source->>'root_content_sha256',source->>'projection_sha256',source->>'output_sha256',
    source->>'source_request_sha256',(source->>'source_creation_receipt')::bigint,(source->>'completion_receipt')::bigint,(source->>'settlement_receipt')::bigint,
    p_target_kind,p_page,p_form_ordinal,p_control_ordinal,p_expected_content_sha256,indicator,v_target_key,p_decision,p_justification,
    p_actor_id,p_operation_key,p_expected_previous_review_id,receipt,body,body_hash) returning * into review;
  return context||jsonb_build_object('data',public.public_source_review_metadata(review),'created',true,'replayed',false);
end $$;
revoke all on function public.submit_public_source_review(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,text,text,text,uuid,uuid)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.submit_public_source_review(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,text,text,text,uuid,uuid) to human_action_writer;

create function public.list_public_source_reviews(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_observation_id uuid,
  p_limit integer,p_cursor_created_at timestamptz,p_cursor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;source jsonb;r public.public_source_reviews;items jsonb:='[]';n integer:=0;more boolean:=false;cursor jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50 or (p_cursor_created_at is null)<>(p_cursor_id is null)
    then return jsonb_build_object('error','invalid_record');end if;
  authority:=public.public_source_review_context(p_tenant_id,p_actor_id,p_engagement_id,false);
  if authority?'error' then return authority;end if;
  source:=public.public_source_review_source(p_tenant_id,p_engagement_id,p_binding_id,p_observation_id,false);
  if source?'error' then return source;end if;
  for r in select * from public.public_source_reviews where tenant_id=p_tenant_id and engagement_id=p_engagement_id
    and binding_id=p_binding_id and observation_id=p_observation_id
    and (p_cursor_id is null or (created_at,id)<(p_cursor_created_at,p_cursor_id))
    order by created_at desc,id desc limit p_limit+1 loop
    n:=n+1;if n>p_limit then more:=true;exit;end if;
    items:=items||jsonb_build_array(public.public_source_review_metadata(r));
    cursor:=jsonb_build_object('created_at',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',r.id);
  end loop;
  return jsonb_build_object('tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'binding_id',p_binding_id,'observation_id',p_observation_id,
    'data',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor else null end);
end $$;
revoke all on function public.list_public_source_reviews(uuid,uuid,uuid,uuid,uuid,integer,timestamptz,uuid)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.list_public_source_reviews(uuid,uuid,uuid,uuid,uuid,integer,timestamptz,uuid) to human_action_writer;

create function public.reconcile_public_source_review(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_binding_id uuid,p_observation_id uuid,p_operation_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;source jsonb;r public.public_source_reviews;context jsonb;
begin
  if p_operation_key is null then return jsonb_build_object('error','invalid_record');end if;
  authority:=public.public_source_review_context(p_tenant_id,p_actor_id,p_engagement_id,false);
  if authority?'error' then return authority;end if;
  source:=public.public_source_review_source(p_tenant_id,p_engagement_id,p_binding_id,p_observation_id,false);
  if source?'error' then return source;end if;
  context:=jsonb_build_object('tenant_id',p_tenant_id,'actor_id',p_actor_id,'engagement_id',p_engagement_id,'binding_id',p_binding_id,
    'observation_id',p_observation_id,'operation_key',p_operation_key);
  select * into r from public.public_source_reviews where tenant_id=p_tenant_id and engagement_id=p_engagement_id
    and binding_id=p_binding_id and observation_id=p_observation_id and operation_key=p_operation_key and reviewed_by=p_actor_id;
  if not found then return context||jsonb_build_object('outcome',jsonb_build_object('state','not_found'));end if;
  return context||jsonb_build_object('outcome',jsonb_build_object('state','retained','review',public.public_source_review_metadata(r)));
end $$;
revoke all on function public.reconcile_public_source_review(uuid,uuid,uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.reconcile_public_source_review(uuid,uuid,uuid,uuid,uuid,uuid) to human_action_writer;
