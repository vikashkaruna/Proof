-- W8.3 technical register: freeze only recorded plan/action/detail facts.
-- This is not an attestation that execution, vault evidence, or closure succeeded.
alter type public.ledger_action_type add value if not exists 'report.technical.requested';
alter type public.ledger_action_type add value if not exists 'report.technical.drafted';

create table public.technical_report_requests (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 plan_id uuid not null,operation_key uuid not null,
 requested_by uuid not null references public.users(id) on delete restrict,
 title text not null check(length(btrim(title)) between 1 and 300),
 report_id uuid,status text not null default 'requested'
  check(status in ('requested','drafted','released')),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,operation_key),unique(tenant_id,report_id),
 foreign key(tenant_id,plan_id) references public.remediation_plans(tenant_id,id) on delete restrict,
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict
);
create table public.technical_request_sources (
 request_id uuid primary key references public.technical_report_requests(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 source_text text not null check(octet_length(source_text) between 1 and 4194304),
 source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
 captured_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,request_id),
 foreign key(tenant_id,request_id) references public.technical_report_requests(tenant_id,id) on delete restrict,
 check(source_sha256=encode(sha256(convert_to(source_text,'UTF8')),'hex'))
);
alter table public.technical_report_requests enable row level security;
alter table public.technical_request_sources enable row level security;
revoke all on public.technical_report_requests,public.technical_request_sources from public,anon,authenticated,service_role;
grant select on public.technical_report_requests,public.technical_request_sources to service_role;
create policy technical_request_service_read on public.technical_report_requests for select to service_role using(true);
create policy technical_source_service_read on public.technical_request_sources for select to service_role using(true);
create trigger technical_source_immutable before update or delete on public.technical_request_sources
 for each row execute function public.evidence_receipt_immutable();

create function public.request_technical_report(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,
 p_plan_id uuid,p_title text,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare p public.remediation_plans;a public.remediation_actions;d public.dry_runs;
 t public.approval_tokens;b public.execution_batches;rb public.rollback_executions;
 v public.verification_results;rec public.plan_reconciliations;
 req public.technical_report_requests;v_request_id uuid:=gen_random_uuid();actions jsonb:='[]'::jsonb;source_text text;
 action_count integer;v_time timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
  and role in ('owner','admin')) and not public.report_founder_allowed(p_tenant_id,p_actor_id)
  then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_plan_id is null or p_correlation_id is null or p_title is null
  or length(btrim(p_title)) not between 1 and 300 then return jsonb_build_object('error','invalid_request'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 select * into req from public.technical_report_requests where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then
  if req.requested_by is distinct from p_actor_id or req.plan_id is distinct from p_plan_id
   or req.title is distinct from btrim(p_title) then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('requestId',req.id,'reportId',req.report_id,'status',req.status,'replayed',true);
 end if;
 -- The stronger plan lock blocks concurrent child inserts through their FK lock.
 select * into p from public.remediation_plans where tenant_id=p_tenant_id and id=p_plan_id for update;
 if not found then return jsonb_build_object('error','plan_not_found'); end if;
 if length(btrim(p.title)) not between 1 and 1000 or length(p.library_version)>200
  or p.version<1 then return jsonb_build_object('error','plan_content_unsupported'); end if;
 select count(*) into action_count from public.remediation_actions where tenant_id=p_tenant_id and plan_id=p.id;
 if action_count not between 1 and 100 then return jsonb_build_object('error','action_count_unsupported'); end if;
 for a in select * from public.remediation_actions
  where tenant_id=p_tenant_id and plan_id=p.id order by sequence,id for share loop
  if a.sequence<1 or length(btrim(a.description)) not between 1 and 8192
   then return jsonb_build_object('error','action_content_unsupported'); end if;
  d:=null;t:=null;b:=null;rb:=null;v:=null;rec:=null;
  if a.latest_dry_run_id is not null then
   select * into d from public.dry_runs where tenant_id=p_tenant_id and id=a.latest_dry_run_id
    and action_id=a.id and plan_id=p.id for share;
   if d.id is null or d.parameters_hash is distinct from
      encode(sha256(convert_to(a.parameters::text,'UTF8')),'hex')
    or d.rollback_definition_hash is distinct from
      encode(sha256(convert_to(a.rollback_definition::text,'UTF8')),'hex')
    then return jsonb_build_object('error','dry_run_source_mismatch'); end if;
  end if;
  if a.approval_token_id is not null then
   select * into t from public.approval_tokens where tenant_id=p_tenant_id
    and id=a.approval_token_id and plan_id=p.id for share;
   if t.id is null or not(a.id=any(t.action_ids)) or t.approver_id is distinct from a.approved_by
    then return jsonb_build_object('error','approval_source_mismatch'); end if;
  end if;
  if a.execution_batch_id is not null then
   select * into b from public.execution_batches where tenant_id=p_tenant_id
    and id=a.execution_batch_id and plan_id=p.id for share;
   if b.id is null or t.id is null or b.approval_token_id is distinct from t.id
    then return jsonb_build_object('error','execution_source_mismatch'); end if;
   select * into rec from public.plan_reconciliations where tenant_id=p_tenant_id
    and plan_id=p.id and batch_id=b.id for share;
  elsif a.final_outcome is not null or a.executed_at is not null then
   return jsonb_build_object('error','execution_source_mismatch');
  end if;
  if a.latest_rollback_execution_id is not null then
   select * into rb from public.rollback_executions where tenant_id=p_tenant_id
    and id=a.latest_rollback_execution_id and action_id=a.id and batch_id=b.id for share;
   if rb.id is null or rb.definition_hash is distinct from
     encode(sha256(convert_to(a.rollback_definition::text,'UTF8')),'hex')
    then return jsonb_build_object('error','rollback_source_mismatch'); end if;
  end if;
  if a.latest_verification_result_id is not null then
   select * into v from public.verification_results where tenant_id=p_tenant_id
    and id=a.latest_verification_result_id and action_id=a.id and batch_id=b.id for share;
   if v.id is null then return jsonb_build_object('error','verification_source_mismatch'); end if;
  end if;
  if a.rollback_validated and a.rollback_validated_at is null
   then return jsonb_build_object('error','rollback_source_mismatch'); end if;
  actions:=actions||jsonb_build_array(jsonb_build_object(
   'id',a.id,'sequence',a.sequence,'action_type',a.action_type,'description',a.description,
   'risk_class',a.risk_class,'risk_score',a.risk_score,
   'parameters_sha256',encode(sha256(convert_to(a.parameters::text,'UTF8')),'hex'),
   'rollback_definition_sha256',encode(sha256(convert_to(a.rollback_definition::text,'UTF8')),'hex'),
   'rollback_validation_recorded',a.rollback_validated,
   'rollback_validated_at',a.rollback_validated_at,
   'approval_status_recorded',a.approval_status,
   'approval',case when t.id is null then null else jsonb_build_object(
    'id',t.id,'status',t.status,'approver_id',t.approver_id,'issued_at',t.issued_at,
    'expires_at',t.expires_at,'consumed_at',t.consumed_at) end,
   'dry_run',case when d.id is null then null else jsonb_build_object(
    'id',d.id,'status',d.status,'renderable',d.renderable,'created_at',d.created_at,
    'expires_at',d.expires_at,'diff_sha256',case when d.diff is null then null else
      encode(sha256(convert_to(d.diff::text,'UTF8')),'hex') end) end,
   'execution',case when b.id is null then null else jsonb_build_object(
    'batch_id',b.id,'batch_status',b.status,'content_digest',b.content_digest,
    'started_at',b.started_at,'finished_at',b.finished_at,
    'action_status',a.execution_status,'final_outcome',a.final_outcome,
    'executed_at',a.executed_at,'executed_by_agent',a.executed_by_agent,
    'pre_state_ref_recorded',a.pre_state_uri is not null,
    'post_state_ref_recorded',a.post_state_uri is not null) end,
   'rollback_execution',case when rb.id is null then null else jsonb_build_object(
    'id',rb.id,'status',rb.status,'definition_hash',rb.definition_hash,
    'triggered_by',rb.triggered_by,'finished_at',rb.finished_at) end,
   'verification',case when v.id is null then null else jsonb_build_object(
    'id',v.id,'outcome',v.outcome,'verified_at',v.verified_at,
    'evidence_ref_recorded',v.evidence_uri is not null) end,
   'reconciliation',case when rec.id is null then null else jsonb_build_object(
    'id',rec.id,'created_at',rec.created_at,
    'unexecuted_count',jsonb_array_length(rec.unexecuted),
    'parameter_diff_count',jsonb_array_length(rec.parameter_diffs)) end
  ));
 end loop;
 source_text:=jsonb_build_object(
  'schema_version',1,'serialization','postgres-jsonb-text-v1','kind','technical_plan_source',
  'request_id',v_request_id,'tenant_id',p_tenant_id,'captured_at',v_time,
  'plan',jsonb_build_object('id',p.id,'engagement_id',p.engagement_id,
   'library_version',p.library_version,'title',p.title,'status',p.status,
   'version',p.version,'created_at',p.created_at,'updated_at',p.updated_at),
  'actions',actions,
  'limitations',jsonb_build_array(
   'This is a frozen register of recorded plan and action state, not independent execution verification.',
   'A recorded rollback validation flag is not a rollback execution; only linked rollback executions are shown.',
   'References to pre/post state or verification evidence are not Object Lock or closure attestations.')
 )::text;
 if octet_length(source_text)>4194304 then raise exception 'technical source too large'; end if;
 insert into public.technical_report_requests(id,tenant_id,plan_id,operation_key,requested_by,title)
 values(v_request_id,p_tenant_id,p_plan_id,p_operation_key,p_actor_id,btrim(p_title)) returning * into req;
 insert into public.technical_request_sources(request_id,tenant_id,source_text,source_sha256)
 values(req.id,p_tenant_id,source_text,encode(sha256(convert_to(source_text,'UTF8')),'hex'));
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.technical.requested'::public.ledger_action_type,req.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('plan_id',p_plan_id,'action_count',action_count,
   'source_sha256',encode(sha256(convert_to(source_text,'UTF8')),'hex')));
 return jsonb_build_object('requestId',req.id,'reportId',null,'status','requested','replayed',false);
end $$;
revoke all on function public.request_technical_report(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.request_technical_report(uuid,uuid,uuid,uuid,text,uuid) to service_role;

create function public.record_technical_report_draft(p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,
 p_content_text text,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.technical_report_requests;src public.technical_request_sources;content jsonb;
 r public.reports;v_hash text;source_plan jsonb;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_request_id is null or p_correlation_id is null or p_content_text is null
  or octet_length(p_content_text) not between 1 and 65536 then return jsonb_build_object('error','invalid_request'); end if;
 begin content:=p_content_text::jsonb; exception when others then return jsonb_build_object('error','invalid_request'); end;
 select * into req from public.technical_report_requests where tenant_id=p_tenant_id and id=p_request_id for update;
 if not found then return jsonb_build_object('error','request_not_found'); end if;
 select * into src from public.technical_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 if src.request_id is null then return jsonb_build_object('error','source_not_found'); end if;
 source_plan:=src.source_text::jsonb->'plan';
 if source_plan->>'id' is distinct from req.plan_id::text then
  return jsonb_build_object('error','source_binding_mismatch'); end if;
 if jsonb_typeof(content) is distinct from 'object'
  or not(content ?& array['schema_version','kind','source_kind','request_id','tenant_id','plan_id','source_sha256','title','generated_by'])
  or content-array['schema_version','kind','source_kind','request_id','tenant_id','plan_id','source_sha256','title','generated_by']<>'{}'::jsonb
  or content->'schema_version' is distinct from '2'::jsonb
  or content->>'kind' is distinct from 'technical_recorded_register'
  or content->>'source_kind' is distinct from 'recorded_remediation_plan'
  or content->>'request_id' is distinct from req.id::text
  or content->>'tenant_id' is distinct from p_tenant_id::text
  or content->>'plan_id' is distinct from req.plan_id::text
  or content->>'source_sha256' is distinct from src.source_sha256
  or jsonb_typeof(content->'title') is distinct from 'string'
  or content->>'title' is distinct from req.title
  or content->>'generated_by' is distinct from 'technical-report-builder'
  then return jsonb_build_object('error','source_binding_mismatch'); end if;
 v_hash:=encode(sha256(convert_to(p_content_text,'UTF8')),'hex');
 if req.report_id is not null then
  select * into r from public.reports where tenant_id=p_tenant_id and id=req.report_id;
  if found and r.content_sha256=v_hash then
   return jsonb_build_object('requestId',req.id,'reportId',r.id,'status',r.status,'contentHash',v_hash,'replayed',true);
  end if;
  return jsonb_build_object('error','idempotency_conflict');
 end if;
 insert into public.reports(tenant_id,engagement_id,kind,title,storage_uri,content,library_version,
  generated_by_agent,operation_key,created_by,content_text,content_sha256)
 values(p_tenant_id,(source_plan->>'engagement_id')::uuid,'technical',req.title,null,content,
  source_plan->>'library_version',
  'technical-report-builder',req.operation_key,p_actor_id,p_content_text,v_hash) returning * into r;
 update public.technical_report_requests set report_id=r.id,status='drafted',updated_at=clock_timestamp() where id=req.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.technical.drafted'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('request_id',req.id,'source_sha256',src.source_sha256,'content_sha256',v_hash));
 return jsonb_build_object('requestId',req.id,'reportId',r.id,'status','draft','contentHash',v_hash,'replayed',false);
end $$;
revoke all on function public.record_technical_report_draft(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_technical_report_draft(uuid,uuid,uuid,text,uuid) to service_role;
