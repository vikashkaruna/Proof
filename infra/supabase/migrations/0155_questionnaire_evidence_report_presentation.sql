-- ─────────────────────────────────────────────────────────────────────
-- 0155_questionnaire_evidence_report_presentation.sql
--
-- Owner decision (e438/e439): NEW Board/Auditor requests over a
-- questionnaire-only assessment (source1, no retained public-control review)
-- withhold posture, exposure and score bands. Such a request's frozen source
-- is wrapped as source5 at INSERT, and its draft must be the exact document6
-- recomputed here (parity with @axiom/report-kit questionnaire-evidence-report).
--
-- Historical rows are never rewritten: existing source1-4 requests, drafts,
-- reviews and artifacts keep their original branches, bytes and renderers.
-- The frozen original result stays opaque provenance inside source5.
-- ─────────────────────────────────────────────────────────────────────

create function controller_security.questionnaire155_policy() returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('version',2,'document_version',6,
 'evidence_basis','unverified_questionnaire_declarations','metrics','withheld',
 'reasons',jsonb_build_array('questionnaire_declarations_unverified','independent_evidence_not_verified','applicability_unverified'),
 'review_required',true)
$$;
revoke all on function controller_security.questionnaire155_policy() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;

-- Exactly the source1 shapes the 0144 capture triggers build.
create function controller_security.questionnaire155_original(kind text,txt text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v jsonb;keys text[];
begin
 if kind not in ('board','auditor') or txt is null or octet_length(txt)>4194304
  or not controller_security.coverage144_unique(txt::json,0) then
  raise exception 'questionnaire source refused' using errcode='22023';end if;
 v:=txt::jsonb;
 keys:=array['schema_version','serialization','kind','request_id','tenant_id','engagement_id',
 'assessment_run_id','library_version','controls_text','controls_sha256','result_text','result_sha256',
 'completed_at','finalized_at','receipts','limitations'];
 if kind='auditor' then keys:=keys||array['report_kind'];end if;
 if jsonb_typeof(v) is distinct from 'object' or not(v?&keys) or v-keys<>'{}'::jsonb
  or v->'schema_version' is distinct from '1'::jsonb
  or v->>'serialization' is distinct from 'postgres-jsonb-text-v1'
  or v->>'kind' is distinct from (case kind when 'board' then 'board_source' else 'statutory_source' end)
  or (kind='auditor' and v->>'report_kind' is distinct from 'auditor')
  or jsonb_typeof(v->'receipts'->'finalized') is distinct from 'object'
  or v->>'controls_sha256' is distinct from encode(sha256(convert_to(v->>'controls_text','UTF8')),'hex')
  or v->>'result_sha256' is distinct from encode(sha256(convert_to(v->>'result_text','UTF8')),'hex')
 then raise exception 'questionnaire source refused' using errcode='22023';end if;
 return v;
end $$;
revoke all on function controller_security.questionnaire155_original(text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;

create function controller_security.questionnaire155_wrap(kind text,original_text text) returns text
language plpgsql immutable set search_path='' as $$
declare txt text;
begin
 perform controller_security.questionnaire155_original(kind,original_text);
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object(
 'schema_version',5,'serialization','axiom-questionnaire-evidence-source-canonical-json-1',
 'kind','questionnaire_evidence_report_source','report_kind',kind,
 'presentation_policy',controller_security.questionnaire155_policy(),
 'retained_source',jsonb_build_object('serialization','postgres-jsonb-text-v1',
 'schema_version',1,'text',original_text,
 'sha256',encode(sha256(convert_to(original_text,'UTF8')),'hex'))));
 if octet_length(txt)>4194304 then raise exception 'questionnaire source exceeds byte limit' using errcode='22023';end if;
 return txt;
end $$;
revoke all on function controller_security.questionnaire155_wrap(text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;

create function controller_security.questionnaire155_inner(kind text,txt text,sha text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare e jsonb;
begin
 if txt is null or octet_length(txt)>4194304 or sha is null
  or sha is distinct from encode(sha256(convert_to(txt,'UTF8')),'hex')
  or not controller_security.coverage144_unique(txt::json,0) then
  raise exception 'questionnaire source refused' using errcode='22023';end if;
 e:=txt::jsonb;
 if jsonb_typeof(e) is distinct from 'object'
  or not(e?&array['schema_version','serialization','kind','report_kind','presentation_policy','retained_source'])
  or e-array['schema_version','serialization','kind','report_kind','presentation_policy','retained_source']<>'{}'::jsonb
  or e->'schema_version' is distinct from '5'::jsonb
  or e->>'serialization' is distinct from 'axiom-questionnaire-evidence-source-canonical-json-1'
  or e->>'kind' is distinct from 'questionnaire_evidence_report_source' or e->>'report_kind' is distinct from kind
  or e->'presentation_policy' is distinct from controller_security.questionnaire155_policy()
  or jsonb_typeof(e->'retained_source') is distinct from 'object'
  or not((e->'retained_source')?&array['serialization','schema_version','text','sha256'])
  or (e->'retained_source')-array['serialization','schema_version','text','sha256']<>'{}'::jsonb
  or e->'retained_source'->>'serialization' is distinct from 'postgres-jsonb-text-v1'
  or e->'retained_source'->'schema_version' is distinct from '1'::jsonb
  or e->'retained_source'->>'sha256' is distinct from encode(sha256(convert_to(e->'retained_source'->>'text','UTF8')),'hex')
  or controller_security.canonical_questionnaire_json(e) is distinct from txt
 then raise exception 'questionnaire source refused' using errcode='22023';end if;
 return controller_security.questionnaire155_original(kind,e->'retained_source'->>'text');
end $$;
revoke all on function controller_security.questionnaire155_inner(text,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;

-- document6: every field is a verbatim copy of frozen source or a literal.
create function controller_security.questionnaire155_document(
 kind text,source_text text,source_sha text,t uuid,eid uuid,rid uuid,req uuid,title text,generated text
) returns jsonb language plpgsql immutable set search_path='' as $$
declare v jsonb;result jsonb;p jsonb;c jsonb;d jsonb;rows jsonb:='[]';state text;
 n_unavail integer:=0;n_unknown integer:=0;n_na integer:=0;n_nba integer:=0;n_rec integer:=0;
begin
 v:=controller_security.questionnaire155_inner(kind,source_text,source_sha);
 if v->>'tenant_id' is distinct from t::text or v->>'engagement_id' is distinct from eid::text
  or v->>'assessment_run_id' is distinct from rid::text or v->>'request_id' is distinct from req::text
  or title is null or length(title) not between 1 and 300
  or (select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0)
      from regexp_split_to_table(title,'') as chars(ch))>300 or generated is null
  or generated !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
 then raise exception 'questionnaire document refused' using errcode='22023';end if;
 perform generated::timestamptz;
 result:=(v->>'result_text')::jsonb;
 p:=result->'questionnaire_provenance';
 if jsonb_typeof(p) is distinct from 'object' then p:=null;end if;
 for c in select item from jsonb_array_elements((v->>'controls_text')::jsonb) with ordinality x(item,n) order by n loop
  d:=null;
  if p is not null then
   select item into d from jsonb_array_elements(p->'controls') y(item) where item->>'control_id'=c->>'id';
   if d is null then raise exception 'questionnaire document refused' using errcode='22023';end if;
  end if;
  state:=case
   when d is null then 'provenance_unavailable'
   when d->>'applicability_state'='caller_declared_not_applicable_unverified' then 'declared_not_applicable_unverified'
   when d->>'applicability_state'='unknown' or d->>'answer_state' in ('unknown','partially_answered') then 'unknown'
   when d->>'answer_state'='not_boolean_assessable' then 'not_boolean_assessable'
   else 'declarations_recorded_unverified' end;
  case state
   when 'provenance_unavailable' then n_unavail:=n_unavail+1;
   when 'unknown' then n_unknown:=n_unknown+1;
   when 'declared_not_applicable_unverified' then n_na:=n_na+1;
   when 'not_boolean_assessable' then n_nba:=n_nba+1;
   else n_rec:=n_rec+1;
  end case;
  rows:=rows||jsonb_build_array(jsonb_build_object('controlId',c->'id','title',c->'title','domain',c->'domain',
   'state',state,'answerState',coalesce(d->'answer_state','null'::jsonb),
   'applicabilityState',coalesce(d->'applicability_state','null'::jsonb),
   'answerCounts',case when d is null then 'null'::jsonb else jsonb_build_object(
     'known',d->'known_boolean_question_count','affirmed',d->'caller_affirmed_count',
     'denied',d->'caller_denied_count','unknown',d->'unknown_count') end,
   'evidenceNeeded',case state
     when 'provenance_unavailable' then 'Questionnaire provenance is unavailable; review the source questionnaire and applicability.'
     when 'unknown' then 'Answer the open questionnaire declarations and confirm applicability, then provide supporting evidence.'
     when 'declared_not_applicable_unverified' then 'Provide evidence supporting the declaration that this control does not apply.'
     when 'not_boolean_assessable' then 'Collect supporting evidence; this control has no questionnaire declaration to record.'
     else 'Provide evidence supporting the recorded declarations; they are not verified.' end));
 end loop;
 return jsonb_build_object('schema_version',6,'kind',case kind when 'board' then 'board_report' else 'auditor_pack' end,
 'request_id',req,'tenant_id',t,'engagement_id',eid,'assessment_run_id',rid,'title',title,'generated_at',generated,
 'source_sha256',source_sha,'retained_source_sha256',encode(sha256(convert_to((source_text::jsonb)->'retained_source'->>'text','UTF8')),'hex'),
 'assessment_result_digest',v->'result_sha256','library_digest',v->'controls_sha256',
 'presentation_policy',controller_security.questionnaire155_policy(),
 'metrics',jsonb_build_object('state','withheld','compliance_conclusion','not_determined'),
 'questionnaire',jsonb_build_object('provenance',case when p is null then 'unavailable' else 'caller_declared_unverified' end,
   'libraryVersion',v->'library_version'),
 'applicability',case when p is null then 'null'::jsonb else jsonb_build_object(
   'sdfSelfAttested',p->'applicability'->'sdf_self_attested'->'value',
   'processesChildren',p->'applicability'->'processes_children'->'value',
   'processesHealth',p->'applicability'->'processes_health'->'value') end,
 'summary',jsonb_build_object('controls',jsonb_array_length(rows),'provenanceUnavailable',n_unavail,
   'unknown',n_unknown,'declaredNotApplicable',n_na,'notBooleanAssessable',n_nba,'declarationsRecorded',n_rec),
 'controls',rows,
 'provenance',jsonb_build_object('finalizedAt',v->'finalized_at',
   'finalizedReceipt',jsonb_build_object('id',v->'receipts'->'finalized'->'id','entry_hash',v->'receipts'->'finalized'->'entry_hash')),
 'declarationsVerified',false,'evidenceVerified',false,'humanReviewRequired',true);
end $$;
revoke all on function controller_security.questionnaire155_document(text,text,text,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;

-- Selection at NEW source INSERT only. A questionnaire-only source1 (the
-- capture triggers already wrapped reviewed public sources as source4) becomes
-- source5. UPDATE is not touched; existing rows keep their bytes.
create function controller_security.questionnaire155_select_board() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.source_text::jsonb)->'schema_version'='1'::jsonb then
  new.source_text:=controller_security.questionnaire155_wrap('board',new.source_text);
  new.source_sha256:=encode(sha256(convert_to(new.source_text,'UTF8')),'hex');
 end if;
 return new;
end $$;
revoke all on function controller_security.questionnaire155_select_board() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create trigger board_request_sources_questionnaire155
 before insert on public.board_request_sources
 for each row execute function controller_security.questionnaire155_select_board();

create function controller_security.questionnaire155_select_auditor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.source_text::jsonb)->'schema_version'='1'::jsonb
    and (new.source_text::jsonb)->>'report_kind'='auditor' then
  new.source_text:=controller_security.questionnaire155_wrap('auditor',new.source_text);
  new.source_sha256:=encode(sha256(convert_to(new.source_text,'UTF8')),'hex');
 end if;
 return new;
end $$;
revoke all on function controller_security.questionnaire155_select_auditor() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create trigger statutory_request_sources_questionnaire155
 before insert on public.statutory_request_sources
 for each row execute function controller_security.questionnaire155_select_auditor();

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
  if v_source.source_text::jsonb->'schema_version'='4'::jsonb then
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
  elsif v_content->'schema_version' in ('3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb) or v_content?'public_review_appendix' or v_content?'asset_scope' then
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
  if v_source.source_text::jsonb->'schema_version'='4'::jsonb then
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
