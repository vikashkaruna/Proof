-- Explicit candidate publication and founder approval. Applying this migration
-- never publishes 0.2.0, approves it, changes the current library or adopts it.
alter type public.ledger_action_type add value if not exists 'catalogue.version_approved';
create table public.catalogue_version_manifests (
 library_version text not null check(library_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 mapping_version text not null,
 manifest_text text not null check(octet_length(manifest_text) between 2 and 1048576),
 manifest_sha256 text not null check(manifest_sha256=encode(sha256(convert_to(manifest_text,'UTF8')),'hex')),
 primary key(library_version,mapping_version)
);
create table public.catalogue_version_approval_events (
 library_version text primary key references public.approved_catalogue_versions(library_version),
 tenant_id uuid not null references public.tenants(id), actor_id uuid not null references public.users(id),
 session_id uuid not null, operation_key uuid not null unique,
 challenge_id uuid not null unique references public.mfa_challenges(id),
 request_text text not null, request_sha256 text not null,
 receipt_id bigint not null references public.audit_ledger(id),
 approved_at timestamptz not null default clock_timestamp()
);
create trigger catalogue_manifests_immutable before update or delete or truncate on public.catalogue_version_manifests
 for each statement execute function public.evidence_receipt_immutable();
create trigger catalogue_approvals_immutable before update or delete or truncate on public.catalogue_version_approval_events
 for each statement execute function public.evidence_receipt_immutable();
alter table public.catalogue_version_manifests enable row level security;
alter table public.catalogue_version_approval_events enable row level security;
revoke all on public.catalogue_version_manifests,public.catalogue_version_approval_events from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
insert into public.catalogue_version_manifests values('0.1.1','public-evidence-1',controller_security.public_control_report_mapping_manifest(),'3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6');

-- Immutable source fingerprint is the reviewed 0.2.0 package manifest. The
-- service key can stage those exact bytes only after the explicit publisher
-- has inserted and verified the immutable control rows. It cannot approve.
create function public.publish_catalogue_manifest(p_library_version text,p_manifest_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare digest text;
begin
 digest:=encode(sha256(convert_to(p_manifest_text,'UTF8')),'hex');
 if p_library_version is distinct from '0.2.0' or digest is distinct from '3bfc2044ceaab0275caf528c932a2a0a5f314fab776c03b51037a78ca812437e'
 or not exists(select 1 from public.control_libraries where version=p_library_version and status='published' and control_count=46)
 or (select count(*) from public.controls where library_version=p_library_version)<>46
 then raise exception 'candidate manifest refused' using errcode='23514';end if;
 insert into public.catalogue_version_manifests values(p_library_version,'public-evidence-1',p_manifest_text,digest) on conflict do nothing;
 if not exists(select 1 from public.catalogue_version_manifests where library_version=p_library_version and mapping_version='public-evidence-1' and manifest_text=p_manifest_text)
 then raise exception 'candidate manifest conflict' using errcode='23505';end if;
 return jsonb_build_object('libraryVersion',p_library_version,'manifestSha256',digest,'approved',false);
end $$;
revoke all on function public.publish_catalogue_manifest(text,text) from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.publish_catalogue_manifest(text,text) to service_role;

create function controller_security.catalogue161_authority(t uuid,a uuid,s uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not controller_security.catalogue127_authority(t,a,false)
 or not exists(select 1 from auth.sessions where id=s and user_id=a and (not_after is null or not_after>clock_timestamp()))
 then raise exception 'live internal founder session required' using errcode='42501';end if;
 perform 1 from auth.sessions where id=s and user_id=a for share;
end $$;

-- Fingerprints are recomputed over actual immutable published rows, never
-- accepted from a browser, seed metadata or an unverified manifest assertion.
create function controller_security.catalogue161_fingerprint(v text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lib public.control_libraries;m public.catalogue_version_manifests;rows jsonb;expected jsonb;q jsonb;
begin
 select * into lib from public.control_libraries where version=v and status='published' for share;
 select * into m from public.catalogue_version_manifests where library_version=v and mapping_version='public-evidence-1';
 if lib.version is null or m.library_version is null then raise exception 'published catalogue and manifest required' using errcode='23514';end if;
 select jsonb_agg(to_jsonb(c)-'created_at' order by c.id) into rows from public.controls c where library_version=v;
 select jsonb_agg(jsonb_build_object(
 'id',c->>'id','library_version',v,'title',c->>'title','obligation',c->>'obligation','domain',c->>'domain','severity',c->>'severity',
 'citations',c->'citations','evidence_required',c->'evidenceRequired','assessment_questions',c->'assessmentQuestions','scoring',c->'scoring',
 'remediation_patterns',c->'remediationPatterns','tags',c->'tags','sdf_only',c->'sdfOnly','children_only',c->'childrenOnly',
 'introduced_in_version',c->'introducedInVersion','revised_in_version',coalesce(c->'revisedInVersion','null'::jsonb),'notes',coalesce(c->'notes','null'::jsonb)) order by c->>'id')
 into expected from jsonb_array_elements(m.manifest_text::jsonb->'controls') x(item) cross join lateral (select item->'control' c)y;
 if rows is distinct from expected or jsonb_array_length(rows)<>lib.control_count
 or (m.manifest_text::jsonb)#>>'{provenance,libraryVersion}' is distinct from v
 or (m.manifest_text::jsonb)#>>'{provenance,publisher}' is distinct from lib.published_by
 or ((m.manifest_text::jsonb)#>>'{provenance,publishedAt}')::timestamptz is distinct from lib.published_at
 then raise exception 'published catalogue differs from reviewed manifest' using errcode='23514';end if;
 select jsonb_build_object('libraryVersion',v,'controls',jsonb_agg(jsonb_build_object('id',c->>'id','title',c->>'title','questions',
 (select jsonb_agg(jsonb_build_object('id',x->>'id','prompt',x->>'prompt','type',x->>'type') order by n) from jsonb_array_elements(c->'assessment_questions') with ordinality q(x,n))) order by c->>'id')) into q from jsonb_array_elements(rows)c;
 return jsonb_build_object('libraryVersion',v,'rowsHash',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(rows),'UTF8')),'hex'),
 'questionnaireDigest',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(q),'UTF8')),'hex'),
 'manifestSha256',m.manifest_sha256,'mappingVersion',m.mapping_version,'controlCount',lib.control_count,'publishedBy',lib.published_by,
 'publishedAt',lib.published_at,'changeLog',lib.change_log,'isCurrent',lib.is_current);
end $$;

create function public.read_catalogue_versions(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform controller_security.catalogue161_authority(p_tenant_id,p_actor_id,p_session_id);
 select coalesce(jsonb_agg(controller_security.catalogue161_fingerprint(l.version)||jsonb_build_object('approved',a.library_version is not null,'approvedAt',a.approved_at) order by l.published_at),'[]'::jsonb)
 into result from public.control_libraries l join public.catalogue_version_manifests m on m.library_version=l.version
 left join public.approved_catalogue_versions a on a.library_version=l.version where l.status='published';
 return jsonb_build_object('versions',result);
end $$;

create function public.preflight_catalogue_version_approval(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;f jsonb;
begin
 perform controller_security.catalogue161_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_request_text is null or octet_length(p_request_text)>4096 then raise exception 'catalogue request refused' using errcode='22023';end if;
 r:=p_request_text::jsonb;
 if controller_security.canonical_questionnaire_json(r) is distinct from p_request_text or jsonb_typeof(r) is distinct from 'object'
 or (select count(*) from jsonb_object_keys(r))<>9 or r-array['version','operationKey','libraryVersion','rowsHash','questionnaireDigest','manifestSha256','mappingVersion','reason','confirmed']<>'{}'::jsonb
 or r->'version' is distinct from '1'::jsonb or r->'confirmed' is distinct from 'true'::jsonb
 or r->>'libraryVersion' is distinct from '0.2.0' or r->>'mappingVersion' is distinct from 'public-evidence-1'
 or r->>'operationKey' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or jsonb_typeof(r->'reason') is distinct from 'string' or length(r->>'reason') not between 1 and 2000 or r->>'reason'!~'[^[:space:]]'
 then raise exception 'catalogue request refused' using errcode='22023';end if;
 f:=controller_security.catalogue161_fingerprint(r->>'libraryVersion');
 if r->>'rowsHash' is distinct from f->>'rowsHash' or r->>'questionnaireDigest' is distinct from f->>'questionnaireDigest' or r->>'manifestSha256' is distinct from f->>'manifestSha256'
 then raise exception 'catalogue source changed' using errcode='23514';end if;
 return f||jsonb_build_object('authorized',true,'requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'));
end $$;

create function public.approve_catalogue_version(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;f jsonb;challenge public.mfa_challenges;now_at timestamptz;digest text;binding text;receipt bigint;saved public.catalogue_version_approval_events;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human catalogue writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('axiom.catalogue-version-approval',161));
 f:=public.preflight_catalogue_version_approval(p_tenant_id,p_actor_id,p_session_id,p_request_text);r:=p_request_text::jsonb;
 select * into saved from public.catalogue_version_approval_events where operation_key=(r->>'operationKey')::uuid;
 if found then
  if saved.tenant_id<>p_tenant_id or saved.actor_id<>p_actor_id or saved.session_id<>p_session_id or saved.request_text<>p_request_text then raise exception 'catalogue operation conflict' using errcode='23505';end if;
  return jsonb_build_object('approved',true,'libraryVersion',saved.library_version,'receiptId',saved.receipt_id::text,'replayed',true);
 end if;
 if exists(select 1 from public.approved_catalogue_versions where library_version=r->>'libraryVersion') then raise exception 'catalogue already approved' using errcode='23505';end if;
 digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.catalogue-version.approve',1,p_tenant_id::text,p_actor_id::text,p_session_id::text,digest)),'UTF8')),'hex');
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 select * into challenge from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();
 if challenge.id is null or challenge.user_id is distinct from p_actor_id or challenge.tenant_id is distinct from p_tenant_id
 or challenge.purpose::text is distinct from 'catalogue_adoption' or challenge.bound_resource_ref is distinct from r->>'operationKey'
 or challenge.bound_payload_sha256 is distinct from binding or challenge.consumed_for is distinct from r->>'operationKey'
 or challenge.satisfied_at is null or challenge.consumed_at is null or challenge.created_at>challenge.satisfied_at
 or challenge.expires_at>challenge.created_at+interval '5 minutes' or challenge.satisfied_at>now_at
 or challenge.satisfied_at<=now_at-interval '5 minutes' or challenge.expires_at<=now_at
 or challenge.consumed_at<challenge.satisfied_at or challenge.consumed_at>now_at
 or not exists(select 1 from public.user_mfa_factors where id=challenge.factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 or exists(select 1 from public.catalogue_version_approval_events where challenge_id=p_challenge_id)
 or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
 then raise exception 'fresh catalogue MFA required' using errcode='42501';end if;
 insert into public.approved_catalogue_versions(library_version,rows_hash,questionnaire_digest,catalogue_manifest_sha256,mapping_version,published_by,change_log,published_at,control_count)
 values(r->>'libraryVersion',f->>'rowsHash',f->>'questionnaireDigest',f->>'manifestSha256',f->>'mappingVersion',f->>'publishedBy',f->>'changeLog',(f->>'publishedAt')::timestamptz,(f->>'controlCount')::integer);
 receipt:=public.append_ledger(p_tenant_id,(r->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'catalogue.version_approved',r->>'libraryVersion',digest,f->>'manifestSha256',null,null,null,null,'success',
 jsonb_build_object('library_version',r->>'libraryVersion','rows_hash',f->>'rowsHash','questionnaire_digest',f->>'questionnaireDigest','manifest_sha256',f->>'manifestSha256','mapping_version',f->>'mappingVersion','reason',r->>'reason'));
 insert into public.catalogue_version_approval_events(library_version,tenant_id,actor_id,session_id,operation_key,challenge_id,request_text,request_sha256,receipt_id)
 values(r->>'libraryVersion',p_tenant_id,p_actor_id,p_session_id,(r->>'operationKey')::uuid,p_challenge_id,p_request_text,digest,receipt);
 return jsonb_build_object('approved',true,'libraryVersion',r->>'libraryVersion','receiptId',receipt::text,'replayed',false);
end $$;

revoke all on function controller_security.catalogue161_authority(uuid,uuid,uuid),controller_security.catalogue161_fingerprint(text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
revoke all on function public.read_catalogue_versions(uuid,uuid,uuid),public.preflight_catalogue_version_approval(uuid,uuid,uuid,text) from public,anon,authenticated,agent_ledger_writer;
grant execute on function public.read_catalogue_versions(uuid,uuid,uuid),public.preflight_catalogue_version_approval(uuid,uuid,uuid,text) to service_role,human_action_writer;
revoke all on function public.approve_catalogue_version(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.approve_catalogue_version(uuid,uuid,uuid,text,uuid) to human_action_writer;

-- Preserve all legacy provenance checks, replacing only its singleton manifest
-- source with the immutable exact-version lookup. Historical bytes stay intact.
do $$declare body text;begin
 body:=pg_get_functiondef('controller_security.public_control_report_provenance(uuid,uuid,uuid)'::regprocedure);
 if position('manifest:=controller_security.public_control_report_mapping_manifest();' in body)=0 then raise exception 'catalogue provenance upgrade source refused';end if;
 body:=replace(body,'manifest:=controller_security.public_control_report_mapping_manifest();',
 'select manifest_text into manifest from public.catalogue_version_manifests where library_version=cat.library_version and mapping_version=cat.mapping_version; if manifest is null then raise exception ''human review mapping manifest unavailable'' using errcode=''23514'';end if;');
 execute body;
end $$;
