-- Source-bound human-approved Saakshi staged evidence lifecycle.
-- Temporary encrypted payloads; runtime receipts and exact immutable provider proof required.
begin;
create function controller_security.saakshi119_flat_json(v jsonb) returns text language sql immutable set search_path='' as $$
 select '{'||string_agg(to_json(key)::text||':'||value::text,',' order by key collate "C")||'}' from jsonb_each(v)
$$;

revoke all on function controller_security.saakshi119_flat_json(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create table public.saakshi119_sources (
 operation_id uuid primary key references public.evidence_ingestions(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id), actor_id uuid not null references public.users(id),
 operation_key uuid not null, resource_id uuid not null unique, run_id uuid not null unique references public.agent_runs(id),
 human_metadata jsonb not null check(jsonb_typeof(human_metadata)='object' and octet_length(human_metadata::text)<=20000),
 original_approval jsonb not null, payload_id uuid not null unique, cipher_hash text not null,
 human_body_hash text not null check(human_body_hash ~ '^[a-f0-9]{64}$'),
 input_text text not null check(octet_length(input_text) between 1 and 16000),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),

 requested_receipt bigint not null unique references public.audit_ledger(id),
 recorded_at timestamptz not null default clock_timestamp(), unique(tenant_id,operation_key)
);

create table public.saakshi119_temporary_payloads (
 id uuid primary key, operation_id uuid not null unique references public.saakshi119_sources(operation_id),
 ciphertext bytea not null check(octet_length(ciphertext) between 1 and 8388608),
 nonce bytea not null check(octet_length(nonce)=12), tag bytea not null check(octet_length(tag)=16),
 key_id text not null check(key_id ~ '^[a-zA-Z0-9_-]{1,80}$'), cipher_hash text not null,
 created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
 check(expires_at>created_at and expires_at<=created_at+interval '15 minutes')
);

create table public.saakshi119_payload_purges (
 operation_id uuid primary key references public.saakshi119_sources(operation_id), payload_id uuid not null unique,
 cipher_hash text not null, reason text not null check(reason in ('expired','settled')),
 purged_at timestamptz not null default clock_timestamp(), receipt_id uuid not null unique default gen_random_uuid()
);

create table public.saakshi119_terminals (
 operation_id uuid primary key references public.saakshi119_sources(operation_id), run_id uuid not null unique,
 reason text not null check(reason in ('expired_unconfirmed','expired_runtime_failure')), settlement_receipt bigint not null references public.audit_ledger(id),
 closed_at timestamptz not null default clock_timestamp()
);

create table public.saakshi119_upload_claims (
 operation_id uuid primary key references public.saakshi119_sources(operation_id) on delete restrict,
 run_id uuid not null unique references public.agent_runs(id), input_hash text not null,
 actor_id uuid not null references public.users(id), claimed_at timestamptz not null default clock_timestamp()
);

alter table public.saakshi119_temporary_payloads enable row level security;

alter table public.saakshi119_payload_purges enable row level security;

alter table public.saakshi119_terminals enable row level security;

revoke all on public.saakshi119_temporary_payloads,public.saakshi119_payload_purges,public.saakshi119_terminals
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_payload_immutable before update on public.saakshi119_temporary_payloads for each row execute function public.evidence_receipt_immutable();

create trigger saakshi119_purge_immutable before update or delete on public.saakshi119_payload_purges for each row execute function public.evidence_receipt_immutable();

create trigger saakshi119_terminal_immutable before update or delete on public.saakshi119_terminals for each row execute function public.evidence_receipt_immutable();

alter table public.saakshi119_sources enable row level security;

alter table public.saakshi119_upload_claims enable row level security;

revoke all on public.saakshi119_sources,public.saakshi119_upload_claims from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_sources_immutable before update or delete on public.saakshi119_sources for each row execute function public.evidence_receipt_immutable();

create trigger saakshi119_claims_immutable before update or delete on public.saakshi119_upload_claims for each row execute function public.evidence_receipt_immutable();

create function controller_security.saakshi119_authority(t uuid,a uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 lock table public.kill_switch_state in share mode;
 perform 1 from public.kill_switch_state where scope='global' or tenant_id=t for share;
 perform 1 from public.tenant_users where tenant_id=t and user_id=a for share;
 perform 1 from public.users where id=a for share;
 return public.evidence_manager_allowed(t,a)
  and exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  and not exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=t));
end $$;

revoke all on function controller_security.saakshi119_authority(uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

CREATE OR REPLACE FUNCTION public.prepare_saakshi119(t uuid, a uuid, k uuid, human_text text, provider text, bucket text, ciphertext bytea, nonce bytea, tag bytea, keyid text, ttl_seconds integer, expected_encryption text DEFAULT 'AES256', expected_legal_hold boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare human jsonb; body bytea; q jsonb; begun jsonb; r public.evidence_ingestions; d public.saakshi119_sources;
 input text; ih text; hh text; resource uuid; payloadid uuid; payloadclock timestamptz; approval jsonb; started jsonb; run public.agent_runs;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_authority(t,a) is not true then raise exception 'source authority refused' using errcode='42501';end if;
 if k is null or human_text is null or octet_length(human_text) not between 1 and 12000000 then raise exception 'invalid human source' using errcode='22023';end if;
 human:=human_text::jsonb;
 if jsonb_typeof(human)<>'object' or (human-array['operationKey','contentBase64','filename','contentType','evidenceType','description','controlIds','engagementId','retentionApproval'])<>'{}'::jsonb
 or not(human ?& array['operationKey','contentBase64','filename','contentType','evidenceType','description','controlIds','retentionApproval'])
 or human->>'operationKey' is distinct from k::text or jsonb_typeof(human->'contentBase64')<>'string'
 then raise exception 'invalid human source' using errcode='22023';end if;
 approval:=human->'retentionApproval';
 if expected_encryption is null or expected_encryption not in ('AES256','aws:kms') or expected_legal_hold is null
 or approval is distinct from jsonb_build_object('provider',provider,'bucket',bucket,'lockMode','COMPLIANCE','retentionPolicy','seven_years',
  'encryption',expected_encryption,'legalHold',expected_legal_hold,'acknowledgesImmutableRetention',true)
 then raise exception 'explicit configured human retention approval required' using errcode='42501';end if;
 if ciphertext is null or nonce is null or tag is null or keyid is null or ttl_seconds is null or ttl_seconds not between 1 and 900
  or octet_length(nonce)<>12 or octet_length(tag)<>16 or keyid !~ '^[a-zA-Z0-9_-]{1,80}$'
 then raise exception 'invalid temporary encrypted payload' using errcode='22023';end if;
 body:=decode(human->>'contentBase64','base64');
 if octet_length(body) not between 1 and 8388608 or octet_length(ciphertext)<>octet_length(body) or replace(encode(body,'base64'),E'\n','') is distinct from human->>'contentBase64'
 then raise exception 'invalid retained bytes' using errcode='22023';end if;
 hh:=encode(sha256(convert_to(human_text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('saakshi119/'||t::text||'/'||k::text,119));
 select * into d from public.saakshi119_sources where tenant_id=t and operation_key=k;
 if found then
  if d.actor_id is distinct from a or d.human_metadata is distinct from human-'contentBase64' or d.human_body_hash is distinct from hh
   or (d.input_text::jsonb)->>'provider' is distinct from provider or (d.input_text::jsonb)->>'bucket' is distinct from bucket
  then raise exception 'source replay conflict' using errcode='23505';end if;
  return jsonb_build_object('run_id',d.run_id,'operation_id',d.operation_id,'input_text',d.input_text,'input_hash',d.input_hash,'human_body_hash',d.human_body_hash,'requested_receipt',d.requested_receipt::text,'replayed',true);
 end if;

 if exists(select 1 from public.evidence_ingestions where tenant_id=t and operation_key=k) then raise exception 'legacy intent cannot be linked' using errcode='42501';end if;
 q:=jsonb_build_object('content_hash',encode(sha256(body),'hex'),'byte_size',octet_length(body),'mime_type',human->>'contentType','filename',human->>'filename',
 'evidence_type',human->>'evidenceType','description',human->>'description','control_ids',human->'controlIds','engagement_id',human->'engagementId',
 'collected_by_agent','saakshi','provider',provider,'bucket',bucket,'object_key','tenants/'||t::text||'/evidence-ingestions/'||k::text||'/'||encode(sha256(body),'hex'),
 'retention_policy',approval->>'retentionPolicy','legal_hold',approval->'legalHold');
 begun:=controller_security.begin_saakshi119_intent(t,a,k,q,k);
 if begun?'error' or begun->'replayed' is distinct from 'false'::jsonb then raise exception 'new evidence intent required: %',begun using errcode='42501';end if;
 select * into r from public.evidence_ingestions where id=(begun->>'operation_id')::uuid and tenant_id=t for update;
 if r.id is null or r.actor_id is distinct from a or r.correlation_id is distinct from k or r.status<>'pending' or r.request is distinct from q then raise exception 'intent mismatch';end if;

 update public.evidence_ingestions set updated_at=clock_timestamp() where id=r.id;
 resource:=gen_random_uuid();payloadid:=gen_random_uuid();
 input:=controller_security.saakshi119_flat_json(jsonb_build_object(
 'purpose','saakshi_owned_resource_stage_v1','tenant_id',t::text,'actor_id',a::text,'engagement_id',q->'engagement_id',
 'operation_id',r.id::text,'operation_key',k::text,'owned_resource_id',resource::text,'human_request_hash',hh,
 'provider',provider,'bucket',bucket,'object_key',q->>'object_key','content_hash',q->>'content_hash','byte_size',octet_length(body),
 'retain_until',to_char(r.retain_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'legal_hold',expected_legal_hold,'encryption',expected_encryption));
 ih:=encode(sha256(convert_to(input,'UTF8')),'hex');
 started:=public.record_generic_agent_run_start(t,a,'saakshi',r.engagement_id,k,ih);
 if started?'error' or started->'created' is distinct from 'true'::jsonb then raise exception 'new agent request required: %',started using errcode='42501';end if;
 select * into run from public.agent_runs where tenant_id=t and id=(started->>'run_id')::uuid for update;
 if run.id is null or run.input_redacted_hash is distinct from ih or run.metadata->>'requested_by' is distinct from a::text then raise exception 'run mismatch';end if;
 insert into public.saakshi119_sources(operation_id,tenant_id,actor_id,operation_key,resource_id,run_id,human_metadata,human_body_hash,input_text,input_hash,original_approval,payload_id,cipher_hash,requested_receipt)
 values(r.id,t,a,k,resource,run.id,human-'contentBase64',hh,input,ih,
 jsonb_build_object('sourceKind','human_uploaded_bytes','tenantId',t::text,'actorId',a::text,'engagementId',q->'engagement_id','operationKey',k::text,
 'bodyHash',hh,'contentHash',q->>'content_hash','byteSize',octet_length(body),'contentType',human->>'contentType','retention',approval),
 payloadid,encode(sha256(ciphertext),'hex'),(run.metadata->>'request_receipt')::bigint) returning * into d;
 payloadclock:=clock_timestamp();
 insert into public.saakshi119_temporary_payloads(id,operation_id,ciphertext,nonce,tag,key_id,cipher_hash,created_at,expires_at)
 values(payloadid,r.id,ciphertext,nonce,tag,keyid,encode(sha256(ciphertext),'hex'),payloadclock,payloadclock+make_interval(secs=>ttl_seconds));
 return jsonb_build_object('run_id',d.run_id,'operation_id',d.operation_id,'input_text',d.input_text,'input_hash',d.input_hash,'human_body_hash',d.human_body_hash,'requested_receipt',d.requested_receipt::text,'replayed',false);
end $function$;

CREATE OR REPLACE FUNCTION controller_security.saakshi119_source_valid(t uuid, a uuid, runid uuid, k uuid, ih text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.saakshi119_sources; r public.evidence_ingestions; run public.agent_runs; receipt public.audit_ledger; payload public.saakshi119_temporary_payloads;
begin
 if controller_security.saakshi119_authority(t,a) is not true then return false;end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and run_id=runid and operation_key=k;
 if not found then return false;end if;
 select * into r from public.evidence_ingestions where id=d.operation_id and tenant_id=t for update;
 if r.id is null or r.actor_id is distinct from a or r.correlation_id is distinct from k or r.status<>'pending'
 or d.input_hash is distinct from ih or ih is distinct from encode(sha256(convert_to(d.input_text,'UTF8')),'hex')
 or (d.input_text::jsonb)->>'human_request_hash' is distinct from d.human_body_hash
 or d.original_approval->>'bodyHash' is distinct from d.human_body_hash
 or d.original_approval->>'contentHash' is distinct from r.request->>'content_hash'
 or d.original_approval->'byteSize' is distinct from r.request->'byte_size'
 then return false;end if;
 if exists(select 1 from public.saakshi119_payload_purges where operation_id=r.id)
  or exists(select 1 from public.saakshi119_terminals where operation_id=r.id) then return false;end if;
 select * into payload from public.saakshi119_temporary_payloads where id=d.payload_id and operation_id=r.id for share;
 if payload.id is null or payload.expires_at<=clock_timestamp() or payload.cipher_hash is distinct from d.cipher_hash
  or encode(sha256(payload.ciphertext),'hex') is distinct from d.cipher_hash
  or octet_length(payload.ciphertext)::text is distinct from r.request->>'byte_size' then return false;end if;
 if r.engagement_id is not null then
  perform 1 from public.engagements where id=r.engagement_id and tenant_id=t and status<>'cancelled' for share;
  if not found then return false;end if;
 end if;
 select * into run from public.agent_runs where tenant_id=t and id=runid for update;
 select * into receipt from public.audit_ledger where tenant_id=t and id=d.requested_receipt;
 return run.id is not null and run.agent='saakshi' and run.status='running' and run.completed_at is null
 and run.correlation_id=k and run.engagement_id is not distinct from r.engagement_id and run.input_redacted_hash=ih
 and run.metadata->>'lifecycle_writer'='generic_agent_rpc_v1' and run.metadata->>'requested_by'=a::text
 and run.metadata->>'request_receipt'=d.requested_receipt::text
 and receipt.actor_type='human' and receipt.actor_id=a::text and receipt.action_type='agent.invocation.requested'
 and receipt.target_ref=runid::text and receipt.correlation_id=k and receipt.input_hash=ih and receipt.result='pending';
end $function$;

revoke all on function controller_security.saakshi119_source_valid(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

CREATE OR REPLACE FUNCTION public.consume_saakshi119_upload(t uuid, a uuid, runid uuid, k uuid, ih text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare d public.saakshi119_sources; inserted uuid;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_source_valid(t,a,runid,k,ih) is not true then raise exception 'source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where run_id=runid;
 insert into public.saakshi119_upload_claims(operation_id,run_id,input_hash,actor_id) values(d.operation_id,runid,ih,a)
 on conflict(operation_id) do nothing returning operation_id into inserted;
 return jsonb_build_object('mode',case when inserted is null then 'recover_only' else 'upload_once' end,'run_id',runid,'input_hash',ih,'expires_at_ms',(select floor(extract(epoch from expires_at)*1000)::bigint from public.saakshi119_temporary_payloads where id=d.payload_id));
end $function$;

revoke all on function public.consume_saakshi119_upload(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.consume_saakshi119_upload(uuid,uuid,uuid,uuid,text) to evidence_ingestion_writer;

alter function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) set schema controller_security;

alter function controller_security.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) rename to settle_evidence_ingest_before_119;

revoke all on function controller_security.settle_evidence_ingest_before_119(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create function public.settle_evidence_ingest(t uuid,a uuid,op uuid,receipt jsonb,corr uuid) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare r public.evidence_ingestions;
begin
 if not public.evidence_manager_allowed(t,a) then return jsonb_build_object('error','forbidden');end if;
 select * into r from public.evidence_ingestions where tenant_id=t and id=op for update;
 if not found then return jsonb_build_object('error','operation_not_found');end if;
 if exists(select 1 from public.saakshi119_sources where operation_id=op) then return jsonb_build_object('error','dedicated_saakshi_finalizer_required');end if;
 return controller_security.settle_evidence_ingest_before_119(t,a,op,receipt,corr);
end $$;

revoke all on function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.settle_evidence_ingest(uuid,uuid,uuid,jsonb,uuid) to evidence_ingestion_writer;

CREATE OR REPLACE FUNCTION public.expire_saakshi119_payload(t uuid, runid uuid, k uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare d public.saakshi119_sources; intent public.evidence_ingestions; payload public.saakshi119_temporary_payloads; run public.agent_runs; settled jsonb;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped cleanup writer required' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and run_id=runid and operation_key=k;
 if not found then raise exception 'source not found' using errcode='42501';end if;
 if controller_security.saakshi119_authority(t,d.actor_id) is not true then raise exception 'expiry source authority refused' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||((d.input_text::jsonb)->>'content_hash'),1));
 select * into intent from public.evidence_ingestions where tenant_id=t and id=d.operation_id for update;
 if exists(select 1 from public.saakshi119_payload_purges where operation_id=d.operation_id) then return jsonb_build_object('purged',true,'replayed',true);end if;
 select * into payload from public.saakshi119_temporary_payloads where operation_id=d.operation_id for update;
 if payload.id is null or payload.expires_at>clock_timestamp() or intent.status<>'pending' then raise exception 'payload not expired' using errcode='42501';end if;
 select * into run from public.agent_runs where tenant_id=t and id=runid for update;
 if run.status='running' then
  settled:=public.record_generic_agent_run_finish(t,d.actor_id,runid,'saakshi',intent.engagement_id,k,d.input_hash,'failed','agent_invocation_failed',null,null,null,null,null,null,null);
  if settled?'error' then raise exception 'expired attempt settlement refused: %',settled;end if;
  select * into run from public.agent_runs where tenant_id=t and id=runid;
 end if;
 if run.status<>'failed' or (run.metadata->>'runtime_outcome') is null or (run.metadata->>'runtime_outcome') not in ('unconfirmed','runtime_reported_failure') then raise exception 'terminal conflict';end if;

 update public.evidence_ingestions set updated_at=clock_timestamp(),last_error_code=case when run.metadata->>'runtime_outcome'='runtime_reported_failure' then 'expired_runtime_failure' else 'expired_unconfirmed' end where id=intent.id;
 delete from public.saakshi119_temporary_payloads where id=payload.id;
 insert into public.saakshi119_payload_purges(operation_id,payload_id,cipher_hash,reason) values(d.operation_id,payload.id,d.cipher_hash,'expired');
 insert into public.saakshi119_terminals(operation_id,run_id,reason,settlement_receipt) values(d.operation_id,runid,case when run.metadata->>'runtime_outcome'='runtime_reported_failure' then 'expired_runtime_failure' else 'expired_unconfirmed' end,(run.metadata->>'settlement_receipt')::bigint);
 return jsonb_build_object('purged',true,'replayed',false);
end $function$;

revoke all on function public.expire_saakshi119_payload(uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.expire_saakshi119_payload(uuid,uuid,uuid) to evidence_ingestion_writer;

CREATE OR REPLACE FUNCTION controller_security.begin_saakshi119_intent(p_tenant_id uuid, p_actor_id uuid, p_operation_key uuid, p_request jsonb, p_correlation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.evidence_ingestions; v_engagement uuid; v_size bigint; v_hash text; v_field text;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_correlation_id is null or p_request is null or jsonb_typeof(p_request)<>'object'
    or octet_length(p_request::text)>16384 then return jsonb_build_object('error','invalid_request'); end if;

 if (p_request-array['content_hash','byte_size','mime_type','filename','evidence_type','description','control_ids',
    'engagement_id','collected_by_agent','provider','bucket','object_key','retention_policy','legal_hold'])<>'{}'::jsonb
    or not(p_request ?& array['content_hash','byte_size','mime_type','evidence_type','control_ids','collected_by_agent',
      'provider','bucket','object_key','retention_policy','legal_hold']) then return jsonb_build_object('error','invalid_request'); end if;


 p_request:=jsonb_build_object('filename',null,'description',null,'engagement_id',null)||p_request;
 foreach v_field in array array['content_hash','mime_type','evidence_type','collected_by_agent','provider','bucket','object_key','retention_policy'] loop
  if jsonb_typeof(p_request->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 foreach v_field in array array['filename','description','engagement_id'] loop
  if p_request ? v_field and jsonb_typeof(p_request->v_field) not in ('string','null') then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 begin
  v_size:=(p_request->>'byte_size')::bigint;
  v_engagement:=(p_request->>'engagement_id')::uuid;
 exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error','invalid_request'); end;
 v_hash:=p_request->>'content_hash';
 if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' or v_size is null or v_size not between 1 and 8388608
    or jsonb_typeof(p_request->'byte_size')<>'number' or (p_request->>'byte_size') !~ '^[0-9]+$'
    or p_request->>'retention_policy' is distinct from 'seven_years'
    or jsonb_typeof(p_request->'legal_hold') is distinct from 'boolean'
    or jsonb_typeof(p_request->'control_ids') is distinct from 'array'
    or p_request->>'provider' not in ('s3','s3-compatible')
    or p_request->>'collected_by_agent' not in ('human','saakshi')
    or length(coalesce(p_request->>'mime_type','')) not between 1 and 200
    or length(coalesce(p_request->>'bucket','')) not between 3 and 255
    or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
    or p_request->>'object_key' is distinct from 'tenants/'||p_tenant_id::text||'/evidence-ingestions/'||p_operation_key::text||'/'||v_hash
    or p_request->>'evidence_type' not in ('document','config','screenshot','log','attestation','interview','inventory','report')
    or length(p_request->>'filename')>160 or length(p_request->>'description')>2000 then
  return jsonb_build_object('error','invalid_request');
 end if;
 if jsonb_array_length(p_request->'control_ids')>40 or exists(select 1 from jsonb_array_elements(p_request->'control_ids') x
    where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 100) then return jsonb_build_object('error','invalid_request'); end if;
 if exists(select 1 from jsonb_array_elements_text(p_request->'control_ids') x where not exists(select 1 from public.controls c where c.id=x)) then
  return jsonb_build_object('error','control_not_found'); end if;
 if v_engagement is not null then
  perform 1 from public.engagements where tenant_id=p_tenant_id and id=v_engagement for key share;
  if not found then return jsonb_build_object('error','engagement_not_found'); end if;
 end if;

 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 select * into r from public.evidence_ingestions where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then
  if r.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('operation_id',r.id,'operation_key',r.operation_key,'status',r.status,'evidence_id',r.evidence_id,'request',r.request,
    'retain_until',r.retain_until,'correlation_id',r.correlation_id,'replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||v_hash,1));
 if exists(select 1 from public.evidence where tenant_id=p_tenant_id and content_hash=v_hash) then
  return jsonb_build_object('error','content_already_registered'); end if;
 if exists(select 1 from public.evidence_ingestions pending where pending.tenant_id=p_tenant_id and pending.request->>'content_hash'=v_hash
  and not exists(select 1 from public.saakshi119_terminals terminal
   join public.saakshi119_sources source on source.operation_id=terminal.operation_id
   join public.agent_runs run on run.id=source.run_id and run.tenant_id=source.tenant_id
   join public.audit_ledger receipt on receipt.id=terminal.settlement_receipt and receipt.tenant_id=source.tenant_id
   where terminal.operation_id=pending.id and terminal.run_id=source.run_id and terminal.reason in ('expired_unconfirmed','expired_runtime_failure')
    and source.tenant_id=p_tenant_id and source.operation_key=pending.operation_key and source.actor_id=pending.actor_id
    and run.agent='saakshi' and run.status='failed' and run.input_redacted_hash=source.input_hash
    and ((terminal.reason='expired_unconfirmed' and run.metadata->>'runtime_outcome'='unconfirmed') or (terminal.reason='expired_runtime_failure' and run.metadata->>'runtime_outcome'='runtime_reported_failure')) and run.metadata->>'settlement_receipt'=terminal.settlement_receipt::text
    and receipt.action_type='agent.invocation.settled' and receipt.result='failure' and receipt.detail->>'runtime_outcome'=run.metadata->>'runtime_outcome' and receipt.actor_type='system'
    and receipt.actor_id='bff-generic-agent-controller' and receipt.target_ref=run.id::text
    and receipt.input_hash=source.input_hash)) then
  return jsonb_build_object('error','content_ingestion_pending'); end if;
 insert into public.evidence_ingestions(tenant_id,operation_key,engagement_id,actor_id,correlation_id,request,retain_until)
 values(p_tenant_id,p_operation_key,v_engagement,p_actor_id,p_correlation_id,p_request,date_trunc('second',clock_timestamp())+interval '7 years 1 second') returning * into r;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'evidence.ingestion.started',r.id::text,null,null,null,null,null,null,'success',
  jsonb_build_object('operation_id',r.id,'content_hash',v_hash,'byte_size',v_size,'provider',p_request->>'provider'));
 return jsonb_build_object('operation_id',r.id,'operation_key',r.operation_key,'status',r.status,'evidence_id',null,'request',r.request,
  'retain_until',r.retain_until,'correlation_id',r.correlation_id,'replayed',false);
end $function$

;

revoke all on function controller_security.begin_saakshi119_intent(uuid,uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create table public.saakshi119_terminal_contexts (
 operation_id uuid primary key references public.saakshi119_terminals(operation_id),
 termination_kind text not null check(termination_kind='administrative_payload_expiry'),
 runtime_observation text not null check(runtime_observation in ('unconfirmed','runtime_reported_failure')),
 provider_observation text not null check(provider_observation in ('not_attempted','outcome_unknown')),
 upload_lease_consumed boolean not null,
 original_target jsonb not null,
 content_hash text not null,
 created_at timestamptz not null default clock_timestamp(),
 check((upload_lease_consumed and provider_observation='outcome_unknown') or
       (not upload_lease_consumed and provider_observation='not_attempted'))
);

alter table public.saakshi119_terminal_contexts enable row level security;

revoke all on public.saakshi119_terminal_contexts from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_terminal_context_immutable before update or delete on public.saakshi119_terminal_contexts for each row execute function public.evidence_receipt_immutable();

CREATE OR REPLACE FUNCTION controller_security.saakshi119_capture_terminal_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.saakshi119_sources; consumed boolean; source jsonb; recorded_runtime text;
begin
 select * into d from public.saakshi119_sources where operation_id=new.operation_id;
 if d.run_id is distinct from new.run_id then raise exception 'terminal source mismatch';end if;
 consumed:=exists(select 1 from public.saakshi119_upload_claims where operation_id=d.operation_id and run_id=d.run_id and input_hash=d.input_hash and actor_id=d.actor_id);
 source:=d.input_text::jsonb;select metadata->>'runtime_outcome' into recorded_runtime from public.agent_runs where id=d.run_id;
 insert into public.saakshi119_terminal_contexts(operation_id,termination_kind,runtime_observation,provider_observation,upload_lease_consumed,original_target,content_hash)
 values(d.operation_id,'administrative_payload_expiry',recorded_runtime,case when consumed then 'outcome_unknown' else 'not_attempted' end,consumed,
 jsonb_build_object('provider',source->'provider','bucket',source->'bucket','objectKey',source->'object_key','expectedLockMode','COMPLIANCE','retainUntil',source->'retain_until','encryption',source->'encryption','legalHold',source->'legal_hold'),source->>'content_hash');
 return new;
end $function$

;

revoke all on function controller_security.saakshi119_capture_terminal_context() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_capture_terminal_context after insert on public.saakshi119_terminals for each row execute function controller_security.saakshi119_capture_terminal_context();

create function public.read_saakshi119_payload(t uuid,a uuid,runid uuid,k uuid,ih text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources; p public.saakshi119_temporary_payloads;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_source_valid(t,a,runid,k,ih) is not true then raise exception 'source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and run_id=runid and operation_key=k;
 select * into p from public.saakshi119_temporary_payloads where id=d.payload_id and operation_id=d.operation_id for share;
 if p.id is null or p.expires_at<=clock_timestamp() then raise exception 'source refused' using errcode='42501';end if;
 return jsonb_build_object('id',p.id,'binding',jsonb_build_object('source',d.input_text::jsonb,'runId',runid,'correlationId',k,'requestedReceipt',d.requested_receipt::text),
 'originalApproval',d.original_approval,'algorithm','AES-256-GCM','keyId',p.key_id,'nonce',encode(p.nonce,'hex'),'tag',encode(p.tag,'hex'),
 'ciphertextHash',p.cipher_hash,'ciphertextSize',octet_length(p.ciphertext),'createdAt',p.created_at,'expiresAt',p.expires_at,
 'purged',false,'ciphertextHex',encode(p.ciphertext,'hex'));
end $$;

revoke all on function public.read_saakshi119_payload(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.read_saakshi119_payload(uuid,uuid,uuid,uuid,text) to evidence_ingestion_writer;

create function public.current_saakshi119_payload(t uuid,a uuid,runid uuid,k uuid,ih text,payloadid uuid,ch text) returns boolean language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_source_valid(t,a,runid,k,ih) is not true then return false;end if;
 return exists(select 1 from public.saakshi119_sources d join public.saakshi119_temporary_payloads p on p.id=d.payload_id and p.operation_id=d.operation_id
 where d.tenant_id=t and d.actor_id=a and d.run_id=runid and d.operation_key=k and p.id=payloadid and d.cipher_hash=ch and p.cipher_hash=ch and p.expires_at>clock_timestamp());
end $$;

revoke all on function public.current_saakshi119_payload(uuid,uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.current_saakshi119_payload(uuid,uuid,uuid,uuid,text,uuid,text) to evidence_ingestion_writer;

create table public.saakshi119_dispatch_claims (
 run_id uuid primary key references public.saakshi119_sources(run_id), tenant_id uuid not null, operation_key uuid not null,
 input_hash text not null, claimed_at timestamptz not null default clock_timestamp()
);

alter table public.saakshi119_dispatch_claims enable row level security;

revoke all on public.saakshi119_dispatch_claims from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_dispatch_claims_immutable before update or delete on public.saakshi119_dispatch_claims for each row execute function public.evidence_receipt_immutable();

create function public.read_saakshi119_dispatch(t uuid,runid uuid,k uuid) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources;
begin
 if current_setting('role',true) is distinct from 'agent_ledger_writer' then raise exception 'scoped agent writer required' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and run_id=runid and operation_key=k;
 if d.operation_id is null or not controller_security.saakshi119_source_valid(t,d.actor_id,runid,k,d.input_hash) then raise exception 'source refused' using errcode='42501';end if;
 return jsonb_build_object('tenant_id',t,'run_id',runid,'operation_key',k,'input_text',d.input_text,'request_hash',d.input_hash,'requested_receipt',d.requested_receipt::text);
end $$;

revoke all on function public.read_saakshi119_dispatch(uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,evidence_ingestion_writer;

grant execute on function public.read_saakshi119_dispatch(uuid,uuid,uuid) to agent_ledger_writer;

create function public.claim_saakshi119_dispatch(t uuid,runid uuid,k uuid,ih text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources; inserted uuid; expiry bigint;
begin
 if current_setting('role',true) is distinct from 'agent_ledger_writer' then raise exception 'scoped agent writer required' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and run_id=runid and operation_key=k;
 if d.operation_id is null or not controller_security.saakshi119_source_valid(t,d.actor_id,runid,k,ih) then raise exception 'source refused' using errcode='42501';end if;
 select floor(extract(epoch from expires_at)*1000)::bigint into expiry from public.saakshi119_temporary_payloads where id=d.payload_id;
 insert into public.saakshi119_dispatch_claims(run_id,tenant_id,operation_key,input_hash) values(runid,t,k,ih) on conflict(run_id) do nothing returning run_id into inserted;
 return jsonb_build_object('run_id',runid,'claimed',inserted is not null,'expires_at_ms',expiry);
end $$;

revoke all on function public.claim_saakshi119_dispatch(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,evidence_ingestion_writer;

grant execute on function public.claim_saakshi119_dispatch(uuid,uuid,uuid,text) to agent_ledger_writer;

create table public.saakshi119_stage_observations (
 run_id uuid primary key references public.saakshi119_sources(run_id), operation_id uuid not null unique references public.saakshi119_sources(operation_id),
 output_text text not null check(octet_length(output_text) between 1 and 32000), output_hash text not null,
 version_id text not null check(length(version_id) between 1 and 1024 and version_id<>'null'),
 readback_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp()
);

alter table public.saakshi119_stage_observations enable row level security;

revoke all on public.saakshi119_stage_observations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_stage_observations_immutable before update or delete on public.saakshi119_stage_observations for each row execute function public.evidence_receipt_immutable();

create function public.record_saakshi119_stage(t uuid,a uuid,runid uuid,k uuid,ih text,output_text text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources; o jsonb; r jsonb; s jsonb; h text; existing public.saakshi119_stage_observations;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_source_valid(t,a,runid,k,ih) is not true then raise exception 'source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where run_id=runid;
 if not exists(select 1 from public.saakshi119_upload_claims where operation_id=d.operation_id and run_id=runid and input_hash=ih and actor_id=a)
 or not exists(select 1 from public.saakshi119_dispatch_claims where run_id=runid and tenant_id=t and operation_key=k and input_hash=ih)
 then raise exception 'unclaimed stage refused' using errcode='42501';end if;
 if output_text is null or octet_length(output_text) not between 1 and 32000 then raise exception 'invalid stage';end if;
 o:=output_text::jsonb;r:=o->'receipt';s:=d.input_text::jsonb;
 if jsonb_typeof(o)<>'object' or o-'kind'-'accepted'-'source'-'receipt'<>'{}'::jsonb or o->>'kind'<>'sealed_pending_registration' or o->'accepted' is distinct from 'false'::jsonb or o->'source' is distinct from s
 or jsonb_typeof(r)<>'object' or r-array['tenant_id','engagement_id','operation_id','provider','bucket','object_key','content_hash','byte_size','retain_until','legal_hold','encryption','correlation_id','version_id','collected_by_agent','readback_at','lock_mode','verified']<>'{}'::jsonb
 or not (r ?& array['tenant_id','engagement_id','operation_id','provider','bucket','object_key','content_hash','byte_size','retain_until','legal_hold','encryption','correlation_id','version_id','collected_by_agent','readback_at','lock_mode','verified'])
 or r->'tenant_id' is distinct from s->'tenant_id' or r->'engagement_id' is distinct from s->'engagement_id'
 or r->'operation_id' is distinct from s->'operation_id' or r->'provider' is distinct from s->'provider' or r->'bucket' is distinct from s->'bucket'
 or r->'object_key' is distinct from s->'object_key' or r->'content_hash' is distinct from s->'content_hash' or r->'byte_size' is distinct from s->'byte_size'
 or r->'legal_hold' is distinct from s->'legal_hold' or r->'encryption' is distinct from s->'encryption' or r->>'correlation_id' is distinct from k::text
 or r->>'collected_by_agent' is distinct from 'saakshi' or r->>'lock_mode' is distinct from 'COMPLIANCE' or r->'verified' is distinct from 'true'::jsonb
 or jsonb_typeof(r->'version_id')<>'string' or length(r->>'version_id') not between 1 and 1024 or r->>'version_id'='null'
 or (r->>'retain_until')::timestamptz<(s->>'retain_until')::timestamptz or abs(extract(epoch from (clock_timestamp()-(r->>'readback_at')::timestamptz)))>300
 then raise exception 'stage mismatch' using errcode='42501';end if;
 h:=encode(sha256(convert_to(output_text,'UTF8')),'hex');
 select * into existing from public.saakshi119_stage_observations where run_id=runid;
 if existing.run_id is not null then
 if existing.output_text is distinct from output_text or existing.output_hash is distinct from h then raise exception 'stage observation conflict' using errcode='42501';end if;
 return jsonb_build_object('recorded',true,'replayed',true,'output_hash',h);
 end if;
 insert into public.saakshi119_stage_observations(run_id,operation_id,output_text,output_hash,version_id,readback_at)
 values(runid,d.operation_id,output_text,h,r->>'version_id',(r->>'readback_at')::timestamptz);
 return jsonb_build_object('recorded',true,'replayed',false,'output_hash',h);
end $$;

revoke all on function public.record_saakshi119_stage(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.record_saakshi119_stage(uuid,uuid,uuid,uuid,text,text) to evidence_ingestion_writer;

create table public.saakshi119_terminal_stage_links (
 operation_id uuid primary key references public.saakshi119_terminals(operation_id),
 run_id uuid not null unique references public.saakshi119_stage_observations(run_id),
 observed_version text not null, observed_output_hash text not null,
 accepted boolean not null default false check(not accepted), recorded_at timestamptz not null default clock_timestamp()
);

alter table public.saakshi119_terminal_stage_links enable row level security;

revoke all on public.saakshi119_terminal_stage_links from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_terminal_stage_links_immutable before update or delete on public.saakshi119_terminal_stage_links for each row execute function public.evidence_receipt_immutable();

create function controller_security.saakshi119_preserve_observed_version() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.saakshi119_terminal_stage_links(operation_id,run_id,observed_version,observed_output_hash)
 select new.operation_id,new.run_id,s.version_id,s.output_hash from public.saakshi119_stage_observations s where s.run_id=new.run_id and s.operation_id=new.operation_id;
 return new;
end $$;

revoke all on function controller_security.saakshi119_preserve_observed_version() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_preserve_observed_version after insert on public.saakshi119_terminals for each row execute function controller_security.saakshi119_preserve_observed_version();

create table public.saakshi119_settled_outputs (
 run_id uuid primary key references public.saakshi119_sources(run_id), tenant_id uuid not null, actor_id uuid not null, operation_key uuid not null,
 input_hash text not null, output_text text not null, output_hash text not null,
 evidence_id uuid not null references public.evidence(id), object_version_id uuid not null references public.evidence_object_versions(id),
 requested_receipt bigint not null references public.audit_ledger(id), started_receipt bigint not null references public.audit_ledger(id),
 completed_receipt bigint not null references public.audit_ledger(id), settled_receipt bigint not null unique references public.audit_ledger(id),
 recorded_at timestamptz not null default clock_timestamp(), unique(tenant_id,operation_key)
);

alter table public.saakshi119_settled_outputs enable row level security;

revoke all on public.saakshi119_settled_outputs from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create trigger saakshi119_settled_outputs_immutable before update or delete on public.saakshi119_settled_outputs for each row execute function public.evidence_receipt_immutable();

alter function public.record_generic_agent_run_finish(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text) set schema controller_security;

alter function controller_security.record_generic_agent_run_finish(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text) rename to generic_finish_before_119;

revoke all on function controller_security.generic_finish_before_119(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create function public.record_generic_agent_run_finish(p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_agent text,p_engagement_id uuid,p_correlation_id uuid,p_request_hash text,p_status text,p_error text,p_latency_ms integer,p_input_tokens integer,p_output_tokens integer,p_cost_usd numeric,p_started_receipt text,p_completed_receipt text,p_response_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_agent='saakshi' and p_status='succeeded' and exists(select 1 from public.saakshi119_sources where run_id=p_run_id)
 then return jsonb_build_object('error','dedicated_saakshi_finalizer_required');end if;
 return controller_security.generic_finish_before_119(p_tenant_id,p_actor_id,p_run_id,p_agent,p_engagement_id,p_correlation_id,p_request_hash,p_status,p_error,p_latency_ms,p_input_tokens,p_output_tokens,p_cost_usd,p_started_receipt,p_completed_receipt,p_response_hash);
end $$;

revoke all on function public.record_generic_agent_run_finish(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text) from public,anon,authenticated,service_role,agent_ledger_writer,evidence_ingestion_writer;

grant execute on function public.record_generic_agent_run_finish(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text) to human_action_writer;

CREATE OR REPLACE FUNCTION public.finalize_saakshi119(t uuid, a uuid, runid uuid, k uuid, ih text, output_text text, started text, completed text, latency integer, inputtokens integer, outputtokens integer, cost numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare d public.saakshi119_sources; observed public.saakshi119_stage_observations; run public.agent_runs; domain jsonb; outcome jsonb; oh text; payload public.saakshi119_temporary_payloads; saved public.saakshi119_settled_outputs;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_authority(t,a) is not true then raise exception 'source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and run_id=runid and operation_key=k;
 if d.run_id is null or d.input_hash is distinct from ih then raise exception 'source refused' using errcode='42501';end if;

 perform 1 from public.evidence_ingestions where tenant_id=t and id=d.operation_id for update;
 select * into saved from public.saakshi119_settled_outputs where run_id=runid;
 if saved.run_id is not null then
  if controller_security.saakshi119_saved_valid(t,a,k,d.human_body_hash) is not true
  or saved.input_hash is distinct from ih or saved.output_text is distinct from output_text
  or saved.started_receipt::text is distinct from started or saved.completed_receipt::text is distinct from completed
  then raise exception 'settlement replay refused' using errcode='42501';end if;
  select * into run from public.agent_runs where tenant_id=t and id=runid;
  if run.latency_ms is distinct from latency or run.input_tokens is distinct from inputtokens
   or run.output_tokens is distinct from outputtokens or run.cost_usd is distinct from cost
  then raise exception 'settlement replay refused' using errcode='42501';end if;
  return jsonb_build_object('accepted',true,'run_id',runid,'evidence_id',saved.evidence_id,
   'object_version_id',saved.object_version_id,'output_hash',saved.output_hash,'replayed',true);
 end if;
 if controller_security.saakshi119_source_valid(t,a,runid,k,ih) is not true then raise exception 'source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and run_id=runid and operation_key=k;
 select * into observed from public.saakshi119_stage_observations where run_id=runid;
 oh:=encode(sha256(convert_to(output_text,'UTF8')),'hex');
 if observed.run_id is null or observed.output_text is distinct from output_text or observed.output_hash is distinct from oh
 or not exists(select 1 from public.saakshi119_dispatch_claims where run_id=runid and input_hash=ih)
 or not exists(select 1 from public.saakshi119_upload_claims where operation_id=d.operation_id and run_id=runid and input_hash=ih and actor_id=a)
 then raise exception 'stage output refused' using errcode='42501';end if;

 domain:=controller_security.settle_evidence_ingest_before_119(t,a,d.operation_id,output_text::jsonb->'receipt',k);
 if domain->>'status' is distinct from 'settled' then raise exception 'domain settlement refused: %',domain->>'error' using errcode='42501';end if;
 outcome:=controller_security.generic_finish_before_119(t,a,runid,'saakshi',(d.input_text::jsonb->>'engagement_id')::uuid,k,ih,'succeeded',null,latency,inputtokens,outputtokens,cost,started,completed,oh);
 if outcome->>'status' is distinct from 'succeeded' then raise exception 'runtime settlement refused: %',outcome->>'error' using errcode='42501';end if;
 select * into run from public.agent_runs where tenant_id=t and id=runid;
 if run.output_redacted_hash is distinct from oh or run.metadata->>'runtime_output_hash' is distinct from oh or run.metadata->>'response_output_hash' is distinct from oh then raise exception 'runtime output hash refused';end if;
 insert into public.saakshi119_settled_outputs(run_id,tenant_id,actor_id,operation_key,input_hash,output_text,output_hash,evidence_id,object_version_id,requested_receipt,started_receipt,completed_receipt,settled_receipt)
 values(runid,t,a,k,ih,output_text,oh,(domain->>'evidence_id')::uuid,(domain->>'object_version_id')::uuid,d.requested_receipt,started::bigint,completed::bigint,(run.metadata->>'settlement_receipt')::bigint);
 select * into payload from public.saakshi119_temporary_payloads where id=d.payload_id for update;
 delete from public.saakshi119_temporary_payloads where id=d.payload_id;
 insert into public.saakshi119_payload_purges(operation_id,payload_id,cipher_hash,reason) values(d.operation_id,d.payload_id,d.cipher_hash,'settled');
 return jsonb_build_object('accepted',true,'run_id',runid,'evidence_id',domain->'evidence_id','object_version_id',domain->'object_version_id','output_hash',oh,'replayed',false);
end $function$;

revoke all on function public.finalize_saakshi119(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.finalize_saakshi119(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,integer,numeric) to evidence_ingestion_writer;

CREATE OR REPLACE FUNCTION controller_security.saakshi119_saved_valid(t uuid, a uuid, k uuid, bodyhash text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.saakshi119_sources; r public.evidence_ingestions; g public.agent_runs; x public.saakshi119_settled_outputs; v public.evidence_object_versions; h public.audit_ledger; b public.audit_ledger; e public.audit_ledger; c public.audit_ledger;
begin
 if controller_security.saakshi119_authority(t,a) is not true then return false;end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and operation_key=k;
 if not found or d.human_body_hash is distinct from bodyhash or d.input_hash is distinct from encode(sha256(convert_to(d.input_text,'UTF8')),'hex') then return false;end if;
 select * into r from public.evidence_ingestions where tenant_id=t and id=d.operation_id for update;
 if r.id is null or r.actor_id is distinct from a or r.correlation_id is distinct from k or r.status<>'settled' then return false;end if;
 if r.engagement_id is not null then
 perform 1 from public.engagements where tenant_id=t and id=r.engagement_id and status<>'cancelled' for share;
 if not found then return false;end if;end if;
 select * into g from public.agent_runs where tenant_id=t and id=d.run_id for update;
 select * into x from public.saakshi119_settled_outputs where run_id=d.run_id;
 if x.run_id is null or x.tenant_id is distinct from t or x.actor_id is distinct from a or x.operation_key is distinct from k or x.input_hash is distinct from d.input_hash
 or x.output_hash is distinct from encode(sha256(convert_to(x.output_text,'UTF8')),'hex') or g.status<>'succeeded' or g.completed_at is null
 or g.agent<>'saakshi' or g.engagement_id is distinct from r.engagement_id or g.correlation_id is distinct from k or g.input_redacted_hash is distinct from x.input_hash
 or g.output_redacted_hash is distinct from x.output_hash or g.metadata->>'requested_by' is distinct from a::text
 or g.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1' or g.metadata->>'runtime_outcome' is distinct from 'receipt_confirmed'
 or g.metadata->>'runtime_normalized_input_hash' is distinct from x.input_hash or g.metadata->>'runtime_output_hash' is distinct from x.output_hash
 or g.metadata->>'response_output_hash' is distinct from x.output_hash or g.metadata->>'settlement_receipt' is distinct from x.settled_receipt::text
 or x.evidence_id is distinct from r.evidence_id or x.requested_receipt is distinct from d.requested_receipt
 then return false;end if;
 select * into v from public.evidence_object_versions where tenant_id=t and id=x.object_version_id;
 if v.ingestion_id is distinct from d.operation_id or v.evidence_id is distinct from x.evidence_id
 or v.receipt is distinct from x.output_text::jsonb->'receipt' or v.lock_mode<>'COMPLIANCE' then return false;end if;
 if not exists(select 1 from public.saakshi119_dispatch_claims where run_id=d.run_id and tenant_id=t and input_hash=d.input_hash)
 or not exists(select 1 from public.saakshi119_upload_claims where run_id=d.run_id and operation_id=d.operation_id and actor_id=a and input_hash=d.input_hash)
 or not exists(select 1 from public.saakshi119_stage_observations where run_id=d.run_id and operation_id=d.operation_id and output_text=x.output_text and output_hash=x.output_hash and version_id=v.version_id)
 or not exists(select 1 from public.saakshi119_payload_purges where operation_id=d.operation_id and payload_id=d.payload_id and cipher_hash=d.cipher_hash and reason='settled') then return false;end if;
 select * into h from public.audit_ledger where tenant_id=t and id=x.requested_receipt;
 select * into b from public.audit_ledger where tenant_id=t and id=x.started_receipt;
 select * into e from public.audit_ledger where tenant_id=t and id=x.completed_receipt;
 select * into c from public.audit_ledger where tenant_id=t and id=x.settled_receipt;
 return h.id is not null and b.id is not null and e.id is not null and c.id is not null
 and h.actor_type='human' and h.actor_id=a::text and h.action_type='agent.invocation.requested' and h.target_ref=d.run_id::text and h.result='pending' and h.input_hash=x.input_hash and h.correlation_id=k
 and h.detail->>'agent'='saakshi' and h.detail->>'engagement_id' is not distinct from r.engagement_id::text
 and b.sequence_no>h.sequence_no and e.sequence_no>b.sequence_no and c.sequence_no>e.sequence_no
 and b.actor_type='agent' and e.actor_type='agent' and b.actor_id='saakshi' and e.actor_id='saakshi'
 and b.action_type='evidence.collected' and e.action_type='evidence.collected' and b.result='pending' and e.result='success'
 and b.correlation_id=k and e.correlation_id=k and b.target_ref is not distinct from r.engagement_id::text and e.target_ref is not distinct from r.engagement_id::text
 and b.input_hash=x.input_hash and e.input_hash=x.input_hash and e.output_hash=x.output_hash
 and b.agent_version is not null and b.agent_version=e.agent_version
 and b.detail->>'phase'='started' and e.detail->>'phase'='completed' and b.detail->>'run_id'=d.run_id::text and e.detail->>'run_id'=d.run_id::text
 and b.detail->>'request_hash'=x.input_hash and e.detail->>'request_hash'=x.input_hash and e.detail->>'started_entry'=b.id::text
 and c.actor_type='system' and c.actor_id='bff-generic-agent-controller' and c.action_type='agent.invocation.settled'
 and c.target_ref=d.run_id::text and c.input_hash=x.input_hash and c.output_hash=x.output_hash and c.correlation_id=k and c.result='success'
 and c.detail->>'requested_by'=a::text and c.detail->>'agent'='saakshi' and c.detail->>'runtime_outcome'='receipt_confirmed'
 and c.detail->>'started_receipt'=b.id::text and c.detail->>'completed_receipt'=e.id::text;
end $function$;

revoke all on function controller_security.saakshi119_saved_valid(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;

create function public.recover_saakshi119(t uuid,a uuid,k uuid,bodyhash text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources; x public.saakshi119_settled_outputs;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_saved_valid(t,a,k,bodyhash) is not true then raise exception 'saved source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and operation_key=k;
 select * into x from public.saakshi119_settled_outputs where run_id=d.run_id;
 return jsonb_build_object('accepted',true,'run_id',x.run_id,'evidence_id',x.evidence_id,'object_version_id',x.object_version_id,
 'input_text',d.input_text,'input_hash',x.input_hash,'output_text',x.output_text,'output_hash',x.output_hash,'human_body_hash',d.human_body_hash,
 'requested_receipt',x.requested_receipt::text,'started_receipt',x.started_receipt::text,'completed_receipt',x.completed_receipt::text,'settled_receipt',x.settled_receipt::text);
end $$;

revoke all on function public.recover_saakshi119(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.recover_saakshi119(uuid,uuid,uuid,text) to evidence_ingestion_writer;

create function public.bind_saakshi119_stage(t uuid,a uuid,runid uuid,k uuid,ih text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_source_valid(t,a,runid,k,ih) is not true
 or not exists(select 1 from public.saakshi119_dispatch_claims where run_id=runid and tenant_id=t and operation_key=k and input_hash=ih)
 then raise exception 'claimed source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and run_id=runid and operation_key=k;
 return jsonb_build_object('source',d.input_text::jsonb,'runId',runid,'correlationId',k,'requestedReceipt',d.requested_receipt::text);
end $$;

revoke all on function public.bind_saakshi119_stage(uuid,uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.bind_saakshi119_stage(uuid,uuid,uuid,uuid,text) to evidence_ingestion_writer;

revoke all on function public.prepare_saakshi119(uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,text,integer,text,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.prepare_saakshi119(uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,text,integer,text,boolean) to evidence_ingestion_writer;

create function public.read_saakshi119_status(t uuid,a uuid,k uuid,bodyhash text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources; intent public.evidence_ingestions; run public.agent_runs; h public.audit_ledger; payload public.saakshi119_temporary_payloads; terminal public.saakshi119_terminals; observed public.saakshi119_stage_observations; consumed boolean;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_authority(t,a) is not true then raise exception 'status source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and operation_key=k;
 if d.run_id is null or d.human_body_hash is distinct from bodyhash or d.input_hash is distinct from encode(sha256(convert_to(d.input_text,'UTF8')),'hex')
 or d.original_approval->>'bodyHash' is distinct from bodyhash or d.input_text::jsonb->>'human_request_hash' is distinct from bodyhash
 then raise exception 'status source refused' using errcode='42501';end if;
 select * into intent from public.evidence_ingestions where tenant_id=t and id=d.operation_id for update;
 if intent.id is null or intent.actor_id is distinct from a or intent.correlation_id is distinct from k or intent.status<>'pending'
 then raise exception 'status source refused' using errcode='42501';end if;
 if intent.engagement_id is not null then
 perform 1 from public.engagements where tenant_id=t and id=intent.engagement_id and status<>'cancelled' for share;
 if not found then raise exception 'status source refused' using errcode='42501';end if;end if;
 select * into run from public.agent_runs where tenant_id=t and id=d.run_id for update;
 select * into h from public.audit_ledger where tenant_id=t and id=d.requested_receipt;
 if run.id is null or run.agent<>'saakshi' or run.correlation_id is distinct from k or run.engagement_id is distinct from intent.engagement_id
 or run.input_redacted_hash is distinct from d.input_hash or run.metadata->>'requested_by' is distinct from a::text
 or run.metadata->>'request_receipt' is distinct from d.requested_receipt::text or run.status not in ('running','failed')
 or h.actor_type is distinct from 'human' or h.actor_id is distinct from a::text or h.action_type is distinct from 'agent.invocation.requested'
 or h.target_ref is distinct from run.id::text or h.input_hash is distinct from d.input_hash or h.correlation_id is distinct from k
 then raise exception 'status source refused' using errcode='42501';end if;
 select * into payload from public.saakshi119_temporary_payloads where id=d.payload_id for share;
 select * into terminal from public.saakshi119_terminals where operation_id=d.operation_id;
 select * into observed from public.saakshi119_stage_observations where run_id=d.run_id;
 consumed:=exists(select 1 from public.saakshi119_upload_claims where run_id=d.run_id and operation_id=d.operation_id and input_hash=d.input_hash and actor_id=a);
 return jsonb_build_object('kind','unconfirmed_staged_evidence','accepted',false,'operation_key',k,'run_id',d.run_id,
  'input_text',d.input_text,'input_hash',d.input_hash,'human_body_hash',d.human_body_hash,'requested_receipt',d.requested_receipt::text,
  'payload_expires_at',case when payload.id is null then null else to_jsonb(payload.expires_at) end,
  'payload_purged',exists(select 1 from public.saakshi119_payload_purges where operation_id=d.operation_id),
  'terminal_reason',terminal.reason,'runtime_outcome',case when run.status='failed' then run.metadata->>'runtime_outcome' else 'unconfirmed' end,
  'provider_observation',case when observed.run_id is not null then 'observed_unaccepted' when consumed then 'outcome_unknown' else 'not_attempted' end,
  'observed_version',observed.version_id,'observed_output_hash',observed.output_hash,'new_approved_key_allowed',terminal.operation_id is not null);
end $$;

revoke all on function public.read_saakshi119_status(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.read_saakshi119_status(uuid,uuid,uuid,text) to evidence_ingestion_writer;

create function public.expire_saakshi119(t uuid,a uuid,k uuid,bodyhash text) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare d public.saakshi119_sources; status jsonb;
begin
 if current_setting('role',true) is distinct from 'evidence_ingestion_writer' then raise exception 'scoped evidence writer required' using errcode='42501';end if;
 if controller_security.saakshi119_authority(t,a) is not true then raise exception 'expiry source refused' using errcode='42501';end if;
 select * into d from public.saakshi119_sources where tenant_id=t and actor_id=a and operation_key=k;
 if d.run_id is null or d.human_body_hash is distinct from bodyhash then raise exception 'expiry source refused' using errcode='42501';end if;

 perform pg_advisory_xact_lock(hashtextextended(t::text||((d.input_text::jsonb)->>'content_hash'),1));
 status:=public.read_saakshi119_status(t,a,k,bodyhash);
 if status->'accepted' is distinct from 'false'::jsonb then raise exception 'expiry source refused' using errcode='42501';end if;
 perform public.expire_saakshi119_payload(t,d.run_id,k);
 return public.read_saakshi119_status(t,a,k,bodyhash);
end $$;

revoke all on function public.expire_saakshi119(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

grant execute on function public.expire_saakshi119(uuid,uuid,uuid,text) to evidence_ingestion_writer;
create trigger saakshi119_sources_no_truncate before truncate on public.saakshi119_sources for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_temporary_payloads_no_truncate before truncate on public.saakshi119_temporary_payloads for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_payload_purges_no_truncate before truncate on public.saakshi119_payload_purges for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_terminals_no_truncate before truncate on public.saakshi119_terminals for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_upload_claims_no_truncate before truncate on public.saakshi119_upload_claims for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_terminal_contexts_no_truncate before truncate on public.saakshi119_terminal_contexts for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_dispatch_claims_no_truncate before truncate on public.saakshi119_dispatch_claims for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_stage_observations_no_truncate before truncate on public.saakshi119_stage_observations for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_terminal_stage_links_no_truncate before truncate on public.saakshi119_terminal_stage_links for each statement execute function public.evidence_receipt_immutable();
create trigger saakshi119_settled_outputs_no_truncate before truncate on public.saakshi119_settled_outputs for each statement execute function public.evidence_receipt_immutable();
commit;
