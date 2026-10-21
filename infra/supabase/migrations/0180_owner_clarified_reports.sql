-- New requests freeze owner coverage declarations separately from observed evidence.
-- Existing sources/documents/reviews/artifacts retain their original codecs and bytes.
begin;
create function controller_security.coverage180_inner(kind text,txt text,sha text) returns jsonb
language plpgsql stable set search_path='' as $$
declare e jsonb;b jsonb;inner_source jsonb;original jsonb;cap jsonb;oc jsonb;snapshot jsonb;
 r controller_security.public_coverage_clarifications;pages jsonb;needed boolean;
begin
 if kind not in('board','auditor') or txt is null or octet_length(txt)>4194304
 or sha is distinct from encode(sha256(convert_to(txt,'UTF8')),'hex')
 or not controller_security.coverage144_unique(txt::json,0) then raise exception 'clarified source refused'using errcode='22023';end if;
 e:=txt::jsonb;
 if controller_security.flow174_keys(e,array['schema_version','kind','serialization','report_kind','retained_source','owner_clarification'])is distinct from true
 or e->'schema_version'is distinct from '8'::jsonb or e->>'kind'is distinct from 'clarified_report_source'
 or e->>'serialization'is distinct from 'axiom-clarified-report-source-json-1' or e->>'report_kind'is distinct from kind
 or controller_security.flow174_keys(e->'retained_source',array['text','sha256'])is distinct from true
 or controller_security.canonical_questionnaire_json(e)is distinct from txt
 then raise exception 'clarified source refused'using errcode='22023';end if;
 b:=controller_security.brand177_inner(kind,e->'retained_source'->>'text',e->'retained_source'->>'sha256');
 inner_source:=(b->'retained_source'->>'text')::jsonb;oc:=e->'owner_clarification';
 if inner_source->'schema_version'='5'::jsonb then
  if oc is distinct from 'null'::jsonb then raise exception 'questionnaire clarification refused'using errcode='22023';end if;
  return e;
 end if;
 original:=(inner_source->'retained_source'->>'text')::jsonb;cap:=original->'human_control_review'->'capture';
 pages:=controller_security.coverage179_pages((cap->>'payload_text')::jsonb);
 needed:=exists(select 1 from jsonb_array_elements(pages)p where p->>'state'<>'examined'or p->'truncated'='true'::jsonb);
 if oc='null'::jsonb then
  if needed then raise exception 'owner coverage explanation required'using errcode='22023';end if;
  return e;
 end if;
 if controller_security.flow174_keys(oc,array['snapshot_text','snapshot_sha256','receipt_id'])is distinct from true
 or not controller_security.flow174_digest(oc->'snapshot_sha256')or oc->>'receipt_id'!~'^[1-9][0-9]{0,39}$'
 or octet_length(oc->>'snapshot_text')>24576
 or encode(sha256(convert_to(oc->>'snapshot_text','UTF8')),'hex')is distinct from oc->>'snapshot_sha256'
 then raise exception 'owner coverage explanation refused'using errcode='22023';end if;
 select *into r from controller_security.public_coverage_clarifications where tenant_id=(original->>'tenant_id')::uuid
 and engagement_id=(original->>'engagement_id')::uuid and check_id=(cap->>'check_id')::uuid and payload_sha256=cap->>'payload_sha256'
 and snapshot_text=oc->>'snapshot_text'and snapshot_sha256=oc->>'snapshot_sha256'and receipt_id::text=oc->>'receipt_id';
 if r.id is null or not exists(select 1 from public.audit_ledger l where l.tenant_id=r.tenant_id and l.id=r.receipt_id
 and l.actor_type='human'and l.actor_id=r.actor_id::text and l.action_type::text='public_coverage.owner_clarified'
 and l.target_ref=r.id::text and l.output_hash=r.snapshot_sha256 and l.result='success')
 then raise exception 'owner coverage receipt refused'using errcode='22023';end if;
 snapshot:=(oc->>'snapshot_text')::jsonb;
 if snapshot->>'tenantId'is distinct from original->>'tenant_id'or snapshot->'request'->>'engagementId'is distinct from original->>'engagement_id'
 or snapshot->'request'->>'checkId'is distinct from cap->>'check_id'or snapshot->'request'->>'payloadSha256'is distinct from cap->>'payload_sha256'
 or snapshot->>'disposition'is distinct from 'owner_declarations_unverified'
 then raise exception 'owner coverage scope refused'using errcode='22023';end if;
 return e;
end $$;

create function controller_security.coverage180_document(kind text,source_text text,source_sha text,t uuid,eid uuid,rid uuid,req uuid,title text,generated text)
returns jsonb language plpgsql stable set search_path=''as $$
declare e jsonb;d jsonb;oc jsonb;
begin
 e:=controller_security.coverage180_inner(kind,source_text,source_sha);oc:=e->'owner_clarification';
 d:=controller_security.brand177_document(kind,e->'retained_source'->>'text',e->'retained_source'->>'sha256',t,eid,rid,req,title,generated);
 return d||jsonb_build_object('schema_version',8,'source_sha256',source_sha,'branded_source_sha256',e->'retained_source'->'sha256',
 'owner_coverage_clarification',case when oc='null'::jsonb then null else(oc->>'snapshot_text')::jsonb end,
 'owner_clarification_sha256',case when oc='null'::jsonb then null else oc->>'snapshot_sha256'end,
 'owner_clarification_receipt',case when oc='null'::jsonb then null else oc->>'receipt_id'end);
end $$;

create function controller_security.coverage180_select()returns trigger language plpgsql security definer set search_path=''as $$
declare kind text;b jsonb;inner_source jsonb;original jsonb;cap jsonb;r controller_security.public_coverage_clarifications;oc jsonb:='null'::jsonb;txt text;
begin
 if current_setting('axiom.report_coverage_review',true)is distinct from 'owner-coverage-1'then return new;end if;
 kind:=case when tg_table_name='board_request_sources'then'board'else'auditor'end;
 b:=controller_security.brand177_inner(kind,new.source_text,new.source_sha256);inner_source:=(b->'retained_source'->>'text')::jsonb;
 if inner_source->'schema_version'='4'::jsonb then
 original:=(inner_source->'retained_source'->>'text')::jsonb;cap:=original->'human_control_review'->'capture';
 if original->>'tenant_id'is distinct from new.tenant_id::text then raise exception 'coverage source scope refused'using errcode='22023';end if;
 -- Serialize capture against owner revisions. Historic frozen requests do not
 -- require this head to remain current during later rendering/review/release.
 perform pg_advisory_xact_lock(hashtextextended('public-coverage179:'||new.tenant_id::text,0));
 select *into r from controller_security.public_coverage_clarifications x where x.tenant_id=new.tenant_id
 and x.engagement_id=(original->>'engagement_id')::uuid and x.check_id=(cap->>'check_id')::uuid and x.payload_sha256=cap->>'payload_sha256'
 and not exists(select 1 from controller_security.public_coverage_clarifications n where n.previous_revision_id=x.id);
 if r.id is not null then oc:=jsonb_build_object('snapshot_text',r.snapshot_text,'snapshot_sha256',r.snapshot_sha256,'receipt_id',r.receipt_id::text);end if;
 end if;
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object('schema_version',8,'kind','clarified_report_source','serialization','axiom-clarified-report-source-json-1','report_kind',kind,
 'retained_source',jsonb_build_object('text',new.source_text,'sha256',new.source_sha256),'owner_clarification',oc));
 perform controller_security.coverage180_inner(kind,txt,encode(sha256(convert_to(txt,'UTF8')),'hex'));
 new.source_text:=txt;new.source_sha256:=encode(sha256(convert_to(txt,'UTF8')),'hex');return new;
end $$;
create trigger zzz_board_source_coverage180 before insert on public.board_request_sources for each row execute function controller_security.coverage180_select();
create trigger zzz_statutory_source_coverage180 before insert on public.statutory_request_sources for each row execute function controller_security.coverage180_select();

create function public.request_clarified_board_report(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_engagement_id uuid,p_assessment_run_id uuid,p_title text,p_correlation_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare result jsonb;prior text:=current_setting('axiom.report_presentation',true);prior_coverage text:=current_setting('axiom.report_coverage_review',true);src public.board_request_sources;
begin
 perform set_config('axiom.report_presentation','axiom-report-brand-1',true);perform set_config('axiom.report_coverage_review','owner-coverage-1',true);
 result:=public.request_board_report(p_tenant_id,p_actor_id,p_operation_key,p_engagement_id,p_assessment_run_id,p_title,p_correlation_id);
 perform set_config('axiom.report_presentation',coalesce(prior,''),true);perform set_config('axiom.report_coverage_review',coalesce(prior_coverage,''),true);
 if result?'error'then return result;end if;
 select *into src from public.board_request_sources where tenant_id=p_tenant_id and request_id=(result->>'requestId')::uuid;
 if src.request_id is null or(src.source_text::jsonb)->'schema_version'is distinct from'8'::jsonb then return jsonb_build_object('error','idempotency_conflict');end if;
 perform controller_security.coverage180_inner('board',src.source_text,src.source_sha256);return result;
exception when others then
 perform set_config('axiom.report_presentation',coalesce(prior,''),true);perform set_config('axiom.report_coverage_review',coalesce(prior_coverage,''),true);
 if sqlstate='22023' and sqlerrm='owner coverage explanation required' then return jsonb_build_object('error','owner_coverage_explanation_required');end if;raise;
end $$;
revoke all on function public.request_clarified_board_report(uuid,uuid,uuid,uuid,uuid,text,uuid)from public,anon,authenticated,service_role,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.request_clarified_board_report(uuid,uuid,uuid,uuid,uuid,text,uuid)to human_action_writer;

create function public.request_clarified_auditor_report(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_engagement_id uuid,p_assessment_run_id uuid,p_title text,p_correlation_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare result jsonb;prior text:=current_setting('axiom.report_presentation',true);prior_coverage text:=current_setting('axiom.report_coverage_review',true);src public.statutory_request_sources;
begin
 perform set_config('axiom.report_presentation','axiom-report-brand-1',true);perform set_config('axiom.report_coverage_review','owner-coverage-1',true);
 result:=public.request_statutory_report(p_tenant_id,p_actor_id,p_operation_key,p_engagement_id,p_assessment_run_id,'auditor',p_title,p_correlation_id);
 perform set_config('axiom.report_presentation',coalesce(prior,''),true);perform set_config('axiom.report_coverage_review',coalesce(prior_coverage,''),true);
 if result?'error'then return result;end if;
 select *into src from public.statutory_request_sources where tenant_id=p_tenant_id and request_id=(result->>'requestId')::uuid;
 if src.request_id is null or(src.source_text::jsonb)->'schema_version'is distinct from'8'::jsonb then return jsonb_build_object('error','idempotency_conflict');end if;
 perform controller_security.coverage180_inner('auditor',src.source_text,src.source_sha256);return result;
exception when others then
 perform set_config('axiom.report_presentation',coalesce(prior,''),true);perform set_config('axiom.report_coverage_review',coalesce(prior_coverage,''),true);
 if sqlstate='22023' and sqlerrm='owner coverage explanation required' then return jsonb_build_object('error','owner_coverage_explanation_required');end if;raise;
end $$;
revoke all on function public.request_clarified_auditor_report(uuid,uuid,uuid,uuid,uuid,text,uuid)from public,anon,authenticated,service_role,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.request_clarified_auditor_report(uuid,uuid,uuid,uuid,uuid,text,uuid)to human_action_writer;

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
  if v_source.source_text::jsonb->'schema_version'='8'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.coverage180_document('board',v_source.source_text,v_source.source_sha256,
         p_tenant_id,v_req.engagement_id,v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then return jsonb_build_object('error','assessment_source_conflict');end;
  elsif v_source.source_text::jsonb->'schema_version'='6'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.brand177_document('board',v_source.source_text,v_source.source_sha256,
         p_tenant_id,v_req.engagement_id,v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then return jsonb_build_object('error','assessment_source_conflict');end;
  elsif v_source.source_text::jsonb->'schema_version'='4'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.coverage144_document('board',
         v_source.source_text,v_source.source_sha256,p_tenant_id,v_req.engagement_id,
         v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then
      return jsonb_build_object('error','assessment_source_conflict');
    end;
  elsif v_source.source_text::jsonb->'schema_version'='5'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.questionnaire155_document('board',
         v_source.source_text,v_source.source_sha256,p_tenant_id,v_req.engagement_id,
         v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then
      return jsonb_build_object('error','assessment_source_conflict');
    end;
  elsif v_source.source_text::jsonb->>'schema_version' in ('2','3') then
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
  elsif v_content->'schema_version' in ('3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb,'7'::jsonb,'8'::jsonb) or v_content?'public_review_appendix' or v_content?'asset_scope' then
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
  if v_source.source_text::jsonb->'schema_version'='8'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.coverage180_document('auditor',v_source.source_text,v_source.source_sha256,
         p_tenant_id,v_req.engagement_id,v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then return jsonb_build_object('error','assessment_source_conflict');end;
  elsif v_source.source_text::jsonb->'schema_version'='6'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.brand177_document('auditor',v_source.source_text,v_source.source_sha256,
         p_tenant_id,v_req.engagement_id,v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then return jsonb_build_object('error','assessment_source_conflict');end;
  elsif v_source.source_text::jsonb->'schema_version'='4'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.coverage144_document('auditor',
         v_source.source_text,v_source.source_sha256,p_tenant_id,v_req.engagement_id,
         v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then
      return jsonb_build_object('error','assessment_source_conflict');
    end;
  elsif v_source.source_text::jsonb->'schema_version'='5'::jsonb then
    begin
      if octet_length(p_content_text)>4194304 or not controller_security.coverage144_unique(p_content_text::json,0)
       or v_content is distinct from controller_security.questionnaire155_document('auditor',
         v_source.source_text,v_source.source_sha256,p_tenant_id,v_req.engagement_id,
         v_req.assessment_run_id,v_req.id,v_req.title,v_content->>'generated_at')
       or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
       or v_content->>'library_digest' is distinct from v_req.library_digest
      then return jsonb_build_object('error','assessment_source_conflict');end if;
    exception when data_exception or check_violation then
      return jsonb_build_object('error','assessment_source_conflict');
    end;
  else
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

create or replace function public.begin_board_artifact_build(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,
 p_operation_key uuid,p_request jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports; req public.board_report_requests; src public.board_request_sources;
 a public.board_report_artifacts; rev public.report_reviews; b public.board_artifact_builds;
 item jsonb; kind text; expected_key text; n bigint; idx integer;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_report_id is null or p_operation_key is null or p_correlation_id is null or p_request is null
  or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>16384
  or not(p_request ?& array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])
  or (p_request-array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])<>'{}'::jsonb
  or p_request->'legal_hold' is distinct from 'false'::jsonb
  or p_request->>'provider' not in ('s3','s3-compatible') or jsonb_typeof(p_request->'provider')<>'string'
  or jsonb_typeof(p_request->'bucket')<>'string' or length(p_request->>'bucket') not between 3 and 255
  or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
  or p_request->>'retention_policy'<>'seven_years' or jsonb_typeof(p_request->'retention_policy')<>'string'
  or jsonb_typeof(p_request->'renderer_version')<>'string'
  or length(coalesce(p_request->>'renderer_version','')) not between 1 and 200
  or jsonb_typeof(p_request->'artifacts')<>'array' or jsonb_array_length(p_request->'artifacts')<>2
  or p_request->>'source_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'content_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'review_sha256' !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found or r.kind<>'board' or r.generated_by_agent<>'board-report-builder' then return jsonb_build_object('error','report_not_found'); end if;
 select * into req from public.board_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.board_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into a from public.board_report_artifacts where tenant_id=p_tenant_id and report_id=r.id;
 select * into rev from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if req.id is null or src.request_id is null or a.id is null or req.operation_key is distinct from r.operation_key
  or req.engagement_id is distinct from r.engagement_id or req.title is distinct from r.title
  or r.content->>'source_sha256' is distinct from src.source_sha256
  or r.content->>'assessment_run_id' is distinct from req.assessment_run_id::text
  or r.content->>'assessment_result_digest' is distinct from req.assessment_result_digest
  or r.content->>'library_digest' is distinct from req.library_digest
  or a.source_json_sha256 is distinct from src.source_sha256
  or a.source_json_bytes is distinct from octet_length(src.source_text)
  or src.source_sha256 is distinct from encode(sha256(convert_to(src.source_text,'UTF8')),'hex')
  then return jsonb_build_object('error','assessment_source_conflict'); end if;
 if (src.source_text::jsonb->'schema_version'='8'::jsonb) is distinct from (p_request->>'renderer_version'='chromium-board-clarified-v8') then return jsonb_build_object('error','renderer_version_conflict');end if;
 if src.source_text::jsonb->'schema_version'='8'::jsonb then
  if r.content->'schema_version' is distinct from '8'::jsonb or p_request->>'renderer_version' is distinct from 'chromium-board-clarified-v8'
   or r.content is distinct from controller_security.coverage180_document('board',src.source_text,src.source_sha256,p_tenant_id,req.engagement_id,req.assessment_run_id,req.id,req.title,r.content->>'generated_at')
  then return jsonb_build_object('error','renderer_version_conflict');end if;
 elsif r.content->'schema_version'='8'::jsonb then return jsonb_build_object('error','renderer_version_conflict');
 elsif src.source_text::jsonb->'schema_version'='6'::jsonb then
  if r.content->'schema_version' is distinct from '7'::jsonb or p_request->>'renderer_version' is distinct from 'chromium-board-brand-v7'
   or r.content is distinct from controller_security.brand177_document('board',src.source_text,src.source_sha256,p_tenant_id,req.engagement_id,req.assessment_run_id,req.id,req.title,r.content->>'generated_at')
  then return jsonb_build_object('error','renderer_version_conflict');end if;
 elsif r.content->'schema_version'='7'::jsonb then return jsonb_build_object('error','renderer_version_conflict');
 else
 -- Old renderer strings remain accepted exactly as before. New source4 is pinned.
 if src.source_text::jsonb->'schema_version'='4'::jsonb and
   (r.content->'schema_version' is distinct from '5'::jsonb or
    p_request->>'renderer_version' is distinct from 'chromium-board-evidence-v5')
 then return jsonb_build_object('error','renderer_version_conflict');end if;
 -- New source5 is pinned to document6 and its renderer; document6 never
 -- renders under any other source.
 if (src.source_text::jsonb->'schema_version'='5'::jsonb) is distinct from (r.content->'schema_version'='6'::jsonb)
   or (src.source_text::jsonb->'schema_version'='5'::jsonb and
       p_request->>'renderer_version' is distinct from 'chromium-board-questionnaire-evidence-v6')
 then return jsonb_build_object('error','renderer_version_conflict');end if;
 end if;
 if r.status not in ('approved','published') or rev.id is null or rev.decision<>'approved'
  or rev.content_sha256 is distinct from r.content_sha256
  or r.reviewed_content_hash is distinct from r.content_sha256
  or rev.review_sha256 is distinct from encode(sha256(convert_to(rev.review_text,'UTF8')),'hex')
  then return jsonb_build_object('error','not_approved'); end if;
 if p_request->>'source_sha256' is distinct from src.source_sha256
  or p_request->>'content_sha256' is distinct from r.content_sha256
  or p_request->>'review_sha256' is distinct from rev.review_sha256
  then return jsonb_build_object('error','manifest_changed'); end if;
 for idx in 0..1 loop
  item:=p_request->'artifacts'->idx;
  kind:=case idx when 0 then 'source_json' else 'board_pdf' end;
  if jsonb_typeof(item)<>'object' or not(item ?& array['kind','mime_type','content_hash','byte_size','object_key'])
    or (item-array['kind','mime_type','content_hash','byte_size','object_key'])<>'{}'::jsonb
    or item->>'kind' is distinct from kind
    or item->>'mime_type' is distinct from (case idx when 0 then 'application/json' else 'application/pdf' end)
    or jsonb_typeof(item->'content_hash')<>'string' or item->>'content_hash' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(item->'byte_size')<>'number' or item->>'byte_size' !~ '^[0-9]+$'
    or jsonb_typeof(item->'object_key')<>'string' then return jsonb_build_object('error','invalid_request'); end if;
  begin n:=(item->>'byte_size')::bigint; exception when numeric_value_out_of_range then return jsonb_build_object('error','invalid_request'); end;
  if (idx=0 and (n<>octet_length(src.source_text) or item->>'content_hash' is distinct from src.source_sha256))
    or (idx=1 and n not between 1 and 33554432) then return jsonb_build_object('error','manifest_changed'); end if;
  expected_key:='tenants/'||p_tenant_id::text||'/reports/'||r.id::text||'/'||p_operation_key::text||'/'||kind||'/'||(item->>'content_hash');
  if item->>'object_key' is distinct from expected_key then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 select * into b from public.board_artifact_builds where tenant_id=p_tenant_id and report_id=r.id for update;
 if found then
  if b.operation_key is distinct from p_operation_key or b.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
   'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',true);
 end if;
 if r.status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 if exists(select 1 from public.board_artifact_builds where tenant_id=p_tenant_id and operation_key=p_operation_key)
  then return jsonb_build_object('error','idempotency_conflict'); end if;
 insert into public.board_artifact_builds(tenant_id,report_id,operation_key,actor_id,review_id,source_sha256,
  content_sha256,review_sha256,request,retain_until,correlation_id)
 values(p_tenant_id,r.id,p_operation_key,p_actor_id,rev.id,src.source_sha256,r.content_sha256,rev.review_sha256,
  p_request,date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id) returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifacts.started'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'source_sha256',b.source_sha256,'pdf_sha256',p_request#>>'{artifacts,1,content_hash}','review_id',rev.id));
 return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
  'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',false);
end $$;

create or replace function public.begin_statutory_artifact_build(p_tenant_id uuid,p_actor_id uuid,p_report_id uuid,
 p_operation_key uuid,p_request jsonb,p_correlation_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.reports; req public.statutory_report_requests; src public.statutory_request_sources;
 a public.statutory_report_artifacts; rev public.report_reviews; b public.statutory_artifact_builds;
 item jsonb; kind text; expected_key text; n bigint; idx integer;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_report_id is null or p_operation_key is null or p_correlation_id is null or p_request is null
  or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>16384
  or not(p_request ?& array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])
  or (p_request-array['provider','bucket','retention_policy','legal_hold','source_sha256','content_sha256','review_sha256','renderer_version','artifacts'])<>'{}'::jsonb
  or p_request->'legal_hold' is distinct from 'false'::jsonb
  or p_request->>'provider' not in ('s3','s3-compatible') or jsonb_typeof(p_request->'provider')<>'string'
  or jsonb_typeof(p_request->'bucket')<>'string' or length(p_request->>'bucket') not between 3 and 255
  or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
  or p_request->>'retention_policy'<>'seven_years' or jsonb_typeof(p_request->'retention_policy')<>'string'
  or jsonb_typeof(p_request->'renderer_version')<>'string'
  or length(coalesce(p_request->>'renderer_version','')) not between 1 and 200
  or jsonb_typeof(p_request->'artifacts')<>'array' or jsonb_array_length(p_request->'artifacts')<>2
  or p_request->>'source_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'content_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'review_sha256' !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found or r.kind not in ('auditor') or r.generated_by_agent<>'statutory-report-builder' then return jsonb_build_object('error','report_not_found'); end if;
 select * into req from public.statutory_report_requests where tenant_id=p_tenant_id and report_id=r.id;
 select * into src from public.statutory_request_sources where tenant_id=p_tenant_id and request_id=req.id;
 select * into a from public.statutory_report_artifacts where tenant_id=p_tenant_id and report_id=r.id;
 select * into rev from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if req.id is null or src.request_id is null or a.id is null or req.operation_key is distinct from r.operation_key
  or req.engagement_id is distinct from r.engagement_id or req.title is distinct from r.title or req.kind is distinct from r.kind
  or r.content->>'source_sha256' is distinct from src.source_sha256
  or r.content->>'assessment_run_id' is distinct from req.assessment_run_id::text
  or r.content->>'assessment_result_digest' is distinct from req.assessment_result_digest
  or r.content->>'library_digest' is distinct from req.library_digest
  or a.source_json_sha256 is distinct from src.source_sha256
  or a.source_json_bytes is distinct from octet_length(src.source_text)
  or src.source_sha256 is distinct from encode(sha256(convert_to(src.source_text,'UTF8')),'hex')
  then return jsonb_build_object('error','assessment_source_conflict'); end if;
 if (src.source_text::jsonb->'schema_version'='8'::jsonb) is distinct from (p_request->>'renderer_version'='chromium-auditor-clarified-v8') then return jsonb_build_object('error','renderer_version_conflict');end if;
 if src.source_text::jsonb->'schema_version'='8'::jsonb then
  if r.content->'schema_version' is distinct from '8'::jsonb or p_request->>'renderer_version' is distinct from 'chromium-auditor-clarified-v8'
   or r.content is distinct from controller_security.coverage180_document('auditor',src.source_text,src.source_sha256,p_tenant_id,req.engagement_id,req.assessment_run_id,req.id,req.title,r.content->>'generated_at')
  then return jsonb_build_object('error','renderer_version_conflict');end if;
 elsif r.content->'schema_version'='8'::jsonb then return jsonb_build_object('error','renderer_version_conflict');
 elsif src.source_text::jsonb->'schema_version'='6'::jsonb then
  if r.content->'schema_version' is distinct from '7'::jsonb or p_request->>'renderer_version' is distinct from 'chromium-auditor-brand-v7'
   or r.content is distinct from controller_security.brand177_document('auditor',src.source_text,src.source_sha256,p_tenant_id,req.engagement_id,req.assessment_run_id,req.id,req.title,r.content->>'generated_at')
  then return jsonb_build_object('error','renderer_version_conflict');end if;
 elsif r.content->'schema_version'='7'::jsonb then return jsonb_build_object('error','renderer_version_conflict');
 else
 -- Old renderer strings remain accepted exactly as before. New source4 is pinned.
 if src.source_text::jsonb->'schema_version'='4'::jsonb and
   (r.content->'schema_version' is distinct from '5'::jsonb or
    p_request->>'renderer_version' is distinct from 'chromium-auditor-evidence-v5')
 then return jsonb_build_object('error','renderer_version_conflict');end if;
 -- New source5 is pinned to document6 and its renderer; document6 never
 -- renders under any other source.
 if (src.source_text::jsonb->'schema_version'='5'::jsonb) is distinct from (r.content->'schema_version'='6'::jsonb)
   or (src.source_text::jsonb->'schema_version'='5'::jsonb and
       p_request->>'renderer_version' is distinct from 'chromium-auditor-questionnaire-evidence-v6')
 then return jsonb_build_object('error','renderer_version_conflict');end if;
 end if;
 if r.status not in ('approved','published') or rev.id is null or rev.decision<>'approved'
  or rev.content_sha256 is distinct from r.content_sha256
  or r.reviewed_content_hash is distinct from r.content_sha256
  or rev.review_sha256 is distinct from encode(sha256(convert_to(rev.review_text,'UTF8')),'hex')
  then return jsonb_build_object('error','not_approved'); end if;
 if p_request->>'source_sha256' is distinct from src.source_sha256
  or p_request->>'content_sha256' is distinct from r.content_sha256
  or p_request->>'review_sha256' is distinct from rev.review_sha256
  then return jsonb_build_object('error','manifest_changed'); end if;
 for idx in 0..1 loop
  item:=p_request->'artifacts'->idx;
  kind:=case idx when 0 then 'source_json' else 'statutory_pdf' end;
  if jsonb_typeof(item)<>'object' or not(item ?& array['kind','mime_type','content_hash','byte_size','object_key'])
    or (item-array['kind','mime_type','content_hash','byte_size','object_key'])<>'{}'::jsonb
    or item->>'kind' is distinct from kind
    or item->>'mime_type' is distinct from (case idx when 0 then 'application/json' else 'application/pdf' end)
    or jsonb_typeof(item->'content_hash')<>'string' or item->>'content_hash' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(item->'byte_size')<>'number' or item->>'byte_size' !~ '^[0-9]+$'
    or jsonb_typeof(item->'object_key')<>'string' then return jsonb_build_object('error','invalid_request'); end if;
  begin n:=(item->>'byte_size')::bigint; exception when numeric_value_out_of_range then return jsonb_build_object('error','invalid_request'); end;
  if (idx=0 and (n<>octet_length(src.source_text) or item->>'content_hash' is distinct from src.source_sha256))
    or (idx=1 and n not between 1 and 33554432) then return jsonb_build_object('error','manifest_changed'); end if;
  expected_key:='tenants/'||p_tenant_id::text||'/reports/'||r.id::text||'/'||p_operation_key::text||'/'||kind||'/'||(item->>'content_hash');
  if item->>'object_key' is distinct from expected_key then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 select * into b from public.statutory_artifact_builds where tenant_id=p_tenant_id and report_id=r.id for update;
 if found then
  if b.operation_key is distinct from p_operation_key or b.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
   'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',true);
 end if;
 if r.status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 if exists(select 1 from public.statutory_artifact_builds where tenant_id=p_tenant_id and operation_key=p_operation_key)
  then return jsonb_build_object('error','idempotency_conflict'); end if;
 insert into public.statutory_artifact_builds(tenant_id,report_id,operation_key,actor_id,review_id,source_sha256,
  content_sha256,review_sha256,request,retain_until,correlation_id)
 values(p_tenant_id,r.id,p_operation_key,p_actor_id,rev.id,src.source_sha256,r.content_sha256,rev.review_sha256,
  p_request,date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id) returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'report.artifacts.started'::public.ledger_action_type,r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('build_id',b.id,'source_sha256',b.source_sha256,'pdf_sha256',p_request#>>'{artifacts,1,content_hash}','review_id',rev.id));
 return jsonb_build_object('buildId',b.id,'reportId',r.id,'operationKey',b.operation_key,'status',b.status,
  'request',b.request,'retainUntil',b.retain_until,'correlationId',b.correlation_id,'replayed',false);
end $$;
revoke all on function controller_security.coverage180_inner(text,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
revoke all on function controller_security.coverage180_document(text,text,text,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
revoke all on function controller_security.coverage180_select() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
-- Retired creation entrypoints stay callable only by their owning SQL wrappers.
-- New human requests cannot bypass owner coverage clarification via an older RPC.
revoke execute on function public.request_board_report(uuid,uuid,uuid,uuid,uuid,text,uuid),
 public.request_statutory_report(uuid,uuid,uuid,uuid,uuid,text,text,uuid),
 public.request_branded_board_report(uuid,uuid,uuid,uuid,uuid,text,uuid),
 public.request_branded_auditor_report(uuid,uuid,uuid,uuid,uuid,text,uuid)
 from public,anon,authenticated,service_role,human_action_writer,statutory_proof_writer,agent_ledger_writer;
commit;
