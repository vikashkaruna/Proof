-- The agent/worker service key is not evidence of a human decision or an S3
-- Object Lock readback. Keep those authorities in two distinct BFF identities.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='human_action_writer') then
    create role human_action_writer nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname='evidence_ingestion_writer') then
    create role evidence_ingestion_writer nologin noinherit nobypassrls;
  end if;
end $$;
alter role human_action_writer nologin noinherit nobypassrls;
alter role evidence_ingestion_writer nologin noinherit nobypassrls;
grant human_action_writer, evidence_ingestion_writer to authenticator;
grant usage on schema public to human_action_writer, evidence_ingestion_writer;

-- Name inventory is deliberately exact. Fail the migration if a function is
-- missing or overloaded, so a later signature change cannot silently keep a
-- forgeable generic-service entry point.
do $$
declare
  v_name text;
  v_signature regprocedure;
  v_count integer;
begin
  foreach v_name in array array[
    'review_policy_draft',
    'register_consent_purpose', 'publish_consent_notice',
    'set_consent_purpose_active', 'record_consent',
    'withdraw_consent', 'set_consent_legal_hold',
    'complete_withdrawal_downstream', 'dismiss_monitoring_alert',
    'review_onboarding_proposal', 'prepare_onboarding_proposal',
    'attest_connector_grant', 'submit_classification_review',
    'create_tenant_invitation', 'revoke_tenant_invitation',
    'accept_tenant_invitation', 'manage_connector',
    'manage_connector_credential', 'issue_connector_grant',
    'manage_workload_identity', 'manage_estate',
    'start_onboarding_wizard', 'advance_onboarding_wizard',
    'create_ropa_record', 'create_policy_draft', 'create_playbook_entry'
  ] loop
    select count(*), min(p.oid::regprocedure::text)::regprocedure
      into v_count,v_signature from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    if v_count<>1 then
      raise exception '0098 expected one public.% function, found %',v_name,v_count;
    end if;
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_signature);
    execute format('grant execute on function %s to human_action_writer',v_signature);
  end loop;
  foreach v_name in array array[
    'begin_evidence_ingest', 'settle_evidence_ingest',
    'note_evidence_ingest_failure'
  ] loop
    select count(*), min(p.oid::regprocedure::text)::regprocedure
      into v_count,v_signature from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    if v_count<>1 then
      raise exception '0098 expected one public.% function, found %',v_name,v_count;
    end if;
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_signature);
    execute format('grant execute on function %s to evidence_ingestion_writer',v_signature);
  end loop;
end $$;

-- SECURITY DEFINER dispatch remains a producer RPC, but a raw service-key
-- table write would bypass the event and can no longer alter an alert.
revoke insert,update on public.monitoring_alerts from service_role;
-- Wizard mutations are already RPC-only; the old direct grants bypassed their
-- human actor/step validation and their ledger append.
revoke insert,update on public.tenant_onboarding_wizards from service_role;

-- Invitation delivery is a BFF provider result, not a worker assertion.
revoke update(delivery_status,delivery_completed_at,provider_message_id,delivery_error_code)
  on public.tenant_invitations from service_role;
grant select(id,delivery_status,accepted_at,revoked_at)
  on public.tenant_invitations to human_action_writer;
grant update(delivery_status,delivery_completed_at,provider_message_id,delivery_error_code)
  on public.tenant_invitations to human_action_writer;
create policy invitation_human_writer_read on public.tenant_invitations for select
  to human_action_writer using (true);
create policy invitation_human_writer_settle on public.tenant_invitations for update
  to human_action_writer
  using (delivery_status='pending' and accepted_at is null and revoked_at is null)
  with check (true);

-- Rejecting a plan is one human decision, one token revocation and one ledger
-- transaction. The old route could report success after a zero-row plan update
-- or a failed action update, leaving a false human success entry.
alter type public.ledger_action_type add value if not exists 'plan.rejected';
create function public.reject_remediation_plan(
  p_tenant_id uuid,p_plan_id uuid,p_actor_id uuid,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_plan public.remediation_plans;
  v_actions integer;
  v_tokens integer;
begin
  if p_tenant_id is null or p_plan_id is null or p_actor_id is null or p_correlation_id is null then
    return jsonb_build_object('error','invalid_request');
  end if;
  perform 1 from public.tenant_users where tenant_id=p_tenant_id and user_id=p_actor_id
    and role in ('founder','owner','admin','approver') for share;
  if not found then return jsonb_build_object('error','forbidden'); end if;
  -- The normal execution claim takes this plan lock first. A rejection cannot
  -- race a claimed or already-executed action into a cancelled state.
  select * into v_plan from public.remediation_plans
    where tenant_id=p_tenant_id and id=p_plan_id for update;
  if not found then return jsonb_build_object('error','plan_not_found'); end if;
  if v_plan.status not in ('draft','review','approved')
    or exists(select 1 from public.execution_batches
      where tenant_id=p_tenant_id and plan_id=p_plan_id)
    or exists(select 1 from public.execution_dispatch_outbox
      where tenant_id=p_tenant_id and plan_id=p_plan_id)
    or exists(select 1 from public.remediation_actions
      where tenant_id=p_tenant_id and plan_id=p_plan_id
        and (execution_status in ('executing','succeeded','failed','rolled_back')
          or final_outcome in ('succeeded','failed','rolled_back'))) then
    return jsonb_build_object('error','plan_not_rejectable');
  end if;
  update public.remediation_actions set approval_status='skipped',
    execution_status='skipped',final_outcome='skipped',updated_at=clock_timestamp()
    where tenant_id=p_tenant_id and plan_id=p_plan_id;
  get diagnostics v_actions=row_count;
  update public.approval_tokens set status='revoked',revoked_at=clock_timestamp()
    where tenant_id=p_tenant_id and plan_id=p_plan_id and status='issued';
  get diagnostics v_tokens=row_count;
  update public.remediation_plans set status='cancelled',version=version+1,
    updated_at=clock_timestamp() where tenant_id=p_tenant_id and id=p_plan_id;
  perform public.append_ledger(p_tenant_id,p_correlation_id,'human',p_actor_id::text,
    null,null,null,'plan.rejected',p_plan_id::text,null,null,null,null,null,null,
    'success',jsonb_build_object('previousStatus',v_plan.status,'skippedActions',v_actions,
      'revokedTokens',v_tokens));
  return jsonb_build_object('status','cancelled','skippedActions',v_actions,
    'revokedTokens',v_tokens);
end $$;
revoke all on function public.reject_remediation_plan(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.reject_remediation_plan(uuid,uuid,uuid,uuid)
  to human_action_writer;
