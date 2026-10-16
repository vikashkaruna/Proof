-- Disposable current-policy suite. Prepared through report-policy-phases.py; requires144.
-- This fixture is SQL-only synthetic finalized data. NormalAuth/controller/provider acceptance is separate.
-- No retained state, no ledger deletion, no history rewriting, no live credentials.
-- @coverage144_setup
-- @coverage144_parity
select pg_temp.ok((select count(*)=4 from coverage144_parity_fixture),'exact four production TS parity fixtures');
create temporary table coverage144_sources as
 select 'board'::text kind,s.source_text,s.source_sha256,r.id request_id,r.title,r.assessment_run_id
 from public.board_request_sources s join public.board_report_requests r on r.id=s.request_id and r.tenant_id=s.tenant_id
 where r.id=((select value from board_requested)->>'requestId')::uuid
 union all
 select 'auditor',s.source_text,s.source_sha256,r.id,r.title,r.assessment_run_id
 from public.statutory_request_sources s join public.statutory_report_requests r on r.id=s.request_id and r.tenant_id=s.tenant_id
 where r.id=((select value from auditor_requested)->>'requestId')::uuid;
select pg_temp.ok((select count(*)=2 and bool_and(source_text::jsonb->'schema_version'='4'::jsonb) from coverage144_sources),'new public requests freeze4');
select pg_temp.ok((select bool_and(source_text::jsonb->'presentation_policy'=controller_security.coverage144_policy()) from coverage144_sources),'fixed policy server owned');
select pg_temp.ok((select bool_and((source_text::jsonb)->'retained_source'->'schema_version'='3'::jsonb) from coverage144_sources),'exact source3 retained inside4');
select pg_temp.ok((select bool_and(source_sha256=encode(sha256(convert_to(source_text,'UTF8')),'hex')) from coverage144_sources),'policy bound by full envelope SHA');
do $$declare f jsonb;s text;doc jsonb;
begin
 for f in select value from coverage144_parity_fixture loop
  s:=controller_security.coverage144_wrap(f->>'kind',f->>'originalText');
  perform pg_temp.ok(s=f->>'sourceText','actual SQL/TS canonical source4 byte parity');
  doc:=controller_security.coverage144_document(f->>'kind',s,f->>'sourceSha256',
   (f->'input'->>'tenantId')::uuid,(f->'input'->>'engagementId')::uuid,
   (f->'input'->>'assessmentRunId')::uuid,(f->'input'->>'requestId')::uuid,
   f->'input'->>'title',f->'input'->>'generatedAt');
  perform pg_temp.ok(doc=f->'document','actual SQL/TS complete document5 projection parity');
 end loop;
end $$;
-- Same UTF-16 title limit as the immutable TypeScript document5 contract.
do $$declare f jsonb;s text;rejected boolean;
begin
 select value into f from coverage144_parity_fixture limit 1;s:=f->>'sourceText';
 perform pg_temp.ok(controller_security.coverage144_document(f->>'kind',s,f->>'sourceSha256',
  (f->'input'->>'tenantId')::uuid,(f->'input'->>'engagementId')::uuid,
  (f->'input'->>'assessmentRunId')::uuid,(f->'input'->>'requestId')::uuid,
  repeat(chr(128512),150),f->'input'->>'generatedAt')->>'title'=repeat(chr(128512),150),
  '300 UTF16 units accepted without changing title bytes');
 rejected:=false;
 begin
  perform controller_security.coverage144_document(f->>'kind',s,f->>'sourceSha256',
   (f->'input'->>'tenantId')::uuid,(f->'input'->>'engagementId')::uuid,
   (f->'input'->>'assessmentRunId')::uuid,(f->'input'->>'requestId')::uuid,
   repeat(chr(128512),151),f->'input'->>'generatedAt');
 exception when invalid_parameter_value then rejected:=true;end;
 perform pg_temp.ok(rejected,'302 UTF16 units refused despite only151 Unicode scalars');
end $$;
create function pg_temp.refuse144_source(kind text,txt text) returns void language plpgsql as $$
declare refused boolean:=false;
begin
 begin
  perform controller_security.coverage144_inner(kind,txt,encode(sha256(convert_to(txt,'UTF8')),'hex'));
 exception when data_exception or check_violation then refused:=true;end;
 perform pg_temp.ok(refused,'strict canonical source4 refusal');
end $$;
do $$declare f jsonb;e jsonb;
begin
 select value into f from coverage144_parity_fixture limit 1;e:=(f->>'sourceText')::jsonb;
 perform pg_temp.refuse144_source(f->>'kind',(e||jsonb_build_object('unexpected',true))::text);
 perform pg_temp.refuse144_source(f->>'kind',controller_security.canonical_questionnaire_json(jsonb_set(e,'{presentation_policy,metrics}','"published"')));
 perform pg_temp.refuse144_source(f->>'kind',controller_security.canonical_questionnaire_json(jsonb_set(e,'{presentation_policy,reasons}','[]')));
 perform pg_temp.refuse144_source(f->>'kind',controller_security.canonical_questionnaire_json(jsonb_set(e,'{retained_source,sha256}',to_jsonb(repeat('f',64)))));
 perform pg_temp.refuse144_source(f->>'kind',controller_security.canonical_questionnaire_json(jsonb_set(e,'{retained_source,schema_version}','3')));
 perform pg_temp.refuse144_source(f->>'kind',replace(f->>'sourceText','"schema_version":4','"schema_version":4,"schema_version":4'));
end $$;
create function pg_temp.doc(kind text) returns jsonb language sql stable as $$
 select controller_security.coverage144_document($1,s.source_text,s.source_sha256,
  pg_temp.id(31),pg_temp.id(41),s.assessment_run_id,s.request_id,s.title,'2026-10-16T12:34:56.123456Z')
 from coverage144_sources s where s.kind=$1
$$;
create function pg_temp.draft(p_kind text,body text) returns jsonb language plpgsql as $$
declare s record;
begin
 select * into s from coverage144_sources x where x.kind=p_kind;
 if p_kind='board' then return public.record_board_report_draft(pg_temp.id(31),pg_temp.id(1),s.request_id,body,'<p>Unpublished synthetic doc5; not a real rendered PDF.</p>',gen_random_uuid());end if;
 return public.record_source_bound_statutory_draft(pg_temp.id(31),pg_temp.id(1),s.request_id,body,'<p>Unpublished synthetic doc5; not a real rendered PDF.</p>',gen_random_uuid());
end $$;
create function pg_temp.refuse_doc(kind text,doc text) returns void language plpgsql as $$
declare nr bigint;nl bigint;r jsonb;
begin
 select count(*) into nr from public.reports;select count(*) into nl from public.audit_ledger;
 r:=pg_temp.draft(kind,doc);
 perform pg_temp.ok(r->>'error'='assessment_source_conflict','strict source4/document5 refusal');
 perform pg_temp.ok((select count(*)=nr from public.reports),'refusal writes zero reports');
 perform pg_temp.ok((select count(*)=nl from public.audit_ledger),'refusal writes zero ledger rows');
end $$;
do $$declare k text;d jsonb;
begin
 foreach k in array array['board','auditor'] loop
  d:=pg_temp.doc(k);
  perform pg_temp.refuse_doc(k,(d||jsonb_build_object('posture_score',100))::text);
  perform pg_temp.refuse_doc(k,(d||jsonb_build_object('estimated_exposure_inr',584400000))::text);
  perform pg_temp.refuse_doc(k,(d||jsonb_build_object('unknown_field','no authority'))::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{schema_version}','4')::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{metrics,state}','"published"')::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{presentation_policy,reasons}','[]')::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{source_sha256}',to_jsonb(repeat('f',64)))::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{assessment_result_digest}',to_jsonb(repeat('f',64)))::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{library_digest}',to_jsonb(repeat('f',64)))::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{tenant_id}',to_jsonb(pg_temp.id(32)::text))::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{summary,controls}','0')::text);
  perform pg_temp.refuse_doc(k,jsonb_set(d,'{controls,0,questions,0,state}','"human_yes_unverified"')::text);
  perform pg_temp.refuse_doc(k,replace(d::text,'"schema_version": 5','"schema_version": 5, "schema_version": 5'));
 end loop;
end $$;
-- Atomic receipt failure must roll back report/artifact/request changes together.
create function pg_temp.fail144_receipt() returns trigger language plpgsql as $$
begin
 if new.tenant_id=pg_temp.id(31) and new.action_type::text='report.drafted' then
  raise exception 'synthetic144 receipt failure' using errcode='ZX144';end if;
 return new;
end $$;
create trigger synthetic144_receipt_failure before insert on public.audit_ledger for each row execute function pg_temp.fail144_receipt();
do $$declare nr bigint;nl bigint;
begin
 select count(*) into nr from public.reports;select count(*) into nl from public.audit_ledger;
 begin
  perform pg_temp.draft('board',pg_temp.doc('board')::text);
  raise exception 'ASSERTION: receipt failure not observed';
 exception when sqlstate 'ZX144' then null;end;
 perform pg_temp.ok((select count(*)=nr from public.reports),'receipt failure rolls back report');
 perform pg_temp.ok((select count(*)=nl from public.audit_ledger),'receipt failure rolls back ledger');
 perform pg_temp.ok((select report_id is null and status='requested' from public.board_report_requests where id=(select request_id from coverage144_sources where kind='board')),'receipt failure rolls back request');
end $$;
drop trigger synthetic144_receipt_failure on public.audit_ledger;
create temporary table coverage144_drafted(kind text,report_id uuid);
do $$declare k text;d jsonb;r jsonb;report public.reports;
begin
 foreach k in array array['board','auditor'] loop
  d:=pg_temp.doc(k);r:=pg_temp.draft(k,d::text);
  perform pg_temp.ok(r?'reportId','actual new source4/doc5 draft persisted');
  insert into coverage144_drafted values(k,(r->>'reportId')::uuid);
  perform pg_temp.ok(pg_temp.draft(k,d::text)->>'replayed'='true','exact doc5 replay');
  select * into report from public.reports where id=(r->>'reportId')::uuid;
  perform pg_temp.ok(report.content=d and report.content_sha256=encode(sha256(convert_to(d::text,'UTF8')),'hex'),'exact retained document5 text/hash');
  perform pg_temp.ok(public.release_report(pg_temp.id(31),report.id,pg_temp.id(1),report.content_sha256,repeat('a',64),gen_random_uuid())->>'error'='not_approved','new5 not released without human');
  perform pg_temp.ok(public.review_report(pg_temp.id(31),report.id,'approved',null,pg_temp.id(1),report.content_sha256,gen_random_uuid())->>'status'='approved','existing human content review remains');
  perform pg_temp.ok(public.release_report(pg_temp.id(31),report.id,pg_temp.id(1),report.content_sha256,repeat('a',64),gen_random_uuid())->>'error'='report_artifact_unverified','new5 review cannot bypass retained artifact');
 end loop;
end $$;
create function pg_temp.build_request(k text,op uuid,renderer text) returns jsonb language plpgsql stable as $$
declare s record;r public.reports;rev public.report_reviews;items jsonb;
begin
 select * into s from coverage144_sources where kind=k;
 select * into r from public.reports where id=(select report_id from coverage144_drafted where kind=k);
 select * into rev from public.report_reviews where tenant_id=r.tenant_id and report_id=r.id;
 select jsonb_agg(jsonb_build_object('kind',kind,'mime_type',case n when 0 then 'application/json' else 'application/pdf' end,
  'content_hash',hash,'byte_size',case n when 0 then octet_length(s.source_text) else 600 end,
  'object_key','tenants/'||r.tenant_id||'/reports/'||r.id||'/'||op||'/'||kind||'/'||hash) order by n) into items
 from (select 0 n,'source_json' kind,s.source_sha256 hash union all select 1,case k when 'board' then 'board_pdf' else 'statutory_pdf' end,repeat('d',64)) x;
 return jsonb_build_object('provider','s3-compatible','bucket','axiom-fixture-coverage-v5','retention_policy','seven_years',
 'legal_hold',false,'source_sha256',s.source_sha256,'content_sha256',r.content_sha256,'review_sha256',rev.review_sha256,
 'renderer_version',renderer,'artifacts',items);
end $$;
do $$declare k text;rid uuid;op uuid;r jsonb;b jsonb;renderer text;nb bigint;nl bigint;
begin
 foreach k in array array['board','auditor'] loop
  select report_id into rid from coverage144_drafted where kind=k;op:=gen_random_uuid();
  renderer:=case k when 'board' then 'chromium-board-evidence-v5' else 'chromium-auditor-evidence-v5' end;
  b:=pg_temp.build_request(k,op,case k when 'board' then 'chromium-board-v1' else 'chromium-auditor-v1' end);
  select count(*) into nl from public.audit_ledger;
  if k='board' then r:=public.begin_board_artifact_build(pg_temp.id(31),pg_temp.id(1),rid,op,b,gen_random_uuid());
  else r:=public.begin_statutory_artifact_build(pg_temp.id(31),pg_temp.id(1),rid,op,b,gen_random_uuid());end if;
  perform pg_temp.ok(r->>'error'='renderer_version_conflict','source4 rejects old renderer');
  perform pg_temp.ok((select count(*)=nl from public.audit_ledger),'renderer refusal writes zero ledger');
  b:=pg_temp.build_request(k,op,renderer);
  if k='board' then r:=public.begin_board_artifact_build(pg_temp.id(31),pg_temp.id(1),rid,op,b,gen_random_uuid());
  else r:=public.begin_statutory_artifact_build(pg_temp.id(31),pg_temp.id(1),rid,op,b,gen_random_uuid());end if;
  perform pg_temp.ok(r?'buildId','new renderer manifest accepted for existing custody pipeline');
 end loop;
end $$;
-- Private helpers expose no new human/service/agent mutation or read authority.
select pg_temp.ok(not has_function_privilege('human_action_writer','controller_security.coverage144_wrap(text,text)','EXECUTE')
 and not has_function_privilege('service_role','controller_security.coverage144_document(text,text,text,uuid,uuid,uuid,uuid,text,text)','EXECUTE'),'pure helpers private');
select pg_temp.ok(public.request_board_report(pg_temp.id(31),pg_temp.id(1),pg_temp.id(301),pg_temp.id(41),
 ((select value from issued)->>'run_id')::uuid,'Asset-bound board draft',pg_temp.id(302))->>'replayed'='true','same request replays without new source policy choice');
select pg_temp.ok((select bool_and(s.source_text=f.source_text and s.source_sha256=f.source_sha256)
 from public.board_request_sources s join coverage144_sources f on f.request_id=s.request_id where f.kind='board'),'request replay preserves exact source bytes');
rollback;
