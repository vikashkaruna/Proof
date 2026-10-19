-- Explicit human-reviewed processing declarations. Default-off BFF mount;
-- no connector grants, approval tokens, agent/provider work or inferred flows.
alter type public.mfa_challenge_purpose add value if not exists 'data_flow_declaration';
alter type public.ledger_action_type add value if not exists 'data_flow.declared';
alter type public.ledger_action_type add value if not exists 'data_flow.reviewed';
alter type public.ledger_action_type add value if not exists 'data_flow.withdrawn';
alter type public.ledger_action_type add value if not exists 'data_flow.intent_fenced';

create table controller_security.flow174_parties(
 tenant_id uuid not null references public.tenants(id),id uuid not null,
 declaration jsonb not null,content_sha256 text not null check(content_sha256~'^[a-f0-9]{64}$'),
 supersedes_party_ref uuid,created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,id),foreign key(tenant_id,supersedes_party_ref)references controller_security.flow174_parties(tenant_id,id)
);
create table controller_security.flow174_revisions(
 tenant_id uuid not null references public.tenants(id),id uuid not null,flow_id uuid not null,version integer not null check(version>0),
 previous_revision_id uuid,preparer_id uuid not null references public.users(id),preparer_authority_sha256 text not null check(preparer_authority_sha256~'^[a-f0-9]{64}$'),session_id uuid not null,
 intent_text text not null,intent_sha256 text not null check(intent_sha256~'^[a-f0-9]{64}$'),
 content_sha256 text not null check(content_sha256~'^[a-f0-9]{64}$'),source_sha256 text not null check(source_sha256~'^[a-f0-9]{64}$'),source jsonb not null,
 origin_system_id uuid not null,destination_system_id uuid,party_ref uuid,source_ropa_id uuid,
 valid_until timestamptz not null,challenge_id uuid not null references public.mfa_challenges(id),receipt_id bigint not null,
 created_at timestamptz not null default clock_timestamp(),primary key(tenant_id,id),unique(tenant_id,flow_id,version),unique(challenge_id),
 foreign key(tenant_id,previous_revision_id)references controller_security.flow174_revisions(tenant_id,id),
 foreign key(tenant_id,origin_system_id)references public.estate_systems(tenant_id,id),
 foreign key(tenant_id,destination_system_id)references public.estate_systems(tenant_id,id),
 foreign key(tenant_id,party_ref)references controller_security.flow174_parties(tenant_id,id),
 foreign key(tenant_id,source_ropa_id)references public.operator_workflow_records(tenant_id,id),
 foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id)
);
create index flow174_revision_page on controller_security.flow174_revisions(tenant_id,created_at desc,id);
create table controller_security.flow174_reviews(
 tenant_id uuid not null,revision_id uuid not null,operation_key uuid not null unique,actor_id uuid not null references public.users(id),session_id uuid not null,
 authority_sha256 text not null check(authority_sha256~'^[a-f0-9]{64}$'),intent_text text not null,decision text not null check(decision in('approve','reject')),challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,
 created_at timestamptz not null default clock_timestamp(),primary key(tenant_id,revision_id),
 foreign key(tenant_id,revision_id)references controller_security.flow174_revisions(tenant_id,id),foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id)
);
create table controller_security.flow174_withdrawals(
 tenant_id uuid not null,revision_id uuid not null,operation_key uuid not null unique,actor_id uuid not null references public.users(id),session_id uuid not null,
 intent_text text not null,challenge_id uuid not null unique references public.mfa_challenges(id),receipt_id bigint not null,
 created_at timestamptz not null default clock_timestamp(),primary key(tenant_id,revision_id),
 foreign key(tenant_id,revision_id)references controller_security.flow174_revisions(tenant_id,id),foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id)
);
create table controller_security.flow174_fences(
 tenant_id uuid not null references public.tenants(id),operation_key uuid primary key,actor_id uuid not null references public.users(id),session_id uuid not null,
 intent_text text not null,receipt_id bigint not null,created_at timestamptz not null default clock_timestamp(),foreign key(tenant_id,receipt_id)references public.audit_ledger(tenant_id,id)
);
-- Original factor and database-clock interval are pinned before verification.
create table controller_security.flow174_mfa(
 operation_key uuid primary key,tenant_id uuid not null references public.tenants(id),actor_id uuid not null references public.users(id),session_id uuid not null,
 authority_sha256 text not null check(authority_sha256~'^[a-f0-9]{64}$'),binding_sha256 text not null check(binding_sha256~'^[a-f0-9]{64}$'),challenge_id uuid not null unique references public.mfa_challenges(id),factor_id uuid not null references public.user_mfa_factors(id),
 created_at timestamptz not null,challenge_expires_at timestamptz not null,
 check(challenge_expires_at>created_at and challenge_expires_at<=created_at+interval '5 minutes')
);
do $$declare n text;begin
 foreach n in array array['parties','revisions','reviews','withdrawals','fences','mfa']loop
 execute format('alter table controller_security.flow174_%I enable row level security',n);
 execute format('revoke all on controller_security.flow174_%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer',n);
 execute format('create trigger flow174_no_truncate before truncate on controller_security.flow174_%I for each statement execute function public.evidence_receipt_immutable()',n);
 execute format('create trigger flow174_immutable before update or delete on controller_security.flow174_%I for each row execute function public.evidence_receipt_immutable()',n);
 end loop;
end $$;
create function controller_security.flow174_keys(v jsonb,wanted text[])returns boolean language sql immutable set search_path=''as $$
 select jsonb_typeof(v)='object'and(select array_agg(k order by k)from jsonb_object_keys(v)k)=(select array_agg(k order by k)from unnest(wanted)k)$$;
create function controller_security.flow174_text(v jsonb,n integer,nullable boolean)returns boolean language sql immutable set search_path=''as $$
 select coalesce((nullable and v='null'::jsonb)or(public.operator_workflow_text(v,n,false)and v#>>'{}'=btrim(v#>>'{}',chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||' '||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),false)$$;
create function controller_security.flow174_uuid(v jsonb,nullable boolean)returns boolean language sql immutable set search_path=''as $$
 select coalesce((nullable and v='null'::jsonb)or(jsonb_typeof(v)='string'and v#>>'{}'~'^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'),false)$$;
create function controller_security.flow174_digest(v jsonb)returns boolean language sql immutable set search_path=''as $$
 select coalesce(jsonb_typeof(v)='string'and v#>>'{}'~'^[a-f0-9]{64}$',false)$$;
create function controller_security.flow174_hash(v jsonb)returns text language sql immutable set search_path=''as $$select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(v),'UTF8')),'hex')$$;
create function controller_security.flow174_prepare_allowed(t uuid,a uuid)returns boolean language sql stable security definer set search_path=''as $$
 select public.is_live_platform_founder(a)or exists(select 1 from public.tenant_users where tenant_id=t and user_id=a and role in('owner','admin'))$$;
create function controller_security.flow174_authority(t uuid,a uuid)returns text language plpgsql volatile security definer set search_path=''as $$declare m public.tenant_users;f public.platform_founders;begin
 perform 1 from public.users where id=a for no key update;
 select *into f from public.platform_founders where user_id=a for share;
 if public.is_live_platform_founder(a)then
 return controller_security.flow174_hash(jsonb_build_object('kind','live_platform_founder','actorId',a,'designatedAt',to_char(f.designated_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 end if;
 select *into m from public.tenant_users where tenant_id=t and user_id=a and role in('owner','admin')for share;
 if m.id is null then return null;end if;
 return controller_security.flow174_hash(jsonb_build_object('kind','explicit_membership','membershipId',m.id,'tenantId',t,'actorId',a,'role',m.role,'invitedAt',to_char(m.invited_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
end $$;
create function controller_security.flow174_session(t uuid,a uuid,s uuid)returns void language plpgsql volatile security definer set search_path=''as $$begin
 perform pg_advisory_xact_lock(hashtextextended(t::text,47));
 perform 1 from public.users where id=a for no key update;
 if not found then raise exception 'current flow user required'using errcode='42501';end if;
 perform 1 from public.platform_founders where user_id=a for share;
 if not(public.is_live_platform_founder(a)or exists(select 1 from public.tenant_users where tenant_id=t and user_id=a))then raise exception 'current flow member required'using errcode='42501';end if;
 perform 1 from public.tenant_users where tenant_id=t and user_id=a for share;
 if not public.mfa_recovery_live_session(a,s)or public.mfa_recovery_open_case(a)is not null then raise exception 'current flow recovery-safe session required'using errcode='42501';end if;
 perform 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp())for share;
 if not found then raise exception 'current flow session required'using errcode='42501';end if;
end $$;
create function controller_security.flow174_human(t uuid,a uuid,s uuid)returns void language plpgsql volatile security definer set search_path=''as $$begin
 perform controller_security.flow174_session(t,a,s);
 perform public.assert_mfa_recovery_session_actor(a,s);
end $$;
create function controller_security.flow174_pin(t uuid,sys uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare x public.estate_systems;e public.estates;v jsonb;begin
 -- Parent before child follows estate mutation lock order. Parent version is
 -- committed in the pin hash, so archive/restore cannot revive an old review.
 select estate.* into e from public.estates estate join public.estate_systems system on(system.tenant_id,system.estate_id)=(estate.tenant_id,estate.id)where system.tenant_id=t and system.id=sys for share of estate;
 select * into x from public.estate_systems where tenant_id=t and id=sys for share;
 if x.id is null or e.id is null or x.estate_id<>e.id or x.status<>'active'or e.status<>'active'then raise exception 'current registered flow system required'using errcode='42501';end if;
 v:=jsonb_build_object('systemId',x.id,'estateId',x.estate_id,'version',x.version);
 return v||jsonb_build_object('contentSha256',controller_security.flow174_hash(v||jsonb_build_object('estateVersion',e.version)));end $$;
create function controller_security.flow174_intent(raw text)returns jsonb language plpgsql immutable set search_path=''as $$declare v jsonb;q jsonb;d jsonb;p jsonb;pin jsonb;k text;begin
 if raw is null or octet_length(raw)>18000 then raise exception 'bounded flow intent required'using errcode='22023';end if;
 v:=raw::jsonb;q:=v->'request';
 if controller_security.canonical_questionnaire_json(v)is distinct from raw or controller_security.flow174_keys(v,array['phase','request'])is distinct from true
 or v->>'phase'not in('declare','approve','reject','withdraw')or v->>'phase'is null or not controller_security.flow174_uuid(q->'operationKey',false) or q->'schemaVersion'is distinct from '1'::jsonb
 or jsonb_typeof(q->'reason')is distinct from 'string'or length(q->>'reason')not between 20 and 2000 or not controller_security.flow174_text(q->'reason',2000,false)then raise exception 'exact phased flow intent required'using errcode='22023';end if;
 perform(q->>'operationKey')::uuid;
 if v->>'phase'='declare'then
 if controller_security.flow174_keys(q,array['schemaVersion','operationKey','flowId','previousRevisionId','origin','destination','purpose','dataCategories','originCountry','destinationCountries','crossBorder','transferSafeguards','sourceRopaId','sourceNote','validUntil','reason'])is distinct from true
 or not controller_security.flow174_uuid(q->'flowId',false)or not controller_security.flow174_uuid(q->'previousRevisionId',true)
 or not controller_security.flow174_uuid(q->'sourceRopaId',true)or not controller_security.flow174_text(q->'purpose',2000,true)
 or not controller_security.flow174_text(q->'transferSafeguards',2000,true)or not controller_security.flow174_text(q->'sourceNote',2000,false)
 or q->'crossBorder'not in('true'::jsonb,'false'::jsonb,'null'::jsonb)
 then raise exception 'flow declaration refused'using errcode='22023';end if;
 if jsonb_typeof(q->'validUntil')is distinct from 'string'or q->>'validUntil'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$'then raise exception 'explicit valid timestamp required'using errcode='22023';end if;
 perform(q->>'validUntil')::timestamptz;d:=q->'destination';
 if d->>'kind'='system'then
 if controller_security.flow174_keys(d,array['kind','system'])is distinct from true then raise exception 'flow destination refused'using errcode='22023';end if;
 elsif d->>'kind'='unknown'then
 if controller_security.flow174_keys(d,array['kind','reason'])is distinct from true or not controller_security.flow174_text(d->'reason',2000,false)then raise exception 'explicit unknown destination required'using errcode='22023';end if;
 elsif d->>'kind'='party'then
 if controller_security.flow174_keys(d,array['kind','party','system'])is distinct from true then raise exception 'flow party destination refused'using errcode='22023';end if;p:=d->'party';
 if p->>'kind'='existing'then
 if controller_security.flow174_keys(p,array['kind','partyRef','contentSha256'])is distinct from true or not controller_security.flow174_uuid(p->'partyRef',false)or not controller_security.flow174_digest(p->'contentSha256')then raise exception 'exact party reference required'using errcode='22023';end if;
 elsif p->>'kind'='new'then
 if controller_security.flow174_keys(p,array['kind','declaration'])is distinct from true or controller_security.flow174_keys(p->'declaration',array['partyRef','label','role','supersedesPartyRef'])is distinct from true
 or not controller_security.flow174_uuid(p#>'{declaration,partyRef}',false)or not controller_security.flow174_uuid(p#>'{declaration,supersedesPartyRef}',true)
 or not controller_security.flow174_text(p#>'{declaration,label}',200,false)or coalesce(p#>>'{declaration,role}'in('processor','recipient'),false)is distinct from truethen raise exception 'bounded party declaration required'using errcode='22023';end if;
 else raise exception 'explicit party reference required'using errcode='22023';end if;
 else raise exception 'typed flow destination required'using errcode='22023';end if;
 foreach pin in array array[q->'origin',case when d->'system'='null'::jsonb then null else d->'system'end]loop
 if pin is null then continue;end if;
 if controller_security.flow174_keys(pin,array['systemId','estateId','version','contentSha256'])is distinct from true or not controller_security.flow174_uuid(pin->'systemId',false)or not controller_security.flow174_uuid(pin->'estateId',false)
 or jsonb_typeof(pin->'version')is distinct from 'number'or(pin->>'version')::integer<1 or not controller_security.flow174_digest(pin->'contentSha256')then raise exception 'exact registered system pin required'using errcode='22023';end if;
 end loop;
 foreach k in array array['originCountry','destinationCountries','dataCategories']loop
 if q->k='null'::jsonb then continue;end if;
 if k='originCountry'then if jsonb_typeof(q->k)<>'string'or q->>k!~'^[A-Z]{2}$'then raise exception 'country declaration refused'using errcode='22023';end if;
 elsif jsonb_typeof(q->k)<>'array'or jsonb_array_length(q->k)>50 or exists(select 1 from jsonb_array_elements(q->k)x where jsonb_typeof(x)<>'string'or(k='destinationCountries'and x#>>'{}'!~'^[A-Z]{2}$')or(k='dataCategories'and not controller_security.flow174_text(x,80,false)))
 or(select count(distinct x)from jsonb_array_elements(q->k)x)<>jsonb_array_length(q->k)then raise exception 'bounded declared categories/countries required'using errcode='22023';end if;
 end loop;
 else
 if controller_security.flow174_keys(q,array['schemaVersion','operationKey','revisionId','expectedContentSha256','reason'])is distinct from true or not controller_security.flow174_uuid(q->'revisionId',false)or not controller_security.flow174_digest(q->'expectedContentSha256')then raise exception 'exact flow revision decision required'using errcode='22023';end if;
 end if;
 return v;end $$;
create function controller_security.flow174_source(t uuid,q jsonb)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare origin jsonb;target jsonb;party jsonb;d jsonb:=q->'destination';r public.operator_workflow_records;ropa jsonb;stored controller_security.flow174_parties;begin
 origin:=controller_security.flow174_pin(t,(q#>>'{origin,systemId}')::uuid);
 if origin is distinct from q->'origin'then raise exception 'flow origin changed'using errcode='40001';end if;
 if d->>'kind'='unknown'then target:=jsonb_build_object('kind','unknown');
 else
 if d->'system'<>'null'::jsonb then
 target:=controller_security.flow174_pin(t,(d#>>'{system,systemId}')::uuid);
 if target is distinct from d->'system'or target=origin then raise exception 'flow target changed'using errcode='40001';end if;
 end if;
 if d->>'kind'='party'then
 if d#>>'{party,kind}'='existing'then
 select * into stored from controller_security.flow174_parties where tenant_id=t and id=(d#>>'{party,partyRef}')::uuid;
 if stored.id is null or stored.content_sha256 is distinct from d#>>'{party,contentSha256}'or not exists(select 1 from controller_security.flow174_revisions rv join controller_security.flow174_reviews review on(review.tenant_id,review.revision_id)=(rv.tenant_id,rv.id)where rv.tenant_id=t and rv.party_ref=stored.id and review.decision='approve')then raise exception 'current declared party required'using errcode='42501';end if;
 party:=jsonb_build_object('partyRef',stored.id,'contentSha256',stored.content_sha256);
 else
 select * into stored from controller_security.flow174_parties where tenant_id=t and id=(d#>>'{party,declaration,partyRef}')::uuid;
 if stored.id is not null and stored.declaration is distinct from d#>'{party,declaration}'then raise exception 'immutable party reference conflict'using errcode='23505';end if;
 party:=jsonb_build_object('partyRef',d#>'{party,declaration,partyRef}','contentSha256',controller_security.flow174_hash(d#>'{party,declaration}'));
 if d#>'{party,declaration,supersedesPartyRef}'<>'null'::jsonb and not exists(select 1 from controller_security.flow174_parties where tenant_id=t and id=(d#>>'{party,declaration,supersedesPartyRef}')::uuid)then raise exception 'same tenant superseded party required'using errcode='42501';end if;
 end if;
 target:=jsonb_build_object('kind','party','party',party,'system',target);
 else target:=jsonb_build_object('kind','system','system',target);end if;
 end if;
 if q->'sourceRopaId'<>'null'::jsonb then
 select * into r from public.operator_workflow_records where tenant_id=t and id=(q->>'sourceRopaId')::uuid and kind='ropa';
 if r.id is null or public.operator_workflow_source(t,r.payload)?'error'then raise exception 'current retained RoPA reference required'using errcode='42501';end if;
 ropa:=jsonb_build_object('recordId',r.id,'receiptId',r.receipt_id::text,'payloadSha256',controller_security.flow174_hash(r.payload));
 end if;
 return jsonb_build_object('origin',origin,'destination',target,'ropa',ropa);end $$;
create function controller_security.flow174_state(t uuid,rid uuid)returns text language plpgsql volatile security definer set search_path=''as $$
declare r controller_security.flow174_revisions;x controller_security.flow174_reviews;q jsonb;begin
 select * into strict r from controller_security.flow174_revisions where tenant_id=t and id=rid;
 if exists(select 1 from controller_security.flow174_withdrawals where tenant_id=t and revision_id=rid)then return 'withdrawn';end if;
 select * into x from controller_security.flow174_reviews where tenant_id=t and revision_id=rid;
 if x.decision='reject'then return 'rejected';end if;
 if r.valid_until<=clock_timestamp()then return 'expired';end if;
 -- Only the latest retained head may be reviewed-current. A newer draft, rejection or withdrawal never reactivates older approval.
 if exists(select 1 from controller_security.flow174_revisions newer where newer.tenant_id=t and newer.flow_id=r.flow_id and newer.version>r.version)then return 'superseded';end if;
 begin
 q:=(r.intent_text::jsonb)->'request';
 if controller_security.flow174_authority(t,r.preparer_id)is distinct from r.preparer_authority_sha256 or(x.actor_id is not null and controller_security.flow174_authority(t,x.actor_id)is distinct from x.authority_sha256)or controller_security.flow174_source(t,q)is distinct from r.source then return 'stale';end if;
 exception when others then return 'stale';end;
 return case when x.decision='approve'then 'approved'else 'proposed'end;end $$;
create function public.preflight_data_flow_declaration(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s'as $$
declare v jsonb;q jsonb;src jsonb;prior controller_security.flow174_revisions;r controller_security.flow174_revisions;phase text;begin
 perform controller_security.flow174_human(p_tenant_id,p_actor_id,p_session_id);
 v:=controller_security.flow174_intent(p_intent_text);q:=v->'request';phase:=v->>'phase';
 if not controller_security.flow174_prepare_allowed(p_tenant_id,p_actor_id)then raise exception 'current flow preparation/review capability required'using errcode='42501';end if;
 if phase='declare'then
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||(q->>'flowId'),174));
 select * into prior from controller_security.flow174_revisions where tenant_id=p_tenant_id and flow_id=(q->>'flowId')::uuid order by version desc limit 1;
 if prior.id is distinct from(q->>'previousRevisionId')::uuid then raise exception 'current flow revision changed'using errcode='40001';end if;
 if(q->>'validUntil')::timestamptz<=clock_timestamp()or(q->>'validUntil')::timestamptz>clock_timestamp()+interval '366 days'then raise exception 'explicit bounded review validity required'using errcode='42501';end if;
 if q#>>'{destination,kind}'='party'and q#>>'{destination,party,kind}'='new'and exists(select 1 from controller_security.flow174_parties where tenant_id=p_tenant_id and id=(q#>>'{destination,party,declaration,partyRef}')::uuid)then raise exception 'new party reference already retained'using errcode='23505';end if;
 src:=controller_security.flow174_source(p_tenant_id,q);
 else
 select * into r from controller_security.flow174_revisions where tenant_id=p_tenant_id and id=(q->>'revisionId')::uuid;
 if r.id is null or r.content_sha256 is distinct from q->>'expectedContentSha256'then raise exception 'exact retained declaration required'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||r.flow_id::text,174));
 if phase in('approve','reject')then
 if r.preparer_id=p_actor_id or controller_security.flow174_authority(p_tenant_id,r.preparer_id)is distinct from r.preparer_authority_sha256 then raise exception 'independent current client review required'using errcode='42501';end if;
 select * into prior from controller_security.flow174_revisions where tenant_id=p_tenant_id and flow_id=r.flow_id order by version desc limit 1;
 if prior.id<>r.id or exists(select 1 from controller_security.flow174_reviews where tenant_id=p_tenant_id and revision_id=r.id)or exists(select 1 from controller_security.flow174_withdrawals where tenant_id=p_tenant_id and revision_id=r.id)then raise exception 'flow review revision changed'using errcode='40001';end if;
 if r.valid_until<=clock_timestamp()then raise exception 'flow review validity expired'using errcode='42501';end if;
 src:=controller_security.flow174_source(p_tenant_id,(r.intent_text::jsonb)->'request');
 if src is distinct from r.source then raise exception 'recorded flow source changed'using errcode='40001';end if;
 else
 if exists(select 1 from controller_security.flow174_withdrawals where tenant_id=p_tenant_id and revision_id=r.id)then raise exception 'flow already withdrawn'using errcode='40001';end if;
 -- Withdrawal of metadata does not claim that actual processing stopped.
 src:=r.source;
 end if;
 end if;
 return jsonb_build_object('intent',v,'tenantId',p_tenant_id,'actorId',p_actor_id,'sessionId',p_session_id,'phase',phase,'requestSha256',controller_security.flow174_hash(v),'source',src,'sourceSha256',controller_security.flow174_hash(src));end $$;
create function public.read_data_flow_declaration_operation(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)returns jsonb language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare v jsonb;q jsonb;op uuid;phase text;revision uuid;actor uuid;original text;receipt bigint;result jsonb;d controller_security.flow174_mfa;c public.mfa_challenges;f controller_security.flow174_fences;binding text;begin
 perform controller_security.flow174_session(p_tenant_id,p_actor_id,p_session_id);v:=controller_security.flow174_intent(p_intent_text);q:=v->'request';op:=(q->>'operationKey')::uuid;phase:=v->>'phase';
 perform pg_advisory_xact_lock(hashtextextended(op::text,174));
 result:=jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'phase',phase,'operationKey',op,'requestSha256',controller_security.flow174_hash(v));
 select id,preparer_id,intent_text,receipt_id into revision,actor,original,receipt from controller_security.flow174_revisions where tenant_id=p_tenant_id and id=op;
 if revision is null then select revision_id,actor_id,intent_text,receipt_id into revision,actor,original,receipt from controller_security.flow174_reviews where tenant_id=p_tenant_id and operation_key=op;end if;
 if revision is null then select revision_id,actor_id,intent_text,receipt_id into revision,actor,original,receipt from controller_security.flow174_withdrawals where tenant_id=p_tenant_id and operation_key=op;end if;
 if revision is not null then
 if actor<>p_actor_id or original<>p_intent_text then raise exception 'flow original operation conflict'using errcode='23505';end if;
 return result||jsonb_build_object('recorded',true,'revisionId',revision,'receiptId',receipt::text,'state',controller_security.flow174_state(p_tenant_id,revision));end if;
 select * into f from controller_security.flow174_fences where operation_key=op;
 if f.operation_key is not null then
 if(f.tenant_id,f.actor_id,f.intent_text)is distinct from(p_tenant_id,p_actor_id,p_intent_text)then raise exception 'flow original fence conflict'using errcode='23505';end if;
 return result||jsonb_build_object('recorded',false,'fenced',true,'fenceReceiptId',f.receipt_id::text,'challengeExpiresAt',null);end if;
 select * into d from controller_security.flow174_mfa where operation_key=op;
 if d.operation_key is not null then
 binding:=controller_security.flow174_hash(jsonb_build_array('axiom.data-flow.'||phase,1,p_tenant_id::text,p_actor_id::text,d.session_id::text,controller_security.flow174_hash(v)));
 if(d.tenant_id,d.actor_id,d.binding_sha256)is distinct from(p_tenant_id,p_actor_id,binding)then raise exception 'flow original MFA scope conflict'using errcode='23505';end if;
 select * into c from public.mfa_challenges where id=d.challenge_id;
 end if;
 return result||jsonb_build_object('recorded',false,'fenced',false,'fenceReceiptId',null,'challengeExpiresAt',d.challenge_expires_at);end $$;
create function public.record_data_flow_declaration(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text,p_challenge_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare old jsonb;proof jsonb;v jsonb;q jsonb;phase text;op uuid;r controller_security.flow174_revisions;prior controller_security.flow174_revisions;c public.mfa_challenges;d controller_security.flow174_mfa;receipt bigint;now_at timestamptz;binding text;party jsonb;party_ref uuid;target uuid;content text;begin
 if current_setting('role',true)is distinct from 'human_action_writer'then raise exception 'human flow writer required'using errcode='42501';end if;
 old:=public.read_data_flow_declaration_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 if old->>'recorded'='true'then return old;end if;
 if old->>'fenced'='true'then raise exception 'flow original intent fenced'using errcode='42501';end if;
 proof:=public.preflight_data_flow_declaration(p_tenant_id,p_actor_id,p_session_id,p_intent_text);v:=proof->'intent';q:=v->'request';phase:=v->>'phase';op:=(q->>'operationKey')::uuid;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp'order by id for update;
 select * into d from controller_security.flow174_mfa where operation_key=op;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;now_at:=clock_timestamp();
 binding:=controller_security.flow174_hash(jsonb_build_array('axiom.data-flow.'||phase,1,p_tenant_id::text,p_actor_id::text,p_session_id::text,proof->>'requestSha256'));
 if d.authority_sha256 is distinct from controller_security.flow174_authority(p_tenant_id,p_actor_id)or c.id is null or(d.tenant_id,d.actor_id,d.session_id,d.binding_sha256,d.challenge_id,d.factor_id,d.created_at,d.challenge_expires_at)is distinct from(p_tenant_id,p_actor_id,p_session_id,binding,c.id,c.factor_id,c.created_at,c.expires_at)
 or(c.user_id,c.tenant_id,c.purpose::text,c.bound_resource_ref,c.bound_payload_sha256,c.consumed_for)is distinct from(p_actor_id,p_tenant_id,'data_flow_declaration',op::text,binding,op::text)
 or c.satisfied_at is null or c.consumed_at is null or c.created_at>c.satisfied_at or c.satisfied_at>c.consumed_at or c.satisfied_at<=now_at-interval '5 minutes'or c.consumed_at>now_at or c.expires_at<=now_at or c.expires_at>c.created_at+interval '5 minutes'
 or not exists(select 1 from public.user_mfa_factors where id=c.factor_id and user_id=p_actor_id and factor_type='totp'and status='active'and revoked_at is null)
 or exists(select 1 from controller_security.flow174_revisions where challenge_id=c.id)or exists(select 1 from controller_security.flow174_reviews where challenge_id=c.id)or exists(select 1 from controller_security.flow174_withdrawals where challenge_id=c.id)
 then raise exception 'fresh original phase-bound flow MFA required'using errcode='42501';end if;
 proof:=public.preflight_data_flow_declaration(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,
 (case phase when 'declare'then 'data_flow.declared'when 'withdraw'then 'data_flow.withdrawn'else 'data_flow.reviewed'end)::public.ledger_action_type,
 (case when phase='declare'then op else(q->>'revisionId')::uuid end)::text,proof->>'requestSha256',null,null,null,null,null,'success',jsonb_build_object('phase',phase,'requestSha256',proof->>'requestSha256','sourceSha256',proof->>'sourceSha256','metadataOnly',true,'executionAuthority',false));
 if phase='declare'then
 if q#>>'{destination,kind}'='party'then
 if q#>>'{destination,party,kind}'='new'then
 party:=q#>'{destination,party,declaration}';party_ref:=(party->>'partyRef')::uuid;
 insert into controller_security.flow174_parties(tenant_id,id,declaration,content_sha256,supersedes_party_ref)values(p_tenant_id,party_ref,party,controller_security.flow174_hash(party),(party->>'supersedesPartyRef')::uuid);
 else party_ref:=(q#>>'{destination,party,partyRef}')::uuid;end if;end if;
 if q#>>'{destination,kind}'in('system','party')then target:=(q#>>'{destination,system,systemId}')::uuid;end if;
 select * into prior from controller_security.flow174_revisions where tenant_id=p_tenant_id and flow_id=(q->>'flowId')::uuid order by version desc limit 1;
 content:=controller_security.flow174_hash(jsonb_build_object('declaration',q,'source',proof->'source'));
 insert into controller_security.flow174_revisions(tenant_id,id,flow_id,version,previous_revision_id,preparer_id,preparer_authority_sha256,session_id,intent_text,intent_sha256,content_sha256,source_sha256,source,origin_system_id,destination_system_id,party_ref,source_ropa_id,valid_until,challenge_id,receipt_id)
 values(p_tenant_id,op,(q->>'flowId')::uuid,coalesce(prior.version,0)+1,prior.id,p_actor_id,controller_security.flow174_authority(p_tenant_id,p_actor_id),p_session_id,p_intent_text,proof->>'requestSha256',content,proof->>'sourceSha256',proof->'source',(q#>>'{origin,systemId}')::uuid,target,party_ref,(q->>'sourceRopaId')::uuid,(q->>'validUntil')::timestamptz,c.id,receipt);
 elsif phase in('approve','reject')then
 insert into controller_security.flow174_reviews(tenant_id,revision_id,operation_key,actor_id,session_id,authority_sha256,intent_text,decision,challenge_id,receipt_id)values(p_tenant_id,(q->>'revisionId')::uuid,op,p_actor_id,p_session_id,controller_security.flow174_authority(p_tenant_id,p_actor_id),p_intent_text,phase,c.id,receipt);
 else insert into controller_security.flow174_withdrawals(tenant_id,revision_id,operation_key,actor_id,session_id,intent_text,challenge_id,receipt_id)values(p_tenant_id,(q->>'revisionId')::uuid,op,p_actor_id,p_session_id,p_intent_text,c.id,receipt);end if;
 if c.expires_at<=clock_timestamp()or(phase='declare'and(q->>'validUntil')::timestamptz<=clock_timestamp())or(phase in('approve','reject')and exists(select 1 from controller_security.flow174_revisions where tenant_id=p_tenant_id and id=(q->>'revisionId')::uuid and valid_until<=clock_timestamp()))then raise exception 'flow MFA expired during retention'using errcode='42501';end if;
 return public.read_data_flow_declaration_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);end $$;
create function public.fence_data_flow_declaration(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_intent_text text)returns jsonb language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$declare old jsonb;v jsonb;op uuid;receipt bigint;begin
 if current_setting('role',true)is distinct from 'human_action_writer'then raise exception 'human flow fence writer required'using errcode='42501';end if;
 old:=public.read_data_flow_declaration_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);
 if old->>'recorded'='true'or old->>'fenced'='true'then return old;end if;
 v:=controller_security.flow174_intent(p_intent_text);op:=(v#>>'{request,operationKey}')::uuid;
 receipt:=public.append_ledger(p_tenant_id,op,'human',p_actor_id::text,null,null,null,'data_flow.intent_fenced',null,old->>'requestSha256',null,null,null,null,null,'success',jsonb_build_object('phase',v->>'phase','metadataOnly',true));
 insert into controller_security.flow174_fences(tenant_id,operation_key,actor_id,session_id,intent_text,receipt_id)values(p_tenant_id,op,p_actor_id,p_session_id,p_intent_text,receipt);
 return public.read_data_flow_declaration_operation(p_tenant_id,p_actor_id,p_session_id,p_intent_text);end $$;
create function public.data_flow_declaration_context(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_revision_id uuid default null)returns jsonb language plpgsql volatile security definer set search_path=''set lock_timeout='5s'as $$
declare systems jsonb:='[]';parties jsonb:='[]';revisions jsonb:='[]';s public.estate_systems;r controller_security.flow174_revisions;x controller_security.flow174_reviews;w controller_security.flow174_withdrawals;p controller_security.flow174_parties;state text;begin
 perform controller_security.flow174_session(p_tenant_id,p_actor_id,p_session_id);
 if(select count(*)from public.estate_systems where tenant_id=p_tenant_id and status='active')>1000 then raise exception 'flow inventory exceeds bounded selector'using errcode='54000';end if;
 for s in select sys.*from public.estate_systems sys join public.estates e on(e.tenant_id,e.id)=(sys.tenant_id,sys.estate_id)where sys.tenant_id=p_tenant_id and sys.status='active'and e.status='active'order by sys.id limit 1000 loop
 systems:=systems||jsonb_build_array(jsonb_build_object('name',s.name,'pin',controller_security.flow174_pin(p_tenant_id,s.id)));end loop;
 for p in select party.*from controller_security.flow174_parties party where party.tenant_id=p_tenant_id and exists(select 1 from controller_security.flow174_revisions rv join controller_security.flow174_reviews review on(review.tenant_id,review.revision_id)=(rv.tenant_id,rv.id)where rv.tenant_id=p_tenant_id and rv.party_ref=party.id and review.decision='approve')order by party.id limit 1000 loop
 parties:=parties||jsonb_build_array(jsonb_build_object('declaration',p.declaration,'contentSha256',p.content_sha256));end loop;
 for r in select *from controller_security.flow174_revisions where tenant_id=p_tenant_id and(p_revision_id is null or id=p_revision_id)order by created_at desc,id limit 100 loop
 select *into x from controller_security.flow174_reviews where tenant_id=p_tenant_id and revision_id=r.id;
 select *into w from controller_security.flow174_withdrawals where tenant_id=p_tenant_id and revision_id=r.id;
 select *into p from controller_security.flow174_parties where tenant_id=p_tenant_id and id=r.party_ref;
 state:=controller_security.flow174_state(p_tenant_id,r.id);
 revisions:=revisions||jsonb_build_array(jsonb_build_object('revisionId',r.id,'flowId',r.flow_id,'version',r.version,'tenantId',r.tenant_id,'preparerId',r.preparer_id,'isHead',not exists(select 1 from controller_security.flow174_revisions newer where newer.tenant_id=p_tenant_id and newer.flow_id=r.flow_id and newer.version>r.version),
 'request',(r.intent_text::jsonb)->'request','requestSha256',r.intent_sha256,'contentSha256',r.content_sha256,'sourceSha256',r.source_sha256,'source',r.source,'party',p.declaration,'state',state,
 'declarationReceiptId',r.receipt_id::text,'reviewReceiptId',x.receipt_id::text,'withdrawalReceiptId',w.receipt_id::text,
 'createdAt',to_char(r.created_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'reviewedAt',to_char(x.created_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
 end loop;
 return jsonb_build_object('tenantId',p_tenant_id,'actorId',p_actor_id,'checkedAt',to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'historyHasMore',p_revision_id is null and(select count(*)>100 from controller_security.flow174_revisions where tenant_id=p_tenant_id),'canPrepare',controller_security.flow174_prepare_allowed(p_tenant_id,p_actor_id),'canReview',controller_security.flow174_prepare_allowed(p_tenant_id,p_actor_id),'systems',systems,'parties',parties,'revisions',revisions);end $$;

alter function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) set schema controller_security;
alter function controller_security.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) rename to append_agent_ledger_before_0174;
revoke all on function controller_security.append_agent_ledger_before_0174(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
create function public.append_agent_ledger(p_tenant_id uuid,p_correlation_id uuid,p_actor_type public.actor_type,p_actor_id text,p_agent_version text,p_model_id text,p_prompt_hash text,p_action_type public.ledger_action_type,p_target_ref text,p_input_hash text,p_output_hash text,p_approval_token_id uuid,p_approver_id uuid,p_pre_state_ref text,p_post_state_ref text,p_result public.ledger_result,p_detail jsonb) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if p_action_type::text=any(array['data_flow.declared','data_flow.reviewed','data_flow.withdrawn','data_flow.intent_fenced'])then raise exception 'human declaration authority required'using errcode='42501';end if;
 return controller_security.append_agent_ledger_before_0174(p_tenant_id,p_correlation_id,p_actor_type,p_actor_id,p_agent_version,p_model_id,p_prompt_hash,p_action_type,p_target_ref,p_input_hash,p_output_hash,p_approval_token_id,p_approver_id,p_pre_state_ref,p_post_state_ref,p_result,p_detail);
end $$;
revoke all on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller,axiom_prativedan_controller;
grant execute on function public.append_agent_ledger(uuid,uuid,public.actor_type,text,text,text,text,public.ledger_action_type,text,text,text,uuid,uuid,text,text,public.ledger_result,jsonb) to agent_ledger_writer;

create function public.issue_data_flow_declaration_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_ttl_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;d controller_security.flow174_mfa;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'data flow declaration MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'data flow declaration MFA input refused' using errcode='22023';end if;

 if p_ttl_ms is null or p_ttl_ms not between 1 and 300000 then raise exception 'data flow declaration MFA TTL refused' using errcode='22023';end if;

 perform controller_security.flow174_human(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;

 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id) or not controller_security.flow174_prepare_allowed(p_tenant_id,p_actor_id)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'data flow declaration MFA scope refused' using errcode='42501';end if;

 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,174));
 if exists(select 1 from controller_security.flow174_fences where operation_key=p_operation_key) then raise exception 'scope request fenced' using errcode='42501';end if;
 select * into d from controller_security.flow174_mfa where operation_key=p_operation_key;
 if d.operation_key is not null then
  if (d.tenant_id,d.actor_id,d.session_id,d.binding_sha256,d.factor_id,d.authority_sha256) is distinct from(p_tenant_id,p_actor_id,p_session_id,p_bound_payload_sha256,p_factor_id,controller_security.flow174_authority(p_tenant_id,p_actor_id)) then raise exception 'MFA decision conflict' using errcode='23505';end if;
  select * into c from public.mfa_challenges where id=d.challenge_id;
  return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
 end if;
 insert into public.mfa_challenges(user_id,tenant_id,factor_id,purpose,bound_resource_ref,bound_payload_sha256,created_at,expires_at)
 values(p_actor_id,p_tenant_id,p_factor_id,'data_flow_declaration',p_operation_key::text,p_bound_payload_sha256,now_at,now_at+p_ttl_ms*interval '1 millisecond') returning * into c;
 insert into controller_security.flow174_mfa(operation_key,tenant_id,actor_id,session_id,authority_sha256,binding_sha256,challenge_id,factor_id,challenge_expires_at,created_at)values(p_operation_key,p_tenant_id,p_actor_id,p_session_id,controller_security.flow174_authority(p_tenant_id,p_actor_id),p_bound_payload_sha256,c.id,p_factor_id,c.expires_at,now_at);
 return jsonb_build_object('id',c.id,'expires_at',c.expires_at,'max_attempts',c.max_attempts);
end $$;
create function public.satisfy_data_flow_declaration_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_satisfied_with text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'data flow declaration MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'data flow declaration MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_satisfied_with is null or p_satisfied_with not in ('totp','recovery_code') then raise exception 'data flow declaration MFA input refused' using errcode='22023';end if;

 perform controller_security.flow174_human(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,174));
 if exists(select 1 from controller_security.flow174_fences where operation_key=p_operation_key)
  or not exists(select 1 from controller_security.flow174_mfa d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id and d.factor_id=p_factor_id and d.authority_sha256=controller_security.flow174_authority(p_tenant_id,p_actor_id))
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id) or not controller_security.flow174_prepare_allowed(p_tenant_id,p_actor_id)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'data flow declaration MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'data_flow_declaration'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or not exists(select 1 from controller_security.flow174_mfa d where d.operation_key=p_operation_key and d.factor_id=c.factor_id and d.created_at=c.created_at and d.challenge_expires_at=c.expires_at)
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'data flow declaration MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is not null or c.satisfied_with is not null then raise exception 'data flow declaration MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set satisfied_at=now_at,satisfied_with=p_satisfied_with where id=c.id and attempts=p_expected_attempts and satisfied_at is null and consumed_at is null returning * into c;
 if not found then raise exception 'data flow declaration MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'satisfied_with',c.satisfied_with);
end $$;
create function public.consume_data_flow_declaration_mfa_challenge(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_factor_id uuid,p_operation_key uuid,p_bound_payload_sha256 text,p_challenge_id uuid,p_expected_attempts integer,p_consumed_for uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare now_at timestamptz;c public.mfa_challenges;
begin

 if current_setting('role',true) is distinct from 'service_role' then raise exception 'data flow declaration MFA service required' using errcode='42501';end if;
 if p_tenant_id is null or p_actor_id is null or p_session_id is null or p_factor_id is null or p_operation_key is null
  or p_bound_payload_sha256 is null or p_bound_payload_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'data flow declaration MFA input refused' using errcode='22023';end if;

 if p_challenge_id is null or p_expected_attempts is null or p_expected_attempts<1 or p_consumed_for is null or p_consumed_for is distinct from p_operation_key then raise exception 'data flow declaration MFA input refused' using errcode='22023';end if;

 perform controller_security.flow174_human(p_tenant_id,p_actor_id,p_session_id);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for no key update;
 perform 1 from public.tenants where id=p_tenant_id for share;
 perform 1 from auth.sessions where id=p_session_id and user_id=p_actor_id for share;
 perform 1 from public.user_mfa_factors where user_id=p_actor_id and factor_type='totp' order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation_key::text,174));
 if exists(select 1 from controller_security.flow174_fences where operation_key=p_operation_key)
  or not exists(select 1 from controller_security.flow174_mfa d where d.operation_key=p_operation_key and d.tenant_id=p_tenant_id and d.actor_id=p_actor_id and d.session_id=p_session_id and d.binding_sha256=p_bound_payload_sha256 and d.challenge_id=p_challenge_id and d.factor_id=p_factor_id and d.authority_sha256=controller_security.flow174_authority(p_tenant_id,p_actor_id))
 then raise exception 'scope decision refused' using errcode='42501';end if;
 select * into c from public.mfa_challenges where id=p_challenge_id for update;
 now_at:=clock_timestamp();

 if not exists(select 1 from public.tenants where id=p_tenant_id) or not controller_security.flow174_prepare_allowed(p_tenant_id,p_actor_id)
  or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_actor_id and (not_after is null or not_after>now_at))
  or not exists(select 1 from public.user_mfa_factors where id=p_factor_id and user_id=p_actor_id and factor_type='totp' and status='active' and revoked_at is null)
 then raise exception 'data flow declaration MFA scope refused' using errcode='42501';end if;

 if c.id is null or c.user_id is distinct from p_actor_id or c.tenant_id is distinct from p_tenant_id
  or c.factor_id is distinct from p_factor_id or c.purpose::text is distinct from 'data_flow_declaration'
  or c.bound_resource_ref is distinct from p_operation_key::text or c.bound_payload_sha256 is distinct from p_bound_payload_sha256
  or c.attempts is distinct from p_expected_attempts or c.attempts<1 or c.attempts>c.max_attempts
  or not exists(select 1 from controller_security.flow174_mfa d where d.operation_key=p_operation_key and d.factor_id=c.factor_id and d.created_at=c.created_at and d.challenge_expires_at=c.expires_at)
  or c.created_at>now_at or c.expires_at<=c.created_at or c.expires_at>c.created_at+interval '5 minutes' or c.expires_at<=now_at
  or c.consumed_at is not null
 then raise exception 'data flow declaration MFA challenge refused' using errcode='42501';end if;
 if c.satisfied_at is null or c.satisfied_with not in ('totp','recovery_code') or c.satisfied_with is null
  or c.satisfied_at<c.created_at or c.satisfied_at>now_at or c.satisfied_at<=now_at-interval '5 minutes'
 then raise exception 'data flow declaration MFA challenge refused' using errcode='42501';end if;
 update public.mfa_challenges set consumed_at=now_at,consumed_for=p_consumed_for::text where id=c.id and attempts=p_expected_attempts and satisfied_at is not null and consumed_at is null returning * into c;
 if not found then raise exception 'data flow declaration MFA challenge refused' using errcode='42501';end if;
 return jsonb_build_object('id',c.id,'satisfied_at',c.satisfied_at,'expires_at',c.expires_at,'factor_id',c.factor_id);
end $$;
revoke all on function public.issue_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.issue_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.satisfy_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.satisfy_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text) to service_role;
revoke all on function public.consume_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.consume_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid) to service_role;



do $$declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
 (n.nspname='controller_security'and p.proname like 'flow174_%')or(n.nspname='public'and p.proname in('preflight_data_flow_declaration','read_data_flow_declaration_operation','record_data_flow_declaration','fence_data_flow_declaration','data_flow_declaration_context','issue_data_flow_declaration_mfa_challenge','satisfy_data_flow_declaration_mfa_challenge','consume_data_flow_declaration_mfa_challenge'))loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer',f.signature);
 end loop;
end $$;
grant execute on function public.preflight_data_flow_declaration(uuid,uuid,uuid,text),public.read_data_flow_declaration_operation(uuid,uuid,uuid,text),public.data_flow_declaration_context(uuid,uuid,uuid,uuid)to service_role;
grant execute on function public.record_data_flow_declaration(uuid,uuid,uuid,text,uuid),public.fence_data_flow_declaration(uuid,uuid,uuid,text)to human_action_writer;
grant execute on function public.issue_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,integer),public.satisfy_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,text),public.consume_data_flow_declaration_mfa_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,uuid)to service_role;
