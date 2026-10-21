-- Live platform founder visibility is independent of materialized tenant roles.
-- Keep explicit memberships/history intact and private writer grants unchanged.
create function public.platform_founder_visibility_allowed()returns boolean
language sql stable security definer set search_path=''as $$
 select public.session_is_current()and public.is_live_platform_founder(auth.uid());
$$;
revoke all on function public.platform_founder_visibility_allowed()from public,anon;
grant execute on function public.platform_founder_visibility_allowed()to authenticated,service_role;

create or replace function public.current_tenant_roles()returns public.user_role[]
language sql stable security definer set search_path=''as $$
 select case when not public.session_is_current()then '{}'::public.user_role[]
 when public.platform_founder_visibility_allowed()then array['founder']::public.user_role[]
 else(select coalesce(array_agg(role),'{}'::public.user_role[])from public.tenant_users
 where tenant_id=public.current_tenant_id()and user_id=auth.uid())end;
$$;
create or replace function public.is_tenant_member(check_tenant uuid)returns boolean
language sql stable security definer set search_path=''as $$
 select public.session_is_current()and(
 (public.platform_founder_visibility_allowed()and exists(select 1 from public.tenants where id=check_tenant))
 or exists(select 1 from public.tenant_users where tenant_id=check_tenant and user_id=auth.uid()));
$$;
create or replace function public.has_tenant_role(check_tenant uuid,allowed_roles public.user_role[])returns boolean
language sql stable security definer set search_path=''as $$
 select public.session_is_current()and case when public.platform_founder_visibility_allowed()
 then 'founder'::public.user_role=any(allowed_roles)and exists(select 1 from public.tenants where id=check_tenant)
 else exists(select 1 from public.tenant_users where tenant_id=check_tenant and user_id=auth.uid()and role=any(allowed_roles))end;
$$;
create or replace function public.report_visible(p_tenant_id uuid,p_created_by uuid,p_status text)returns boolean
language sql stable security definer set search_path=''as $$
 select public.session_is_current()and(public.platform_founder_visibility_allowed()or exists(
 select 1 from public.tenant_users m join public.users u on u.id=m.user_id
 where m.tenant_id=p_tenant_id and m.user_id=auth.uid()and
 (p_status='published'or(m.role in('founder','owner','admin')and p_created_by=u.id)or(m.role='founder'and u.is_axiom_internal))));
$$;
create or replace function public.report_founder_allowed(p_tenant_id uuid,p_actor_id uuid)returns boolean
language plpgsql security definer set search_path=''as $$
begin
 -- The actual private writer still supplies the actor/session/MFA scope. Lock
 -- the protected live designation and internal fact before granting authority.
 perform 1 from public.platform_founders f join public.users u on u.id=f.user_id
 where f.user_id=p_actor_id and f.revoked_at is null and u.is_axiom_internal
 for share of f,u;
 if found then return exists(select 1 from public.tenants where id=p_tenant_id);end if;
 perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id and role='founder'for share;
 if not found then return false;end if;
 perform 1 from public.users where id=p_actor_id and is_axiom_internal for share;
 return found;
end$$;

-- Only these reviewed current180 public RLS relations receive SELECT policies.
-- This literal inventory does not grant access to future tables, private
-- schemas, credentials, auth sessions, or any table missing SELECT privileges.
do $$declare relation_name text;begin
 foreach relation_name in array array[
  'agent_runs',
  'approval_exports',
  'approval_proof_archives',
  'approval_proof_reviews',
  'approval_proof_versions',
  'approval_tokens',
  'assessment_dispatch_jobs',
  'assessment_dispatch_key_policies',
  'assessment_local_custody_authorizations',
  'assessment_request_resolutions',
  'assessment_source_cancellations',
  'audit_ledger',
  'board_artifact_builds',
  'board_artifact_versions',
  'board_report_artifacts',
  'board_report_requests',
  'board_request_sources',
  'breach_notifications',
  'breaches',
  'catalogue_current_version_events',
  'catalogue_engagement_admissions',
  'catalogue_reaudit_decisions',
  'catalogue_reaudit_requests',
  'catalogue_version_approval_events',
  'classification_reviews',
  'compliance_events',
  'connector_credentials',
  'connector_discovery_runs',
  'connector_grant_attestations',
  'connector_grants',
  'connector_health_checks',
  'connectors',
  'consent_notice_versions',
  'consent_purposes',
  'consent_records',
  'consent_withdrawals',
  'dpb_artifact_builds',
  'dpb_artifact_versions',
  'dpb_report_requests',
  'dpb_request_sources',
  'drift_events',
  'dry_runs',
  'dsars',
  'engagement_intake_operations',
  'engagement_intake_receipts',
  'engagements',
  'estate_scans',
  'estate_systems',
  'estates',
  'evidence',
  'evidence_ingestions',
  'evidence_object_versions',
  'evidence_pack_archives',
  'evidence_pack_builds',
  'evidence_pack_items',
  'evidence_packs',
  'execution_batches',
  'execution_dispatch_outbox',
  'finding_evidence',
  'findings',
  'idempotency_keys',
  'kill_switch_state',
  'local_custody_intent_cancellations',
  'local_custody_policy_events',
  'local_custody_policy_heads',
  'local_custody_policy_versions',
  'mapping_context_adoptions',
  'mcp_tool_registry',
  'mfa_challenges',
  'mfa_recovery_cases',
  'mfa_recovery_delegations',
  'model_accounting_runs',
  'monitoring_alerts',
  'monitoring_read_decisions',
  'monitoring_read_dispatches',
  'monitoring_read_fences',
  'monitoring_read_revocations',
  'monitoring_read_scopes',
  'monitoring_schedule_fires',
  'monitoring_schedules',
  'onboarding_attested_systems',
  'onboarding_proposal_systems',
  'onboarding_proposals',
  'operator_workflow_cancellations',
  'operator_workflow_records',
  'plan_reconciliations',
  'plan_source_review_adoptions',
  'plan_source_review_tasks',
  'playbook_entries',
  'policy_drafts',
  'policy_evaluations',
  'postgresql_discovery_requests',
  'postgresql_sandbox_deployments',
  'pramaan_auditor_archives',
  'pramaan_auditor_builds',
  'pramaan_dossier_archives',
  'pramaan_dossier_builds',
  'pramaan_dossiers',
  'pramaan_dpb_archives',
  'pramaan_dpb_builds',
  'pramaan_full_archives',
  'pramaan_full_builds',
  'pramaan_full_releases',
  'pramaan_full_reviews',
  'pramaan_technical_archives',
  'pramaan_technical_builds',
  'prativedan_accounted_attempts',
  'prativedan_accounted_capsules',
  'prativedan_accounted_terminals',
  'prativedan_assessment_sources',
  'prativedan_controller_admissions',
  'prativedan_controller_phases',
  'prativedan_draft_claims',
  'prativedan_draft_outputs',
  'prativedan_draft_requests',
  'prativedan_draft_reviews',
  'public_control_assessment_sources',
  'public_control_review_cancellations',
  'public_control_review_sets',
  'public_source_bindings',
  'public_source_dispatch_claims',
  'public_source_dispatches',
  'public_source_observations',
  'public_source_reviews',
  'public_website_asset_associations',
  'public_website_asset_cancellations',
  'public_website_asset_operations',
  'public_website_checks',
  'public_website_control_evidence',
  'public_website_targets',
  'remediation_actions',
  'remediation_plans',
  'report_email_dispatches',
  'report_reviews',
  'reports',
  'reviewed_workflow_acknowledgements',
  'reviewed_workflow_dispatch_claims',
  'reviewed_workflow_dispatches',
  'reviewed_workflow_settled_outputs',
  'rollback_executions',
  'ropa_records',
  'saakshi119_dispatch_claims',
  'saakshi119_settled_outputs',
  'saakshi119_sources',
  'standing_approval_policies',
  'statutory_artifact_builds',
  'statutory_artifact_versions',
  'statutory_report_artifacts',
  'statutory_report_requests',
  'statutory_request_sources',
  'sudhaar_settled_outputs',
  'system_data_categories',
  'technical_artifact_builds',
  'technical_artifact_versions',
  'technical_report_requests',
  'technical_request_sources',
  'tenant_invitations',
  'tenant_ledger_counters',
  'tenant_onboarding_intakes',
  'tenant_onboarding_wizards',
  'tenant_users',
  'tenants',
  'users',
  'verification_results',
  'workload_assessment_packets',
  'workload_identities',
  'workload_task_delegations'
 ]loop
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public'and c.relname=relation_name and c.relkind='r'and c.relrowsecurity
   and(c.relname in('tenants','users')or exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='tenant_id'and not a.attisdropped)))
  then raise exception 'Reviewed founder visibility relation missing or unsafe: %',relation_name;end if;
  execute format('create policy founder181_global_read on public.%I for select to authenticated using(public.platform_founder_visibility_allowed())',relation_name);
 end loop;
end$$;

create or replace function controller_security.catalogue127_authority(t uuid,a uuid,global_action boolean default false) returns boolean
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
 return public.report_founder_allowed(t,a);
end $$;

create or replace function controller_security.catalogue178_authority(t uuid,a uuid,s uuid,wanted text default null)returns void
language plpgsql security definer set search_path=''as $$
begin
 if not public.session_postdates_fence(a,s)
 or not exists(select 1 from auth.sessions where id=s and user_id=a and(not_after is null or not_after>clock_timestamp()))
 or not(exists(select 1 from public.tenant_users where tenant_id=t and user_id=a and(wanted is null or role::text=wanted))
 or(wanted is null or wanted='founder')and public.is_live_platform_founder(a))
 then raise exception 'live catalogue membership/session required'using errcode='42501';end if;
 if(wanted is null or wanted='founder')and public.is_live_platform_founder(a)then
  perform 1 from public.platform_founders f join public.users u on u.id=f.user_id where f.user_id=a and f.revoked_at is null and u.is_axiom_internal for share of f,u;
  if not found then raise exception 'live founder authority changed'using errcode='42501';end if;
 else perform 1 from public.tenant_users where tenant_id=t and user_id=a for share;end if;
 perform 1 from auth.sessions where id=s and user_id=a for share;
 if wanted='founder'then
  perform controller_security.catalogue161_authority(t,a,s);
  if not public.is_live_platform_founder(a)then raise exception 'live platform founder required'using errcode='42501';end if;
 end if;
 if exists(select 1 from public.kill_switch_state where engaged and(scope='global'or tenant_id=t))then raise exception 'catalogue mutations halted'using errcode='42501';end if;
end $$;
