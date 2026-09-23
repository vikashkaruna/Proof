-- Trusted backend policy publication and transactional controller fencing.
-- No key removal, cloud administration or client execution authority is added.
alter type public.ledger_action_type add value if not exists 'workload.dispatch_policy_published';
create table public.assessment_dispatch_key_policies (
 tenant_id uuid primary key references public.tenants(id) on delete restrict,
 revision integer not null check(revision>0),
 provider text not null check(provider in ('aws','gcp')),
 primary_ref text not null,
 readable_refs text[] not null,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 receipt bigint not null references public.audit_ledger(id) on delete restrict,
 updated_at timestamptz not null default clock_timestamp()
);
alter table public.assessment_dispatch_key_policies enable row level security;
revoke all on public.assessment_dispatch_key_policies from public,anon,authenticated,service_role;
grant select on public.assessment_dispatch_key_policies to service_role;
create policy backend_dispatch_policy_read on public.assessment_dispatch_key_policies for select to service_role using(true);

create function public.publish_assessment_dispatch_key_policy(
 p_tenant_id uuid,p_actor_id uuid,p_correlation_id uuid,p_expected_revision integer,
 p_provider text,p_primary_ref text,p_readable_refs text[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.assessment_dispatch_key_policies; refs text[]; digest text; receipt bigint; revision integer; pattern text;
begin
 if p_tenant_id is null or p_actor_id is null or p_correlation_id is null or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>=2147483647
  or p_provider is null or p_provider not in ('aws','gcp') or p_primary_ref is null
  or p_readable_refs is null or cardinality(p_readable_refs) not between 1 and 10 or coalesce(array_ndims(p_readable_refs),1)<>1
  or array_position(p_readable_refs,null) is not null or not (p_primary_ref=any(p_readable_refs))
  or cardinality(p_readable_refs)<>(select count(distinct k) from unnest(p_readable_refs) k)
 then return jsonb_build_object('error','policy_refused'); end if;
 pattern:=case p_provider when 'aws' then '^arn:aws:kms:ap-south-1:[0-9]{12}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  else '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/asia-south1/keyRings/[a-zA-Z0-9_-]{1,63}/cryptoKeys/[a-zA-Z0-9_-]{1,63}$' end;
 if exists(select 1 from unnest(p_readable_refs) k where length(k)>500 or k ~ '[[:space:]]' or k !~ pattern)
 then return jsonb_build_object('error','policy_refused'); end if;
 select array_agg(k order by k collate "C") into refs from unnest(p_readable_refs) k;
 digest:=encode(sha256(convert_to('axiom.dispatch.key-policy.v1'||chr(10)||p_tenant_id::text||chr(10)||p_provider||chr(10)||p_primary_ref||chr(10)||array_to_string(refs,chr(10)),'UTF8')),'hex');
 -- Global publication lock prevents one resource being assigned to two tenants.
 -- Per-tenant exclusive lock also fences the previously ABSENT-policy case.
 perform pg_advisory_xact_lock(474747);
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,47));
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id for share;
 perform 1 from public.users where id=p_actor_id for share;
 if not exists(select 1 from public.tenant_users m join public.users u on u.id=m.user_id
  where m.tenant_id=p_tenant_id and m.user_id=p_actor_id and (m.role in ('owner','admin') or (m.role='founder' and u.is_axiom_internal)))
 then return jsonb_build_object('error','policy_forbidden'); end if;
 select * into old from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id for update;
 if old.tenant_id is not null and old.fingerprint=digest and p_expected_revision in(old.revision,old.revision-1)
 then return jsonb_build_object('tenantId',p_tenant_id,'revision',old.revision,'fingerprint',old.fingerprint,'receipt',old.receipt::text); end if;
 if p_expected_revision<>coalesce(old.revision,0)
 then return jsonb_build_object('error','policy_conflict'); end if;
 if old.tenant_id is not null and (old.provider<>p_provider or not (old.readable_refs <@ refs) or not (p_primary_ref=any(old.readable_refs)))
 then return jsonb_build_object('error','policy_transition_refused'); end if;
 if exists(select 1 from public.assessment_dispatch_key_policies where tenant_id<>p_tenant_id and readable_refs && refs)
  or exists(select 1 from public.assessment_dispatch_jobs where tenant_id<>p_tenant_id and key_ref=any(refs))
  or exists(select 1 from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and not (key_ref=any(refs)))
 then return jsonb_build_object('error','policy_keys_required'); end if;
 revision:=coalesce(old.revision,0)+1;
 receipt:=public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,null,null,null,
  'workload.dispatch_policy_published',p_tenant_id::text,null,digest,null,null,null,null,'success',
  jsonb_build_object('revision',revision,'provider',p_provider,'primary_ref',p_primary_ref,'readable_refs',refs,'previous_fingerprint',old.fingerprint));
 insert into public.assessment_dispatch_key_policies(tenant_id,revision,provider,primary_ref,readable_refs,fingerprint,receipt)
 values(p_tenant_id,revision,p_provider,p_primary_ref,refs,digest,receipt)
 on conflict(tenant_id) do update set revision=excluded.revision,provider=excluded.provider,primary_ref=excluded.primary_ref,
  readable_refs=excluded.readable_refs,fingerprint=excluded.fingerprint,receipt=excluded.receipt,updated_at=clock_timestamp();
 return jsonb_build_object('tenantId',p_tenant_id,'revision',revision,'fingerprint',digest,'receipt',receipt::text);
end $$;
revoke all on function public.publish_assessment_dispatch_key_policy(uuid,uuid,uuid,integer,text,text,text[]) from public,anon,authenticated;
grant execute on function public.publish_assessment_dispatch_key_policy(uuid,uuid,uuid,integer,text,text,text[]) to service_role;

alter function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea) rename to enqueue_assessment_dispatch_unfenced;
revoke all on function public.enqueue_assessment_dispatch_unfenced(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea) from public,anon,authenticated,service_role;
alter function public.claim_assessment_dispatch(uuid,uuid) rename to claim_assessment_dispatch_unfenced;
revoke all on function public.claim_assessment_dispatch_unfenced(uuid,uuid) from public,anon,authenticated,service_role;

create function public.enqueue_assessment_dispatch(
 p_job_id uuid,p_tenant_id uuid,p_actor_id uuid,p_workload_id uuid,p_estate_id uuid,p_engagement_id uuid,
 p_correlation_id uuid,p_input_hash text,p_proof_hash text,p_expires_at timestamptz,
 p_key_ref text,p_nonce bytea,p_ciphertext bytea,p_wrapped_key bytea,
 p_policy_revision integer default null,p_policy_fingerprint text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare policy public.assessment_dispatch_key_policies;
begin
 if p_tenant_id is null then return jsonb_build_object('error','policy_refused'); end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 select * into policy from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id;
 -- Historical stable-ID receipt recovery still passes the original actor/context
 -- checks. It cannot create a run, change ciphertext or renew task authority.
 if not exists(select 1 from public.assessment_dispatch_jobs where id=p_job_id) then
  if policy.tenant_id is not null then
   if p_policy_revision is distinct from policy.revision or p_policy_fingerprint is distinct from policy.fingerprint or p_key_ref is distinct from policy.primary_ref
   then return jsonb_build_object('error','policy_stale'); end if;
  elsif p_policy_revision is not null or p_policy_fingerprint is not null or p_key_ref like 'arn:%' or p_key_ref like 'projects/%'
  then return jsonb_build_object('error','policy_required'); end if;
 end if;
 return public.enqueue_assessment_dispatch_unfenced(p_job_id,p_tenant_id,p_actor_id,p_workload_id,p_estate_id,p_engagement_id,p_correlation_id,p_input_hash,p_proof_hash,p_expires_at,p_key_ref,p_nonce,p_ciphertext,p_wrapped_key);
end $$;
create function public.claim_assessment_dispatch(p_tenant_id uuid,p_job_id uuid,p_policy_revision integer default null,p_policy_fingerprint text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare policy public.assessment_dispatch_key_policies; job public.assessment_dispatch_jobs;
begin
 if p_tenant_id is null then return jsonb_build_object('error','policy_refused'); end if;
 perform pg_advisory_xact_lock_shared(hashtextextended(p_tenant_id::text,47));
 select * into policy from public.assessment_dispatch_key_policies where tenant_id=p_tenant_id;
 select * into job from public.assessment_dispatch_jobs where tenant_id=p_tenant_id and id=p_job_id;
 if policy.tenant_id is not null then
  if p_policy_revision is distinct from policy.revision or p_policy_fingerprint is distinct from policy.fingerprint or not (job.key_ref=any(policy.readable_refs))
  then return jsonb_build_object('error','policy_stale'); end if;
 elsif p_policy_revision is not null or p_policy_fingerprint is not null or job.key_ref like 'arn:%' or job.key_ref like 'projects/%'
 then return jsonb_build_object('error','policy_required'); end if;
 return public.claim_assessment_dispatch_unfenced(p_tenant_id,p_job_id);
end $$;
revoke all on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text) from public,anon,authenticated;
grant execute on function public.enqueue_assessment_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,timestamptz,text,bytea,bytea,bytea,integer,text) to service_role;
revoke all on function public.claim_assessment_dispatch(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.claim_assessment_dispatch(uuid,uuid,integer,text) to service_role;
