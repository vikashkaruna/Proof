-- Staff prepare an immutable interpretation of the retained intake. A client
-- owner or admin reviews that exact content before any systems are created.
alter type public.ledger_action_type add value if not exists 'onboarding.proposal.prepared';
alter type public.ledger_action_type add value if not exists 'onboarding.proposal.approved';
alter type public.ledger_action_type add value if not exists 'onboarding.proposal.rejected';

create table public.onboarding_proposals (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 estate_id uuid not null,
 prepared_by uuid not null references public.users(id) on delete restrict,
 estate_snapshot jsonb not null check(jsonb_typeof(estate_snapshot)='object'),
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='array'),
 systems jsonb not null check(jsonb_typeof(systems)='array' and jsonb_array_length(systems) between 1 and 100),
 content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reviewed_by uuid references public.users(id) on delete restrict,
 review_reason text,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 unique(tenant_id,id),
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id) on delete restrict,
 check((status='pending' and reviewed_by is null and reviewed_at is null and review_reason is null)
    or (status<>'pending' and reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(btrim(review_reason)) between 1 and 2000))
);
-- The original onboarding intake is a single immutable batch per tenant.
create unique index onboarding_one_pending on public.onboarding_proposals(tenant_id) where status='pending';
create unique index onboarding_one_applied on public.onboarding_proposals(tenant_id) where status='approved';
create table public.onboarding_proposal_systems (
 tenant_id uuid not null,
 proposal_id uuid not null,
 source_index integer not null check(source_index>=0),
 system_id uuid not null,
 primary key(tenant_id,proposal_id,source_index),
 unique(tenant_id,system_id),
 foreign key(tenant_id,proposal_id) references public.onboarding_proposals(tenant_id,id) on delete restrict,
 foreign key(tenant_id,system_id) references public.estate_systems(tenant_id,id) on delete restrict
);

do $$ declare t text; begin
 foreach t in array array['onboarding_proposals','onboarding_proposal_systems'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create policy tenant_member_read on public.%I for select to authenticated using (public.is_tenant_member(tenant_id))',t);
  execute format('create policy service_read on public.%I for select to service_role using (true)',t);
 end loop;
end $$;

create function public.prepare_onboarding_proposal(p_tenant_id uuid,p_actor_id uuid,p_estate_id uuid,p_systems jsonb,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare original jsonb; proposal public.onboarding_proposals; estate public.estates; item jsonb; n integer;
begin
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in ('founder','axiom_analyst') for share;
 if not found then return jsonb_build_object('error','forbidden'); end if;
 select * into estate from public.estates where tenant_id=p_tenant_id and id=p_estate_id for update;
 if not found then return jsonb_build_object('error','not_found'); end if;
 if estate.status<>'active' then return jsonb_build_object('error','estate_archived'); end if;
 -- Serialize all proposals for this tenant even when targeting different estates.
 select proposed_systems into original from public.tenant_onboarding_intakes where tenant_id=p_tenant_id for update;
 if not found then return jsonb_build_object('error','no_intake'); end if;
 if exists(select 1 from public.onboarding_proposals where tenant_id=p_tenant_id and status in ('pending','approved')) then
  return jsonb_build_object('error','proposal_exists');
 end if;
 if jsonb_typeof(p_systems) is distinct from 'array' then return jsonb_build_object('error','invalid_systems'); end if;
 n:=jsonb_array_length(p_systems);
 if n<1 or n>100 or n<>jsonb_array_length(original) then return jsonb_build_object('error','invalid_systems'); end if;
 -- Position is the source index. All intake entries must be reviewed explicitly;
 -- a new proposal after rejection may revise mappings but cannot drop history.
 for item in select value from jsonb_array_elements(p_systems) loop
  if jsonb_typeof(item) is distinct from 'object' or length(btrim(coalesce(item->>'name',''))) not between 1 and 200
    or coalesce(item->>'systemKind','') not in ('database','application','storage','identity','saas','other')
    or jsonb_typeof(item->'dataCategories') is distinct from 'array'
    or jsonb_array_length(item->'dataCategories')>100 then return jsonb_build_object('error','invalid_systems'); end if;
 end loop;
 insert into public.onboarding_proposals(tenant_id,estate_id,prepared_by,estate_snapshot,source_snapshot,systems,content_sha256)
 values(p_tenant_id,p_estate_id,p_actor_id,to_jsonb(estate),original,p_systems,
   encode(sha256(convert_to(jsonb_build_object('estate',to_jsonb(estate),'source',original,'systems',p_systems)::text,'UTF8')),'hex')) returning * into proposal;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,'onboarding.proposal.prepared',proposal.id::text,null,null,null,null,null,null,'success',
   jsonb_build_object('estateId',p_estate_id,'contentSha256',proposal.content_sha256,'systemCount',n));
 return jsonb_build_object('data',to_jsonb(proposal));
end $$;

create function public.review_onboarding_proposal(p_tenant_id uuid,p_actor_id uuid,p_proposal_id uuid,p_content_sha256 text,p_decision text,p_reason text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare proposal public.onboarding_proposals; estate public.estates; estate_id uuid; original jsonb; item jsonb; result jsonb; new_id uuid; ids jsonb:='[]'; idx integer:=0;
begin
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role in ('owner','admin') for share;
 if not found then return jsonb_build_object('error','forbidden'); end if;
 if p_decision not in ('approved','rejected') or p_decision is null or length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then return jsonb_build_object('error','invalid_review'); end if;
 select p.estate_id into estate_id from public.onboarding_proposals p where p.tenant_id=p_tenant_id and p.id=p_proposal_id;
 if not found then return jsonb_build_object('error','not_found'); end if;
 select * into estate from public.estates e where e.tenant_id=p_tenant_id and e.id=estate_id for update;
 select * into proposal from public.onboarding_proposals where tenant_id=p_tenant_id and id=p_proposal_id for update;
 if proposal.prepared_by=p_actor_id then return jsonb_build_object('error','self_review'); end if;
 if proposal.status<>'pending' then return jsonb_build_object('error','already_reviewed'); end if;
 if proposal.content_sha256 is distinct from p_content_sha256 then return jsonb_build_object('error','content_changed'); end if;
 if p_decision='approved' then
  if estate.status<>'active' then return jsonb_build_object('error','estate_archived'); end if;
  if estate.version is distinct from (proposal.estate_snapshot->>'version')::integer then return jsonb_build_object('error','estate_changed'); end if;
  select proposed_systems into original from public.tenant_onboarding_intakes where tenant_id=p_tenant_id for update;
  if original is distinct from proposal.source_snapshot then return jsonb_build_object('error','source_changed'); end if;
  for item in select value from jsonb_array_elements(proposal.systems) loop
   result:=public.manage_estate(p_tenant_id,p_actor_id,'system.create',estate.id,item,p_correlation_id);
   if result ? 'error' then raise exception 'Proposal application failed' using errcode='23514'; end if;
   new_id:=(result#>>'{resource,id}')::uuid;
   insert into public.onboarding_proposal_systems(tenant_id,proposal_id,source_index,system_id) values(p_tenant_id,proposal.id,idx,new_id);
   ids:=ids||jsonb_build_array(new_id); idx:=idx+1;
  end loop;
 end if;
 update public.onboarding_proposals set status=p_decision,reviewed_by=p_actor_id,review_reason=btrim(p_reason),reviewed_at=now() where id=proposal.id returning * into proposal;
 perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  (case when p_decision='approved' then 'onboarding.proposal.approved' else 'onboarding.proposal.rejected' end)::public.ledger_action_type,
  proposal.id::text,null,null,null,p_actor_id,null,null,'success',jsonb_build_object('contentSha256',proposal.content_sha256,'preparedBy',proposal.prepared_by,'reason',proposal.review_reason,'systemIds',ids));
 return jsonb_build_object('data',to_jsonb(proposal),'systemIds',ids);
end $$;
revoke all on function public.prepare_onboarding_proposal(uuid,uuid,uuid,jsonb,uuid),public.review_onboarding_proposal(uuid,uuid,uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.prepare_onboarding_proposal(uuid,uuid,uuid,jsonb,uuid),public.review_onboarding_proposal(uuid,uuid,uuid,text,text,text,uuid) to service_role;

-- The intake also contains private contact fields. Return only its proposed
-- inventory; do not grant a browser or a NOBYPASSRLS BFF broad intake SELECT.
create function public.read_onboarding_inventory(p_tenant_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce((select proposed_systems from public.tenant_onboarding_intakes where tenant_id=p_tenant_id),'[]'::jsonb)
$$;
revoke all on function public.read_onboarding_inventory(uuid) from public,anon,authenticated;
grant execute on function public.read_onboarding_inventory(uuid) to service_role;
