-- Reconciliation statements must describe the database-derived facts they sign.
-- A caller-supplied prose statement with a 64-character signature was not proof.
-- Archive mutation is a BFF-only trust boundary. The generic service_role key
-- is also held by agents and must never be able to forge a provider receipt or
-- impersonate a founder through a SECURITY DEFINER RPC.
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname='approval_archive_writer') then
    create role approval_archive_writer nologin noinherit nobypassrls;
  end if;
end $$;
alter role approval_archive_writer nologin noinherit nobypassrls;
grant approval_archive_writer to authenticator;
grant usage on schema public to approval_archive_writer;
-- 0085 already removed direct export INSERT. Move its remaining audited RPC to
-- the BFF-only role so an agent cannot impersonate a member and invent a
-- historical export receipt or approval.exported ledger entry.
revoke insert, update, delete on public.approval_exports from service_role;
revoke all on function public.record_approval_export(uuid,uuid,uuid,text,jsonb,jsonb,text,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.record_approval_export(uuid,uuid,uuid,text,jsonb,jsonb,text,bigint,uuid)
  to approval_archive_writer;

alter table public.plan_reconciliations
  drop constraint plan_reconciliations_statement_check;
alter table public.plan_reconciliations
  add constraint plan_reconciliations_statement_check
  check(octet_length(statement) between 1 and 262144);
create function public.prepare_plan_reconciliation(
  p_tenant_id uuid, p_plan_id uuid, p_batch_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  b public.execution_batches;
  t public.approval_tokens;
  v_out_of_scope jsonb;
  v_unexecuted jsonb;
  v_outcomes jsonb;
  v_verifications jsonb;
  v_digest text;
  v_facts jsonb;
begin
  select * into b from public.execution_batches
    where tenant_id=p_tenant_id and plan_id=p_plan_id and id=p_batch_id;
  if not found then return jsonb_build_object('error','batch_not_found'); end if;
  if b.finished_at is null then return jsonb_build_object('error','batch_not_finished'); end if;
  select * into t from public.approval_tokens
    where tenant_id=p_tenant_id and plan_id=p_plan_id and id=b.approval_token_id;
  if not found or t.action_ids is null or cardinality(t.action_ids)=0
    or cardinality(t.action_ids)<>(select count(distinct aid) from unnest(t.action_ids) aid)
    or t.signed_payload->>'contentDigest' is distinct from b.content_digest
    or b.mode is distinct from t.mode
    or b.concurrency is distinct from t.concurrency
    or b.stop_on_failure is distinct from t.stop_on_failure
    or t.signed_payload->>'planId' is distinct from p_plan_id::text
    or t.signed_payload->'actionIds' is distinct from
      (select to_jsonb(array_agg(aid order by aid)) from unnest(t.action_ids) aid)
    then return jsonb_build_object('error','approved_scope_unconfirmed'); end if;
  select coalesce(jsonb_agg(a.id::text order by a.id),'[]'::jsonb) into v_out_of_scope
    from public.remediation_actions a where a.tenant_id=p_tenant_id and a.execution_batch_id=b.id
      and not (t.action_ids @> array[a.id]);
  if jsonb_array_length(v_out_of_scope)>0 then
    return jsonb_build_object('error','out_of_scope_executed','action_ids',v_out_of_scope);
  end if;
  if exists(select 1 from unnest(t.action_ids) aid where not exists(
    select 1 from public.remediation_actions a where a.tenant_id=p_tenant_id
      and a.plan_id=p_plan_id and a.id=aid and a.execution_batch_id=b.id)) then
    return jsonb_build_object('error','execution_chain_incomplete');
  end if;
  select coalesce(jsonb_object_agg(a.id::text,coalesce(a.final_outcome::text,'unexecuted')),'{}'::jsonb)
    into v_outcomes from public.remediation_actions a
    where a.tenant_id=p_tenant_id and a.execution_batch_id=b.id and a.id=any(t.action_ids);
  select coalesce(jsonb_agg(jsonb_build_object('action_id',a.id,'reason','swept_unexecuted') order by a.id),'[]'::jsonb)
    into v_unexecuted from public.remediation_actions a
    where a.tenant_id=p_tenant_id and a.execution_batch_id=b.id and a.final_outcome is null;
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'action_id',v.action_id,
      'outcome',v.outcome,'checks',v.checks,'verified_at',v.verified_at) order by v.action_id,v.verified_at,v.id),'[]'::jsonb)
    into v_verifications from public.verification_results v
    where v.tenant_id=p_tenant_id and v.batch_id=b.id;
  v_digest:=public.action_set_content_digest(p_tenant_id,p_plan_id,t.action_ids);
  v_facts:=jsonb_build_object(
    'schema_version',2,'tenant_id',p_tenant_id,'plan_id',p_plan_id,'batch_id',b.id,
    'token_id',t.id,'approved_action_ids',to_jsonb(t.action_ids),
    'approved_content_digest',b.content_digest,'recomputed_content_digest',v_digest,
    'content_digest_drift',v_digest is distinct from b.content_digest,
    'batch_mode',b.mode,'batch_concurrency',b.concurrency,
    'batch_stop_on_failure',b.stop_on_failure,
    'batch_status',b.status,'finished_at',b.finished_at,
    'action_outcomes',v_outcomes,'unexecuted',v_unexecuted,
    'verification_results',v_verifications);
  if octet_length(v_facts::text)>262144 then
    return jsonb_build_object('error','statement_too_large');
  end if;
  return jsonb_build_object('statement',v_facts::text,'facts',v_facts);
end $$;

alter type public.ledger_action_type add value if not exists 'approval.archive.started';
alter type public.ledger_action_type add value if not exists 'approval.archive.settled';
alter type public.ledger_action_type add value if not exists 'approval.archive.released';

create table public.approval_proof_archives (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  token_id uuid not null unique,
  plan_id uuid not null,
  batch_id uuid not null,
  reconciliation_id uuid not null,
  operation_key uuid not null,
  actor_id uuid not null references public.users(id) on delete restrict,
  source_text text not null check(octet_length(source_text) between 1 and 4194304),
  source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes integer not null check(source_bytes between 1 and 4194304),
  provider text not null check(provider in ('s3','s3-compatible')),
  bucket text not null check(length(bucket) between 3 and 255),
  object_key text not null,
  retain_until timestamptz not null,
  correlation_id uuid not null,
  status text not null default 'pending' check(status in ('pending','settled','released')),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  released_at timestamptz,
  released_by uuid references public.users(id) on delete restrict,
  unique(tenant_id,id),unique(tenant_id,operation_key),
  foreign key(tenant_id,token_id) references public.approval_tokens(tenant_id,id) on delete restrict,
  foreign key(tenant_id,batch_id) references public.execution_batches(tenant_id,id) on delete restrict,
  foreign key(tenant_id,reconciliation_id) references public.plan_reconciliations(tenant_id,id) on delete restrict,
  check(source_bytes=octet_length(source_text)),
  check((status='pending' and settled_at is null and released_at is null and released_by is null)
    or (status='settled' and settled_at is not null and released_at is null and released_by is null)
    or (status='released' and settled_at is not null and released_at is not null and released_by is not null))
);
create table public.approval_proof_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  archive_id uuid not null unique,
  provider text not null check(provider in ('s3','s3-compatible')),
  bucket text not null,
  object_key text not null,
  version_id text not null check(length(version_id) between 1 and 1024 and btrim(version_id)<>'' and version_id<>'null'),
  content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check(byte_size between 1 and 4194304),
  retain_until timestamptz not null,
  readback_at timestamptz not null,
  lock_mode text not null check(lock_mode='COMPLIANCE'),
  legal_hold boolean not null check(legal_hold=false),
  encryption text not null check(encryption in ('AES256','aws:kms')),
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,id),unique(provider,bucket,object_key,version_id),
  foreign key(tenant_id,archive_id) references public.approval_proof_archives(tenant_id,id) on delete restrict
);
alter table public.approval_proof_archives enable row level security;
alter table public.approval_proof_versions enable row level security;
revoke all on public.approval_proof_archives,public.approval_proof_versions from public,anon,authenticated,service_role;
grant select on public.approval_proof_archives,public.approval_proof_versions to service_role;
create policy approval_archives_service_read on public.approval_proof_archives for select to service_role using(true);
create policy approval_versions_service_read on public.approval_proof_versions for select to service_role using(true);
create function public.approval_archive_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.status='released'
   or (to_jsonb(new)-array['status','settled_at','released_at','released_by']) is distinct from
      (to_jsonb(old)-array['status','settled_at','released_at','released_by'])
   or (old.status='pending' and (new.status<>'settled' or new.settled_at is null
       or new.released_at is not null or new.released_by is not null))
   or (old.status='settled' and (new.status<>'released' or new.settled_at is distinct from old.settled_at
       or new.released_at is null or new.released_by is null))
   then raise exception 'approval_archive_immutable' using errcode='42501'; end if;
 return new;
end $$;
revoke all on function public.approval_archive_immutable() from public,anon,authenticated,service_role;
create trigger approval_archive_immutable before update or delete on public.approval_proof_archives
  for each row execute function public.approval_archive_immutable();
create trigger approval_version_immutable before update or delete on public.approval_proof_versions
  for each row execute function public.evidence_receipt_immutable();

create function public.begin_approval_proof_archive(p_tenant_id uuid,p_actor_id uuid,p_token_id uuid,
  p_operation_key uuid,p_provider text,p_bucket text,p_object_key text,
  p_source_sha256 text,p_source_bytes integer,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.approval_tokens; b public.execution_batches; r public.plan_reconciliations;
  a public.approval_proof_archives; prepared jsonb; expected_key text;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_operation_key is null or p_correlation_id is null or p_provider not in ('s3','s3-compatible')
   or length(p_bucket) not between 3 and 255 or p_bucket !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
   or p_source_sha256 !~ '^[0-9a-f]{64}$' or p_source_bytes not between 1 and 4194304
   then return jsonb_build_object('error','invalid_request'); end if;
 select * into t from public.approval_tokens where tenant_id=p_tenant_id and id=p_token_id for update;
 if not found then return jsonb_build_object('error','approval_not_found'); end if;
 prepared:=public.prepare_approval_proof_source(p_tenant_id,p_token_id);
 if prepared ? 'error' then return prepared; end if;
 if prepared->>'sourceSha256' is distinct from p_source_sha256
   or (prepared->>'sourceBytes')::integer is distinct from p_source_bytes
   then return jsonb_build_object('error','source_changed'); end if;
 expected_key:='tenants/'||p_tenant_id::text||'/approvals/'||p_token_id::text||'/'||p_operation_key::text||'/'||p_source_sha256;
 if p_object_key is distinct from expected_key then return jsonb_build_object('error','invalid_request'); end if;
 select * into a from public.approval_proof_archives where tenant_id=p_tenant_id and token_id=p_token_id for update;
 if found then
   if a.operation_key is distinct from p_operation_key or a.source_sha256 is distinct from p_source_sha256
     or a.provider is distinct from p_provider or a.bucket is distinct from p_bucket
     then return jsonb_build_object('error','idempotency_conflict'); end if;
   return jsonb_build_object('archiveId',a.id,'status',a.status,'sourceText',a.source_text,
     'sourceSha256',a.source_sha256,'sourceBytes',a.source_bytes,'retainUntil',a.retain_until,
     'operationKey',a.operation_key,'replayed',true);
 end if;
 select * into b from public.execution_batches where tenant_id=p_tenant_id and approval_token_id=t.id;
 select * into r from public.plan_reconciliations where tenant_id=p_tenant_id and batch_id=b.id;
 insert into public.approval_proof_archives(tenant_id,token_id,plan_id,batch_id,reconciliation_id,
   operation_key,actor_id,source_text,source_sha256,source_bytes,provider,bucket,object_key,
   retain_until,correlation_id)
 values(p_tenant_id,t.id,t.plan_id,b.id,r.id,p_operation_key,p_actor_id,prepared->>'sourceText',
   p_source_sha256,p_source_bytes,p_provider,p_bucket,p_object_key,
   date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id)
 returning * into a;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'approval.archive.started',a.id::text,null,null,t.id,t.approver_id,null,null,'success',
   jsonb_build_object('archive_id',a.id,'token_id',t.id,'source_sha256',a.source_sha256));
 return jsonb_build_object('archiveId',a.id,'status',a.status,'sourceText',a.source_text,
   'sourceSha256',a.source_sha256,'sourceBytes',a.source_bytes,'retainUntil',a.retain_until,
   'operationKey',a.operation_key,'replayed',false);
end $$;
revoke all on function public.begin_approval_proof_archive(uuid,uuid,uuid,uuid,text,text,text,text,integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.begin_approval_proof_archive(uuid,uuid,uuid,uuid,text,text,text,text,integer,uuid)
  to approval_archive_writer;

-- The source is built from live producer rows, not a caller-authored export.
-- Historical prose reconciliations fail the exact statement comparison.
create function public.prepare_approval_proof_source(p_tenant_id uuid,p_token_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 t public.approval_tokens; b public.execution_batches; r public.plan_reconciliations;
 issuance public.audit_ledger; recon_event public.audit_ledger;
 prepared jsonb; actions jsonb; verifications jsonb; rollbacks jsonb; usages jsonb;
 source jsonb; source_text text; n integer;
begin
 select * into t from public.approval_tokens where tenant_id=p_tenant_id and id=p_token_id;
 if not found then return jsonb_build_object('error','approval_not_found'); end if;
 if t.status <> 'consumed' or t.consumed_at is null
   or t.signature !~ '^[0-9a-f]{64}$'
   or t.action_ids is null or cardinality(t.action_ids)=0
   or cardinality(t.action_ids)<>(select count(distinct aid) from unnest(t.action_ids) aid)
   or t.signed_payload->>'planId' is distinct from t.plan_id::text
   or t.signed_payload->'actionIds' is distinct from
     (select to_jsonb(array_agg(aid order by aid)) from unnest(t.action_ids) aid)
   or t.signed_payload->>'approverId' is distinct from t.approver_id::text
   or t.signed_payload->>'nonce' is distinct from t.nonce
   or (t.signed_payload->>'expiresAt')::timestamptz is distinct from t.expires_at
   or t.signed_payload->>'mode' is distinct from t.mode
   or t.signed_payload->'concurrency' is distinct from to_jsonb(t.concurrency)
   or t.signed_payload->'stopOnFailure' is distinct from to_jsonb(t.stop_on_failure)
   or coalesce(t.signed_payload->'conditions','{}'::jsonb) is distinct from t.conditions
   or t.signed_payload->>'contentDigest' !~ '^[0-9a-f]{64}$'
   then return jsonb_build_object('error','approval_signature_source_incomplete'); end if;
 select count(*) into n from public.execution_batches where tenant_id=p_tenant_id and approval_token_id=t.id;
 if n<>1 then return jsonb_build_object('error','execution_chain_incomplete'); end if;
 select * into b from public.execution_batches where tenant_id=p_tenant_id and approval_token_id=t.id;
 if b.plan_id is distinct from t.plan_id or b.finished_at is null or
   b.content_digest is distinct from t.signed_payload->>'contentDigest'
   then return jsonb_build_object('error','execution_chain_incomplete'); end if;
 select * into r from public.plan_reconciliations where tenant_id=p_tenant_id and batch_id=b.id;
 if not found then return jsonb_build_object('error','reconciliation_missing'); end if;
 prepared:=public.prepare_plan_reconciliation(p_tenant_id,t.plan_id,b.id);
 if prepared ? 'error' or r.statement is distinct from prepared->>'statement'
   or r.approved_scope->>'token_id' is distinct from t.id::text
   or r.approved_scope->>'content_digest' is distinct from b.content_digest
   then return jsonb_build_object('error','reconciliation_unverified'); end if;
 select * into issuance from public.audit_ledger where tenant_id=p_tenant_id
   and action_type='approval.token.issued' and approval_token_id=t.id
   order by sequence_no desc limit 1;
 if not found or issuance.approver_id is distinct from t.approver_id or
   issuance.detail->>'contentDigest' is distinct from b.content_digest
   then return jsonb_build_object('error','issuance_audit_missing'); end if;
 select * into recon_event from public.audit_ledger where tenant_id=p_tenant_id
   and action_type='execution.reconciliation.recorded' and detail->>'batch_id'=b.id::text
   order by sequence_no desc limit 1;
 if not found or recon_event.detail->>'statement_sha256' is distinct from
   encode(sha256(convert_to(r.statement,'UTF8')),'hex')
   then return jsonb_build_object('error','reconciliation_audit_missing'); end if;
 if exists(select 1 from unnest(t.action_ids) aid where not exists(
   select 1 from public.remediation_actions a join public.dry_runs d
     on d.tenant_id=a.tenant_id and d.id=a.latest_dry_run_id
   where a.tenant_id=p_tenant_id and a.plan_id=t.plan_id and a.id=aid
     and a.rollback_validated and a.rollback_definition is not null
     and d.action_id=a.id and d.plan_id=t.plan_id and d.status='succeeded'
     and d.created_at<=t.issued_at and d.expires_at>t.issued_at
     and d.diff=a.dry_run_result
     and d.parameters_hash=encode(sha256(convert_to(a.parameters::text,'UTF8')),'hex')
     and d.rollback_definition_hash=encode(sha256(convert_to(a.rollback_definition::text,'UTF8')),'hex')
 )) then return jsonb_build_object('error','dry_run_or_rollback_incomplete'); end if;
 if exists(select 1 from public.remediation_actions a where a.tenant_id=p_tenant_id
   and a.execution_batch_id=b.id and a.final_outcome in ('succeeded','rolled_back')
   and not exists(select 1 from public.verification_results v where v.tenant_id=p_tenant_id
     and v.batch_id=b.id and v.action_id=a.id))
   then return jsonb_build_object('error','verification_incomplete'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('action_id',a.id,'action_type',a.action_type,
   'parameters_hash',d.parameters_hash,'rollback_definition',a.rollback_definition,
   'rollback_definition_hash',d.rollback_definition_hash,'rollback_validated',a.rollback_validated,
   'dry_run',jsonb_build_object('id',d.id,'status',d.status,'diff',d.diff,
     'created_at',d.created_at,'expires_at',d.expires_at),
   'execution_batch_id',a.execution_batch_id,'final_outcome',a.final_outcome) order by a.id),'[]'::jsonb)
   into actions from public.remediation_actions a join public.dry_runs d
     on d.tenant_id=a.tenant_id and d.id=a.latest_dry_run_id
   where a.tenant_id=p_tenant_id and a.id=any(t.action_ids);
 if jsonb_array_length(actions)<>cardinality(t.action_ids) then
   return jsonb_build_object('error','action_chain_incomplete'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'action_id',v.action_id,
   'outcome',v.outcome,'checks',v.checks,'verified_at',v.verified_at)
   order by v.action_id,v.verified_at,v.id),'[]'::jsonb) into verifications
   from public.verification_results v where v.tenant_id=p_tenant_id and v.batch_id=b.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'action_id',x.action_id,
   'definition_hash',x.definition_hash,'status',x.status,'triggered_by',x.triggered_by,
   'started_at',x.started_at,'finished_at',x.finished_at) order by x.started_at,x.id),'[]'::jsonb)
   into rollbacks from public.rollback_executions x where x.tenant_id=p_tenant_id and x.batch_id=b.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'action_id',u.action_id,
   'valid',u.valid,'reason',u.reason,'created_at',u.created_at) order by u.created_at,u.id),'[]'::jsonb)
   into usages from public.approval_token_usages u where u.token_id=t.id;
 source:=jsonb_build_object('schema_version',1,'kind','approval_proof_source',
   'tenant_id',p_tenant_id,'plan_id',t.plan_id,'token',jsonb_build_object(
      'id',t.id,'approver_id',t.approver_id,'action_ids',to_jsonb(t.action_ids),
      'mode',t.mode,'concurrency',t.concurrency,'stop_on_failure',t.stop_on_failure,
      'issued_at',t.issued_at,'expires_at',t.expires_at,'consumed_at',t.consumed_at,
      'status',t.status,'reason',t.reason,'conditions',t.conditions,
      'signed_payload',t.signed_payload,'signature',t.signature),
   'issuance_ledger',jsonb_build_object('sequence_no',issuance.sequence_no,
      'entry_hash',issuance.entry_hash,'occurred_at',issuance.occurred_at,
      'detail',issuance.detail),
   'actions',actions,'token_usages',usages,
   'execution',jsonb_build_object('id',b.id,'request_key',b.request_key,
     'content_digest',b.content_digest,'mode',b.mode,'concurrency',b.concurrency,
     'stop_on_failure',b.stop_on_failure,'status',b.status,'started_at',b.started_at,
     'finished_at',b.finished_at),
   'verification_results',verifications,'rollback_executions',rollbacks,
   'reconciliation',jsonb_build_object('id',r.id,'statement',r.statement,
     'signature',r.statement_signature,'approved_scope',r.approved_scope,
     'executed_reality',r.executed_reality,'unexecuted',r.unexecuted,
     'parameter_diffs',r.parameter_diffs,'verification_outcomes',r.verification_outcomes,
     'reconciled_by_agent',r.reconciled_by_agent,'created_at',r.created_at),
   'reconciliation_ledger',jsonb_build_object('sequence_no',recon_event.sequence_no,
     'entry_hash',recon_event.entry_hash,'occurred_at',recon_event.occurred_at));
 source_text:=source::text;
 if octet_length(source_text)>4194304 then return jsonb_build_object('error','source_too_large'); end if;
 return jsonb_build_object('sourceText',source_text,
   'sourceSha256',encode(sha256(convert_to(source_text,'UTF8')),'hex'),
   'sourceBytes',octet_length(source_text));
end $$;
revoke all on function public.prepare_approval_proof_source(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_approval_proof_source(uuid,uuid) to service_role;
revoke all on function public.prepare_plan_reconciliation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_plan_reconciliation(uuid,uuid,uuid) to service_role;

create or replace function public.record_plan_reconciliation(
  p_tenant_id uuid,p_plan_id uuid,p_batch_id uuid,p_correlation_id uuid,
  p_statement text,p_statement_signature text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.execution_batches;
  t public.approval_tokens;
  prepared jsonb;
  f jsonb;
  existing public.plan_reconciliations;
  v_drift boolean;
begin
  if p_correlation_id is null or p_statement is null or octet_length(p_statement) not between 1 and 262144
    or p_statement_signature !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error','invalid_record');
  end if;
  select * into b from public.execution_batches
    where tenant_id=p_tenant_id and plan_id=p_plan_id and id=p_batch_id for update;
  if not found then return jsonb_build_object('error','batch_not_found'); end if;
  prepared:=public.prepare_plan_reconciliation(p_tenant_id,p_plan_id,p_batch_id);
  if prepared ? 'error' then return prepared; end if;
  if p_statement is distinct from prepared->>'statement' then
    return jsonb_build_object('error','statement_mismatch');
  end if;
  select * into existing from public.plan_reconciliations
    where tenant_id=p_tenant_id and batch_id=p_batch_id;
  if found then
    if existing.statement is distinct from p_statement or existing.statement_signature is distinct from p_statement_signature
      then return jsonb_build_object('error','reconciliation_conflict'); end if;
    return jsonb_build_object('reconciliation',jsonb_build_object('id',existing.id,'replayed',true));
  end if;
  select * into t from public.approval_tokens where tenant_id=p_tenant_id and id=b.approval_token_id;
  f:=prepared->'facts';
  v_drift:=(f->>'content_digest_drift')::boolean;
  insert into public.plan_reconciliations(tenant_id,plan_id,batch_id,approved_scope,executed_reality,
      unexecuted,parameter_diffs,verification_outcomes,statement,statement_signature,reconciled_by_agent)
  values(p_tenant_id,p_plan_id,b.id,
    jsonb_build_object('token_id',t.id,'nonce',t.nonce,'action_ids',to_jsonb(t.action_ids),
      'content_digest',b.content_digest),
    jsonb_build_object('batch_status',b.status,'content_digest_recomputed',f->>'recomputed_content_digest',
      'action_outcomes',f->'action_outcomes'),
    f->'unexecuted',
    case when v_drift then jsonb_build_array(jsonb_build_object('kind','content_digest_drift',
      'approved',b.content_digest,'recomputed',f->>'recomputed_content_digest')) else '[]'::jsonb end,
    jsonb_build_object('action_outcomes',f->'action_outcomes',
      'verification_results',f->'verification_results'),p_statement,p_statement_signature,'samadhan')
  returning * into existing;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'agent','samadhan',null,null,null,
    'execution.reconciliation.recorded',p_plan_id::text,null,null,null,null,null,null,
    (case when jsonb_array_length(f->'unexecuted')=0 and not v_drift then 'success' else 'skipped' end)::public.ledger_result,
    jsonb_build_object('batch_id',b.id,'reconciliation_id',existing.id,
      'statement_sha256',encode(sha256(convert_to(p_statement,'UTF8')),'hex')));
  return jsonb_build_object('reconciliation',jsonb_build_object('id',existing.id,
    'unexecuted',jsonb_array_length(f->'unexecuted'),'content_digest_drift',v_drift,'replayed',false));
end $$;

create function public.settle_approval_proof_archive(p_tenant_id uuid,p_actor_id uuid,
  p_archive_id uuid,p_receipt jsonb,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.approval_proof_archives; v public.approval_proof_versions;
  v_until timestamptz; v_readback timestamptz;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
   or octet_length(p_receipt::text)>16384 then return jsonb_build_object('error','invalid_receipt'); end if;
 select * into a from public.approval_proof_archives where tenant_id=p_tenant_id and id=p_archive_id for update;
 if not found then return jsonb_build_object('error','archive_not_found'); end if;
 select * into v from public.approval_proof_versions where tenant_id=p_tenant_id and archive_id=a.id;
 if found then
   if v.receipt is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
   return jsonb_build_object('archiveId',a.id,'status',a.status,'versionId',v.version_id,'replayed',true);
 end if;
 if a.status<>'pending' then return jsonb_build_object('error','archive_not_pending'); end if;
 if not(p_receipt ?& array['provider','bucket','object_key','version_id','content_hash','byte_size',
   'tenant_id','collected_by_agent','operation_id','retain_until','readback_at','lock_mode',
   'verified','legal_hold','encryption'])
   or (p_receipt-array['provider','bucket','object_key','version_id','content_hash','byte_size',
   'tenant_id','collected_by_agent','operation_id','retain_until','readback_at','lock_mode',
   'verified','legal_hold','encryption'])<>'{}'::jsonb
   or p_receipt->>'provider' is distinct from a.provider or p_receipt->>'bucket' is distinct from a.bucket
   or p_receipt->>'object_key' is distinct from a.object_key
   or p_receipt->>'content_hash' is distinct from a.source_sha256
   or p_receipt->'byte_size' is distinct from to_jsonb(a.source_bytes)
   or p_receipt->>'tenant_id' is distinct from p_tenant_id::text
   or p_receipt->>'collected_by_agent' is distinct from 'approval-proof-archive'
   or p_receipt->>'operation_id' is distinct from a.id::text
   or p_receipt->>'version_id' is null or length(p_receipt->>'version_id') not between 1 and 1024
   or btrim(p_receipt->>'version_id')='' or p_receipt->>'version_id'='null'
   or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE'
   or p_receipt->'verified' is distinct from 'true'::jsonb
   or p_receipt->'legal_hold' is distinct from 'false'::jsonb
   or p_receipt->>'encryption' not in ('AES256','aws:kms')
   then return jsonb_build_object('error','receipt_mismatch'); end if;
 begin
   v_until:=(p_receipt->>'retain_until')::timestamptz;
   v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then
   return jsonb_build_object('error','invalid_receipt');
 end;
 if v_until is null or not isfinite(v_until) or v_until<a.retain_until
   or v_readback is null or not isfinite(v_readback)
   or v_readback<clock_timestamp()-interval '5 minutes'
   or v_readback>clock_timestamp()+interval '5 minutes'
   then return jsonb_build_object('error','receipt_mismatch'); end if;
 insert into public.approval_proof_versions(tenant_id,archive_id,provider,bucket,object_key,
   version_id,content_hash,byte_size,retain_until,readback_at,lock_mode,legal_hold,encryption,receipt)
 values(p_tenant_id,a.id,a.provider,a.bucket,a.object_key,p_receipt->>'version_id',a.source_sha256,
   a.source_bytes,v_until,v_readback,'COMPLIANCE',false,p_receipt->>'encryption',p_receipt)
 returning * into v;
 update public.approval_proof_archives set status='settled',settled_at=clock_timestamp()
   where tenant_id=p_tenant_id and id=a.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'approval.archive.settled',a.id::text,null,null,a.token_id,null,null,null,'success',
   jsonb_build_object('archive_id',a.id,'source_sha256',a.source_sha256,
     'version_id',v.version_id,'retain_until',v.retain_until));
 return jsonb_build_object('archiveId',a.id,'status','settled','versionId',v.version_id,'replayed',false);
end $$;
revoke all on function public.settle_approval_proof_archive(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.settle_approval_proof_archive(uuid,uuid,uuid,jsonb,uuid) to approval_archive_writer;

create function public.release_approval_proof_archive(p_tenant_id uuid,p_actor_id uuid,
  p_archive_id uuid,p_source_sha256 text,p_version_id text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.approval_proof_archives; v public.approval_proof_versions; prepared jsonb;
begin
 if not public.report_founder_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null then return jsonb_build_object('error','invalid_request'); end if;
 select * into a from public.approval_proof_archives where tenant_id=p_tenant_id and id=p_archive_id for update;
 if not found then return jsonb_build_object('error','archive_not_found'); end if;
 select * into v from public.approval_proof_versions where tenant_id=p_tenant_id and archive_id=a.id;
 if not found or a.status='pending' then return jsonb_build_object('error','archive_not_settled'); end if;
 if p_source_sha256 is distinct from a.source_sha256 or p_version_id is distinct from v.version_id
   then return jsonb_build_object('error','archive_version_mismatch'); end if;
 prepared:=public.prepare_approval_proof_source(p_tenant_id,a.token_id);
 if prepared ? 'error' or prepared->>'sourceSha256' is distinct from a.source_sha256
   then return jsonb_build_object('error','source_changed'); end if;
 if a.status='released' then
   return jsonb_build_object('archiveId',a.id,'status','released','sourceSha256',a.source_sha256,
     'versionId',v.version_id,'replayed',true);
 end if;
 update public.approval_proof_archives set status='released',released_at=clock_timestamp(),released_by=p_actor_id
   where tenant_id=p_tenant_id and id=a.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
   'approval.archive.released',a.id::text,null,null,a.token_id,null,null,null,'success',
   jsonb_build_object('archive_id',a.id,'source_sha256',a.source_sha256,'version_id',v.version_id));
 return jsonb_build_object('archiveId',a.id,'status','released','sourceSha256',a.source_sha256,
   'versionId',v.version_id,'replayed',false);
end $$;
revoke all on function public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;

-- Reconciliation signatures are proof only after the database verifies the
-- exact statement under a key that the ordinary PostgREST service role cannot
-- read or replace. A missing/mismatched key fails closed before row or ledger.
create schema if not exists axiom_secrets;
revoke all on schema axiom_secrets from public, anon, authenticated, service_role;

create table axiom_secrets.reconciliation_keys (
  scope text primary key check (scope = 'global' or scope ~ '^tenant:[0-9a-f-]{36}$'),
  key_bytes bytea not null check (octet_length(key_bytes) >= 32),
  provisioned_at timestamptz not null default clock_timestamp()
);
revoke all on axiom_secrets.reconciliation_keys from public, anon, authenticated, service_role;

create function axiom_secrets.reconciliation_signature_valid(
  p_tenant_id uuid, p_statement text, p_signature text
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_key bytea; v_crypto_schema text; v_expected bytea; v_supplied bytea;
  v_diff integer:=0; i integer;
begin
  if p_tenant_id is null or p_statement is null or p_signature !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select key_bytes into v_key from axiom_secrets.reconciliation_keys
    where scope in ('tenant:' || p_tenant_id::text, 'global')
    order by (scope = 'tenant:' || p_tenant_id::text) desc limit 1;
  if v_key is null then return false; end if;
  select n.nspname into v_crypto_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if v_crypto_schema is null then return false; end if;
  execute pg_catalog.format('select %I.hmac($1,$2,$3)',v_crypto_schema)
    into v_expected using convert_to(p_statement,'UTF8'),v_key,'sha256';
  v_supplied:=decode(p_signature,'hex');
  for i in 0..31 loop
    v_diff:=v_diff | (get_byte(v_expected,i) # get_byte(v_supplied,i));
  end loop;
  return v_diff=0;
end $$;
revoke all on function axiom_secrets.reconciliation_signature_valid(uuid,text,text)
  from public, anon, authenticated, service_role;

-- Keep the historical comparison and insert logic private. The public RPC
-- checks the HMAC before it can invoke that logic or append success to Lekha.
alter function public.record_plan_reconciliation(uuid,uuid,uuid,uuid,text,text)
  rename to record_plan_reconciliation_unchecked;
revoke all on function public.record_plan_reconciliation_unchecked(uuid,uuid,uuid,uuid,text,text)
  from public, anon, authenticated, service_role;

create function public.record_plan_reconciliation(
  p_tenant_id uuid,p_plan_id uuid,p_batch_id uuid,p_correlation_id uuid,
  p_statement text,p_statement_signature text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare prepared jsonb;
begin
  if p_correlation_id is null or p_statement is null
    or octet_length(p_statement) not between 1 and 262144
    or p_statement_signature !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error','invalid_record');
  end if;
  prepared:=public.prepare_plan_reconciliation(p_tenant_id,p_plan_id,p_batch_id);
  if prepared ? 'error' then return prepared; end if;
  if p_statement is distinct from prepared->>'statement' then
    return jsonb_build_object('error','statement_mismatch');
  end if;
  if not axiom_secrets.reconciliation_signature_valid(
      p_tenant_id,p_statement,p_statement_signature) then
    return jsonb_build_object('error','reconciliation_signature_unverified');
  end if;
  return public.record_plan_reconciliation_unchecked(
    p_tenant_id,p_plan_id,p_batch_id,p_correlation_id,p_statement,p_statement_signature);
end $$;
revoke all on function public.record_plan_reconciliation(uuid,uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.record_plan_reconciliation(uuid,uuid,uuid,uuid,text,text)
  to service_role;

-- Historical rows may predate this verification. Never export one by relying
-- solely on its format or on the ledger event created at record time.
alter function public.prepare_approval_proof_source(uuid,uuid)
  rename to prepare_approval_proof_source_unverified;
revoke all on function public.prepare_approval_proof_source_unverified(uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.prepare_approval_proof_source(p_tenant_id uuid,p_token_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; source jsonb; reconciliation jsonb;
begin
  result:=public.prepare_approval_proof_source_unverified(p_tenant_id,p_token_id);
  if result ? 'error' then return result; end if;
  source:=(result->>'sourceText')::jsonb;
  reconciliation:=source->'reconciliation';
  if not axiom_secrets.reconciliation_signature_valid(
    p_tenant_id,reconciliation->>'statement',reconciliation->>'signature') then
    return jsonb_build_object('error','reconciliation_signature_unverified');
  end if;
  return result;
end $$;
revoke all on function public.prepare_approval_proof_source(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_approval_proof_source(uuid,uuid) to service_role;

-- A client-facing release requires an explicit founder review of the exact
-- frozen bytes and retained provider version. The review is append-only.
alter type public.ledger_action_type add value if not exists 'approval.archive.reviewed';
create table public.approval_proof_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  archive_id uuid not null unique,
  reviewed_by uuid not null references public.users(id) on delete restrict,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  version_id text not null check (length(version_id) between 1 and 1024),
  reviewed_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,id),
  foreign key(tenant_id,archive_id) references public.approval_proof_archives(tenant_id,id) on delete restrict
);
alter table public.approval_proof_reviews enable row level security;
revoke all on public.approval_proof_reviews from public,anon,authenticated,service_role;
grant select on public.approval_proof_reviews to service_role;
create policy approval_reviews_service_read on public.approval_proof_reviews
  for select to service_role using(true);
create trigger approval_review_immutable before update or delete on public.approval_proof_reviews
  for each row execute function public.evidence_receipt_immutable();

create function public.review_approval_proof_archive(
  p_tenant_id uuid,p_actor_id uuid,p_archive_id uuid,
  p_source_sha256 text,p_version_id text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.approval_proof_archives; v public.approval_proof_versions;
  r public.approval_proof_reviews; prepared jsonb;
begin
  if not public.report_founder_allowed(p_tenant_id,p_actor_id) then
    return jsonb_build_object('error','founder_authority_required'); end if;
  if p_correlation_id is null then return jsonb_build_object('error','invalid_request'); end if;
  select * into a from public.approval_proof_archives
    where tenant_id=p_tenant_id and id=p_archive_id for update;
  if not found then return jsonb_build_object('error','archive_not_found'); end if;
  if a.status <> 'settled' then return jsonb_build_object('error','archive_not_settled'); end if;
  select * into v from public.approval_proof_versions
    where tenant_id=p_tenant_id and archive_id=a.id;
  if not found or p_source_sha256 is distinct from a.source_sha256
    or p_version_id is distinct from v.version_id then
    return jsonb_build_object('error','archive_version_mismatch'); end if;
  prepared:=public.prepare_approval_proof_source(p_tenant_id,a.token_id);
  if prepared ? 'error' or prepared->>'sourceSha256' is distinct from a.source_sha256
    or prepared->>'sourceText' is distinct from a.source_text then
    return jsonb_build_object('error','source_changed'); end if;
  select * into r from public.approval_proof_reviews
    where tenant_id=p_tenant_id and archive_id=a.id;
  if found then
    if r.reviewed_by is distinct from p_actor_id or r.source_sha256 is distinct from p_source_sha256
      or r.version_id is distinct from p_version_id then
      return jsonb_build_object('error','review_conflict'); end if;
    return jsonb_build_object('archiveId',a.id,'sourceSha256',a.source_sha256,
      'versionId',v.version_id,'reviewedBy',r.reviewed_by,'replayed',true);
  end if;
  insert into public.approval_proof_reviews(tenant_id,archive_id,reviewed_by,source_sha256,version_id)
    values(p_tenant_id,a.id,p_actor_id,a.source_sha256,v.version_id) returning * into r;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
    'approval.archive.reviewed',a.id::text,null,null,a.token_id,null,null,null,'success',
    jsonb_build_object('archive_id',a.id,'source_sha256',a.source_sha256,
      'version_id',v.version_id,'review_id',r.id));
  return jsonb_build_object('archiveId',a.id,'sourceSha256',a.source_sha256,
    'versionId',v.version_id,'reviewedBy',r.reviewed_by,'replayed',false);
end $$;
revoke all on function public.review_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.review_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  to approval_archive_writer;

alter function public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  rename to release_approval_proof_archive_without_review_guard;
revoke all on function public.release_approval_proof_archive_without_review_guard(uuid,uuid,uuid,text,text,uuid)
  from public,anon,authenticated,service_role;
create function public.release_approval_proof_archive(
  p_tenant_id uuid,p_actor_id uuid,p_archive_id uuid,
  p_source_sha256 text,p_version_id text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare reviewed public.approval_proof_reviews; a public.approval_proof_archives;
  v public.approval_proof_versions;
begin
  if not public.report_founder_allowed(p_tenant_id,p_actor_id) then
    return jsonb_build_object('error','founder_authority_required'); end if;
  select * into a from public.approval_proof_archives
    where tenant_id=p_tenant_id and id=p_archive_id for update;
  if not found then return jsonb_build_object('error','archive_not_found'); end if;
  select * into v from public.approval_proof_versions
    where tenant_id=p_tenant_id and archive_id=p_archive_id;
  if not found or a.status='pending' then
    return jsonb_build_object('error','archive_not_settled'); end if;
  if p_source_sha256 is distinct from a.source_sha256 or p_version_id is distinct from v.version_id then
    return jsonb_build_object('error','archive_version_mismatch'); end if;
  select * into reviewed from public.approval_proof_reviews
    where tenant_id=p_tenant_id and archive_id=p_archive_id;
  if not found or reviewed.source_sha256 is distinct from p_source_sha256
    or reviewed.version_id is distinct from p_version_id then
    return jsonb_build_object('error','founder_review_required'); end if;
  return public.release_approval_proof_archive_without_review_guard(
    p_tenant_id,p_actor_id,p_archive_id,p_source_sha256,p_version_id,p_correlation_id);
end $$;
revoke all on function public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.release_approval_proof_archive(uuid,uuid,uuid,text,text,uuid)
  to approval_archive_writer;
