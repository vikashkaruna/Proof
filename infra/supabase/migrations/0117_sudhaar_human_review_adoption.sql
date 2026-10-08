-- Human adoption records review work only. It grants no corrective-action authority.
alter type public.ledger_action_type add value if not exists 'plan.review_adopted';
alter table public.remediation_plans add column purpose text not null default 'remediation'
 check(purpose in ('remediation','source_review'));

create table public.plan_source_review_adoptions (
 plan_id uuid primary key references public.remediation_plans(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 proposal_operation_key uuid not null,
 adoption_key uuid not null,
 proposal_run_id uuid not null references public.sudhaar_settled_outputs(run_id) on delete restrict,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 output_hash text not null check(output_hash ~ '^[a-f0-9]{64}$'),
 reason text not null check(length(reason) between 20 and 2000 and reason=btrim(reason)),
 source jsonb not null,
 output_proof jsonb not null,
 task_count integer not null check(task_count between 1 and 500),
 adoption_receipt bigint not null unique references public.audit_ledger(id) on delete restrict,
 adoption_receipt_text text generated always as (adoption_receipt::text) stored,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,proposal_operation_key),unique(tenant_id,adoption_key),unique(tenant_id,plan_id),
 foreign key(tenant_id,plan_id) references public.remediation_plans(tenant_id,id) on delete restrict
);
alter table public.findings add constraint findings_tenant_id_unique unique(tenant_id,id);
create table public.plan_source_review_tasks (
 tenant_id uuid not null, plan_id uuid not null, sequence integer not null check(sequence between 1 and 500),
 finding_id uuid not null, task jsonb not null,
 primary key(plan_id,sequence),unique(plan_id,finding_id),
 foreign key(tenant_id,plan_id) references public.plan_source_review_adoptions(tenant_id,plan_id) deferrable initially deferred,
 foreign key(tenant_id,finding_id) references public.findings(tenant_id,id) on delete restrict
);
alter table public.plan_source_review_adoptions enable row level security;
alter table public.plan_source_review_tasks enable row level security;
revoke all on public.plan_source_review_adoptions,public.plan_source_review_tasks
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant select on public.plan_source_review_adoptions,public.plan_source_review_tasks to authenticated;
create policy tenant_member_read on public.plan_source_review_adoptions for select to authenticated using(public.is_tenant_member(tenant_id));
create policy tenant_member_read on public.plan_source_review_tasks for select to authenticated using(public.is_tenant_member(tenant_id));
create trigger review_adoption_immutable before update or delete on public.plan_source_review_adoptions for each row execute function public.evidence_receipt_immutable();
create function controller_security.review_task_insert_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.plan_source_review_adoptions where plan_id=new.plan_id)
 then raise exception 'source review task set is immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger review_task_no_append before insert on public.plan_source_review_tasks for each row execute function controller_security.review_task_insert_guard();
create trigger review_task_immutable before update or delete on public.plan_source_review_tasks for each row execute function public.evidence_receipt_immutable();
create function controller_security.refuse_review_truncate() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'source review records are immutable' using errcode='42501'; end $$;
create trigger review_adoption_no_truncate before truncate on public.plan_source_review_adoptions for each statement execute function controller_security.refuse_review_truncate();
create trigger review_task_no_truncate before truncate on public.plan_source_review_tasks for each statement execute function controller_security.refuse_review_truncate();

create function controller_security.review_plan_purpose_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='UPDATE' and new.purpose is distinct from old.purpose
 then raise exception 'plan purpose is immutable' using errcode='42501'; end if;
 if new.purpose='source_review' and (new.status<>'review' or new.plan_approval_token_id is not null
  or new.depends_on is not null or new.version<>1 or new.aggregate_blast_radius<>'{}'::jsonb)
 then raise exception 'source review cannot acquire execution authority' using errcode='42501'; end if;
 if TG_OP='UPDATE' and old.purpose='source_review' and
  (new.tenant_id,new.engagement_id,new.library_version,new.title,new.description,new.generated_by_agent,new.created_at)
  is distinct from (old.tenant_id,old.engagement_id,old.library_version,old.title,old.description,old.generated_by_agent,old.created_at)
 then raise exception 'source review facts are immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger review_plan_purpose before insert or update on public.remediation_plans for each row execute function controller_security.review_plan_purpose_guard();
create function controller_security.review_plan_no_actions() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.remediation_plans where id=new.plan_id and tenant_id=new.tenant_id and purpose='source_review' for share;
 if found then raise exception 'source review cannot contain remediation actions' using errcode='42501'; end if;
 return new;
end $$;
create trigger review_plan_action_guard before insert or update on public.remediation_actions for each row execute function controller_security.review_plan_no_actions();
-- Deferred binding rejects unreceipted review plans even through privileged direct DML.
create function controller_security.review_plan_binding_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.purpose='source_review' and not exists(select 1 from public.plan_source_review_adoptions a
  where a.plan_id=new.id and a.tenant_id=new.tenant_id and a.task_count=(select count(*) from public.plan_source_review_tasks t where t.plan_id=new.id))
 then raise exception 'source review requires atomic adoption' using errcode='42501'; end if;
 return null;
end $$;
create constraint trigger review_plan_binding after insert or update on public.remediation_plans
 deferrable initially deferred for each row execute function controller_security.review_plan_binding_guard();

create function public.read_sudhaar_review_adoption_source(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare s public.sudhaar_settled_outputs; proof jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human planning writer required' using errcode='42501'; end if;
 select * into s from public.sudhaar_settled_outputs where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=p_operation_key;
 if not found then return jsonb_build_object('error','review_source_unavailable'); end if;
 proof:=public.recover_sudhaar_output(p_tenant_id,p_actor_id,s.engagement_id,p_operation_key,s.input_text);
 if proof ? 'error' or proof ? 'missing' then return jsonb_build_object('error','review_source_unavailable'); end if;
 return jsonb_build_object('input_text',s.input_text);
end $$;
revoke all on function public.read_sudhaar_review_adoption_source(uuid,uuid,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.read_sudhaar_review_adoption_source(uuid,uuid,uuid) to human_action_writer;

create function public.adopt_sudhaar_review(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_adoption_key uuid,
 p_reason text,p_acknowledge_review_only boolean,p_request_hash text,p_expected_input_hash text,p_expected_output_hash text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare s public.sudhaar_settled_outputs; a public.plan_source_review_adoptions; proof jsonb; proposal jsonb; input jsonb;
 body_hash text; plan uuid; receipt bigint; count_tasks integer;
begin
 if current_setting('role',true) is distinct from 'human_action_writer'
 then raise exception 'human planning writer required' using errcode='42501'; end if;
 if p_tenant_id is null or p_actor_id is null or p_operation_key is null or p_adoption_key is null
  or p_acknowledge_review_only is distinct from true or p_reason is null or length(p_reason) not between 20 and 2000 or p_reason<>btrim(p_reason)
  or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
 then return jsonb_build_object('error','review_adoption_conflict'); end if;
 body_hash:=encode(pg_catalog.sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_object(
  'tenantId',p_tenant_id,'actorId',p_actor_id,'proposalOperationKey',p_operation_key,'adoptionKey',p_adoption_key,
  'acknowledgeReviewOnly',true,'reason',p_reason)),'UTF8')),'hex');
 if body_hash is distinct from p_request_hash then return jsonb_build_object('error','review_adoption_conflict'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,117));
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_adoption_key::text,118));
 select * into s from public.sudhaar_settled_outputs where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=p_operation_key;
 if not found then return jsonb_build_object('error','review_source_unavailable'); end if;
 proof:=public.recover_sudhaar_output(p_tenant_id,p_actor_id,s.engagement_id,p_operation_key,s.input_text);
 if proof ? 'error' or proof ? 'missing' or s.input_hash is distinct from p_expected_input_hash or s.output_hash is distinct from p_expected_output_hash
 then return jsonb_build_object('error','review_source_unavailable'); end if;
 proposal:=s.output_text::jsonb; input:=s.input_text::jsonb;
 select * into a from public.plan_source_review_adoptions where tenant_id=p_tenant_id and
  (proposal_operation_key=p_operation_key or adoption_key=p_adoption_key);
 if found then
  if a.actor_id is distinct from p_actor_id or a.proposal_operation_key is distinct from p_operation_key
   or a.adoption_key is distinct from p_adoption_key or a.request_hash is distinct from body_hash or a.reason is distinct from p_reason
   or a.proposal_run_id is distinct from s.run_id or a.input_hash is distinct from s.input_hash or a.output_hash is distinct from s.output_hash
  then return jsonb_build_object('error','review_adoption_conflict'); end if;
 else
  count_tasks:=jsonb_array_length(proposal->'review_tasks');
  plan:=gen_random_uuid();
  insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title,description,status,purpose,generated_by_agent)
   values(plan,p_tenant_id,s.engagement_id,input#>>'{source,libraryVersion}',proposal->>'title',
    'Human-adopted source review tasks. No corrective actions or execution authority.','review','source_review','sudhaar');
  insert into public.plan_source_review_tasks(tenant_id,plan_id,sequence,finding_id,task)
   select p_tenant_id,plan,(t->>'sequence')::integer,(t->>'finding_id')::uuid,t from jsonb_array_elements(proposal->'review_tasks') t;
  receipt:=public.append_ledger(p_tenant_id,p_adoption_key,'human',p_actor_id::text,null,null,null,'plan.review_adopted',
   plan::text,body_hash,s.output_hash,null,null,null,null,'success',jsonb_build_object('purpose','source_review','plan_id',plan,
   'proposal_operation_key',p_operation_key,'proposal_run_id',s.run_id,'source',input->'source','task_count',count_tasks,
   'action_count',0,'execution_allowed',false,'reason',p_reason,'acknowledge_review_only',true,
   'adoption_key',p_adoption_key,'proposal_input_hash',s.input_hash,'settled_receipt',s.settled_receipt::text));
  insert into public.plan_source_review_adoptions(plan_id,tenant_id,actor_id,proposal_operation_key,adoption_key,proposal_run_id,
   request_hash,input_hash,output_hash,reason,source,output_proof,task_count,adoption_receipt)
   values(plan,p_tenant_id,p_actor_id,p_operation_key,p_adoption_key,s.run_id,body_hash,s.input_hash,s.output_hash,p_reason,input->'source',jsonb_build_object('runId',s.run_id,'inputHash',s.input_hash,'outputHash',s.output_hash,
    'requestedReceipt',s.requested_receipt::text,'startedReceipt',s.started_receipt::text,
    'completedReceipt',s.completed_receipt::text,'settledReceipt',s.settled_receipt::text),count_tasks,receipt)
   returning * into a;
 end if;
 return jsonb_build_object('tenantId',a.tenant_id,'actorId',a.actor_id,'proposalOperationKey',a.proposal_operation_key,
  'adoptionKey',a.adoption_key,'planId',a.plan_id,'requestHash',a.request_hash,'adoptionReceipt',a.adoption_receipt::text,
  'purpose','source_review','status','review','taskCount',a.task_count,'actionCount',0,'executionAllowed',false,'source',a.source,
  'outputProof',jsonb_build_object('runId',s.run_id,'inputHash',s.input_hash,'outputHash',s.output_hash,
   'requestedReceipt',s.requested_receipt::text,'startedReceipt',s.started_receipt::text,
   'completedReceipt',s.completed_receipt::text,'settledReceipt',s.settled_receipt::text));
end $$;
revoke all on function public.adopt_sudhaar_review(uuid,uuid,uuid,uuid,text,boolean,text,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.adopt_sudhaar_review(uuid,uuid,uuid,uuid,text,boolean,text,text,text) to human_action_writer;

alter function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_human_ledger_before_0117;
revoke all on function controller_security.append_human_ledger_before_0117(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.append_human_ledger(
 p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,
 p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
 p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='plan.review_adopted'
 then raise exception 'review adoption requires atomic resolution' using errcode='42501'; end if;
 return controller_security.append_human_ledger_before_0117(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,
  p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.append_human_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to human_action_writer;

alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0117;
revoke all on function controller_security.append_agent_ledger_before_0117(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
create function public.append_agent_ledger(
 p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,
 p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,
 p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='plan.review_adopted'
 then raise exception 'review adoption requires human atomic resolution' using errcode='42501'; end if;
 return controller_security.append_agent_ledger_before_0117(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
  p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,
  p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

-- Trigger entry points are owner controlled, never alternate public mutation APIs.
revoke all on function controller_security.refuse_review_truncate(),controller_security.review_plan_purpose_guard(),
 controller_security.review_plan_no_actions(),controller_security.review_plan_binding_guard(),controller_security.review_task_insert_guard()
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
