-- Immutable human declarations, not verified evidence or an assessment engine.
alter type public.ledger_action_type add value if not exists 'public_control.review_recorded';
alter type public.ledger_action_type add value if not exists 'public_control.review_cancelled';
create table public.public_control_review_sets (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
 engagement_id uuid not null, estate_id uuid, check_id uuid not null,
 previous_review_id uuid, actor_id uuid not null references public.users(id), operation_key uuid not null,
 request_codec text not null check(request_codec='axiom-public-control-review-request-canonical-json-1'),
 request_text text not null check(octet_length(request_text)<=131072),
 request_sha256 text not null check(request_sha256=encode(sha256(convert_to(request_text,'UTF8')),'hex')),
 snapshot_codec text not null check(snapshot_codec='axiom-public-control-review-snapshot-pg-canonical-json-1'),
 snapshot_text text not null check(octet_length(snapshot_text)<=524288),
 snapshot_sha256 text not null check(snapshot_sha256=encode(sha256(convert_to(snapshot_text,'UTF8')),'hex')),
 receipt_id bigint not null, created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id), unique(tenant_id,receipt_id), unique(tenant_id,operation_key), unique(tenant_id,engagement_id,check_id,id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id),
 foreign key(tenant_id,check_id) references public.public_website_checks(tenant_id,id),
 foreign key(tenant_id,engagement_id,check_id,previous_review_id) references public.public_control_review_sets(tenant_id,engagement_id,check_id,id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create unique index public_control_review_one_root on public.public_control_review_sets(tenant_id,engagement_id,check_id) where previous_review_id is null;
create unique index public_control_review_one_successor on public.public_control_review_sets(previous_review_id) where previous_review_id is not null;
create trigger public_control_review_immutable before update or delete on public.public_control_review_sets for each row execute function public.evidence_receipt_immutable();
create trigger public_control_review_no_truncate before truncate on public.public_control_review_sets for each statement execute function public.evidence_receipt_immutable();
alter table public.public_control_review_sets enable row level security;
revoke all on public.public_control_review_sets from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
-- All reads pass live authority/context RPCs, including historical reads.

create function controller_security.public_control_review_context(t uuid,a uuid,e uuid,c uuid,w boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name public.user_role;internal boolean;ctx jsonb;estate uuid;rows_hash text;qprojection jsonb;
begin
 select role into role_name from public.tenant_users where tenant_id=t and user_id=a for share;
 select is_axiom_internal into internal from public.users where id=a for share;
 if role_name is null or role_name='agent' or internal is null or (role_name in ('founder','axiom_analyst') and internal is distinct from true)
 or (w and role_name not in ('founder','axiom_analyst','owner','admin','reviewer')) then return jsonb_build_object('error','forbidden');end if;
 ctx:=public.read_public_website_control_review(t,a,e,c);
 if ctx?'error' then return ctx;end if;
 select estate_id into estate from public.engagements where tenant_id=t and id=e and status<>'cancelled' for share;
 if not found then return jsonb_build_object('error','context_refused');end if;
 select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(ctx->'controls'),'UTF8')),'hex') into rows_hash;
 if ctx->>'libraryVersion' is distinct from '0.1.1' or rows_hash is distinct from 'ddf7b3202e731871a78012ddeffa7b8ebde4c2f4b8b3dbbfa7fd95e1c6a7a011'
 or ctx->'library'->>'published_by' is distinct from 'Axiom Minds · Founder'
 or ctx->'library'->>'change_log' is distinct from '0.1.1 — CITATION CORRECTION (PATCH; assessments remain comparable).

The DPDPR-2025 citations were authored against the DRAFT Rules numbering and
were never re-mapped after notification, so 21 of 24 pointed at the wrong rule.
Reports generated against 0.1.0 cite the wrong law for notice, breach
notification, retention, cross-border transfer, data-principal rights and SDF
obligations. All 24 re-mapped against the Gazette text of G.S.R. 846(E) and
verified on 2026-09-20; each citation now records what it was verified against.

Header facts corrected: notification is 13 November 2025 (not 14 — the Gazette
issue is dated the 13th, and every commencement date is computed from it);
there are 23 rules (not "rules 5-24"); children''s-data controls follow Rule 10
(not "Rules 9-10"); SDF controls follow Rule 13 (not "Rules 11-12").

No control''s obligation, evidence requirement, question, scoring or remediation
pattern changed. Control count unchanged; the ~19 controls for the 10 uncited
rules and 7 schedules land in 0.2.0 as a MINOR.'
 or (ctx->'library'->>'published_at')::timestamptz is distinct from '2026-09-20'::timestamptz
 or ctx->'library'->>'control_count' is distinct from '46'
 then return jsonb_build_object('error','catalogue_refused');end if;
 select jsonb_build_object('libraryVersion','0.1.1','controls',jsonb_agg(jsonb_build_object('id',v->>'id','title',v->>'title','questions',(select jsonb_agg(jsonb_build_object('id',q->>'id','prompt',q->>'prompt','type',q->>'type') order by n) from jsonb_array_elements(v->'assessment_questions') with ordinality x(q,n))) order by v->>'id')) into qprojection from jsonb_array_elements(ctx->'controls') x(v);
 if encode(sha256(convert_to(controller_security.canonical_questionnaire_json(qprojection),'UTF8')),'hex') is distinct from '1fcd03e3c5e1cbec9bf09f86a0f26d05ec117d4d4acb3a8a448195e5ee897b0e' then return jsonb_build_object('error','catalogue_refused');end if;
 return ctx||jsonb_build_object('estateId',estate,'catalogueManifestSha256','3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6','mappingVersion','public-evidence-1','questionnaireDigest','1fcd03e3c5e1cbec9bf09f86a0f26d05ec117d4d4acb3a8a448195e5ee897b0e');
end $$;
revoke all on function controller_security.public_control_review_context(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function controller_security.public_control_review_request_valid(v jsonb,ctx jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare c record;q record;j jsonb;candidate jsonb;ord jsonb;known jsonb;source jsonb;
begin
 if jsonb_typeof(v) is distinct from 'object' or not v?&array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability']
 or v-array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability']<>'{}'::jsonb or v->'version' is distinct from '1'::jsonb
 or jsonb_typeof(v->'operationKey') is distinct from 'string' or (v->>'operationKey')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or v->>'engagementId' is distinct from ctx->>'engagementId' or v->>'checkId' is distinct from ctx->>'checkId' or v->'expectedEstateId' is distinct from ctx->'estateId'
 or (v->'expectedPreviousReviewId'<>'null'::jsonb and (jsonb_typeof(v->'expectedPreviousReviewId') is distinct from 'string' or (v->>'expectedPreviousReviewId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
 or v->'expectedSource' is distinct from jsonb_build_object('payloadSha256',ctx->>'payloadSha256','catalogueManifestSha256',ctx->>'catalogueManifestSha256','mappingVersion','public-evidence-1','libraryVersion','0.1.1','questionnaireDigest',ctx->>'questionnaireDigest')
 or jsonb_typeof(v->'answers') is distinct from 'object' or jsonb_typeof(v->'applicability') is distinct from 'object'
 or not v->'applicability'?&array['sdfSelfAttested','processesChildren','processesHealth','rationale']
 or (v->'applicability')-array['sdfSelfAttested','processesChildren','processesHealth','rationale']<>'{}'::jsonb
 or jsonb_typeof(v->'applicability'->'rationale') is distinct from 'string' or length(v->'applicability'->>'rationale') not between 1 and 2000 or v->'applicability'->>'rationale'!~'[^[:space:]]'
 then return false;end if;
 foreach known in array array[v->'applicability'->'sdfSelfAttested',v->'applicability'->'processesChildren',v->'applicability'->'processesHealth'] loop
 if jsonb_typeof(known) not in ('boolean','null') then return false;end if;end loop;
 source:=(ctx->>'payloadText')::jsonb;
 for c in select * from jsonb_each(v->'answers') loop
  select x into known from jsonb_array_elements(ctx->'controls') x where x->>'id'=c.key;
  if known is null or jsonb_typeof(c.value) is distinct from 'object' then return false;end if;
  for q in select * from jsonb_each(c.value) loop
   if not exists(select 1 from jsonb_array_elements(known->'assessment_questions') x where x->>'id'=q.key and x->>'type'='boolean') then return false;end if;
   j:=q.value;
   if jsonb_typeof(j) is distinct from 'object' or not j?&array['answer','rationale','candidateOrdinals'] or j-array['answer','rationale','candidateOrdinals']<>'{}'::jsonb
   or jsonb_typeof(j->'answer') not in ('boolean','null') or jsonb_typeof(j->'rationale') is distinct from 'string' or length(j->>'rationale') not between 1 and 2000 or j->>'rationale'!~'[^[:space:]]'
   or jsonb_typeof(j->'candidateOrdinals') is distinct from 'array' then return false;end if;
   if jsonb_array_length(j->'candidateOrdinals')>128 or (select count(*)<>count(distinct value) from jsonb_array_elements(j->'candidateOrdinals')) then return false;end if;
   for ord in select value from jsonb_array_elements(j->'candidateOrdinals') loop
    if jsonb_typeof(ord) is distinct from 'number' or ord::text!~'^[1-9][0-9]{0,2}$' or ord::text::integer>128 then return false;end if;
    select x into candidate from jsonb_array_elements(source->'candidates') x where x->'ordinal'=ord;
    if candidate is null or not exists(select 1 from jsonb_array_elements(source->'pages') p where p->>'page'=candidate->'locator'->>'page' and p->>'state'='examined' and p->>'contentSha256'=candidate->'locator'->>'contentSha256') then return false;end if;
   end loop;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function controller_security.public_control_review_request_valid(jsonb,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- Shape validation also permits cancellation of a stale never-recorded intent;
-- unlike record validation it confers no source/estate/CAS freshness authority.
create function controller_security.public_control_review_request_shape(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;kv record;q record;j jsonb;ord jsonb;counted integer:=0;uuid_pattern text:='^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
begin
 if jsonb_typeof(v) is distinct from 'object' or not v?&array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability'] or v-array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability']<>'{}'::jsonb or v->'version' is distinct from '1'::jsonb then return false;end if;
 foreach k in array array['operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId'] loop
 if v->k='null'::jsonb and k in ('expectedEstateId','expectedPreviousReviewId') then continue;end if;
 if jsonb_typeof(v->k) is distinct from 'string' or v->>k !~ uuid_pattern then return false;end if;end loop;
 j:=v->'expectedSource';
 if jsonb_typeof(j) is distinct from 'object' or not j?&array['payloadSha256','catalogueManifestSha256','mappingVersion','libraryVersion','questionnaireDigest'] or j-array['payloadSha256','catalogueManifestSha256','mappingVersion','libraryVersion','questionnaireDigest']<>'{}'::jsonb or j->>'libraryVersion' is distinct from '0.1.1' or j->>'mappingVersion' is distinct from 'public-evidence-1' then return false;end if;
 foreach k in array array['payloadSha256','catalogueManifestSha256','questionnaireDigest'] loop if jsonb_typeof(j->k) is distinct from 'string' or j->>k !~'^[a-f0-9]{64}$' then return false;end if;end loop;
 j:=v->'applicability';
 if jsonb_typeof(j) is distinct from 'object' or not j?&array['sdfSelfAttested','processesChildren','processesHealth','rationale'] or j-array['sdfSelfAttested','processesChildren','processesHealth','rationale']<>'{}'::jsonb or jsonb_typeof(j->'rationale') is distinct from 'string' or length(j->>'rationale') not between 1 and 2000 or j->>'rationale'!~'[^[:space:]]' then return false;end if;
 foreach k in array array['sdfSelfAttested','processesChildren','processesHealth'] loop if jsonb_typeof(j->k) not in ('boolean','null') then return false;end if;end loop;
 if jsonb_typeof(v->'answers') is distinct from 'object' or (select count(*)>46 from jsonb_object_keys(v->'answers')) then return false;end if;
 for kv in select * from jsonb_each(v->'answers') loop
 if length(kv.key) not between 1 and 200 or jsonb_typeof(kv.value) is distinct from 'object' then return false;end if;
 for q in select * from jsonb_each(kv.value) loop
 counted:=counted+1;j:=q.value;
 if counted>5000 or length(q.key) not between 1 and 200 or jsonb_typeof(j) is distinct from 'object' or not j?&array['answer','rationale','candidateOrdinals'] or j-array['answer','rationale','candidateOrdinals']<>'{}'::jsonb or jsonb_typeof(j->'answer') not in ('boolean','null') or jsonb_typeof(j->'rationale') is distinct from 'string' or length(j->>'rationale') not between 1 and 2000 or j->>'rationale'!~'[^[:space:]]' or jsonb_typeof(j->'candidateOrdinals') is distinct from 'array' then return false;end if;
 if jsonb_array_length(j->'candidateOrdinals')>128 or (select count(*)<>count(distinct value) from jsonb_array_elements(j->'candidateOrdinals')) then return false;end if;
 for ord in select value from jsonb_array_elements(j->'candidateOrdinals') loop if jsonb_typeof(ord) is distinct from 'number' or ord::text!~'^[1-9][0-9]{0,2}$' or ord::text::integer>128 then return false;end if;end loop;
 end loop;end loop;return true;
end $$;
revoke all on function controller_security.public_control_review_request_shape(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create table public.public_control_review_cancellations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,actor_id uuid not null references public.users(id),engagement_id uuid not null,check_id uuid not null,operation_key uuid not null,
 request_codec text not null check(request_codec='axiom-public-control-review-request-canonical-json-1'),request_text text not null check(octet_length(request_text)<=131072),request_sha256 text not null check(request_sha256=encode(sha256(convert_to(request_text,'UTF8')),'hex')),
 reason text not null check(length(reason) between 1 and 2000 and reason~'[^[:space:]]'),
 cancellation_codec text not null check(cancellation_codec='axiom-public-control-review-cancellation-pg-canonical-json-1'),cancellation_text text not null check(octet_length(cancellation_text) between 2 and 16384),cancellation_sha256 text not null check(cancellation_sha256=encode(sha256(convert_to(cancellation_text,'UTF8')),'hex')),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),unique(tenant_id,actor_id,operation_key),unique(tenant_id,receipt_id),
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id),foreign key(tenant_id,check_id) references public.public_website_checks(tenant_id,id),foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create trigger public_control_cancellation_immutable before update or delete on public.public_control_review_cancellations for each row execute function public.evidence_receipt_immutable();
create trigger public_control_cancellation_no_truncate before truncate on public.public_control_review_cancellations for each statement execute function public.evidence_receipt_immutable();
alter table public.public_control_review_cancellations enable row level security;
revoke all on public.public_control_review_cancellations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.record_public_control_review_set(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;ctx jsonb;old public.public_control_review_sets;head public.public_control_review_sets;r public.public_control_review_sets;
 normalized jsonb:='{}';questions jsonb;ctrl jsonb;q jsonb;snapshot jsonb;snapshot_text text;rid uuid:=gen_random_uuid();receipt bigint;
begin
 if p_request_text is null or octet_length(p_request_text)>131072 then return jsonb_build_object('error','invalid_record');end if;
 begin v:=p_request_text::jsonb;
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text then return jsonb_build_object('error','invalid_record');end if;
 ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid,true);
 exception when invalid_text_representation then return jsonb_build_object('error','invalid_record');end;
 if ctx?'error' then return ctx;end if;
 if not controller_security.public_control_review_request_shape(v) or not controller_security.public_control_review_request_valid(v,ctx) then return jsonb_build_object('error','invalid_record');end if;
 perform pg_advisory_xact_lock(hashtextextended('public-control-review:'||p_tenant_id::text,0));
 if exists(select 1 from public.public_control_review_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(v->>'operationKey')::uuid) then
  if exists(select 1 from public.public_control_review_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(v->>'operationKey')::uuid and request_text=p_request_text) then return jsonb_build_object('error','operation_cancelled');end if;
  return jsonb_build_object('error','idempotency_conflict');end if;
 -- All authority/context locks precede the journal lock. Never replay first.
 select * into old from public.public_control_review_sets where tenant_id=p_tenant_id and operation_key=(v->>'operationKey')::uuid;
 if found then
  if old.actor_id<>p_actor_id or old.request_text<>p_request_text or old.estate_id is distinct from (ctx->>'estateId')::uuid then return jsonb_build_object('error','idempotency_conflict');end if;
  return jsonb_build_object('data',to_jsonb(old)||jsonb_build_object('receipt_id',old.receipt_id::text),'replayed',true);end if;
 select * into head from public.public_control_review_sets x where tenant_id=p_tenant_id and engagement_id=(v->>'engagementId')::uuid and check_id=(v->>'checkId')::uuid and not exists(select 1 from public.public_control_review_sets y where y.previous_review_id=x.id);
 if head.id is distinct from (v->>'expectedPreviousReviewId')::uuid then return jsonb_build_object('error','stale_review');end if;
 for ctrl in select value from jsonb_array_elements(ctx->'controls') loop
  questions:='{}';
  for q in select value from jsonb_array_elements(ctrl->'assessment_questions') where value->>'type'='boolean' loop
   questions:=questions||jsonb_build_object(q->>'id',coalesce(v->'answers'->(ctrl->>'id')->(q->>'id')->'answer','null'::jsonb));
  end loop;
  normalized:=normalized||jsonb_build_object(ctrl->>'id',questions);
 end loop;
 snapshot:=jsonb_build_object('version',1,'tenantId',p_tenant_id,'engagementId',v->'engagementId','estateId',ctx->'estateId','checkId',v->'checkId','checkedAt',ctx->'checkedAt','captureReceipt',ctx->'captureReceipt','request',v,'normalizedAnswers',normalized,'declarationsVerified',false,'requiresHumanReview',true);
 snapshot_text:=controller_security.canonical_questionnaire_json(snapshot);
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'public_control.review_recorded',rid::text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),encode(sha256(convert_to(snapshot_text,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('engagement_id',v->'engagementId','check_id',v->'checkId','previous_review_id',head.id,'declarations_verified',false));
 insert into public.public_control_review_sets(id,tenant_id,engagement_id,estate_id,check_id,previous_review_id,actor_id,operation_key,request_codec,request_text,request_sha256,snapshot_codec,snapshot_text,snapshot_sha256,receipt_id)
 values(rid,p_tenant_id,(v->>'engagementId')::uuid,(ctx->>'estateId')::uuid,(v->>'checkId')::uuid,head.id,p_actor_id,(v->>'operationKey')::uuid,'axiom-public-control-review-request-canonical-json-1',p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),'axiom-public-control-review-snapshot-pg-canonical-json-1',snapshot_text,encode(sha256(convert_to(snapshot_text,'UTF8')),'hex'),receipt) returning * into r;
 return jsonb_build_object('data',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),'replayed',false);
end $$;
revoke all on function public.record_public_control_review_set(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.record_public_control_review_set(uuid,uuid,text) to human_action_writer;

create function public.read_public_control_review_set(p_tenant_id uuid,p_actor_id uuid,p_review_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.public_control_review_sets;ctx jsonb;
begin
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=p_review_id;
 if not found then return jsonb_build_object('error','source_refused');end if;
 ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,r.engagement_id,r.check_id,false);
 if ctx?'error' then return ctx;end if;
 return jsonb_build_object('data',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),'isCurrent',not exists(select 1 from public.public_control_review_sets where previous_review_id=r.id),'contextCurrent',r.estate_id is not distinct from (ctx->>'estateId')::uuid);
end $$;
revoke all on function public.read_public_control_review_set(uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_public_control_review_set(uuid,uuid,uuid) to service_role,human_action_writer;

-- Producer credentials cannot impersonate the recorded human judgment.
create or replace function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
 p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text in ('public_control.review_recorded','public_control.review_cancelled','prativedan.draft.requested','prativedan.draft.claimed','prativedan.draft.settled','prativedan.draft.reviewed')
  or (p_action_type::text='report.generated' and exists(select 1 from public.prativedan_draft_requests
   where tenant_id=p_tenant_id and run_id::text=p_detail->>'run_id'))
 then raise exception 'dedicated controller receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0126(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
  p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

create function public.read_public_control_review_head(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_check_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;r public.public_control_review_sets;
begin
 ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,p_engagement_id,p_check_id,false);
 if ctx?'error' then return ctx;end if;
 select * into r from public.public_control_review_sets x where tenant_id=p_tenant_id and engagement_id=p_engagement_id and check_id=p_check_id and not exists(select 1 from public.public_control_review_sets y where y.previous_review_id=x.id);
 return jsonb_build_object('context',ctx,'data',case when r.id is null then null else to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text) end);
end $$;
revoke all on function public.read_public_control_review_head(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_public_control_review_head(uuid,uuid,uuid,uuid) to service_role,human_action_writer;

-- A generic human/producer ledger capability cannot manufacture a review receipt.
create function controller_security.public_control_review_receipt_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.public_control_review_sets;l public.audit_ledger;receipt bigint;
begin
 if tg_table_name='audit_ledger' then receipt:=new.id;else receipt:=new.receipt_id;end if;
 select * into r from public.public_control_review_sets where receipt_id=receipt;
 select * into l from public.audit_ledger where id=receipt;
 if r.id is null or l.id is null or l.tenant_id is distinct from r.tenant_id or l.actor_type::text is distinct from 'human' or l.actor_id is distinct from r.actor_id::text
 or l.correlation_id is distinct from r.operation_key or l.target_ref is distinct from r.id::text or l.action_type::text is distinct from 'public_control.review_recorded' or l.input_hash is distinct from r.request_sha256 or l.output_hash is distinct from r.snapshot_sha256 or l.result::text is distinct from 'success'
 then raise exception 'public review receipt binding refused' using errcode='42501';end if;
 return new;
end $$;
revoke all on function controller_security.public_control_review_receipt_binding() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create constraint trigger public_control_review_receipt after insert on public.public_control_review_sets deferrable initially deferred for each row execute function controller_security.public_control_review_receipt_binding();
create constraint trigger public_control_review_ledger_receipt after insert on public.audit_ledger deferrable initially deferred for each row when(new.action_type::text='public_control.review_recorded') execute function controller_security.public_control_review_receipt_binding();

-- Read-only recovery proves an earlier commit without granting replay/dispatch.
-- A changed head/estate/library cannot erase a historical positive receipt.
create function public.cancel_public_control_review_operation(p_tenant_id uuid,p_actor_id uuid,p_request_text text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;role_name public.user_role;internal boolean;r public.public_control_review_sets;c public.public_control_review_cancellations;rid uuid:=gen_random_uuid();receipt bigint;txt text;
begin
 if p_request_text is null or octet_length(p_request_text)>131072 or p_reason is null or length(p_reason) not between 1 and 2000 or p_reason!~'[^[:space:]]' then return jsonb_build_object('error','invalid_record');end if;
 begin v:=p_request_text::jsonb;exception when invalid_text_representation then return jsonb_build_object('error','invalid_record');end;
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text or not controller_security.public_control_review_request_shape(v) then return jsonb_build_object('error','invalid_record');end if;
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if role_name is null or role_name not in ('founder','axiom_analyst','owner','admin','reviewer') or internal is null or (role_name in ('founder','axiom_analyst') and internal is distinct from true) then return jsonb_build_object('error','forbidden');end if;
 perform 1 from public.engagements where tenant_id=p_tenant_id and id=(v->>'engagementId')::uuid for share;
 if not found then return jsonb_build_object('error','context_refused');end if;
 perform 1 from public.public_website_checks where tenant_id=p_tenant_id and id=(v->>'checkId')::uuid for share;
 if not found then return jsonb_build_object('error','source_refused');end if;
 perform pg_advisory_xact_lock(hashtextextended('public-control-review:'||p_tenant_id::text,0));
 select * into c from public.public_control_review_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(v->>'operationKey')::uuid;
 if found then
 if c.request_text<>p_request_text or c.reason<>p_reason then return jsonb_build_object('error','idempotency_conflict');end if;
 return jsonb_build_object('state','cancelled','data',to_jsonb(c)||jsonb_build_object('receipt_id',c.receipt_id::text));end if;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and operation_key=(v->>'operationKey')::uuid;
 if found then
 if r.actor_id<>p_actor_id or r.request_text<>p_request_text then return jsonb_build_object('error','idempotency_conflict');end if;
 return jsonb_build_object('state','recorded','data',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),'isCurrent',not exists(select 1 from public.public_control_review_sets where previous_review_id=r.id),'contextCurrent',r.estate_id is not distinct from (select estate_id from public.engagements where tenant_id=p_tenant_id and id=r.engagement_id) and (r.request_text::jsonb->'expectedSource'->>'libraryVersion')=(select library_version from public.engagements where tenant_id=p_tenant_id and id=r.engagement_id));end if;
 txt:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'tenantId',p_tenant_id,'actorId',p_actor_id,'engagementId',v->'engagementId','checkId',v->'checkId','operationKey',v->'operationKey','requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),'reason',p_reason));
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'public_control.review_cancelled',rid::text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),encode(sha256(convert_to(txt,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('engagement_id',v->'engagementId','check_id',v->'checkId','review_never_recorded',true));
 insert into public.public_control_review_cancellations(id,tenant_id,actor_id,engagement_id,check_id,operation_key,request_codec,request_text,request_sha256,reason,cancellation_codec,cancellation_text,cancellation_sha256,receipt_id)
 values(rid,p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid,(v->>'operationKey')::uuid,'axiom-public-control-review-request-canonical-json-1',p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),p_reason,'axiom-public-control-review-cancellation-pg-canonical-json-1',txt,encode(sha256(convert_to(txt,'UTF8')),'hex'),receipt) returning * into c;
 return jsonb_build_object('state','cancelled','data',to_jsonb(c)||jsonb_build_object('receipt_id',c.receipt_id::text));
end $$;
revoke all on function public.cancel_public_control_review_operation(uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.cancel_public_control_review_operation(uuid,uuid,text,text) to human_action_writer;

create function public.read_public_control_review_operation(p_tenant_id uuid,p_actor_id uuid,p_engagement_id uuid,p_check_id uuid,p_operation_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.public_control_review_sets;e public.engagements;c public.public_control_review_cancellations;role_name public.user_role;internal boolean;
begin
 select role into role_name from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 select is_axiom_internal into internal from public.users where id=p_actor_id for share;
 if role_name is null or role_name='agent' or internal is null or (role_name in ('founder','axiom_analyst') and internal is distinct from true) then return jsonb_build_object('error','forbidden');end if;
 select * into e from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for share;
 if not found then return jsonb_build_object('error','context_refused');end if;
 perform 1 from public.public_website_checks where tenant_id=p_tenant_id and id=p_check_id for share;
 if not found then return jsonb_build_object('error','source_refused');end if;
 select * into c from public.public_control_review_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=p_operation_key;
 if found then
 if c.engagement_id<>p_engagement_id or c.check_id<>p_check_id then return jsonb_build_object('error','source_refused');end if;
 return jsonb_build_object('state','cancelled','data',to_jsonb(c)||jsonb_build_object('receipt_id',c.receipt_id::text));end if;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if not found then return jsonb_build_object('state','not_found');end if;
 if r.actor_id<>p_actor_id or r.engagement_id<>p_engagement_id or r.check_id<>p_check_id then return jsonb_build_object('error','source_refused');end if;
 return jsonb_build_object('state','recorded','data',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),'isCurrent',not exists(select 1 from public.public_control_review_sets where previous_review_id=r.id),'contextCurrent',r.estate_id is not distinct from e.estate_id and (r.request_text::jsonb->'expectedSource'->>'libraryVersion')=e.library_version);
end $$;
revoke all on function public.read_public_control_review_operation(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
grant execute on function public.read_public_control_review_operation(uuid,uuid,uuid,uuid,uuid) to service_role,human_action_writer;

create function controller_security.public_control_cancellation_receipt_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.public_control_review_cancellations;l public.audit_ledger;receipt bigint;
begin
 if tg_table_name='audit_ledger' then receipt:=new.id;else receipt:=new.receipt_id;end if;
 select * into c from public.public_control_review_cancellations where receipt_id=receipt;select * into l from public.audit_ledger where id=receipt;
 if c.id is null or l.id is null or l.tenant_id is distinct from c.tenant_id or l.actor_type::text is distinct from 'human' or l.actor_id is distinct from c.actor_id::text or l.correlation_id is distinct from c.operation_key or l.target_ref is distinct from c.id::text or l.action_type::text is distinct from 'public_control.review_cancelled' or l.input_hash is distinct from c.request_sha256 or l.output_hash is distinct from c.cancellation_sha256 or l.result::text is distinct from 'success' then raise exception 'public review cancellation receipt refused' using errcode='42501';end if;
 return new;
end $$;
revoke all on function controller_security.public_control_cancellation_receipt_binding() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create constraint trigger public_control_cancel_receipt after insert on public.public_control_review_cancellations deferrable initially deferred for each row execute function controller_security.public_control_cancellation_receipt_binding();
create constraint trigger public_control_cancel_ledger_receipt after insert on public.audit_ledger deferrable initially deferred for each row when(new.action_type::text='public_control.review_cancelled') execute function controller_security.public_control_cancellation_receipt_binding();
