-- W4.3: transactional assessment tools behind verified BFF workload authority.
-- Workers never receive SQL credentials. JWT/SVID validation is the BFF's gate;
-- these service-only RPCs repeat live task/context checks under database locks.
create table public.workload_assessment_packets (
  run_id uuid primary key references public.workload_task_delegations(run_id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  engagement_id uuid not null,
  library_version text not null references public.control_libraries(version) on delete restrict,
  controls jsonb not null check(jsonb_typeof(controls)='array'),
  library_digest text not null check(library_digest ~ '^[a-f0-9]{64}$'),
  started_receipt bigint not null,
  completed_receipt bigint,
  result_digest text,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict,
  check ((result is null and result_digest is null and completed_receipt is null and completed_at is null)
    or (jsonb_typeof(result)='object' and result_digest ~ '^[a-f0-9]{64}$' and completed_receipt is not null and completed_at is not null))
);
alter table public.workload_assessment_packets enable row level security;
revoke all on public.workload_assessment_packets from public,anon,authenticated,service_role;
grant select on public.workload_assessment_packets to service_role;
create policy backend_assessment_packet_read on public.workload_assessment_packets for select to service_role using(true);

create function public.lock_assessment_workload_task(
 p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_scope text,p_identity_expires_at timestamptz
) returns public.workload_task_delegations language plpgsql security definer set search_path='' as $$
declare task public.workload_task_delegations; authority jsonb;
begin
 -- This short transaction lock also covers first-time INSERT of a tenant halt.
 -- No lock is held across the worker's calculation or a network/tool call.
 lock table public.kill_switch_state in share mode;
 select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=p_run_id;
 if not found then return null; end if;
 -- Preserve 0041's lock order for membership changes, archival and revocation.
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=task.created_by for share;
 perform 1 from public.users where id=task.created_by for share;
 if task.estate_id is not null then
  perform 1 from public.estates where tenant_id=p_tenant_id and id=task.estate_id for share;
 end if;
 perform 1 from public.engagements where tenant_id=p_tenant_id and id=task.engagement_id for update;
 perform 1 from public.workload_identities where tenant_id=p_tenant_id and id=p_workload_id for share;
 select * into task from public.workload_task_delegations where tenant_id=p_tenant_id and run_id=p_run_id for update;
 perform 1 from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 authority:=public.read_workload_task(p_tenant_id,p_run_id,p_workload_id,'parikshan',p_proof_hash,p_scope);
 if authority is null or task.engagement_id is null or p_identity_expires_at is null
  or p_identity_expires_at<=clock_timestamp() or task.expires_at<=clock_timestamp()
 then return null; end if;
 return task;
end $$;
revoke all on function public.lock_assessment_workload_task(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated,service_role;

create function public.start_workload_assessment(
 p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_input_hash text,p_identity_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.workload_task_delegations; packet public.workload_assessment_packets;
 engagement public.engagements; library public.control_libraries; definitions jsonb; digest text; receipt bigint;
begin
 task:=public.lock_assessment_workload_task(p_tenant_id,p_run_id,p_workload_id,p_proof_hash,'control_library.read',p_identity_expires_at);
 if task.run_id is null or task.input_hash is distinct from p_input_hash or not ('findings.write'=any(task.scopes)) then return jsonb_build_object('error','task_refused'); end if;
 select * into packet from public.workload_assessment_packets where run_id=p_run_id;
 if found then return jsonb_build_object('engagement_id',packet.engagement_id,'library_version',packet.library_version,
  'library_digest',packet.library_digest,'controls',packet.controls,'started_receipt',packet.started_receipt::text); end if;
 select * into engagement from public.engagements where tenant_id=p_tenant_id and id=task.engagement_id;
 -- A new immutable assessment snapshot must not replace human-reviewed results
 -- or another completed run. Reassessment uses a new engagement.
 if engagement.status not in ('intake','discovery','classification','assessment')
  or exists(select 1 from public.findings where engagement_id=engagement.id)
 then return jsonb_build_object('error','assessment_already_started'); end if;
 select * into library from public.control_libraries where version=engagement.library_version for share;
 if not found or library.status not in ('published','deprecated') or library.control_count not between 1 and 500
 then return jsonb_build_object('error','library_unavailable'); end if;
 select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) into definitions
 from public.controls c where library_version=engagement.library_version;
 if jsonb_array_length(definitions)<>library.control_count then return jsonb_build_object('error','library_unavailable'); end if;
 digest:=encode(sha256(convert_to(definitions::text,'UTF8')),'hex');
 receipt:=public.append_ledger(p_tenant_id=>p_tenant_id,p_correlation_id=>task.correlation_id,p_actor_type=>'agent',p_actor_id=>'parikshan',
  p_agent_version=>null,p_model_id=>null,p_prompt_hash=>null,p_action_type=>'assessment.started',p_target_ref=>engagement.id::text,
  p_input_hash=>p_input_hash,p_output_hash=>null,p_approval_token_id=>null,p_approver_id=>null,p_pre_state_ref=>null,p_post_state_ref=>null,p_result=>'pending',
  p_detail=>jsonb_build_object('run_id',p_run_id,'workload_id',p_workload_id,'library_version',library.version,'library_digest',digest));
 insert into public.workload_assessment_packets(run_id,tenant_id,engagement_id,library_version,controls,library_digest,started_receipt)
 values(p_run_id,p_tenant_id,engagement.id,library.version,definitions,digest,receipt);
 update public.agent_runs set status='running' where id=p_run_id;
 update public.engagements set status='assessment' where id=engagement.id;
 if least(task.expires_at,p_identity_expires_at)<=clock_timestamp() then raise exception 'task_expired' using errcode='42501'; end if;
 return jsonb_build_object('engagement_id',engagement.id,'library_version',library.version,'library_digest',digest,'controls',definitions,'started_receipt',receipt::text);
end $$;
revoke all on function public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.start_workload_assessment(uuid,uuid,uuid,text,text,timestamptz) to service_role;

create function public.complete_workload_assessment(
 p_tenant_id uuid,p_run_id uuid,p_workload_id uuid,p_proof_hash text,p_library_digest text,p_result jsonb,p_identity_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.workload_task_delegations; packet public.workload_assessment_packets;
 digest text; receipt bigint; finding jsonb; score numeric; risk numeric; posture numeric; exposure bigint;
begin
 task:=public.lock_assessment_workload_task(p_tenant_id,p_run_id,p_workload_id,p_proof_hash,'findings.write',p_identity_expires_at);
 if task.run_id is null then return jsonb_build_object('error','task_refused'); end if;
 select * into packet from public.workload_assessment_packets where run_id=p_run_id for update;
 if not found or packet.library_digest is distinct from p_library_digest then return jsonb_build_object('error','snapshot_required'); end if;
 if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>1048576
  or p_result->>'library_version' is distinct from packet.library_version
  or jsonb_typeof(p_result->'findings') is distinct from 'array'
  or jsonb_typeof(p_result->'posture_score') is distinct from 'number'
  or jsonb_typeof(p_result->'estimated_exposure_inr') is distinct from 'number'
 then return jsonb_build_object('error','invalid_result'); end if;
 digest:=encode(sha256(convert_to(p_result::text,'UTF8')),'hex');
 if packet.completed_receipt is not null then
  if packet.result_digest<>digest then return jsonb_build_object('error','result_conflict'); end if;
  return jsonb_build_object('completed_receipt',packet.completed_receipt::text,'result_digest',digest);
 end if;
 if exists(select 1 from public.findings where engagement_id=packet.engagement_id)
  or not exists(select 1 from public.engagements where id=packet.engagement_id and tenant_id=p_tenant_id and status='assessment' and library_version=packet.library_version)
 then return jsonb_build_object('error','assessment_conflict'); end if;
 if jsonb_array_length(p_result->'findings')<>jsonb_array_length(packet.controls)
  or (select count(distinct f->>'control_id') from jsonb_array_elements(p_result->'findings') f)<>jsonb_array_length(packet.controls)
  or exists(select 1 from jsonb_array_elements(p_result->'findings') f where not exists(
    select 1 from jsonb_array_elements(packet.controls) c where c->>'id'=f->>'control_id'))
 then return jsonb_build_object('error','invalid_result'); end if;
 posture:=(p_result->>'posture_score')::numeric;
 if posture<0 or posture>100 or round(posture,2)<>posture
  or (p_result->>'estimated_exposure_inr')::numeric<0
  or (p_result->>'estimated_exposure_inr')::numeric>9007199254740991
  or trunc((p_result->>'estimated_exposure_inr')::numeric)<>(p_result->>'estimated_exposure_inr')::numeric
 then return jsonb_build_object('error','invalid_result'); end if;
 exposure:=(p_result->>'estimated_exposure_inr')::bigint;
 -- Validate the whole batch before any writes; errors below roll back all rows.
 for finding in select value from jsonb_array_elements(p_result->'findings') loop
  if jsonb_typeof(finding->'score') is distinct from 'number' or jsonb_typeof(finding->'risk_points') is distinct from 'number'
   or jsonb_typeof(finding->'rationale') is distinct from 'string' or length(finding->>'rationale') not between 1 and 4000
  then return jsonb_build_object('error','invalid_result'); end if;
  score:=(finding->>'score')::numeric; risk:=(finding->>'risk_points')::numeric;
  if score<0 or score>100 or round(score,2)<>score or risk<0 or risk>99999.99 or round(risk,2)<>risk
  then return jsonb_build_object('error','invalid_result'); end if;
 end loop;
 for finding in select value from jsonb_array_elements(p_result->'findings') loop
  insert into public.findings(tenant_id,engagement_id,control_id,library_version,score,risk_points,rationale)
  values(p_tenant_id,packet.engagement_id,finding->>'control_id',packet.library_version,(finding->>'score')::numeric,(finding->>'risk_points')::numeric,finding->>'rationale');
 end loop;
 update public.engagements set posture_score=posture,estimated_exposure_inr=exposure,status='review',updated_at=clock_timestamp() where id=packet.engagement_id;
 receipt:=public.append_ledger(p_tenant_id=>p_tenant_id,p_correlation_id=>task.correlation_id,p_actor_type=>'agent',p_actor_id=>'parikshan',
  p_agent_version=>null,p_model_id=>null,p_prompt_hash=>null,p_action_type=>'assessment.scored',p_target_ref=>packet.engagement_id::text,
  p_input_hash=>task.input_hash,p_output_hash=>digest,p_approval_token_id=>null,p_approver_id=>null,p_pre_state_ref=>null,p_post_state_ref=>null,p_result=>'success',
  p_detail=>jsonb_build_object('run_id',p_run_id,'workload_id',p_workload_id,'library_version',packet.library_version,'library_digest',packet.library_digest,'finding_count',jsonb_array_length(p_result->'findings')));
 update public.workload_assessment_packets set result=p_result,result_digest=digest,completed_receipt=receipt,completed_at=clock_timestamp() where run_id=p_run_id;
 if least(task.expires_at,p_identity_expires_at)<=clock_timestamp() then raise exception 'task_expired' using errcode='42501'; end if;
 return jsonb_build_object('completed_receipt',receipt::text,'result_digest',digest);
end $$;
revoke all on function public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_workload_assessment(uuid,uuid,uuid,text,text,jsonb,timestamptz) to service_role;
