-- Unmounted public website asset-association core. Metadata never verifies
-- ownership, creates connector credentials or authorizes an agent operation.
alter type public.ledger_action_type add value if not exists 'connector.website.target_registered';
alter type public.ledger_action_type add value if not exists 'connector.website.asset_associated';
alter type public.ledger_action_type add value if not exists 'connector.website.asset_withdrawn';

create table public.public_website_asset_operations (
 id uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),
 operation_key uuid not null,kind text not null check(kind in ('register_target','associate_capture','capture','withdraw')),
 resource_id uuid not null,request_text text not null check(octet_length(request_text) between 2 and 16384),
 request_sha256 text not null check(request_sha256=encode(sha256(convert_to(request_text,'UTF8')),'hex')),
 snapshot_text text not null check(octet_length(snapshot_text) between 2 and 16384),
 snapshot_sha256 text not null check(snapshot_sha256=encode(sha256(convert_to(snapshot_text,'UTF8')),'hex')),
 receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,actor_id,operation_key),unique(tenant_id,receipt_id),
 foreign key(tenant_id,receipt_id) references public.audit_ledger(tenant_id,id)
);
create table public.public_website_targets (
 id uuid primary key,tenant_id uuid not null,estate_id uuid not null,system_id uuid not null,
 estate_version integer not null check(estate_version>0),system_version integer not null check(system_version>0),
 target_version integer not null check(target_version>0),url text not null,
 snapshot_text text not null,snapshot_sha256 text not null check(snapshot_sha256=encode(sha256(convert_to(snapshot_text,'UTF8')),'hex')),
 operation_id uuid not null,unique(tenant_id,id),unique(tenant_id,operation_id),
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id),
 foreign key(tenant_id,system_id) references public.estate_systems(tenant_id,id),
 foreign key(tenant_id,operation_id) references public.public_website_asset_operations(tenant_id,id) deferrable initially deferred
);
create table public.public_website_asset_associations (
 id uuid primary key,tenant_id uuid not null,target_id uuid not null,check_id uuid not null,
 target_sha256 text not null,payload_sha256 text not null,capture_receipt bigint not null,
 snapshot_text text not null,snapshot_sha256 text not null check(snapshot_sha256=encode(sha256(convert_to(snapshot_text,'UTF8')),'hex')),
 operation_id uuid not null,unique(tenant_id,id),unique(tenant_id,operation_id),
 foreign key(tenant_id,target_id) references public.public_website_targets(tenant_id,id),
 foreign key(tenant_id,check_id) references public.public_website_checks(tenant_id,id),
 foreign key(tenant_id,capture_receipt) references public.audit_ledger(tenant_id,id),
 foreign key(tenant_id,operation_id) references public.public_website_asset_operations(tenant_id,id) deferrable initially deferred
);
-- No direct table access, including service-role writes. Only narrow functions.
revoke all on public.public_website_asset_operations,public.public_website_targets,public.public_website_asset_associations from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;
alter table public.public_website_asset_operations enable row level security;
alter table public.public_website_targets enable row level security;
alter table public.public_website_asset_associations enable row level security;
create trigger website_asset_operation_immutable before update or delete on public.public_website_asset_operations for each row execute function public.evidence_receipt_immutable();
create trigger website_asset_operation_no_truncate before truncate on public.public_website_asset_operations for each statement execute function public.evidence_receipt_immutable();
create trigger website_target_immutable before update or delete on public.public_website_targets for each row execute function public.evidence_receipt_immutable();
create trigger website_target_no_truncate before truncate on public.public_website_targets for each statement execute function public.evidence_receipt_immutable();
create trigger website_asset_association_immutable before update or delete on public.public_website_asset_associations for each row execute function public.evidence_receipt_immutable();
create trigger website_asset_association_no_truncate before truncate on public.public_website_asset_associations for each statement execute function public.evidence_receipt_immutable();

create function controller_security.website_asset139_allowed(t uuid,a uuid,w boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.user_role;i boolean;
begin
 select role into r from public.tenant_users where tenant_id=t and user_id=a for share;
 select is_axiom_internal into i from public.users where id=a for share;
 return coalesce(r is not null and r<>'agent' and i is not null and (r not in ('founder','axiom_analyst') or i is true)
  and (not w or r in ('founder','owner','admin')),false);
end $$;
create function controller_security.website_asset139_request(s text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare r jsonb;fields text[];v text;
begin
 if s is null or octet_length(s) not between 2 and 16384 then raise exception 'asset request refused' using errcode='22023';end if;
 r:=s::jsonb;
 fields:=case r->>'kind'
  when 'register_target' then array['version','kind','operationKey','confirmed','estateId','systemId','expectedEstateVersion','expectedSystemVersion','url']
  when 'associate_capture' then array['version','kind','operationKey','confirmed','targetId','expectedTargetSha256','checkId','expectedPayloadSha256','expectedCaptureReceipt']
  when 'capture' then array['version','kind','operationKey','confirmed','targetId','expectedTargetSha256']
  when 'withdraw' then array['version','kind','operationKey','confirmed','subjectType','subjectId','expectedSubjectSha256','reason'] else null end;
 if fields is null or jsonb_typeof(r)<>'object' or not(r?&fields) or r-fields<>'{}'::jsonb
  or r->'version' is distinct from '1'::jsonb or r->>'version' is distinct from '1' or r->'confirmed' is distinct from 'true'::jsonb
  or controller_security.canonical_questionnaire_json(r) is distinct from s
 then raise exception 'asset request refused' using errcode='22023';end if;
 foreach v in array array['operationKey','estateId','systemId','targetId','checkId','subjectId'] loop
  if r?v and (jsonb_typeof(r->v)<>'string' or r->>v !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') then raise exception 'asset identifier refused' using errcode='22023';end if;
 end loop;
 foreach v in array array['expectedTargetSha256','expectedPayloadSha256','expectedSubjectSha256'] loop
  if r?v and (jsonb_typeof(r->v)<>'string' or r->>v !~ '^[a-f0-9]{64}$') then raise exception 'asset digest refused' using errcode='22023';end if;
 end loop;
 if r->>'kind'='register_target' then
  if jsonb_typeof(r->'url')<>'string' or length(r->>'url')>2048 or octet_length(r->>'url')<>length(r->>'url')
   or r->>'url' !~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/[^?#[:space:]]*$'
   or r->>'url' ~ $urlbad$[\\"<>`{}[:cntrl:]]$urlbad$
   or r->>'url' ~ '^https://([^/]*\.)?(localhost|local|internal|test|invalid|example|onion)/'
   or r->>'url' ~ '(^|/)(\.|%2[eE]){1,2}(/|$)'
   or jsonb_typeof(r->'expectedEstateVersion')<>'number' or r->>'expectedEstateVersion' !~ '^[1-9][0-9]{0,8}$'
   or jsonb_typeof(r->'expectedSystemVersion')<>'number' or r->>'expectedSystemVersion' !~ '^[1-9][0-9]{0,8}$'
  then raise exception 'asset target refused' using errcode='22023';end if;
 elsif r->>'kind'='associate_capture' then
  if jsonb_typeof(r->'expectedCaptureReceipt')<>'string' or r->>'expectedCaptureReceipt' !~ '^[1-9][0-9]{0,18}$'
   or (r->>'expectedCaptureReceipt')::numeric>9223372036854775807 then raise exception 'asset receipt refused' using errcode='22023';end if;
 elsif r->>'kind'='withdraw' then
  if r->>'subjectType' not in ('target','association') or jsonb_typeof(r->'subjectType')<>'string'
   or jsonb_typeof(r->'reason')<>'string' or length(r->>'reason') not between 1 and 2000 or r->>'reason' !~ '[^[:space:]]'
  then raise exception 'asset withdrawal refused' using errcode='22023';end if;
 end if;
 return r;
end $$;
create function controller_security.website_asset139_withdrawn(t uuid,k text,s uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.public_website_asset_operations o where tenant_id=t and kind='withdraw' and o.snapshot_text::jsonb->>'subjectType'=k and o.snapshot_text::jsonb->>'subjectId'=s::text)
$$;
create function controller_security.website_asset139_result(o public.public_website_asset_operations,replayed boolean) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state','recorded','tenantId',o.tenant_id,'actorId',o.actor_id,'operationKey',o.operation_key,'kind',o.kind,
 'requestCodec','axiom-public-website-asset-request-canonical-json-1','requestText',o.request_text,'requestSha256',o.request_sha256,
 'snapshotCodec','axiom-public-website-asset-snapshot-canonical-json-1','snapshotText',o.snapshot_text,'snapshotSha256',o.snapshot_sha256,
 'receipt',jsonb_build_object('id',o.receipt_id::text,'entryHash',l.entry_hash),'replayed',replayed)
 from public.audit_ledger l where l.tenant_id=o.tenant_id and l.id=o.receipt_id
$$;

-- Reciprocal immutable receipt checks prevent naked generic-human ledger forgeries.
create function controller_security.website_asset139_binding() returns trigger
language plpgsql security definer set search_path='' as $$
declare o public.public_website_asset_operations;l public.audit_ledger;t public.public_website_targets;a public.public_website_asset_associations;r jsonb;s jsonb;action text;
begin
 if tg_table_name='audit_ledger' then
  if new.action_type::text not in ('connector.website.target_registered','connector.website.asset_associated','connector.website.asset_withdrawn') then return null;end if;
  select * into o from public.public_website_asset_operations where tenant_id=new.tenant_id and receipt_id=new.id;l:=new;
 elsif tg_table_name='public_website_asset_operations' then o:=new;select * into l from public.audit_ledger where tenant_id=o.tenant_id and id=o.receipt_id;
 else select * into o from public.public_website_asset_operations where tenant_id=new.tenant_id and id=new.operation_id;select * into l from public.audit_ledger where tenant_id=o.tenant_id and id=o.receipt_id;end if;
 if o.id is null or l.id is null then raise exception 'asset receipt missing' using errcode='23514';end if;
 r:=controller_security.website_asset139_request(o.request_text);s:=o.snapshot_text::jsonb;
 action:=case o.kind when 'register_target' then 'connector.website.target_registered' when 'withdraw' then 'connector.website.asset_withdrawn' else 'connector.website.asset_associated' end;
 if o.kind is distinct from r->>'kind' or o.operation_key::text is distinct from r->>'operationKey'
  or o.snapshot_text is distinct from controller_security.canonical_questionnaire_json(s)
  or s->'version' is distinct from '1'::jsonb or s->>'version' is distinct from '1' or s->>'id' is distinct from o.resource_id::text
  or s->>'tenantId' is distinct from o.tenant_id::text or s->>'actorId' is distinct from o.actor_id::text
  or s->'ownershipVerified' is distinct from 'false'::jsonb or s->'connectorAccessGranted' is distinct from 'false'::jsonb
  or l.action_type::text is distinct from action or l.actor_type::text is distinct from 'human' or l.actor_id is distinct from o.actor_id::text
  or l.correlation_id is distinct from o.operation_key or l.target_ref is distinct from o.resource_id::text
  or l.input_hash is distinct from o.request_sha256 or l.output_hash is distinct from o.snapshot_sha256 or l.result::text is distinct from 'success'
  or l.detail is distinct from jsonb_build_object('operation_id',o.id,'operation_key',o.operation_key,'kind',o.kind)
 then raise exception 'asset receipt binding refused' using errcode='23514';end if;
 if o.kind='register_target' then
  select * into t from public.public_website_targets where tenant_id=o.tenant_id and id=o.resource_id;
  if t.id is null or t.operation_id<>o.id or t.snapshot_text<>o.snapshot_text or t.snapshot_sha256<>o.snapshot_sha256
   or s->>'kind' is distinct from 'target'
   or s-array['version','id','tenantId','actorId','ownershipVerified','connectorAccessGranted','kind','estateId','systemId','estateVersion','systemVersion','targetVersion','estateName','systemName','url']<>'{}'::jsonb
   or s->>'estateId' is distinct from t.estate_id::text or s->>'systemId' is distinct from t.system_id::text
   or s->'estateVersion' is distinct from to_jsonb(t.estate_version) or s->'systemVersion' is distinct from to_jsonb(t.system_version)
   or s->'targetVersion' is distinct from to_jsonb(t.target_version) or s->>'url' is distinct from t.url
   or jsonb_typeof(s->'estateName') is distinct from 'string' or length(s->>'estateName') not between 1 and 200
   or jsonb_typeof(s->'systemName') is distinct from 'string' or length(s->>'systemName') not between 1 and 200
   or t.estate_id::text is distinct from r->>'estateId' or t.system_id::text is distinct from r->>'systemId'
   or t.url is distinct from r->>'url' or t.estate_version is distinct from (r->>'expectedEstateVersion')::integer or t.system_version is distinct from (r->>'expectedSystemVersion')::integer
  then raise exception 'target receipt refused' using errcode='23514';end if;
 elsif o.kind in ('associate_capture','capture') then
  select * into a from public.public_website_asset_associations where tenant_id=o.tenant_id and id=o.resource_id;
  if a.id is null or a.operation_id<>o.id or a.snapshot_text<>o.snapshot_text or a.snapshot_sha256<>o.snapshot_sha256 or s->>'kind' is distinct from 'association'
   or s-array['version','id','tenantId','actorId','ownershipVerified','connectorAccessGranted','kind','targetId','targetSha256','checkId','payloadSha256','captureReceipt','requestedUrl','finalUrl','checkedAt']<>'{}'::jsonb
   or s->>'targetId' is distinct from a.target_id::text or s->>'targetSha256' is distinct from a.target_sha256
   or s->>'checkId' is distinct from a.check_id::text or s->>'payloadSha256' is distinct from a.payload_sha256
   or s->'captureReceipt' is distinct from (select jsonb_build_object('id',q.id::text,'entryHash',q.entry_hash) from public.audit_ledger q where q.tenant_id=a.tenant_id and q.id=a.capture_receipt)
   or a.target_sha256 is distinct from (select x.snapshot_sha256 from public.public_website_targets x where x.tenant_id=a.tenant_id and x.id=a.target_id)
   or not exists(select 1 from public.public_website_checks c join public.public_website_control_evidence p on (p.tenant_id,p.check_id)=(c.tenant_id,c.id)
    where c.tenant_id=a.tenant_id and c.id=a.check_id and p.payload_sha256=a.payload_sha256 and p.capture_receipt=a.capture_receipt
    and s->>'requestedUrl'=c.requested_url and s->>'finalUrl'=c.final_url
    and s->>'checkedAt'=to_char(c.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
   or a.target_id::text is distinct from r->>'targetId' or a.target_sha256 is distinct from r->>'expectedTargetSha256'
   or (o.kind='associate_capture' and (a.check_id::text is distinct from r->>'checkId' or a.payload_sha256 is distinct from r->>'expectedPayloadSha256' or a.capture_receipt::text is distinct from r->>'expectedCaptureReceipt'))
  then raise exception 'association receipt refused' using errcode='23514';end if;
 else
  if s->>'kind' is distinct from 'withdrawal' or s-array['version','id','tenantId','actorId','ownershipVerified','connectorAccessGranted','kind','subjectType','subjectId','subjectSha256','reason']<>'{}'::jsonb or s->>'subjectType' is distinct from r->>'subjectType' or s->>'subjectId' is distinct from r->>'subjectId'
   or s->>'subjectSha256' is distinct from r->>'expectedSubjectSha256' or s->>'reason' is distinct from r->>'reason'
  then raise exception 'withdrawal receipt refused' using errcode='23514';end if;
 end if;
 return null;
end $$;
create constraint trigger website_asset_ledger_binding after insert on public.audit_ledger deferrable initially deferred for each row execute function controller_security.website_asset139_binding();
create constraint trigger website_asset_operation_binding after insert on public.public_website_asset_operations deferrable initially deferred for each row execute function controller_security.website_asset139_binding();
create constraint trigger website_target_binding after insert on public.public_website_targets deferrable initially deferred for each row execute function controller_security.website_asset139_binding();
create constraint trigger website_association_binding after insert on public.public_website_asset_associations deferrable initially deferred for each row execute function controller_security.website_asset139_binding();

-- Tenant-local serialization orders immutable registration versions, withdrawal,
-- exact replay and association. Inventory locks retain estate-before-system order.
create function controller_security.website_asset139_current(t uuid,a uuid,target uuid,digest text) returns public.public_website_targets
language plpgsql security definer set search_path='' as $$
declare v public.public_website_targets;e public.estates;s public.estate_systems;
begin
 if not controller_security.website_asset139_allowed(t,a,true) then raise exception 'asset manager required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(139,hashtext(t::text));
 select * into v from public.public_website_targets where tenant_id=t and id=target;
 if v.id is null or v.snapshot_sha256 is distinct from digest or controller_security.website_asset139_withdrawn(t,'target',target)
 then raise exception 'current target required' using errcode='22023';end if;
 select * into e from public.estates where tenant_id=t and id=v.estate_id for update;
 select * into s from public.estate_systems where tenant_id=t and id=v.system_id for update;
 if e.id is null or s.id is null or s.estate_id is distinct from e.id or e.status<>'active' or s.status<>'active'
 or e.version is distinct from v.estate_version or s.version is distinct from v.system_version
 then raise exception 'target inventory changed' using errcode='22023';end if;
 return v;
end $$;
create function controller_security.website_asset139_write(t uuid,a uuid,request_text text,fresh_check uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;o public.public_website_asset_operations;v public.public_website_targets;
 e public.estates;s public.estate_systems;c public.public_website_checks;p public.public_website_control_evidence;
 l public.audit_ledger;snap jsonb;snap_text text;oid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();
 receipt bigint;subject_sha text;version_no integer;action public.ledger_action_type;
begin
 if not controller_security.website_asset139_allowed(t,a,true) then raise exception 'asset manager required' using errcode='42501';end if;
 r:=controller_security.website_asset139_request(request_text);
 perform pg_advisory_xact_lock(139,hashtext(t::text));
 select * into o from public.public_website_asset_operations where tenant_id=t and actor_id=a and operation_key=(r->>'operationKey')::uuid;
 if o.id is not null then
  if o.request_text is distinct from request_text then raise exception 'asset operation conflict' using errcode='23505';end if;
  return controller_security.website_asset139_result(o,true);
 end if;
 snap:=jsonb_build_object('version',1,'id',rid,'tenantId',t,'actorId',a,'ownershipVerified',false,'connectorAccessGranted',false);
 if r->>'kind'='register_target' then
  select * into e from public.estates where tenant_id=t and id=(r->>'estateId')::uuid for update;
  select * into s from public.estate_systems where tenant_id=t and id=(r->>'systemId')::uuid for update;
  if e.id is null or s.id is null or s.estate_id is distinct from e.id or e.status<>'active' or s.status<>'active'
   or e.version is distinct from (r->>'expectedEstateVersion')::integer or s.version is distinct from (r->>'expectedSystemVersion')::integer
  then raise exception 'current inventory required' using errcode='22023';end if;
  if exists(select 1 from public.public_website_targets x where tenant_id=t and system_id=s.id and url=r->>'url' and not controller_security.website_asset139_withdrawn(t,'target',x.id))
  then raise exception 'active target exists' using errcode='23505';end if;
  select coalesce(max(target_version),0)+1 into version_no from public.public_website_targets where tenant_id=t and system_id=s.id and url=r->>'url';
  snap:=snap||jsonb_build_object('kind','target','estateId',e.id,'systemId',s.id,'estateVersion',e.version,'systemVersion',s.version,
   'targetVersion',version_no,'estateName',e.name,'systemName',s.name,'url',r->>'url');
  action:='connector.website.target_registered';
 elsif r->>'kind' in ('associate_capture','capture') then
  v:=controller_security.website_asset139_current(t,a,(r->>'targetId')::uuid,r->>'expectedTargetSha256');
  if r->>'kind'='capture' and fresh_check is null then raise exception 'fresh capture required' using errcode='22023';end if;
  select * into c from public.public_website_checks where tenant_id=t and id=case when r->>'kind'='capture' then fresh_check else (r->>'checkId')::uuid end;
  select * into p from public.public_website_control_evidence where tenant_id=t and check_id=c.id;
  select * into l from public.audit_ledger where tenant_id=t and id=p.capture_receipt;
  if c.id is null or p.check_id is null or l.id is null or c.status<>'checked' or c.requested_url is distinct from v.url
   or p.payload_sha256 is distinct from encode(sha256(convert_to(p.payload_text,'UTF8')),'hex')
   or l.action_type::text is distinct from 'connector.website.evidence_captured' or l.target_ref is distinct from c.id::text
   or l.input_hash is distinct from p.payload_sha256 or l.output_hash is distinct from encode(sha256(convert_to(p.page_sources::text,'UTF8')),'hex')
   or (r->>'kind'='associate_capture' and (p.payload_sha256 is distinct from r->>'expectedPayloadSha256' or p.capture_receipt::text is distinct from r->>'expectedCaptureReceipt'))
  then raise exception 'retained capture differs or recapture required' using errcode='22023';end if;
  snap:=snap||jsonb_build_object('kind','association','targetId',v.id,'targetSha256',v.snapshot_sha256,'checkId',c.id,
   'payloadSha256',p.payload_sha256,'captureReceipt',jsonb_build_object('id',l.id::text,'entryHash',l.entry_hash),
   'requestedUrl',c.requested_url,'finalUrl',c.final_url,'checkedAt',to_char(c.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  action:='connector.website.asset_associated';
 else
  if r->>'subjectType'='target' then
   select snapshot_sha256 into subject_sha from public.public_website_targets where tenant_id=t and id=(r->>'subjectId')::uuid;
  else select snapshot_sha256 into subject_sha from public.public_website_asset_associations where tenant_id=t and id=(r->>'subjectId')::uuid;end if;
  if subject_sha is null or subject_sha is distinct from r->>'expectedSubjectSha256' or controller_security.website_asset139_withdrawn(t,r->>'subjectType',(r->>'subjectId')::uuid)
  then raise exception 'active subject required' using errcode='22023';end if;
  snap:=snap||jsonb_build_object('kind','withdrawal','subjectType',r->>'subjectType','subjectId',r->>'subjectId','subjectSha256',subject_sha,'reason',r->>'reason');
  action:='connector.website.asset_withdrawn';
 end if;
 snap_text:=controller_security.canonical_questionnaire_json(snap);
 -- The ledger deliberately carries IDs and hashes only. Neither URL nor reason
 -- nor immutable request/snapshot text is duplicated into ledger detail.
 receipt:=public.append_ledger(t,(r->>'operationKey')::uuid,'human'::public.actor_type,a::text,null,null,null,
  action,rid::text,encode(sha256(convert_to(request_text,'UTF8')),'hex'),encode(sha256(convert_to(snap_text,'UTF8')),'hex'),
  null,null,null,null,'success'::public.ledger_result,jsonb_build_object('operation_id',oid,'operation_key',r->>'operationKey','kind',r->>'kind'));
 insert into public.public_website_asset_operations(id,tenant_id,actor_id,operation_key,kind,resource_id,request_text,request_sha256,snapshot_text,snapshot_sha256,receipt_id)
 values(oid,t,a,(r->>'operationKey')::uuid,r->>'kind',rid,request_text,encode(sha256(convert_to(request_text,'UTF8')),'hex'),snap_text,encode(sha256(convert_to(snap_text,'UTF8')),'hex'),receipt) returning * into o;
 if r->>'kind'='register_target' then
  insert into public.public_website_targets values(rid,t,e.id,s.id,e.version,s.version,version_no,r->>'url',snap_text,o.snapshot_sha256,oid);
 elsif r->>'kind' in ('associate_capture','capture') then
  insert into public.public_website_asset_associations values(rid,t,v.id,c.id,v.snapshot_sha256,p.payload_sha256,p.capture_receipt,snap_text,o.snapshot_sha256,oid);
 end if;
 return controller_security.website_asset139_result(o,false);
end $$;
create function public.record_public_website_asset_operation(p_tenant_id uuid,p_actor_id uuid,p_request_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if controller_security.website_asset139_request(p_request_text)->>'kind'='capture' then raise exception 'fresh capture required' using errcode='22023';end if;
 return controller_security.website_asset139_write(p_tenant_id,p_actor_id,p_request_text);
end $$;
create function public.read_public_website_asset_operation(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.public_website_asset_operations;
begin
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,false) then raise exception 'tenant reader required' using errcode='42501';end if;
 select * into o from public.public_website_asset_operations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=p_operation_key;
 if o.id is null then return jsonb_build_object('state','not_found');end if;
 return controller_security.website_asset139_result(o,true);
end $$;
create function public.read_public_website_target_for_capture(p_tenant_id uuid,p_actor_id uuid,p_target_id uuid,p_target_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v public.public_website_targets;
begin
 v:=controller_security.website_asset139_current(p_tenant_id,p_actor_id,p_target_id,p_target_sha256);
 return jsonb_build_object('snapshotText',v.snapshot_text,'snapshotSha256',v.snapshot_sha256);
end $$;
create function public.record_targeted_public_website_capture(p_tenant_id uuid,p_actor_id uuid,p_request_text text,
 p_final_url text,p_result jsonb,p_codec text,p_payload_text text,p_payload_sha256 text,p_page_sources jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;v public.public_website_targets;o public.public_website_asset_operations;saved jsonb;
begin
 if current_setting('role',true) is distinct from 'human_action_writer' then raise exception 'human writer required' using errcode='42501';end if;
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,true) then raise exception 'asset manager required' using errcode='42501';end if;
 r:=controller_security.website_asset139_request(p_request_text);
 if r->>'kind'<>'capture' then raise exception 'capture intent required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(139,hashtext(p_tenant_id::text));
 select * into o from public.public_website_asset_operations where tenant_id=p_tenant_id and actor_id=p_actor_id and operation_key=(r->>'operationKey')::uuid;
 if o.id is not null then
  if o.request_text is distinct from p_request_text then raise exception 'asset operation conflict' using errcode='23505';end if;
  return controller_security.website_asset139_result(o,true);
 end if;
 v:=controller_security.website_asset139_current(p_tenant_id,p_actor_id,(r->>'targetId')::uuid,r->>'expectedTargetSha256');
 saved:=public.record_public_website_control_capture(p_tenant_id,p_actor_id,(r->>'operationKey')::uuid,v.url,p_final_url,p_result,p_codec,p_payload_text,p_payload_sha256,p_page_sources);
 return controller_security.website_asset139_write(p_tenant_id,p_actor_id,p_request_text,(saved->>'id')::uuid);
end $$;

-- Bounded explicit paging, with historical immutable rows qualified by current
-- withdrawal and inventory state rather than silently deleting old provenance.
create function public.list_public_website_assets(p_tenant_id uuid,p_actor_id uuid,p_after uuid default null,p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not controller_security.website_asset139_allowed(p_tenant_id,p_actor_id,false) then raise exception 'tenant reader required' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'asset page refused' using errcode='22023';end if;
 return coalesce((select jsonb_agg(v order by v->>'id') from (
 select jsonb_build_object('id',x.id,'snapshotText',x.snapshot_text,'snapshotSha256',x.snapshot_sha256,
 'withdrawn',controller_security.website_asset139_withdrawn(p_tenant_id,'target',x.id),
 'inventoryCurrent',e.status='active' and s.status='active' and s.estate_id=e.id and e.version=x.estate_version and s.version=x.system_version) v
 from public.public_website_targets x join public.estates e on (e.tenant_id,e.id)=(x.tenant_id,x.estate_id)
 join public.estate_systems s on (s.tenant_id,s.id)=(x.tenant_id,x.system_id)
 where x.tenant_id=p_tenant_id and (p_after is null or x.id>p_after) order by x.id limit p_limit) q),'[]'::jsonb);
end $$;

-- Chain the current wrapper instead of copying a historical human-action list.
alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0139;
revoke all on function controller_security.append_agent_ledger_before_0139(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,
 p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,
 p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text in ('connector.website.target_registered','connector.website.asset_associated','connector.website.asset_withdrawn')
 then raise exception 'dedicated human asset receipt required' using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0139(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,
 p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,
 p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

revoke all on function controller_security.website_asset139_allowed(uuid,uuid,boolean),
 controller_security.website_asset139_request(text),controller_security.website_asset139_withdrawn(uuid,text,uuid),
 controller_security.website_asset139_result(public.public_website_asset_operations,boolean),controller_security.website_asset139_binding(),
 controller_security.website_asset139_current(uuid,uuid,uuid,text),controller_security.website_asset139_write(uuid,uuid,text,uuid)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
revoke all on function public.record_public_website_asset_operation(uuid,uuid,text),
 public.record_targeted_public_website_capture(uuid,uuid,text,text,jsonb,text,text,text,jsonb),
 public.read_public_website_asset_operation(uuid,uuid,uuid),public.read_public_website_target_for_capture(uuid,uuid,uuid,text),
 public.list_public_website_assets(uuid,uuid,uuid,integer)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.record_public_website_asset_operation(uuid,uuid,text),
 public.record_targeted_public_website_capture(uuid,uuid,text,text,jsonb,text,text,text,jsonb) to human_action_writer;
grant execute on function public.read_public_website_asset_operation(uuid,uuid,uuid),
 public.read_public_website_target_for_capture(uuid,uuid,uuid,text),public.list_public_website_assets(uuid,uuid,uuid,integer) to service_role,human_action_writer;
