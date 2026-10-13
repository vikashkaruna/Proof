-- Dedicated assessment-source draft persistence. Unmounted: neither this store
-- nor recorded review grants publication, execution or evidence verification.
-- Source v2 is intentionally incompatible with the legacy board-source codec.
alter type public.ledger_action_type add value if not exists 'prativedan.draft.requested';
alter type public.ledger_action_type add value if not exists 'prativedan.draft.claimed';
alter type public.ledger_action_type add value if not exists 'prativedan.draft.settled';
alter type public.ledger_action_type add value if not exists 'prativedan.draft.reviewed';

create function controller_security.prativedan123_hash(value text) returns text
language sql immutable strict set search_path='' as $$select encode(sha256(convert_to(value,'UTF8')),'hex')$$;
-- json preserves duplicate decoded names; jsonb does not. Refuse before casting.
create function controller_security.prativedan123_json_unique(value json, depth integer default 0)
returns boolean language plpgsql immutable strict set search_path='' as $$
declare item json;
begin
 if depth>40 then return false; end if;
 if json_typeof(value)='object' then
  if (select count(*)<>count(distinct key) from json_each(value)) then return false; end if;
  for item in select v from json_each(value) e(k,v) loop
   if not controller_security.prativedan123_json_unique(item,depth+1) then return false; end if;
  end loop;
 elsif json_typeof(value)='array' then
  for item in select v from json_array_elements(value) e(v) loop
   if not controller_security.prativedan123_json_unique(item,depth+1) then return false; end if;
  end loop;
 end if;
 return true;
end $$;
create function controller_security.prativedan123_json(value text, byte_limit integer)
returns jsonb language plpgsql immutable set search_path='' as $$
begin
 if value is null or octet_length(value) not between 1 and byte_limit
  or not controller_security.prativedan123_json_unique(value::json)
 then raise exception 'draft JSON refused' using errcode='22023'; end if;
 return value::jsonb;
end $$;
create function controller_security.prativedan123_authority(t uuid,a uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 lock table public.kill_switch_state in share mode;
 perform 1 from public.kill_switch_state where scope='global' or tenant_id=t for share;
 return t is not null and a is not null and t<>'00000000-0000-0000-0000-000000000000'::uuid
  and a<>'00000000-0000-0000-0000-000000000000'::uuid
  and public.report_founder_allowed(t,a)
  and exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  and not exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=t));
end $$;

-- Independent bounded set equality: counts alone cannot prove coverage.
create function controller_security.prativedan123_coverage(controls jsonb,findings jsonb,declarations jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare n integer;
begin
 if jsonb_typeof(controls) is distinct from 'array' or jsonb_typeof(findings) is distinct from 'array'
  or jsonb_typeof(declarations) is distinct from 'array' then return false;end if;
 n:=jsonb_array_length(controls);
 if n not between 1 and 500 or jsonb_array_length(findings)<>n or jsonb_array_length(declarations)<>n
  or (select count(distinct x->>'id') from jsonb_array_elements(controls) x)<>n
  or (select count(distinct x->>'control_id') from jsonb_array_elements(findings) x)<>n
  or (select count(distinct x->>'control_id') from jsonb_array_elements(declarations) x)<>n
  or exists(select 1 from jsonb_array_elements(controls) c where jsonb_typeof(c->'id') is distinct from 'string'
   or not exists(select 1 from jsonb_array_elements(findings) f where f->>'control_id'=c->>'id')
   or not exists(select 1 from jsonb_array_elements(declarations) d where d->>'control_id'=c->>'id'))
 then return false;end if;
 return true;
end $$;

-- Verifies current questionnaire declarations against the exact immutable
-- finalized packet, then returns only the deterministic renderer projection.
create function controller_security.prativedan123_input(t uuid,e uuid,r uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.workload_assessment_packets; title text; c jsonb; f jsonb; d jsonb; q jsonb;
 prov jsonb; app jsonb; field text; req jsonb; qs jsonb; yesn integer; non integer; un integer; kn integer;
 state text; applicable text; suffix text; items jsonb:='[]'; ids jsonb:='[]'; n integer;
begin
 if not public.board_assessment_source_valid(t,r,e) then raise exception 'completed assessment refused' using errcode='42501'; end if;
 select * into p from public.workload_assessment_packets where tenant_id=t and run_id=r and engagement_id=e;
 perform 1 from public.control_libraries where version=p.library_version and status in ('published','deprecated')
  and control_count=jsonb_array_length(p.controls) for share;
 if not found or jsonb_array_length(p.controls) not between 1 and 500 then raise exception 'published library refused' using errcode='42501'; end if;
 select engagements.title into title from public.engagements where tenant_id=t and id=e
  and library_version=p.library_version and status<>'cancelled' for share;
 if not found or length(title) not between 1 and 300 then raise exception 'engagement refused' using errcode='42501'; end if;
 prov:=p.result->'questionnaire_provenance'; app:=prov->'applicability'; n:=jsonb_array_length(p.controls);
 if jsonb_typeof(p.result) is distinct from 'object' or (p.result-array['library_version','posture_score','estimated_exposure_inr','findings','questionnaire_provenance'])<>'{}'
  or not(p.result ?& array['library_version','posture_score','estimated_exposure_inr','findings','questionnaire_provenance'])
  or jsonb_typeof(p.result->'posture_score') is distinct from 'number' or (p.result->>'posture_score')::numeric not between 0 and 100
  or jsonb_typeof(p.result->'estimated_exposure_inr') is distinct from 'number'
  or p.result->>'estimated_exposure_inr' !~ '^[0-9]+$'
  or (p.result->>'estimated_exposure_inr')::numeric not between 0 and 9007199254740991
  or trunc((p.result->>'estimated_exposure_inr')::numeric)<>(p.result->>'estimated_exposure_inr')::numeric
  or jsonb_typeof(prov) is distinct from 'object'
  or prov->>'version' is distinct from '1' or jsonb_typeof(prov->'version') is distinct from 'number' or prov->'review_required' is distinct from 'true'::jsonb
  or prov->>'estimates' is distinct from 'provisional' or prov->>'source_library_version' is distinct from p.library_version
  or prov->>'source_library_digest' is distinct from p.library_digest
  or (prov-array['version','review_required','estimates','source_library_version','source_library_digest','applicability','controls'])<>'{}'
  or jsonb_typeof(app) is distinct from 'object' or (app-array['sdf_self_attested','processes_children','processes_health'])<>'{}'
  or not(app ?& array['sdf_self_attested','processes_children','processes_health'])
  or jsonb_typeof(prov->'controls') is distinct from 'array' or jsonb_typeof(p.result->'findings') is distinct from 'array'
 then raise exception 'current questionnaire refused' using errcode='42501'; end if;
 foreach field in array array['sdf_self_attested','processes_children','processes_health'] loop
  d:=app->field;
  if jsonb_typeof(d) is distinct from 'object' or not(d ?& array['value','provenance']) or (d-array['value','provenance'])<>'{}'
   or d->'value' not in ('true'::jsonb,'false'::jsonb,'null'::jsonb)
   or d->>'provenance' is distinct from (case when d->'value'='null'::jsonb then 'unknown' else 'caller_declared_unverified' end)
  then raise exception 'applicability refused' using errcode='42501'; end if;
 end loop;
 if controller_security.prativedan123_coverage(p.controls,p.result->'findings',prov->'controls') is distinct from true
 then raise exception 'control coverage refused' using errcode='42501';end if;
 select jsonb_agg(value->'id' order by ord) into ids from jsonb_array_elements(p.controls) with ordinality x(value,ord);
 -- Preserve finalized result.findings order independently of library ordering.
 for c in select ctl.value from jsonb_array_elements(p.result->'findings') with ordinality fnd(value,ord)
  join lateral jsonb_array_elements(p.controls) ctl(value) on ctl.value->>'id'=fnd.value->>'control_id' order by fnd.ord loop
  if c->>'library_version' is distinct from p.library_version
   or jsonb_typeof(c->'sdf_only') is distinct from 'boolean' or jsonb_typeof(c->'children_only') is distinct from 'boolean'
   or jsonb_typeof(c->'assessment_questions') is distinct from 'array'
   or not exists(select 1 from public.controls pinned where pinned.library_version=p.library_version and pinned.id=c->>'id'
    and pinned.title=c->>'title' and pinned.severity::text=c->>'severity' and pinned.assessment_questions=c->'assessment_questions'
    and pinned.sdf_only=(c->>'sdf_only')::boolean and pinned.children_only=(c->>'children_only')::boolean)
  then raise exception 'pinned control refused' using errcode='42501'; end if;
  select value into d from jsonb_array_elements(prov->'controls') where value->>'control_id'=c->>'id';
  select value into f from jsonb_array_elements(p.result->'findings') where value->>'control_id'=c->>'id';
  if d is null or f is null or jsonb_typeof(d->'questions') is distinct from 'array'
   or (d-array['control_id','questions','known_boolean_question_count','caller_affirmed_count','caller_denied_count','unknown_count','answer_state','applicability_state'])<>'{}'
   or (f-array['control_id','score','risk_points','rationale'])<>'{}' or not(f ?& array['control_id','score','rationale'])
   or jsonb_typeof(f->'score') is distinct from 'number' or (f->>'score')::numeric not between 0 and 100
   or jsonb_typeof(f->'rationale') is distinct from 'string' or length(f->>'rationale') not between 1 and 4000
  then raise exception 'finding declaration refused' using errcode='42501'; end if;
  select coalesce(jsonb_agg(x->'id'),'[]') into qs from jsonb_array_elements(c->'assessment_questions') x where x->>'type'='boolean';
  kn:=jsonb_array_length(qs);
  if kn>1000 then raise exception 'question count refused' using errcode='42501';end if;
  foreach field in array array['known_boolean_question_count','caller_affirmed_count','caller_denied_count','unknown_count'] loop
   if jsonb_typeof(d->field) is distinct from 'number' or d->>field !~ '^[0-9]+$' then raise exception 'integer declaration count refused' using errcode='42501';end if;
  end loop;
  if (select count(distinct x->>'question_id') from jsonb_array_elements(d->'questions') x)<>kn
   or jsonb_array_length(d->'questions')<>kn then raise exception 'question coverage refused' using errcode='42501'; end if;
  for q in select value from jsonb_array_elements(d->'questions') loop
   if not(q ?& array['question_id','declaration']) or (q-array['question_id','declaration'])<>'{}'
    or jsonb_typeof(q->'question_id') is distinct from 'string' or jsonb_typeof(q->'declaration') is distinct from 'string'
    or not(qs @> jsonb_build_array(q->'question_id')) or q->>'declaration' not in ('caller_affirmed','caller_denied','unknown')
   then raise exception 'question declaration refused' using errcode='42501'; end if;
  end loop;
  select count(*) filter(where x->>'declaration'='caller_affirmed'),count(*) filter(where x->>'declaration'='caller_denied')
   into yesn,non from jsonb_array_elements(d->'questions') x;
  un:=kn-yesn-non;
  state:=case when kn=0 then 'not_boolean_assessable' when un=kn then 'unknown' when un>0 then 'partially_answered' else 'caller_declared_unverified' end;
  req:='[]';
  if c->'sdf_only'='true'::jsonb then req:=req||jsonb_build_array(app#>'{sdf_self_attested,value}'); end if;
  if c->'children_only'='true'::jsonb then req:=req||jsonb_build_array(app#>'{processes_children,value}'); end if;
  applicable:=case when req='[]'::jsonb then 'unconditional' when req @> '[false]' then 'caller_declared_not_applicable_unverified'
   when req @> '[null]' then 'unknown' else 'caller_declared_applicable_unverified' end;
  if d->'known_boolean_question_count' is distinct from to_jsonb(kn) or d->'caller_affirmed_count' is distinct from to_jsonb(yesn)
   or d->'caller_denied_count' is distinct from to_jsonb(non) or d->'unknown_count' is distinct from to_jsonb(un)
   or d->>'answer_state' is distinct from state or d->>'applicability_state' is distinct from applicable
  then raise exception 'declaration state refused' using errcode='42501'; end if;
  suffix:=' [Draft assessment declaration: answer='||state||'; applicability='||applicable||'; evidence unverified.]';
  items:=items||jsonb_build_array(jsonb_build_object('control_id',c->>'id','title',c->>'title','severity',c->>'severity','score',f->'score','rationale',(f->>'rationale')||suffix));
 end loop;
 if jsonb_array_length(items)<>n then raise exception 'projected coverage refused' using errcode='42501';end if;
 return jsonb_build_object('tenant_id',t,'engagement_id',e,'title',title,'kind','board','findings',items,
  'posture_score',p.result->'posture_score','estimated_exposure_inr',p.result->'estimated_exposure_inr',
  'library_version',p.library_version,'library_control_ids',ids,'reviewer_id',null);
end $$;

create table public.prativedan_assessment_sources (
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 source_id uuid primary key references public.agent_runs(id) on delete restrict,
 engagement_id uuid not null,
 source_text text not null check(octet_length(source_text) between 1 and 1048576),
 source_sha256 text not null check(source_sha256=controller_security.prativedan123_hash(source_text)),
 renderer_input_projection jsonb not null,
 captured_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,source_id),foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict
);
create function controller_security.prativedan123_config() returns text
language sql immutable set search_path='' as $$select $config${"agent":"prativedan","agent_version":"0.1.0","citation_policy":"explicit-canonical-nonzero-uuid-references-unverified","citation_verification":"unverified_references","exposure_divisor":10000000,"exposure_format":".2f","finding_limit":10,"finding_order":"numeric-finite-nonnegative-risk-desc-otherwise-source-order","html_escape":"python-html-escape-quote-true","html_findings_columns":["control_id","title","severity","score","risk_points"],"implementation":"deterministic-prativedan-sections-html-v1","model_identity":null,"model_inference":false,"posture_bands":[[85,"Strong"],[65,"Acceptable"],[40,"At Risk"],[0,"Critical"]],"posture_format":".0f","ranked_findings_title":"Top findings (by risk-weighted exposure)","renderer_config_version":"prativedan-draft-v1","review_required":true,"schema_version":1,"section_order":["executive_summary","findings_table","library","attribution"],"source_findings_title":"Findings for review (source order)","source_rationale_suffix":" [Draft assessment declaration: answer={answer_state}; applicability={applicability_state}; evidence unverified.]"}$config$::text$$;

create table public.prativedan_draft_requests (
 tenant_id uuid not null, operation_key uuid not null, source_id uuid not null,
 actor_id uuid not null references public.users(id) on delete restrict,
 run_id uuid not null unique default gen_random_uuid(),
 request_text text not null check(octet_length(request_text) between 1 and 4096),
 request_sha256 text not null check(request_sha256=controller_security.prativedan123_hash(request_text)),
 renderer_config_text text not null default controller_security.prativedan123_config()
  check(renderer_config_text=controller_security.prativedan123_config()),
 requested_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,operation_key),foreign key(tenant_id,source_id) references public.prativedan_assessment_sources(tenant_id,source_id) on delete restrict,
 check(operation_key<>'00000000-0000-0000-0000-000000000000'::uuid)
);
create table public.prativedan_draft_claims (
 tenant_id uuid not null, operation_key uuid not null,
 normalized_input_text text not null check(octet_length(normalized_input_text) between 1 and 1048576),
 runtime_normalized_input_sha256 text not null check(runtime_normalized_input_sha256=controller_security.prativedan123_hash(normalized_input_text)),
 claimed_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 claimed_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 primary key(tenant_id,operation_key),foreign key(tenant_id,operation_key) references public.prativedan_draft_requests(tenant_id,operation_key) on delete restrict,
 check(expires_at>claimed_at and expires_at<=claimed_at+interval '5 minutes')
);
create table public.prativedan_draft_outputs (
 draft_id uuid primary key default gen_random_uuid(),tenant_id uuid not null,operation_key uuid not null,
 runtime_output_text text not null check(octet_length(runtime_output_text) between 1 and 2097152),
 runtime_output_sha256 text not null check(runtime_output_sha256=controller_security.prativedan123_hash(runtime_output_text)),
 response_output_text text not null check(octet_length(response_output_text) between 1 and 2097152),
 response_output_sha256 text not null check(response_output_sha256=controller_security.prativedan123_hash(response_output_text)),
 started_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 completed_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 settled_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,operation_key),foreign key(tenant_id,operation_key) references public.prativedan_draft_claims(tenant_id,operation_key) on delete restrict,
 check(started_receipt<completed_receipt and completed_receipt<settled_receipt)
);
create table public.prativedan_draft_reviews (
 tenant_id uuid not null,operation_key uuid not null,review_key uuid not null,
 actor_id uuid not null references public.users(id) on delete restrict,
 decision text not null check(decision in ('accepted','rejected')),
 reason text not null check(length(reason) between 20 and 2000 and reason=btrim(reason)),
 response_output_sha256 text not null check(response_output_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,operation_key),unique(tenant_id,review_key),
 foreign key(tenant_id,operation_key) references public.prativedan_draft_outputs(tenant_id,operation_key) on delete restrict
);

create function controller_security.prativedan123_source(t uuid,e uuid,r uuid) returns text
language plpgsql security definer set search_path='' as $$
declare p public.workload_assessment_packets; i jsonb; s public.audit_ledger;c public.audit_ledger;f public.audit_ledger; result text;
begin
 i:=controller_security.prativedan123_input(t,e,r);
 select * into p from public.workload_assessment_packets where tenant_id=t and run_id=r and engagement_id=e;
 select * into s from public.audit_ledger where tenant_id=t and id=p.started_receipt;
 select * into c from public.audit_ledger where tenant_id=t and id=p.completed_receipt;
 select * into f from public.audit_ledger where tenant_id=t and id=p.finalized_receipt;
 if not(s.id<c.id and c.id<f.id) or p.completed_at>p.finalized_at
  or octet_length(p.controls::text)>524288 or octet_length(p.result::text)>524288
 then raise exception 'source ordering or bounds refused' using errcode='42501'; end if;
 result:=jsonb_build_object('schema_version',2,'serialization','postgres-jsonb-text-v1',
  'kind','prativedan_assessment_source','source_id',r,'tenant_id',t,'engagement_id',e,'assessment_run_id',r,
  'title',i->>'title','library_version',p.library_version,'controls_text',p.controls::text,'controls_sha256',p.library_digest,
  'result_text',p.result::text,'result_sha256',p.result_digest,'completed_at',p.completed_at,'finalized_at',p.finalized_at,
  'receipts',jsonb_build_object('started',jsonb_build_object('id',s.id::text,'entry_hash',s.entry_hash),
   'completed',jsonb_build_object('id',c.id::text,'entry_hash',c.entry_hash),'finalized',jsonb_build_object('id',f.id::text,'entry_hash',f.entry_hash)),
  'limitations',jsonb_build_array('Recorded questionnaire computation; no independent evidence verification.',
   'Current remediation state is not included.','Not a compliance certification or legal opinion.'))::text;
 if octet_length(result)>1048576 then raise exception 'source bytes refused' using errcode='22023'; end if;
 return result;
end $$;
create function public.preview_prativedan_assessment_source(t uuid,a uuid,e uuid,r uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare value text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501'; end if;
 if not controller_security.prativedan123_authority(t,a) then raise exception 'founder authority refused' using errcode='42501'; end if;
 -- Pure preview creates no row/receipt. Source identity is the completed run,
 -- not a board request. Timestamp output is stable across session time zones.
 perform set_config('TimeZone','UTC',true);
 value:=controller_security.prativedan123_source(t,e,r);
 return jsonb_build_object('source_text',value,'source_sha256',controller_security.prativedan123_hash(value),'publication_allowed',false);
end $$;

create function public.request_prativedan_assessment_draft(t uuid,a uuid,human_text text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare h jsonb;k uuid;e uuid;r uuid; value text;sh text;receipt bigint;runid uuid:=gen_random_uuid();old public.prativedan_draft_requests;s public.prativedan_assessment_sources;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501'; end if;
 if not controller_security.prativedan123_authority(t,a) then raise exception 'founder authority refused' using errcode='42501'; end if;
 h:=controller_security.prativedan123_json(human_text,4096);
 if jsonb_typeof(h) is distinct from 'object' or not(h ?& array['operationKey','engagementId','assessmentRunId','expectedSourceSha256','sourceReviewed'])
  or (h-array['operationKey','engagementId','assessmentRunId','expectedSourceSha256','sourceReviewed'])<>'{}'
  or h->'sourceReviewed' is distinct from 'true'::jsonb or jsonb_typeof(h->'expectedSourceSha256') is distinct from 'string'
  or h->>'expectedSourceSha256' !~ '^[a-f0-9]{64}$'
  or h->>'operationKey' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or h->>'engagementId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or h->>'assessmentRunId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 then raise exception 'human request refused' using errcode='22023'; end if;
 k:=(h->>'operationKey')::uuid;e:=(h->>'engagementId')::uuid;r:=(h->>'assessmentRunId')::uuid;
 if k='00000000-0000-0000-0000-000000000000' or e='00000000-0000-0000-0000-000000000000' or r='00000000-0000-0000-0000-000000000000'
 then raise exception 'nil request identity refused' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 select * into old from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 if found then
  if old.actor_id is distinct from a or old.request_text is distinct from human_text then raise exception 'draft request conflict' using errcode='22023'; end if;
  return jsonb_build_object('run_id',old.run_id,'operation_key',k,'requested_receipt',old.requested_receipt::text,'replayed',true);
 end if;
 perform set_config('TimeZone','UTC',true);
 value:=controller_security.prativedan123_source(t,e,r);sh:=controller_security.prativedan123_hash(value);
 if sh is distinct from h->>'expectedSourceSha256' then raise exception 'reviewed source changed' using errcode='42501'; end if;
 -- A second operation cannot overwrite the frozen source identity.
 insert into public.prativedan_assessment_sources(tenant_id,source_id,engagement_id,source_text,source_sha256,renderer_input_projection)
 values(t,r,e,value,sh,controller_security.prativedan123_input(t,e,r)) on conflict(source_id) do nothing;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=r;
 if s.source_text is distinct from value or s.engagement_id is distinct from e then raise exception 'source snapshot conflict' using errcode='42501'; end if;
 receipt:=public.append_ledger(t,k,'human',a::text,null,null,null,'prativedan.draft.requested',runid::text,
  controller_security.prativedan123_hash(human_text),sh,null,a,null,null,'success',
  jsonb_build_object('source_id',r,'engagement_id',e,'assessment_run_id',r,'run_id',runid,'operation_key',k,
   'renderer_config_version','prativedan-draft-v1','renderer_config_sha256','b6b22a3360126539085f1630cdb390396fc97ca72fc894259c7c4cb7bc3d0ba3',
   'publication_allowed',false,'source_reviewed',true));
 insert into public.prativedan_draft_requests(tenant_id,operation_key,source_id,actor_id,run_id,request_text,request_sha256,requested_receipt)
 values(t,k,r,a,runid,human_text,controller_security.prativedan123_hash(human_text),receipt);
 return jsonb_build_object('run_id',runid,'operation_key',k,'requested_receipt',receipt::text,'replayed',false);
end $$;

create function controller_security.prativedan123_receipt(t uuid,id bigint) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id::text,'entry_hash',entry_hash) from public.audit_ledger where tenant_id=t and audit_ledger.id=$2
$$;
create function controller_security.prativedan123_read(t uuid,k uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;s public.prativedan_assessment_sources;c public.prativedan_draft_claims;
 o public.prativedan_draft_outputs;v public.prativedan_draft_reviews;value jsonb;
begin
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 if not found then return jsonb_build_object('missing',true); end if;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into o from public.prativedan_draft_outputs where tenant_id=t and operation_key=k;
 select * into v from public.prativedan_draft_reviews where tenant_id=t and operation_key=k;
 perform controller_security.prativedan123_validate(t,k);
 value:=jsonb_build_object('schema_version',2,'kind','prativedan_unpublished_draft','tenant_id',t,'operation_key',k,
  'actor_id',q.actor_id,'source_id',s.source_id,'assessment_run_id',s.source_id,'engagement_id',s.engagement_id,'run_id',q.run_id,
  'source_text',s.source_text,'source_sha256',s.source_sha256,'request_text',q.request_text,'request_sha256',q.request_sha256,
  'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text),
  'renderer_config_text',q.renderer_config_text,'requested_receipt',controller_security.prativedan123_receipt(t,q.requested_receipt),
  'state',case when o.draft_id is not null then 'unpublished' when c.claimed_receipt is not null then 'invocation_uncertain' else 'requested' end,
  'publication_allowed',false,'review_required',true,'citation_verification','unverified_references');
 if c.claimed_receipt is not null then
  value:=value||jsonb_build_object('claimed_receipt',controller_security.prativedan123_receipt(t,c.claimed_receipt),
   'normalized_input_text',c.normalized_input_text,'runtime_normalized_input_sha256',c.runtime_normalized_input_sha256,
   'claim_expires_at',c.expires_at);
 end if;
 if o.draft_id is not null then
  value:=value||jsonb_build_object('draft_id',o.draft_id,'runtime_output_text',o.runtime_output_text,'runtime_output_sha256',o.runtime_output_sha256,
   'response_output_text',o.response_output_text,'response_output_sha256',o.response_output_sha256,'output',o.response_output_text::jsonb,
   'started_receipt',controller_security.prativedan123_receipt(t,o.started_receipt),
   'completed_receipt',controller_security.prativedan123_receipt(t,o.completed_receipt),'settled_receipt',controller_security.prativedan123_receipt(t,o.settled_receipt));
 end if;
 if v.reviewed_receipt is not null then value:=value||jsonb_build_object('review',jsonb_build_object('actor_id',v.actor_id,
  'review_key',v.review_key,'decision',v.decision,'reason',v.reason,'response_output_sha256',v.response_output_sha256,
  'receipt',controller_security.prativedan123_receipt(t,v.reviewed_receipt)));end if;
 return value;
end $$;
create function public.read_prativedan_assessment_draft(t uuid,a uuid,human_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h jsonb;q public.prativedan_draft_requests;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501'; end if;
 if not controller_security.prativedan123_authority(t,a) then raise exception 'founder authority refused' using errcode='42501'; end if;
 h:=controller_security.prativedan123_json(human_text,4096);
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=(h->>'operationKey')::uuid;
 if not found then return jsonb_build_object('missing',true); end if;
 if q.actor_id is distinct from a or q.request_text is distinct from human_text then raise exception 'original request refused' using errcode='42501';end if;
 return controller_security.prativedan123_read(t,q.operation_key);
end $$;
create function controller_security.prativedan123_runtime_request(t uuid,k uuid,r uuid,rh text)
returns public.prativedan_draft_requests language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;
begin
 if current_setting('role',true) is distinct from 'agent_ledger_writer' then raise exception 'agent writer required' using errcode='42501'; end if;
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 if not found or q.run_id is distinct from r or q.request_sha256 is distinct from rh
 then raise exception 'recorded request required' using errcode='42501'; end if;
 if not controller_security.prativedan123_authority(t,q.actor_id) then raise exception 'request authority changed' using errcode='42501'; end if;
 return q;
end $$;
create function public.load_prativedan_assessment_dispatch(t uuid,k uuid,r uuid,rh text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;
begin
 q:=controller_security.prativedan123_runtime_request(t,k,r,rh);
 return controller_security.prativedan123_read(t,k);
end $$;
create function public.claim_prativedan_assessment_draft(t uuid,k uuid,r uuid,rh text,input_text text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare q public.prativedan_draft_requests;s public.prativedan_assessment_sources;c public.prativedan_draft_claims;
 i jsonb;ih text;receipt bigint;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 q:=controller_security.prativedan123_runtime_request(t,k,r,rh);
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 i:=controller_security.prativedan123_json(input_text,1048576);ih:=controller_security.prativedan123_hash(input_text);
 -- Structural business-value equality only. PG text never stands in for the
 -- Python-normalized byte domain, which is retained and hashed separately.
 if i is distinct from s.renderer_input_projection then raise exception 'normalized source projection refused' using errcode='42501';end if;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 if found then
  if c.normalized_input_text is distinct from input_text then raise exception 'claim input conflict' using errcode='42501';end if;
  return jsonb_build_object('claimed',false,'invocation_uncertain',true,'readback',controller_security.prativedan123_read(t,k));
 end if;
 stamp:=clock_timestamp();
 receipt:=public.append_ledger(t,k,'system','prativedan-draft-controller','0.1.0',null,null,'prativedan.draft.claimed',r::text,
  ih,null,null,null,null,null,'pending',jsonb_build_object('run_id',r,'request_hash',rh,'source_sha256',s.source_sha256,
   'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text),'one_shot',true));
 insert into public.prativedan_draft_claims(tenant_id,operation_key,normalized_input_text,runtime_normalized_input_sha256,claimed_receipt,claimed_at,expires_at)
 values(t,k,input_text,ih,receipt,stamp,stamp+interval '5 minutes');
 return jsonb_build_object('claimed',true,'expires_at',stamp+interval '5 minutes','readback',controller_security.prativedan123_read(t,k));
end $$;

create function controller_security.prativedan123_runtime_valid(t uuid,k uuid,started bigint,completed bigint,oh text)
returns boolean language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;c public.prativedan_draft_claims;s public.prativedan_assessment_sources;
 first public.audit_ledger;last public.audit_ledger;entry public.audit_ledger;
begin
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 select * into first from public.audit_ledger where tenant_id=t and id=started;
 select * into last from public.audit_ledger where tenant_id=t and id=completed;
 if q.run_id is null or c.claimed_receipt is null or first.id is null or last.id is null
  or not(q.requested_receipt<c.claimed_receipt and c.claimed_receipt<first.id and first.id<last.id)
  or last.occurred_at>c.expires_at
  or first.result<>'pending' or last.result<>'success'
  or first.detail->>'phase' is distinct from 'started' or last.detail->>'phase' is distinct from 'completed'
  or last.detail->>'started_entry' is distinct from first.id::text or last.output_hash is distinct from oh
 then return false; end if;
 foreach entry in array array[first,last] loop
  if entry.actor_type<>'agent' or entry.actor_id is distinct from 'prativedan' or entry.agent_version is distinct from '0.1.0'
   or entry.action_type::text is distinct from 'report.generated' or entry.correlation_id is distinct from k
   or entry.target_ref is distinct from s.engagement_id::text or entry.input_hash is distinct from c.runtime_normalized_input_sha256
   or entry.detail->>'run_id' is distinct from q.run_id::text or entry.detail->>'request_hash' is distinct from q.request_sha256
   or entry.detail->>'renderer_config_version' is distinct from 'prativedan-draft-v1'
   or entry.detail->>'renderer_config_sha256' is distinct from controller_security.prativedan123_hash(q.renderer_config_text)
  then return false;end if;
 end loop;
 return true;
end $$;

create function controller_security.prativedan123_output_valid(i jsonb,o jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare expected jsonb;sections jsonb;
begin
 if jsonb_typeof(o) is distinct from 'object'
  or not(o ?& array['title','kind','sections','cited_evidence_ids','generated_by_agent','rendered_html','review_required','citation_verification'])
  or (o-array['title','kind','sections','cited_evidence_ids','generated_by_agent','rendered_html','review_required','citation_verification'])<>'{}'
  or o->>'title' is distinct from i->>'title' or o->>'kind' is distinct from 'board'
  or o->>'generated_by_agent' is distinct from 'prativedan' or o->'cited_evidence_ids' is distinct from '[]'::jsonb
  or o->'review_required' is distinct from 'true'::jsonb or o->>'citation_verification' is distinct from 'unverified_references'
  or jsonb_typeof(o->'rendered_html') is distinct from 'string' or octet_length(o->>'rendered_html') not between 1 and 2097152
  or jsonb_typeof(o->'sections') is distinct from 'array' then return false;end if;
 sections:=o->'sections';if jsonb_array_length(sections)<>4 then return false;end if;
 select coalesce(jsonb_agg(v||jsonb_build_object('risk_points',null) order by ord),'[]') into expected
  from jsonb_array_elements(i->'findings') with ordinality x(v,ord) where ord<=10;
 return coalesce(sections->1=jsonb_build_object('type','findings_table','title','Findings for review (source order)','items',expected)
  and sections->2=jsonb_build_object('type','library','title','Control library','body',
   'Referenced library version: '||(i->>'library_version')||'. Draft input declares '||jsonb_array_length(i->'library_control_ids')::text||' controls; frozen source verification remains required.')
  and sections->3=jsonb_build_object('type','attribution','title','Draft attribution and review status','body',
   'Generated by Prativedan (v0.1.0). Pending recorded human review. Evidence references are unverified.')
  and jsonb_typeof(sections->0)='object' and ((sections->0)-array['type','title','body'])='{}'
  and sections#>>'{0,type}'='executive_summary' and sections#>>'{0,title}'='Executive summary'
  and jsonb_typeof(sections#>'{0,body}')='string' and octet_length(sections#>>'{0,body}') between 1 and 32000,false);
 -- Exact HTML/template numeric rendering is a future version2 BFF semantic
 -- integration gate; this unmounted store does not claim published fidelity.
end $$;
create function public.settle_prativedan_assessment_draft(t uuid,k uuid,r uuid,rh text,input_hash text,
 config_text text,output_text text,response_text text,started bigint,completed bigint) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare q public.prativedan_draft_requests;c public.prativedan_draft_claims;s public.prativedan_assessment_sources;
 o public.prativedan_draft_outputs;body jsonb;response jsonb;oh text;receipt bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 q:=controller_security.prativedan123_runtime_request(t,k,r,rh);
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 if c.claimed_receipt is null or c.runtime_normalized_input_sha256 is distinct from input_hash or config_text is distinct from q.renderer_config_text
 then raise exception 'claimed scope refused' using errcode='42501';end if;
 select * into o from public.prativedan_draft_outputs where tenant_id=t and operation_key=k;
 if found then
  if o.runtime_output_text is distinct from output_text or o.response_output_text is distinct from response_text
   or o.started_receipt is distinct from started or o.completed_receipt is distinct from completed
  then raise exception 'settlement conflict' using errcode='42501';end if;
  return controller_security.prativedan123_read(t,k)||jsonb_build_object('replayed',true);
 end if;
 if clock_timestamp()>c.expires_at then raise exception 'claim completion expired' using errcode='42501';end if;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 body:=controller_security.prativedan123_json(output_text,2097152);response:=controller_security.prativedan123_json(response_text,2097152);
 oh:=controller_security.prativedan123_hash(output_text);
 if body is distinct from response or controller_security.prativedan123_output_valid(s.renderer_input_projection,body) is distinct from true
  or controller_security.prativedan123_runtime_valid(t,k,started,completed,oh) is distinct from true
 then raise exception 'runtime proof refused' using errcode='42501';end if;
 receipt:=public.append_ledger(t,k,'system','prativedan-draft-controller','0.1.0',null,null,'prativedan.draft.settled',r::text,
  input_hash,oh,null,null,null,null,'success',jsonb_build_object('run_id',r,'request_hash',rh,'source_sha256',s.source_sha256,
   'response_output_sha256',controller_security.prativedan123_hash(response_text),'started_receipt',started::text,'completed_receipt',completed::text,
   'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(config_text),'publication_allowed',false));
 if clock_timestamp()>c.expires_at then raise exception 'claim expired during settlement' using errcode='42501';end if;
 insert into public.prativedan_draft_outputs(tenant_id,operation_key,runtime_output_text,runtime_output_sha256,response_output_text,response_output_sha256,
  started_receipt,completed_receipt,settled_receipt) values(t,k,output_text,oh,response_text,controller_security.prativedan123_hash(response_text),started,completed,receipt);
 return controller_security.prativedan123_read(t,k)||jsonb_build_object('replayed',false);
end $$;
create function public.review_prativedan_assessment_draft(t uuid,a uuid,k uuid,review_key uuid,expected_hash text,decision text,reason text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare q public.prativedan_draft_requests;o public.prativedan_draft_outputs;v public.prativedan_draft_reviews;receipt bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if not controller_security.prativedan123_authority(t,a) then raise exception 'founder authority refused' using errcode='42501';end if;
 if review_key is null or review_key='00000000-0000-0000-0000-000000000000' or decision is null or decision not in ('accepted','rejected')
  or reason is null or length(reason) not between 20 and 2000 or reason<>btrim(reason)
 then raise exception 'human review refused' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 select * into o from public.prativedan_draft_outputs where tenant_id=t and operation_key=k;
 if q.run_id is null or o.draft_id is null or o.response_output_sha256 is distinct from expected_hash then raise exception 'reviewed draft mismatch' using errcode='42501';end if;
 select * into v from public.prativedan_draft_reviews where tenant_id=t and operation_key=k;
 if found then
  if v.actor_id is distinct from a or v.review_key is distinct from review_key or v.decision is distinct from decision or v.reason is distinct from reason
  then raise exception 'human review conflict' using errcode='42501';end if;
  return jsonb_build_object('reviewed_receipt',v.reviewed_receipt::text,'publication_allowed',false,'replayed',true);
 end if;
 receipt:=public.append_ledger(t,review_key,'human',a::text,null,null,null,'prativedan.draft.reviewed',o.draft_id::text,
  expected_hash,null,null,a,null,null,'success',jsonb_build_object('operation_key',k,'review_key',review_key,'decision',decision,'reason',reason,'publication_allowed',false));
 insert into public.prativedan_draft_reviews(tenant_id,operation_key,review_key,actor_id,decision,reason,response_output_sha256,reviewed_receipt)
 values(t,k,review_key,a,decision,reason,expected_hash,receipt);
 return jsonb_build_object('reviewed_receipt',receipt::text,'publication_allowed',false,'replayed',false);
end $$;

-- Deferred checks close accidental privileged INSERT paths as well as RPCs.
-- Dedicated ledger events without their exact journal are refused at commit.
create function controller_security.prativedan123_validate(t uuid,k uuid) returns void
language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;s public.prativedan_assessment_sources;c public.prativedan_draft_claims;
 o public.prativedan_draft_outputs;v public.prativedan_draft_reviews;l public.audit_ledger;h jsonb;
begin
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 select * into l from public.audit_ledger where tenant_id=t and id=q.requested_receipt;
 h:=controller_security.prativedan123_json(q.request_text,4096);
 if q.run_id is null or s.source_id is null or l.id is null or q.requested_receipt<=(s.source_text::jsonb#>>'{receipts,finalized,id}')::bigint
  or h is distinct from jsonb_build_object('operationKey',k,'engagementId',s.engagement_id,'assessmentRunId',s.source_id,'expectedSourceSha256',s.source_sha256,'sourceReviewed',true)
  or l.action_type::text is distinct from 'prativedan.draft.requested' or l.actor_type<>'human' or l.actor_id is distinct from q.actor_id::text
  or l.correlation_id is distinct from k or l.target_ref is distinct from q.run_id::text or l.result<>'success'
  or l.input_hash is distinct from q.request_sha256 or l.output_hash is distinct from s.source_sha256
  or l.detail->>'source_id' is distinct from s.source_id::text or l.detail->>'run_id' is distinct from q.run_id::text
  or l.detail->>'engagement_id' is distinct from s.engagement_id::text or l.detail->'source_reviewed' is distinct from 'true'::jsonb
  or l.detail->>'renderer_config_sha256' is distinct from controller_security.prativedan123_hash(q.renderer_config_text)
  or l.detail->>'renderer_config_version' is distinct from 'prativedan-draft-v1' or l.detail->'publication_allowed' is distinct from 'false'::jsonb
 then raise exception 'request journal proof refused' using errcode='42501';end if;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 if c.claimed_receipt is not null then
  select * into l from public.audit_ledger where tenant_id=t and id=c.claimed_receipt;
  if l.id is null or l.id<=q.requested_receipt or l.action_type::text is distinct from 'prativedan.draft.claimed'
   or l.actor_type<>'system' or l.actor_id is distinct from 'prativedan-draft-controller' or l.correlation_id is distinct from k
   or l.target_ref is distinct from q.run_id::text or l.result<>'pending' or l.input_hash is distinct from c.runtime_normalized_input_sha256
   or l.detail->>'request_hash' is distinct from q.request_sha256 or l.detail->>'source_sha256' is distinct from s.source_sha256
   or l.detail->>'renderer_config_sha256' is distinct from controller_security.prativedan123_hash(q.renderer_config_text)
   or l.detail->'one_shot' is distinct from 'true'::jsonb
   or controller_security.prativedan123_json(c.normalized_input_text,1048576) is distinct from s.renderer_input_projection
  then raise exception 'claim journal proof refused' using errcode='42501';end if;
 end if;
 select * into o from public.prativedan_draft_outputs where tenant_id=t and operation_key=k;
 if o.draft_id is not null then
  select * into l from public.audit_ledger where tenant_id=t and id=o.settled_receipt;
  if o.recorded_at>c.expires_at or controller_security.prativedan123_runtime_valid(t,k,o.started_receipt,o.completed_receipt,o.runtime_output_sha256) is distinct from true
   or l.id is null or l.action_type::text is distinct from 'prativedan.draft.settled' or l.actor_type<>'system'
   or l.actor_id is distinct from 'prativedan-draft-controller' or l.correlation_id is distinct from k or l.target_ref is distinct from q.run_id::text
   or l.result<>'success' or l.input_hash is distinct from c.runtime_normalized_input_sha256 or l.output_hash is distinct from o.runtime_output_sha256
   or l.detail->>'response_output_sha256' is distinct from o.response_output_sha256 or l.detail->>'source_sha256' is distinct from s.source_sha256
   or l.detail->>'request_hash' is distinct from q.request_sha256
   or l.detail->>'started_receipt' is distinct from o.started_receipt::text or l.detail->>'completed_receipt' is distinct from o.completed_receipt::text
   or l.detail->'publication_allowed' is distinct from 'false'::jsonb
   or controller_security.prativedan123_json(o.response_output_text,2097152) is distinct from controller_security.prativedan123_json(o.runtime_output_text,2097152)
   or controller_security.prativedan123_output_valid(s.renderer_input_projection,o.runtime_output_text::jsonb) is distinct from true
  then raise exception 'settlement journal proof refused' using errcode='42501';end if;
 end if;
 select * into v from public.prativedan_draft_reviews where tenant_id=t and operation_key=k;
 if v.reviewed_receipt is not null then
  select * into l from public.audit_ledger where tenant_id=t and id=v.reviewed_receipt;
  if l.id is null or l.id<=o.settled_receipt or l.action_type::text is distinct from 'prativedan.draft.reviewed' or l.actor_type<>'human'
   or l.actor_id is distinct from v.actor_id::text or l.correlation_id is distinct from v.review_key or l.target_ref is distinct from o.draft_id::text
   or l.input_hash is distinct from o.response_output_sha256 or v.response_output_sha256 is distinct from o.response_output_sha256 or l.result<>'success'
   or l.detail->>'decision' is distinct from v.decision or l.detail->>'reason' is distinct from v.reason
   or l.detail->>'operation_key' is distinct from k::text or l.detail->'publication_allowed' is distinct from 'false'::jsonb
  then raise exception 'review journal proof refused' using errcode='42501';end if;
 end if;
end $$;
create function controller_security.prativedan123_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare k uuid;source_value text;
begin
 if tg_table_name='prativedan_assessment_sources' then
  perform set_config('TimeZone','UTC',true);
  source_value:=controller_security.prativedan123_source(new.tenant_id,new.engagement_id,new.source_id);
  if new.source_text is distinct from source_value
   or new.renderer_input_projection is distinct from controller_security.prativedan123_input(new.tenant_id,new.engagement_id,new.source_id)
   or not exists(select 1 from public.prativedan_draft_requests where tenant_id=new.tenant_id and source_id=new.source_id)
  then raise exception 'source journal proof refused' using errcode='42501';end if;
  return new;
 elsif tg_table_name='audit_ledger' then
  if new.action_type::text='prativedan.draft.reviewed' then
   select operation_key into k from public.prativedan_draft_reviews where tenant_id=new.tenant_id and reviewed_receipt=new.id;
  elsif new.action_type::text='prativedan.draft.requested' then
   select operation_key into k from public.prativedan_draft_requests where tenant_id=new.tenant_id and requested_receipt=new.id;
  elsif new.action_type::text='prativedan.draft.claimed' then
   select operation_key into k from public.prativedan_draft_claims where tenant_id=new.tenant_id and claimed_receipt=new.id;
  elsif new.action_type::text='prativedan.draft.settled' then
   select operation_key into k from public.prativedan_draft_outputs where tenant_id=new.tenant_id and settled_receipt=new.id;
  end if;
  if k is null then raise exception 'orphan draft ledger event refused' using errcode='42501';end if;
 else k:=new.operation_key;end if;
 perform controller_security.prativedan123_validate(new.tenant_id,k);
 return new;
end $$;
create function controller_security.prativedan123_no_truncate() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'draft journal truncate refused' using errcode='42501';end $$;
do $$declare tab text;begin
 foreach tab in array array['prativedan_assessment_sources','prativedan_draft_requests','prativedan_draft_claims','prativedan_draft_outputs','prativedan_draft_reviews'] loop
  execute format('alter table public.%I enable row level security',tab);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer',tab);
  execute format('create trigger draft_immutable before update or delete on public.%I for each row execute function public.evidence_receipt_immutable()',tab);
  execute format('create trigger draft_no_truncate before truncate on public.%I for each statement execute function controller_security.prativedan123_no_truncate()',tab);
  execute format('create constraint trigger draft_receipt_binding after insert on public.%I deferrable initially deferred for each row execute function controller_security.prativedan123_binding()',tab);
 end loop;
end $$;
create constraint trigger prativedan_draft_ledger_binding after insert on public.audit_ledger deferrable initially deferred
 for each row when(new.action_type::text in ('prativedan.draft.requested','prativedan.draft.claimed','prativedan.draft.settled','prativedan.draft.reviewed'))
 execute function controller_security.prativedan123_binding();
-- No generic SELECT/DML grants. Authority-bearing APIs require the matching
-- scoped writer role even when invoked by a privileged test/session account.
do $$declare f record;begin
 for f in select p.oid::regprocedure signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='controller_security' and p.proname like 'prativedan123_%')
   or (n.nspname='public' and p.proname in ('preview_prativedan_assessment_source','request_prativedan_assessment_draft',
    'read_prativedan_assessment_draft','load_prativedan_assessment_dispatch','claim_prativedan_assessment_draft','settle_prativedan_assessment_draft','review_prativedan_assessment_draft')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer',f.signature);
  if f.nspname='public' then
   execute format('grant execute on function %s to %I',f.signature,case when f.proname in ('load_prativedan_assessment_dispatch',
    'claim_prativedan_assessment_draft','settle_prativedan_assessment_draft') then 'agent_ledger_writer' else 'human_action_writer' end);
  end if;
 end loop;
end $$;
