-- Retained human declarations -> credentialless review drafts. No legal publication,
-- verified private facts, corrective authority or duplicate measured records.

create function controller_security.reviewed_workflow_source_valid(
 p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_input_text text,p_records_text text
) returns boolean language plpgsql security definer set search_path='' as $$
declare i jsonb; item jsonb; r public.operator_workflow_records; receipt public.audit_ledger;
 context jsonb; n integer;
begin
 if p_tenant_id is null or p_actor_id is null or p_engagement_id is null
  or p_input_text is null or octet_length(p_input_text) not between 1 and 524288
  or p_records_text is null or octet_length(p_records_text) not between 1 and 524288
 then return false; end if;
 i:=p_input_text::jsonb;
 if jsonb_typeof(i) is distinct from 'object'
  or not(i ?& array['schema_version','mode','tenant_id','engagement_id','source_records_sha256','records'])
  or (select count(*) from jsonb_object_keys(i))<>6
  or i->'schema_version' is distinct from '1'::jsonb or i->>'mode' is distinct from 'reviewed_workflow'
  or i->>'tenant_id' is distinct from p_tenant_id::text or i->>'engagement_id' is distinct from p_engagement_id::text
  or i->'records' is distinct from p_records_text::jsonb
  or i->>'source_records_sha256' is distinct from encode(sha256(convert_to(p_records_text,'UTF8')),'hex')
  or jsonb_typeof(i->'records') is distinct from 'array'
 then return false; end if;
 n:=jsonb_array_length(i->'records');
 if n not between 1 and 20
  or n<>(select count(distinct value->>'id') from jsonb_array_elements(i->'records'))
  or n<>(select count(distinct value->>'operation_key') from jsonb_array_elements(i->'records'))
  or n<>(select count(distinct value->>'receipt_id') from jsonb_array_elements(i->'records'))
 then return false; end if;
 -- Earn current authority/context locks before immutable source locks and run.
 lock table public.kill_switch_state in share mode;
 perform 1 from public.kill_switch_state where scope='global' or tenant_id=p_tenant_id for share;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'vibhaag')
  or not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=p_tenant_id))
 then return false; end if;
 context:=public.public_source_review_context(p_tenant_id,p_actor_id,p_engagement_id,false);
 if context?'error' then return false; end if;
 perform 1 from public.operator_workflow_records where tenant_id=p_tenant_id
  and id in(select (value->>'id')::uuid from jsonb_array_elements(i->'records')) order by id for share;
 for item in select value from jsonb_array_elements(i->'records') loop
  select * into r from public.operator_workflow_records where tenant_id=p_tenant_id and id=(item->>'id')::uuid;
  if not found or r.engagement_id is distinct from p_engagement_id or r.kind not in ('ropa','delivery_task')
   or item is distinct from public.operator_workflow_metadata(r)
   or not public.operator_workflow_valid(r.kind,r.payload)
  then return false; end if;
  context:=public.operator_workflow_source(p_tenant_id,r.payload);
  if context?'error' then return false; end if;
  select * into receipt from public.audit_ledger where tenant_id=p_tenant_id and id=r.receipt_id;
  if receipt.id is null or receipt.actor_type<>'human' or receipt.actor_id is distinct from r.created_by::text
   or receipt.action_type::text is distinct from (case r.kind when 'ropa' then 'ropa.recorded' else 'playbook.created' end)
   or receipt.target_ref is distinct from r.id::text or receipt.result<>'success'
   or receipt.detail->>'kind' is distinct from r.kind
   or receipt.detail->>'operation_key' is distinct from r.operation_key::text
   or receipt.detail->'review_required' is distinct from 'true'::jsonb
   or receipt.detail->>'payload_sha256' is distinct from encode(sha256(convert_to(r.payload::text,'UTF8')),'hex')
  then return false; end if;
 end loop;
 return true;
exception when data_exception then return false;
end $$;
revoke all on function controller_security.reviewed_workflow_source_valid(uuid,uuid,uuid,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create function public.read_reviewed_workflow_sources(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_record_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare records jsonb;records_text text;input_text text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human reviewed workflow reader required' using errcode='42501';end if;
 if p_record_ids is null or cardinality(p_record_ids) not between 1 and 20
  or cardinality(p_record_ids)<>(select count(distinct v) from unnest(p_record_ids)v)
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 -- Preserve the explicitly selected order; lock earning remains deterministic
 -- in the shared private source verifier.
 select jsonb_agg(public.operator_workflow_metadata(r) order by chosen.ordinal) into records
 from unnest(p_record_ids) with ordinality chosen(id,ordinal)
 join public.operator_workflow_records r on r.id=chosen.id and r.tenant_id=p_tenant_id;
 if records is null or jsonb_array_length(records)<>cardinality(p_record_ids)
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 records_text:=records::text;
 input_text:=jsonb_build_object('schema_version',1,'mode','reviewed_workflow','tenant_id',p_tenant_id,'engagement_id',p_engagement_id,
  'records',records,'source_records_sha256',encode(sha256(convert_to(records_text,'UTF8')),'hex'))::text;
 if not controller_security.reviewed_workflow_source_valid(p_tenant_id,p_actor_id,p_engagement_id,input_text,records_text)
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 return jsonb_build_object('records',records);
end $$;
revoke all on function public.read_reviewed_workflow_sources(uuid,uuid,uuid,uuid[])
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.read_reviewed_workflow_sources(uuid,uuid,uuid,uuid[]) to human_action_writer;

create table public.reviewed_workflow_dispatches (
 run_id uuid primary key references public.agent_runs(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 engagement_id uuid not null,
 operation_key uuid not null,
 input_text text not null check(octet_length(input_text) between 1 and 524288),
 records_text text not null check(octet_length(records_text) between 1 and 524288),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 source_records_sha256 text not null check(source_records_sha256 ~ '^[a-f0-9]{64}$'),
 requested_receipt bigint not null references public.audit_ledger(id) on delete restrict,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,operation_key),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict
);
create table public.reviewed_workflow_dispatch_claims (
 run_id uuid primary key references public.reviewed_workflow_dispatches(run_id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 claimed_at timestamptz not null default clock_timestamp()
);
alter table public.reviewed_workflow_dispatches enable row level security;
alter table public.reviewed_workflow_dispatch_claims enable row level security;
revoke all on public.reviewed_workflow_dispatches,public.reviewed_workflow_dispatch_claims
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create trigger reviewed_workflow_dispatch_immutable before update or delete on public.reviewed_workflow_dispatches
 for each row execute function public.evidence_receipt_immutable();
create trigger reviewed_workflow_claim_immutable before update or delete on public.reviewed_workflow_dispatch_claims
 for each row execute function public.evidence_receipt_immutable();

create or replace function public.start_reviewed_workflow_dispatch(
 p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_operation_key uuid,p_input_text text,p_records_text text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare started jsonb; d public.reviewed_workflow_dispatches; r public.agent_runs; h text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human reviewed workflow writer required' using errcode='42501';end if;
 if p_operation_key is null or not controller_security.reviewed_workflow_source_valid(p_tenant_id,p_actor_id,p_engagement_id,p_input_text,p_records_text)
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 h:=encode(sha256(convert_to(p_input_text,'UTF8')),'hex');
 started:=public.record_generic_agent_run_start(p_tenant_id,p_actor_id,'vibhaag',p_engagement_id,p_operation_key,h);
 if started?'error' then return started;end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=(started->>'run_id')::uuid for update;
 select * into d from public.reviewed_workflow_dispatches where run_id=r.id;
 if found then
  if d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.engagement_id=p_engagement_id and d.operation_key=p_operation_key
   and d.input_text=p_input_text and d.records_text=p_records_text and d.input_hash=h
   and d.requested_receipt::text=r.metadata->>'request_receipt'
  then return started;end if;
  return jsonb_build_object('error','dispatch_conflict');
 end if;
 -- Never attach reviewed authority to an older generic attempt.
 if started->'created' is distinct from 'true'::jsonb then return jsonb_build_object('error','reviewed_dispatch_unrecoverable');end if;
 insert into public.reviewed_workflow_dispatches(run_id,tenant_id,actor_id,engagement_id,operation_key,input_text,records_text,input_hash,
  source_records_sha256,requested_receipt)
 values(r.id,p_tenant_id,p_actor_id,p_engagement_id,p_operation_key,p_input_text,p_records_text,h,
  encode(sha256(convert_to(p_records_text,'UTF8')),'hex'),(r.metadata->>'request_receipt')::bigint);
 return started;
end $$;

create or replace function controller_security.reviewed_workflow_dispatch_valid(p_tenant_id uuid,p_run_id uuid,p_operation_key uuid,p_write boolean)
 returns boolean language plpgsql security definer set search_path='' as $$
declare d public.reviewed_workflow_dispatches; r public.agent_runs; receipt public.audit_ledger;
begin
 select * into d from public.reviewed_workflow_dispatches where tenant_id=p_tenant_id and run_id=p_run_id and operation_key=p_operation_key;
 if not found or p_write is null or d.input_hash is distinct from encode(sha256(convert_to(d.input_text,'UTF8')),'hex')
  or d.source_records_sha256 is distinct from encode(sha256(convert_to(d.records_text,'UTF8')),'hex')
  or not controller_security.reviewed_workflow_source_valid(d.tenant_id,d.actor_id,d.engagement_id,d.input_text,d.records_text)
 then return false;end if;
 if p_write then
  select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 else
  select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for share;
 end if;
 select * into receipt from public.audit_ledger where tenant_id=p_tenant_id and id=d.requested_receipt;
 if r.id is null or r.agent<>'vibhaag' or r.engagement_id is distinct from d.engagement_id or r.correlation_id is distinct from p_operation_key
  or r.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1' or r.metadata->>'requested_by' is distinct from d.actor_id::text
  or r.metadata->>'request_receipt' is distinct from d.requested_receipt::text or r.input_redacted_hash is distinct from d.input_hash
  or receipt.id is null or receipt.actor_type<>'human' or receipt.actor_id is distinct from d.actor_id::text
  or receipt.action_type<>'agent.invocation.requested' or receipt.result<>'pending'
  or receipt.target_ref is distinct from p_run_id::text or receipt.correlation_id is distinct from p_operation_key
  or receipt.input_hash is distinct from d.input_hash or receipt.detail->>'agent' is distinct from 'vibhaag'
  or receipt.detail->>'engagement_id' is distinct from d.engagement_id::text
 then return false;end if;
 return true;
end $$;

create or replace function public.read_reviewed_workflow_dispatch(p_tenant_id uuid,p_run_id uuid,p_operation_key uuid)
 returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.reviewed_workflow_dispatches;
begin
 if current_setting('role',true) is distinct from 'agent_ledger_writer'
 then raise exception 'reviewed workflow transport reader required' using errcode='42501';end if;
 if not controller_security.reviewed_workflow_dispatch_valid(p_tenant_id,p_run_id,p_operation_key,false)
  or not exists(select 1 from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id and status='running' and completed_at is null)
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 select * into d from public.reviewed_workflow_dispatches where run_id=p_run_id;
 return jsonb_build_object('run_id',p_run_id,'request_hash',d.input_hash,'input_text',d.input_text);
end $$;

create or replace function public.claim_reviewed_workflow_dispatch(p_tenant_id uuid,p_run_id uuid,p_operation_key uuid,p_request_hash text)
 returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r public.agent_runs; d public.reviewed_workflow_dispatches;
begin
 if current_setting('role',true) is distinct from 'agent_ledger_writer'
 then raise exception 'reviewed workflow transport reader required' using errcode='42501';end if;
 if not controller_security.reviewed_workflow_dispatch_valid(p_tenant_id,p_run_id,p_operation_key,true)
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 select * into d from public.reviewed_workflow_dispatches where run_id=p_run_id;
 if r.status<>'running' or r.completed_at is not null or d.input_hash is distinct from p_request_hash
 then return jsonb_build_object('error','reviewed_source_refused');end if;
 insert into public.reviewed_workflow_dispatch_claims(run_id,tenant_id,input_hash) values(p_run_id,p_tenant_id,p_request_hash) on conflict do nothing;
 return jsonb_build_object('run_id',p_run_id,'claimed',found);
end $$;
revoke all on function controller_security.reviewed_workflow_dispatch_valid(uuid,uuid,uuid,boolean),
 public.start_reviewed_workflow_dispatch(uuid,uuid,uuid,uuid,text,text),public.read_reviewed_workflow_dispatch(uuid,uuid,uuid),
 public.claim_reviewed_workflow_dispatch(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.start_reviewed_workflow_dispatch(uuid,uuid,uuid,uuid,text,text) to human_action_writer;
grant execute on function public.read_reviewed_workflow_dispatch(uuid,uuid,uuid),public.claim_reviewed_workflow_dispatch(uuid,uuid,uuid,text) to agent_ledger_writer;

-- Deterministic output consistency only. Authority is separately verified.
create function controller_security.reviewed_workflow_declaration(p_value jsonb)
returns text language plpgsql immutable set search_path='' as $$
begin
 if p_value='null'::jsonb then return 'Unknown — authorised human confirmation required';end if;
 if jsonb_typeof(p_value)='array' then
  if jsonb_array_length(p_value)=0 then return 'Human recorded none (review required)';end if;
  return (select string_agg(value,', ' order by ordinal) from jsonb_array_elements_text(p_value) with ordinality a(value,ordinal));
 end if;
 if jsonb_typeof(p_value)='boolean' then return case p_value when 'true'::jsonb then 'Human recorded yes (review required)' else 'Human recorded no (review required)' end;end if;
 return p_value#>>'{}';
end $$;
create function controller_security.reviewed_workflow_expected_output(p_input_text text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare i jsonb:=p_input_text::jsonb;record jsonb;payload jsonb;ref jsonb; processing jsonb:='[]';policies jsonb:='[]';playbooks jsonb;
 fields text[]:=array['engagementId','sourceNote','system','purpose','legalBasis','retentionMonths','dataCategories','dataPrincipals','processors','recipients','destinationCountries','transferSafeguards','dpiaRequired','region','crossBorder','securityMeasures'];
 labels text[]:=array['engagement','source and reason','system','purpose','legal basis','retention in months','data categories','data principal groups','processors','recipients','destination countries','transfer safeguards','impact assessment required','processing location','cross-border processing','security measures'];
 categories text[]:=array['privacy_notice','consent_notice','retention','dpa_template'];
 titles text[]:=array['Privacy Notice','Consent Notice','Retention Policy','Data Processing Agreement Template'];
 prompts text[]:=array[
  'Confirm organisation identity, contacts, rights routes, notice languages and applicable obligations before publication.',
  'Confirm specific purposes, lawful basis, clear affirmative action, notice language, consent records and withdrawal routes. No consent is proven by this draft.',
  'Confirm retention triggers, deletion methods, legal holds, exceptions, owners and review schedule. No deletion is authorised by this draft.',
  'Verify parties, roles, instructions, subprocessors, security, incidents, audit terms, transfers and signatures with legal counsel. This unsigned draft creates no agreement.'];
 content text;unresolved jsonb;j integer;
begin
 for record in select value from jsonb_array_elements(i->'records') where value->>'kind'='ropa' loop
  payload:=record->'payload';
  ref:=jsonb_build_object('record_id',record->'id','human_receipt_id',record->'receipt_id','created_by',record->'created_by','record_kind','ropa');
  select coalesce(jsonb_agg(field order by ordinal),'[]'::jsonb) into unresolved from unnest(fields) with ordinality a(field,ordinal)
   where field<>'engagementId' and payload->field='null'::jsonb;
  processing:=processing||jsonb_build_array(jsonb_build_object('source',ref,'declarations',payload,'unresolved_fields',unresolved,
   'declaration_status','human_recorded_unverified','review_required',true));
  content:='Human and legal review required. Recorded declarations are not independently verified processing or legal facts.'
   ||E'\n\nHuman source record: '||(record->>'id')||E'\n\nHuman audit receipt: '||(record->>'receipt_id')
   ||E'\n\nOriginal recorded actor: '||(record->>'created_by');
  for j in 1..array_length(fields,1) loop
   content:=content||E'\n\nRecorded '||labels[j]||': '||controller_security.reviewed_workflow_declaration(payload->fields[j]);
  end loop;
  if payload?'source' then
   content:=content||E'\n\nRetained public observation: '||(payload#>>'{source,observationId}')
    ||E'\n\nPublic observation output SHA-256: '||(payload#>>'{source,outputSha256}');
  end if;
  content:=content||E'\n\nPublic HTML provenance does not establish private processing facts, residency, contracts, lawful basis or compliance.'
   ||E'\n\nApproval, publication and execution remain separate human decisions.';
  for j in 1..4 loop
   policies:=policies||jsonb_build_array(jsonb_build_object('source',ref,'source_ropa_id',record->'id','category',categories[j],
    'title',left('Draft '||titles[j]||' — '||(payload->>'system'),300),
    'content','DRAFT '||upper(titles[j])||' — UNPUBLISHED'||E'\n\n'||content||E'\n\n'||prompts[j],
    'review_required',true,'legal_review_required',true,'publication_status','unpublished'));
  end loop;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object(
  'source',jsonb_build_object('record_id',value->'id','human_receipt_id',value->'receipt_id','created_by',value->'created_by','record_kind','delivery_task'),
  'reported_task',value->'payload','reported_total_minutes',(value#>>'{payload,durationMinutes}')::bigint*(value#>>'{payload,repetitions}')::bigint,
  'measurement_status','not_verified','ranking_basis','human_reported_time_only','time_horizon','not_recorded',
  'automation_candidate',false,'review_required',true)
  order by (value#>>'{payload,durationMinutes}')::bigint*(value#>>'{payload,repetitions}')::bigint desc,ordinal),'[]'::jsonb)
 into playbooks from jsonb_array_elements(i->'records') with ordinality a(value,ordinal) where value->>'kind'='delivery_task';
 return jsonb_build_object('schema_version',1,'mode','reviewed_workflow','source_records_sha256',i->'source_records_sha256',
  'processing_reviews',processing,'policy_drafts',policies,'playbook_reviews',playbooks,'persistence','not_saved',
  'review_required',true,'execution_allowed',false,'publication_allowed',false);
end $$;
revoke all on function controller_security.reviewed_workflow_declaration(jsonb),controller_security.reviewed_workflow_expected_output(text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

-- Capture only newly authenticated, validated Sudhaar success in the SAME
-- transaction as controller settlement. This is telemetry, never a saved plan.
create table public.reviewed_workflow_settled_outputs (
 run_id uuid primary key references public.agent_runs(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 engagement_id uuid not null,
 operation_key uuid not null,
 input_text text not null check(octet_length(input_text) between 1 and 524288),
 output_text text not null check(octet_length(output_text) between 1 and 524288),
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
alter table public.reviewed_workflow_settled_outputs enable row level security;
revoke all on public.reviewed_workflow_settled_outputs from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create trigger reviewed_workflow_output_immutable before update or delete on public.reviewed_workflow_settled_outputs
 for each row execute function public.evidence_receipt_immutable();

create function public.settle_reviewed_workflow_output(
 p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_engagement_id uuid,p_correlation_id uuid,
 p_request_hash text,p_input_text text,p_output_text text,p_response_hash text,
 p_latency_ms integer,p_input_tokens integer,p_output_tokens integer,p_cost_usd numeric,
 p_started_receipt text,p_completed_receipt text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r public.agent_runs; saved public.reviewed_workflow_settled_outputs; settled jsonb; d public.reviewed_workflow_dispatches;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human reviewed workflow writer required' using errcode='42501'; end if;
 if p_tenant_id is null or p_actor_id is null or p_run_id is null or p_engagement_id is null or p_correlation_id is null
  or p_output_text is null or octet_length(p_output_text) not between 1 and 524288
  or p_request_hash is distinct from encode(pg_catalog.sha256(convert_to(p_input_text,'UTF8')),'hex')
  or p_response_hash is distinct from encode(pg_catalog.sha256(convert_to(p_output_text,'UTF8')),'hex')

 then return jsonb_build_object('error','output_context_refused'); end if;
 select * into d from public.reviewed_workflow_dispatches where tenant_id=p_tenant_id and run_id=p_run_id;
 if not found or d.actor_id is distinct from p_actor_id or d.engagement_id is distinct from p_engagement_id
  or d.operation_key is distinct from p_correlation_id or d.input_text is distinct from p_input_text
  or not controller_security.reviewed_workflow_dispatch_valid(p_tenant_id,p_run_id,p_correlation_id,true)
  or not exists(select 1 from public.reviewed_workflow_dispatch_claims where run_id=p_run_id and tenant_id=p_tenant_id and input_hash=p_request_hash)
 then return jsonb_build_object('error','output_context_refused');end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 if not found or r.agent<>'vibhaag' or r.engagement_id is distinct from p_engagement_id or r.correlation_id is distinct from p_correlation_id
  or r.metadata->>'requested_by' is distinct from p_actor_id::text or r.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
  or r.input_redacted_hash is distinct from p_request_hash
 then return jsonb_build_object('error','output_context_refused'); end if;
 select * into saved from public.reviewed_workflow_settled_outputs where run_id=p_run_id;
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
 if p_output_text::jsonb is distinct from controller_security.reviewed_workflow_expected_output(p_input_text)
 then return jsonb_build_object('error','output_context_refused');end if;
 -- Existing receipt verifier checks original human request and ordered actual
 -- runtime receipts. Failure rolls back both settlement and capture.
 settled:=public.record_generic_agent_run_finish(p_tenant_id,p_actor_id,p_run_id,'vibhaag',p_engagement_id,p_correlation_id,
  p_request_hash,'succeeded',null,p_latency_ms,p_input_tokens,p_output_tokens,p_cost_usd,p_started_receipt,p_completed_receipt,p_response_hash);
 if settled->>'status' is distinct from 'succeeded' then return settled; end if;
 select * into r from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id;
 if r.metadata->>'runtime_output_hash' is distinct from p_response_hash
  or r.metadata->>'runtime_normalized_input_hash' is distinct from p_request_hash
 then raise exception 'Reviewed workflow wire receipt hashes refused' using errcode='23514'; end if;
 insert into public.reviewed_workflow_settled_outputs(run_id,tenant_id,actor_id,engagement_id,operation_key,input_text,output_text,input_hash,output_hash,
  requested_receipt,started_receipt,completed_receipt,settled_receipt)
 values(p_run_id,p_tenant_id,p_actor_id,p_engagement_id,p_correlation_id,p_input_text,p_output_text,p_request_hash,p_response_hash,
  (r.metadata->>'request_receipt')::bigint,p_started_receipt::bigint,p_completed_receipt::bigint,(r.metadata->>'settlement_receipt')::bigint);
 return settled;
end $$;
revoke all on function public.settle_reviewed_workflow_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.settle_reviewed_workflow_output(uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric,text,text) to human_action_writer;

create function public.recover_reviewed_workflow_output(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_operation_key uuid,p_input_text text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare s public.reviewed_workflow_settled_outputs; r public.agent_runs; requested public.audit_ledger; started public.audit_ledger;
 completed public.audit_ledger; settled public.audit_ledger; h text; d public.reviewed_workflow_dispatches;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human reviewed workflow writer required' using errcode='42501'; end if;
 select * into d from public.reviewed_workflow_dispatches where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if not found then return jsonb_build_object('missing',true);end if;
 if d.actor_id is distinct from p_actor_id or d.engagement_id is distinct from p_engagement_id or d.input_text is distinct from p_input_text
  or not controller_security.reviewed_workflow_dispatch_valid(p_tenant_id,d.run_id,p_operation_key,false)
 then return jsonb_build_object('error','output_context_refused');end if;
 h:=encode(pg_catalog.sha256(convert_to(p_input_text,'UTF8')),'hex');
 select * into r from public.agent_runs where tenant_id=p_tenant_id and agent='vibhaag' and correlation_id=p_operation_key
  and metadata->>'lifecycle_writer'='generic_agent_rpc_v1' for share;
 if not found then return jsonb_build_object('missing',true); end if;
 if r.engagement_id is distinct from p_engagement_id or r.metadata->>'requested_by' is distinct from p_actor_id::text
  or r.input_redacted_hash is distinct from h then return jsonb_build_object('error','output_context_refused'); end if;
 select * into s from public.reviewed_workflow_settled_outputs where run_id=r.id;
 if not found then return jsonb_build_object('error','output_unrecoverable'); end if;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id and id=s.requested_receipt;
 select * into started from public.audit_ledger where tenant_id=p_tenant_id and id=s.started_receipt;
 select * into completed from public.audit_ledger where tenant_id=p_tenant_id and id=s.completed_receipt;
 select * into settled from public.audit_ledger where tenant_id=p_tenant_id and id=s.settled_receipt;
 if s.tenant_id is distinct from p_tenant_id or s.actor_id is distinct from p_actor_id or s.engagement_id is distinct from p_engagement_id
  or s.operation_key is distinct from p_operation_key or s.input_text is distinct from p_input_text or s.input_hash is distinct from h
  or s.output_hash is distinct from encode(pg_catalog.sha256(convert_to(s.output_text,'UTF8')),'hex')
  or s.output_text::jsonb is distinct from controller_security.reviewed_workflow_expected_output(p_input_text)
  or not exists(select 1 from public.reviewed_workflow_dispatch_claims where run_id=r.id and tenant_id=p_tenant_id and input_hash=h)
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
  or requested.detail->>'agent' is distinct from 'vibhaag' or requested.detail->>'engagement_id' is distinct from p_engagement_id::text
  or requested.target_ref is distinct from r.id::text or requested.correlation_id<>p_operation_key
  or started.id is null or completed.id is null or settled.id is null
  or not(requested.sequence_no<started.sequence_no and started.sequence_no<completed.sequence_no and completed.sequence_no<settled.sequence_no)
  or started.actor_type<>'agent' or completed.actor_type<>'agent' or started.actor_id<>'vibhaag' or completed.actor_id<>'vibhaag'
  or started.action_type<>'classification.started' or completed.action_type<>'classification.started'
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
  or settled.detail->>'requested_by' is distinct from p_actor_id::text or settled.detail->>'agent' is distinct from 'vibhaag'
  or settled.detail->>'started_receipt' is distinct from s.started_receipt::text or settled.detail->>'completed_receipt' is distinct from s.completed_receipt::text
 then return jsonb_build_object('error','output_proof_refused'); end if;
 return jsonb_build_object('run_id',r.id,'input_hash',s.input_hash,'output_hash',s.output_hash,'output_text',s.output_text,
  'requested_receipt',s.requested_receipt::text,'started_receipt',s.started_receipt::text,
  'completed_receipt',s.completed_receipt::text,'settled_receipt',s.settled_receipt::text);
end $$;
revoke all on function public.recover_reviewed_workflow_output(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_reviewed_workflow_output(uuid,uuid,uuid,uuid,text) to human_action_writer;

-- Narrow wrappers retain every pre-existing validation and human/agent grant.
-- Private originals are callable only by these owner-controlled definers.
alter function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_human_ledger_before_0118;
revoke all on function controller_security.append_human_ledger_before_0118(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.append_human_ledger(
 p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,
 p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
 p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_detail->>'purpose'='reviewed_workflow_acknowledgement'
 then raise exception 'reviewed workflow acknowledgement requires atomic record' using errcode='42501'; end if;
 return controller_security.append_human_ledger_before_0118(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,
  p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to human_action_writer;

alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0118;
revoke all on function controller_security.append_agent_ledger_before_0118(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.append_agent_ledger(
 p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,
 p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
 p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_detail->>'purpose'='reviewed_workflow_acknowledgement'
 then raise exception 'reviewed workflow acknowledgement refused for generic producer' using errcode='42501'; end if;
 return controller_security.append_agent_ledger_before_0118(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,
  p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;


create table public.reviewed_workflow_acknowledgements (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 run_id uuid not null references public.reviewed_workflow_settled_outputs(run_id) on delete restrict,
 operation_key uuid not null,
 body_text text not null check(octet_length(body_text) between 1 and 8192),
 body_hash text not null check(body_hash ~ '^[a-f0-9]{64}$'),
 output_hash text not null check(output_hash ~ '^[a-f0-9]{64}$'),
 acknowledgement_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 policy_index integer,
 policy_draft_id uuid references public.operator_workflow_records(id) on delete restrict,
 policy_receipt bigint references public.audit_ledger(id) on delete restrict,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,operation_key),
 check((policy_index is null and policy_draft_id is null and policy_receipt is null)
  or (policy_index between 0 and 79 and policy_draft_id is not null and policy_receipt is not null))
);
alter table public.reviewed_workflow_acknowledgements enable row level security;
revoke all on public.reviewed_workflow_acknowledgements
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create trigger reviewed_workflow_ack_immutable before update or delete on public.reviewed_workflow_acknowledgements
 for each row execute function public.evidence_receipt_immutable();

create function public.acknowledge_reviewed_workflow_output(
 p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_original_operation_key uuid,p_input_text text,
 p_operation_key uuid,p_body_text text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare proof jsonb;body jsonb;output jsonb;prior public.reviewed_workflow_acknowledgements; ack public.audit_ledger;
 requested public.audit_ledger; policy public.operator_workflow_records;original public.operator_workflow_records;
 selected jsonb;payload jsonb;result jsonb;receipt bigint;v_id uuid:=gen_random_uuid();index integer;h text;manifest jsonb;current_status text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human reviewed workflow writer required' using errcode='42501';end if;
 if p_operation_key is null or p_body_text is null or octet_length(p_body_text) not between 1 and 8192
 then return jsonb_build_object('error','invalid_acknowledgement');end if;
 body:=p_body_text::jsonb;
 if jsonb_typeof(body) is distinct from 'object'
  or not(body ?& array['runId','outputHash','policyIndex','reason','confirmReview'])
  or (select count(*) from jsonb_object_keys(body))<>5
  or body->'confirmReview' is distinct from 'true'::jsonb
  or jsonb_typeof(body->'reason') is distinct from 'string' or length(body->>'reason') not between 1 and 2000
  or btrim(body->>'reason') is distinct from body->>'reason'
  or body->'policyIndex'<>'null'::jsonb and (jsonb_typeof(body->'policyIndex')<>'number' or body->>'policyIndex'!~ '^[0-9]+$')
 then return jsonb_build_object('error','invalid_acknowledgement');end if;
 -- Current source/authority is earned before run, immutable output and own
 -- operation locks. No cancelled or historical capability is reused.
 proof:=public.recover_reviewed_workflow_output(p_tenant_id,p_actor_id,p_engagement_id,p_original_operation_key,p_input_text);
 if proof?'error' or proof?'missing' then return jsonb_build_object('error','output_proof_refused');end if;
 if body->>'runId' is distinct from proof->>'run_id' or body->>'outputHash' is distinct from proof->>'output_hash'
 then return jsonb_build_object('error','output_proof_refused');end if;
 output:=(proof->>'output_text')::jsonb;
 index:=(body->>'policyIndex')::integer;
 if index is not null and index not between 0 and jsonb_array_length(output->'policy_drafts')-1
 then return jsonb_build_object('error','invalid_acknowledgement');end if;
 if index is not null then
  selected:=output->'policy_drafts'->index;
  select * into original from public.operator_workflow_records where tenant_id=p_tenant_id and id=(selected->>'source_ropa_id')::uuid and kind='ropa';
  if not found then return jsonb_build_object('error','output_proof_refused');end if;
  payload:=jsonb_build_object('engagementId',p_engagement_id,'sourceNote',original.payload->'sourceNote',
   'title',selected->'title','category',selected->'category','content',selected->'content','sourceRopaId',original.id);
  if original.payload?'source' then payload:=payload||jsonb_build_object('source',original.payload->'source');end if;
 end if;
 h:=encode(sha256(convert_to(p_body_text,'UTF8')),'hex');
 manifest:=jsonb_build_object('kind','reviewed_workflow_acknowledgement_recorded','tenantId',p_tenant_id,'actorId',p_actor_id,
  'operationKey',p_operation_key,'originalOperationKey',p_original_operation_key,'runId',proof->>'run_id',
  'inputHash',proof->>'input_hash','outputHash',proof->>'output_hash','sourceDigest',output->'source_records_sha256',
  'bodyHash',h,'policyIndex',index,'requestedReceipt',proof->>'requested_receipt','startedReceipt',proof->>'started_receipt',
  'completedReceipt',proof->>'completed_receipt','settledReceipt',proof->>'settled_receipt');
 perform pg_advisory_xact_lock(hashtextextended('reviewed-workflow-ack/'||p_tenant_id::text||'/'||p_operation_key::text,118));
 select * into prior from public.reviewed_workflow_acknowledgements where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if found then
  select * into ack from public.audit_ledger where tenant_id=p_tenant_id and id=prior.acknowledgement_receipt;
  if prior.actor_id is distinct from p_actor_id or prior.run_id::text is distinct from proof->>'run_id'
   or prior.body_text is distinct from p_body_text or prior.body_hash is distinct from h
   or prior.output_hash is distinct from proof->>'output_hash' or prior.policy_index is distinct from index
   or ack.id is null or ack.actor_type<>'human' or ack.actor_id is distinct from p_actor_id::text
   or ack.action_type<>'classification.reviewed' or ack.result<>'success' or ack.target_ref is distinct from prior.id::text
   or ack.correlation_id is distinct from p_operation_key or ack.input_hash is distinct from h
   or ack.output_hash is distinct from prior.output_hash
   or ack.sequence_no<=(select sequence_no from public.audit_ledger where tenant_id=p_tenant_id and id=(proof->>'settled_receipt')::bigint)
   or ack.detail is distinct from jsonb_build_object('purpose','reviewed_workflow_acknowledgement','run_id',prior.run_id,
    'source_records_sha256',output->'source_records_sha256','output_hash',prior.output_hash,
    'requested_receipt',proof->>'requested_receipt','started_receipt',proof->>'started_receipt',
    'completed_receipt',proof->>'completed_receipt','settled_receipt',proof->>'settled_receipt',
    'reason',body->>'reason','policy_index',index,'policy_draft_id',prior.policy_draft_id,
    'policy_receipt',prior.policy_receipt::text,'publication_allowed',false,'execution_allowed',false)
  then return jsonb_build_object('error','acknowledgement_conflict');end if;
  if index is not null then
   select * into policy from public.operator_workflow_records where tenant_id=p_tenant_id and id=prior.policy_draft_id;
   if not found or policy.kind<>'policy_draft' or policy.created_by is distinct from p_actor_id
    or policy.operation_key is distinct from p_operation_key or policy.receipt_id is distinct from prior.policy_receipt
    or policy.payload is distinct from payload
    or not exists(select 1 from public.audit_ledger l where l.tenant_id=p_tenant_id and l.id=prior.policy_receipt
      and l.actor_type='human' and l.actor_id=p_actor_id::text and l.action_type='policy.drafted' and l.result='success'
      and l.target_ref=policy.id::text and l.correlation_id=p_operation_key and l.output_hash is null and l.input_hash is null
      and l.detail=jsonb_build_object('title',payload->>'title','category',payload->>'category','content_hash',policy.content_sha256))
   then return jsonb_build_object('error','policy_state_changed');end if;
   select status into current_status from public.policy_drafts where tenant_id=p_tenant_id and id=policy.policy_draft_id
    and created_by=p_actor_id and title=payload->>'title' and category=payload->>'category'
    and content=payload->>'content' and content_sha256=policy.content_sha256 for share;
   if not found then return jsonb_build_object('error','policy_state_changed');end if;
  end if;
  manifest:=manifest||jsonb_build_object('initialPolicyStatus',case when index is null then null else 'draft' end,
   'currentPolicyStatus',current_status);
  return jsonb_build_object('acknowledgement_id',prior.id,'receipt_id',prior.acknowledgement_receipt::text,
   'policy_draft_id',prior.policy_draft_id,'replayed',true,'manifest',manifest||jsonb_build_object(
    'acknowledgementId',prior.id,'receiptId',prior.acknowledgement_receipt::text,'policyDraftId',prior.policy_draft_id,'policyReceipt',prior.policy_receipt::text));
 end if;
 if index is not null then
  -- A pre-existing human operation cannot acquire retrospective agent origin.
  if exists(select 1 from public.operator_workflow_records where tenant_id=p_tenant_id and operation_key=p_operation_key)
  then return jsonb_build_object('error','acknowledgement_conflict');end if;
  result:=public.record_operator_workflow(p_tenant_id,p_actor_id,p_operation_key,'policy_draft',payload,p_operation_key);
  if result?'error' then return result;end if;
  if result->'replayed' is distinct from 'false'::jsonb then raise exception 'prior policy cannot acquire agent provenance' using errcode='23514';end if;
  select * into policy from public.operator_workflow_records where tenant_id=p_tenant_id and id=(result#>>'{data,id}')::uuid;
  select status into current_status from public.policy_drafts where tenant_id=p_tenant_id and id=policy.policy_draft_id for share;
  if current_status is distinct from 'draft' then raise exception 'initial policy adoption must be draft' using errcode='23514';end if;
 end if;
 manifest:=manifest||jsonb_build_object('initialPolicyStatus',case when index is null then null else 'draft' end,
  'currentPolicyStatus',current_status);
 receipt:=public.append_ledger(p_tenant_id,p_operation_key,'human',p_actor_id::text,null,null,null,'classification.reviewed',v_id::text,
  h,proof->>'output_hash',null,null,null,null,'success',
  jsonb_build_object('purpose','reviewed_workflow_acknowledgement','run_id',(proof->>'run_id')::uuid,
   'source_records_sha256',output->'source_records_sha256','output_hash',proof->>'output_hash',
   'requested_receipt',proof->>'requested_receipt','started_receipt',proof->>'started_receipt',
   'completed_receipt',proof->>'completed_receipt','settled_receipt',proof->>'settled_receipt',
   'reason',body->>'reason','policy_index',index,'policy_draft_id',policy.id,'policy_receipt',policy.receipt_id::text,
   'publication_allowed',false,'execution_allowed',false));
 insert into public.reviewed_workflow_acknowledgements(id,tenant_id,actor_id,run_id,operation_key,body_text,body_hash,output_hash,
  acknowledgement_receipt,policy_index,policy_draft_id,policy_receipt)
 values(v_id,p_tenant_id,p_actor_id,(proof->>'run_id')::uuid,p_operation_key,p_body_text,h,proof->>'output_hash',receipt,index,policy.id,policy.receipt_id);
 return jsonb_build_object('acknowledgement_id',v_id,'receipt_id',receipt::text,'policy_draft_id',policy.id,'replayed',false,
  'manifest',manifest||jsonb_build_object('acknowledgementId',v_id,'receiptId',receipt::text,'policyDraftId',policy.id,'policyReceipt',policy.receipt_id::text));
exception when data_exception then return jsonb_build_object('error','invalid_acknowledgement');
end $$;
revoke all on function public.acknowledge_reviewed_workflow_output(uuid,uuid,uuid,uuid,text,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.acknowledge_reviewed_workflow_output(uuid,uuid,uuid,uuid,text,uuid,text) to human_action_writer;

-- Exact lost-response inspection. It can only enter the replay branch after
-- holding the SAME operation lock and finding the immutable acknowledgement.
-- An unsent/missing acknowledgement never acquires a human decision here.
create function public.recover_reviewed_workflow_acknowledgement(
 p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_original_operation_key uuid,p_input_text text,
 p_operation_key uuid,p_body_text text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare proof jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human reviewed workflow reader required' using errcode='42501';end if;
 proof:=public.recover_reviewed_workflow_output(p_tenant_id,p_actor_id,p_engagement_id,p_original_operation_key,p_input_text);
 if proof?'error' or proof?'missing' then return jsonb_build_object('error','output_proof_refused');end if;
 if p_operation_key is null then return jsonb_build_object('error','invalid_acknowledgement');end if;
 perform pg_advisory_xact_lock(hashtextextended('reviewed-workflow-ack/'||p_tenant_id::text||'/'||p_operation_key::text,118));
 if not exists(select 1 from public.reviewed_workflow_acknowledgements where tenant_id=p_tenant_id and operation_key=p_operation_key)
 then return jsonb_build_object('missing',true);end if;
 return public.acknowledge_reviewed_workflow_output(p_tenant_id,p_actor_id,p_engagement_id,p_original_operation_key,p_input_text,p_operation_key,p_body_text);
end $$;
revoke all on function public.recover_reviewed_workflow_acknowledgement(uuid,uuid,uuid,uuid,text,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_reviewed_workflow_acknowledgement(uuid,uuid,uuid,uuid,text,uuid,text) to human_action_writer;
