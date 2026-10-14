-- Unmounted controller-only accounting journal. No worker custody or live grants.
-- Saved legacy counters remain unverified. Only a sealed independently observed
-- journal can prove no_model; vendor usage/estimates do not represent invoices.
alter type public.ledger_action_type add value if not exists 'agent.model.accounting.opened';
alter type public.ledger_action_type add value if not exists 'agent.model.call.started';
alter type public.ledger_action_type add value if not exists 'agent.model.call.observed';
alter type public.ledger_action_type add value if not exists 'agent.model.accounting.sealed';

begin;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='axiom_model_accounting_controller') then
  create role axiom_model_accounting_controller nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='axiom_model_accounting_controller'
  and (rolcanlogin or rolinherit or rolbypassrls or rolsuper or rolcreaterole or rolcreatedb or rolreplication))
 then raise exception 'accounting custody role refused';end if;
 -- PostgreSQL may grant ADMIN membership to a non-superuser creator. That is
 -- provisioning authority, not a runtime SET/INHERIT delegation.
 if exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.roleid
  where r.rolname='axiom_model_accounting_controller'
   and (not m.admin_option or m.set_option or m.inherit_option
    or m.member<>(select oid from pg_roles where rolname=current_user)))
 then raise exception 'accounting custody membership refused';end if;
 if exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='axiom_model_accounting_controller')
 then raise exception 'accounting custody parent membership refused';end if;
end $$;

grant usage on schema public to axiom_model_accounting_controller;

create function controller_security.accounting128_keys(v jsonb, expected text[]) returns boolean
 language sql immutable set search_path='' as $$
 select jsonb_typeof(v)='object' and
  (select array_agg(k order by k collate "C") from jsonb_object_keys(v) k)
   = (select array_agg(k order by k collate "C") from unnest(expected) k)
$$;
create function controller_security.accounting128_hash(v jsonb) returns boolean
 language sql immutable set search_path='' as $$select jsonb_typeof(v)='string' and v#>>'{}' ~ '^[a-f0-9]{64}$'$$;
create function controller_security.accounting128_identity(v jsonb) returns boolean
 language sql immutable set search_path='' as $$select jsonb_typeof(v)='string' and length(v#>>'{}')<=300 and v#>>'{}' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'$$;
create function controller_security.accounting128_uuid(v jsonb) returns boolean
 language sql immutable set search_path='' as $$select jsonb_typeof(v)='string' and v#>>'{}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' and v#>>'{}'<>'00000000-0000-0000-0000-000000000000'$$;
create function controller_security.accounting128_token(v jsonb) returns boolean
 language sql immutable set search_path='' as $$select jsonb_typeof(v)='number' and v::text ~ '^(0|[1-9][0-9]*)$' and (v::text)::numeric<=2147483647$$;
create function controller_security.accounting128_decimal(v jsonb) returns boolean
 language sql immutable set search_path='' as $$select jsonb_typeof(v)='string' and length(v#>>'{}')<=335 and length(split_part(v#>>'{}','.',2))<=324 and v#>>'{}' ~ '^(0|[1-9][0-9]{0,9})([.][0-9]*[1-9])?$'$$;
create function controller_security.accounting128_route(v jsonb, served boolean default false) returns boolean
 language plpgsql immutable set search_path='' as $$
begin
 return controller_security.accounting128_keys(v,case when served then array['provider','model','reported_model'] else array['provider','model'] end)
  and v->>'provider' in ('self_hosted','bedrock','anthropic_api','anthropic','openai','gemini','fallback_chain')
  and controller_security.accounting128_identity(v->'model')
  and (not served or v->'reported_model'='null'::jsonb or controller_security.accounting128_identity(v->'reported_model'));
end $$;
create function controller_security.accounting128_start(v jsonb) returns boolean
 language plpgsql immutable set search_path='' as $$
begin
 return controller_security.accounting128_keys(v,array['schema_version','tenant_id','run_id','correlation_id','request_sha256','agent','agent_version','call_id','request_json_sha256','request_json_basis','template_sha256','model_selector','task'])
  and v->'schema_version'='2'::jsonb
  and controller_security.accounting128_uuid(v->'tenant_id') and controller_security.accounting128_uuid(v->'run_id')
  and controller_security.accounting128_uuid(v->'correlation_id') and controller_security.accounting128_uuid(v->'call_id')
  and controller_security.accounting128_hash(v->'request_sha256') and controller_security.accounting128_hash(v->'request_json_sha256')
  and controller_security.accounting128_hash(v->'template_sha256')
  and v->>'agent' in ('drishti','vibhaag','parikshan','saakshi','sudhaar','karya','samadhan','lekha','nazar','prativedan','pramaan','sanket')
  and controller_security.accounting128_identity(v->'agent_version') and controller_security.accounting128_identity(v->'model_selector')
  and v->>'request_json_basis'='canonical_decoded_request_not_http_wire'
  and v->>'task' in ('structural','reasoning','embedding','classification','summarisation','report');
end $$;
create function controller_security.accounting128_outcome(v jsonb) returns boolean
 language plpgsql immutable set search_path='' as $$
declare u jsonb; p jsonb; a jsonb; last_attempt jsonb; n integer;
begin
 if controller_security.accounting128_keys(v,array['schema_version','tenant_id','run_id','correlation_id','request_sha256','agent','agent_version','call_id','request_json_sha256','request_json_basis','template_sha256','model_selector','task','state','failure_code','content_sha256','planned','serving','commitments','attempts','usage','pricing']) is distinct from true
  or controller_security.accounting128_start(v-array['state','failure_code','content_sha256','planned','serving','commitments','attempts','usage','pricing']) is distinct from true then return false;end if;
 if (v->>'state' in ('completed','failed','cancelled','uncertain')) is distinct from true then return false;end if;
 u:=v->'usage';p:=v->'pricing';
 if controller_security.accounting128_keys(u,array['availability','input_tokens','output_tokens','total_tokens']) is distinct from true
  or controller_security.accounting128_keys(p,array['basis','scope','config_sha256','estimate_usd']) is distinct from true
  or p->>'scope' is distinct from 'successful_response_only' then return false;end if;
 if u->>'availability'='reported' then
  if controller_security.accounting128_token(u->'input_tokens') is distinct from true
   or controller_security.accounting128_token(u->'output_tokens') is distinct from true
   or controller_security.accounting128_token(u->'total_tokens') is distinct from true
   or (u->>'total_tokens')::numeric<>(u->>'input_tokens')::numeric+(u->>'output_tokens')::numeric then return false;end if;
 elsif u is distinct from jsonb_build_object('availability','unavailable','input_tokens',null,'output_tokens',null,'total_tokens',null) then return false;end if;
 if p->>'basis'='configuration_estimate' then
  if u->>'availability'<>'reported' or controller_security.accounting128_hash(p->'config_sha256') is distinct from true
   or controller_security.accounting128_decimal(p->'estimate_usd') is distinct from true then return false;end if;
  if (p->>'estimate_usd')::numeric>9999.999999 then return false;end if;
 elsif p->>'basis' is distinct from 'unavailable' or p->'estimate_usd'<>'null'::jsonb
  or (p->'config_sha256'<>'null'::jsonb and controller_security.accounting128_hash(p->'config_sha256') is distinct from true) then return false;end if;
 if v->>'state'='completed' then
  if v->'failure_code'<>'null'::jsonb or controller_security.accounting128_hash(v->'content_sha256') is distinct from true
   or controller_security.accounting128_route(v->'planned') is distinct from true
   or controller_security.accounting128_route(v->'serving',true) is distinct from true
   or v->'serving'->>'provider' not in ('self_hosted','anthropic','openai','gemini')
   or controller_security.accounting128_keys(v->'commitments',array['composed_sha256','transport_prompt_sha256','sdk_handoff_sha256','basis']) is distinct from true
   or v->'commitments'->>'basis' is distinct from 'sdk_handoff_not_http_wire'
   or controller_security.accounting128_hash(v->'commitments'->'composed_sha256') is distinct from true
   or controller_security.accounting128_hash(v->'commitments'->'transport_prompt_sha256') is distinct from true
   or controller_security.accounting128_hash(v->'commitments'->'sdk_handoff_sha256') is distinct from true
   or jsonb_typeof(v->'attempts') is distinct from 'array' then return false;end if;
  n:=jsonb_array_length(v->'attempts');if n not between 1 and 3 then return false;end if;
  for a in select value from jsonb_array_elements(v->'attempts') loop
   if controller_security.accounting128_keys(a,array['provider','model','outcome']) is distinct from true
    or controller_security.accounting128_route(a-'outcome') is distinct from true
    or (a->>'outcome' in ('failed','succeeded')) is distinct from true then return false;end if;
  end loop;
  last_attempt:=v->'attempts'->(n-1);
  if last_attempt->>'outcome'<>'succeeded' or last_attempt-'outcome'<>(v->'serving')-'reported_model'
   or exists(select 1 from jsonb_array_elements(v->'attempts') with ordinality a(value,i) where i<n and value->>'outcome'<>'failed') then return false;end if;
 else
  if v->>'state' not in ('failed','cancelled','uncertain')
   or (v->>'failure_code' in ('gateway_unavailable','current_authority_refused','gateway_response_invalid','invocation_cancelled','transport_uncertain')) is distinct from true
   or (v->>'state'='cancelled')<>(v->>'failure_code'='invocation_cancelled')
   or (v->>'state'='uncertain')<>(v->>'failure_code'='transport_uncertain')
   or v->'content_sha256'<>'null'::jsonb or v->'planned'<>'null'::jsonb or v->'serving'<>'null'::jsonb
   or v->'commitments'<>'null'::jsonb or v->'attempts'<>'null'::jsonb
   or u->>'availability'<>'unavailable' or p->>'basis'<>'unavailable' or p->'config_sha256'<>'null'::jsonb then return false;end if;
 end if;
 return true;
exception when others then return false;
end $$;

create table public.model_accounting_runs (
 run_id uuid primary key, tenant_id uuid not null references public.tenants(id),
 binding jsonb not null, requested_receipt bigint not null references public.audit_ledger(id),
 started_receipt bigint not null unique references public.audit_ledger(id),
 opened_receipt bigint not null unique references public.audit_ledger(id),
 origin text not null check(origin in ('generic','prativedan_assessment')),
 generic_run_id uuid references public.agent_runs(id),
 dedicated_run_id uuid references public.prativedan_draft_requests(run_id),
 check ((origin='generic' and generic_run_id is not null and generic_run_id=run_id and dedicated_run_id is null)
  or (origin='prativedan_assessment' and dedicated_run_id is not null and dedicated_run_id=run_id and generic_run_id is null)),
 check(controller_security.accounting128_keys(binding,array['schema_version','tenant_id','run_id','correlation_id','request_sha256','agent','agent_version']) is true)
);
create table public.model_accounting_call_starts (
 run_id uuid not null references public.model_accounting_runs(run_id), call_id uuid not null,
 start_text text not null check(octet_length(start_text) between 1 and 8192),
 start_sha256 text not null check(start_sha256=controller_security.prativedan123_hash(start_text)),
 start_packet jsonb not null check(start_packet=controller_security.prativedan123_json(start_text,8192) and controller_security.accounting128_start(start_packet) is true),
 receipt bigint not null unique references public.audit_ledger(id), primary key(run_id,call_id), unique(call_id)
);
create table public.model_accounting_call_outcomes (
 run_id uuid not null, call_id uuid not null,
 outcome_text text not null check(octet_length(outcome_text) between 1 and 16384),
 outcome_sha256 text not null check(outcome_sha256=controller_security.prativedan123_hash(outcome_text)),
 outcome_packet jsonb not null check(outcome_packet=controller_security.prativedan123_json(outcome_text,16384) and controller_security.accounting128_outcome(outcome_packet) is true),
 receipt bigint not null unique references public.audit_ledger(id), primary key(run_id,call_id),
 foreign key(run_id,call_id) references public.model_accounting_call_starts(run_id,call_id)
);
create table public.model_accounting_seals (
 run_id uuid primary key references public.model_accounting_runs(run_id),
 calls_text text not null check(octet_length(calls_text) between 2 and 8388608),
 calls_sha256 text not null check(calls_sha256=controller_security.prativedan123_hash(calls_text)),
 summary jsonb not null,
 completed_receipt bigint not null unique references public.audit_ledger(id),
 receipt bigint not null unique references public.audit_ledger(id)
);

create function controller_security.accounting128_receipt(t uuid,i bigint) returns jsonb
 language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id::text,'entry_hash',entry_hash) from public.audit_ledger where tenant_id=t and id=i
$$;
create function controller_security.accounting128_summary(calls jsonb) returns jsonb
 language plpgsql immutable set search_path='' as $$
declare c jsonb; n integer; nu integer:=0; np integer:=0; uncertain boolean:=false;
 ki bigint:=0; ko bigint:=0; kc numeric:=0; costtext text; basis text;
begin
 if jsonb_typeof(calls) is distinct from 'array' then raise exception 'accounting callset refused';end if;
 n:=jsonb_array_length(calls);if n>1000 then raise exception 'accounting callset refused';end if;
 if (select count(*)<>count(distinct value->>'call_id') from jsonb_array_elements(calls)) then raise exception 'accounting duplicate call refused';end if;
 for c in select value from jsonb_array_elements(calls) loop
  if controller_security.accounting128_outcome(c) is distinct from true then raise exception 'accounting observation refused';end if;
  uncertain:=uncertain or c->>'state'<>'completed' or case when c->'attempts'='null'::jsonb then false else jsonb_array_length(c->'attempts')>1 end;
  if c->'usage'->>'availability'='reported' then
   nu:=nu+1;ki:=ki+(c->'usage'->>'input_tokens')::bigint;ko:=ko+(c->'usage'->>'output_tokens')::bigint;
  end if;
  if c->'pricing'->>'basis'='configuration_estimate' then np:=np+1;kc:=kc+(c->'pricing'->>'estimate_usd')::numeric;end if;
 end loop;
 costtext:=kc::text;
 if position('.' in costtext)>0 then costtext:=rtrim(rtrim(costtext,'0'),'.');end if;
 basis:=case when n=0 then 'no_model' when not uncertain and nu=n and np=n then 'all_known'
  when nu>0 or np>0 then 'known_partial' else 'unknown' end;
 return jsonb_build_object('schema_version',2,'basis',basis,'call_count',n,'known_usage_call_count',nu,
  'known_estimate_call_count',np,'unknown_attempt_usage',uncertain,
  'input_tokens',case when not uncertain and nu=n then ki else null end,
  'output_tokens',case when not uncertain and nu=n then ko else null end,
  'total_tokens',case when not uncertain and nu=n then ki+ko else null end,
  'estimate_usd',case when not uncertain and np=n then costtext else null end,
  'known_input_tokens',ki,'known_output_tokens',ko,'known_total_tokens',ki+ko,'known_estimate_usd',costtext);
end $$;

-- A real controller separately validates live scoped workload identity; this
-- seam accepts only custody-role calls bound to an actual durable human request.
-- Bare UUIDs do not establish runtime identity and no shared role receives grants.
create function controller_security.accounting128_dedicated_dispatch(t uuid,k uuid,r uuid,rh text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;p public.prativedan_controller_phases;binding jsonb;
begin
 select * into q from public.prativedan_draft_requests where tenant_id=t and operation_key=k and run_id=r and request_sha256=rh;
 if exists(select 1 from public.agent_runs where id=r) then raise exception 'accounting origin collision refused' using errcode='42501';end if;
 if q.run_id is null then raise exception 'accounting dedicated request refused' using errcode='42501';end if;
 perform controller_security.prativedan123_validate(t,k);
 if controller_security.prativedan126_phase_valid(t,k,'started') is distinct from true
 then raise exception 'accounting dedicated start refused' using errcode='42501';end if;
 select * into p from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase='started';
 binding:=jsonb_build_object('schema_version',2,'tenant_id',t,'run_id',r,'correlation_id',k,
  'request_sha256',rh,'agent','prativedan','agent_version','0.1.0');
 return jsonb_build_object('origin','prativedan_assessment','binding',binding,'requested_receipt',q.requested_receipt,'started_receipt',p.receipt);
end $$;

create function controller_security.accounting128_dispatch(t uuid,r uuid,rh text,active boolean)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare run public.agent_runs; req public.audit_ledger; first public.audit_ledger;
 actor uuid; role public.user_role; internal boolean; binding jsonb; count_started integer; dedicated_key uuid;
begin
 if t is null or r is null or rh is null or rh !~ '^[a-f0-9]{64}$'
  or t='00000000-0000-0000-0000-000000000000'::uuid or r='00000000-0000-0000-0000-000000000000'::uuid
 then raise exception 'accounting dispatch refused' using errcode='42501';end if;
 select operation_key into dedicated_key from public.prativedan_draft_requests where tenant_id=t and run_id=r;
 if dedicated_key is not null then
  if exists(select 1 from public.agent_runs where id=r) then raise exception 'accounting origin collision refused' using errcode='42501';end if;
  if active then raise exception 'accounting dedicated controller required' using errcode='42501';end if;
  return controller_security.accounting128_dedicated_dispatch(t,dedicated_key,r,rh);
 end if;
 if active then
  lock table public.kill_switch_state in share mode;
  perform 1 from public.kill_switch_state where scope='global' or tenant_id=t for share;
  if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
   or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or tenant_id=t))
  then raise exception 'accounting dispatch stopped' using errcode='42501';end if;
 end if;
 select * into run from public.agent_runs where tenant_id=t and id=r for update;
 if not found or run.input_redacted_hash is distinct from rh
  or run.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
  or run.metadata->>'request_receipt' !~ '^[1-9][0-9]{0,18}$'
  or run.metadata->>'requested_by' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or (active and (run.status<>'running' or run.completed_at is not null))
 then raise exception 'accounting dispatch refused' using errcode='42501';end if;
 if active and exists(select 1 from public.audit_ledger where tenant_id=t and actor_type='agent' and actor_id=run.agent
  and correlation_id=run.correlation_id and detail->>'phase' in ('completed','failed') and detail->>'run_id'=r::text and detail->>'request_hash'=rh)
 then raise exception 'accounting dispatch already completed' using errcode='42501';end if;
 actor:=(run.metadata->>'requested_by')::uuid;
 if active then
  select tu.role,u.is_axiom_internal into role,internal from public.tenant_users tu join public.users u on u.id=tu.user_id
   where tu.tenant_id=t and tu.user_id=actor for share of tu,u;
  if role is null or role not in ('founder','axiom_analyst','owner','admin')
   or (role in ('founder','axiom_analyst') and internal is distinct from true)
   or (run.agent in ('lekha','nazar','sanket') and role not in ('founder','axiom_analyst'))
  then raise exception 'accounting actor refused' using errcode='42501';end if;
 end if;
 select * into req from public.audit_ledger where tenant_id=t and id::text=run.metadata->>'request_receipt';
 if req.id is null or req.actor_type<>'human' or req.actor_id<>actor::text
  or req.action_type::text<>'agent.invocation.requested' or req.target_ref is distinct from r::text
  or req.correlation_id is distinct from run.correlation_id or req.input_hash is distinct from rh
  or req.result<>'pending' or req.detail is distinct from jsonb_build_object('agent',run.agent,'engagement_id',run.engagement_id)
 then raise exception 'accounting human request refused' using errcode='42501';end if;
 select count(*) into count_started from public.audit_ledger where tenant_id=t and actor_type='agent' and actor_id=run.agent
  and correlation_id=run.correlation_id and detail->>'phase'='started' and detail->>'run_id'=r::text and detail->>'request_hash'=rh;
 if count_started<>1 then raise exception 'accounting started receipt ambiguous' using errcode='42501';end if;
 select * into first from public.audit_ledger where tenant_id=t and actor_type='agent' and actor_id=run.agent
  and correlation_id=run.correlation_id and detail->>'phase'='started' and detail->>'run_id'=r::text and detail->>'request_hash'=rh;
 if first.result<>'pending' or first.sequence_no<=req.sequence_no or first.agent_version is null
  or controller_security.accounting128_identity(to_jsonb(first.agent_version)) is distinct from true
  or first.input_hash is null or first.input_hash !~ '^[a-f0-9]{64}$' or first.output_hash is not null
  or first.target_ref is distinct from run.engagement_id::text
  or first.action_type::text is distinct from (case run.agent when 'drishti' then 'discovery.started' when 'vibhaag' then 'classification.started'
   when 'parikshan' then 'assessment.started' when 'saakshi' then 'evidence.collected' when 'sudhaar' then 'plan.generated'
   when 'lekha' then 'execution.started' else 'report.generated' end)
 then raise exception 'accounting runtime start refused' using errcode='42501';end if;
 binding:=jsonb_build_object('schema_version',2,'tenant_id',t,'run_id',r,'correlation_id',run.correlation_id,
  'request_sha256',rh,'agent',run.agent,'agent_version',first.agent_version);
 return jsonb_build_object('origin','generic','binding',binding,'requested_receipt',req.id,'started_receipt',first.id);
end $$;

create function controller_security.accounting128_load(t uuid,r uuid,rh text,dispatch jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare  row public.model_accounting_runs; receipt bigint; claimed boolean:=false;
begin
 select * into row from public.model_accounting_runs where run_id=r;
 if found then
  if row.origin is distinct from dispatch->>'origin' or row.binding is distinct from dispatch->'binding' or row.requested_receipt<>(dispatch->>'requested_receipt')::bigint
   or row.started_receipt<>(dispatch->>'started_receipt')::bigint
   or exists(select 1 from public.model_accounting_seals where run_id=r)
  then raise exception 'accounting dispatch conflict' using errcode='42501';end if;
 else
  receipt:=public.append_ledger(t,(dispatch->'binding'->>'correlation_id')::uuid,'system','model-accounting-controller',
   null,null,null,'agent.model.accounting.opened',r::text,rh,null,null,null,null,null,'pending',dispatch->'binding');
  insert into public.model_accounting_runs values(r,t,dispatch->'binding',(dispatch->>'requested_receipt')::bigint,(dispatch->>'started_receipt')::bigint,receipt,dispatch->>'origin',case when dispatch->>'origin'='generic' then r else null end,case when dispatch->>'origin'='prativedan_assessment' then r else null end);claimed:=true;
 end if;
 return dispatch->'binding'||jsonb_build_object('requested_receipt',controller_security.accounting128_receipt(t,(dispatch->>'requested_receipt')::bigint),'claimed',claimed);
end $$;

create function controller_security.accounting128_begin(t uuid,r uuid,rh text,call_id uuid,start_text text,dispatch jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare  row public.model_accounting_runs; saved public.model_accounting_call_starts;
 v jsonb; receipt bigint; h text; claimed boolean:=false;
begin
 select * into row from public.model_accounting_runs where run_id=r;
 if row.run_id is null or row.origin is distinct from dispatch->>'origin' or row.binding is distinct from dispatch->'binding'
  or exists(select 1 from public.model_accounting_seals where run_id=r)
 then raise exception 'accounting run unavailable' using errcode='42501';end if;
 v:=controller_security.prativedan123_json(start_text,8192);h:=controller_security.prativedan123_hash(start_text);
 if controller_security.accounting128_start(v) is distinct from true or v->>'call_id' is distinct from call_id::text
  or v-array['call_id','request_json_sha256','request_json_basis','template_sha256','model_selector','task'] is distinct from row.binding
 then raise exception 'accounting call binding refused' using errcode='42501';end if;
 select * into saved from public.model_accounting_call_starts where run_id=r and model_accounting_call_starts.call_id=accounting128_begin.call_id;
 if found then
  if saved.start_text is distinct from accounting128_begin.start_text then raise exception 'accounting call replay conflict' using errcode='42501';end if;
 else
  if (select count(*) from public.model_accounting_call_starts where run_id=r)>=1000 then raise exception 'accounting call limit refused';end if;
  receipt:=public.append_ledger(t,(row.binding->>'correlation_id')::uuid,'system','model-accounting-controller',
   null,null,null,'agent.model.call.started',call_id::text,h,null,null,null,null,null,'pending',jsonb_build_object('run_id',r,'start_sha256',h));
  insert into public.model_accounting_call_starts values(r,call_id,start_text,h,v,receipt) returning * into saved;claimed:=true;
 end if;
 return row.binding||jsonb_build_object('call_id',call_id,'claimed',claimed,'start_sha256',saved.start_sha256,
  'started_receipt',controller_security.accounting128_receipt(t,saved.receipt));
end $$;

-- Finishing records an already attempted observation even after a halt or
-- membership revocation. It confers no dispatch, retry, release or write scope.
create function controller_security.accounting128_finish(t uuid,r uuid,rh text,call_id uuid,outcome_text text,dispatch jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare  row public.model_accounting_runs; first public.model_accounting_call_starts;
 saved public.model_accounting_call_outcomes;v jsonb;receipt bigint;h text;
begin
 select * into row from public.model_accounting_runs where run_id=r;
 if row.run_id is null or row.origin is distinct from dispatch->>'origin' or row.binding is distinct from dispatch->'binding'
  or exists(select 1 from public.model_accounting_seals where run_id=r) then raise exception 'accounting run unavailable' using errcode='42501';end if;
 select * into first from public.model_accounting_call_starts where run_id=r and model_accounting_call_starts.call_id=accounting128_finish.call_id;
 v:=controller_security.prativedan123_json(outcome_text,16384);h:=controller_security.prativedan123_hash(outcome_text);
 if first.run_id is null or controller_security.accounting128_outcome(v) is distinct from true
  or v-array['state','failure_code','content_sha256','planned','serving','commitments','attempts','usage','pricing'] is distinct from first.start_packet
 then raise exception 'accounting observation binding refused' using errcode='42501';end if;
 select * into saved from public.model_accounting_call_outcomes where run_id=r and model_accounting_call_outcomes.call_id=accounting128_finish.call_id;
 if found then
  if saved.outcome_text is distinct from accounting128_finish.outcome_text then raise exception 'accounting observation replay conflict' using errcode='42501';end if;
 else
  receipt:=public.append_ledger(t,(row.binding->>'correlation_id')::uuid,'system','model-accounting-controller',
   null,null,null,'agent.model.call.observed',call_id::text,first.start_sha256,h,null,null,null,null,
   case when v->>'state'='completed' then 'success'::public.ledger_result else 'failure'::public.ledger_result end,
   jsonb_build_object('run_id',r,'outcome_sha256',h,'started_receipt',first.receipt::text));
  insert into public.model_accounting_call_outcomes values(r,call_id,outcome_text,h,v,receipt) returning * into saved;
 end if;
 return row.binding||jsonb_build_object('call_id',call_id,'outcome_sha256',saved.outcome_sha256,
  'completed_receipt',controller_security.accounting128_receipt(t,saved.receipt));
end $$;

create function controller_security.accounting128_completion(t uuid,r uuid,started bigint,completed bigint)
 returns boolean language plpgsql stable security definer set search_path='' as $$
declare row public.model_accounting_runs;first public.audit_ledger;last public.audit_ledger;
begin
 select * into row from public.model_accounting_runs where tenant_id=t and run_id=r;
 select * into first from public.audit_ledger where tenant_id=t and id=started;
 select * into last from public.audit_ledger where tenant_id=t and id=completed;
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then
  if controller_security.prativedan126_phase_valid(t,(row.binding->>'correlation_id')::uuid,'completed') is distinct from true
   or not exists(select 1 from public.prativedan_controller_phases where tenant_id=t and operation_key=(row.binding->>'correlation_id')::uuid and phase='completed' and receipt=completed)
  then return false;end if;
 end if;
 return row.run_id is not null and row.started_receipt=started and first.id is not null and last.id is not null
  and last.sequence_no>first.sequence_no and last.actor_type='agent' and last.actor_id=first.actor_id
  and last.agent_version=first.agent_version and last.action_type=first.action_type
  and last.correlation_id=first.correlation_id and last.target_ref is not distinct from first.target_ref
  and ((last.result='success' and last.detail->>'phase'='completed' and last.output_hash is not null and last.output_hash ~ '^[a-f0-9]{64}$')
   or (last.result='failure' and last.detail->>'phase'='failed' and last.output_hash is null
    and last.detail->>'failure_code' in ('agent_failed','audit_completion_failed','target_failed','invocation_cancelled','accounting_uncertain','current_authority_refused')))
  and last.detail->>'run_id'=r::text and last.detail->>'request_hash'=row.binding->>'request_sha256'
  and last.detail->>'started_entry'=started::text and last.input_hash=first.input_hash;
end $$;

create function controller_security.accounting128_read(t uuid,r uuid,rh text,dispatch jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare  row public.model_accounting_runs; saved public.model_accounting_seals;
begin
 select * into row from public.model_accounting_runs where run_id=r;
 select * into saved from public.model_accounting_seals where run_id=r;
 if row.run_id is null or saved.run_id is null or row.origin is distinct from dispatch->>'origin' or row.binding is distinct from dispatch->'binding'
 then raise exception 'accounting seal unavailable' using errcode='42501';end if;
 return row.binding||jsonb_build_object('serialization','postgres-jsonb-text-v1','calls_text',saved.calls_text,
  'calls_sha256',saved.calls_sha256,'summary',saved.summary,
  'requested_receipt',controller_security.accounting128_receipt(t,row.requested_receipt),
  'agent_started_receipt',controller_security.accounting128_receipt(t,row.started_receipt),
  'agent_completed_receipt',controller_security.accounting128_receipt(t,saved.completed_receipt),
  'accounting_receipt',controller_security.accounting128_receipt(t,saved.receipt));
end $$;

-- A controller loads terminal facts independently; HTTP bodies supply no witness.
create function public.read_model_accounting_result(t uuid,r uuid,rh text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare seal jsonb; saved public.model_accounting_seals; terminal public.audit_ledger;
begin
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then raise exception 'accounting generic origin refused' using errcode='42501';end if;
 seal:=controller_security.accounting128_read(t,r,rh,controller_security.accounting128_dispatch(t,r,rh,false));
 select * into saved from public.model_accounting_seals where run_id=r;
 if controller_security.accounting128_completion(t,r,(seal->'agent_started_receipt'->>'id')::bigint,saved.completed_receipt) is distinct from true
 then raise exception 'accounting terminal refused' using errcode='42501';end if;
 select * into terminal from public.audit_ledger where tenant_id=t and id=saved.completed_receipt;
 return jsonb_build_object('binding',seal-array['serialization','calls_text','calls_sha256','summary','requested_receipt','agent_started_receipt','agent_completed_receipt','accounting_receipt'],
  'seal',seal,'terminal_status',case when terminal.result='success' then 'succeeded' else 'failed' end,
  'runtime_output_sha256',terminal.output_hash);
end $$;

create function controller_security.accounting128_seal(t uuid,r uuid,rh text,started text,completed text,dispatch jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare  row public.model_accounting_runs; saved public.model_accounting_seals;
 first public.audit_ledger; last public.audit_ledger; calls jsonb; packet text; summary jsonb;receipt bigint;h text;
begin
 select * into row from public.model_accounting_runs where run_id=r;
 if row.run_id is null or row.origin is distinct from dispatch->>'origin' or row.binding is distinct from dispatch->'binding'
  or started is null or completed is null or started !~ '^[1-9][0-9]{0,18}$' or completed !~ '^[1-9][0-9]{0,18}$'
  or started::numeric>9223372036854775807 or completed::numeric>9223372036854775807
  or row.started_receipt::text is distinct from started then raise exception 'accounting seal refused' using errcode='42501';end if;
 select * into saved from public.model_accounting_seals where run_id=r;
 if found then
  if saved.completed_receipt::text is distinct from completed then raise exception 'accounting seal replay conflict' using errcode='42501';end if;
  return controller_security.accounting128_read(t,r,rh,dispatch);
 end if;
 select * into first from public.audit_ledger where tenant_id=t and id=row.started_receipt;
 select * into last from public.audit_ledger where tenant_id=t and id=completed::bigint;
 if controller_security.accounting128_completion(t,r,row.started_receipt,last.id) is distinct from true
  or exists(select 1 from public.model_accounting_call_starts cs left join public.model_accounting_call_outcomes co using(run_id,call_id)
   where cs.run_id=r and (co.run_id is null or cs.receipt>=last.id or co.receipt>=last.id))
 then raise exception 'accounting completion unconfirmed' using errcode='42501';end if;
 select coalesce(jsonb_agg(co.outcome_packet order by cs.receipt),'[]'::jsonb) into calls
  from public.model_accounting_call_starts cs join public.model_accounting_call_outcomes co using(run_id,call_id) where cs.run_id=r;
 packet:=calls::text;h:=controller_security.prativedan123_hash(packet);summary:=controller_security.accounting128_summary(calls);
 -- Refuse compatibility projection overflow. Exact retained decimal remains
 -- available even where its honest six-place projection is zero.
 if coalesce((summary->>'total_tokens')::numeric,0)>2147483647
  or round(coalesce((summary->>'estimate_usd')::numeric,0),6)>9999.999999
 then raise exception 'accounting compatibility overflow' using errcode='22003';end if;
 receipt:=public.append_ledger(t,(row.binding->>'correlation_id')::uuid,'system','model-accounting-controller',
  null,null,null,'agent.model.accounting.sealed',r::text,rh,h,null,null,null,null,'success',
  jsonb_build_object('calls_sha256',h,'summary',summary,'started_receipt',started,'completed_receipt',completed));
 insert into public.model_accounting_seals values(r,packet,h,summary,last.id,receipt);
 return controller_security.accounting128_read(t,r,rh,dispatch);
end $$;

create function public.load_model_accounting_dispatch(t uuid,r uuid,rh text) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then raise exception 'accounting generic origin refused' using errcode='42501';end if;
 dispatch:=controller_security.accounting128_dispatch(t,r,rh,true);
 return controller_security.accounting128_load(t,r,rh,dispatch);
end $$;

create function public.prativedan_load_model_accounting_dispatch(t uuid,r uuid,rh text,k uuid,authority jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 dispatch:=controller_security.accounting128_dedicated_dispatch(t,k,r,rh);
 if exists(select 1 from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase='completed') then raise exception 'accounting dedicated completed' using errcode='42501';end if;
 return controller_security.accounting128_load(t,r,rh,dispatch);
end $$;

create function public.begin_model_accounting_call(t uuid,r uuid,rh text,call_id uuid,start_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then raise exception 'accounting generic origin refused' using errcode='42501';end if;
 dispatch:=controller_security.accounting128_dispatch(t,r,rh,true);
 return controller_security.accounting128_begin(t,r,rh,call_id,start_text,dispatch);
end $$;

create function public.prativedan_begin_model_accounting_call(t uuid,r uuid,rh text,call_id uuid,start_text text,k uuid,authority jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 dispatch:=controller_security.accounting128_dedicated_dispatch(t,k,r,rh);
 if exists(select 1 from public.prativedan_controller_phases where tenant_id=t and operation_key=k and phase='completed') then raise exception 'accounting dedicated completed' using errcode='42501';end if;
 return controller_security.accounting128_begin(t,r,rh,call_id,start_text,dispatch);
end $$;

create function public.finish_model_accounting_call(t uuid,r uuid,rh text,call_id uuid,outcome_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then raise exception 'accounting generic origin refused' using errcode='42501';end if;
 dispatch:=controller_security.accounting128_dispatch(t,r,rh,false);
 return controller_security.accounting128_finish(t,r,rh,call_id,outcome_text,dispatch);
end $$;

create function public.prativedan_finish_model_accounting_call(t uuid,r uuid,rh text,call_id uuid,outcome_text text,k uuid,authority jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 dispatch:=controller_security.accounting128_dedicated_dispatch(t,k,r,rh);
 return controller_security.accounting128_finish(t,r,rh,call_id,outcome_text,dispatch);
end $$;

create function public.read_model_accounting_run(t uuid,r uuid,rh text) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then raise exception 'accounting generic origin refused' using errcode='42501';end if;
 dispatch:=controller_security.accounting128_dispatch(t,r,rh,false);
 return controller_security.accounting128_read(t,r,rh,dispatch);
end $$;

create function public.prativedan_read_model_accounting_run(t uuid,r uuid,rh text,k uuid,authority jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 dispatch:=controller_security.accounting128_dedicated_dispatch(t,k,r,rh);
 return controller_security.accounting128_read(t,r,rh,dispatch);
end $$;

create function public.seal_model_accounting_run(t uuid,r uuid,rh text,started text,completed text) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 if exists(select 1 from public.prativedan_draft_requests where tenant_id=t and run_id=r) then raise exception 'accounting generic origin refused' using errcode='42501';end if;
 dispatch:=controller_security.accounting128_dispatch(t,r,rh,false);
 return controller_security.accounting128_seal(t,r,rh,started,completed,dispatch);
end $$;

create function public.prativedan_seal_model_accounting_run(t uuid,r uuid,rh text,started text,completed text,k uuid,authority jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare dispatch jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 dispatch:=controller_security.accounting128_dedicated_dispatch(t,k,r,rh);
 return controller_security.accounting128_seal(t,r,rh,started,completed,dispatch);
end $$;

create function public.prativedan_read_model_accounting_result(t uuid,r uuid,rh text,k uuid,authority jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare seal jsonb; saved public.model_accounting_seals; terminal public.audit_ledger;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 seal:=controller_security.accounting128_read(t,r,rh,controller_security.accounting128_dedicated_dispatch(t,k,r,rh));
 select * into saved from public.model_accounting_seals where run_id=r;
 if controller_security.accounting128_completion(t,r,(seal->'agent_started_receipt'->>'id')::bigint,saved.completed_receipt) is distinct from true
 then raise exception 'accounting terminal refused' using errcode='42501';end if;
 select * into terminal from public.audit_ledger where tenant_id=t and id=saved.completed_receipt;
 return jsonb_build_object('binding',seal-array['serialization','calls_text','calls_sha256','summary','requested_receipt','agent_started_receipt','agent_completed_receipt','accounting_receipt'],
  'seal',seal,'terminal_status',case when terminal.result='success' then 'succeeded' else 'failed' end,
  'runtime_output_sha256',terminal.output_hash);
end $$;

create function controller_security.accounting128_dedicated_settlement(t uuid,k uuid,r uuid,rh text,output_text text,started bigint,completed bigint)
 returns void language plpgsql security definer set search_path='' as $$
declare journal jsonb;terminal public.audit_ledger;
begin
 if exists(select 1 from public.model_accounting_runs where run_id=r) then
  journal:=controller_security.accounting128_read(t,r,rh,controller_security.accounting128_dedicated_dispatch(t,k,r,rh));
  if journal->'agent_started_receipt'->>'id' is distinct from started::text
   or journal->'agent_completed_receipt'->>'id' is distinct from completed::text
  then raise exception 'dedicated accounting settlement receipt refused' using errcode='42501';end if;
  select * into terminal from public.audit_ledger where tenant_id=t and id=completed;
  if terminal.output_hash is distinct from controller_security.prativedan123_hash(output_text)
  then raise exception 'dedicated accounting output bytes refused' using errcode='42501';end if;
 end if;
end $$;
-- Guard the common original ten-argument sink as well as the scoped wrapper.
alter function public.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint) set schema controller_security;
alter function controller_security.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint) rename to prativedan128_legacy_settle_before;
revoke all on function controller_security.prativedan128_legacy_settle_before(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller,axiom_prativedan_controller;
create function public.settle_prativedan_assessment_draft(t uuid,k uuid,r uuid,rh text,input_hash text,
 config_text text,output_text text,response_text text,started bigint,completed bigint)
 returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
begin
 perform controller_security.accounting128_dedicated_settlement(t,k,r,rh,output_text,started,completed);
 return controller_security.prativedan128_legacy_settle_before(t,k,r,rh,input_hash,config_text,output_text,response_text,started,completed);
end $$;
revoke all on function public.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller,axiom_prativedan_controller;

create function controller_security.accounting128_prativedan_output_fence() returns trigger
 language plpgsql security definer set search_path='' as $$
declare q public.prativedan_draft_requests;
begin
 select * into q from public.prativedan_draft_requests where tenant_id=new.tenant_id and operation_key=new.operation_key;
 perform controller_security.accounting128_dedicated_settlement(q.tenant_id,q.operation_key,q.run_id,q.request_sha256,new.runtime_output_text,new.started_receipt,new.completed_receipt);
 return null;
end $$;
create constraint trigger accounted_prativedan_output_fence after insert on public.prativedan_draft_outputs
 deferrable initially deferred for each row execute function controller_security.accounting128_prativedan_output_fence();

-- Existing126 atomic settlement must honor an opted-in journal at the public
-- scoped entrypoint, while its original source/phase/transaction checks remain.
alter function public.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) set schema controller_security;
alter function controller_security.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) rename to prativedan128_settle_before;
revoke all on function controller_security.prativedan128_settle_before(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller,axiom_prativedan_controller;
create function public.settle_prativedan_assessment_draft(t uuid,k uuid,r uuid,rh text,input_hash text,
 config_text text,output_text text,response_text text,started bigint,completed bigint,authority jsonb)
 returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare journal jsonb; terminal public.audit_ledger;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||k::text,123));
 perform controller_security.prativedan126_authorize(t,k,r,rh,authority);
 if exists(select 1 from public.model_accounting_runs where run_id=r) then
  journal:=controller_security.accounting128_read(t,r,rh,controller_security.accounting128_dedicated_dispatch(t,k,r,rh));
  if journal->'agent_started_receipt'->>'id' is distinct from started::text
   or journal->'agent_completed_receipt'->>'id' is distinct from completed::text
  then raise exception 'dedicated accounting settlement receipt refused' using errcode='42501';end if;
  select * into terminal from public.audit_ledger where tenant_id=t and id=completed;
  if terminal.output_hash is distinct from controller_security.prativedan123_hash(output_text)
  then raise exception 'dedicated accounting output bytes refused' using errcode='42501';end if;
 end if;
 return controller_security.prativedan128_settle_before(t,k,r,rh,input_hash,config_text,output_text,response_text,started,completed,authority);
end $$;
revoke all on function public.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
grant execute on function public.settle_prativedan_assessment_draft(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) to axiom_prativedan_controller;

-- Both directions are checked at commit: no copied receipt, row with mismatched
-- persisted semantics, or standalone append claiming accounting completion.
create function controller_security.accounting128_validate(r uuid) returns void
 language plpgsql security definer set search_path='' as $$
declare row public.model_accounting_runs; dispatch jsonb; l public.audit_ledger;s public.model_accounting_call_starts;
 o public.model_accounting_call_outcomes; seal public.model_accounting_seals; calls jsonb;
begin
 select * into row from public.model_accounting_runs where run_id=r;
 if row.run_id is null then raise exception 'accounting journal absent';end if;
 dispatch:=controller_security.accounting128_dispatch(row.tenant_id,r,row.binding->>'request_sha256',false);
 if row.origin is distinct from dispatch->>'origin' or row.binding is distinct from dispatch->'binding' or row.requested_receipt<>(dispatch->>'requested_receipt')::bigint
  or row.started_receipt<>(dispatch->>'started_receipt')::bigint then raise exception 'accounting journal binding refused';end if;
 select * into l from public.audit_ledger where tenant_id=row.tenant_id and id=row.opened_receipt;
 if l.id is null or l.action_type::text<>'agent.model.accounting.opened' or l.actor_type<>'system'
  or l.actor_id<>'model-accounting-controller' or l.target_ref is distinct from r::text
  or l.correlation_id is distinct from (row.binding->>'correlation_id')::uuid
  or l.input_hash is distinct from row.binding->>'request_sha256' or l.output_hash is not null
  or l.result<>'pending' or l.detail is distinct from row.binding or l.id<=row.started_receipt
 then raise exception 'accounting opened receipt refused';end if;
 for s in select * from public.model_accounting_call_starts where run_id=r loop
  select * into l from public.audit_ledger where tenant_id=row.tenant_id and id=s.receipt;
  if s.start_packet-array['call_id','request_json_sha256','request_json_basis','template_sha256','model_selector','task'] is distinct from row.binding
   or s.start_packet->>'call_id' is distinct from s.call_id::text
   or l.id is null or l.id<=row.opened_receipt or l.action_type::text<>'agent.model.call.started'
   or l.actor_type<>'system' or l.actor_id<>'model-accounting-controller'
   or l.correlation_id is distinct from (row.binding->>'correlation_id')::uuid or l.target_ref is distinct from s.call_id::text
   or l.input_hash is distinct from s.start_sha256 or l.output_hash is not null or l.result<>'pending'
   or l.detail is distinct from jsonb_build_object('run_id',r,'start_sha256',s.start_sha256)
  then raise exception 'accounting call start receipt refused';end if;
 end loop;
 for o in select * from public.model_accounting_call_outcomes where run_id=r loop
  select * into s from public.model_accounting_call_starts where run_id=r and call_id=o.call_id;
  select * into l from public.audit_ledger where tenant_id=row.tenant_id and id=o.receipt;
  if o.outcome_packet-array['state','failure_code','content_sha256','planned','serving','commitments','attempts','usage','pricing'] is distinct from s.start_packet
   or l.id is null or l.id<=s.receipt or l.action_type::text<>'agent.model.call.observed'
   or l.actor_type<>'system' or l.actor_id<>'model-accounting-controller'
   or l.correlation_id is distinct from (row.binding->>'correlation_id')::uuid or l.target_ref is distinct from o.call_id::text
   or l.input_hash is distinct from s.start_sha256 or l.output_hash is distinct from o.outcome_sha256
   or l.result::text is distinct from (case when o.outcome_packet->>'state'='completed' then 'success' else 'failure' end)
   or l.detail is distinct from jsonb_build_object('run_id',r,'outcome_sha256',o.outcome_sha256,'started_receipt',s.receipt::text)
  then raise exception 'accounting observation receipt refused';end if;
 end loop;
 select * into seal from public.model_accounting_seals where run_id=r;
 if found then
  if controller_security.accounting128_completion(row.tenant_id,r,row.started_receipt,seal.completed_receipt) is distinct from true
  then raise exception 'accounting completion receipt refused';end if;
  if exists(select 1 from public.model_accounting_call_starts cs left join public.model_accounting_call_outcomes co using(run_id,call_id)
   where cs.run_id=r and (co.run_id is null or cs.receipt>=seal.completed_receipt or co.receipt>=seal.completed_receipt))
  then raise exception 'accounting unclosed callset';end if;
  select coalesce(jsonb_agg(co.outcome_packet order by cs.receipt),'[]'::jsonb) into calls
   from public.model_accounting_call_starts cs join public.model_accounting_call_outcomes co using(run_id,call_id) where cs.run_id=r;
  select * into l from public.audit_ledger where tenant_id=row.tenant_id and id=seal.receipt;
  if seal.calls_text is distinct from calls::text or seal.summary is distinct from controller_security.accounting128_summary(calls)
   or l.id is null or l.id<=seal.completed_receipt or l.action_type::text<>'agent.model.accounting.sealed'
   or l.actor_type<>'system' or l.actor_id<>'model-accounting-controller'
   or l.correlation_id is distinct from (row.binding->>'correlation_id')::uuid or l.target_ref is distinct from r::text
   or l.input_hash is distinct from row.binding->>'request_sha256' or l.output_hash is distinct from seal.calls_sha256 or l.result<>'success'
   or l.detail is distinct from jsonb_build_object('calls_sha256',seal.calls_sha256,'summary',seal.summary,
    'started_receipt',row.started_receipt::text,'completed_receipt',seal.completed_receipt::text)
  then raise exception 'accounting sealed receipt refused';end if;
 end if;
end $$;

revoke all on function controller_security.accounting128_completion(uuid,uuid,bigint,bigint) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

create function controller_security.accounting128_row_fence() returns trigger
 language plpgsql security definer set search_path='' as $$begin
 perform controller_security.accounting128_validate(new.run_id);return new;
end $$;
create function controller_security.accounting128_ledger_fence() returns trigger
 language plpgsql security definer set search_path='' as $$
declare run uuid;
begin
 if new.action_type::text not in ('agent.model.accounting.opened','agent.model.call.started','agent.model.call.observed','agent.model.accounting.sealed') then return new;end if;
 if new.action_type::text='agent.model.accounting.opened' then select run_id into run from public.model_accounting_runs where opened_receipt=new.id;
 elsif new.action_type::text='agent.model.call.started' then select run_id into run from public.model_accounting_call_starts where receipt=new.id;
 elsif new.action_type::text='agent.model.call.observed' then select run_id into run from public.model_accounting_call_outcomes where receipt=new.id;
 else select run_id into run from public.model_accounting_seals where receipt=new.id;end if;
 if run is null then raise exception 'accounting orphan receipt refused' using errcode='42501';end if;
 perform controller_security.accounting128_validate(run);return new;
end $$;
create constraint trigger model_accounting_ledger_fence after insert on public.audit_ledger
 deferrable initially deferred for each row execute function controller_security.accounting128_ledger_fence();

alter table public.model_accounting_runs enable row level security;
revoke all on public.model_accounting_runs from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
create trigger model_accounting_runs_immutable before update or delete on public.model_accounting_runs
 for each row execute function public.evidence_receipt_immutable();
create constraint trigger model_accounting_runs_fence after insert on public.model_accounting_runs
 deferrable initially deferred for each row execute function controller_security.accounting128_row_fence();

alter table public.model_accounting_call_starts enable row level security;
revoke all on public.model_accounting_call_starts from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
create trigger model_accounting_call_starts_immutable before update or delete on public.model_accounting_call_starts
 for each row execute function public.evidence_receipt_immutable();
create constraint trigger model_accounting_call_starts_fence after insert on public.model_accounting_call_starts
 deferrable initially deferred for each row execute function controller_security.accounting128_row_fence();

alter table public.model_accounting_call_outcomes enable row level security;
revoke all on public.model_accounting_call_outcomes from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
create trigger model_accounting_call_outcomes_immutable before update or delete on public.model_accounting_call_outcomes
 for each row execute function public.evidence_receipt_immutable();
create constraint trigger model_accounting_call_outcomes_fence after insert on public.model_accounting_call_outcomes
 deferrable initially deferred for each row execute function controller_security.accounting128_row_fence();

alter table public.model_accounting_seals enable row level security;
revoke all on public.model_accounting_seals from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;
create trigger model_accounting_seals_immutable before update or delete on public.model_accounting_seals
 for each row execute function public.evidence_receipt_immutable();
create constraint trigger model_accounting_seals_fence after insert on public.model_accounting_seals
 deferrable initially deferred for each row execute function controller_security.accounting128_row_fence();

revoke all on function controller_security.accounting128_keys(jsonb,text[]) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_hash(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_identity(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_uuid(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_token(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_decimal(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_route(jsonb,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_start(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_outcome(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_receipt(uuid,bigint) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_summary(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_dispatch(uuid,uuid,text,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_validate(uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_row_fence() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function controller_security.accounting128_ledger_fence() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

revoke all on function public.load_model_accounting_dispatch(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;
grant execute on function public.load_model_accounting_dispatch(uuid,uuid,text) to axiom_model_accounting_controller;

revoke all on function public.begin_model_accounting_call(uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;
grant execute on function public.begin_model_accounting_call(uuid,uuid,text,uuid,text) to axiom_model_accounting_controller;

revoke all on function public.finish_model_accounting_call(uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;
grant execute on function public.finish_model_accounting_call(uuid,uuid,text,uuid,text) to axiom_model_accounting_controller;

revoke all on function public.read_model_accounting_run(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;
grant execute on function public.read_model_accounting_run(uuid,uuid,text) to axiom_model_accounting_controller;

revoke all on function public.seal_model_accounting_run(uuid,uuid,text,text,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;
grant execute on function public.seal_model_accounting_run(uuid,uuid,text,text,text) to axiom_model_accounting_controller;

-- Preserve0104 receipt and settlement semantics; accounting is retained
-- separately. Unknown new aggregates are nullable, never projected to fake zero.
create or replace function controller_security.generic_finish_before_119(
 p_tenant_id uuid,p_actor_id uuid,p_run_id uuid,p_agent text,p_engagement_id uuid,
 p_correlation_id uuid,p_request_hash text,p_status text,p_error_code text,
 p_latency_ms integer,p_input_tokens integer,p_output_tokens integer,p_cost_usd numeric,
 p_started_receipt text,p_completed_receipt text,p_response_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_run public.agent_runs; v_start public.audit_ledger; v_end public.audit_ledger;
 v_request public.audit_ledger; v_action text; v_settlement jsonb; v_receipt bigint;
 v_outcome text; v_runtime_input text; v_runtime_output text;
 v_accounted boolean; v_accounting public.model_accounting_seals;
 v_accounting_terminal public.audit_ledger; v_projection_cost numeric;
begin
 if p_tenant_id is null or p_actor_id is null or p_run_id is null
  or p_correlation_id is null or p_agent is null or p_request_hash is null
  or p_request_hash !~ '^[a-f0-9]{64}$' or p_status is null or p_status not in ('succeeded','failed')
  or (p_latency_ms is not null and p_latency_ms<0)
  or (p_input_tokens is not null and p_input_tokens<0)
  or (p_output_tokens is not null and p_output_tokens<0)
  or coalesce(p_input_tokens,0)::bigint+coalesce(p_output_tokens,0)::bigint>2147483647
  or (p_cost_usd is not null and (p_cost_usd<0 or p_cost_usd>9999.999999 or p_cost_usd::text in ('NaN','Infinity','-Infinity')))
  or (p_response_hash is not null and p_response_hash !~ '^[a-f0-9]{64}$')
  or (p_status='succeeded' and (p_error_code is not null or p_response_hash is null
   or p_latency_ms is null))
  or (p_status='failed' and (p_error_code is null or p_error_code not in ('agent_invocation_failed','agent_reported_failure') or p_response_hash is not null))
 then return jsonb_build_object('error','invalid_record'); end if;
 -- Confirmation records the originally authorized attempt; revoked membership
 -- cannot erase its observed outcome. It never authorizes another dispatch.
 select * into v_run from public.agent_runs where tenant_id=p_tenant_id and id=p_run_id for update;
 if not found or v_run.agent is distinct from p_agent
  or v_run.engagement_id is distinct from p_engagement_id
  or v_run.correlation_id is distinct from p_correlation_id
  or v_run.metadata->>'lifecycle_writer' is distinct from 'generic_agent_rpc_v1'
  or v_run.metadata->>'requested_by' is distinct from p_actor_id::text
  or v_run.input_redacted_hash is distinct from p_request_hash
 then return jsonb_build_object('error','run_context_conflict'); end if;
 select * into v_request from public.audit_ledger where tenant_id=p_tenant_id
  and id::text=v_run.metadata->>'request_receipt';
 if v_request.id is null or v_request.actor_type<>'human' or v_request.actor_id<>p_actor_id::text
  or v_request.action_type<>'agent.invocation.requested' or v_request.target_ref is distinct from p_run_id::text
  or v_request.correlation_id<>p_correlation_id or v_request.input_hash is distinct from p_request_hash
  or v_request.result<>'pending' or v_request.detail->>'agent' is distinct from p_agent
  or v_request.detail->>'engagement_id' is distinct from p_engagement_id::text
 then return jsonb_build_object('error','request_unconfirmed'); end if;
 -- The common private sink is also called directly by0119. Enforcing
 -- only the public wrapper would leave that nested finalizer as a bypass.
 select exists(select 1 from public.model_accounting_runs where tenant_id=p_tenant_id and run_id=p_run_id) into v_accounted;
 if v_accounted then
  perform controller_security.accounting128_validate(p_run_id);
  select * into v_accounting from public.model_accounting_seals where run_id=p_run_id;
  if v_accounting.run_id is null then return jsonb_build_object('error','model_accounting_unsealed');end if;
  select * into v_accounting_terminal from public.audit_ledger where tenant_id=p_tenant_id and id=v_accounting.completed_receipt;
  if (p_status='succeeded' and v_accounting_terminal.result<>'success')
   or (p_status='failed' and v_accounting_terminal.result<>'failure')
   or p_started_receipt is distinct from (select started_receipt::text from public.model_accounting_runs where run_id=p_run_id)
   or p_completed_receipt is distinct from v_accounting.completed_receipt::text
  then return jsonb_build_object('error','model_accounting_terminal_conflict');end if;
  v_projection_cost:=case when v_accounting.summary->>'estimate_usd' is null then null else round((v_accounting.summary->>'estimate_usd')::numeric,6) end;
  if p_input_tokens is distinct from (v_accounting.summary->>'input_tokens')::integer
   or p_output_tokens is distinct from (v_accounting.summary->>'output_tokens')::integer
   or p_cost_usd is distinct from v_projection_cost
  then return jsonb_build_object('error','model_accounting_projection_conflict');end if;
 elsif p_status='succeeded' and (p_input_tokens is null or p_output_tokens is null or p_cost_usd is null) then
  return jsonb_build_object('error','invalid_record');
 end if;
 v_settlement:=jsonb_build_object('status',p_status,'error',p_error_code,'latency_ms',p_latency_ms,
  'input_tokens',p_input_tokens,'output_tokens',p_output_tokens,'cost_usd',p_cost_usd,
  'started_receipt',p_started_receipt,'completed_receipt',p_completed_receipt,'response_hash',p_response_hash);
 if v_run.status<>'running' or v_run.completed_at is not null then
  if v_run.metadata->'settlement' is not distinct from v_settlement then
   return jsonb_build_object('run_id',v_run.id,'status',v_run.status,'replayed',true);
  end if;
  return jsonb_build_object('error','terminal_conflict');
 end if;
 v_outcome:='unconfirmed';
 if p_status='succeeded' then
  -- IDs are actual persisted bigint receipts, never in-memory IDs or artifacts.
  if p_started_receipt is null or p_completed_receipt is null
   or p_started_receipt !~ '^[1-9][0-9]{0,18}$' or p_completed_receipt !~ '^[1-9][0-9]{0,18}$'
   or p_started_receipt::numeric>9223372036854775807 or p_completed_receipt::numeric>9223372036854775807
  then return jsonb_build_object('error','receipts_unconfirmed'); end if;
  select * into v_start from public.audit_ledger where tenant_id=p_tenant_id and id=p_started_receipt::bigint;
  select * into v_end from public.audit_ledger where tenant_id=p_tenant_id and id=p_completed_receipt::bigint;
  v_action:=case p_agent when 'drishti' then 'discovery.started' when 'vibhaag' then 'classification.started'
   when 'parikshan' then 'assessment.started' when 'saakshi' then 'evidence.collected'
   when 'sudhaar' then 'plan.generated' when 'lekha' then 'execution.started' else 'report.generated' end;
  if v_start.id is null or v_end.id is null or v_start.sequence_no>=v_end.sequence_no
   or v_start.sequence_no<=v_request.sequence_no
   or v_start.actor_type<>'agent' or v_end.actor_type<>'agent'
   or v_start.actor_id<>p_agent or v_end.actor_id<>p_agent
   or v_start.action_type::text<>v_action or v_end.action_type::text<>v_action
   or v_start.result<>'pending' or v_end.result<>'success'
   or v_start.correlation_id<>p_correlation_id or v_end.correlation_id<>p_correlation_id
   or v_start.target_ref is distinct from p_engagement_id::text or v_end.target_ref is distinct from p_engagement_id::text
   or v_start.agent_version is null or v_start.agent_version is distinct from v_end.agent_version
   or v_start.input_hash is null or v_start.input_hash !~ '^[a-f0-9]{64}$'
   or v_start.input_hash is distinct from v_end.input_hash
   or v_end.output_hash is null or v_end.output_hash !~ '^[a-f0-9]{64}$'
   or v_start.detail->>'phase' is distinct from 'started' or v_end.detail->>'phase' is distinct from 'completed'
   or v_start.detail->>'run_id' is distinct from p_run_id::text or v_end.detail->>'run_id' is distinct from p_run_id::text
   or v_start.detail->>'request_hash' is distinct from p_request_hash or v_end.detail->>'request_hash' is distinct from p_request_hash
   or v_end.detail->>'started_entry' is distinct from p_started_receipt
  then return jsonb_build_object('error','receipts_unconfirmed'); end if;
  v_outcome:='receipt_confirmed'; v_runtime_input:=v_start.input_hash; v_runtime_output:=v_end.output_hash;
 elsif p_error_code='agent_reported_failure' then
  v_outcome:='runtime_reported_failure';
 end if;
 v_receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'system','bff-generic-agent-controller',
  null,null,null,'agent.invocation.settled',p_run_id::text,p_request_hash,v_runtime_output,
  null,null,null,null,case when p_status='succeeded' then 'success'::public.ledger_result else 'failure'::public.ledger_result end,
  jsonb_build_object('requested_by',p_actor_id,'agent',p_agent,'runtime_outcome',v_outcome,
   'started_receipt',p_started_receipt,'completed_receipt',p_completed_receipt));
 update public.agent_runs set status=p_status,completed_at=clock_timestamp(),latency_ms=p_latency_ms,
  input_tokens=p_input_tokens,output_tokens=p_output_tokens,
  total_tokens=case when p_input_tokens is null or p_output_tokens is null then null else p_input_tokens+p_output_tokens end,
  cost_usd=p_cost_usd,error=p_error_code,output_redacted_hash=v_runtime_output,
  metadata=metadata||jsonb_build_object('settlement',v_settlement,'settlement_receipt',v_receipt::text,
   'runtime_outcome',v_outcome,'runtime_normalized_input_hash',v_runtime_input,
   'runtime_output_hash',v_runtime_output,'response_output_hash',p_response_hash,
   'model_accounting_status',case when v_accounted then 'sealed_observed_journal' else 'legacy_unverified' end,
   'model_accounting_receipt',case when v_accounted then v_accounting.receipt::text else null end)
 where id=p_run_id;
 return jsonb_build_object('run_id',p_run_id,'status',p_status,'replayed',false);
end $$;
revoke all on function controller_security.generic_finish_before_119(uuid,uuid,uuid,text,uuid,uuid,text,text,text,integer,integer,integer,numeric,text,text,text)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller;

commit;

revoke all on function public.read_model_accounting_result(uuid,uuid,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer;
grant execute on function public.read_model_accounting_result(uuid,uuid,text) to axiom_model_accounting_controller;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='controller_security' and p.proname like 'accounting128_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller,axiom_prativedan_controller',f.signature);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'prativedan_%model_accounting%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,evidence_ingestion_writer,axiom_model_accounting_controller',f.signature);
  execute format('grant execute on function %s to axiom_prativedan_controller',f.signature);
 end loop;
end $$;
