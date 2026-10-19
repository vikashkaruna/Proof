-- Dedicated deterministic Prativedan controller: one admitted computation,
-- immutable terminal facts and exact-response recovery. No model inference or
-- publication authority. Existing 0123/0126/0128 workflows keep their semantics.
create table public.prativedan_accounted_attempts (
 tenant_id uuid not null, operation_key uuid not null, run_id uuid not null unique,
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 task_sha256 text not null check(task_sha256 ~ '^[a-f0-9]{64}$'),
 started_receipt bigint not null unique references public.audit_ledger(id),
 primary key(tenant_id,operation_key),
 foreign key(tenant_id,operation_key) references public.prativedan_controller_admissions(tenant_id,operation_key)
);
create table public.prativedan_accounted_terminals (
 tenant_id uuid not null, operation_key uuid not null,
 output_text text check(octet_length(output_text) between 1 and 1048576),
 failure_code text check(failure_code in ('target_failed','invocation_cancelled','accounting_uncertain','current_authority_refused')),
 latency_ms integer not null check(latency_ms>=0),
 completed_receipt bigint not null unique references public.audit_ledger(id),
 primary key(tenant_id,operation_key),
 foreign key(tenant_id,operation_key) references public.prativedan_accounted_attempts(tenant_id,operation_key),
 check((output_text is null) <> (failure_code is null))
);
create table public.prativedan_accounted_capsules (
 tenant_id uuid not null, operation_key uuid not null,
 packet_text text not null check(octet_length(packet_text) between 1 and 4194304),
 packet_sha256 text not null check(packet_sha256=controller_security.prativedan123_hash(packet_text)),
 primary key(tenant_id,operation_key),
 foreign key(tenant_id,operation_key) references public.prativedan_accounted_terminals(tenant_id,operation_key)
);
-- These tables are controller-only append facts, not application tables.
do $$ declare n text; begin
 foreach n in array array['prativedan_accounted_attempts','prativedan_accounted_terminals','prativedan_accounted_capsules'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_prativedan_controller,axiom_model_accounting_controller',n);
  execute format('create trigger immutable_rows before update or delete on public.%I for each row execute function public.evidence_receipt_immutable()',n);
  execute format('create trigger no_truncate before truncate on public.%I for each statement execute function controller_security.prativedan123_no_truncate()',n);
 end loop;
end $$;

-- Preserve legacy validation exactly. Only an attempt admitted by the new
-- atomic start may record its terminal observation after human authority stops.
alter function controller_security.prativedan126_phase_valid(uuid,uuid,text) rename to prativedan172_previous_phase_valid;
revoke all on function controller_security.prativedan172_previous_phase_valid(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_prativedan_controller,axiom_model_accounting_controller;
alter table public.prativedan_controller_phases drop constraint prativedan_controller_phases_check;
alter table public.prativedan_controller_phases add constraint prativedan_controller_phases_output_check check(
 (phase='started' and output_sha256 is null) or
 (phase='completed' and (output_sha256 is null or output_sha256 ~ '^[a-f0-9]{64}$')));
create function controller_security.prativedan126_phase_valid(t uuid,k uuid,phase_name text) returns boolean
 language plpgsql stable security definer set search_path='' as $$
declare a public.prativedan_accounted_attempts; f public.prativedan_accounted_terminals;
 p public.prativedan_controller_phases; q public.prativedan_draft_requests;
 c public.prativedan_draft_claims; s public.prativedan_assessment_sources; l public.audit_ledger; detail jsonb;
begin
 select * into a from public.prativedan_accounted_attempts where tenant_id=t and operation_key=k;
 if a.run_id is null or phase_name='started' then
  return controller_security.prativedan172_previous_phase_valid(t,k,phase_name);
 end if;
 if phase_name is distinct from 'completed' then return false;end if;
 select * into f from public.prativedan_accounted_terminals where tenant_id=t and operation_key=k;
 select * into p from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase='completed';
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 select * into l from public.audit_ledger where tenant_id=t and id=f.completed_receipt;
 detail:=jsonb_build_object('phase',case when f.failure_code is null then 'completed' else 'failed' end,
  'run_id',q.run_id,'request_hash',q.request_sha256,'renderer_config_version','prativedan-draft-v1',
  'renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text),'started_entry',a.started_receipt::text);
 if f.failure_code is not null then detail:=detail||jsonb_build_object('failure_code',f.failure_code);end if;
 return coalesce(f.completed_receipt=p.receipt and a.started_receipt<p.receipt
  and l.actor_type='agent' and l.actor_id='prativedan' and l.agent_version='0.1.0'
  and l.action_type::text='report.generated' and l.correlation_id=k and l.target_ref=s.engagement_id::text
  and l.input_hash=c.runtime_normalized_input_sha256 and l.model_id is null and l.prompt_hash is null
  and l.approval_token_id is null and l.approver_id is null and l.pre_state_ref is null and l.post_state_ref is null
  and l.detail=detail and l.output_hash is not distinct from p.output_sha256
  and ((f.failure_code is null and l.result='success' and l.output_hash=controller_security.prativedan123_hash(f.output_text))
   or (f.failure_code is not null and l.result='failure' and l.output_hash is null)),false);
end $$;

-- Atomic admission opens the actual accounting journal before any target work.
-- Lost/replayed start replies never authorize another computation.
create function public.start_prativedan_accounted_draft(t uuid,k uuid,r uuid,rh text,input_text text,task_sha256 text,authority jsonb)
 returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare claim jsonb; first jsonb; loaded jsonb; q public.prativedan_draft_requests;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform public.read_prativedan_accounted_context(t,k,r,rh,authority);
 if task_sha256 is null or task_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'task commitment refused' using errcode='42501';end if;
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 if q.renderer_config_text is distinct from controller_security.prativedan123_config()
  or q.renderer_config_text::jsonb->'model_inference' is distinct from 'false'::jsonb
 then raise exception 'zero-only renderer required' using errcode='42501';end if;
 if exists(select 1 from public.prativedan_draft_claims where tenant_id=t and operation_key=k) then
  return jsonb_build_object('claimed',false,'invocation_uncertain',true);
 end if;
 claim:=public.claim_prativedan_assessment_draft(t,k,r,rh,input_text,authority);
 if claim->'claimed' is distinct from 'true'::jsonb then raise exception 'fresh claim required' using errcode='42501';end if;
 first:=public.record_prativedan_assessment_phase(t,k,r,rh,'started',null,authority);
 loaded:=controller_security.accounting128_load(t,r,rh,controller_security.accounting128_dedicated_dispatch(t,k,r,rh));
 if loaded->'claimed' is distinct from 'true'::jsonb then raise exception 'fresh accounting journal required' using errcode='42501';end if;
 insert into public.prativedan_accounted_attempts values(t,k,r,rh,task_sha256,(first->>'id')::bigint);
 return jsonb_build_object('claimed',true,'claim',claim,'started_receipt',first,'accounting_dispatch',loaded);
end $$;

-- Completion proves possession of a high-entropy task capability under the
-- original admitted actor/session/workload tuple. It grants no new work and
-- intentionally does not require a still-live human session/kill switch.
create function public.finish_prativedan_accounted_draft(t uuid,k uuid,r uuid,rh text,task_proof text,
 output_text text,failure_code text,latency_ms integer,authority jsonb)
 returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare a public.prativedan_accounted_attempts; adm public.prativedan_controller_admissions;
 q public.prativedan_draft_requests; c public.prativedan_draft_claims; s public.prativedan_assessment_sources;
 f public.prativedan_accounted_terminals; saved public.prativedan_accounted_capsules;
 detail jsonb; last bigint; seal jsonb; packet jsonb; packet_text text; out_hash text;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_credential(t);
 select * into a from public.prativedan_accounted_attempts where tenant_id=t and operation_key=k;
 select * into adm from public.prativedan_controller_admissions where tenant_id=t and operation_key=k;
 if a.run_id is distinct from r or a.request_sha256 is distinct from rh
  or task_proof is null or task_proof !~ '^[a-f0-9]{64}$'
  or controller_security.prativedan123_hash(task_proof) is distinct from a.task_sha256
  or jsonb_typeof(authority) is distinct from 'object'
  or authority-array['actor_id','session_id','workload_id','registration_version','subject','svid_expires_at']<>'{}'
  or authority->>'actor_id' is distinct from adm.actor_id::text or authority->>'session_id' is distinct from adm.session_id::text
  or authority->>'workload_id' is distinct from adm.workload_id::text
  or authority->>'registration_version' is distinct from adm.registration_version::text or authority->>'subject' is distinct from adm.subject
 then raise exception 'original admitted task required' using errcode='42501';end if;
 if latency_ms is null or latency_ms<0 or ((output_text is null)=(failure_code is null))
  or (failure_code is not null and failure_code not in ('target_failed','invocation_cancelled','accounting_uncertain','current_authority_refused'))
 then raise exception 'terminal facts refused' using errcode='42501';end if;
 select * into f from public.prativedan_accounted_terminals where tenant_id=t and operation_key=k;
 if found then
  if f.output_text is distinct from output_text or f.failure_code is distinct from failure_code or f.latency_ms is distinct from latency_ms
  then raise exception 'terminal replay conflict' using errcode='42501';end if;
  select * into saved from public.prativedan_accounted_capsules where tenant_id=t and operation_key=k;
  if saved.packet_text is null then raise exception 'terminal capsule missing' using errcode='42501';end if;
  return saved.packet_text::jsonb;
 end if;
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k;
 select * into c from public.prativedan_draft_claims where tenant_id=t and operation_key=k;
 select * into s from public.prativedan_assessment_sources where tenant_id=t and source_id=q.source_id;
 if exists(select 1 from public.model_accounting_call_starts where run_id=r)
 then raise exception 'zero-only attempt contains model calls' using errcode='42501';end if;
 if output_text is not null then
  if controller_security.prativedan123_output_valid(c.normalized_input_text::jsonb,controller_security.prativedan123_json(output_text,1048576)) is distinct from true
  then raise exception 'renderer output refused' using errcode='42501';end if;
  out_hash:=controller_security.prativedan123_hash(output_text);
 end if;
 detail:=jsonb_build_object('phase',case when failure_code is null then 'completed' else 'failed' end,'run_id',r,'request_hash',rh,
  'renderer_config_version','prativedan-draft-v1','renderer_config_sha256',controller_security.prativedan123_hash(q.renderer_config_text),
  'started_entry',a.started_receipt::text);
 if failure_code is not null then detail:=detail||jsonb_build_object('failure_code',failure_code);end if;
 last:=public.append_ledger(t,k,'agent','prativedan','0.1.0',null,null,'report.generated',s.engagement_id::text,
  c.runtime_normalized_input_sha256,out_hash,null,null,null,null,
  case when failure_code is null then 'success'::public.ledger_result else 'failure'::public.ledger_result end,detail);
 insert into public.prativedan_controller_phases(tenant_id,operation_key,phase,receipt,output_sha256) values(t,k,'completed',last,out_hash);
 insert into public.prativedan_accounted_terminals values(t,k,output_text,failure_code,latency_ms,last);
 seal:=controller_security.accounting128_seal(t,r,rh,a.started_receipt::text,last::text,controller_security.accounting128_dedicated_dispatch(t,k,r,rh));
 if seal->'summary'->>'basis' is distinct from 'no_model' then raise exception 'zero-only seal required' using errcode='42501';end if;
 packet:=(seal-array['serialization','calls_text','calls_sha256','summary','requested_receipt','agent_started_receipt','agent_completed_receipt','accounting_receipt'])
  ||jsonb_build_object('kind','accounted_agent_result','status',case when failure_code is null then 'succeeded' else 'failed' end,
   'latency_ms',latency_ms,'input_tokens',0,'output_tokens',0,'cost_usd','0.000000','error',failure_code,'runtime_output_text',output_text,
   'ledger_entry_ids',jsonb_build_array(a.started_receipt::text,last::text),
   'accounting_reference',jsonb_build_object('calls_sha256',seal->>'calls_sha256','receipt',seal->'accounting_receipt'));
 packet_text:=packet::text;
 insert into public.prativedan_accounted_capsules values(t,k,packet_text,controller_security.prativedan123_hash(packet_text));
 return packet;
end $$;

-- Exact result recovery requires fresh current reader authority. It does not
-- re-claim, render, start a model, or infer zero from an absent journal.
create function public.read_prativedan_accounted_draft(t uuid,k uuid,r uuid,rh text,authority jsonb)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare saved public.prativedan_accounted_capsules;begin
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 select * into saved from public.prativedan_accounted_capsules where tenant_id=t and operation_key=k;
 if saved.packet_text is null then return jsonb_build_object('missing',true);end if;
 return saved.packet_text::jsonb;
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('start_prativedan_accounted_draft','finish_prativedan_accounted_draft','read_prativedan_accounted_draft') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller',f.sig);
  execute format('grant execute on function %s to axiom_prativedan_controller',f.sig);
 end loop;
end $$;

-- Narrow registration/context reads for the credential-isolated private
-- controller. No table SELECT or service-role fallback is granted.
create function public.read_prativedan_accounted_registration(t uuid,subject text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare w public.workload_identities;begin
 perform controller_security.prativedan126_credential(t);
 if subject is null or subject !~ '^spiffe://[a-z0-9]([a-z0-9.-]*[a-z0-9])?/agent/prativedan$'
 then raise exception 'exact workload subject required' using errcode='42501';end if;
 select * into w from public.workload_identities where tenant_id=t and spiffe_id=subject and agent_name='prativedan' and status='active';
 if w.id is null then raise exception 'current workload registration required' using errcode='42501';end if;
 return jsonb_build_object('id',w.id,'tenant_id',w.tenant_id,'agent_name',w.agent_name,'spiffe_id',w.spiffe_id,'status',w.status,'version',w.version);
end $$;
create function public.read_prativedan_accounted_context(t uuid,k uuid,r uuid,rh text,authority jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
begin
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 if not exists(select 1 from auth.sessions where id=(authority->>'session_id')::uuid and user_id=(authority->>'actor_id')::uuid
  and (not_after is null or not_after>clock_timestamp()))
 then raise exception 'current authenticated session required' using errcode='42501';end if;
 return controller_security.prativedan123_read(t,k);
end $$;
revoke all on function public.read_prativedan_accounted_registration(uuid,text),public.read_prativedan_accounted_context(uuid,uuid,uuid,text,jsonb)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
grant execute on function public.read_prativedan_accounted_registration(uuid,text),public.read_prativedan_accounted_context(uuid,uuid,uuid,text,jsonb)
 to axiom_prativedan_controller;

-- A zero-only task cannot be upgraded into a model-using invocation through
-- older dedicated controller RPCs. Existing legacy invocations are unchanged.
alter function public.prativedan_begin_model_accounting_call(uuid,uuid,text,uuid,text,uuid,jsonb) set schema controller_security;
alter function controller_security.prativedan_begin_model_accounting_call(uuid,uuid,text,uuid,text,uuid,jsonb) rename to prativedan172_previous_begin;
revoke all on function controller_security.prativedan172_previous_begin(uuid,uuid,text,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_prativedan_controller,axiom_model_accounting_controller;
create function public.prativedan_begin_model_accounting_call(t uuid,r uuid,rh text,call_id uuid,start_text text,k uuid,authority jsonb)
 returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 if exists(select 1 from public.prativedan_accounted_attempts where tenant_id=t and operation_key=k)
 then raise exception 'deterministic renderer forbids model inference' using errcode='42501';end if;
 return controller_security.prativedan172_previous_begin(t,r,rh,call_id,start_text,k,authority);
end $$;
revoke all on function public.prativedan_begin_model_accounting_call(uuid,uuid,text,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
grant execute on function public.prativedan_begin_model_accounting_call(uuid,uuid,text,uuid,text,uuid,jsonb) to axiom_prativedan_controller;

revoke all on function controller_security.prativedan126_phase_valid(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_prativedan_controller,axiom_model_accounting_controller;
