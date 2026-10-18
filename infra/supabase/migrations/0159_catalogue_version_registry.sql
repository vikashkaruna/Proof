-- 0159 (item 8a, step 1): catalogue version dispatch for the public-control
-- review gate. The approved catalogue contract used to be literals inside
-- controller_security.public_control_review_context: library version 0.1.1,
-- its rows hash, publisher, change log, publication date, control count,
-- questionnaire digest, mapping version and catalogue manifest digest. They
-- now live in one immutable registry row per approved version, and the gate
-- and the request validator read that row. Behaviour for 0.1.1 is unchanged
-- (the row holds exactly the former literals); an unregistered version is
-- refused as before. Adding a version is a later, founder-only step (8b);
-- nothing here makes 0.2.0 current. Downstream 0.1.1 pins (0137-0147) move
-- in later steps.
create table public.approved_catalogue_versions (
 library_version text primary key check (library_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 rows_hash text not null check (rows_hash ~ '^[a-f0-9]{64}$'),
 questionnaire_digest text not null check (questionnaire_digest ~ '^[a-f0-9]{64}$'),
 catalogue_manifest_sha256 text not null check (catalogue_manifest_sha256 ~ '^[a-f0-9]{64}$'),
 mapping_version text not null check (mapping_version ~ '^[a-z0-9-]{1,64}$'),
 published_by text not null,
 change_log text not null,
 published_at timestamptz not null,
 control_count integer not null check (control_count between 1 and 500),
 approved_at timestamptz not null default clock_timestamp()
);
create trigger approved_catalogue_versions_immutable before update or delete on public.approved_catalogue_versions
 for each row execute function public.evidence_receipt_immutable();
create trigger approved_catalogue_versions_no_truncate before truncate on public.approved_catalogue_versions
 for each statement execute function public.evidence_receipt_immutable();
alter table public.approved_catalogue_versions enable row level security;
revoke all on public.approved_catalogue_versions from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

insert into public.approved_catalogue_versions(library_version,rows_hash,questionnaire_digest,catalogue_manifest_sha256,
 mapping_version,published_by,change_log,published_at,control_count)
values ('0.1.1','ddf7b3202e731871a78012ddeffa7b8ebde4c2f4b8b3dbbfa7fd95e1c6a7a011','1fcd03e3c5e1cbec9bf09f86a0f26d05ec117d4d4acb3a8a448195e5ee897b0e','3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6','public-evidence-1','Axiom Minds · Founder',
 '0.1.1 — CITATION CORRECTION (PATCH; assessments remain comparable).

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
rules and 7 schedules land in 0.2.0 as a MINOR.',
 '2026-09-20'::timestamptz,46);

CREATE OR REPLACE FUNCTION controller_security.public_control_review_context(t uuid, a uuid, e uuid, c uuid, w boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare role_name public.user_role;internal boolean;ctx jsonb;estate uuid;rows_hash text;qprojection jsonb;cat public.approved_catalogue_versions;
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
 select * into cat from public.approved_catalogue_versions where library_version=ctx->>'libraryVersion';
 if not found or rows_hash is distinct from cat.rows_hash
 or ctx->'library'->>'published_by' is distinct from cat.published_by
 or ctx->'library'->>'change_log' is distinct from cat.change_log
 or (ctx->'library'->>'published_at')::timestamptz is distinct from cat.published_at
 or ctx->'library'->>'control_count' is distinct from cat.control_count::text
 then return jsonb_build_object('error','catalogue_refused');end if;
 select jsonb_build_object('libraryVersion',cat.library_version,'controls',jsonb_agg(jsonb_build_object('id',v->>'id','title',v->>'title','questions',(select jsonb_agg(jsonb_build_object('id',q->>'id','prompt',q->>'prompt','type',q->>'type') order by n) from jsonb_array_elements(v->'assessment_questions') with ordinality x(q,n))) order by v->>'id')) into qprojection from jsonb_array_elements(ctx->'controls') x(v);
 if encode(sha256(convert_to(controller_security.canonical_questionnaire_json(qprojection),'UTF8')),'hex') is distinct from cat.questionnaire_digest then return jsonb_build_object('error','catalogue_refused');end if;
 return ctx||jsonb_build_object('estateId',estate,'catalogueManifestSha256',cat.catalogue_manifest_sha256,'mappingVersion',cat.mapping_version,'questionnaireDigest',cat.questionnaire_digest);
end $function$;

CREATE OR REPLACE FUNCTION controller_security.public_control_review_request_valid(v jsonb, ctx jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare c record;q record;j jsonb;candidate jsonb;ord jsonb;known jsonb;source jsonb;
begin
 if jsonb_typeof(v) is distinct from 'object' or not v?&array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability']
 or v-array['version','operationKey','engagementId','checkId','expectedEstateId','expectedPreviousReviewId','expectedSource','answers','applicability']<>'{}'::jsonb or v->'version' is distinct from '1'::jsonb
 or jsonb_typeof(v->'operationKey') is distinct from 'string' or (v->>'operationKey')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or v->>'engagementId' is distinct from ctx->>'engagementId' or v->>'checkId' is distinct from ctx->>'checkId' or v->'expectedEstateId' is distinct from ctx->'estateId'
 or (v->'expectedPreviousReviewId'<>'null'::jsonb and (jsonb_typeof(v->'expectedPreviousReviewId') is distinct from 'string' or (v->>'expectedPreviousReviewId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
 or v->'expectedSource' is distinct from jsonb_build_object('payloadSha256',ctx->>'payloadSha256','catalogueManifestSha256',ctx->>'catalogueManifestSha256','mappingVersion',ctx->>'mappingVersion','libraryVersion',ctx->>'libraryVersion','questionnaireDigest',ctx->>'questionnaireDigest')
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
end $function$;
