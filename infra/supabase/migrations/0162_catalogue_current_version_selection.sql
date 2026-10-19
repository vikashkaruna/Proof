-- Explicit founder-MFA current-version selection after recorded version approval.
-- No current/default pointer is changed when this migration is applied.
alter type public.ledger_action_type add value if not exists 'catalogue.current_version_changed';
create table public.catalogue_current_version_events (
 library_version text not null references public.approved_catalogue_versions(library_version),
 tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),
 session_id uuid not null,operation_key uuid primary key,
 challenge_id uuid not null unique references public.mfa_challenges(id),
 request_text text not null,request_sha256 text not null,
 receipt_id bigint not null references public.audit_ledger(id),recorded_at timestamptz not null default clock_timestamp()
);
create trigger catalogue_current_events_immutable before update or delete or truncate on public.catalogue_current_version_events for each statement execute function public.evidence_receipt_immutable();
alter table public.catalogue_current_version_events enable row level security;
revoke all on public.catalogue_current_version_events from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create function public.preflight_current_catalogue_version(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;f jsonb;
begin
 perform controller_security.catalogue161_authority(p_tenant_id,p_actor_id,p_session_id);
 if p_request_text is null or octet_length(p_request_text)>4096 then raise exception 'catalogue request refused' using errcode='22023';end if;
 r:=p_request_text::jsonb;
 if controller_security.canonical_questionnaire_json(r) is distinct from p_request_text or jsonb_typeof(r) is distinct from 'object'
 or (select count(*) from jsonb_object_keys(r))<>11 or r-array['version','operationKey','libraryVersion','rowsHash','questionnaireDigest','manifestSha256','mappingVersion','reason','confirmed','transition','previousCurrentVersion']<>'{}'::jsonb
 or r->'version' is distinct from '1'::jsonb or r->'confirmed' is distinct from 'true'::jsonb
 or r->>'libraryVersion' !~ '^[0-9]+\.[0-9]+\.[0-9]+$' or r->>'transition' is distinct from 'make_current'
 or (r->'previousCurrentVersion'<>'null'::jsonb and r->>'previousCurrentVersion' !~ '^[0-9]+\.[0-9]+\.[0-9]+$') or r->>'mappingVersion' is distinct from 'public-evidence-1'
 or r->>'operationKey' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or jsonb_typeof(r->'reason') is distinct from 'string' or length(r->>'reason') not between 1 and 2000 or r->>'reason'!~'[^[:space:]]'
 then raise exception 'catalogue request refused' using errcode='22023';end if;
 f:=controller_security.catalogue161_fingerprint(r->>'libraryVersion');
 if not exists(select 1 from public.approved_catalogue_versions where library_version=r->>'libraryVersion' and mapping_version=r->>'mappingVersion'
 and rows_hash=f->>'rowsHash' and questionnaire_digest=f->>'questionnaireDigest' and catalogue_manifest_sha256=f->>'manifestSha256'
 and published_by=f->>'publishedBy' and change_log=f->>'changeLog' and published_at=(f->>'publishedAt')::timestamptz and control_count=(f->>'controlCount')::integer)
 then raise exception 'approved catalogue required' using errcode='42501';end if;
 if r->>'rowsHash' is distinct from f->>'rowsHash' or r->>'questionnaireDigest' is distinct from f->>'questionnaireDigest' or r->>'manifestSha256' is distinct from f->>'manifestSha256'
 then raise exception 'catalogue source changed' using errcode='23514';end if;
 return f||jsonb_build_object('authorized',true,'requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'));
end $$;

create function public.set_current_catalogue_version(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;f jsonb;challenge public.mfa_challenges;now_at timestamptz;digest text;binding text;receipt bigint;saved public.catalogue_current_version_events;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human catalogue writer required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('axiom.catalogue-version-approval',161));
 perform controller_security.catalogue161_authority(p_tenant_id,p_actor_id,p_session_id);
 lock table public.control_libraries in share row exclusive mode;
 f:=public.preflight_current_catalogue_version(p_tenant_id,p_actor_id,p_session_id,p_request_text);r:=p_request_text::jsonb;
 select * into saved from public.catalogue_current_version_events where operation_key=(r->>'operationKey')::uuid;
 if found then
  if saved.tenant_id<>p_tenant_id or saved.actor_id<>p_actor_id or saved.session_id<>p_session_id or saved.request_text<>p_request_text then raise exception 'catalogue operation conflict' using errcode='23505';end if;
  return jsonb_build_object('approved',true,'libraryVersion',saved.library_version,'receiptId',saved.receipt_id::text,'replayed',true);
 end if;
 if (select version from public.control_libraries where is_current) is distinct from r->>'previousCurrentVersion'
 or exists(select 1 from public.control_libraries where version=r->>'libraryVersion' and is_current) then raise exception 'current catalogue changed' using errcode='23505';end if;
 digest:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array('axiom.catalogue-version.make-current',1,p_tenant_id::text,p_actor_id::text,p_session_id::text,digest)),'UTF8')),'hex');
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
 or exists(select 1 from public.catalogue_current_version_events where challenge_id=p_challenge_id)
 or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
 then raise exception 'fresh catalogue MFA required' using errcode='42501';end if;
 update public.control_libraries set is_current=false where is_current;
 update public.control_libraries set is_current=true where version=r->>'libraryVersion';
 receipt:=public.append_ledger(p_tenant_id,(r->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'catalogue.current_version_changed',r->>'libraryVersion',digest,f->>'manifestSha256',null,null,null,null,'success',
 jsonb_build_object('library_version',r->>'libraryVersion','rows_hash',f->>'rowsHash','questionnaire_digest',f->>'questionnaireDigest','manifest_sha256',f->>'manifestSha256','mapping_version',f->>'mappingVersion','reason',r->>'reason','previous_current_version',r->'previousCurrentVersion'));
 insert into public.catalogue_current_version_events(library_version,tenant_id,actor_id,session_id,operation_key,challenge_id,request_text,request_sha256,receipt_id)
 values(r->>'libraryVersion',p_tenant_id,p_actor_id,p_session_id,(r->>'operationKey')::uuid,p_challenge_id,p_request_text,digest,receipt);
 return jsonb_build_object('approved',true,'libraryVersion',r->>'libraryVersion','receiptId',receipt::text,'replayed',false);
end $$;

revoke all on function public.preflight_current_catalogue_version(uuid,uuid,uuid,text) from public,anon,authenticated,agent_ledger_writer;
grant execute on function public.preflight_current_catalogue_version(uuid,uuid,uuid,text) to service_role,human_action_writer;
revoke all on function public.set_current_catalogue_version(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.set_current_catalogue_version(uuid,uuid,uuid,text,uuid) to human_action_writer;

-- Public reference read for initial onboarding. The service can read the
-- recorded, approved current version but cannot change it through this RPC.
create function public.read_current_catalogue_version() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v text;
begin
 select l.version into v from public.control_libraries l
 where l.is_current and l.status='published' and controller_security.catalogue_approved(l.version,'public-evidence-1');
 if v is null then raise exception 'approved current catalogue unavailable' using errcode='23514';end if;
 return jsonb_build_object('version',v);
end $$;
revoke all on function public.read_current_catalogue_version() from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.read_current_catalogue_version() to service_role;
