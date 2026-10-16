-- Actor-owned abandonment of an exact uncertain metadata intent. Cancellation
-- never attests the request's claimed asset facts and never undoes a receipt.
alter type public.ledger_action_type add value if not exists 'connector.website.operation_cancelled';
create table public.public_website_asset_cancellations(
 id uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),operation_key uuid not null,
 request_text text not null check(octet_length(request_text) between 2 and 16384),request_sha256 text not null check(request_sha256=encode(sha256(convert_to(request_text,'UTF8')),'hex')),
 reason text not null check(length(reason) between 1 and 2000 and reason~'[^[:space:]]'),
 cancellation_text text not null check(octet_length(cancellation_text) between 2 and 16384),cancellation_sha256 text not null check(cancellation_sha256=encode(sha256(convert_to(cancellation_text,'UTF8')),'hex')),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),unique(tenant_id,actor_id,operation_key),unique(tenant_id,receipt_id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
alter table public.public_website_asset_cancellations enable row level security;
revoke all on public.public_website_asset_cancellations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create trigger website_asset_cancellation_immutable before update or delete on public.public_website_asset_cancellations for each row execute function public.evidence_receipt_immutable();
create trigger website_asset_cancellation_no_truncate before truncate on public.public_website_asset_cancellations for each statement execute function public.evidence_receipt_immutable();
create function controller_security.website_asset140_cancelled(c public.public_website_asset_cancellations,replayed boolean) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state','cancelled','tenantId',c.tenant_id,'actorId',c.actor_id,'operationKey',c.operation_key,
 'requestCodec','axiom-public-website-asset-request-canonical-json-1','requestText',c.request_text,'requestSha256',c.request_sha256,
 'cancellationCodec','axiom-public-website-asset-cancellation-canonical-json-1','cancellationText',c.cancellation_text,'cancellationSha256',c.cancellation_sha256,
 'receipt',jsonb_build_object('id',l.id::text,'entryHash',l.entry_hash),'replayed',replayed)
 from public.audit_ledger l where l.tenant_id=c.tenant_id and l.id=c.receipt_id
$$;
create function controller_security.website_asset140_outcome(t uuid,a uuid,k uuid,expected_request text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o public.public_website_asset_operations;c public.public_website_asset_cancellations;
begin
 select * into o from public.public_website_asset_operations where tenant_id=t and actor_id=a and operation_key=k;
 select * into c from public.public_website_asset_cancellations where tenant_id=t and actor_id=a and operation_key=k;
 if o.id is not null and c.id is not null then raise exception 'conflicting asset outcomes' using errcode='23514';end if;
 if o.id is not null then
  if expected_request is not null and o.request_text is distinct from expected_request then raise exception 'asset operation conflict' using errcode='23505';end if;
  return controller_security.website_asset139_result(o,true);
 elsif c.id is not null then
  if expected_request is not null and c.request_text is distinct from expected_request then raise exception 'asset operation conflict' using errcode='23505';end if;
  return controller_security.website_asset140_cancelled(c,true);
 end if;
 return null;
end $$;
create function controller_security.website_asset140_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.public_website_asset_cancellations;l public.audit_ledger;r jsonb;s jsonb;
begin
 if tg_table_name='public_website_asset_operations' then
  if exists(select 1 from public.public_website_asset_cancellations where tenant_id=new.tenant_id and actor_id=new.actor_id and operation_key=new.operation_key)
  then raise exception 'cancelled asset intent cannot commit' using errcode='23514';end if;return null;
 elsif tg_table_name='audit_ledger' then
  if new.action_type::text<>'connector.website.operation_cancelled' then return null;end if;
  l:=new;select * into c from public.public_website_asset_cancellations where tenant_id=l.tenant_id and receipt_id=l.id;
 else c:=new;select * into l from public.audit_ledger where tenant_id=c.tenant_id and id=c.receipt_id;end if;
 if c.id is null or l.id is null then raise exception 'cancellation receipt missing' using errcode='23514';end if;
 r:=controller_security.website_asset139_request(c.request_text);s:=jsonb_build_object('version',1,'id',c.id,'tenantId',c.tenant_id,'actorId',c.actor_id,'operationKey',c.operation_key,'requestSha256',c.request_sha256,'reason',c.reason,'confirmed',true);
 if c.operation_key::text is distinct from r->>'operationKey' or c.cancellation_text is distinct from controller_security.canonical_questionnaire_json(s)
  or exists(select 1 from public.public_website_asset_operations where tenant_id=c.tenant_id and actor_id=c.actor_id and operation_key=c.operation_key)
  or l.actor_type::text is distinct from 'human' or l.actor_id is distinct from c.actor_id::text or l.correlation_id is distinct from c.operation_key
  or l.action_type::text is distinct from 'connector.website.operation_cancelled' or l.target_ref is distinct from c.id::text
  or l.input_hash is distinct from c.request_sha256 or l.output_hash is distinct from c.cancellation_sha256 or l.result::text is distinct from 'success'
  or l.detail is distinct from jsonb_build_object('cancellation_id',c.id,'operation_key',c.operation_key,'kind',r->>'kind')
 then raise exception 'cancellation binding refused' using errcode='23514';end if;
 return null;
end $$;
create constraint trigger website_asset_cancel_ledger_binding after insert on public.audit_ledger deferrable initially deferred for each row execute function controller_security.website_asset140_binding();
create constraint trigger website_asset_cancel_binding after insert on public.public_website_asset_cancellations deferrable initially deferred for each row execute function controller_security.website_asset140_binding();
create constraint trigger website_asset_cancel_operation_fence after insert on public.public_website_asset_operations deferrable initially deferred for each row execute function controller_security.website_asset140_binding();

-- Fence ALL entrypoints, including the common helper, before delegation. In
-- particular the targeted wrapper must check before its nested0133 insertion.
alter function controller_security.website_asset139_write(uuid,uuid,text,uuid) rename to website_asset139_write_before_0140;
revoke all on function controller_security.website_asset139_write_before_0140(uuid,uuid,text,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function controller_security.website_asset139_write(t uuid,a uuid,request_text text,fresh_check uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;prior jsonb;
begin
 if not controller_security.website_asset139_allowed(t,a,true) then raise exception 'asset manager required' using errcode='42501';end if;
 r:=controller_security.website_asset139_request(request_text);perform pg_advisory_xact_lock(139,hashtext(t::text));
 prior:=controller_security.website_asset140_outcome(t,a,(r->>'operationKey')::uuid,request_text);if prior is not null then return prior;end if;
 return controller_security.website_asset139_write_before_0140(t,a,request_text,fresh_check);
end $$;
alter function public.record_public_website_asset_operation(uuid,uuid,text) set schema controller_security;
alter function controller_security.record_public_website_asset_operation(uuid,uuid,text) rename to record_public_website_asset_operation_before_0140;
revoke all on function controller_security.record_public_website_asset_operation_before_0140(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.record_public_website_asset_operation(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;prior jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,true) then raise exception 'asset manager required' using errcode='42501';end if;
 r:=controller_security.website_asset139_request(p_request_text);if r->>'kind'='capture' then raise exception 'fresh capture required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(139,hashtext(p_tenant_id::text));prior:=controller_security.website_asset140_outcome(p_tenant_id,p_actor_id,(r->>'operationKey')::uuid,p_request_text);
 if prior is not null then return prior;end if;
 return controller_security.record_public_website_asset_operation_before_0140(p_tenant_id,p_actor_id,p_request_text);
end $$;
alter function public.record_targeted_public_website_capture(uuid,uuid,text,text,jsonb,text,text,text,jsonb) set schema controller_security;
alter function controller_security.record_targeted_public_website_capture(uuid,uuid,text,text,jsonb,text,text,text,jsonb) rename to record_targeted_public_website_capture_before_0140;
revoke all on function controller_security.record_targeted_public_website_capture_before_0140(uuid,uuid,text,text,jsonb,text,text,text,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.record_targeted_public_website_capture(p_tenant_id uuid,p_actor_id uuid,p_request_text text,p_final_url text,p_result jsonb,p_codec text,p_payload_text text,p_payload_sha256 text,p_page_sources jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;prior jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,true) then raise exception 'asset manager required' using errcode='42501';end if;
 r:=controller_security.website_asset139_request(p_request_text);if r->>'kind'<>'capture' then raise exception 'capture intent required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(139,hashtext(p_tenant_id::text));prior:=controller_security.website_asset140_outcome(p_tenant_id,p_actor_id,(r->>'operationKey')::uuid,p_request_text);
 if prior is not null then return prior;end if;
 return controller_security.record_targeted_public_website_capture_before_0140(p_tenant_id,p_actor_id,p_request_text,p_final_url,p_result,p_codec,p_payload_text,p_payload_sha256,p_page_sources);
end $$;
alter function public.read_public_website_asset_operation(uuid,uuid,uuid) set schema controller_security;
alter function controller_security.read_public_website_asset_operation(uuid,uuid,uuid) rename to read_public_website_asset_operation_before_0140;
revoke all on function controller_security.read_public_website_asset_operation_before_0140(uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.read_public_website_asset_operation(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior jsonb;
begin
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,false) then raise exception 'tenant reader required' using errcode='42501';end if;
 prior:=controller_security.website_asset140_outcome(p_tenant_id,p_actor_id,p_operation_key);
 return coalesce(prior,jsonb_build_object('state','not_found'));
end $$;
create function public.cancel_public_website_asset_operation(p_tenant_id uuid,p_actor_id uuid,p_request_text text,p_reason text,p_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;prior jsonb;c public.public_website_asset_cancellations;cid uuid:=gen_random_uuid();st text;receipt bigint;owned boolean;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,true) then raise exception 'asset manager required' using errcode='42501';end if;
 if p_confirmed is distinct from true or p_reason is null or length(p_reason) not between 1 and 2000 or p_reason!~'[^[:space:]]' then raise exception 'confirmed cancellation reason required' using errcode='22023';end if;
 r:=controller_security.website_asset139_request(p_request_text);perform pg_advisory_xact_lock(139,hashtext(p_tenant_id::text));
 prior:=controller_security.website_asset140_outcome(p_tenant_id,p_actor_id,(r->>'operationKey')::uuid,p_request_text);
 if prior is not null then
  if prior->>'state'='cancelled' and (prior->>'cancellationText')::jsonb->>'reason' is distinct from p_reason then raise exception 'cancellation reason conflict' using errcode='23505';end if;
  return prior;
 end if;
 -- Only historical tenant identity is checked here. Lifecycle, versions,
 -- withdrawal and claimed payload/hash preconditions are NOT cancellation gates.
 if r->>'kind'='register_target' then
  owned:=exists(select 1 from public.estates where tenant_id=p_tenant_id and id=(r->>'estateId')::uuid)
   and exists(select 1 from public.estate_systems where tenant_id=p_tenant_id and id=(r->>'systemId')::uuid);
 elsif r->>'kind' in ('capture','associate_capture') then
  owned:=exists(select 1 from public.public_website_targets where tenant_id=p_tenant_id and id=(r->>'targetId')::uuid)
   and (r->>'kind'='capture' or exists(select 1 from public.public_website_checks where tenant_id=p_tenant_id and id=(r->>'checkId')::uuid));
 elsif r->>'subjectType'='target' then owned:=exists(select 1 from public.public_website_targets where tenant_id=p_tenant_id and id=(r->>'subjectId')::uuid);
 else owned:=exists(select 1 from public.public_website_asset_associations where tenant_id=p_tenant_id and id=(r->>'subjectId')::uuid);end if;
 if owned is distinct from true then raise exception 'tenant references required' using errcode='42501';end if;
 st:=controller_security.canonical_questionnaire_json(jsonb_build_object('version',1,'id',cid,'tenantId',p_tenant_id,'actorId',p_actor_id,'operationKey',r->>'operationKey','requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),'reason',p_reason,'confirmed',true));
 receipt:=public.append_ledger(p_tenant_id,(r->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'connector.website.operation_cancelled',cid::text,
 encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),encode(sha256(convert_to(st,'UTF8')),'hex'),null,null,null,null,'success',jsonb_build_object('cancellation_id',cid,'operation_key',r->>'operationKey','kind',r->>'kind'));
 insert into public.public_website_asset_cancellations(id,tenant_id,actor_id,operation_key,request_text,request_sha256,reason,cancellation_text,cancellation_sha256,receipt_id)
 values(cid,p_tenant_id,p_actor_id,(r->>'operationKey')::uuid,p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),p_reason,st,encode(sha256(convert_to(st,'UTF8')),'hex'),receipt) returning * into c;
 return controller_security.website_asset140_cancelled(c,false);
end $$;

alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0140;
revoke all on function controller_security.append_agent_ledger_before_0140(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
 p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text='connector.website.operation_cancelled' then raise exception 'dedicated human cancellation receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0140(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;
revoke all on function controller_security.website_asset140_cancelled(public.public_website_asset_cancellations,boolean),controller_security.website_asset140_outcome(uuid,uuid,uuid,text),controller_security.website_asset140_binding(),controller_security.website_asset139_write(uuid,uuid,text,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
revoke all on function public.record_public_website_asset_operation(uuid,uuid,text),public.record_targeted_public_website_capture(uuid,uuid,text,text,jsonb,text,text,text,jsonb),public.cancel_public_website_asset_operation(uuid,uuid,text,text,boolean),public.read_public_website_asset_operation(uuid,uuid,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.record_public_website_asset_operation(uuid,uuid,text),public.record_targeted_public_website_capture(uuid,uuid,text,text,jsonb,text,text,text,jsonb),public.cancel_public_website_asset_operation(uuid,uuid,text,text,boolean) to human_action_writer;
grant execute on function public.read_public_website_asset_operation(uuid,uuid,uuid) to service_role,human_action_writer;

-- Read-only selectors: one tenant and one explicit inventory/target context.
-- Fetch one look-ahead row; expose at most fifty and an explicit continuation.
create function public.list_public_website_asset_selection(p_tenant_id uuid,p_actor_id uuid,p_kind text,
 p_estate_id uuid default null,p_system_id uuid default null,p_target_id uuid default null,p_after uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;v public.public_website_targets;cursor_id text;out_rows jsonb;
begin
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,false) then raise exception 'tenant reader required' using errcode='42501';end if;
 if p_kind='targets' then
  if p_target_id is not null or p_estate_id is null or p_system_id is null or not exists(select 1 from public.estate_systems s where s.tenant_id=p_tenant_id and s.id=p_system_id and s.estate_id=p_estate_id) then raise exception 'inventory context refused' using errcode='42501';end if;
  select coalesce(jsonb_agg(q.v order by q.id),'[]'::jsonb) into rows from (
   select t.id,jsonb_build_object('id',t.id,'snapshotText',t.snapshot_text,'snapshotSha256',t.snapshot_sha256,
    'withdrawn',controller_security.website_asset139_withdrawn(p_tenant_id,'target',t.id),
    'inventoryCurrent',e.status='active' and s.status='active' and s.estate_id=e.id and e.version=t.estate_version and s.version=t.system_version) v
   from public.public_website_targets t join public.estates e on (e.tenant_id,e.id)=(t.tenant_id,t.estate_id)
   join public.estate_systems s on (s.tenant_id,s.id)=(t.tenant_id,t.system_id)
   where t.tenant_id=p_tenant_id and t.estate_id=p_estate_id and t.system_id=p_system_id and (p_after is null or t.id>p_after) order by t.id limit 51
  ) q;
 elsif p_kind in ('associations','captures') then
  if p_estate_id is not null or p_system_id is not null or p_target_id is null then raise exception 'target context refused' using errcode='42501';end if;
  select * into v from public.public_website_targets where tenant_id=p_tenant_id and id=p_target_id;
  if v.id is null then raise exception 'target context refused' using errcode='42501';end if;
  if p_kind='associations' then
   select coalesce(jsonb_agg(q.v order by q.id),'[]'::jsonb) into rows from (
    select a.id,jsonb_build_object('id',a.id,'snapshotText',a.snapshot_text,'snapshotSha256',a.snapshot_sha256,
     'operation',controller_security.website_asset139_result(o,true),
     'withdrawn',controller_security.website_asset139_withdrawn(p_tenant_id,'association',a.id)) v
    from public.public_website_asset_associations a join public.public_website_asset_operations o on (o.tenant_id,o.id)=(a.tenant_id,a.operation_id)
    where a.tenant_id=p_tenant_id and a.target_id=p_target_id and (p_after is null or a.id>p_after) order by a.id limit 51
   ) q;
  else
   select coalesce(jsonb_agg(q.v order by q.id),'[]'::jsonb) into rows from (
    select c.id,jsonb_build_object('tenantId',p_tenant_id,'checkId',c.id,'payloadSha256',p.payload_sha256,
     'captureReceipt',jsonb_build_object('id',l.id::text,'entryHash',l.entry_hash),
     'requestedUrl',c.requested_url,'finalUrl',c.final_url,'checkedAt',to_char(c.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) v
    from public.public_website_checks c join public.public_website_control_evidence p on (p.tenant_id,p.check_id)=(c.tenant_id,c.id)
    join public.audit_ledger l on (l.tenant_id,l.id)=(p.tenant_id,p.capture_receipt)
    where c.tenant_id=p_tenant_id and c.requested_url=v.url and (p_after is null or c.id>p_after) order by c.id limit 51
   ) q;
  end if;
 else raise exception 'selection kind refused' using errcode='22023';end if;
 select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into out_rows from jsonb_array_elements(rows) with ordinality where ordinality<=50;
 if jsonb_array_length(rows)>50 then cursor_id:=coalesce(rows->49->>'id',rows->49->>'checkId');end if;
 return jsonb_build_object('kind',p_kind,'tenantId',p_tenant_id,'actorId',p_actor_id,'rows',out_rows,'nextCursor',cursor_id)||
 case when p_kind='targets' then jsonb_build_object('estateId',p_estate_id,'systemId',p_system_id) else jsonb_build_object('targetId',p_target_id) end;
end $$;
revoke all on function public.list_public_website_asset_selection(uuid,uuid,text,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.list_public_website_asset_selection(uuid,uuid,text,uuid,uuid,uuid,uuid) to service_role,human_action_writer;
