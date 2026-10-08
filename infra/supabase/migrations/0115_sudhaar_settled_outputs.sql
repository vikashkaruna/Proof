-- Capture only newly authenticated, validated Sudhaar success in the SAME
-- transaction as controller settlement. This is telemetry, never a saved plan.
create table public.sudhaar_settled_outputs (
 run_id uuid primary key references public.agent_runs(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 engagement_id uuid not null,
 operation_key uuid not null,
 input_text text not null check(octet_length(input_text) between 1 and 524288),
 output_text text not null check(octet_length(output_text) between 1 and 1048576),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 output_hash text not null check(output_hash ~ '^[a-f0-9]{64}$'),
 requested_receipt bigint not null references public.audit_ledger(id) on delete restrict,
 started_receipt bigint not null references public.audit_ledger(id) on delete restrict,
 completed_receipt bigint not null references public.audit_ledger(id) on delete restrict,
 settled_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,operation_key),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict
);
alter table public.sudhaar_settled_outputs enable row level security;
revoke all on public.sudhaar_settled_outputs from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create trigger sudhaar_settled_output_immutable before update or delete on public.sudhaar_settled_outputs
 for each row execute function public.evidence_receipt_immutable();

-- Private verifier earns source locks BEFORE engagement and generic run locks.
-- Worker order is task -> assessment run -> packet -> engagement.
create function controller_security.sudhaar_output_source_valid(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_input_text text)
returns boolean language plpgsql security definer set search_path='' as $$
declare i jsonb; p public.workload_assessment_packets; f jsonb; c jsonb; scored jsonb; declared jsonb;
 row_f public.findings; expected_counts jsonb; n integer;
begin
 if p_input_text is null or octet_length(p_input_text) not between 1 and 524288 then return false; end if;
 i:=p_input_text::jsonb;
 if jsonb_typeof(i) is distinct from 'object' or not(i ?& array['tenant_id','engagement_id','title','source','findings'])
  or (select count(*) from jsonb_object_keys(i))<>5
  or i->>'tenant_id' is distinct from p_tenant_id::text or i->>'engagement_id' is distinct from p_engagement_id::text
  or jsonb_typeof(i->'findings') is distinct from 'array' or jsonb_typeof(i->'title') is distinct from 'string'
  or coalesce(length(i->>'title'),0) not between 1 and 300
  or jsonb_array_length(i->'findings') not between 1 and 500
 then return false; end if;
 lock table public.kill_switch_state in share mode;
 perform 1 from public.kill_switch_state where scope='global' or tenant_id=p_tenant_id for share;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'sudhaar')
  or not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then return false; end if;
 if not public.board_assessment_source_valid(p_tenant_id,(i#>>'{source,assessmentRunId}')::uuid,p_engagement_id)
 then return false; end if;
 select * into p from public.workload_assessment_packets where tenant_id=p_tenant_id
  and run_id=(i#>>'{source,assessmentRunId}')::uuid and engagement_id=p_engagement_id;
 perform 1 from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id
  and library_version=p.library_version and status<>'cancelled' for share;
 if not found or i->'source' is distinct from jsonb_build_object('assessmentRunId',p.run_id,
  'libraryVersion',p.library_version,'libraryDigest',p.library_digest,'resultDigest',p.result_digest,
  'finalizedReceipt',p.finalized_receipt::text)
 then return false; end if;
 perform 1 from public.control_libraries where version=p.library_version and status in ('published','deprecated')
  and control_count=jsonb_array_length(p.controls) for share;
 if not found then return false; end if;
 perform 1 from public.findings where tenant_id=p_tenant_id and engagement_id=p_engagement_id
  and library_version=p.library_version order by id for share;
 n:=jsonb_array_length(i->'findings');
 if n<>jsonb_array_length(p.controls) or n<>jsonb_array_length(p.result->'findings')
  or n<>(select count(*) from public.findings where tenant_id=p_tenant_id and engagement_id=p_engagement_id and library_version=p.library_version)
  or n<>(select count(distinct value->>'finding_id') from jsonb_array_elements(i->'findings'))
  or n<>(select count(distinct value->>'control_id') from jsonb_array_elements(i->'findings'))
 then return false; end if;
 for f in select value from jsonb_array_elements(i->'findings') loop
  if not(f ?& array['finding_id','control_id','title','severity','score_decimal','risk_points_decimal','answer_state','applicability_state','answer_counts'])
   or (select count(*) from jsonb_object_keys(f))<>9 then return false; end if;
  select * into row_f from public.findings where id=(f->>'finding_id')::uuid and tenant_id=p_tenant_id
   and engagement_id=p_engagement_id and library_version=p.library_version and control_id=f->>'control_id';
  if not found then return false; end if;
  select value into c from jsonb_array_elements(p.controls) where value->>'id'=row_f.control_id;
  select value into scored from jsonb_array_elements(p.result->'findings') where value->>'control_id'=row_f.control_id;
  select value into declared from jsonb_array_elements(coalesce(p.result#>'{questionnaire_provenance,controls}','[]'))
   where value->>'control_id'=row_f.control_id;
  expected_counts:=case when declared is null then 'null'::jsonb else jsonb_build_object(
   'known',declared->'known_boolean_question_count','affirmed',declared->'caller_affirmed_count',
   'denied',declared->'caller_denied_count','unknown',declared->'unknown_count') end;
  if c is null or scored is null or f->>'title' is distinct from c->>'title' or f->>'severity' is distinct from c->>'severity'
   or (f->>'score_decimal')::numeric is distinct from row_f.score or (f->>'risk_points_decimal')::numeric is distinct from row_f.risk_points
   or row_f.score is distinct from (scored->>'score')::numeric or row_f.risk_points is distinct from (scored->>'risk_points')::numeric
   or row_f.rationale is distinct from scored->>'rationale'
   or f->>'answer_state' is distinct from coalesce(declared->>'answer_state','unavailable')
   or f->>'applicability_state' is distinct from coalesce(declared->>'applicability_state','unavailable')
   or f->'answer_counts' is distinct from expected_counts
  then return false; end if;
 end loop;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function controller_security.sudhaar_output_source_valid(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create function public.settle_sudhaar_output(
 p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_engagement_id uuid,p_correlation_id uuid,
 p_request_hash text,p_input_text text,p_output_text text,p_response_hash text,
 p_latency_ms integer,p_input_tokens integer,p_output_tokens integer,p_cost_usd numeric,
 p_started_receipt text,p_completed_receipt text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r public.agent_runs; saved public.sudhaar_settled_outputs; o jsonb; i jsonb; t jsonb; f jsonb; reason text; settled jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human planning writer required' using errcode='42501'; end if;
 if p_tenant_id is null or p_actor_id is null or p_run_id is null or p_engagement_id is null or p_correlation_id is null
  or p_output_text is null or octet_length(p_output_text) not between 1 and 1048576
  or p_request_hash is distinct from encode(pg_catalog.sha256(convert_to(p_input_text,'UTF8')),'hex')
  or p_response_hash is distinct from encode(pg_catalog.sha256(convert_to(p_output_text,'UTF8')),'hex')
  or not controller_security.sudhaar_output_source_valid(p_tenant_id,p_actor_id,p_engagement_id,p_input_text)
 then return jsonb_build_object('error','output_context_refused'); end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 if not found or r.agent<>'sudhaar' or r.engagement_id is distinct from p_engagement_id or r.correlation_id is distinct from p_correlation_id
  or r.metadata->>'requested_by' is distinct from p_actor_id::text or r.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
  or r.input_redacted_hash is distinct from p_request_hash
 then return jsonb_build_object('error','output_context_refused'); end if;
 select * into saved from public.sudhaar_settled_outputs where run_id=p_run_id;
 if found then
  if r.status='succeeded' and r.completed_at is not null
   and r.output_redacted_hash=p_response_hash and r.metadata->>'runtime_output_hash'=p_response_hash
   and r.metadata->>'response_output_hash'=p_response_hash
   and saved.tenant_id=p_tenant_id and saved.actor_id=p_actor_id and saved.engagement_id=p_engagement_id and saved.operation_key=p_correlation_id
   and saved.input_text=p_input_text and saved.output_text=p_output_text and saved.input_hash=p_request_hash and saved.output_hash=p_response_hash
   and saved.started_receipt::text=p_started_receipt and saved.completed_receipt::text=p_completed_receipt
   and r.metadata->'settlement'=jsonb_build_object('status','succeeded','error',null,'latency_ms',p_latency_ms,
    'input_tokens',p_input_tokens,'output_tokens',p_output_tokens,'cost_usd',p_cost_usd,'started_receipt',p_started_receipt,
    'completed_receipt',p_completed_receipt,'response_hash',p_response_hash)
  then return jsonb_build_object('run_id',p_run_id,'status','succeeded','replayed',true); end if;
  return jsonb_build_object('error','output_context_refused');
 end if;
 -- Legacy terminal runs must never be backfilled from caller output.
 if r.status<>'running' or r.completed_at is not null then return jsonb_build_object('error','output_unrecoverable'); end if;
 i:=p_input_text::jsonb; o:=p_output_text::jsonb;
 if jsonb_typeof(o) is distinct from 'object'
  or not(o ?& array['schema_version','kind','title','source','persistence','review_required','escalate','execution_allowed','review_tasks','provisional_actions','aggregate_records_affected','aggregate_systems'])
  or (select count(*) from jsonb_object_keys(o))<>12
  or o->'source' is distinct from i->'source' or o->>'title' is distinct from i->>'title'
  or o->'schema_version' is distinct from '1'::jsonb or o->>'kind' is distinct from 'remediation_proposal'
  or o->>'persistence' is distinct from 'not_saved' or o->'review_required' is distinct from 'true'::jsonb
  or o->'escalate' is distinct from 'true'::jsonb or o->'execution_allowed' is distinct from 'false'::jsonb
  or o->'provisional_actions' is distinct from '[]'::jsonb or o->'aggregate_systems' is distinct from '[]'::jsonb
  or o->'aggregate_records_affected' is distinct from 'null'::jsonb or jsonb_typeof(o->'review_tasks') is distinct from 'array'
 then return jsonb_build_object('error','output_context_refused'); end if;
 if jsonb_array_length(o->'review_tasks')<>jsonb_array_length(i->'findings')
  or jsonb_array_length(o->'review_tasks')<>(select count(distinct value->>'finding_id') from jsonb_array_elements(o->'review_tasks'))
  or jsonb_array_length(o->'review_tasks')<>(select count(distinct value->>'sequence') from jsonb_array_elements(o->'review_tasks'))
 then return jsonb_build_object('error','output_context_refused'); end if;
 for f in select value from jsonb_array_elements(i->'findings') loop
  select value into t from jsonb_array_elements(o->'review_tasks') where value->>'finding_id'=f->>'finding_id';
  reason:=case when f->>'answer_state'='unavailable' then 'provenance_unavailable'
   when f->>'applicability_state'<>'unconditional' then 'applicability_unverified'
   when f->>'answer_state' in ('unknown','partially_answered') then 'questionnaire_incomplete'
   when f->>'answer_state'='not_boolean_assessable' then 'evidence_required' else 'declarations_unverified' end;
  if t is null or not(t ?& array['sequence','finding_id','control_id','title','reason','instruction'])
   or (select count(*) from jsonb_object_keys(t))<>6
   or jsonb_typeof(t->'sequence') is distinct from 'number'
   or t->>'control_id' is distinct from f->>'control_id' or t->>'title' is distinct from f->>'title'
   or t->>'reason' is distinct from reason or (t->>'sequence')::integer not between 1 and jsonb_array_length(i->'findings')
   or t->>'instruction' is distinct from 'Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal.'
  then return jsonb_build_object('error','output_context_refused'); end if;
 end loop;
 -- Existing receipt verifier checks original human request and ordered actual
 -- runtime receipts. Failure rolls back both settlement and capture.
 settled:=public.record_generic_agent_run_finish(p_tenant_id,p_actor_id,p_run_id,'sudhaar',p_engagement_id,p_correlation_id,
  p_request_hash,'succeeded',null,p_latency_ms,p_input_tokens,p_output_tokens,p_cost_usd,p_started_receipt,p_completed_receipt,p_response_hash);
 if settled->>'status' is distinct from 'succeeded' then return settled; end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id;
 if r.metadata->>'runtime_output_hash' is distinct from p_response_hash
  or r.metadata->>'runtime_normalized_input_hash' is distinct from p_request_hash
 then raise exception 'Sudhaar wire receipt hashes refused' using errcode='23514'; end if;
 insert into public.sudhaar_settled_outputs(run_id,tenant_id,actor_id,engagement_id,operation_key,input_text,output_text,input_hash,output_hash,
  requested_receipt,started_receipt,completed_receipt,settled_receipt)
 values(p_run_id,p_tenant_id,p_actor_id,p_engagement_id,p_correlation_id,p_input_text,p_output_text,p_request_hash,p_response_hash,
  (r.metadata->>'request_receipt')::bigint,p_started_receipt::bigint,p_completed_receipt::bigint,(r.metadata->>'settlement_receipt')::bigint);
 return settled;
end $$;
revoke all on function public.settle_sudhaar_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.settle_sudhaar_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text) to human_action_writer;

create function public.recover_sudhaar_output(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_operation_key uuid,p_input_text text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare s public.sudhaar_settled_outputs; r public.agent_runs; requested public.audit_ledger; started public.audit_ledger;
 completed public.audit_ledger; settled public.audit_ledger; h text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human planning writer required' using errcode='42501'; end if;
 if not controller_security.sudhaar_output_source_valid(p_tenant_id,p_actor_id,p_engagement_id,p_input_text)
 then return jsonb_build_object('error','output_context_refused'); end if;
 h:=encode(pg_catalog.sha256(convert_to(p_input_text,'UTF8')),'hex');
 select * into r from public.agent_runs where tenant_id=p_tenant_id and agent='sudhaar' and correlation_id=p_operation_key
  and metadata->>'lifecycle_writer'='generic_agent_rpc_v1' for share;
 if not found then return jsonb_build_object('missing',true); end if;
 if r.engagement_id is distinct from p_engagement_id or r.metadata->>'requested_by' is distinct from p_actor_id::text
  or r.input_redacted_hash is distinct from h then return jsonb_build_object('error','output_context_refused'); end if;
 select * into s from public.sudhaar_settled_outputs where run_id=r.id;
 if not found then return jsonb_build_object('error','output_unrecoverable'); end if;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id and id=s.requested_receipt;
 select * into started from public.audit_ledger where tenant_id=p_tenant_id and id=s.started_receipt;
 select * into completed from public.audit_ledger where tenant_id=p_tenant_id and id=s.completed_receipt;
 select * into settled from public.audit_ledger where tenant_id=p_tenant_id and id=s.settled_receipt;
 if s.tenant_id is distinct from p_tenant_id or s.actor_id is distinct from p_actor_id or s.engagement_id is distinct from p_engagement_id
  or s.operation_key is distinct from p_operation_key or s.input_text is distinct from p_input_text or s.input_hash is distinct from h
  or s.output_hash is distinct from encode(pg_catalog.sha256(convert_to(s.output_text,'UTF8')),'hex')
  or r.status<>'succeeded' or r.completed_at is null or r.metadata->>'runtime_outcome' is distinct from 'receipt_confirmed'
  or r.metadata->>'runtime_output_hash' is distinct from s.output_hash
  or r.metadata->>'runtime_normalized_input_hash' is distinct from h
  or r.metadata#>>'{settlement,started_receipt}' is distinct from s.started_receipt::text
  or r.metadata#>>'{settlement,completed_receipt}' is distinct from s.completed_receipt::text
  or r.metadata#>>'{settlement,status}' is distinct from 'succeeded'
  or r.metadata#>>'{settlement,response_hash}' is distinct from s.output_hash
  or r.metadata->>'response_output_hash' is distinct from s.output_hash or r.output_redacted_hash is distinct from s.output_hash
  or r.metadata->>'request_receipt' is distinct from s.requested_receipt::text
  or r.metadata->>'settlement_receipt' is distinct from s.settled_receipt::text
  or requested.id is null or requested.actor_type<>'human' or requested.actor_id<>p_actor_id::text
  or requested.action_type<>'agent.invocation.requested' or requested.result<>'pending' or requested.input_hash is distinct from h
  or requested.detail->>'agent' is distinct from 'sudhaar' or requested.detail->>'engagement_id' is distinct from p_engagement_id::text
  or requested.target_ref is distinct from r.id::text or requested.correlation_id<>p_operation_key
  or started.id is null or completed.id is null or settled.id is null
  or not(requested.sequence_no<started.sequence_no and started.sequence_no<completed.sequence_no and completed.sequence_no<settled.sequence_no)
  or started.actor_type<>'agent' or completed.actor_type<>'agent' or started.actor_id<>'sudhaar' or completed.actor_id<>'sudhaar'
  or started.action_type<>'plan.generated' or completed.action_type<>'plan.generated'
  or started.result<>'pending' or completed.result<>'success'
  or started.input_hash is distinct from h or completed.input_hash is distinct from h or completed.output_hash is distinct from s.output_hash
  or started.correlation_id<>p_operation_key or completed.correlation_id<>p_operation_key
  or started.target_ref is distinct from p_engagement_id::text or completed.target_ref is distinct from p_engagement_id::text
  or started.agent_version is null or started.agent_version is distinct from completed.agent_version
  or started.detail->>'phase' is distinct from 'started' or completed.detail->>'phase' is distinct from 'completed'
  or started.detail->>'run_id' is distinct from r.id::text or completed.detail->>'run_id' is distinct from r.id::text
  or started.detail->>'request_hash' is distinct from h or completed.detail->>'request_hash' is distinct from h
  or completed.detail->>'started_entry' is distinct from s.started_receipt::text
  or settled.actor_type<>'system' or settled.actor_id<>'bff-generic-agent-controller' or settled.action_type<>'agent.invocation.settled'
  or settled.target_ref is distinct from r.id::text or settled.result<>'success' or settled.correlation_id<>p_operation_key
  or settled.input_hash is distinct from h or settled.output_hash is distinct from s.output_hash
  or settled.detail->>'runtime_outcome' is distinct from 'receipt_confirmed'
  or settled.detail->>'requested_by' is distinct from p_actor_id::text or settled.detail->>'agent' is distinct from 'sudhaar'
  or settled.detail->>'started_receipt' is distinct from s.started_receipt::text or settled.detail->>'completed_receipt' is distinct from s.completed_receipt::text
 then return jsonb_build_object('error','output_proof_refused'); end if;
 return jsonb_build_object('run_id',r.id,'input_hash',s.input_hash,'output_hash',s.output_hash,'output_text',s.output_text,
  'requested_receipt',s.requested_receipt::text,'started_receipt',s.started_receipt::text,
  'completed_receipt',s.completed_receipt::text,'settled_receipt',s.settled_receipt::text);
end $$;
revoke all on function public.recover_sudhaar_output(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_sudhaar_output(uuid,uuid,uuid,uuid,text) to human_action_writer;
