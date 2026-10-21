-- Catalogue release is global; an organization's audited basis changes only by
-- a new, genuinely finalized assessment. No historical result/report is updated.
alter type public.ledger_action_type add value if not exists 'catalogue.reaudit_requested';
alter type public.ledger_action_type add value if not exists 'catalogue.reaudit_decided';
create table public.catalogue_reaudit_requests (
 id uuid primary key, tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id), session_id uuid not null,
 baseline_run_id uuid not null references public.workload_assessment_packets(run_id),
 target_version text not null references public.approved_catalogue_versions(library_version),
 delta_sha256 text not null check(delta_sha256 ~ '^[a-f0-9]{64}$'),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 request_text text not null, challenge_id uuid not null unique references public.mfa_challenges(id),
 receipt_id bigint not null references public.audit_ledger(id), requested_at timestamptz not null default clock_timestamp()
);
create table public.catalogue_reaudit_decisions (
 request_id uuid primary key references public.catalogue_reaudit_requests(id),
 operation_key uuid not null unique, tenant_id uuid not null references public.tenants(id),
 actor_id uuid not null references public.users(id), session_id uuid not null,
 decision text not null check(decision in('approve','reject')),
 reason text not null check(length(btrim(reason)) between 1 and 2000), request_text text not null,
 challenge_id uuid not null unique references public.mfa_challenges(id),
 engagement_id uuid unique references public.engagements(id) deferrable initially deferred,
 receipt_id bigint not null references public.audit_ledger(id), decided_at timestamptz not null default clock_timestamp(),
 check((decision='approve')=(engagement_id is not null))
);
create table public.catalogue_engagement_admissions (
 engagement_id uuid primary key references public.engagements(id) deferrable initially deferred,
 tenant_id uuid not null references public.tenants(id), library_version text not null references public.control_libraries(version),
 basis text not null check(basis in('legacy_existing','privileged_import','current_default','retained_audited_version','founder_reaudit_grant')),
 request_id uuid references public.catalogue_reaudit_requests(id), recorded_at timestamptz not null default clock_timestamp()
);
create table public.catalogue_initial_releases(library_version text primary key references public.approved_catalogue_versions(library_version));
insert into public.catalogue_initial_releases select a.library_version from public.approved_catalogue_versions a join public.control_libraries l on l.version=a.library_version where l.is_current;
do $$declare n text;begin
 foreach n in array array['catalogue_reaudit_requests','catalogue_reaudit_decisions','catalogue_engagement_admissions','catalogue_initial_releases']loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer',n);
  execute format('create trigger %I before update or delete or truncate on public.%I for each statement execute function public.evidence_receipt_immutable()',n||'_immutable',n);
 end loop;
end $$;
-- Backfill after this relation's DDL so populated upgrades do not carry
-- deferred FK trigger events across ALTER TABLE or CREATE TRIGGER.
-- Grandfather only exact retained engagements, not a fabricated audited result.
insert into public.catalogue_engagement_admissions(engagement_id,tenant_id,library_version,basis)
 select id,tenant_id,library_version,'legacy_existing' from public.engagements;

create function controller_security.catalogue178_authority(t uuid,a uuid,s uuid,wanted text default null)returns void
language plpgsql security definer set search_path=''as $$
begin
 if not exists(select 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp()))
 or not exists(select 1 from public.tenant_users where tenant_id=t and user_id=a and(wanted is null or role::text=wanted))
 then raise exception 'live catalogue membership/session required'using errcode='42501';end if;
 perform 1 from public.tenant_users where tenant_id=t and user_id=a for share;
 perform 1 from auth.sessions where id=s and user_id=a for share;
 if wanted='founder'then
  perform controller_security.catalogue161_authority(t,a,s);
  if not public.is_live_platform_founder(a)then raise exception 'live platform founder required'using errcode='42501';end if;
 end if;
 if exists(select 1 from public.kill_switch_state where engaged and(scope='global'or tenant_id=t))then raise exception 'catalogue mutations halted'using errcode='42501';end if;
end $$;

create function controller_security.catalogue178_released(v text)returns boolean
language sql stable security definer set search_path=''as $$
 select exists(select 1 from public.approved_catalogue_versions a join public.control_libraries l on l.version=a.library_version
 where a.library_version=v and l.status='published'and(l.is_current or exists(select 1 from public.catalogue_initial_releases b where b.library_version=v) or exists(select 1 from public.catalogue_current_version_events e where e.library_version=v)))
$$;
create function controller_security.catalogue178_baselines(t uuid)returns table(run_id uuid,engagement_id uuid,estate_id uuid,library_version text,finalized_at timestamptz)
language sql security definer set search_path=''as $$
 select p.run_id,p.engagement_id,e.estate_id,p.library_version,p.finalized_at from public.workload_assessment_packets p
 join public.engagements e on(e.tenant_id,e.id)=(p.tenant_id,p.engagement_id)
 where p.tenant_id=t and p.finalized_receipt is not null and p.finalized_at is not null
 and public.board_assessment_source_valid(t,p.run_id,p.engagement_id)
$$;

create function controller_security.catalogue178_delta(old_version text,new_version text)returns jsonb
language plpgsql security definer set search_path=''as $$
declare added jsonb;removed jsonb;changed jsonb;body jsonb;
begin
 perform controller_security.catalogue161_fingerprint(new_version);
 if old_version is not null then perform controller_security.catalogue161_fingerprint(old_version);end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'title',n.title)order by n.id),'[]')into added from public.controls n
 where n.library_version=new_version and not exists(select 1 from public.controls o where o.library_version=old_version and o.id=n.id);
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'title',o.title)order by o.id),'[]')into removed from public.controls o
 where o.library_version=old_version and not exists(select 1 from public.controls n where n.library_version=new_version and n.id=o.id);
 select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'title',n.title,'fields',d.fields)order by n.id),'[]')into changed
 from public.controls n join public.controls o on o.id=n.id and o.library_version=old_version
 cross join lateral(select jsonb_agg(k order by k)fields from jsonb_object_keys(to_jsonb(n)-array['library_version','created_at'])k
 where(to_jsonb(n)->k)is distinct from(to_jsonb(o)->k))d
 where n.library_version=new_version and d.fields is not null;
 body:=jsonb_build_object('previousVersion',old_version,'targetVersion',new_version,'added',added,'removed',removed,'changed',changed);
 return(body-'targetVersion')||jsonb_build_object('sha256',encode(sha256(convert_to(controller_security.canonical_questionnaire_json(body),'UTF8')),'hex'));
end $$;

create function public.read_catalogue_engagement(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare current_version text;effective text;released jsonb;baselines jsonb;upgrades jsonb;requests jsonb;historical boolean;
begin
 perform controller_security.catalogue178_authority(p_tenant_id,p_actor_id,p_session_id);
 select version into strict current_version from public.control_libraries where is_current and status='published';
 if not controller_security.catalogue178_released(current_version)then raise exception 'released current catalogue required'using errcode='23514';end if;
 select coalesce(jsonb_agg(jsonb_build_object('libraryVersion',v.version,'changeLog',v.change_log,'publishedAt',v.published_at,
 'delta',controller_security.catalogue178_delta(v.previous,v.version))order by v.published_at),'[]')into released
 from(select l.*,lag(l.version)over(order by l.published_at,l.version)previous from public.control_libraries l
 where controller_security.catalogue178_released(l.version))v;
 select coalesce(jsonb_agg(jsonb_build_object('runId',b.run_id,'engagementId',b.engagement_id,'estateId',b.estate_id,'libraryVersion',b.library_version,'finalizedAt',b.finalized_at)order by b.finalized_at desc,b.run_id),'[]')into baselines
 from controller_security.catalogue178_baselines(p_tenant_id)b;
 select b.library_version into effective from controller_security.catalogue178_baselines(p_tenant_id)b order by b.finalized_at desc,b.run_id limit 1;
 historical:=not exists(select 1 from controller_security.catalogue178_baselines(p_tenant_id))and exists(select 1 from public.engagements where tenant_id=p_tenant_id and(status::text='completed'or completed_at is not null));
 if historical then select library_version into effective from public.engagements where tenant_id=p_tenant_id and(status::text='completed'or completed_at is not null)order by completed_at desc nulls last,created_at desc,id limit 1;end if;
 select coalesce(jsonb_agg(jsonb_build_object('baselineRunId',b.run_id,'targetVersion',l.version,'delta',controller_security.catalogue178_delta(b.library_version,l.version))order by b.finalized_at desc,l.published_at),'[]')into upgrades
 from controller_security.catalogue178_baselines(p_tenant_id)b cross join public.control_libraries l
 where controller_security.catalogue178_released(l.version)and string_to_array(l.version,'.')::integer[]>string_to_array(b.library_version,'.')::integer[]
 and not exists(select 1 from controller_security.catalogue178_baselines(p_tenant_id)newer where newer.estate_id is not distinct from b.estate_id and string_to_array(newer.library_version,'.')::integer[]>=string_to_array(l.version,'.')::integer[]);
 select coalesce(jsonb_agg(jsonb_build_object('requestId',r.id,'baselineRunId',r.baseline_run_id,'targetVersion',r.target_version,'deltaSha256',r.delta_sha256,
 'ownerReason',r.reason,'requestedAt',r.requested_at,'status',coalesce(case d.decision when'approve'then'approved'when'reject'then'rejected'end,'pending'),
 'decisionReason',d.reason,'engagementId',d.engagement_id,'ownerReceiptId',r.receipt_id::text,'decisionReceiptId',d.receipt_id::text)order by r.requested_at desc,r.id),'[]')into requests
 from public.catalogue_reaudit_requests r left join public.catalogue_reaudit_decisions d on d.request_id=r.id where r.tenant_id=p_tenant_id;
 return jsonb_build_object('currentVersion',current_version,'releasedVersions',released,'auditedBaselines',baselines,'upgradeOptions',upgrades,'requests',requests,
 'effectiveVersion',coalesce(effective,current_version),'hasFinalizedAudit',jsonb_array_length(baselines)>0,'requiresOwnerRequest',historical or jsonb_array_length(upgrades)>0,'historicalAuditNeedsReview',historical);
end $$;

create function public.preflight_catalogue_reaudit(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_decision boolean)returns jsonb
language plpgsql security definer set search_path=''as $$
declare r jsonb;baseline record;original public.catalogue_reaudit_requests;delta jsonb;wanted text;
begin
 if p_decision is null then raise exception 'decision classification required'using errcode='22023';end if;
 wanted:=case when p_decision then'founder'else'owner'end;
 perform controller_security.catalogue178_authority(p_tenant_id,p_actor_id,p_session_id,wanted);
 if p_request_text is null or octet_length(p_request_text)>8192 then raise exception 'bounded catalogue request required'using errcode='22023';end if;
 r:=p_request_text::jsonb;
 if jsonb_typeof(r)is distinct from'object'or controller_security.canonical_questionnaire_json(r)is distinct from p_request_text
 or r->'version'is distinct from'1'::jsonb or r->'confirmed'is distinct from'true'::jsonb
 or jsonb_typeof(r->'operationKey')is distinct from'string'or r->>'operationKey'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or jsonb_typeof(r->'reason')is distinct from'string'or length(btrim(r->>'reason'))not between 1 and 2000
 then raise exception 'catalogue request refused'using errcode='22023';end if;
 if p_decision then
  if(select count(*)from jsonb_object_keys(r))<>6 or r-array['version','operationKey','requestId','decision','reason','confirmed']<>'{}'::jsonb
  or jsonb_typeof(r->'decision')is distinct from'string'or r->>'decision'not in('approve','reject')then raise exception 'decision refused'using errcode='22023';end if;
  select *into original from public.catalogue_reaudit_requests where tenant_id=p_tenant_id and id=(r->>'requestId')::uuid;
  if not found or not exists(select 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=original.actor_id and role='owner')then raise exception 'live owner request required'using errcode='42501';end if;
  select *into baseline from controller_security.catalogue178_baselines(p_tenant_id)where run_id=original.baseline_run_id;
  if not found or not controller_security.catalogue178_released(original.target_version)then raise exception 'reaudit source unavailable'using errcode='23514';end if;
  delta:=controller_security.catalogue178_delta(baseline.library_version,original.target_version);
  if delta->>'sha256'is distinct from original.delta_sha256 then raise exception 'catalogue delta changed'using errcode='23514';end if;
 else
  if(select count(*)from jsonb_object_keys(r))<>7 or r-array['version','operationKey','baselineRunId','targetVersion','deltaSha256','reason','confirmed']<>'{}'::jsonb
  then raise exception 'owner request refused'using errcode='22023';end if;
  select *into baseline from controller_security.catalogue178_baselines(p_tenant_id)where run_id=(r->>'baselineRunId')::uuid;
  if not found or not controller_security.catalogue178_released(r->>'targetVersion')or string_to_array(r->>'targetVersion','.')::integer[]<=string_to_array(baseline.library_version,'.')::integer[]
  then raise exception 'released upgrade and finalized baseline required'using errcode='23514';end if;
  delta:=controller_security.catalogue178_delta(baseline.library_version,r->>'targetVersion');
  if delta->>'sha256'is distinct from r->>'deltaSha256'then raise exception 'catalogue delta changed'using errcode='23514';end if;
 end if;
 if not exists(select 1 from public.catalogue_reaudit_requests q where q.id=(r->>'operationKey')::uuid and not p_decision and q.request_text=p_request_text)
 and not exists(select 1 from public.catalogue_reaudit_decisions d where d.operation_key=(r->>'operationKey')::uuid and p_decision and d.request_text=p_request_text)
 and exists(select 1 from controller_security.catalogue178_baselines(p_tenant_id)newer where newer.estate_id is not distinct from baseline.estate_id
 and string_to_array(newer.library_version,'.')::integer[]>=string_to_array(case when p_decision then original.target_version else r->>'targetVersion'end,'.')::integer[])
 then raise exception 'target already genuinely audited; source is stale'using errcode='23514';end if;
 return jsonb_build_object('authorized',true,'requestSha256',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'));
end $$;

create function controller_security.catalogue178_mfa(t uuid,a uuid,s uuid,r jsonb,txt text,ch uuid,decision boolean)returns void
language plpgsql security definer set search_path=''as $$
declare c public.mfa_challenges;n timestamptz;binding text;
begin
 binding:=encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_build_array(case when decision then'axiom.catalogue-reaudit.decision'else'axiom.catalogue-reaudit.request'end,1,t::text,a::text,s::text,encode(sha256(convert_to(txt,'UTF8')),'hex'))),'UTF8')),'hex');
 perform 1 from public.user_mfa_factors where user_id=a and factor_type='totp'order by id for update;
 select *into c from public.mfa_challenges where id=ch for update;n:=clock_timestamp();
 if c.id is null or c.user_id is distinct from a or c.tenant_id is distinct from t or c.purpose::text is distinct from'catalogue_adoption'
 or c.bound_resource_ref is distinct from r->>'operationKey'or c.bound_payload_sha256 is distinct from binding or c.consumed_for is distinct from r->>'operationKey'
 or c.satisfied_with::text is distinct from'totp'or c.satisfied_at is null or c.consumed_at is null or c.created_at>c.satisfied_at or c.expires_at>c.created_at+interval'5 minutes'
 or c.satisfied_at>n or c.satisfied_at<=n-interval'5 minutes'or c.expires_at<=n or c.consumed_at<c.satisfied_at or c.consumed_at>n
 or not exists(select 1 from public.user_mfa_factors where id=c.factor_id and user_id=a and factor_type='totp'and status='active'and revoked_at is null)
 or exists(select 1 from public.catalogue_reaudit_requests where challenge_id=ch)or exists(select 1 from public.catalogue_reaudit_decisions where challenge_id=ch)
 or not exists(select 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>n))
 then raise exception 'fresh catalogue MFA required'using errcode='42501';end if;
end $$;

create function public.submit_catalogue_reaudit(p_tenant_id uuid,p_actor_id uuid,p_session_id uuid,p_request_text text,p_challenge_id uuid,p_decision boolean)returns jsonb
language plpgsql security definer set search_path=''as $$
declare r jsonb;request_row public.catalogue_reaudit_requests;decision_row public.catalogue_reaudit_decisions;baseline record;receipt bigint;eng uuid;status text;
begin
 if current_setting('role',true)is distinct from'human_action_writer'then raise exception 'human catalogue writer required'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('axiom.catalogue-reaudit:'||p_tenant_id::text,178));
 perform public.preflight_catalogue_reaudit(p_tenant_id,p_actor_id,p_session_id,p_request_text,p_decision);r:=p_request_text::jsonb;
 if p_decision then
  select *into decision_row from public.catalogue_reaudit_decisions where operation_key=(r->>'operationKey')::uuid;
  if found then
   if decision_row.tenant_id<>p_tenant_id or decision_row.actor_id<>p_actor_id or decision_row.session_id<>p_session_id or decision_row.request_text<>p_request_text then raise exception 'decision replay conflict'using errcode='23505';end if;
   return jsonb_build_object('requestId',decision_row.request_id,'status',case decision_row.decision when'approve'then'approved'else'rejected'end,'engagementId',decision_row.engagement_id,'receiptId',decision_row.receipt_id::text,'replayed',true);
  end if;
  select *into request_row from public.catalogue_reaudit_requests where tenant_id=p_tenant_id and id=(r->>'requestId')::uuid;
  if exists(select 1 from public.catalogue_reaudit_decisions where request_id=request_row.id)then raise exception 'request already decided'using errcode='23505';end if;
  select *into strict baseline from controller_security.catalogue178_baselines(p_tenant_id)where run_id=request_row.baseline_run_id;
  perform controller_security.catalogue178_mfa(p_tenant_id,p_actor_id,p_session_id,r,p_request_text,p_challenge_id,true);
  if r->>'decision'='approve'then eng:=gen_random_uuid();end if;
  status:=case r->>'decision'when'approve'then'approved'else'rejected'end;
  receipt:=public.append_ledger(p_tenant_id,(r->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'catalogue.reaudit_decided',request_row.id::text,encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),request_row.delta_sha256,null,null,null,null,'success',jsonb_build_object('decision',r->>'decision','reason',r->>'reason','owner_receipt_id',request_row.receipt_id::text,'new_engagement_id',eng,'target_version',request_row.target_version));
  -- Only this private forward reference is temporarily deferred. Validate it
  -- immediately after the atomic parent insertion even if the caller selected
  -- ALL IMMEDIATE; unrelated constraints and all failure rollbacks stay intact.
  if eng is not null then set constraints public.catalogue_reaudit_decisions_engagement_id_fkey deferred;end if;
  insert into public.catalogue_reaudit_decisions values(request_row.id,(r->>'operationKey')::uuid,p_tenant_id,p_actor_id,p_session_id,r->>'decision',r->>'reason',p_request_text,p_challenge_id,eng,receipt,clock_timestamp());
  if eng is not null then
   insert into public.engagements(id,tenant_id,estate_id,library_version,title,lead_reviewer_id,status)
   values(eng,p_tenant_id,baseline.estate_id,request_row.target_version,'Catalogue delta re-audit — awaiting assessment',p_actor_id,'intake');
   set constraints public.catalogue_reaudit_decisions_engagement_id_fkey immediate;
  end if;
 else
  select *into request_row from public.catalogue_reaudit_requests where id=(r->>'operationKey')::uuid;
  if found then
   if request_row.tenant_id<>p_tenant_id or request_row.actor_id<>p_actor_id or request_row.session_id<>p_session_id or request_row.request_text<>p_request_text then raise exception 'owner replay conflict'using errcode='23505';end if;
   select *into decision_row from public.catalogue_reaudit_decisions where request_id=request_row.id;
   return jsonb_build_object('requestId',request_row.id,'status',coalesce(case decision_row.decision when'approve'then'approved'when'reject'then'rejected'end,'pending'),'engagementId',decision_row.engagement_id,'receiptId',request_row.receipt_id::text,'replayed',true);
  end if;
  if exists(select 1 from public.catalogue_reaudit_requests q left join public.catalogue_reaudit_decisions d on d.request_id=q.id where q.tenant_id=p_tenant_id and q.baseline_run_id=(r->>'baselineRunId')::uuid and q.target_version=r->>'targetVersion'and(d.decision is null or d.decision='approve'))then raise exception 'existing pending or approved re-audit request'using errcode='23505';end if;
  perform controller_security.catalogue178_mfa(p_tenant_id,p_actor_id,p_session_id,r,p_request_text,p_challenge_id,false);
  receipt:=public.append_ledger(p_tenant_id,(r->>'operationKey')::uuid,'human',p_actor_id::text,null,null,null,'catalogue.reaudit_requested',r->>'baselineRunId',encode(sha256(convert_to(p_request_text,'UTF8')),'hex'),r->>'deltaSha256',null,null,null,null,'success',jsonb_build_object('reason',r->>'reason','target_version',r->>'targetVersion','baseline_run_id',r->>'baselineRunId'));
  insert into public.catalogue_reaudit_requests values((r->>'operationKey')::uuid,p_tenant_id,p_actor_id,p_session_id,(r->>'baselineRunId')::uuid,r->>'targetVersion',r->>'deltaSha256',r->>'reason',p_request_text,p_challenge_id,receipt,clock_timestamp());
  return jsonb_build_object('requestId',(r->>'operationKey')::uuid,'status','pending','engagementId',null,'receiptId',receipt::text,'replayed',false);
 end if;
 return jsonb_build_object('requestId',request_row.id,'status',status,'engagementId',eng,'receiptId',receipt::text,'replayed',false);
end $$;

create function controller_security.catalogue178_admit_engagement()returns trigger
language plpgsql security definer set search_path=''as $$
declare basis text;request_id uuid;current_version text;has_baseline boolean;historical boolean;
begin
 if tg_op='UPDATE'and(new.id,new.tenant_id,new.estate_id,new.library_version)is not distinct from(old.id,old.tenant_id,old.estate_id,old.library_version)then return new;end if;
 -- Existing onboarding permits first attaching estate metadata before
 -- any assessment authority exists. A founder-granted re-audit is already scoped.
 if tg_op='UPDATE'and(new.id,new.tenant_id,new.library_version)is not distinct from(old.id,old.tenant_id,old.library_version)
 and old.estate_id is null and new.estate_id is not null
 and old.status::text='intake'and new.status::text='intake'
 and not exists(select 1 from public.catalogue_engagement_admissions a where a.engagement_id=old.id and a.basis='founder_reaudit_grant')
 -- Read-only public discovery/classification preserves its original NULL
 -- estate snapshot; it does not authorize an assessment or mutable task.
 and not exists(select 1 from public.agent_runs r where r.tenant_id=old.tenant_id and r.engagement_id=old.id and r.agent not in('drishti','vibhaag'))
 and not exists(select 1 from public.workload_task_delegations d where d.tenant_id=old.tenant_id and d.engagement_id=old.id)
 and not exists(select 1 from public.assessment_dispatch_jobs j where j.tenant_id=old.tenant_id and j.engagement_id=old.id)
 and not exists(select 1 from public.reports r where r.tenant_id=old.tenant_id and r.engagement_id=old.id)
 then return new;end if;
 if tg_op='UPDATE'then raise exception 'engagement catalogue basis is immutable; create a new engagement'using errcode='23514';end if;
 -- Explicit database-administrator import is distinct from application authority.
 -- SECURITY DEFINER changes current_user, not session_user or the API SET ROLE.
 -- REST authenticator/human/service/agent roles cannot select this branch.
 if current_setting('role',true)='none'and session_user in('postgres','supabase_admin')and exists(select 1 from pg_roles where rolname=session_user and(rolsuper or(rolcreaterole and rolcreatedb)))then
  insert into public.catalogue_engagement_admissions(engagement_id,tenant_id,library_version,basis)values(new.id,new.tenant_id,new.library_version,'privileged_import');
  return new;
 end if;

 select d.request_id into request_id from public.catalogue_reaudit_decisions d join public.catalogue_reaudit_requests r on r.id=d.request_id
 join controller_security.catalogue178_baselines(new.tenant_id)b on b.run_id=r.baseline_run_id
 where d.tenant_id=new.tenant_id and d.engagement_id=new.id and d.decision='approve'and r.target_version=new.library_version and b.estate_id is not distinct from new.estate_id;
 if request_id is not null then basis:='founder_reaudit_grant';
 else
  select exists(select 1 from controller_security.catalogue178_baselines(new.tenant_id))into has_baseline;
  historical:=exists(select 1 from public.engagements where tenant_id=new.tenant_id and(status::text='completed'or completed_at is not null));
  if has_baseline or historical then
   if not exists(select 1 from controller_security.catalogue178_baselines(new.tenant_id)b where b.library_version=new.library_version)then raise exception 'owner request and founder re-audit approval required'using errcode='42501';end if;
   basis:='retained_audited_version';
  else
   select version into current_version from public.control_libraries where is_current;
   if new.library_version is distinct from current_version or not controller_security.catalogue178_released(current_version)then raise exception 'unaudited organization requires released current catalogue'using errcode='42501';end if;
   basis:='current_default';
  end if;
 end if;
 insert into public.catalogue_engagement_admissions(engagement_id,tenant_id,library_version,basis,request_id)values(new.id,new.tenant_id,new.library_version,basis,request_id);
 return new;
end $$;
-- INSERT authorization still rolls back the whole statement on refusal; AFTER
-- ensures the parent exists before its admission FK even under ALL IMMEDIATE.
create trigger catalogue178_engagement_admission after insert on public.engagements for each row execute function controller_security.catalogue178_admit_engagement();
create trigger catalogue178_engagement_scope before update of id,tenant_id,estate_id,library_version on public.engagements for each row execute function controller_security.catalogue178_admit_engagement();
create function controller_security.catalogue178_dispatch_guard()returns trigger
language plpgsql security definer set search_path=''as $$
begin
 if not exists(select 1 from public.catalogue_engagement_admissions a join public.engagements e on e.id=a.engagement_id and e.tenant_id=a.tenant_id
 where a.tenant_id=new.tenant_id and a.engagement_id=new.engagement_id and a.library_version=e.library_version and e.estate_id is not distinct from new.estate_id)then raise exception 'catalogue engagement admission required'using errcode='42501';end if;
 return new;
end $$;
create trigger catalogue178_dispatch_admission before insert on public.assessment_dispatch_jobs for each row execute function controller_security.catalogue178_dispatch_guard();

revoke all on function controller_security.catalogue178_authority(uuid,uuid,uuid,text),controller_security.catalogue178_released(text),controller_security.catalogue178_baselines(uuid),controller_security.catalogue178_delta(text,text),controller_security.catalogue178_mfa(uuid,uuid,uuid,jsonb,text,uuid,boolean),controller_security.catalogue178_admit_engagement(),controller_security.catalogue178_dispatch_guard()from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
revoke all on function public.read_catalogue_engagement(uuid,uuid,uuid),public.preflight_catalogue_reaudit(uuid,uuid,uuid,text,boolean)from public,anon,authenticated,agent_ledger_writer;
grant execute on function public.read_catalogue_engagement(uuid,uuid,uuid),public.preflight_catalogue_reaudit(uuid,uuid,uuid,text,boolean)to service_role,human_action_writer;
revoke all on function public.submit_catalogue_reaudit(uuid,uuid,uuid,text,uuid,boolean)from public,anon,authenticated,service_role,agent_ledger_writer;
grant execute on function public.submit_catalogue_reaudit(uuid,uuid,uuid,text,uuid,boolean)to human_action_writer;

-- All ordinary creation uses the audited SECURITY DEFINER intake/onboarding RPCs.
revoke insert on public.engagements from anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
