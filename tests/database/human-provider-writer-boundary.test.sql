-- A shared worker key cannot impersonate a founder, manager, or S3 readback.
begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'ASSERTION FAILED: generic service executed %',statement;
end $$;

do $$
declare v_name text; v_signature text; v_other text;
begin
  foreach v_name in array array[
    'review_policy_draft','register_consent_purpose','publish_consent_notice',
    'set_consent_purpose_active','record_consent','withdraw_consent',
    'set_consent_legal_hold','complete_withdrawal_downstream',
    'dismiss_monitoring_alert','review_onboarding_proposal',
    'prepare_onboarding_proposal','attest_connector_grant',
    'submit_classification_review','create_tenant_invitation',
    'revoke_tenant_invitation','accept_tenant_invitation',
    'manage_connector','manage_connector_credential',
    'issue_connector_grant','manage_workload_identity','manage_estate',
    'start_onboarding_wizard','advance_onboarding_wizard',
    'create_ropa_record','create_policy_draft','create_playbook_entry',
    'begin_evidence_ingest','settle_evidence_ingest','note_evidence_ingest_failure'
  ] loop
    select p.oid::regprocedure::text into strict v_signature from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    v_other:=case when v_name in ('begin_evidence_ingest','settle_evidence_ingest',
      'note_evidence_ingest_failure') then 'evidence_ingestion_writer' else 'human_action_writer' end;
    perform pg_temp.ok(not has_function_privilege('service_role',v_signature,'EXECUTE')
      and not has_function_privilege('anon',v_signature,'EXECUTE')
      and not has_function_privilege('authenticated',v_signature,'EXECUTE'),
      'shared/untrusted role retains '||v_signature);
    perform pg_temp.ok(has_function_privilege(v_other,v_signature,'EXECUTE'),
      'scoped role lacks '||v_signature);
    perform pg_temp.ok(not has_function_privilege(
      case when v_other='human_action_writer' then 'evidence_ingestion_writer'
        else 'human_action_writer' end,v_signature,'EXECUTE'),
      'restricted roles overlap at '||v_signature);
  end loop;
end $$;
select pg_temp.ok(not (select rolinherit or rolcanlogin or rolbypassrls from pg_roles
  where rolname='human_action_writer') and not (select rolinherit or rolcanlogin or rolbypassrls
  from pg_roles where rolname='evidence_ingestion_writer'), 'roles are no-login, no-inherit, no-bypass');
select pg_temp.ok(pg_has_role('authenticator','human_action_writer','member')
  and pg_has_role('authenticator','evidence_ingestion_writer','member')
  and not pg_has_role('service_role','human_action_writer','member')
  and not pg_has_role('service_role','evidence_ingestion_writer','member')
  and not pg_has_role('human_action_writer','evidence_ingestion_writer','member')
  and not pg_has_role('evidence_ingestion_writer','human_action_writer','member'),
  'only PostgREST may assume either mutually isolated writer');
select pg_temp.ok(not has_table_privilege('service_role','public.monitoring_alerts','INSERT')
  and not has_table_privilege('service_role','public.monitoring_alerts','UPDATE')
  and not has_table_privilege('service_role','public.tenant_onboarding_wizards','INSERT')
  and not has_table_privilege('service_role','public.tenant_onboarding_wizards','UPDATE')
  and not has_column_privilege('service_role','public.tenant_invitations','delivery_status','UPDATE'),
  'direct proof mutation grants removed');

insert into auth.users(id,email) values
 ('99009800-0000-4000-8000-000000000001','human-founder@example.invalid');
insert into public.users(id,email,is_axiom_internal) values
 ('99009800-0000-4000-8000-000000000001','human-founder@example.invalid',true);
insert into public.tenants(id,slug,name) values
 ('99009800-0000-4000-8000-000000000010','human-writer-test','Human writer test');
insert into public.tenant_users(tenant_id,user_id,role) values
 ('99009800-0000-4000-8000-000000000010','99009800-0000-4000-8000-000000000001','founder');
insert into public.policy_drafts(id,tenant_id,title,category,summary,content,content_sha256,created_by)
values('99009800-0000-4000-8000-000000000020','99009800-0000-4000-8000-000000000010',
 'Synthetic policy','data_protection','Synthetic summary','Reviewed source',
 encode(sha256(convert_to('Reviewed source','UTF8')),'hex'),
 '99009800-0000-4000-8000-000000000001');

set local role service_role;
select pg_temp.denied($s$select public.review_policy_draft(
 '99009800-0000-4000-8000-000000000010','99009800-0000-4000-8000-000000000001',
 '99009800-0000-4000-8000-000000000020','approved',
 encode(sha256(convert_to('Reviewed source','UTF8')),'hex'),gen_random_uuid())$s$);
select pg_temp.denied($s$select public.begin_evidence_ingest(
 '99009800-0000-4000-8000-000000000010','99009800-0000-4000-8000-000000000001',
 gen_random_uuid(),'{}'::jsonb,gen_random_uuid())$s$);
select pg_temp.denied($s$select public.settle_evidence_ingest(
 '99009800-0000-4000-8000-000000000010','99009800-0000-4000-8000-000000000001',
 gen_random_uuid(),jsonb_build_object('provider','s3','bucket','retained-example',
 'object_key','tenants/99009800-0000-4000-8000-000000000010/evidence-ingestions/x',
 'version_id','opaque-version','content_hash',repeat('a',64),'byte_size',1,
 'tenant_id','99009800-0000-4000-8000-000000000010','engagement_id',null,
 'collected_by_agent','human','retain_until',now()+interval '7 years 1 day',
 'readback_at',now(),'lock_mode','COMPLIANCE','verified',true,'legal_hold',false,
 'encryption','AES256','operation_id',gen_random_uuid(),'correlation_id',gen_random_uuid()),
 gen_random_uuid())$s$);
select pg_temp.denied($s$insert into public.monitoring_alerts(tenant_id,alert_type,severity,title,
 summary,source_id,source_type) values('99009800-0000-4000-8000-000000000010',
 'drift_high','high','Forged','Forged','source','drift_event')$s$);
reset role;

set local role human_action_writer;
select pg_temp.ok(public.review_policy_draft(
 '99009800-0000-4000-8000-000000000010','99009800-0000-4000-8000-000000000001',
 '99009800-0000-4000-8000-000000000020','approved',
 encode(sha256(convert_to('Reviewed source','UTF8')),'hex'),gen_random_uuid())->>'status'='approved',
 'scoped writer reaches a real founder decision');
select pg_temp.ok(public.review_policy_draft(
 '99009800-0000-4000-8000-000000000010','99009800-0000-4000-8000-000000000001',
 '99009800-0000-4000-8000-000000000020','approved',repeat('a',64),gen_random_uuid())
 ->>'error'='digest_mismatch','writer still rejects a changed digest');
reset role;
select pg_temp.ok((select count(*)=1 from public.audit_ledger where tenant_id=
 '99009800-0000-4000-8000-000000000010' and action_type='policy.reviewed'),
 'one human decision ledger event');
rollback;
