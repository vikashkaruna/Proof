-- Unmounted source-only Option A: global reference provenance is separate from
-- organisation ledgers. Only an organisation's own adoption produces its receipt.
-- Authority tenant is independently server-derived founder membership context,
-- never a global audit home. SQL does not prove a live session/MFA/source review;
-- a required trusted server authorizer and dedicated custody remain mounting gates.
alter type public.ledger_action_type add value if not exists 'catalogue.mapping_contexts_adopted';
do $$begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='axiom_catalogue_publisher') then
  create role axiom_catalogue_publisher nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
end $$;
-- PG17 can add genuine creator ADMIN-only custody. This grants neither SET nor
-- INHERIT. Foreign ADMIN, every SET/INHERIT and all outbound memberships refuse.
create function controller_security.catalogue127_role_safe() returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from pg_catalog.pg_roles where rolname='axiom_catalogue_publisher'
  and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
 and not exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member
  where r.rolname='axiom_catalogue_publisher')
 and not exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid
  where r.rolname='axiom_catalogue_publisher' and (m.set_option or m.inherit_option or not m.admin_option
   or m.member<>(select oid from pg_catalog.pg_roles where rolname=current_user)))
$$;
do $$begin
 if controller_security.catalogue127_role_safe() is distinct from true then raise exception 'catalogue publisher role unsafe';end if;
end $$;
grant usage on schema public to axiom_catalogue_publisher;

create table public.mapping_context_publications (
 publication_version text primary key check(publication_version ~ '^[a-z0-9][a-z0-9.-]{2,79}$'),
 library_version text not null references public.control_libraries(version) on delete restrict,
 packet_text text not null check(octet_length(packet_text) between 1 and 1048576),
 packet_sha256 text not null check(packet_sha256 ~ '^[0-9a-f]{64}$'),
 context_count integer not null check(context_count between 1 and 1000),
 unique(publication_version,library_version)
);
create table public.mapping_context_publication_provenance (
 publication_version text primary key references public.mapping_context_publications(publication_version) on delete restrict,
 authority_tenant_id uuid not null references public.tenants(id) on delete restrict,
 published_by uuid not null references public.users(id) on delete restrict,
 session_id uuid not null check(session_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 correlation_id uuid not null check(correlation_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 request_text text not null check(octet_length(request_text) between 1 and 1048576),
 request_sha256 text not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp()
);
create table public.mapping_contexts (
 publication_version text not null,
 library_version text not null,
 ordinal integer not null check(ordinal between 1 and 1000),
 sector_pack_id uuid not null references public.sector_packs(id) on delete restrict,
 framework_control_id uuid not null references public.framework_controls(id) on delete restrict,
 control_id text not null,
 mapping_strength text not null check(mapping_strength in ('equivalent','partial','indicative')),
 provenance text not null check(provenance in ('reference','mapped')),
 note text not null check(length(note) between 1 and 2000),
 check(not(mapping_strength='equivalent' and provenance='reference')),
 primary key(publication_version,ordinal),
 unique(publication_version,sector_pack_id,framework_control_id,control_id),
 foreign key(publication_version,library_version) references public.mapping_context_publications(publication_version,library_version) on delete restrict,
 foreign key(control_id,library_version) references public.controls(id,library_version) on delete restrict
);
create table public.mapping_context_adoptions (
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 operation_key uuid not null check(operation_key<>'00000000-0000-0000-0000-000000000000'::uuid),
 publication_version text not null references public.mapping_context_publications(publication_version) on delete restrict,
 sector_pack_id uuid not null references public.sector_packs(id) on delete restrict,
 actor_id uuid not null references public.users(id) on delete restrict,
 session_id uuid not null check(session_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 correlation_id uuid not null check(correlation_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 request_text text not null check(octet_length(request_text) between 1 and 4096),
 request_sha256 text not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
 receipt_id bigint not null unique references public.audit_ledger(id) on delete restrict,
 primary key(tenant_id,operation_key)
);
alter table public.mapping_context_publications enable row level security;
alter table public.mapping_context_publication_provenance enable row level security;
alter table public.mapping_contexts enable row level security;
alter table public.mapping_context_adoptions enable row level security;
create function controller_security.catalogue127_packet(v text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('publicationVersion',p.publication_version,'libraryVersion',p.library_version,
  'contexts',coalesce(jsonb_agg(jsonb_build_object('sectorPackCode',s.code,'frameworkCode',f.code,'ref',fc.ref,
   'controlId',m.control_id,'mappingStrength',m.mapping_strength,'provenance',m.provenance,'note',m.note) order by m.ordinal),'[]'::jsonb))
 from public.mapping_context_publications p join public.mapping_contexts m on m.publication_version=p.publication_version
 join public.sector_packs s on s.id=m.sector_pack_id join public.framework_controls fc on fc.id=m.framework_control_id
 join public.frameworks f on f.id=fc.framework_id where p.publication_version=v
 group by p.publication_version,p.library_version
$$;
create function controller_security.catalogue127_valid(v text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(bool_and(p.packet_text=controller_security.catalogue127_packet(v)::text
  and p.packet_sha256=encode(sha256(convert_to(p.packet_text,'UTF8')),'hex')
  and p.context_count=(select count(*) from public.mapping_contexts where publication_version=v)
  and h.request_sha256=encode(sha256(convert_to(h.request_text,'UTF8')),'hex')
  and controller_security.prativedan123_json(h.request_text,1048576)=controller_security.catalogue127_packet(v)
 ),false) from public.mapping_context_publications p join public.mapping_context_publication_provenance h
 on h.publication_version=p.publication_version where p.publication_version=v
$$;
create function controller_security.catalogue127_authority(t uuid,a uuid,global_action boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if t is null or a is null or t='00000000-0000-0000-0000-000000000000'::uuid or a='00000000-0000-0000-0000-000000000000'::uuid then return false;end if;
 lock table public.kill_switch_state in share mode;
 perform 1 from public.kill_switch_state where scope='global' or (not global_action and tenant_id=t) for share;
 if not exists(select 1 from public.kill_switch_state where scope_key='global' and not engaged)
  or exists(select 1 from public.kill_switch_state where engaged and (scope='global' or (not global_action and tenant_id=t)))
 then return false;end if;
 perform 1 from public.tenants where id=t for share;
 if not found then return false;end if;
 perform 1 from public.users where id=a and is_axiom_internal is true for share;
 if not found then return false;end if;
 perform 1 from public.tenant_users where tenant_id=t and user_id=a and role='founder' for share;
 return found;
end $$;
create function controller_security.catalogue127_adoption_valid(t uuid,k uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(bool_and(controller_security.catalogue127_valid(a.publication_version)
  and a.request_sha256=encode(sha256(convert_to(a.request_text,'UTF8')),'hex')
  and controller_security.prativedan123_json(a.request_text,4096)=jsonb_build_object('operationKey',a.operation_key,
   'publicationVersion',a.publication_version,'expectedPacketSha256',p.packet_sha256,'sectorPackCode',s.code)
  and exists(select 1 from public.mapping_contexts m where m.publication_version=a.publication_version and m.sector_pack_id=a.sector_pack_id)
  and l.tenant_id=a.tenant_id and l.correlation_id=a.correlation_id and l.actor_type='human'
  and l.actor_id=a.actor_id::text and l.agent_version is null and l.model_id is null and l.prompt_hash is null
  and l.action_type::text='catalogue.mapping_contexts_adopted' and l.target_ref=a.operation_key::text
  and l.input_hash=a.request_sha256 and l.output_hash=p.packet_sha256 and l.result='success'
  and l.approval_token_id is null and l.approver_id is null and l.pre_state_ref is null and l.post_state_ref is null
  and l.detail=jsonb_build_object('operationKey',a.operation_key,'publicationVersion',a.publication_version,
   'libraryVersion',p.library_version,'sectorPackCode',s.code,'packetSha256',p.packet_sha256,
   'requestSha256',a.request_sha256,'sessionId',a.session_id)
 ),false) from public.mapping_context_adoptions a join public.mapping_context_publications p on p.publication_version=a.publication_version
 join public.sector_packs s on s.id=a.sector_pack_id join public.audit_ledger l on l.id=a.receipt_id
 where a.tenant_id=t and a.operation_key=k
$$;
create function controller_security.catalogue127_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'catalogue context immutable';end if;
 if tg_table_name='audit_ledger' then
  if new.action_type::text<>'catalogue.mapping_contexts_adopted' then return new;end if;
  if not exists(select 1 from public.mapping_context_adoptions where receipt_id=new.id and tenant_id=new.tenant_id)
   or not controller_security.catalogue127_adoption_valid(new.tenant_id,new.target_ref::uuid)
  then raise exception 'catalogue adoption journal refused';end if;
 elsif tg_table_name='mapping_context_adoptions' then
  if not controller_security.catalogue127_adoption_valid(new.tenant_id,new.operation_key) then raise exception 'catalogue adoption journal refused';end if;
 else
  if not controller_security.catalogue127_valid(new.publication_version) then raise exception 'catalogue publication provenance refused';end if;
 end if;
 return new;
end $$;
create constraint trigger mapping_context_publication_binding after insert on public.mapping_context_publications deferrable initially deferred for each row execute function controller_security.catalogue127_guard();
create constraint trigger mapping_context_provenance_binding after insert on public.mapping_context_publication_provenance deferrable initially deferred for each row execute function controller_security.catalogue127_guard();
create constraint trigger mapping_context_row_binding after insert on public.mapping_contexts deferrable initially deferred for each row execute function controller_security.catalogue127_guard();
create constraint trigger mapping_context_adoption_binding after insert on public.mapping_context_adoptions deferrable initially deferred for each row execute function controller_security.catalogue127_guard();
create constraint trigger mapping_context_ledger_binding after insert on public.audit_ledger deferrable initially deferred for each row execute function controller_security.catalogue127_guard();
create trigger mapping_context_publication_immutable before update or delete or truncate on public.mapping_context_publications for each statement execute function controller_security.catalogue127_guard();
create trigger mapping_context_provenance_immutable before update or delete or truncate on public.mapping_context_publication_provenance for each statement execute function controller_security.catalogue127_guard();
create trigger mapping_context_row_immutable before update or delete or truncate on public.mapping_contexts for each statement execute function controller_security.catalogue127_guard();
create trigger mapping_context_adoption_immutable before update or delete or truncate on public.mapping_context_adoptions for each statement execute function controller_security.catalogue127_guard();
create function controller_security.catalogue127_proof(v text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.mapping_context_publications;h public.mapping_context_publication_provenance;
begin
 if not controller_security.catalogue127_valid(v) then raise exception 'catalogue context proof unavailable';end if;
 select * into strict p from public.mapping_context_publications where publication_version=v;
 select * into strict h from public.mapping_context_publication_provenance where publication_version=v;
 return jsonb_build_object('publicationVersion',p.publication_version,'libraryVersion',p.library_version,'contextCount',p.context_count,
  'authorityTenantId',h.authority_tenant_id,'publisherId',h.published_by,'correlationId',h.correlation_id,'sessionId',h.session_id,
  'requestText',h.request_text,'requestSha256',h.request_sha256,'packetText',p.packet_text,'packetSha256',p.packet_sha256);
end $$;
create function public.publish_mapping_context_publication(p_publication_version text,p_library_version text,p_contexts jsonb,
 p_authority_tenant_id uuid,p_published_by uuid,p_correlation_id uuid,p_session_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;pack public.sector_packs;fc uuid;packet text;hash text;n integer;i integer:=0;
 existing public.mapping_context_publications;h public.mapping_context_publication_provenance;
begin
 if p_publication_version is null or p_publication_version !~ '^[a-z0-9][a-z0-9.-]{2,79}$'
  or p_library_version is null or length(p_library_version) not between 1 and 100
  or p_correlation_id is null or p_correlation_id='00000000-0000-0000-0000-000000000000'::uuid
  or p_session_id is null or p_session_id='00000000-0000-0000-0000-000000000000'::uuid
  or jsonb_typeof(p_contexts) is distinct from 'array' or octet_length(p_contexts::text)>1000000
 then raise exception 'catalogue context request refused' using errcode='22023';end if;
 n:=jsonb_array_length(p_contexts);
 if n not between 1 and 1000 or not controller_security.catalogue127_authority(p_authority_tenant_id,p_published_by,true)
 then raise exception 'catalogue context authority refused' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_publication_version,127));
 packet:=jsonb_build_object('publicationVersion',p_publication_version,'libraryVersion',p_library_version,'contexts',p_contexts)::text;
 hash:=encode(sha256(convert_to(packet,'UTF8')),'hex');
 if controller_security.prativedan123_json(p_request_text,1048576)<>packet::jsonb then raise exception 'catalogue reviewed source refused';end if;
 select * into existing from public.mapping_context_publications where publication_version=p_publication_version;
 if found then
  select * into strict h from public.mapping_context_publication_provenance where publication_version=p_publication_version;
  if existing.packet_text<>packet or h.authority_tenant_id<>p_authority_tenant_id or h.published_by<>p_published_by
   or h.correlation_id<>p_correlation_id or h.session_id<>p_session_id or h.request_text<>p_request_text
  then raise exception 'catalogue context publication conflict';end if;
  return controller_security.catalogue127_proof(p_publication_version);
 end if;
 -- Validate all source contexts before the first append or insert. No global mapping lookup.
 for item in select value from jsonb_array_elements(p_contexts) loop
  if jsonb_typeof(item) is distinct from 'object' or (select count(*) from jsonb_object_keys(item))<>7
   or not(item ?& array['sectorPackCode','frameworkCode','ref','controlId','mappingStrength','provenance','note'])
   or exists(select 1 from jsonb_each(item) e where jsonb_typeof(e.value)<>'string')
   or length(item->>'sectorPackCode') not between 1 and 64 or length(item->>'frameworkCode') not between 1 and 64
   or length(item->>'ref') not between 1 and 300 or length(item->>'controlId') not between 1 and 100
   or length(item->>'note') not between 1 and 2000
   or item->>'mappingStrength' not in ('equivalent','partial','indicative') or item->>'provenance' not in ('reference','mapped')
   or (item->>'mappingStrength'='equivalent' and item->>'provenance'='reference')
  then raise exception 'catalogue context shape refused';end if;
  select * into pack from public.sector_packs where code=item->>'sectorPackCode' for share;
  if not found or pack.library_version<>p_library_version or not(item->>'controlId'=any(pack.control_ids))
   or not(item->>'frameworkCode'=any(pack.framework_codes))
   or not exists(select 1 from public.controls where id=item->>'controlId' and library_version=p_library_version)
  then raise exception 'catalogue context references refused';end if;
  select c.id into fc from public.framework_controls c join public.frameworks f on f.id=c.framework_id
   where f.code=item->>'frameworkCode' and c.ref=item->>'ref' for share of c,f;
  if fc is null then raise exception 'catalogue context references refused';end if;
 end loop;
 if (select count(*) from (select distinct x->>'sectorPackCode',x->>'frameworkCode',x->>'ref',x->>'controlId' from jsonb_array_elements(p_contexts)x)s)<>n
 then raise exception 'catalogue context duplicate refused';end if;
 insert into public.mapping_context_publications(publication_version,library_version,packet_text,packet_sha256,context_count)
 values(p_publication_version,p_library_version,packet,hash,n);
 insert into public.mapping_context_publication_provenance(publication_version,authority_tenant_id,published_by,correlation_id,session_id,request_text,request_sha256)
 values(p_publication_version,p_authority_tenant_id,p_published_by,p_correlation_id,p_session_id,p_request_text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'));
 for item in select value from jsonb_array_elements(p_contexts) loop
  i:=i+1;
  insert into public.mapping_contexts(publication_version,library_version,ordinal,sector_pack_id,framework_control_id,control_id,mapping_strength,provenance,note)
  select p_publication_version,p_library_version,i,s.id,c.id,item->>'controlId',item->>'mappingStrength',item->>'provenance',item->>'note'
   from public.sector_packs s join public.frameworks f on f.code=item->>'frameworkCode'
   join public.framework_controls c on c.framework_id=f.id and c.ref=item->>'ref' where s.code=item->>'sectorPackCode';
 end loop;
 return controller_security.catalogue127_proof(p_publication_version);
end $$;
create function public.read_mapping_context_publication_proof(p_publication_version text,p_authority_tenant_id uuid,p_published_by uuid,p_correlation_id uuid,p_session_id uuid,p_request_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not controller_security.catalogue127_authority(p_authority_tenant_id,p_published_by,true) or not exists(
  select 1 from public.mapping_context_publication_provenance where publication_version=p_publication_version
   and authority_tenant_id=p_authority_tenant_id and published_by=p_published_by and correlation_id=p_correlation_id
   and session_id=p_session_id and request_text=p_request_text)
 then raise exception 'catalogue context proof refused' using errcode='42501';end if;
 return controller_security.catalogue127_proof(p_publication_version);
end $$;
create function controller_security.catalogue127_adoption_proof(t uuid,k uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.mapping_context_adoptions;p public.mapping_context_publications;s public.sector_packs;l public.audit_ledger;
begin
 if not controller_security.catalogue127_adoption_valid(t,k) then raise exception 'catalogue adoption proof unavailable';end if;
 select * into strict a from public.mapping_context_adoptions where tenant_id=t and operation_key=k;
 select * into strict p from public.mapping_context_publications where publication_version=a.publication_version;
 select * into strict s from public.sector_packs where id=a.sector_pack_id;
 select * into strict l from public.audit_ledger where id=a.receipt_id;
 return jsonb_build_object('organisationId',a.tenant_id,'actorId',a.actor_id,'sessionId',a.session_id,'correlationId',a.correlation_id,
 'operationKey',a.operation_key,'publicationVersion',a.publication_version,'libraryVersion',p.library_version,'sectorPackCode',s.code,
 'packetSha256',p.packet_sha256,'requestText',a.request_text,'requestSha256',a.request_sha256,
 'receipt',jsonb_build_object('id',l.id::text,'entry_hash',l.entry_hash));
end $$;
create function public.adopt_mapping_context_publication(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_correlation_id uuid,p_request_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req jsonb;k uuid;p public.mapping_context_publications;s public.sector_packs;a public.mapping_context_adoptions;rh text;receipt bigint;
begin
 if not controller_security.catalogue127_authority(p_tenant_id,p_actor_id)
 or p_session_id is null or p_session_id='00000000-0000-0000-0000-000000000000'::uuid
 or p_correlation_id is null or p_correlation_id='00000000-0000-0000-0000-000000000000'::uuid
 then raise exception 'catalogue adoption authority refused' using errcode='42501';end if;
 req:=controller_security.prativedan123_json(p_request_text,4096);
 if jsonb_typeof(req)<>'object' or (select count(*) from jsonb_object_keys(req))<>4
 or not(req ?& array['operationKey','publicationVersion','expectedPacketSha256','sectorPackCode'])
 or exists(select 1 from jsonb_each(req)e where jsonb_typeof(e.value)<>'string')
 or req->>'operationKey' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or req->>'operationKey'='00000000-0000-0000-0000-000000000000'
 or req->>'publicationVersion' !~ '^[a-z0-9][a-z0-9.-]{2,79}$'
 or req->>'expectedPacketSha256' !~ '^[0-9a-f]{64}$' or length(req->>'sectorPackCode') not between 1 and 64
 then raise exception 'catalogue adoption request refused';end if;
 k:=(req->>'operationKey')::uuid;rh:=encode(sha256(convert_to(p_request_text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||k::text,127));
 select * into p from public.mapping_context_publications where publication_version=req->>'publicationVersion' for share;
 if not found or p.packet_sha256<>req->>'expectedPacketSha256' or not controller_security.catalogue127_valid(p.publication_version)
 then raise exception 'catalogue adoption source refused';end if;
 select * into s from public.sector_packs where code=req->>'sectorPackCode' for share;
 if not found or s.library_version<>p.library_version or not exists(select 1 from public.mapping_contexts where publication_version=p.publication_version and sector_pack_id=s.id)
 then raise exception 'catalogue adoption sector refused';end if;
 select * into a from public.mapping_context_adoptions where tenant_id=p_tenant_id and operation_key=k;
 if found then
  if a.actor_id<>p_actor_id or a.session_id<>p_session_id or a.correlation_id<>p_correlation_id or a.request_text<>p_request_text
  then raise exception 'catalogue adoption conflict';end if;
  return controller_security.catalogue127_adoption_proof(p_tenant_id,k);
 end if;
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
 'catalogue.mapping_contexts_adopted',k::text,rh,p.packet_sha256,null,null,null,null,'success',
 jsonb_build_object('operationKey',k,'publicationVersion',p.publication_version,'libraryVersion',p.library_version,
 'sectorPackCode',s.code,'packetSha256',p.packet_sha256,'requestSha256',rh,'sessionId',p_session_id));
 insert into public.mapping_context_adoptions(tenant_id,operation_key,publication_version,sector_pack_id,actor_id,session_id,correlation_id,request_text,request_sha256,receipt_id)
 values(p_tenant_id,k,p.publication_version,s.id,p_actor_id,p_session_id,p_correlation_id,p_request_text,rh,receipt);
 return controller_security.catalogue127_adoption_proof(p_tenant_id,k);
end $$;
create function public.read_mapping_context_adoption_proof(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_correlation_id uuid,p_request_text text,p_operation_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not controller_security.catalogue127_authority(p_tenant_id,p_actor_id) or not exists(select 1 from public.mapping_context_adoptions
 where tenant_id=p_tenant_id and operation_key=p_operation_key and actor_id=p_actor_id and session_id=p_session_id
 and correlation_id=p_correlation_id and request_text=p_request_text)
 then raise exception 'catalogue adoption proof refused' using errcode='42501';end if;
 return controller_security.catalogue127_adoption_proof(p_tenant_id,p_operation_key);
end $$;
-- Global reference projection excludes provenance, memberships, sessions and adoptions.
create function public.read_mapping_context_publication(p_publication_version text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not controller_security.catalogue127_valid(p_publication_version) then raise exception 'catalogue context unavailable';end if;
 return (select jsonb_build_object('publicationVersion',publication_version,'libraryVersion',library_version,'contextCount',context_count,'packetText',packet_text,'packetSha256',packet_sha256) from public.mapping_context_publications where publication_version=p_publication_version);
end $$;
-- Remove all inherited default grants on only the new objects; no role memberships.
do $$declare r record;f record;begin
 for r in select rolname from pg_catalog.pg_roles where rolname<>current_user loop
  execute format('revoke all on public.mapping_context_publications,public.mapping_context_publication_provenance,public.mapping_contexts,public.mapping_context_adoptions from %I',r.rolname);
  for f in select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='controller_security' and p.proname like 'catalogue127_%') or (n.nspname='public' and p.proname in
   ('publish_mapping_context_publication','read_mapping_context_publication_proof','read_mapping_context_publication','adopt_mapping_context_publication','read_mapping_context_adoption_proof')) loop
   execute format('revoke all on function %s from %I',f.signature,r.rolname);
  end loop;
 end loop;
end $$;
revoke all on public.mapping_context_publications,public.mapping_context_publication_provenance,public.mapping_contexts,public.mapping_context_adoptions from public;
do $$declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='controller_security' and p.proname like 'catalogue127_%') or (n.nspname='public' and p.proname in
 ('publish_mapping_context_publication','read_mapping_context_publication_proof','read_mapping_context_publication','adopt_mapping_context_publication','read_mapping_context_adoption_proof')) loop
 execute format('revoke all on function %s from public',f.signature);end loop;
end $$;
grant execute on function public.publish_mapping_context_publication(text,text,jsonb,uuid,uuid,uuid,uuid,text),
 public.read_mapping_context_publication_proof(text,uuid,uuid,uuid,uuid,text),
 public.adopt_mapping_context_publication(uuid,uuid,uuid,uuid,text),public.read_mapping_context_adoption_proof(uuid,uuid,uuid,uuid,text,uuid)
 to axiom_catalogue_publisher;
grant execute on function public.read_mapping_context_publication(text) to authenticated,service_role;
