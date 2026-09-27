-- Exact-byte pack preparation, immutable review and retained archive release.
-- Legacy report rows receive no invented review digest or provider assurance.
alter type public.ledger_action_type add value if not exists 'evidence.pack.prepared';
alter type public.ledger_action_type add value if not exists 'evidence.pack.build.started';
alter type public.ledger_action_type add value if not exists 'evidence.pack.build.pending';
alter type public.ledger_action_type add value if not exists 'evidence.pack.build.settled';

alter table public.reports add column operation_key uuid,
 add column created_by uuid references public.users(id) on delete restrict,
 add column content_text text,
 add column content_sha256 text check(content_sha256 ~ '^[0-9a-f]{64}$'),
 add column reviewed_content_hash text check(reviewed_content_hash ~ '^[0-9a-f]{64}$'),
 add column released_by uuid references public.users(id) on delete restrict,
 add column released_archive_hash text check(released_archive_hash ~ '^[0-9a-f]{64}$'),
 add constraint reports_tenant_identity unique(tenant_id,id),
 add constraint reports_operation_identity unique(tenant_id,operation_key),
 add constraint reports_exact_content check((content_text is null and content_sha256 is null) or
  (content_text is not null and content_sha256=encode(sha256(convert_to(content_text,'UTF8')),'hex')));
alter table public.reports alter column storage_uri drop not null;
alter table public.reports drop constraint reports_tenant_id_fkey;
alter table public.reports add constraint reports_tenant_id_fkey foreign key(tenant_id) references public.tenants(id) on delete restrict;
alter table public.reports drop constraint reports_engagement_id_fkey;
alter table public.reports add constraint reports_engagement_tenant_fk foreign key(tenant_id,engagement_id)
 references public.engagements(tenant_id,id) on delete restrict not valid;
revoke insert,update,delete,truncate on public.reports from public,anon,authenticated,service_role;

create table public.evidence_packs (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete restrict,
 report_id uuid not null unique,operation_key uuid not null,created_by uuid not null references public.users(id) on delete restrict,
 created_at timestamptz not null,engagement_id uuid,library_version text not null references public.control_libraries(version) on delete restrict,
 title text not null,request jsonb not null,manifest_text text not null,
 manifest_sha256 text not null check(manifest_sha256=encode(sha256(convert_to(manifest_text,'UTF8')),'hex')),
 member_count integer not null check(member_count between 1 and 20),
 total_member_bytes bigint not null check(total_member_bytes between 1 and 50331648),
 unique(tenant_id,id),unique(tenant_id,operation_key),
 foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict,
 foreign key(tenant_id,engagement_id) references public.engagements(tenant_id,id) on delete restrict
);
create table public.evidence_pack_items (
 tenant_id uuid not null,pack_id uuid not null,evidence_id uuid not null,evidence_version_id uuid not null,
 ordinal integer not null check(ordinal between 1 and 20),archive_path text not null,
 primary key(pack_id,evidence_id),unique(pack_id,evidence_version_id),unique(pack_id,ordinal),unique(pack_id,archive_path),
 foreign key(tenant_id,pack_id) references public.evidence_packs(tenant_id,id) on delete restrict,
 foreign key(tenant_id,evidence_id) references public.evidence(tenant_id,id) on delete restrict,
 foreign key(tenant_id,evidence_version_id) references public.evidence_object_versions(tenant_id,id) on delete restrict
);
create table public.report_reviews (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,report_id uuid not null unique,
 decision text not null check(decision in ('approved','rejected')),content_sha256 text not null,
 reviewed_by uuid not null references public.users(id) on delete restrict,reviewer_name text not null check(btrim(reviewer_name)<>''),
 reviewed_at timestamptz not null,note text,review_text text not null,
 review_sha256 text not null check(review_sha256=encode(sha256(convert_to(review_text,'UTF8')),'hex')),
 unique(tenant_id,id),foreign key(tenant_id,report_id) references public.reports(tenant_id,id) on delete restrict
);
create table public.evidence_pack_builds (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,pack_id uuid not null unique,operation_key uuid not null,
 actor_id uuid not null references public.users(id) on delete restrict,status text not null default 'pending' check(status in ('pending','settled')),
 request jsonb not null,retain_until timestamptz not null,correlation_id uuid not null,last_error_code text,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),settled_at timestamptz,
 unique(tenant_id,id),unique(tenant_id,operation_key),
 foreign key(tenant_id,pack_id) references public.evidence_packs(tenant_id,id) on delete restrict,
 check((status='pending' and settled_at is null) or (status='settled' and settled_at is not null))
);
create table public.evidence_pack_archives (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,pack_id uuid not null unique,build_id uuid not null unique,
 provider text not null check(provider in ('s3','s3-compatible')),bucket text not null,object_key text not null,
 version_id text not null check(btrim(version_id)<>'' and version_id<>'null'),content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 byte_size bigint not null check(byte_size between 1 and 67108864),lock_mode text not null check(lock_mode='COMPLIANCE'),
 retain_until timestamptz not null,readback_at timestamptz not null,legal_hold boolean not null,
 encryption text not null check(encryption in ('AES256','aws:kms')),receipt jsonb not null,
 verified_by uuid not null references public.users(id) on delete restrict,created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(provider,bucket,object_key,version_id),
 foreign key(tenant_id,pack_id) references public.evidence_packs(tenant_id,id) on delete restrict,
 foreign key(tenant_id,build_id) references public.evidence_pack_builds(tenant_id,id) on delete restrict
);

create function public.report_founder_allowed(p_tenant_id uuid,p_actor_id uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role='founder' for share;
 if not found then return false; end if;
 perform 1 from public.users where id=p_actor_id and is_axiom_internal for share;
 return found;
end $$;
create function public.report_creator_allowed(p_tenant_id uuid,p_actor_id uuid,p_created_by uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return false; end if;
 return coalesce(p_created_by=p_actor_id,false) or public.report_founder_allowed(p_tenant_id,p_actor_id);
end $$;
create function public.report_visible(p_tenant_id uuid,p_created_by uuid,p_status text) returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id
  where m.tenant_id=p_tenant_id and m.user_id=auth.uid() and
   (p_status='published' or (m.role in ('founder','owner','admin') and p_created_by=u.id) or
    (m.role='founder' and u.is_axiom_internal)));
$$;
create function public.pack_visible(p_tenant_id uuid,p_pack_id uuid) returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.evidence_packs p join public.reports r on r.tenant_id=p.tenant_id and r.id=p.report_id
  where p.tenant_id=p_tenant_id and p.id=p_pack_id and public.report_visible(r.tenant_id,r.created_by,r.status));
$$;
do $$ declare r record;t text;begin
 for r in select policyname from pg_policies where schemaname='public' and tablename='reports' loop
  execute format('drop policy %I on public.reports',r.policyname);
 end loop;
 create policy report_scoped_read on public.reports for select to authenticated using(public.report_visible(tenant_id,created_by,status));
 create policy report_service_read on public.reports for select to service_role using(true);
 foreach t in array array['evidence_packs','evidence_pack_items','report_reviews','evidence_pack_builds','evidence_pack_archives'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create policy service_read on public.%I for select to service_role using(true)',t);
 end loop;
end $$;
create policy pack_member_read on public.evidence_packs for select to authenticated using(public.pack_visible(tenant_id,id));
create policy pack_item_member_read on public.evidence_pack_items for select to authenticated using(public.pack_visible(tenant_id,pack_id));
create policy pack_build_member_read on public.evidence_pack_builds for select to authenticated using(public.pack_visible(tenant_id,pack_id));
create policy pack_archive_member_read on public.evidence_pack_archives for select to authenticated using(public.pack_visible(tenant_id,pack_id));
create policy report_review_member_read on public.report_reviews for select to authenticated using(exists(
 select 1 from public.reports r where r.tenant_id=report_reviews.tenant_id and r.id=report_reviews.report_id));

create function public.report_content_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','approved_at','published_at',
  'rejected_by','rejected_at','rejection_reason','released_content_hash','reviewed_content_hash','released_by','released_archive_hash'])
  is distinct from (to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','approved_at','published_at',
  'rejected_by','rejected_at','rejection_reason','released_content_hash','reviewed_content_hash','released_by','released_archive_hash']) then
  raise exception 'report_content_immutable' using errcode='42501'; end if;
 if old.status in ('published','rejected','archived') then raise exception 'report_terminal' using errcode='42501'; end if;
 return new;
end $$;
create trigger report_content_immutable before update or delete on public.reports for each row execute function public.report_content_immutable();
do $$ declare t text; begin
 foreach t in array array['evidence_packs','evidence_pack_items','report_reviews','evidence_pack_archives'] loop
  execute format('create trigger retained_pack_immutable before update or delete on public.%I for each row execute function public.evidence_receipt_immutable()',t);
 end loop;
end $$;
create function public.pack_build_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.status='settled' or (to_jsonb(new)-array['status','last_error_code','updated_at','settled_at'])
  is distinct from (to_jsonb(old)-array['status','last_error_code','updated_at','settled_at']) then
  raise exception 'pack_build_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger pack_build_immutable before update or delete on public.evidence_pack_builds for each row execute function public.pack_build_immutable();

create function public.record_report_draft(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_kind text,p_title text,
 p_engagement_id uuid,p_library_version text,p_content_text text,p_generated_by_agent text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reports;v_content jsonb;v_hash text;v_library text;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_correlation_id is null or p_kind is null or p_kind not in ('board','auditor','dpb','technical','gap_scan','custom')
  or p_title is null or length(btrim(p_title)) not between 1 and 300 or p_content_text is null or octet_length(p_content_text)>1048576
  or p_generated_by_agent is null or length(btrim(p_generated_by_agent)) not between 1 and 80 then return jsonb_build_object('error','invalid_request'); end if;
 begin v_content:=p_content_text::jsonb; exception when invalid_text_representation then return jsonb_build_object('error','invalid_request'); end;
 if jsonb_typeof(v_content) is distinct from 'object' then return jsonb_build_object('error','invalid_request'); end if;
 v_hash:=encode(sha256(convert_to(p_content_text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 select * into r from public.reports where tenant_id=p_tenant_id and operation_key=p_operation_key for update;
 if found then
  if r.created_by is distinct from p_actor_id or r.kind::text is distinct from p_kind or r.title is distinct from btrim(p_title)
   or r.engagement_id is distinct from p_engagement_id or (p_library_version is not null and r.library_version<>p_library_version)
   or r.content_text is distinct from p_content_text or r.generated_by_agent is distinct from p_generated_by_agent then
   return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('reportId',r.id,'status',r.status,'contentHash',r.content_sha256,'replayed',true);
 end if;
 if p_engagement_id is not null then
  select library_version into v_library from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for share;
  if not found then return jsonb_build_object('error','engagement_not_found'); end if;
 else select version into v_library from public.control_libraries where is_current for share; end if;
 if v_library is null or (p_library_version is not null and p_library_version<>v_library) then return jsonb_build_object('error','library_version_mismatch'); end if;
 insert into public.reports(tenant_id,engagement_id,kind,title,storage_uri,content,library_version,generated_by_agent,
  operation_key,created_by,content_text,content_sha256)
 values(p_tenant_id,p_engagement_id,p_kind::public.report_kind,btrim(p_title),null,v_content,v_library,p_generated_by_agent,
  p_operation_key,p_actor_id,p_content_text,v_hash) returning * into r;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'report.generated',r.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('content_hash',v_hash,'kind',p_kind));
 return jsonb_build_object('reportId',r.id,'status','draft','contentHash',v_hash,'replayed',false);
end $$;

create function public.pack_text_ok(p_text text,p_max integer,p_nullable boolean default false) returns boolean
 language sql immutable set search_path='' as $$
 select case when p_text is null then p_nullable else length(p_text) between 1 and p_max
  and p_text !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' end;
$$;
revoke all on function public.pack_text_ok(text,integer,boolean) from public,anon,authenticated,service_role;

create function public.prepare_evidence_pack(p_tenant_id uuid,p_actor_id uuid,p_operation_key uuid,p_title text,
 p_engagement_id uuid,p_library_version text,p_evidence_version_ids uuid[],p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.evidence_packs;v_request jsonb;v_ids uuid[];v_library text;v_pack uuid:=gen_random_uuid();v_report uuid:=gen_random_uuid();
 v_created timestamptz:=clock_timestamp();v_members jsonb;v_manifest jsonb;v_text text;v_hash text;v_count integer;v_size bigint;v_status text;
begin
 if not public.evidence_manager_allowed(p_tenant_id,p_actor_id) then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_correlation_id is null or p_title is null or not public.pack_text_ok(btrim(p_title),200)
  or p_evidence_version_ids is null or cardinality(p_evidence_version_ids) not between 1 and 20
  or array_position(p_evidence_version_ids,null) is not null then return jsonb_build_object('error','invalid_request'); end if;
 select array_agg(distinct x order by x) into v_ids from unnest(p_evidence_version_ids) x;
 if cardinality(v_ids)<>cardinality(p_evidence_version_ids) then return jsonb_build_object('error','invalid_request'); end if;
 v_request:=jsonb_build_object('title',btrim(p_title),'engagement_id',p_engagement_id,'library_version',p_library_version,'evidence_version_ids',v_ids);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 select * into p from public.evidence_packs where tenant_id=p_tenant_id and operation_key=p_operation_key;
 if found then
  if p.created_by<>p_actor_id or p.request is distinct from v_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  select status into v_status from public.reports where tenant_id=p_tenant_id and id=p.report_id;
  return jsonb_build_object('pack_id',p.id,'report_id',p.report_id,'operation_key',p.operation_key,'status',v_status,
   'manifest_text',p.manifest_text,'manifest_sha256',p.manifest_sha256,'replayed',true);
 end if;
 if exists(select 1 from public.reports where tenant_id=p_tenant_id and operation_key=p_operation_key) then return jsonb_build_object('error','idempotency_conflict'); end if;
 if p_engagement_id is not null then
  select library_version into v_library from public.engagements where tenant_id=p_tenant_id and id=p_engagement_id for share;
  if not found then return jsonb_build_object('error','engagement_not_found'); end if;
 else select version into v_library from public.control_libraries where is_current for share; end if;
 if not public.pack_text_ok(v_library,200) or (p_library_version is not null and p_library_version<>v_library) then return jsonb_build_object('error','library_version_mismatch'); end if;
 -- Receipt/evidence rows are immutable under 0073. Row locks also serialize
 -- legacy owner maintenance while their authoritative metadata is captured.
 perform v.id from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id
  where v.tenant_id=p_tenant_id and v.id=any(v_ids) order by v.id for share of v,e;
 select count(*),sum(v.byte_size) into v_count,v_size from public.evidence_object_versions v where v.tenant_id=p_tenant_id and v.id=any(v_ids);
 if v_count<>cardinality(v_ids) then return jsonb_build_object('error','evidence_version_unavailable'); end if;
 if v_size>50331648 then return jsonb_build_object('error','invalid_request'); end if;
 if exists(select 1 from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id
  where v.tenant_id=p_tenant_id and v.id=any(v_ids) and (not public.pack_text_ok(e.filename,160,true) or not public.pack_text_ok(e.mime_type,200,true)
   or not public.pack_text_ok(e.description,2000,true) or not public.pack_text_ok(e.collected_by_agent,100)
   or not public.pack_text_ok(v.version_id,1024) or not isfinite(e.collected_at)
   or extract(year from e.collected_at) not between 1 and 9999
   or cardinality(e.demonstrates_control_ids)>40
   or exists(select 1 from unnest(e.demonstrates_control_ids) c where not public.pack_text_ok(c,100)))) then
  return jsonb_build_object('error','invalid_request'); end if;
 if exists(select 1 from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id
  where v.tenant_id=p_tenant_id and v.id=any(v_ids) and (e.content_hash<>v.content_hash or e.byte_size is distinct from v.byte_size)) then
  return jsonb_build_object('error','evidence_version_unavailable'); end if;
 if exists(select 1 from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id
  where v.tenant_id=p_tenant_id and v.id=any(v_ids) and e.engagement_id is not null and e.engagement_id is distinct from p_engagement_id) then
  return jsonb_build_object('error','engagement_mismatch'); end if;
 -- Until collector provenance is durably bound to its connector, unknown
 -- agent sources cannot safely enter auditor/DPB packs by default.
 if exists(select 1 from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id
  where v.tenant_id=p_tenant_id and v.id=any(v_ids) and e.collected_by_agent is distinct from 'human') then
  return jsonb_build_object('error','provenance_unavailable'); end if;
 if exists(select 1 from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id,
  unnest(e.demonstrates_control_ids) x where v.tenant_id=p_tenant_id and v.id=any(v_ids)
  and not exists(select 1 from public.controls c where c.id=x and c.library_version=v_library)) then
  return jsonb_build_object('error','control_not_found'); end if;
 select jsonb_agg(jsonb_build_object('evidence_id',e.id,'receipt_id',v.id,'version_id',v.version_id,
  'path','evidence/'||e.id::text||'.bin','content_hash',v.content_hash,'byte_size',v.byte_size,'filename',e.filename,
  'mime_type',e.mime_type,'description',e.description,'evidence_type',e.evidence_type,'collected_by_agent',e.collected_by_agent,
  'collected_at',to_char(e.collected_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'control_ids',coalesce((select jsonb_agg(x order by x collate "C") from (select distinct unnest(e.demonstrates_control_ids) x) q),'[]'::jsonb),
  'provenance','human_submitted') order by e.id) into v_members
 from public.evidence_object_versions v join public.evidence e on e.tenant_id=v.tenant_id and e.id=v.evidence_id
 where v.tenant_id=p_tenant_id and v.id=any(v_ids);
 v_manifest:=jsonb_build_object('schema_version',1,'serialization','postgres-jsonb-text-v1','kind','evidence_pack',
  'pack_id',v_pack,'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'title',btrim(p_title),
  'created_at',to_char(v_created at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'library_version',v_library,
  'branding',jsonb_build_object('product','Axiom Proof','company','Axiom Minds Private Limited','company_url','https://axiomminds.ai'),
  'generator',jsonb_build_object('name','evidence-pack-builder','version','1'),'members',v_members,
  'limitations',jsonb_build_array('Human-submitted evidence; its contents and collection provenance are human assertions.',
   'Exact-version storage verification is not a certification of compliance or production-system state.'));
 v_text:=v_manifest::text;
 if octet_length(v_text)>262144 then return jsonb_build_object('error','invalid_request'); end if;
 v_hash:=encode(sha256(convert_to(v_text,'UTF8')),'hex');
 insert into public.reports(id,tenant_id,engagement_id,kind,title,storage_uri,content,library_version,generated_by_agent,
  generated_at,operation_key,created_by,content_text,content_sha256)
 values(v_report,p_tenant_id,p_engagement_id,'evidence_pack',btrim(p_title),null,v_manifest,v_library,'evidence-pack-builder',
  v_created,p_operation_key,p_actor_id,v_text,v_hash);
 insert into public.evidence_packs(id,tenant_id,report_id,operation_key,created_by,created_at,engagement_id,library_version,title,
  request,manifest_text,manifest_sha256,member_count,total_member_bytes)
 values(v_pack,p_tenant_id,v_report,p_operation_key,p_actor_id,v_created,p_engagement_id,v_library,btrim(p_title),v_request,v_text,v_hash,v_count,v_size);
 insert into public.evidence_pack_items(tenant_id,pack_id,evidence_id,evidence_version_id,ordinal,archive_path)
 select p_tenant_id,v_pack,v.evidence_id,v.id,row_number() over(order by v.evidence_id),'evidence/'||v.evidence_id::text||'.bin'
 from public.evidence_object_versions v where v.tenant_id=p_tenant_id and v.id=any(v_ids);
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'evidence.pack.prepared',v_pack::text,
  null,null,null,null,null,null,'success',jsonb_build_object('report_id',v_report,'manifest_sha256',v_hash,'member_count',v_count));
 return jsonb_build_object('pack_id',v_pack,'report_id',v_report,'operation_key',p_operation_key,'status','draft',
  'manifest_text',v_text,'manifest_sha256',v_hash,'replayed',false);
end $$;

-- Remove old unbound entry points; every caller must supply reviewed digests.
drop function public.review_report(uuid,uuid,text,text,uuid,uuid);
drop function public.release_report(uuid,uuid,uuid,uuid);
create function public.review_report(p_tenant_id uuid,p_report_id uuid,p_decision text,p_note text,
 p_reviewed_by uuid,p_expected_content_hash text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reports;v_review public.report_reviews;v_name text;v_pack uuid;v_time timestamptz:=clock_timestamp();v_text text;
begin
 if not public.report_founder_allowed(p_tenant_id,p_reviewed_by) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_decision is null or p_decision not in ('approved','rejected') or length(coalesce(p_note,''))>2000
  or p_expected_content_hash is null or p_expected_content_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found then return jsonb_build_object('error','report_not_found'); end if;
 if r.content_text is null then return jsonb_build_object('error','legacy_report_requires_revision'); end if;
 if r.content_sha256<>p_expected_content_hash then return jsonb_build_object('error','manifest_changed'); end if;
 select * into v_review from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if found then
  if v_review.decision<>p_decision or v_review.reviewed_by<>p_reviewed_by or v_review.note is distinct from p_note then
   return jsonb_build_object('error','not_reviewable'); end if;
  return jsonb_build_object('reportId',r.id,'status',r.status,'contentHash',r.content_sha256,'reviewId',v_review.id,
   'reviewText',v_review.review_text,'reviewHash',v_review.review_sha256,'replayed',true);
 end if;
 if r.status<>'draft' then return jsonb_build_object('error','not_reviewable'); end if;
 if p_decision='rejected' and btrim(coalesce(p_note,''))='' then return jsonb_build_object('error','reason_required'); end if;
 select coalesce(nullif(btrim(full_name),''),email) into v_name from public.users where id=p_reviewed_by;
 if not public.pack_text_ok(btrim(v_name),200) then return jsonb_build_object('error','invalid_request'); end if;
 select id into v_pack from public.evidence_packs where tenant_id=p_tenant_id and report_id=r.id;
 v_text:=jsonb_build_object('schema_version',1,case when v_pack is null then 'report_id' else 'pack_id' end,coalesce(v_pack,r.id),
  case when v_pack is null then 'content_sha256' else 'manifest_sha256' end,r.content_sha256,'decision',p_decision,
  'reviewer',jsonb_build_object('id',p_reviewed_by,'display_name',v_name),
  'reviewed_at',to_char(v_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 if octet_length(v_text)>262144 then return jsonb_build_object('error','invalid_request'); end if;
 insert into public.report_reviews(tenant_id,report_id,decision,content_sha256,reviewed_by,reviewer_name,reviewed_at,note,review_text,review_sha256)
 values(p_tenant_id,r.id,p_decision,r.content_sha256,p_reviewed_by,v_name,v_time,p_note,v_text,encode(sha256(convert_to(v_text,'UTF8')),'hex')) returning * into v_review;
 update public.reports set status=p_decision,reviewed_by=p_reviewed_by,reviewed_at=v_time,review_notes=p_note,
  reviewed_content_hash=r.content_sha256,approved_at=case when p_decision='approved' then v_time else null end,
  rejected_by=case when p_decision='rejected' then p_reviewed_by else null end,rejected_at=case when p_decision='rejected' then v_time else null end,
  rejection_reason=case when p_decision='rejected' then p_note else null end where tenant_id=p_tenant_id and id=r.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_reviewed_by::text,null,null,null,
  case when p_decision='approved' then 'report.approved'::public.ledger_action_type else 'report.rejected'::public.ledger_action_type end,r.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('content_hash',r.content_sha256,'review_id',v_review.id,'decision',p_decision,'note',p_note));
 return jsonb_build_object('reportId',r.id,'status',p_decision,'contentHash',r.content_sha256,'reviewId',v_review.id,
  'reviewText',v_text,'reviewHash',v_review.review_sha256,'replayed',false);
end $$;

create function public.begin_evidence_pack_build(p_tenant_id uuid,p_actor_id uuid,p_pack_id uuid,p_operation_key uuid,
 p_request jsonb,p_correlation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.evidence_packs;r public.reports;b public.evidence_pack_builds;v_review public.report_reviews;v_field text;v_size bigint;
begin
 select * into p from public.evidence_packs where tenant_id=p_tenant_id and id=p_pack_id;
 if not found then return jsonb_build_object('error','pack_not_found'); end if;
 if not public.report_creator_allowed(p_tenant_id,p_actor_id,p.created_by) then return jsonb_build_object('error','forbidden'); end if;
 if p_operation_key is null or p_correlation_id is null or p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>16384 then
  return jsonb_build_object('error','invalid_request'); end if;
 if not(p_request ?& array['provider','bucket','object_key','content_hash','byte_size','manifest_sha256','review_sha256','retention_policy','legal_hold'])
  or (p_request-array['provider','bucket','object_key','content_hash','byte_size','manifest_sha256','review_sha256','retention_policy','legal_hold'])<>'{}'::jsonb then
  return jsonb_build_object('error','invalid_request'); end if;
 foreach v_field in array array['provider','bucket','object_key','content_hash','manifest_sha256','review_sha256','retention_policy'] loop
  if jsonb_typeof(p_request->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_request'); end if;
 end loop;
 if jsonb_typeof(p_request->'byte_size') is distinct from 'number' or (p_request->>'byte_size') !~ '^[0-9]+$'
  or p_request->'legal_hold' is distinct from 'false'::jsonb then return jsonb_build_object('error','invalid_request'); end if;
 begin v_size:=(p_request->>'byte_size')::bigint; exception when numeric_value_out_of_range then return jsonb_build_object('error','invalid_request'); end;
 if v_size not between 1 and 67108864 or p_request->>'provider' not in ('s3','s3-compatible')
  or length(p_request->>'bucket') not between 3 and 255 or p_request->>'bucket' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'
  or p_request->>'content_hash' !~ '^[0-9a-f]{64}$' or p_request->>'review_sha256' !~ '^[0-9a-f]{64}$'
  or p_request->>'retention_policy'<>'seven_years' or p_request->>'object_key' is distinct from
    'tenants/'||p_tenant_id::text||'/evidence-packs/'||p_pack_id::text||'/'||p_operation_key::text||'/'||(p_request->>'content_hash') then
  return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p.report_id for update;
 select * into v_review from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if r.status not in ('approved','published') or v_review.decision is distinct from 'approved' then return jsonb_build_object('error','not_approved'); end if;
 if p_request->>'manifest_sha256' is distinct from p.manifest_sha256 or p_request->>'review_sha256' is distinct from v_review.review_sha256 then
  return jsonb_build_object('error','manifest_changed'); end if;
 select * into b from public.evidence_pack_builds where tenant_id=p_tenant_id and pack_id=p.id for update;
 if found then
  if b.operation_key<>p_operation_key or b.request is distinct from p_request then return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('build_id',b.id,'pack_id',p.id,'operation_key',b.operation_key,'status',b.status,'request',b.request,
   'retain_until',b.retain_until,'correlation_id',b.correlation_id,'replayed',true);
 end if;
 if r.status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_operation_key::text,0));
 if exists(select 1 from public.evidence_pack_builds where tenant_id=p_tenant_id and operation_key=p_operation_key) then
  return jsonb_build_object('error','idempotency_conflict'); end if;
 insert into public.evidence_pack_builds(tenant_id,pack_id,operation_key,actor_id,request,retain_until,correlation_id)
 values(p_tenant_id,p.id,p_operation_key,p_actor_id,p_request,date_trunc('second',clock_timestamp()+interval '7 years')+interval '1 second',p_correlation_id)
 returning * into b;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'evidence.pack.build.started',p.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('build_id',b.id,'archive_sha256',p_request->>'content_hash','manifest_sha256',p.manifest_sha256));
 return jsonb_build_object('build_id',b.id,'pack_id',p.id,'operation_key',b.operation_key,'status',b.status,'request',b.request,
  'retain_until',b.retain_until,'correlation_id',b.correlation_id,'replayed',false);
end $$;

create function public.settle_evidence_pack_build(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,p_receipt jsonb,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.evidence_pack_builds;p public.evidence_packs;q jsonb;v_until timestamptz;v_readback timestamptz;
 v_existing jsonb;v_archive uuid;v_field text;v_status text;
begin
 select p0.* into p from public.evidence_packs p0 join public.evidence_pack_builds b on b.tenant_id=p0.tenant_id and b.pack_id=p0.id
  where b.tenant_id=p_tenant_id and b.id=p_build_id;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if not public.report_creator_allowed(p_tenant_id,p_actor_id,p.created_by) then return jsonb_build_object('error','forbidden'); end if;
 if p_correlation_id is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>16384 then
  return jsonb_build_object('error','invalid_receipt'); end if;
 select status into v_status from public.reports where tenant_id=p_tenant_id and id=p.report_id for update;
 select * into r from public.evidence_pack_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if r.status='settled' then
  select receipt,id into v_existing,v_archive from public.evidence_pack_archives where tenant_id=p_tenant_id and build_id=r.id;
  if v_existing is distinct from p_receipt then return jsonb_build_object('error','receipt_conflict'); end if;
  return jsonb_build_object('build_id',r.id,'pack_id',p.id,'status','settled','archive_id',v_archive,
   'archive_sha256',r.request->>'content_hash','replayed',true);
 end if;
 if v_status<>'approved' then return jsonb_build_object('error','not_approved'); end if;
 q:=r.request||jsonb_build_object('engagement_id',p.engagement_id,'collected_by_agent','evidence-pack-builder');
 -- JSON coercion must not turn numeric/boolean versions into provider IDs.
 foreach v_field in array array['provider','bucket','object_key','version_id','content_hash','tenant_id',
   'collected_by_agent','retain_until','readback_at','lock_mode','encryption','operation_id','correlation_id'] loop
  if jsonb_typeof(p_receipt->v_field) is distinct from 'string' then return jsonb_build_object('error','invalid_receipt'); end if;
 end loop;
 foreach v_field in array array['retain_until','readback_at'] loop
  if p_receipt->>v_field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$' then
   return jsonb_build_object('error','invalid_receipt'); end if;
 end loop;
 begin
  v_until:=(p_receipt->>'retain_until')::timestamptz;
  v_readback:=(p_receipt->>'readback_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','invalid_receipt'); end;
 if not(p_receipt ?& array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id',
      'engagement_id','collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold','encryption','operation_id','correlation_id'])
    or (p_receipt-array['provider','bucket','object_key','version_id','content_hash','byte_size','tenant_id','engagement_id',
      'collected_by_agent','retain_until','readback_at','lock_mode','verified','legal_hold','encryption','operation_id','correlation_id'])<>'{}'::jsonb
    or p_receipt->>'tenant_id' is distinct from p_tenant_id::text
    or p_receipt->>'operation_id' is distinct from r.id::text
    or p_receipt->>'correlation_id' is distinct from r.correlation_id::text
    or p_receipt->>'engagement_id' is distinct from q->>'engagement_id'
    or p_receipt->>'collected_by_agent' is distinct from q->>'collected_by_agent'
    or p_receipt->'byte_size' is distinct from q->'byte_size'
    or p_receipt->>'provider' is distinct from q->>'provider'
    or p_receipt->>'bucket' is distinct from q->>'bucket'
    or p_receipt->>'object_key' is distinct from q->>'object_key'
    or p_receipt->>'content_hash' is distinct from q->>'content_hash'
    or p_receipt->'legal_hold' is distinct from q->'legal_hold'
    or p_receipt->'verified' is distinct from 'true'::jsonb
    or p_receipt->>'lock_mode' is distinct from 'COMPLIANCE'
    or p_receipt->>'encryption' is null or p_receipt->>'encryption' not in ('AES256','aws:kms')
    or length(coalesce(p_receipt->>'version_id','')) not between 1 and 1024
    or btrim(p_receipt->>'version_id')='' or p_receipt->>'version_id'='null'
    or v_until is null or not isfinite(v_until) or v_until<r.retain_until
    or v_readback is null or not isfinite(v_readback) or v_readback<clock_timestamp()-interval '5 minutes'
    or v_readback>clock_timestamp()+interval '5 minutes' then
  return jsonb_build_object('error','receipt_mismatch');
 end if;
 insert into public.evidence_pack_archives(tenant_id,pack_id,build_id,provider,bucket,object_key,version_id,content_hash,byte_size,
  lock_mode,retain_until,readback_at,legal_hold,encryption,receipt,verified_by)
 values(p_tenant_id,p.id,r.id,p_receipt->>'provider',p_receipt->>'bucket',p_receipt->>'object_key',p_receipt->>'version_id',
  p_receipt->>'content_hash',(p_receipt->>'byte_size')::bigint,'COMPLIANCE',v_until,v_readback,false,p_receipt->>'encryption',p_receipt,p_actor_id)
 returning id into v_archive;
 update public.evidence_pack_builds set status='settled',last_error_code=null,settled_at=clock_timestamp(),updated_at=clock_timestamp()
  where tenant_id=p_tenant_id and id=r.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'evidence.pack.build.settled',p.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('build_id',r.id,'archive_id',v_archive,'archive_sha256',q->>'content_hash'));
 return jsonb_build_object('build_id',r.id,'pack_id',p.id,'status','settled','archive_id',v_archive,'archive_sha256',q->>'content_hash','replayed',false);
end $$;

create function public.note_evidence_pack_build_failure(p_tenant_id uuid,p_actor_id uuid,p_build_id uuid,p_error_code text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.evidence_pack_builds;p public.evidence_packs;
begin
 select p0.* into p from public.evidence_packs p0 join public.evidence_pack_builds b0 on b0.tenant_id=p0.tenant_id and b0.pack_id=p0.id
  where b0.tenant_id=p_tenant_id and b0.id=p_build_id;
 if not found then return jsonb_build_object('error','operation_not_found'); end if;
 if not public.report_creator_allowed(p_tenant_id,p_actor_id,p.created_by) then return jsonb_build_object('error','forbidden'); end if;
 if p_correlation_id is null or p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then return jsonb_build_object('error','invalid_request'); end if;
 perform 1 from public.reports where tenant_id=p_tenant_id and id=p.report_id for update;
 select * into b from public.evidence_pack_builds where tenant_id=p_tenant_id and id=p_build_id for update;
 if b.status='pending' and b.last_error_code is distinct from p_error_code then
  update public.evidence_pack_builds set last_error_code=p_error_code,updated_at=clock_timestamp() where tenant_id=p_tenant_id and id=b.id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'evidence.pack.build.pending',p.id::text,
   null,null,null,null,null,null,'success',jsonb_build_object('build_id',b.id,'error_code',p_error_code,'disposition','pending_reconciliation'));
 end if;
 return jsonb_build_object('build_id',b.id,'pack_id',p.id,'status',b.status,
  'last_error_code',case when b.status='pending' then p_error_code else null end);
end $$;

create function public.release_report(p_tenant_id uuid,p_report_id uuid,p_released_by uuid,
 p_expected_content_hash text,p_expected_archive_hash text,p_correlation_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reports;p public.evidence_packs;a public.evidence_pack_archives;v_review public.report_reviews;v_time timestamptz:=clock_timestamp();
begin
 if not public.report_founder_allowed(p_tenant_id,p_released_by) then return jsonb_build_object('error','founder_authority_required'); end if;
 if p_correlation_id is null or p_expected_content_hash is null or p_expected_content_hash !~ '^[0-9a-f]{64}$'
  or (p_expected_archive_hash is not null and p_expected_archive_hash !~ '^[0-9a-f]{64}$') then return jsonb_build_object('error','invalid_request'); end if;
 select * into r from public.reports where tenant_id=p_tenant_id and id=p_report_id for update;
 if not found then return jsonb_build_object('error','report_not_found'); end if;
 if r.content_text is null then return jsonb_build_object('error','legacy_report_requires_revision'); end if;
 if r.content_sha256<>p_expected_content_hash then return jsonb_build_object('error','manifest_changed'); end if;
 if r.status not in ('approved','published') then return jsonb_build_object('error','not_approved'); end if;
 select * into v_review from public.report_reviews where tenant_id=p_tenant_id and report_id=r.id;
 if not found or v_review.decision<>'approved' or v_review.content_sha256 is distinct from r.content_sha256
  or r.reviewed_content_hash is distinct from r.content_sha256 then return jsonb_build_object('error','not_approved'); end if;
 select * into p from public.evidence_packs where tenant_id=p_tenant_id and report_id=r.id;
 if found then
  select a0.* into a from public.evidence_pack_archives a0 join public.evidence_pack_builds b on b.tenant_id=a0.tenant_id and b.id=a0.build_id
   where a0.tenant_id=p_tenant_id and a0.pack_id=p.id and b.status='settled';
  if not found then return jsonb_build_object('error','build_not_settled'); end if;
  if p_expected_archive_hash is distinct from a.content_hash then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 elsif p_expected_archive_hash is not null then return jsonb_build_object('error','archive_hash_mismatch'); end if;
 if r.status='published' then
  if r.released_content_hash is distinct from p_expected_content_hash or r.released_archive_hash is distinct from p_expected_archive_hash then
   return jsonb_build_object('error','idempotency_conflict'); end if;
  return jsonb_build_object('reportId',r.id,'status','published','contentHash',r.released_content_hash,'archiveHash',r.released_archive_hash,'replayed',true);
 end if;
 update public.reports set status='published',published_at=v_time,released_by=p_released_by,released_content_hash=r.content_sha256,
  released_archive_hash=p_expected_archive_hash where tenant_id=p_tenant_id and id=r.id;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_released_by::text,null,null,null,'report.released',r.id::text,
  null,null,null,null,null,null,'success',jsonb_build_object('content_hash',r.content_sha256,'archive_hash',p_expected_archive_hash,'review_id',v_review.id));
 return jsonb_build_object('reportId',r.id,'status','published','contentHash',r.content_sha256,'archiveHash',p_expected_archive_hash,'replayed',false);
end $$;

-- Receipt/pairing constraints are append-only extensions of immutable 0073.
alter table public.evidence_object_versions add constraint evidence_version_pair unique(tenant_id,id,evidence_id);
alter table public.evidence_pack_items add constraint evidence_pack_item_version_pair foreign key(tenant_id,evidence_version_id,evidence_id)
 references public.evidence_object_versions(tenant_id,id,evidence_id) on delete restrict;
alter table public.evidence_pack_builds add constraint pack_build_pair unique(tenant_id,id,pack_id);
alter table public.evidence_pack_archives add constraint pack_archive_build_pair foreign key(tenant_id,build_id,pack_id)
 references public.evidence_pack_builds(tenant_id,id,pack_id) on delete restrict;
-- Private provider locations and build requests are BFF-only, including over
-- direct PostgREST. Public column grants still use publication/creator RLS.
revoke select on public.evidence_pack_builds,public.evidence_pack_archives from authenticated;
grant select(id,tenant_id,pack_id,operation_key,actor_id,status,retain_until,last_error_code,created_at,updated_at,settled_at)
 on public.evidence_pack_builds to authenticated;
grant select(id,tenant_id,pack_id,build_id,version_id,content_hash,byte_size,lock_mode,retain_until,readback_at,legal_hold,encryption,created_at)
 on public.evidence_pack_archives to authenticated;
revoke all on function public.report_founder_allowed(uuid,uuid),public.report_creator_allowed(uuid,uuid,uuid),
 public.report_content_immutable(),public.pack_build_immutable() from public,anon,authenticated,service_role;
revoke all on function public.report_visible(uuid,uuid,text),public.pack_visible(uuid,uuid) from public,anon,service_role;
grant execute on function public.report_visible(uuid,uuid,text),public.pack_visible(uuid,uuid) to authenticated,service_role;
revoke all on function
 public.record_report_draft(uuid,uuid,uuid,text,text,uuid,text,text,text,uuid),
 public.prepare_evidence_pack(uuid,uuid,uuid,text,uuid,text,uuid[],uuid),
 public.review_report(uuid,uuid,text,text,uuid,text,uuid),
 public.release_report(uuid,uuid,uuid,text,text,uuid),
 public.begin_evidence_pack_build(uuid,uuid,uuid,uuid,jsonb,uuid),
 public.settle_evidence_pack_build(uuid,uuid,uuid,jsonb,uuid),
 public.note_evidence_pack_build_failure(uuid,uuid,uuid,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function
 public.record_report_draft(uuid,uuid,uuid,text,text,uuid,text,text,text,uuid),
 public.prepare_evidence_pack(uuid,uuid,uuid,text,uuid,text,uuid[],uuid),
 public.review_report(uuid,uuid,text,text,uuid,text,uuid),
 public.release_report(uuid,uuid,uuid,text,text,uuid),
 public.begin_evidence_pack_build(uuid,uuid,uuid,uuid,jsonb,uuid),
 public.settle_evidence_pack_build(uuid,uuid,uuid,jsonb,uuid),
 public.note_evidence_pack_build_failure(uuid,uuid,uuid,text,uuid)
 to service_role;
