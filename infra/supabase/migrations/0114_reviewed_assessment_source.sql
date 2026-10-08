-- Completed published libraries cannot change between human review, enqueue,
-- worker snapshot and finalization. Initial fixed-count population remains
-- compatible with the existing insert-library-then-controls seed process.
create function controller_security.protect_published_control_source()
returns trigger language plpgsql security definer set search_path='' as $$
declare library public.control_libraries; source_version text;
begin
 if tg_op='TRUNCATE' then raise exception 'Control source truncation refused' using errcode='42501'; end if;
 source_version:=case when tg_op='DELETE' then old.library_version else new.library_version end;
 select * into library from public.control_libraries where control_libraries.version=source_version for update;
 if library.status in ('published','deprecated') then
  if tg_op='DELETE' or ((select count(*) from public.controls where library_version=source_version)>=library.control_count
    and not exists(select 1 from public.controls where library_version=source_version and id=new.id))
  then raise exception 'Published control sources are append-only across versions' using errcode='42501'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger protect_published_control_source before insert or delete on public.controls
 for each row execute function controller_security.protect_published_control_source();
create trigger protect_control_source_truncate before truncate on public.controls
 for each statement execute function controller_security.protect_published_control_source();

create function controller_security.protect_published_library_source()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='TRUNCATE' then raise exception 'Control library truncation refused' using errcode='42501'; end if;
 if old.status in ('published','deprecated') and
  (tg_op='DELETE' or new.version is distinct from old.version or new.control_count is distinct from old.control_count
   or new.status='draft')
 then raise exception 'Published library source is immutable' using errcode='42501'; end if;
 if tg_op='UPDATE' and old.status='draft' and new.status in ('published','deprecated') then
  if new.control_count not between 1 and 500 or
   (select count(*) from public.controls where library_version=old.version)<>new.control_count
   or exists(select 1 from public.controls where library_version=old.version and
    (length(id) not between 1 and 200 or length(title) not between 1 and 2000 or jsonb_typeof(assessment_questions)<>'array'))
  then raise exception 'Incomplete library publication refused' using errcode='42501'; end if;
  if (select coalesce(sum(jsonb_array_length(assessment_questions)),0) from public.controls where library_version=old.version)>5000
   or exists(select 1 from public.controls c cross join lateral jsonb_array_elements(c.assessment_questions) q
     where c.library_version=old.version and
      (jsonb_typeof(q)<>'object' or jsonb_typeof(q->'id') is distinct from 'string' or length(q->>'id') not between 1 and 200
       or jsonb_typeof(q->'prompt') is distinct from 'string' or length(q->>'prompt') not between 1 and 10000
       or jsonb_typeof(q->'type') is distinct from 'string' or q->>'type' not in ('boolean','scale','text','multi','evidence')))
   or exists(select 1 from public.controls c cross join lateral jsonb_array_elements(c.assessment_questions) q
     where c.library_version=old.version group by c.id,q->>'id' having count(*)>1)
  then raise exception 'Invalid library publication refused' using errcode='42501'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger protect_published_library_source before update or delete on public.control_libraries
 for each row execute function controller_security.protect_published_library_source();
create trigger protect_library_source_truncate before truncate on public.control_libraries
 for each statement execute function controller_security.protect_published_library_source();

-- Exact canonicalization of the fixed-key string/array questionnaire projection.
-- No removal of whitespace from arbitrary prompt strings. Object keys in this
-- projection are ASCII; JSON string escaping and Unicode values are preserved.
create function controller_security.canonical_questionnaire_json(value jsonb)
returns text language plpgsql immutable strict set search_path='' as $$
declare result text;
begin
 if jsonb_typeof(value)='object' then
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||controller_security.canonical_questionnaire_json(item),',' order by key collate "C"),'')||'}'
   into result from jsonb_each(value) as entries(key,item);
 elsif jsonb_typeof(value)='array' then
  select '['||coalesce(string_agg(controller_security.canonical_questionnaire_json(item),',' order by ordinal),'')||']'
   into result from jsonb_array_elements(value) with ordinality as entries(item,ordinal);
 else result:=value::text; end if;
 return result;
end $$;

-- Recovery compares reviewed HTTP preconditions against the immutable original
-- human receipt separately from the unchanged canonical worker-input hash.
alter function public.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text) set schema controller_security;
revoke all on function controller_security.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.recover_reviewed_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_expected_library_version text,p_expected_questionnaire_digest text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare reply jsonb; requested public.audit_ledger; expected jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human assessment writer required' using errcode='42501'; end if;
 reply:=controller_security.recover_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash);
 if reply is null or reply ? 'error' then return reply; end if;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id
  and action_type::text='assessment.requested' and target_ref=p_job_id::text;
 if requested.id is not null and (requested.actor_type<>'human' or requested.actor_id is distinct from p_actor_id::text
  or requested.correlation_id is distinct from p_correlation_id or requested.input_hash is distinct from p_input_hash
  or requested.detail->>'run_id' is distinct from reply->>'run_id'
  or not exists(select 1 from public.agent_runs where tenant_id=p_tenant_id and id=(reply->>'run_id')::uuid
    and metadata->>'assessment_request_receipt'=requested.id::text))
 then return jsonb_build_object('error','dispatch_conflict'); end if;
 if p_expected_library_version is null and p_expected_questionnaire_digest is null then expected:=null;
 elsif p_expected_library_version is null or length(p_expected_library_version) not between 1 and 200
   or p_expected_questionnaire_digest is null or p_expected_questionnaire_digest !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','dispatch_conflict');
 else expected:=jsonb_build_object('libraryVersion',p_expected_library_version,'questionnaireDigest',p_expected_questionnaire_digest); end if;
 if requested.detail->'expected_questionnaire' is distinct from expected
 then return jsonb_build_object('error','dispatch_conflict'); end if;
 return reply;
end $$;
create function public.recover_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text
) returns jsonb language sql security definer set search_path='' as $$
 select public.recover_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,null,null)
$$;
revoke all on function public.recover_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text),public.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.recover_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text),public.recover_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text) to human_action_writer;

-- The legacy unknown-body enqueue cannot bypass reviewed receipt matching.
alter function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)
 rename to enqueue_human_assessment_dispatch;
alter function public.enqueue_human_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)
 set schema controller_security;
revoke all on function controller_security.enqueue_human_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.enqueue_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,
 p_policy_revision integer default null,p_policy_fingerprint text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare recovered jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human assessment writer required' using errcode='42501'; end if;
 -- Preserve policy47 -> job44 -> membership locks before old receipt recovery.
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 recovered:=public.recover_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash);
 if recovered is not null then return recovered; end if;
 return controller_security.enqueue_human_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,p_policy_revision,p_policy_fingerprint);
end $$;
revoke all on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text) to human_action_writer;

create function public.enqueue_reviewed_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,
 p_policy_revision integer,p_policy_fingerprint text,p_expected_library_version text,p_expected_questionnaire_digest text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare engagement public.engagements; library public.control_libraries; projection jsonb; controls jsonb; recovered jsonb; policy public.assessment_dispatch_key_policies; reply jsonb; receipt bigint;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human assessment writer required' using errcode='42501'; end if;
 if p_tenant_id is null or p_job_id is null or p_engagement_id is null
  or p_expected_library_version is null or length(p_expected_library_version) not between 1 and 200
  or p_expected_questionnaire_digest is null or p_expected_questionnaire_digest !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','invalid_dispatch'); end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,44));
 -- Exact historical receipt recovery never requires current source availability.
 recovered:=public.recover_reviewed_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_expected_library_version,p_expected_questionnaire_digest);
 if recovered is not null then return recovered; end if;
 -- Table locks close INSERT/DELETE phantom races and remain held until the
 -- existing atomic enqueue and request receipt complete. Lock reference tables
 -- before estate/engagement rows to avoid publication/seed lock inversion.
 lock table public.controls,public.control_libraries in share mode;
 perform 1 from public.estates where tenant_id=p_tenant_id and id=p_estate_id for share;
 select * into engagement from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for update;
 if engagement.id is null or engagement.library_version is distinct from p_expected_library_version
  or engagement.estate_id is distinct from p_estate_id
 then return jsonb_build_object('error','questionnaire_source_changed'); end if;
 select * into library from public.control_libraries where version=p_expected_library_version for share;
 if library.version is null or library.status not in ('published','deprecated') or library.control_count not between 1 and 500
 then return jsonb_build_object('error','questionnaire_source_changed'); end if;
 if exists(select 1 from public.controls where library_version=p_expected_library_version and
   (length(id) not between 1 and 200 or length(title) not between 1 and 2000 or jsonb_typeof(assessment_questions)<>'array'))
 then return jsonb_build_object('error','questionnaire_source_changed'); end if;
 if (select count(*) from public.controls where library_version=p_expected_library_version)<>library.control_count
  or (select coalesce(sum(jsonb_array_length(assessment_questions)),0) from public.controls where library_version=p_expected_library_version)>5000
 then return jsonb_build_object('error','questionnaire_source_changed'); end if;
 if exists(select 1 from public.controls c cross join lateral jsonb_array_elements(c.assessment_questions) q
  where c.library_version=p_expected_library_version and
   (jsonb_typeof(q)<>'object' or jsonb_typeof(q->'id') is distinct from 'string' or length(q->>'id') not between 1 and 200
    or jsonb_typeof(q->'prompt') is distinct from 'string' or length(q->>'prompt') not between 1 and 10000
    or jsonb_typeof(q->'type') is distinct from 'string' or q->>'type' not in ('boolean','scale','text','multi','evidence')))
  or exists(select 1 from public.controls c cross join lateral jsonb_array_elements(c.assessment_questions) q
    where c.library_version=p_expected_library_version group by c.id,q->>'id' having count(*)>1)
 then return jsonb_build_object('error','questionnaire_source_changed'); end if;
 select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'questions',
   coalesce((select jsonb_agg(jsonb_build_object('id',q->>'id','prompt',q->>'prompt','type',q->>'type') order by ordinal)
    from jsonb_array_elements(c.assessment_questions) with ordinality as questions(q,ordinal)),'[]'::jsonb)) order by c.id)
 into controls from public.controls c where c.library_version=p_expected_library_version;
 projection:=jsonb_build_object('libraryVersion',p_expected_library_version,'controls',controls);
 if encode(sha256(convert_to(controller_security.canonical_questionnaire_json(projection),'UTF8')),'hex') is distinct from p_expected_questionnaire_digest
 then return jsonb_build_object('error','questionnaire_source_changed'); end if;
 select * into policy from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id;
 if policy.tenant_id is null then return jsonb_build_object('error','policy_required'); end if;
 if p_policy_revision is distinct from policy.revision or p_policy_fingerprint is distinct from policy.fingerprint
  or p_key_ref is distinct from policy.primary_ref
 then return jsonb_build_object('error','policy_stale'); end if;
 reply:=controller_security.enqueue_assessment_dispatch(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,
  p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key,p_policy_revision,p_policy_fingerprint);
 if reply ? 'error' then return reply; end if;
 receipt:=public.append_ledger(p_tenant_id=>p_tenant_id,p_correlation_id=>p_correlation_id,
  p_actor_type=>'human',p_actor_id=>p_actor_id::text,p_agent_version=>null,p_model_id=>null,p_prompt_hash=>null,
  p_action_type=>'assessment.requested',p_target_ref=>p_job_id::text,p_input_hash=>p_input_hash,p_output_hash=>null,
  p_approval_token_id=>null,p_approver_id=>null,p_pre_state_ref=>null,p_post_state_ref=>null,p_result=>'pending',
  p_detail=>jsonb_build_object('purpose','durable_assessment','job_id',p_job_id,'run_id',reply->>'run_id',
   'workload_id',p_workload_id,'estate_id',p_estate_id,'engagement_id',p_engagement_id,'library_version',p_expected_library_version,
   'policy_revision',policy.revision,'policy_fingerprint',policy.fingerprint,
   'expected_questionnaire',jsonb_build_object('libraryVersion',p_expected_library_version,'questionnaireDigest',p_expected_questionnaire_digest)));
 update public.agent_runs set metadata=metadata||jsonb_build_object('assessment_request_receipt',receipt::text,
  'request_kind','durable_assessment_v1') where tenant_id=p_tenant_id and id=(reply->>'run_id')::uuid;
 return reply;
end $$;
revoke all on function controller_security.protect_published_control_source(),controller_security.protect_published_library_source(),controller_security.canonical_questionnaire_json(jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
revoke all on function public.enqueue_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.enqueue_reviewed_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text,text,text) to human_action_writer;
