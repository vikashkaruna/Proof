-- Pure generator prepends each reviewed questionnaire/public assessment prefix.
-- Real DB authority and lifecycle; synthetic SQL identities, HTML/PDF bytes and
-- owner sessions. No actual MFA, browser capture, provider custody or release.
select pg_temp.ok((select public.confirm_workload_assessment(t,run)->>'status'='succeeded'from clarified180_context),'independently finalized assessment');
create temporary table clarified180_saved(kind text primary key,old_request uuid,old_source text,old_report uuid,old_content text,old_review jsonb,new_request uuid,new_source text,new_sha text,new_report uuid,new_content text);
create function pg_temp.clarified180_denied(q text)returns void language plpgsql as $$begin begin execute q;exception when insufficient_privilege then return;end;raise exception 'ASSERTION: denied SQL succeeded';end$$;
-- Old7 proof is created only by the privileged fixture owner. Application roles
-- cannot call legacy creation functions; existing drafts/approvals remain valid.
do $$declare c record;k text;x jsonb;rid uuid;src text;sha text;d text;report uuid;review jsonb;begin
 select *into c from clarified180_context;
 for k in select unnest(array['board','auditor'])loop
  if k='board'then x:=public.request_branded_board_report(c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Retained original document7',gen_random_uuid());
  else x:=public.request_branded_auditor_report(c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Retained original document7',gen_random_uuid());end if;
  rid:=(x->>'requestId')::uuid;
  if k='board'then select source_text,source_sha256 into src,sha from public.board_request_sources where request_id=rid;
  else select source_text,source_sha256 into src,sha from public.statutory_request_sources where request_id=rid;end if;
  perform pg_temp.ok(src::jsonb->'schema_version'='6'::jsonb,'privileged historical source6 fixture');
  d:=controller_security.canonical_questionnaire_json(controller_security.brand177_document(k,src,sha,c.t,c.eng,c.run,rid,'Retained original document7','2026-10-21T00:00:00.000Z'));
  if k='board'then x:=public.record_board_report_draft(c.t,c.founder,rid,d,'<html>Synthetic7</html>',gen_random_uuid());
  else x:=public.record_source_bound_statutory_draft(c.t,c.founder,rid,d,'<html>Synthetic7</html>',gen_random_uuid());end if;
  report:=(x->>'reportId')::uuid;
  select public.review_report(c.t,report,'approved',null,c.founder,content_sha256,gen_random_uuid())into review from public.reports where id=report;
  perform pg_temp.ok(review->>'status'='approved','old7 genuine immutable approval fixture');
  insert into clarified180_saved(kind,old_request,old_source,old_report,old_content,old_review)values(k,rid,src,report,d,review);
 end loop;
end$$;
-- Human writer can request only through the new scoped wrappers. A claimed old
-- RPC name cannot bypass required owner explanations for a NEW public report.
do $$declare c record;f text;begin select *into c from clarified180_context;
 foreach f in array array['request_board_report','request_branded_board_report','request_branded_auditor_report']loop
  perform pg_temp.ok(not has_function_privilege('human_action_writer','public.'||f||'(uuid,uuid,uuid,uuid,uuid,text,uuid)','execute'),'old request function revoked: '||f);
  perform pg_temp.ok(not has_function_privilege('statutory_proof_writer','public.'||f||'(uuid,uuid,uuid,uuid,uuid,text,uuid)','execute'),'proof writer cannot bypass new owner scope: '||f);
 end loop;
 set local role human_action_writer;
 perform pg_temp.clarified180_denied(format('select public.request_board_report(%L,%L,%L,%L,%L,%L,%L)',c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Denied old RPC bypass',gen_random_uuid()));
 perform pg_temp.clarified180_denied(format('select public.request_branded_board_report(%L,%L,%L,%L,%L,%L,%L)',c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Denied old branded bypass',gen_random_uuid()));
 perform pg_temp.clarified180_denied(format('select public.request_branded_auditor_report(%L,%L,%L,%L,%L,%L,%L)',c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Denied old auditor bypass',gen_random_uuid()));
 perform pg_temp.clarified180_denied(format('select public.request_statutory_report(%L,%L,%L,%L,%L,%L,%L,%L)',c.t,c.manager,gen_random_uuid(),c.eng,c.run,'auditor','Denied old statutory bypass',gen_random_uuid()));
 reset role;
 set local role statutory_proof_writer;
 perform pg_temp.clarified180_denied(format('select public.request_board_report(%L,%L,%L,%L,%L,%L,%L)',c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Denied proof writer bypass',gen_random_uuid()));
 perform pg_temp.clarified180_denied(format('select public.request_statutory_report(%L,%L,%L,%L,%L,%L,%L,%L)',c.t,c.manager,gen_random_uuid(),c.eng,c.run,'auditor','Denied proof writer statutory bypass',gen_random_uuid()));
 reset role;
end$$;
select set_config('axiom.report_presentation','suite-original-presentation',true);
select set_config('axiom.report_coverage_review','suite-original-coverage',true);
-- Missing owner explanation refuses both kinds atomically, restores exact GUCs,
-- and leaves the former approved source/document7 bytes intact.
do $$declare c record;k text;x jsonb;before_state jsonb;after_state jsonb;begin
 select *into c from clarified180_context;
 if c.is_public then
 for k in select unnest(array['board','auditor'])loop
  select jsonb_build_array((select count(*)from public.board_report_requests),(select count(*)from public.statutory_report_requests),(select count(*)from public.board_request_sources),(select count(*)from public.statutory_request_sources),(select count(*)from public.audit_ledger))into before_state;
  set local role human_action_writer;
  if k='board'then x:=public.request_clarified_board_report(c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Public explanation required',gen_random_uuid());
  else x:=public.request_clarified_auditor_report(c.t,c.manager,gen_random_uuid(),c.eng,c.run,'Public explanation required',gen_random_uuid());end if;
  reset role;
  perform pg_temp.ok(x->>'error'='owner_coverage_explanation_required','missing owner explanation refuses actual request: '||k);
  select jsonb_build_array((select count(*)from public.board_report_requests),(select count(*)from public.statutory_report_requests),(select count(*)from public.board_request_sources),(select count(*)from public.statutory_request_sources),(select count(*)from public.audit_ledger))into after_state;
  perform pg_temp.ok(after_state=before_state,'missing explanation rolls back request source and ledger: '||k);
  perform pg_temp.ok(current_setting('axiom.report_presentation')='suite-original-presentation'and current_setting('axiom.report_coverage_review')='suite-original-coverage','wrapper restores GUCs after refusal');
 end loop;end if;
end$$;
-- Owner declarations go through the actual179 session/role-bound writer.
create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
alter table auth.sessions add column if not exists created_at timestamptz not null default clock_timestamp();
create function pg_temp.clarified180_owner(reason text)returns void language plpgsql as $$declare c record;checkid uuid;payload text;pages jsonb;previous uuid;r text;x jsonb;sessionid uuid:='99180000-0000-4000-8000-000000000901';begin
 select *into c from clarified180_context;if not c.is_public then return;end if;
 insert into auth.sessions(id,user_id,not_after)values(sessionid,c.manager,null)on conflict do nothing;
 insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted)values('99180000-0000-4000-8000-000000000902',c.manager,'totp','active','synthetic-sealed')on conflict do nothing;
 insert into public.mfa_session_attestations(id,user_id,session_id,factor_id,satisfied_at,expires_at)values('99180000-0000-4000-8000-000000000903',c.manager,sessionid::text,'99180000-0000-4000-8000-000000000902',clock_timestamp()-interval'1 second',clock_timestamp()+interval'15 minutes')on conflict do nothing;
 select check_id,payload_sha256,controller_security.coverage179_pages(payload_text::jsonb)into checkid,payload,pages from public.public_website_control_evidence where check_id=((select record from saved_check)->>'id')::uuid;
 select id into previous from controller_security.public_coverage_clarifications q where tenant_id=c.t and engagement_id=c.eng and check_id=checkid and payload_sha256=payload and not exists(select 1 from controller_security.public_coverage_clarifications n where n.previous_revision_id=q.id);
 r:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'operationKey',gen_random_uuid(),'engagementId',c.eng,'checkId',checkid,'payloadSha256',payload,'expectedPreviousRevisionId',previous,'clarifications',(select jsonb_agg(jsonb_build_object('page',p->>'page','sourceState',p->>'state','sourceTruncated',p->'truncated','reasonCategory','needs_investigation','reason',reason,'proposedPublicUrl',null))from jsonb_array_elements(pages)p where p->>'state'<>'examined'or p->'truncated'='true'::jsonb)));
 set local role human_action_writer;x:=public.submit_public_coverage_clarification(c.t,c.manager,sessionid,r);reset role;
 perform pg_temp.ok(x?'record','real owner declaration writer succeeds: '||coalesce(x->>'error','unknown'));
end$$;
select pg_temp.clarified180_owner('Owner requests further investigation of incomplete public pages before relying on this report.');
-- Both new source8 kinds positively traverse request, draft, human review and
-- durable artifact begin under the real scoped proof-writer role. Provider bytes remain synthetic.
do $$declare c record;k text;x jsonb;rid uuid;src text;sha text;d text;r public.reports;q jsonb;key uuid;review jsonb;pdf text:=repeat('d',64);begin
 select *into c from clarified180_context;
 for k in select unnest(array['board','auditor'])loop
  key:=gen_random_uuid();set local role human_action_writer;
  if k='board'then x:=public.request_clarified_board_report(c.t,c.manager,key,c.eng,c.run,'New clarified document8',gen_random_uuid());
  else x:=public.request_clarified_auditor_report(c.t,c.manager,key,c.eng,c.run,'New clarified document8',gen_random_uuid());end if;
  reset role;rid:=(x->>'requestId')::uuid;
  perform pg_temp.ok(rid is not null,'human wrapper creates actual source8 request: '||k||' '||x::text);
  perform pg_temp.ok(current_setting('axiom.report_presentation')='suite-original-presentation'and current_setting('axiom.report_coverage_review')='suite-original-coverage','wrapper restores GUCs after success');
  if k='board'then select source_text,source_sha256 into src,sha from public.board_request_sources where request_id=rid;
  else select source_text,source_sha256 into src,sha from public.statutory_request_sources where request_id=rid;end if;
  perform pg_temp.ok(src::jsonb->'schema_version'='8'::jsonb,'actual trigger freezes source8');
  perform pg_temp.ok((src::jsonb->'owner_clarification'<>'null'::jsonb)=c.is_public,'public source freezes owner receipt; questionnaire asserts no public explanation');
  d:=controller_security.canonical_questionnaire_json(controller_security.coverage180_document(k,src,sha,c.t,c.eng,c.run,rid,'New clarified document8','2026-10-21T00:00:00.000Z'));
  set local role statutory_proof_writer;
  if k='board'then x:=public.record_board_report_draft(c.t,c.founder,rid,d,'<html>Synthetic8</html>',gen_random_uuid());
  else x:=public.record_source_bound_statutory_draft(c.t,c.founder,rid,d,'<html>Synthetic8</html>',gen_random_uuid());end if;
  reset role;select *into r from public.reports where id=(x->>'reportId')::uuid;
  perform pg_temp.ok(r.id is not null and r.content->'schema_version'='8'::jsonb,'human writer records new document8: '||k||' '||x::text);
  set local role statutory_proof_writer;review:=public.review_report(c.t,r.id,'approved',null,c.founder,r.content_sha256,gen_random_uuid());reset role;
  perform pg_temp.ok(review->>'status'='approved','new source8 has separate real review');
  key:=gen_random_uuid();q:=jsonb_build_object('provider','s3-compatible','bucket','clarified-test','retention_policy','seven_years','legal_hold',false,'source_sha256',sha,'content_sha256',r.content_sha256,'review_sha256',review->>'reviewHash','renderer_version','chromium-'||k||'-clarified-v8','artifacts',jsonb_build_array(jsonb_build_object('kind','source_json','mime_type','application/json','content_hash',sha,'byte_size',octet_length(src),'object_key','tenants/'||c.t||'/reports/'||r.id||'/'||key||'/source_json/'||sha),jsonb_build_object('kind',case k when'board'then'board_pdf'else'statutory_pdf'end,'mime_type','application/pdf','content_hash',pdf,'byte_size',1234,'object_key','tenants/'||c.t||'/reports/'||r.id||'/'||key||'/'||case k when'board'then'board_pdf'else'statutory_pdf'end||'/'||pdf)));
  set local role statutory_proof_writer;
  if k='board'then x:=public.begin_board_artifact_build(c.t,c.founder,r.id,key,q,gen_random_uuid());
  else x:=public.begin_statutory_artifact_build(c.t,c.founder,r.id,key,q,gen_random_uuid());end if;
  reset role;perform pg_temp.ok(x->>'status'='pending'and x->>'replayed'='false','source8 approved artifact intent succeeds: '||k||' '||x::text);
  update clarified180_saved set new_request=rid,new_source=src,new_sha=sha,new_report=r.id,new_content=d where kind=k;
 end loop;
end$$;
-- A later owner revision must not mutate or invalidate the exact frozen source,
-- former approved document7, new document8, or its source-bound begin intent.
select pg_temp.clarified180_owner('Owner adds a later follow-up explanation; the previously frozen report must retain its first explanation.');
do $$declare c record;s record;src text;d text;rid uuid;begin select *into c from clarified180_context;
 for s in select *from clarified180_saved loop
  if s.kind='board'then select source_text into src from public.board_request_sources where request_id=s.new_request;
  else select source_text into src from public.statutory_request_sources where request_id=s.new_request;end if;
  perform pg_temp.ok(src=s.new_source,'later owner revision leaves source8 bytes frozen');
  d:=controller_security.canonical_questionnaire_json(controller_security.coverage180_document(s.kind,src,s.new_sha,c.t,c.eng,c.run,s.new_request,'New clarified document8','2026-10-21T00:00:00.000Z'));
  perform pg_temp.ok(d=s.new_content,'historical owner revision still validates exact document8');
  if s.kind='board'then select source_text into src from public.board_request_sources where request_id=s.old_request;
  else select source_text into src from public.statutory_request_sources where request_id=s.old_request;end if;
  perform pg_temp.ok(src=s.old_source,'old7 frozen source bytes unchanged');
  select content_text into d from public.reports where id=s.old_report;
  perform pg_temp.ok(d=s.old_content and d::jsonb->'schema_version'='7'::jsonb,'approved old7 document preserved');
  perform pg_temp.ok(exists(select 1 from public.reports r join public.report_reviews v on v.tenant_id=r.tenant_id and v.report_id=r.id where r.id=s.old_report and r.status='approved'and v.decision='approved'and v.content_sha256=r.content_sha256 and v.review_sha256=s.old_review->>'reviewHash'),'old7 approval status and exact review receipt preserved');
 end loop;
end$$;
set constraints all immediate;
rollback;
