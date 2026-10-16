-- Additive source3/document4 support for asset-linked accepted assessments.
-- Unrelated legacy source1/2 bytes and public RPC OIDs/ACLs are preserved.
-- No inventory freshness, withdrawal, or head check is added to report freezing.


create or replace function controller_security.public_control_report_provenance(
 p_tenant_id uuid,p_run_id uuid,p_engagement_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 s public.public_control_assessment_sources;j public.assessment_dispatch_jobs;
 r public.public_control_review_sets;c public.public_website_control_evidence;
 w public.public_website_checks;p public.workload_assessment_packets;t public.workload_task_delegations;
 requested public.audit_ledger;reviewed public.audit_ledger;captured public.audit_ledger;
 snap jsonb;req jsonb;input jsonb;expected text;manifest text;provenance jsonb;asset jsonb;
 ctrl jsonb;observed jsonb;questions jsonb;field text;declaration_value jsonb;rows_digest text;total integer;affirmed integer;denied integer;unknowns integer;answer_state text;applicability_state text;
begin
 select * into s from public.public_control_assessment_sources where run_id=p_run_id;
 if not found then return null;end if;
 if s.tenant_id is distinct from p_tenant_id or s.engagement_id is distinct from p_engagement_id
 or not public.board_assessment_source_valid(p_tenant_id,p_run_id,p_engagement_id)
 then raise exception 'human review report source refused' using errcode='23514';end if;
 select * into j from public.assessment_dispatch_jobs where id=s.job_id;
 select * into t from public.workload_task_delegations where run_id=s.run_id;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=s.review_id;
 select * into c from public.public_website_control_evidence where tenant_id=p_tenant_id and check_id=r.check_id;
 select * into w from public.public_website_checks where tenant_id=p_tenant_id and id=r.check_id;
 select * into p from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=s.run_id;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id and id=s.requested_receipt;
 select * into reviewed from public.audit_ledger where tenant_id=p_tenant_id and id=s.review_receipt;
 select * into captured from public.audit_ledger where tenant_id=p_tenant_id and id=s.capture_receipt;
 snap:=r.snapshot_text::jsonb;req:=r.request_text::jsonb;input:=s.input_text::jsonb;
 expected:=controller_security.canonical_questionnaire_json(jsonb_build_object(
  'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'library_version','0.1.1',
  'answers',snap->'normalizedAnswers','sdf_self_attested',req->'applicability'->'sdfSelfAttested',
  'processes_children',req->'applicability'->'processesChildren','processes_health',req->'applicability'->'processesHealth'));
 if j.id is null or t.run_id is null or r.id is null or c.check_id is null or w.id is null
 or j.tenant_id is distinct from p_tenant_id or j.actor_id is distinct from s.actor_id
 or j.run_id is distinct from s.run_id or j.engagement_id is distinct from p_engagement_id
 or j.estate_id is distinct from s.estate_id or j.input_hash is distinct from s.input_sha256
 or t.tenant_id is distinct from p_tenant_id or t.created_by is distinct from s.actor_id
 or t.engagement_id is distinct from p_engagement_id or t.estate_id is distinct from s.estate_id
 or t.input_hash is distinct from s.input_sha256 or t.correlation_id is distinct from j.correlation_id
 or r.engagement_id is distinct from p_engagement_id or r.estate_id is distinct from s.estate_id
 or r.request_sha256 is distinct from s.request_sha256 or r.snapshot_sha256 is distinct from s.snapshot_sha256
 or r.receipt_id is distinct from s.review_receipt or c.capture_receipt is distinct from s.capture_receipt
 or s.input_text is distinct from expected
 or s.input_sha256 is distinct from encode(sha256(convert_to(s.input_text,'UTF8')),'hex')
 or r.request_sha256 is distinct from encode(sha256(convert_to(r.request_text,'UTF8')),'hex')
 or r.snapshot_sha256 is distinct from encode(sha256(convert_to(r.snapshot_text,'UTF8')),'hex')
 or snap->'request' is distinct from req or snap->>'tenantId' is distinct from p_tenant_id::text
 or snap->>'engagementId' is distinct from p_engagement_id::text or (snap->>'estateId')::uuid is distinct from s.estate_id
 or snap->>'checkId' is distinct from r.check_id::text or snap->>'captureReceipt' is distinct from c.capture_receipt::text
 or (snap->>'checkedAt')::timestamptz is distinct from w.checked_at
 or snap->'declarationsVerified' is distinct from 'false'::jsonb or snap->'requiresHumanReview' is distinct from 'true'::jsonb
 or req->'expectedSource'->>'payloadSha256' is distinct from c.payload_sha256
 or req->'expectedSource'->>'libraryVersion' is distinct from '0.1.1'
 or req->'expectedSource'->>'mappingVersion' is distinct from 'public-evidence-1'
 or req->'expectedSource'->>'questionnaireDigest' is distinct from '1fcd03e3c5e1cbec9bf09f86a0f26d05ec117d4d4acb3a8a448195e5ee897b0e'
 or c.codec is distinct from 'axiom-public-evidence-v2-canonical-json-1'
 or c.payload_sha256 is distinct from encode(sha256(convert_to(c.payload_text,'UTF8')),'hex')
 or requested.id is null or requested.action_type::text is distinct from 'assessment.requested'
 or requested.actor_type::text is distinct from 'human' or requested.actor_id is distinct from s.actor_id::text
 or requested.correlation_id is distinct from s.job_id or requested.target_ref is distinct from s.job_id::text
 or requested.input_hash is distinct from s.input_sha256 or requested.result::text is distinct from 'pending'
 or requested.detail->>'run_id' is distinct from s.run_id::text
 or reviewed.id is null or reviewed.action_type::text is distinct from 'public_control.review_recorded'
 or reviewed.actor_type::text is distinct from 'human' or reviewed.actor_id is distinct from r.actor_id::text
 or reviewed.correlation_id is distinct from r.operation_key or reviewed.target_ref is distinct from r.id::text
 or reviewed.input_hash is distinct from r.request_sha256 or reviewed.output_hash is distinct from r.snapshot_sha256
 or reviewed.result::text is distinct from 'success'
 or captured.id is null or captured.action_type::text is distinct from 'connector.website.evidence_captured'
 or captured.actor_type::text is distinct from 'human' or captured.actor_id is distinct from w.actor_id::text
 or captured.correlation_id is distinct from w.correlation_id or w.status is distinct from 'checked'
 or captured.target_ref is distinct from w.id::text or captured.input_hash is distinct from c.payload_sha256
 or captured.output_hash is distinct from encode(sha256(convert_to(c.page_sources::text,'UTF8')),'hex')
 or captured.result::text is distinct from 'success'
 then raise exception 'human review report binding refused' using errcode='23514';end if;
 -- The normal worker already emits these declarations. A report may not imply
 -- they came from this review unless the finalized packet agrees exactly.
 select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_agg(v-'created_at' order by v->>'id')),'UTF8')),'hex') into rows_digest from jsonb_array_elements(p.controls)v;
 if rows_digest is distinct from 'ddf7b3202e731871a78012ddeffa7b8ebde4c2f4b8b3dbbfa7fd95e1c6a7a011'
 then raise exception 'human review frozen catalogue refused' using errcode='23514';end if;
 provenance:=p.result->'questionnaire_provenance';
 if p.library_version is distinct from '0.1.1' or provenance->>'source_library_version' is distinct from p.library_version
 or provenance->>'source_library_digest' is distinct from p.library_digest
 or provenance->'version' is distinct from '1'::jsonb or provenance->>'estimates' is distinct from 'provisional'
 or provenance->'review_required' is distinct from 'true'::jsonb
 or jsonb_typeof(provenance->'controls') is distinct from 'array'
 or jsonb_array_length(provenance->'controls') is distinct from jsonb_array_length(p.controls)
 then raise exception 'human review computation provenance refused' using errcode='23514';end if;
 for ctrl in select value from jsonb_array_elements(p.controls) loop
  select value into observed from jsonb_array_elements(provenance->'controls') where value->>'control_id'=ctrl->>'id';
  select coalesce(jsonb_agg(jsonb_build_object('question_id',value->>'id','declaration',case input->'answers'->(ctrl->>'id')->(value->>'id') when 'true'::jsonb then 'caller_affirmed' when 'false'::jsonb then 'caller_denied' else 'unknown' end) order by value->>'id'),'[]'::jsonb)
   into questions from jsonb_array_elements(ctrl->'assessment_questions') where value->>'type'='boolean';
  select count(*),count(*) filter(where value->>'declaration'='caller_affirmed'),count(*) filter(where value->>'declaration'='caller_denied'),count(*) filter(where value->>'declaration'='unknown') into total,affirmed,denied,unknowns from jsonb_array_elements(questions);
  answer_state:=case when total=0 then 'not_boolean_assessable' when unknowns=total then 'unknown' when unknowns>0 then 'partially_answered' else 'caller_declared_unverified' end;
  applicability_state:=case when ctrl->>'sdf_only'<>'true' and ctrl->>'children_only'<>'true' then 'unconditional' when (ctrl->>'sdf_only'='true' and input->'sdf_self_attested'='false'::jsonb) or (ctrl->>'children_only'='true' and input->'processes_children'='false'::jsonb) then 'caller_declared_not_applicable_unverified' when (ctrl->>'sdf_only'='true' and input->'sdf_self_attested'='null'::jsonb) or (ctrl->>'children_only'='true' and input->'processes_children'='null'::jsonb) then 'unknown' else 'caller_declared_applicable_unverified' end;
  if observed is null or observed->'questions' is distinct from questions
   or observed->'known_boolean_question_count' is distinct from to_jsonb(total) or observed->'caller_affirmed_count' is distinct from to_jsonb(affirmed) or observed->'caller_denied_count' is distinct from to_jsonb(denied) or observed->'unknown_count' is distinct from to_jsonb(unknowns)
   or observed->>'answer_state' is distinct from answer_state or observed->>'applicability_state' is distinct from applicability_state
   or (select count(*) from jsonb_array_elements(provenance->'controls') where value->>'control_id'=ctrl->>'id')<>1
  then raise exception 'human review answer provenance refused' using errcode='23514';end if;
 end loop;
 foreach field in array array['sdf_self_attested','processes_children','processes_health'] loop
  declaration_value:=input->field;
  if provenance->'applicability'->field is distinct from jsonb_build_object('value',declaration_value,'provenance',case when declaration_value='null'::jsonb then 'unknown' else 'caller_declared_unverified' end)
  then raise exception 'human review applicability provenance refused' using errcode='23514';end if;
 end loop;
 manifest:=controller_security.public_control_report_mapping_manifest();
 if req->'expectedSource'->>'catalogueManifestSha256' is distinct from encode(sha256(convert_to(manifest,'UTF8')),'hex')
 then raise exception 'human review mapping provenance refused' using errcode='23514';end if;
 -- Frozen139 rows and their actual receipts only: no current inventory,
 -- withdrawal, role, or review-head lookup may invalidate an accepted run.
 if r.request_codec='axiom-public-control-review-request-canonical-json-2' then
  if r.snapshot_codec is distinct from 'axiom-public-control-review-snapshot-pg-canonical-json-2'
   or req->'version' is distinct from '2'::jsonb or snap->'version' is distinct from '2'::jsonb
  then raise exception 'asset report review codec refused' using errcode='23514';end if;
  asset:=controller_security.review141_assets(p_tenant_id,req);
  if snap->'assetProvenance' is distinct from asset
   or asset->>'estate_id' is distinct from s.estate_id::text
  then raise exception 'asset report provenance refused' using errcode='23514';end if;
 end if;
 return jsonb_build_object(
  'schema_version',case when asset is null then 1 else 2 end,'kind','public_control_review','tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'estate_id',s.estate_id,
  'job_id',s.job_id,'assessment_run_id',s.run_id,'requested_by',s.actor_id,
  'worker_input',jsonb_build_object('codec','axiom-assessment-input-canonical-json-1','text',s.input_text,'sha256',s.input_sha256),
  'requested_receipt',jsonb_build_object('id',requested.id::text,'entry_hash',requested.entry_hash),
  'review',jsonb_build_object('id',r.id,'actor_id',r.actor_id,'operation_key',r.operation_key,'request_codec',r.request_codec,'request_text',r.request_text,'request_sha256',r.request_sha256,'snapshot_codec',r.snapshot_codec,'snapshot_text',r.snapshot_text,'snapshot_sha256',r.snapshot_sha256,'receipt',jsonb_build_object('id',reviewed.id::text,'entry_hash',reviewed.entry_hash),'created_at',r.created_at),
  'capture',jsonb_build_object('check_id',c.check_id,'checked_at',w.checked_at,'codec',c.codec,'payload_text',c.payload_text,'payload_sha256',c.payload_sha256,'page_sources',c.page_sources,'page_sources_text',c.page_sources::text,'page_sources_sha256',captured.output_hash,'capture_receipt',jsonb_build_object('id',captured.id::text,'entry_hash',captured.entry_hash)),
  'catalogue',jsonb_build_object('library_version','0.1.1','questionnaire_digest',req->'expectedSource'->'questionnaireDigest','mapping_version','public-evidence-1','manifest_text',manifest,'manifest_sha256',encode(sha256(convert_to(manifest,'UTF8')),'hex')),
  'declarations_verified',false,'evidence_verified',false,'review_required',true
 );
end $$;

create or replace function public.capture_board_request_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  packet public.workload_assessment_packets;
  started public.audit_ledger;
  completed public.audit_ledger;
  finalized public.audit_ledger;
  controls_text text;
  result_text text;
  source_text text;
  human_review jsonb;
begin
  -- The request RPC checked and share-locked the same finalized packet.
  -- Recheck here so an alternative privileged INSERT cannot freeze a
  -- merely completed or mismatched packet.
  if not public.board_assessment_source_valid(
    new.tenant_id, new.assessment_run_id, new.engagement_id
  ) then
    raise exception 'board assessment source is not finalized';
  end if;

  select * into packet from public.workload_assessment_packets
    where tenant_id = new.tenant_id and run_id = new.assessment_run_id
      and engagement_id = new.engagement_id for share;
  if not found or packet.result_digest is distinct from new.assessment_result_digest
     or packet.library_digest is distinct from new.library_digest
     or packet.library_version is distinct from new.library_version then
    raise exception 'board assessment source changed';
  end if;

  controls_text := packet.controls::text;
  result_text := packet.result::text;
  if packet.library_digest is distinct from encode(sha256(convert_to(controls_text, 'UTF8')), 'hex')
     or packet.result_digest is distinct from encode(sha256(convert_to(result_text, 'UTF8')), 'hex') then
    raise exception 'board assessment digest mismatch';
  end if;

  select * into started from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.started_receipt;
  select * into completed from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.completed_receipt;
  select * into finalized from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.finalized_receipt;

  source_text := jsonb_build_object(
    'schema_version', 1,
    'serialization', 'postgres-jsonb-text-v1',
    'kind', 'board_source',
    'request_id', new.id,
    'tenant_id', new.tenant_id,
    'engagement_id', new.engagement_id,
    'assessment_run_id', new.assessment_run_id,
    'library_version', packet.library_version,
    'controls_text', controls_text,
    'controls_sha256', packet.library_digest,
    'result_text', result_text,
    'result_sha256', packet.result_digest,
    'completed_at', packet.completed_at,
    'finalized_at', packet.finalized_at,
    'receipts', jsonb_build_object(
      'started', jsonb_build_object('id', started.id::text, 'entry_hash', started.entry_hash),
      'completed', jsonb_build_object('id', completed.id::text, 'entry_hash', completed.entry_hash),
      'finalized', jsonb_build_object('id', finalized.id::text, 'entry_hash', finalized.entry_hash)
    ),
    'limitations', jsonb_build_array(
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.'
    )
  )::text;
  human_review := controller_security.public_control_report_provenance(new.tenant_id,new.assessment_run_id,new.engagement_id);
  if human_review is not null then
    source_text := (source_text::jsonb || jsonb_build_object('schema_version',case when human_review->>'schema_version'='2' then 3 else 2 end,'human_control_review',human_review))::text;
  end if;
  if octet_length(source_text) > 4194304 then
    raise exception 'board source exceeds byte limit';
  end if;

  insert into public.board_request_sources (
    request_id, tenant_id, source_text, source_sha256,
    controls_sha256, result_sha256
  ) values (
    new.id, new.tenant_id, source_text,
    encode(sha256(convert_to(source_text, 'UTF8')), 'hex'),
    packet.library_digest, packet.result_digest
  );
  return new;
end $$;

create or replace function public.capture_statutory_request_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  packet public.workload_assessment_packets;
  started public.audit_ledger;
  completed public.audit_ledger;
  finalized public.audit_ledger;
  controls_text text;
  result_text text;
  source_text text;
  human_review jsonb;
begin
  -- The request RPC checked and share-locked the same finalized packet.
  -- Recheck here so an alternative privileged INSERT cannot freeze a
  -- merely completed or mismatched packet.
  if not public.board_assessment_source_valid(
    new.tenant_id, new.assessment_run_id, new.engagement_id
  ) then
    raise exception 'auditor assessment source is not finalized';
  end if;

  select * into packet from public.workload_assessment_packets
    where tenant_id = new.tenant_id and run_id = new.assessment_run_id
      and engagement_id = new.engagement_id for share;
  if not found or packet.result_digest is distinct from new.assessment_result_digest
     or packet.library_digest is distinct from new.library_digest
     or packet.library_version is distinct from new.library_version then
    raise exception 'auditor assessment source changed';
  end if;

  controls_text := packet.controls::text;
  result_text := packet.result::text;
  if packet.library_digest is distinct from encode(sha256(convert_to(controls_text, 'UTF8')), 'hex')
     or packet.result_digest is distinct from encode(sha256(convert_to(result_text, 'UTF8')), 'hex') then
    raise exception 'auditor assessment digest mismatch';
  end if;

  select * into started from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.started_receipt;
  select * into completed from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.completed_receipt;
  select * into finalized from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.finalized_receipt;

  source_text := jsonb_build_object(
    'schema_version', 1,
    'serialization', 'postgres-jsonb-text-v1',
    'kind', 'statutory_source',
    'report_kind', new.kind,
    'request_id', new.id,
    'tenant_id', new.tenant_id,
    'engagement_id', new.engagement_id,
    'assessment_run_id', new.assessment_run_id,
    'library_version', packet.library_version,
    'controls_text', controls_text,
    'controls_sha256', packet.library_digest,
    'result_text', result_text,
    'result_sha256', packet.result_digest,
    'completed_at', packet.completed_at,
    'finalized_at', packet.finalized_at,
    'receipts', jsonb_build_object(
      'started', jsonb_build_object('id', started.id::text, 'entry_hash', started.entry_hash),
      'completed', jsonb_build_object('id', completed.id::text, 'entry_hash', completed.entry_hash),
      'finalized', jsonb_build_object('id', finalized.id::text, 'entry_hash', finalized.entry_hash)
    ),
    'limitations', jsonb_build_array(
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Assessment-derived auditor review only; no independent audit attestation, evidence certification, compliance certification or legal opinion.'
    )
  )::text;
  human_review := controller_security.public_control_report_provenance(new.tenant_id,new.assessment_run_id,new.engagement_id);
  if human_review is not null then
    source_text := (source_text::jsonb || jsonb_build_object('schema_version',case when human_review->>'schema_version'='2' then 3 else 2 end,'human_control_review',human_review))::text;
  end if;
  if octet_length(source_text) > 4194304 then
    raise exception 'auditor source exceeds byte limit';
  end if;

  insert into public.statutory_request_sources (
    request_id, tenant_id, source_text, source_sha256,
    controls_sha256, result_sha256
  ) values (
    new.id, new.tenant_id, source_text,
    encode(sha256(convert_to(source_text, 'UTF8')), 'hex'),
    packet.library_digest, packet.result_digest
  );
  return new;
end $$;

-- Pure qualified appendix projection: every label derives from frozen bytes.
create function controller_security.public_control_asset_report_appendix(h jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare snap jsonb:=(h->'review'->>'snapshot_text')::jsonb;a jsonb:=snap->'assetProvenance';
 t jsonb:=(a->'target'->>'snapshot_text')::jsonb;c jsonb:=(a->'association'->>'snapshot_text')::jsonb;
begin
 if h->'schema_version' is distinct from '2'::jsonb or snap->'version' is distinct from '2'::jsonb
 or a->'schema_version' is distinct from '1'::jsonb or a->>'kind' is distinct from 'public_website_asset_binding'
 or a->'ownership_verified' is distinct from 'false'::jsonb or a->'connector_access_granted' is distinct from 'false'::jsonb
 or a->'review_required' is distinct from 'true'::jsonb
 then raise exception 'asset report appendix refused' using errcode='23514';end if;
 return jsonb_build_object('label','human-declared asset scope','tenant_id',a->'tenant_id',
 'estate',jsonb_build_object('id',t->'estateId','name',t->'estateName','version',t->'estateVersion'),
 'system',jsonb_build_object('id',t->'systemId','name',t->'systemName','version',t->'systemVersion'),
 'target',jsonb_build_object('id',t->'id','version',t->'targetVersion','url',t->'url','sha256',a->'target'->'snapshot_sha256','declared_by',a->'target'->'actor_id','receipt',a->'target'->'receipt'),
 'association',jsonb_build_object('id',c->'id','sha256',a->'association'->'snapshot_sha256','declared_by',a->'association'->'actor_id','receipt',a->'association'->'receipt','check_id',c->'checkId','payload_sha256',c->'payloadSha256','capture_receipt',c->'captureReceipt','requested_url',c->'requestedUrl','final_url',c->'finalUrl','checked_at',c->'checkedAt'),
 'ownership_verified',false,'connector_access_granted',false,'review_required',true,
 'qualification','Human-declared asset scope retained with this review. It does not verify website ownership, grant connector access, or establish current inventory or authority.');
end $$;
revoke all on function controller_security.public_control_asset_report_appendix(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;


create or replace function public.record_board_report_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.board_report_requests;
  v_report public.reports;
  v_content jsonb;
  v_content_hash text;
  v_html_hash text;
  v_source public.board_request_sources;
  expected_review jsonb;
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_request_id is null or p_correlation_id is null or p_content_text is null
     or octet_length(p_content_text) > 5242880 or p_html_text is null
     or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_request');
  end;

  if jsonb_typeof(v_content) is distinct from 'object' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, v_req.assessment_run_id, v_req.engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  select * into v_source from public.board_request_sources where tenant_id=p_tenant_id and request_id=v_req.id;
  if v_source.source_text::jsonb->>'schema_version' in ('2','3') then
    expected_review:=controller_security.public_control_report_interpretation((v_source.source_text::jsonb->>'result_text')::jsonb,v_req.title);
    if v_content->'schema_version' is distinct from (case when v_source.source_text::jsonb->>'schema_version'='3' then '4'::jsonb else '3'::jsonb end)
     or (v_source.source_text::jsonb->>'schema_version'='3' and v_content->'asset_scope' is distinct from controller_security.public_control_asset_report_appendix(v_source.source_text::jsonb->'human_control_review'))
     or (v_source.source_text::jsonb->>'schema_version'='2' and v_content?'asset_scope')
     or v_content->>'kind' is distinct from 'board_report' or v_content->>'title' is distinct from v_req.title
     or v_content->>'tenant_id' is distinct from p_tenant_id::text or v_content->>'engagement_id' is distinct from v_req.engagement_id::text
     or v_content->>'assessment_run_id' is distinct from v_req.assessment_run_id::text
     or v_content->>'source_sha256' is distinct from v_source.source_sha256
     or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
     or v_content->>'library_version' is distinct from v_req.library_version or v_content->>'library_digest' is distinct from v_req.library_digest
     or v_content->'public_review_appendix' is distinct from controller_security.public_control_report_appendix(v_source.source_text::jsonb->'human_control_review')
     or v_content->'questionnaire_interpretation' is distinct from expected_review->'interpretation'
     or v_content->'executive_summary' is distinct from expected_review->'summary'
    then return jsonb_build_object('error','assessment_source_conflict');end if;
  elsif v_content->'schema_version' in ('3'::jsonb,'4'::jsonb) or v_content?'public_review_appendix' or v_content?'asset_scope' then
    return jsonb_build_object('error','assessment_source_conflict');
  end if;
  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found and v_report.content_sha256 = v_content_hash then
      return jsonb_build_object(
        'reportId', v_report.id,
        'requestId', v_req.id,
        'status', v_report.status,
        'contentHash', v_content_hash,
        'replayed', true
      );
    end if;
  end if;

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, v_req.engagement_id, 'board'::public.report_kind, v_req.title, null, v_content,
    v_req.library_version, 'board-report-builder', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.board_report_artifacts (
    tenant_id, report_id, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.board_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'system', 'board-report-builder', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'request_id', v_req.id,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'requestId', v_req.id,
    'status', 'draft',
    'contentHash', v_content_hash,
    'replayed', false
  );
end $$;

create or replace function public.record_source_bound_statutory_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.statutory_report_requests;
  v_report public.reports;
  v_source public.statutory_request_sources;
  v_content jsonb;
  v_result jsonb;
  v_source_document jsonb;
  v_controls jsonb;
  v_content_hash text;
  v_html_hash text;
  extra_fields text[];
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_request_id is null or p_correlation_id is null or p_content_text is null
     or octet_length(p_content_text) > 5242880 or p_html_text is null
     or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_request');
  end;

  if jsonb_typeof(v_content) is distinct from 'object' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and id = p_request_id;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, v_req.assessment_run_id, v_req.engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  select * into v_source from public.statutory_request_sources
   where tenant_id = p_tenant_id and request_id = v_req.id;
  if found then
    v_source_document := v_source.source_text::jsonb;
    v_result := (v_source_document->>'result_text')::jsonb;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',item->>'id','title',item->>'title','domain',item->>'domain','severity',item->>'severity'
    ) order by ordinal),'[]'::jsonb) into v_controls
    from jsonb_array_elements((v_source_document->>'controls_text')::jsonb) with ordinality as c(item,ordinal);
  end if;
  extra_fields:=case when v_source_document->>'schema_version'='3' then array['public_review_appendix','questionnaire_review','asset_scope'] when v_source_document->>'schema_version'='2' then array['public_review_appendix','questionnaire_review'] else array[]::text[] end;
  if not found or v_source.source_sha256 is distinct from encode(sha256(convert_to(v_source.source_text,'UTF8')),'hex')
    or not (v_content ?& (array['schema_version','kind','source_kind','request_id','tenant_id',
      'engagement_id','assessment_run_id','source_sha256','assessment_result_digest','library_digest',
      'library_version','title','generated_by','generated_at','posture_score','finalized_at',
      'finalized_ledger_receipt','findings','controls','limitations']||extra_fields))
    or (v_content - (array['schema_version','kind','source_kind','request_id','tenant_id',
      'engagement_id','assessment_run_id','source_sha256','assessment_result_digest','library_digest',
      'library_version','title','generated_by','generated_at','posture_score','finalized_at',
      'finalized_ledger_receipt','findings','controls','limitations']||extra_fields)) <> '{}'::jsonb
    or v_content->'schema_version' is distinct from (case when v_source_document->>'schema_version'='3' then '4'::jsonb when v_source_document->>'schema_version'='2' then '3'::jsonb else '2'::jsonb end)
    or (v_source_document->>'schema_version' in ('2','3') and (v_content->'public_review_appendix' is distinct from controller_security.public_control_report_appendix(v_source_document->'human_control_review') or v_content->'questionnaire_review' is distinct from controller_security.public_control_report_interpretation(v_result,v_req.title)))
    or (v_source_document->>'schema_version'='3' and v_content->'asset_scope' is distinct from controller_security.public_control_asset_report_appendix(v_source_document->'human_control_review'))
    or v_content->>'kind' is distinct from 'auditor_pack'
    or v_content->>'source_kind' is distinct from 'finalized_assessment'
    or v_content->>'request_id' is distinct from v_req.id::text
    or v_content->>'tenant_id' is distinct from p_tenant_id::text
    or v_content->>'engagement_id' is distinct from v_req.engagement_id::text
    or v_content->>'source_sha256' is distinct from v_source.source_sha256
    or v_content->>'assessment_run_id' is distinct from v_req.assessment_run_id::text
    or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
    or v_content->>'library_digest' is distinct from v_req.library_digest
    or v_content->>'library_version' is distinct from v_req.library_version
    or v_content->>'title' is distinct from v_req.title
    or v_content->>'generated_by' is distinct from 'statutory-report-builder'
    or jsonb_typeof(v_content->'generated_at') is distinct from 'string'
    or length(coalesce(v_content->>'generated_at','')) not between 1 and 80
    or v_content->'posture_score' is distinct from v_result->'posture_score'
    or v_content->>'finalized_at' is distinct from v_source_document->>'finalized_at'
    or v_content->>'finalized_ledger_receipt' is distinct from v_source_document#>>'{receipts,finalized,id}'
    or jsonb_typeof(v_result->'findings') is distinct from 'array'
    or v_content->'findings' is distinct from v_result->'findings'
    or v_content->'controls' is distinct from v_controls
    or v_content->>'limitations' is distinct from
      'Assessment-derived findings only. No independent audit, evidence verification, or auditor attestation is represented.' then
    return jsonb_build_object('error', 'assessment_source_conflict');
  end if;

  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found then
      if v_report.content_sha256 is distinct from v_content_hash then
        return jsonb_build_object('error','idempotency_conflict');
      end if;
      return jsonb_build_object(
        'reportId', v_report.id,
        'requestId', v_req.id,
        'status', v_report.status,
        'contentHash', v_content_hash,
        'replayed', true
      );
    end if;
  end if;

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, v_req.engagement_id, v_req.kind, v_req.title, null, v_content,
    v_req.library_version, 'statutory-report-builder', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.statutory_report_artifacts (
    tenant_id, report_id, kind, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_req.kind, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.statutory_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'system', 'statutory-report-builder', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'request_id', v_req.id,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'requestId', v_req.id,
    'status', 'draft',
    'contentHash', v_content_hash,
    'replayed', false
  );
end $$;
