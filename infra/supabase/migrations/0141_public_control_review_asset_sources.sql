-- Versioned human-declared website asset scope. Existing immutable v1 bytes remain unchanged.
-- No URL fetch, credential grant, agent mutation or ownership assertion is introduced.
alter table public.public_control_review_sets drop constraint public_control_review_sets_request_codec_check;
alter table public.public_control_review_sets add constraint public_control_review_sets_request_codec_check check(request_codec in ('axiom-public-control-review-request-canonical-json-1','axiom-public-control-review-request-canonical-json-2'));
alter table public.public_control_review_sets drop constraint public_control_review_sets_snapshot_codec_check;
alter table public.public_control_review_sets add constraint public_control_review_sets_snapshot_codec_check check(snapshot_codec in ('axiom-public-control-review-snapshot-pg-canonical-json-1','axiom-public-control-review-snapshot-pg-canonical-json-2'));
alter table public.public_control_review_sets add constraint public_control_review_codec_pair141 check ((request_codec='axiom-public-control-review-request-canonical-json-2')=(snapshot_codec='axiom-public-control-review-snapshot-pg-canonical-json-2'));
alter table public.public_control_review_cancellations drop constraint public_control_review_cancellations_request_codec_check;
alter table public.public_control_review_cancellations add constraint public_control_review_cancellations_request_codec_check check(request_codec in ('axiom-public-control-review-request-canonical-json-1','axiom-public-control-review-request-canonical-json-2'));

-- Exact existing review ASSESSMENT_RUN matrix (0134), independent of the
-- narrower existing Parikshan workload dispatch gate. No authority is widened.
create function controller_security.review141_authorized(t uuid,a uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id
 where m.tenant_id=t and m.user_id=a and m.role in ('founder','axiom_analyst','owner','admin','reviewer')
 and (m.role not in ('founder','axiom_analyst') or u.is_axiom_internal is true))
$$;
create function controller_security.review141_v1_request(v jsonb) returns jsonb language sql immutable set search_path='' as $$ select (v-'associationRef')||jsonb_build_object('version',1) $$;
create function controller_security.review141_shape(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare ref jsonb;x text;
begin
 if v->'version'='1'::jsonb then return controller_security.public_control_review_request_shape(v);end if;
 if v->'version' is distinct from '2'::jsonb or v->>'version' is distinct from '2' or not controller_security.public_control_review_request_shape(controller_security.review141_v1_request(v)) or v->'expectedEstateId'='null'::jsonb then return false;end if;
 ref:=v->'associationRef';
 if jsonb_typeof(ref) is distinct from 'object' or not(ref?&array['associationId','associationSha256','targetId','targetSha256','associationReceipt']) or ref-array['associationId','associationSha256','targetId','targetSha256','associationReceipt']<>'{}'::jsonb then return false;end if;
 foreach x in array array['associationId','targetId'] loop
 if jsonb_typeof(ref->x) is distinct from 'string' or ref->>x !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then return false;end if;end loop;
 foreach x in array array['associationSha256','targetSha256'] loop
 if jsonb_typeof(ref->x) is distinct from 'string' or ref->>x !~ '^[a-f0-9]{64}$' then return false;end if;end loop;
 ref:=ref->'associationReceipt';
 return coalesce(jsonb_typeof(ref)='object' and ref-array['id','entryHash']='{}'::jsonb and jsonb_typeof(ref->'id')='string' and ref->>'id' ~ '^[1-9][0-9]{0,18}$' and (ref->>'id')::numeric<=9223372036854775807 and jsonb_typeof(ref->'entryHash')='string' and ref->>'entryHash' ~ '^[a-f0-9]{64}$',false);
 exception when others then return false;
end $$;

-- Read immutable provenance under trusted SQL custody; current-state checks are
-- deliberately separate so historical accepted jobs never acquire freshness gates.
create function controller_security.review141_assets(t uuid,v jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.public_website_asset_associations;target public.public_website_targets;
 ao public.public_website_asset_operations;tope public.public_website_asset_operations;al public.audit_ledger;tl public.audit_ledger;
 p public.public_website_control_evidence;c public.public_website_checks;cl public.audit_ledger;ref jsonb:=v->'associationRef';result jsonb;
begin
 if v->'version' is distinct from '2'::jsonb or not controller_security.review141_shape(v) then raise exception 'asset review refused' using errcode='22023';end if;
 select * into a from public.public_website_asset_associations where tenant_id=t and id=(ref->>'associationId')::uuid;
 select * into target from public.public_website_targets where tenant_id=t and id=a.target_id;
 select * into ao from public.public_website_asset_operations where tenant_id=t and id=a.operation_id;
 select * into tope from public.public_website_asset_operations where tenant_id=t and id=target.operation_id;
 select * into al from public.audit_ledger where tenant_id=t and id=ao.receipt_id;
 select * into tl from public.audit_ledger where tenant_id=t and id=tope.receipt_id;
 select * into p from public.public_website_control_evidence where tenant_id=t and check_id=a.check_id;
 select * into c from public.public_website_checks where tenant_id=t and id=a.check_id;
 select * into cl from public.audit_ledger where tenant_id=t and id=p.capture_receipt;
 if a.id is null or target.id is null or ao.id is null or tope.id is null or al.id is null or tl.id is null or cl.id is null or p.check_id is null or c.id is null
 or a.snapshot_sha256 is distinct from ref->>'associationSha256' or target.id::text is distinct from ref->>'targetId' or target.snapshot_sha256 is distinct from ref->>'targetSha256'
 or al.id::text is distinct from ref->'associationReceipt'->>'id' or al.entry_hash is distinct from ref->'associationReceipt'->>'entryHash'
 or target.estate_id::text is distinct from v->>'expectedEstateId' or a.check_id::text is distinct from v->>'checkId'
 or a.payload_sha256 is distinct from v->'expectedSource'->>'payloadSha256' or a.payload_sha256 is distinct from p.payload_sha256 or a.capture_receipt is distinct from p.capture_receipt
 or a.target_sha256 is distinct from target.snapshot_sha256 or c.requested_url is distinct from target.url
 or ao.kind not in ('associate_capture','capture') or tope.kind<>'register_target'
 or ao.snapshot_text is distinct from a.snapshot_text or tope.snapshot_text is distinct from target.snapshot_text
 or ao.snapshot_sha256 is distinct from a.snapshot_sha256 or tope.snapshot_sha256 is distinct from target.snapshot_sha256
 or ao.request_sha256 is distinct from encode(sha256(convert_to(ao.request_text,'UTF8')),'hex') or tope.request_sha256 is distinct from encode(sha256(convert_to(tope.request_text,'UTF8')),'hex')
 or ao.snapshot_sha256 is distinct from encode(sha256(convert_to(ao.snapshot_text,'UTF8')),'hex') or tope.snapshot_sha256 is distinct from encode(sha256(convert_to(tope.snapshot_text,'UTF8')),'hex')
 or al.action_type::text<>'connector.website.asset_associated' or tl.action_type::text<>'connector.website.target_registered'
 or al.actor_type::text<>'human' or tl.actor_type::text<>'human' or al.actor_id is distinct from ao.actor_id::text or tl.actor_id is distinct from tope.actor_id::text
 or al.correlation_id is distinct from ao.operation_key or tl.correlation_id is distinct from tope.operation_key
 or al.target_ref is distinct from a.id::text or tl.target_ref is distinct from target.id::text
 or al.input_hash is distinct from ao.request_sha256 or tl.input_hash is distinct from tope.request_sha256
 or al.output_hash is distinct from ao.snapshot_sha256 or tl.output_hash is distinct from tope.snapshot_sha256
 or al.result::text<>'success' or tl.result::text<>'success'
 or cl.action_type::text<>'connector.website.evidence_captured' or cl.target_ref is distinct from c.id::text
 or cl.input_hash is distinct from p.payload_sha256 or cl.output_hash is distinct from encode(sha256(convert_to(p.page_sources::text,'UTF8')),'hex')
 then raise exception 'asset review provenance refused' using errcode='22023';end if;
 perform controller_security.website_asset139_request(ao.request_text);perform controller_security.website_asset139_request(tope.request_text);
 select jsonb_build_object('schema_version',1,'kind','public_website_asset_binding','tenant_id',t,'estate_id',target.estate_id,'system_id',target.system_id,
 'target',jsonb_build_object('actor_id',tope.actor_id,'operation_key',tope.operation_key,'request_codec','axiom-public-website-asset-request-canonical-json-1','request_text',tope.request_text,'request_sha256',tope.request_sha256,'snapshot_codec','axiom-public-website-asset-snapshot-canonical-json-1','snapshot_text',tope.snapshot_text,'snapshot_sha256',tope.snapshot_sha256,'receipt',jsonb_build_object('id',tl.id::text,'entry_hash',tl.entry_hash)),
 'association',jsonb_build_object('actor_id',ao.actor_id,'operation_key',ao.operation_key,'request_codec','axiom-public-website-asset-request-canonical-json-1','request_text',ao.request_text,'request_sha256',ao.request_sha256,'snapshot_codec','axiom-public-website-asset-snapshot-canonical-json-1','snapshot_text',ao.snapshot_text,'snapshot_sha256',ao.snapshot_sha256,'receipt',jsonb_build_object('id',al.id::text,'entry_hash',al.entry_hash)),
 'ownership_verified',false,'connector_access_granted',false,'review_required',true) into result;
 return result;
end $$;

-- Acquired before HEAD by every initial v1/v2 resolver/enqueue path. Authority
-- remains ASSESSMENT_RUN, never the manager-only 139_current helper.
create function controller_security.review141_prelock(t uuid,a uuid,eid uuid,estate uuid,v jsonb,job boolean) returns void
language plpgsql security definer set search_path='' as $$
declare e public.estates;s public.estate_systems;eng public.engagements;asset jsonb;sid uuid;
begin
 lock table public.controls,public.control_libraries in share mode;
 perform pg_advisory_xact_lock(139,hashtext(t::text));
 if v->'version'='2'::jsonb then asset:=controller_security.review141_assets(t,v);sid:=(asset->>'system_id')::uuid;end if;
 select * into e from public.estates where tenant_id=t and id=estate for share;
 if sid is not null then select * into s from public.estate_systems where tenant_id=t and id=sid for share;end if;
 if job then select * into eng from public.engagements where tenant_id=t and id=eid for update;
 else select * into eng from public.engagements where tenant_id=t and id=eid for share;end if;
 -- Separate explicit check avoids any implicit coercion of a JSON commitment.
 if v->'version'='2'::jsonb then
  if e.id is null or s.id is null or eng.id is null or eng.estate_id is distinct from e.id or e.status<>'active' or s.status<>'active' or s.estate_id is distinct from e.id
  or e.version is distinct from (((asset->'target'->>'snapshot_text')::jsonb)->>'estateVersion')::integer
  or s.version is distinct from (((asset->'target'->>'snapshot_text')::jsonb)->>'systemVersion')::integer
  or controller_security.website_asset139_withdrawn(t,'target',(v->'associationRef'->>'targetId')::uuid)
  or controller_security.website_asset139_withdrawn(t,'association',(v->'associationRef'->>'associationId')::uuid)
  then raise exception 'asset review inventory changed' using errcode='22023';end if;
 end if;
end $$;

create function controller_security.review141_record_v1(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
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

create function controller_security.review141_record_v2(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;ctx jsonb;old public.public_control_review_sets;head public.public_control_review_sets;r public.public_control_review_sets;
 normalized jsonb:='{}';questions jsonb;ctrl jsonb;q jsonb;snapshot jsonb;snapshot_text text;rid uuid:=gen_random_uuid();receipt bigint;assets jsonb;
begin
 if p_request_text is null or octet_length(p_request_text)>131072 then return jsonb_build_object('error','invalid_record');end if;
 begin v:=p_request_text::jsonb;
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text then return jsonb_build_object('error','invalid_record');end if;
 if not controller_security.review141_shape(v) or v->'version' is distinct from '2'::jsonb then return jsonb_build_object('error','invalid_record');end if;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not controller_security.review141_authorized(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden');end if;
 -- Positive immutable replay does not require today's inventory to remain active.
 select * into old from public.public_control_review_sets where tenant_id=p_tenant_id and operation_key=(v->>'operationKey')::uuid;
 if found then
  if old.actor_id<>p_actor_id or old.request_text<>p_request_text then return jsonb_build_object('error','idempotency_conflict');end if;
  return jsonb_build_object('data',to_jsonb(old)||jsonb_build_object('receipt_id',old.receipt_id::text),'replayed',true);
 end if;
 perform controller_security.review141_prelock(p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'expectedEstateId')::uuid,v,false);
 assets:=controller_security.review141_assets(p_tenant_id,v);
 ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid,true);
 exception when invalid_text_representation then return jsonb_build_object('error','invalid_record');end;
 if ctx?'error' then return ctx;end if;
 if not controller_security.review141_shape(v) or not controller_security.public_control_review_request_valid(controller_security.review141_v1_request(v),ctx) then return jsonb_build_object('error','invalid_record');end if;
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
 snapshot:=jsonb_build_object('version',2,'assetProvenance',assets,'tenantId',p_tenant_id,'engagementId',v->'engagementId','estateId',ctx->'estateId','checkId',v->'checkId','checkedAt',ctx->'checkedAt','captureReceipt',ctx->'captureReceipt','request',v,'normalizedAnswers',normalized,'declarationsVerified',false,'requiresHumanReview',true);
 snapshot_text:=controller_security.canonical_questionnaire_json(snapshot);
 receipt:=public.append_ledger(p_tenant_id,(v->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'public_control.review_recorded',rid::text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),encode(sha256(convert_to(snapshot_text,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('engagement_id',v->'engagementId','check_id',v->'checkId','previous_review_id',head.id,'declarations_verified',false));
 insert into public.public_control_review_sets(id,tenant_id,engagement_id,estate_id,check_id,previous_review_id,actor_id,operation_key,request_codec,request_text,request_sha256,snapshot_codec,snapshot_text,snapshot_sha256,receipt_id)
 values(rid,p_tenant_id,(v->>'engagementId')::uuid,(ctx->>'estateId')::uuid,(v->>'checkId')::uuid,head.id,p_actor_id,(v->>'operationKey')::uuid,'axiom-public-control-review-request-canonical-json-2',p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),'axiom-public-control-review-snapshot-pg-canonical-json-2',snapshot_text,encode(sha256(convert_to(snapshot_text,'UTF8')),'hex'),receipt) returning * into r;
 return jsonb_build_object('data',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),'replayed',false);
end $$;
create or replace function public.record_public_control_review_set(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;ctx jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if p_request_text is null or octet_length(p_request_text)>131072 then return jsonb_build_object('error','invalid_record');end if;
 begin v:=p_request_text::jsonb;exception when others then return jsonb_build_object('error','invalid_record');end;
 if v->'version'='2'::jsonb then return controller_security.review141_record_v2(p_tenant_id,p_actor_id,p_request_text);end if;
 -- Context before HEAD preserves the historical v1 authority/error order.
 ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid,true);
 if ctx?'error' then return ctx;end if;
 perform pg_advisory_xact_lock(hashtextextended('public-control-review:'||p_tenant_id::text,0));
 if exists(select 1 from public.public_control_review_sets where tenant_id=p_tenant_id and id=(v->>'expectedPreviousReviewId')::uuid and request_codec='axiom-public-control-review-request-canonical-json-2') then return jsonb_build_object('error','association_context_required');end if;
 return controller_security.review141_record_v1(p_tenant_id,p_actor_id,p_request_text);
 exception when invalid_text_representation then return jsonb_build_object('error','invalid_record');
end $$;

create or replace function public.resolve_public_control_assessment_source(
 p_tenant_id uuid,p_actor_id uuid,p_job_id uuid,p_engagement_id uuid,
 p_review_id uuid,p_request_sha256 text,p_snapshot_sha256 text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.public_control_review_sets; j public.assessment_dispatch_jobs;
 s public.public_control_assessment_sources; ctx jsonb; snap jsonb; input_text text;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan') then return jsonb_build_object('error','forbidden');end if;
 if exists(select 1 from public.assessment_source_cancellations where tenant_id=p_tenant_id and actor_id=p_actor_id and job_id=p_job_id) then return jsonb_build_object('error','assessment_source_cancelled');end if;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=p_review_id for share;
 if not found or r.engagement_id is distinct from p_engagement_id or r.request_sha256 is distinct from p_request_sha256
 or r.snapshot_sha256 is distinct from p_snapshot_sha256 then return jsonb_build_object('error','review_source_refused');end if;
 select * into j from public.assessment_dispatch_jobs where id=p_job_id;
 if found then
  select * into s from public.public_control_assessment_sources where job_id=p_job_id;
  if s.job_id is null or s.tenant_id is distinct from p_tenant_id or s.actor_id is distinct from p_actor_id
   or s.run_id is distinct from j.run_id or s.engagement_id is distinct from p_engagement_id
   or s.review_id is distinct from p_review_id or s.request_sha256 is distinct from p_request_sha256
   or s.snapshot_sha256 is distinct from p_snapshot_sha256 or s.input_sha256 is distinct from j.input_hash
   or s.estate_id is distinct from j.estate_id or j.actor_id is distinct from p_actor_id or j.tenant_id is distinct from p_tenant_id
  then return jsonb_build_object('error','dispatch_conflict');end if;
  input_text:=s.input_text;
 else
  perform controller_security.review141_prelock(p_tenant_id,p_actor_id,p_engagement_id,r.estate_id,r.request_text::jsonb,false);
  perform pg_advisory_xact_lock(hashtextextended('public-control-review:'||p_tenant_id::text,0));
  ctx:=controller_security.public_control_review_context(p_tenant_id,p_actor_id,p_engagement_id,r.check_id,true);
  if ctx?'error' then return ctx;end if;
  if r.estate_id is distinct from (ctx->>'estateId')::uuid
   or exists(select 1 from public.public_control_review_sets where previous_review_id=r.id)
   or not controller_security.public_control_review_request_valid(case when r.request_codec='axiom-public-control-review-request-canonical-json-2' then controller_security.review141_v1_request(r.request_text::jsonb) else r.request_text::jsonb end,ctx)
  then return jsonb_build_object('error','review_source_changed');end if;
  snap:=r.snapshot_text::jsonb;
  input_text:=controller_security.canonical_questionnaire_json(jsonb_build_object(
   'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'library_version','0.1.1',
   'answers',snap->'normalizedAnswers','sdf_self_attested',snap->'request'->'applicability'->'sdfSelfAttested',
   'processes_children',snap->'request'->'applicability'->'processesChildren','processes_health',snap->'request'->'applicability'->'processesHealth'));
 end if;
 return jsonb_build_object('review',to_jsonb(r)||jsonb_build_object('receipt_id',r.receipt_id::text),
  'inputText',input_text,'inputSha256',encode(sha256(convert_to(input_text,'UTF8')),'hex'));
end $$;

create or replace function public.enqueue_public_control_assessment_dispatch(p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,p_policy_revision integer,p_policy_fingerprint text,p_review_id uuid,p_review_request_sha256 text,p_review_snapshot_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare source jsonb;reply jsonb;r public.public_control_review_sets;requested bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 reply:=public.recover_public_control_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if reply is not null then return reply;end if;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=p_review_id;
 lock table public.kill_switch_state in share mode;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not public.workload_task_actor_allowed(p_tenant_id,p_actor_id,'parikshan') then return jsonb_build_object('error','forbidden');end if;
 if r.id is null then return jsonb_build_object('error','review_source_refused');end if;
 perform controller_security.review141_prelock(p_tenant_id,p_actor_id,p_engagement_id,r.estate_id,r.request_text::jsonb,true);
 source:=public.resolve_public_control_assessment_source(p_tenant_id,p_actor_id,p_job_id,p_engagement_id,p_review_id,p_review_request_sha256,p_review_snapshot_sha256);
 if source?'error' then return source;end if;
 if source->>'inputSha256' is distinct from p_input_hash or (source->'review'->>'estate_id')::uuid is distinct from p_estate_id then return jsonb_build_object('error','dispatch_conflict');end if;
 reply:=public.enqueue_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,p_policy_revision,p_policy_fingerprint,
 '0.1.1',((source->'review'->>'request_text')::jsonb)->'expectedSource'->>'questionnaireDigest');
 if reply?'error' then return reply;end if;
 select * into r from public.public_control_review_sets where id=p_review_id and tenant_id=p_tenant_id;
 select (metadata->>'assessment_request_receipt')::bigint into requested from public.agent_runs where id=(reply->>'run_id')::uuid and tenant_id=p_tenant_id;
 insert into public.public_control_assessment_sources(job_id,run_id,tenant_id,actor_id,engagement_id,estate_id,review_id,request_sha256,snapshot_sha256,input_text,input_sha256,requested_receipt,review_receipt,capture_receipt)
 values(p_job_id,(reply->>'run_id')::uuid,p_tenant_id,p_actor_id,p_engagement_id,p_estate_id,r.id,r.request_sha256,r.snapshot_sha256,source->>'inputText',p_input_hash,requested,r.receipt_id,(r.snapshot_text::jsonb->>'captureReceipt')::bigint);
 return reply;
end $$;

create or replace function public.cancel_public_control_review_operation(p_tenant_id uuid,p_actor_id uuid,p_request_text text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;role_name public.user_role;internal boolean;r public.public_control_review_sets;c public.public_control_review_cancellations;rid uuid:=gen_random_uuid();receipt bigint;txt text;
begin
 if p_request_text is null or octet_length(p_request_text)>131072 or p_reason is null or length(p_reason) not between 1 and 2000 or p_reason!~'[^[:space:]]' then return jsonb_build_object('error','invalid_record');end if;
 begin v:=p_request_text::jsonb;exception when invalid_text_representation then return jsonb_build_object('error','invalid_record');end;
 if controller_security.canonical_questionnaire_json(v) is distinct from p_request_text or not controller_security.review141_shape(v) then return jsonb_build_object('error','invalid_record');end if;
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
 values(rid,p_tenant_id,p_actor_id,(v->>'engagementId')::uuid,(v->>'checkId')::uuid,(v->>'operationKey')::uuid,case when v->'version'='2'::jsonb then 'axiom-public-control-review-request-canonical-json-2' else 'axiom-public-control-review-request-canonical-json-1' end,p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),p_reason,'axiom-public-control-review-cancellation-pg-canonical-json-1',txt,encode(sha256(convert_to(txt,'UTF8')),'hex'),receipt) returning * into c;
 return jsonb_build_object('state','cancelled','data',to_jsonb(c)||jsonb_build_object('receipt_id',c.receipt_id::text));
end $$;
create function controller_security.review141_snapshot_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare req jsonb;snap jsonb;assets jsonb;
begin
 if new.request_codec='axiom-public-control-review-request-canonical-json-1' then
  if new.request_text::jsonb->'version' is distinct from '1'::jsonb or new.snapshot_text::jsonb->'version' is distinct from '1'::jsonb then raise exception 'review codec refused' using errcode='23514';end if;
  return new;
 end if;
 req:=new.request_text::jsonb;snap:=new.snapshot_text::jsonb;
 assets:=controller_security.review141_assets(new.tenant_id,req);
 if not controller_security.review141_shape(req) or req->'version' is distinct from '2'::jsonb or snap->'version' is distinct from '2'::jsonb
 or controller_security.canonical_questionnaire_json(req) is distinct from new.request_text or controller_security.canonical_questionnaire_json(snap) is distinct from new.snapshot_text
 or snap->'request' is distinct from req or snap->'assetProvenance' is distinct from assets
 then raise exception 'review asset snapshot refused' using errcode='23514';end if;
 return new;
end $$;
create trigger public_control_review_asset_guard141 before insert on public.public_control_review_sets for each row execute function controller_security.review141_snapshot_guard();
-- All helper entrypoints are private; public RPC OIDs/ACLs above are preserved.
revoke all on function controller_security.review141_authorized(uuid,uuid),controller_security.review141_v1_request(jsonb),controller_security.review141_shape(jsonb),controller_security.review141_assets(uuid,jsonb),controller_security.review141_prelock(uuid,uuid,uuid,uuid,jsonb,boolean),controller_security.review141_record_v1(uuid,uuid,text),controller_security.review141_record_v2(uuid,uuid,text),controller_security.review141_snapshot_guard() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
