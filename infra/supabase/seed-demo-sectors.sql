-- ─────────────────────────────────────────────────────────────────────
-- seed-demo-sectors.sql
--
-- Three fictitious demo companies, one per sector, with enough recorded
-- history that every tenant screen renders real rows and every persona has
-- something to do:
--
--   Kosha Capital Finance Ltd       BFSI        posture ~72  (mid maturity)
--   Sanjeevani Care Hospitals       Healthcare  posture ~45  (live breach)
--   Nimbus Stack Technologies       SaaS/Tech   posture ~86  (mature, XBR gap)
--
-- LOCAL / DEV DATABASES ONLY. Run through scripts/seed-demo-sectors.sh,
-- which refuses non-loopback hosts. All names, people, identifiers and
-- figures are invented; principal emails use the reserved .example domain.
--
-- Re-runnable. Tenant history is written once (fixed UUIDs, guarded by
-- "already seeded"); every run then
--   * grants every existing user a membership in each demo tenant,
--   * re-extends the dry-run window of actions still awaiting approval,
--   * adds a fresh approvable plan to any demo tenant whose approvable plan
--     was consumed by a live approval,
-- so the approval journey can be demonstrated again after each use.
--
-- Write paths: domain tables are inserted directly (this is fixture
-- history, not live agent output), but the audit ledger is written ONLY
-- through public.append_ledger() and operator workflow records ONLY
-- through public.record_operator_workflow(), the sanctioned paths. No
-- approval token here is usable: historic tokens are consumed and carry
-- a non-verifying signature. Live approvals still go through the BFF,
-- the MFA step-up and issue_reviewed_plan_approval().
-- ─────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
begin;

-- Deterministic ids so a re-run finds what the first run wrote.
-- RFC 9562 version-4 layout (version nibble 4, variant 8-b): the BFF parses
-- ids with strict UUID validators and rejects a raw md5.
create function pg_temp.did(k text) returns uuid language sql immutable
  as $$ select (substr(h, 1, 12) || '4' || substr(h, 14, 3)
                || substr('89ab', 1 + ('x' || substr(h, 17, 1))::bit(4)::int % 4, 1)
                || substr(h, 18, 15))::uuid
          from (select md5('axiom-demo/' || k) as h) x $$;
create function pg_temp.hex(k text) returns text language sql immutable
  as $$ select encode(sha256(convert_to('axiom-demo/' || k, 'UTF8')), 'hex') $$;
-- Stable pseudo-random integer in [lo, hi] from a key.
create function pg_temp.jit(k text, lo int, hi int) returns int language sql immutable
  as $$ select lo + (('x' || substr(md5(k), 1, 8))::bit(32)::bigint % (hi - lo + 1))::int $$;

-- ── Control library ─────────────────────────────────────────────────
-- Demo setup never publishes or selects a catalogue. Use the recorded founder
-- approval/current-selection flow first; absence is a configuration refusal.

-- ── People ──────────────────────────────────────────────────────────
-- Every demo row names a real account so foreign keys and dual-control
-- checks (reviewer <> creator, approver <> creator) hold. Missing
-- personas fall back to the owner.
create temp table demo_people (k text primary key, user_id uuid not null) on commit drop;

do $$
declare
  v_founder uuid; v_owner uuid;
begin
  select id into v_founder from public.users where email = 'founder@axiomproof.ai';
  if v_founder is null then
    select u.id into v_founder from public.users u
      join public.tenant_users tu on tu.user_id = u.id
      where tu.role = 'founder' order by u.email limit 1;
  end if;
  select id into v_owner from public.users where email = 'client1@axiomproof.ai';
  if v_owner is null then
    select u.id into v_owner from public.users u
      join public.tenant_users tu on tu.user_id = u.id
      where tu.role = 'owner' order by u.email limit 1;
  end if;
  if v_founder is null or v_owner is null then
    raise exception 'seed-demo-sectors needs a founder and an owner account in public.users';
  end if;
  insert into demo_people values ('founder', v_founder), ('owner', v_owner);

  insert into demo_people
  select k, coalesce(
           (select u.id from public.users u where u.email like 'persona-' || p || '-%@example.invalid'
              order by u.email limit 1),
           v_owner)
  from (values ('approver','approver'), ('reviewer','reviewer'), ('viewer','viewer'),
               ('analyst','analyst'), ('partner','partner')) as x(k, p);
end $$;

create function pg_temp.who(k text) returns uuid language sql stable
  as $$ select user_id from demo_people where demo_people.k = who.k $$;

-- The founder account works across tenants as Axiom staff; founder and
-- analyst roles are refused by the database for non-internal accounts.
update public.users set is_axiom_internal = true
 where id = pg_temp.who('founder') and not is_axiom_internal;

-- ── Tenants ─────────────────────────────────────────────────────────
-- Ids start with 'fd' so an existing persona's default tenant (lowest id)
-- does not change. mfa_required_roles is empty so owners and approvers
-- can sign in without first enrolling; founder and analyst still always
-- need a factor (platform rule), and every approval still needs a step-up.
insert into public.tenants (id, slug, name, tier, is_sdf, processes_children_data,
                            processes_health_data, mfa_required_roles, is_demo, dpo_name, dpo_email)
values
  ('fd5e0001-0000-4000-8000-000000000001', 'demo-kosha-bfsi', 'Kosha Capital Finance (Demo · BFSI)',
   'enterprise', true, false, false, '{}', true, 'Ananya Rao', 'dpo@kosha-capital.example'),
  ('fd5e0002-0000-4000-8000-000000000002', 'demo-sanjeevani-health', 'Sanjeevani Care Hospitals (Demo · Healthcare)',
   'enterprise', true, true, true, '{}', true, 'Dr. Farhan Qureshi', 'dpo@sanjeevani-care.example'),
  ('fd5e0003-0000-4000-8000-000000000003', 'demo-nimbus-saas', 'Nimbus Stack Technologies (Demo · SaaS)',
   'growth', false, false, false, '{}', true, 'Meera Iyer', 'privacy@nimbus-stack.example')
on conflict (id) do update set
  name = excluded.name, tier = excluded.tier, is_sdf = excluded.is_sdf,
  processes_children_data = excluded.processes_children_data,
  processes_health_data = excluded.processes_health_data,
  mfa_required_roles = excluded.mfa_required_roles, is_demo = excluded.is_demo,
  dpo_name = excluded.dpo_name, dpo_email = excluded.dpo_email;

-- ── Memberships ─────────────────────────────────────────────────────
-- Every account gets the role it already holds elsewhere (highest
-- authority first), so each persona sees the demo companies through its
-- own permissions. Accounts with no membership yet become owners; the
-- founder account becomes founder.
insert into public.tenant_users (tenant_id, user_id, role, approval_scopes, accepted_at)
select t.id, u.id,
       case when u.id = pg_temp.who('founder') then 'founder'::public.user_role
            else coalesce(best.role, 'owner'::public.user_role) end,
       coalesce(best.approval_scopes, '{}'),
       now()
from public.users u
cross join (select id from public.tenants where slug like 'demo-%' and is_demo) t
left join lateral (
  select tu.role, tu.approval_scopes from public.tenant_users tu
   join public.tenants ot on ot.id = tu.tenant_id and ot.slug not like 'demo-%'
   where tu.user_id = u.id
   order by array_position(array['founder','axiom_analyst','owner','admin','approver',
                                 'reviewer','partner','viewer','agent']::text[], tu.role::text)
   limit 1
) best on true
where coalesce(best.role::text, 'owner') <> 'agent'
on conflict (tenant_id, user_id) do nothing;

-- ── Per-company history ─────────────────────────────────────────────
create function pg_temp.seed_company(t uuid, c jsonb) returns void
language plpgsql as $fn$
declare
  lib constant text := (select l.version from public.control_libraries l
                         join public.approved_catalogue_versions a on a.library_version=l.version
                         where l.is_current and l.status='published'
                           and (select count(*) from public.controls c where c.library_version=l.version)=a.control_count);
  k text := c->>'key';
  founder uuid := pg_temp.who('founder');
  owner uuid := pg_temp.who('owner');
  approver uuid := pg_temp.who('approver');
  reviewer uuid := pg_temp.who('reviewer');
  analyst uuid := pg_temp.who('analyst');
  drafter uuid;
  estate uuid := pg_temp.did(k || '/estate');
  eng_prev uuid := pg_temp.did(k || '/eng/prev');
  eng uuid := pg_temp.did(k || '/eng/current');
  p_done uuid := pg_temp.did(k || '/plan/done');
  p_live uuid := pg_temp.did(k || '/plan/live');
  p_fail uuid := pg_temp.did(k || '/plan/failed');
  p_draft uuid := pg_temp.did(k || '/plan/draft');
  tok_done uuid := pg_temp.did(k || '/token/done');
  tok_fail uuid := pg_temp.did(k || '/token/failed');
  bat_done uuid := pg_temp.did(k || '/batch/done');
  bat_fail uuid := pg_temp.did(k || '/batch/failed');
  ctl record; sys jsonb; a jsonb; x jsonb; i int; n int;
  v_score numeric; v_prev numeric; st public.finding_status; w numeric;
  posture numeric; prev_posture numeric;
  aid uuid; did_ uuid; ev uuid; fid uuid; pid uuid; rid uuid; br uuid;
  open_findings uuid[];
  corr uuid;
  receipt jsonb; ropa_id uuid;
begin
  drafter := case when analyst <> owner then analyst else founder end;
  if lib is null then raise exception 'no complete approved current catalogue to seed against'; end if;
  if exists (select 1 from public.engagements where tenant_id = t) then
    raise notice 'demo company % already has history; skipping core seed', k;
    return;
  end if;

  -- Estate and systems ------------------------------------------------
  insert into public.estates (id, tenant_id, slug, name, description)
  values (estate, t, 'primary', c->>'estate_name', c->>'estate_desc');

  i := 0;
  for sys in select * from jsonb_array_elements(c->'systems') loop
    i := i + 1;
    insert into public.estate_systems (id, tenant_id, estate_id, name, system_kind, external_ref, description)
    values (pg_temp.did(k || '/sys/' || i), t, estate, sys->>'name', sys->>'kind', sys->>'ref', sys->>'desc');
    insert into public.system_data_categories (tenant_id, system_id, category_key, source)
    select t, pg_temp.did(k || '/sys/' || i), cat,
           case when pg_temp.jit(k || cat || i, 0, 2) = 0 then 'observed' else 'declared' end
    from jsonb_array_elements_text(sys->'cats') cat;
  end loop;

  -- Engagements: a completed baseline and the current one ---------------
  insert into public.engagements (id, tenant_id, library_version, title, status, posture_score,
                                  estimated_exposure_inr, lead_reviewer_id, started_at, completed_at, estate_id, created_at)
  values (eng_prev, t, lib, c->>'prev_title', 'completed', null, (c->>'prev_exposure')::bigint, reviewer,
          now() - interval '200 days', now() - interval '150 days', estate, now() - interval '200 days'),
         (eng, t, lib, c->>'title', (c->>'status')::public.engagement_status, null,
          (c->>'exposure')::bigint, reviewer, now() - interval '34 days',
          case when c->>'status' = 'completed' then now() - interval '2 days' end, estate, now() - interval '34 days');

  -- Findings: one per control, scored from the sector's domain profile --
  for ctl in select id, domain::text as domain, severity::text as severity
               from public.controls where library_version = lib order by id loop
    v_score := least(100, greatest(5,
               coalesce((c->'domain_scores'->>ctl.domain)::numeric, (c->>'base_score')::numeric)
               + pg_temp.jit(k || ctl.id, -9, 9)));
    v_prev := greatest(5, v_score - (c->>'improvement')::numeric - pg_temp.jit(k || 'p' || ctl.id, 0, 10));
    w := case ctl.severity when 'critical' then 10 when 'high' then 6 when 'medium' then 3 else 1 end;
    st := case when v_score >= 85 then 'closed'
               when v_score >= 72 then 'in_remediation'
               when v_score >= 60 then 'planned'
               when ctl.severity = 'low' and v_score < 50 then 'accepted_risk'
               else 'open' end;
    insert into public.findings (id, tenant_id, engagement_id, control_id, library_version, status,
                                 score, risk_points, rationale, answers, reviewed_by, reviewed_at, review_notes)
    values (pg_temp.did(k || '/f/' || ctl.id), t, eng, ctl.id, lib, st, v_score,
            round(w * (100 - v_score) / 10, 2),
            case when v_score >= 85 then 'Control operating as designed; evidence sampled and sealed.'
                 when v_score >= 60 then 'Control partially implemented; remediation is planned or under way.'
                 else 'Material gap: control absent or not evidenced for in-scope systems.' end
              || ' ' || coalesce(c->'rationale'->>ctl.domain, ''),
            jsonb_build_object('implemented', v_score >= 60, 'evidence_sampled', v_score >= 72,
                               'owner_named', v_score >= 50, 'source', 'questionnaire+discovery'),
            case when v_score >= 60 then reviewer end,
            case when v_score >= 60 then now() - interval '20 days' end,
            case when st = 'accepted_risk' then 'Risk accepted by the board for this cycle; revisit next assessment.' end);
    insert into public.findings (id, tenant_id, engagement_id, control_id, library_version, status,
                                 score, risk_points, rationale, reviewed_by, reviewed_at)
    values (pg_temp.did(k || '/fp/' || ctl.id), t, eng_prev, ctl.id, lib,
            'closed', v_prev, round(w * (100 - v_prev) / 10, 2),
            'Baseline assessment result; superseded by the current assessment.', reviewer, now() - interval '160 days');
  end loop;

  select round(avg(f.score), 2) into posture from public.findings f where f.engagement_id = eng;
  select round(avg(f.score), 2) into prev_posture from public.findings f where f.engagement_id = eng_prev;
  update public.engagements set posture_score = posture where id = eng;
  update public.engagements set posture_score = prev_posture where id = eng_prev;

  select array_agg(id order by risk_points desc) into open_findings
    from public.findings where engagement_id = eng and status in ('open', 'planned');

  -- Evidence ----------------------------------------------------------
  i := 0;
  for x in select * from jsonb_array_elements(c->'evidence') loop
    i := i + 1;
    ev := pg_temp.did(k || '/ev/' || i);
    insert into public.evidence (id, tenant_id, engagement_id, content_hash, storage_uri, filename, mime_type,
                                 byte_size, evidence_type, description, collected_by_agent, collected_at,
                                 demonstrates_control_ids, worm_lock_until)
    values (ev, t, eng, pg_temp.hex(k || '/ev/' || i),
            's3://axiom-demo-evidence-ap-south-1/' || k || '/' || (x->>'file'),
            x->>'file', x->>'mime', 40000 + pg_temp.jit(k || i, 0, 2000000),
            (x->>'type')::public.evidence_type, x->>'desc',
            case when i % 3 = 0 then 'saakshi' when i % 3 = 1 then 'drishti' else 'parikshan' end,
            now() - make_interval(days => 30 - i * 2),
            array(select jsonb_array_elements_text(x->'controls')),
            case when i % 2 = 0 then now() + interval '7 years' end);
    insert into public.finding_evidence (tenant_id, finding_id, evidence_id, link_type, note)
    select t, f.id, ev, case when f.status = 'closed' then 'demonstrates' else 'partial' end::public.evidence_link_type,
           'Linked by Saakshi during evidence collection.'
      from public.findings f
     where f.engagement_id = eng and f.control_id in (select jsonb_array_elements_text(x->'controls'))
    on conflict do nothing;
  end loop;

  -- Plan A: completed and verified (history for execution + ledger) -----
  insert into public.remediation_plans (id, tenant_id, engagement_id, library_version, title, description,
                                        status, version, aggregate_blast_radius, created_at)
  values (p_done, t, eng, lib, c->'plans'->'done'->>'title', c->'plans'->'done'->>'desc', 'completed', 2,
          '{"systems": 2, "rows": 48210}', now() - interval '25 days');

  -- Plan B: in review and approvable now (the live demo) ----------------
  insert into public.remediation_plans (id, tenant_id, engagement_id, library_version, title, description,
                                        status, version, aggregate_blast_radius, created_at)
  values (p_live, t, eng, lib, c->'plans'->'live'->>'title', c->'plans'->'live'->>'desc', 'review', 1,
          '{"systems": 3, "rows": 152400}', now() - interval '3 days');

  -- Plan C: executed with a failure that was rolled back -----------------
  insert into public.remediation_plans (id, tenant_id, engagement_id, library_version, title, description,
                                        status, version, aggregate_blast_radius, created_at)
  values (p_fail, t, eng, lib, c->'plans'->'failed'->>'title', c->'plans'->'failed'->>'desc',
          'partial_failure', 1, '{"systems": 1, "rows": 9100}', now() - interval '12 days');

  -- Plan D: draft, dry-run not yet complete (shows ineligibility) --------
  insert into public.remediation_plans (id, tenant_id, engagement_id, library_version, title, description,
                                        status, version, created_at)
  values (p_draft, t, eng, lib, c->'plans'->'draft'->>'title', c->'plans'->'draft'->>'desc', 'draft', 1,
          now() - interval '1 day');

  -- Historic tokens (consumed; signature deliberately non-verifying).
  insert into public.approval_tokens (id, tenant_id, plan_id, action_ids, approver_id, mode, concurrency,
                                      stop_on_failure, signature, signed_payload, nonce, issued_at, expires_at,
                                      consumed_at, status, reason)
  values
   (tok_done, t, p_done, '{}', approver, 'batch', 1, true, 'demo-fixture-not-a-signature',
    jsonb_build_object('planId', p_done, 'fixture', true, 'contentDigest', pg_temp.hex(k || '/digest/done')),
    pg_temp.hex(k || '/nonce/done'), now() - interval '20 days', now() - interval '19 days',
    now() - interval '20 days' + interval '2 hours', 'consumed', 'Reviewed dry-run diff with the CISO.'),
   (tok_fail, t, p_fail, '{}', approver, 'individual', 1, true, 'demo-fixture-not-a-signature',
    jsonb_build_object('planId', p_fail, 'fixture', true, 'contentDigest', pg_temp.hex(k || '/digest/failed')),
    pg_temp.hex(k || '/nonce/failed'), now() - interval '10 days', now() - interval '9 days',
    now() - interval '10 days' + interval '1 hour', 'consumed', 'Approved with stop-on-failure.');

  insert into public.execution_batches (id, tenant_id, plan_id, request_key, correlation_id, approval_token_id,
                                        content_digest, mode, concurrency, stop_on_failure, status,
                                        dispatch_reference, started_at, finished_at)
  values
   (bat_done, t, p_done, k || '-exec-done', pg_temp.did(k || '/corr/done'), tok_done,
    pg_temp.hex(k || '/digest/done'), 'batch', 1, true, 'completed', 'karya/' || k || '/0001',
    now() - interval '20 days' + interval '3 hours', now() - interval '20 days' + interval '4 hours'),
   (bat_fail, t, p_fail, k || '-exec-failed', pg_temp.did(k || '/corr/failed'), tok_fail,
    pg_temp.hex(k || '/digest/failed'), 'individual', 1, true, 'rolled_back', 'karya/' || k || '/0002',
    now() - interval '10 days' + interval '2 hours', now() - interval '10 days' + interval '3 hours');

  -- Actions -------------------------------------------------------------
  for pid, x in select * from (values (p_done, c->'plans'->'done'), (p_live, c->'plans'->'live'),
                                      (p_fail, c->'plans'->'failed'), (p_draft, c->'plans'->'draft')) v loop
    i := 0;
    for a in select * from jsonb_array_elements(x->'actions') loop
      i := i + 1;
      aid := pg_temp.did(k || '/act/' || pid || '/' || i);
      insert into public.remediation_actions (
        id, tenant_id, plan_id, sequence, action_type, parameters, description, closes_finding_ids,
        risk_class, risk_score, blast_radius, rollback_definition, rollback_validated, rollback_validated_at,
        dry_run_status, dry_run_result, dry_run_completed_at, dry_run_expires_at,
        approval_status, approval_token_id, approved_by, approved_at,
        execution_status, executed_by_agent, executed_at, pre_state_uri, post_state_uri,
        verification_status, verification_result, verified_at, final_outcome, execution_batch_id)
      values (
        aid, t, pid, i, (a->>'type')::public.action_type, coalesce(a->'params', '{}'), a->>'desc',
        case when open_findings is not null and array_length(open_findings, 1) >= i
             then array_remove(array[open_findings[i + (case when pid = p_live then 0 when pid = p_draft then 6 else 10 end)]], null)
             else '{}' end,
        (a->>'risk')::public.action_risk_class, (a->>'score')::numeric,
        -- Shape read by the plan screen (BlastRadius in plans/[id]/page.tsx).
        coalesce(a->'blast', '{}') || jsonb_build_object(
          'recordsAffected', coalesce((a->'blast'->>'rows')::int, 0),
          'systemsAffected', case when a->'blast' ? 'target' then jsonb_build_array(a->'blast'->>'target') else '[]'::jsonb end,
          'environment', 'production'),
        coalesce(a->'rollback', '{"strategy": "snapshot_restore"}')
          || jsonb_build_object('estimatedRollbackTimeSeconds', 30 + pg_temp.jit(k || 'rbs' || pid || i, 0, 270)),
        -- Timeline (0157): rollback validated, then the dry run recorded, then the
        -- approval inside the run's 24-hour window. The live plan's run is
        -- recorded through record_dry_run at the end of every seed run.
        pid <> p_draft,
        case when pid = p_done then now() - interval '20 days 3 hours'
             when pid = p_fail then now() - interval '10 days 3 hours'
             when pid = p_live then now() end,
        case when pid in (p_done, p_fail) then 'dry_run_complete' else 'awaiting_dry_run' end::public.action_status,
        null,
        case when pid = p_done then now() - interval '20 days 2 hours'
             when pid = p_fail then now() - interval '10 days 2 hours' end,
        case when pid = p_done then now() - interval '19 days 2 hours'
             when pid = p_fail then now() - interval '9 days 2 hours' end,
        case when pid = p_live then 'awaiting_approval' when pid = p_draft then 'draft'
             else 'approved' end::public.action_status,
        case when pid = p_done then tok_done when pid = p_fail then tok_fail end,
        case when pid in (p_done, p_fail) then approver end,
        case when pid = p_done then now() - interval '20 days' when pid = p_fail then now() - interval '10 days' end,
        case when pid in (p_live, p_draft) then 'draft'
             when pid = p_fail and i = 2 then 'rolled_back'
             when pid = p_fail and i > 2 then 'skipped' else 'succeeded' end::public.action_status,
        case when pid in (p_done, p_fail) then 'karya' end,
        case when pid = p_done then now() - interval '20 days' + interval '3 hours'
             when pid = p_fail then now() - interval '10 days' + interval '2 hours' end,
        case when pid in (p_done, p_fail) then 's3://axiom-demo-state-ap-south-1/' || k || '/pre/' || i end,
        case when pid in (p_done, p_fail) then 's3://axiom-demo-state-ap-south-1/' || k || '/post/' || i end,
        case when pid = p_done then 'succeeded' when pid = p_fail and i = 1 then 'succeeded'
             when pid = p_fail and i = 2 then 'failed' end::public.action_status,
        case when pid = p_done or (pid = p_fail and i = 1) then '{"checks_passed": 3, "checks_failed": 0}'::jsonb
             when pid = p_fail and i = 2 then '{"checks_passed": 1, "checks_failed": 2}'::jsonb end,
        case when pid in (p_done, p_fail) and i <= 2 then now() - interval '9 days' end,
        case when pid = p_done then 'succeeded' when pid = p_fail and i = 1 then 'succeeded'
             when pid = p_fail and i = 2 then 'rolled_back' when pid = p_fail then 'skipped' end,
        case when pid = p_done then bat_done when pid = p_fail then bat_fail end);

      if pid in (p_done, p_fail) then
        did_ := pg_temp.did(k || '/dry/' || aid);
        insert into public.dry_runs (id, tenant_id, action_id, plan_id, status, diff, renderable, parameters_hash,
                                     rollback_definition_hash, correlation_id, expires_at, created_at)
        values (did_, t, aid, pid, 'succeeded',
                -- {changes: [{field, before, after}]} is what parseDryRunChanges renders.
                jsonb_build_object('summary', a->>'desc', 'changes', case
                  when a->>'type' in ('data.retention_purge', 'data.delete') then jsonb_build_array(
                    jsonb_build_object('field', coalesce(a->'blast'->>'target', 'dataset') || ' · rows in scope',
                                       'before', coalesce((a->'blast'->>'rows')::int, 0), 'after', 0, 'role', 'removed'))
                  when a->>'type' = 'data.mask' then (
                    select coalesce(jsonb_agg(jsonb_build_object('field', col, 'before', 'cleartext',
                                                                 'after', 'masked (last 4 visible)', 'role', 'masked')),
                                    '[{"field": "pii_columns", "before": "cleartext", "after": "masked"}]'::jsonb)
                      from jsonb_array_elements_text(coalesce(a->'params'->'columns', a->'params'->'fields', '[]'::jsonb)) col)
                  when a->>'type' like 'config.%' then jsonb_build_array(
                    jsonb_build_object('field', coalesce(a->'blast'->>'target', 'configuration') || ' · ' || split_part(a->>'type', '.', 2),
                                       'before', 'not enforced', 'after', 'enforced'))
                  else jsonb_build_array(jsonb_build_object('field', a->>'type', 'before', 'current version', 'after', 'remediated version'))
                  end),
                true,
                -- The content binding record_dry_run computes, over the stored rows.
                (select encode(sha256(convert_to(x.parameters::text, 'UTF8')), 'hex')
                   from public.remediation_actions x where x.id = aid),
                (select encode(sha256(convert_to(x.rollback_definition::text, 'UTF8')), 'hex')
                   from public.remediation_actions x where x.id = aid),
                pg_temp.did(k || '/corr/dry/' || aid),
                case when pid = p_done then now() - interval '19 days 2 hours'
                     else now() - interval '9 days 2 hours' end,
                case when pid = p_done then now() - interval '20 days 2 hours'
                     else now() - interval '10 days 2 hours' end);
        -- The cache mirrors the recorded run, as record_dry_run leaves it.
        update public.remediation_actions ra set latest_dry_run_id = did_, dry_run_result = d.diff
          from public.dry_runs d where ra.id = aid and d.id = did_;
      end if;

      if pid = p_done or (pid = p_fail and i <= 2) then
        rid := pg_temp.did(k || '/ver/' || aid);
        insert into public.verification_results (id, tenant_id, action_id, batch_id, checks, outcome,
                                                 evidence_uri, correlation_id, verified_at)
        values (rid, t, aid, case when pid = p_done then bat_done else bat_fail end,
                case when pid = p_fail and i = 2 then
                  '[{"check": "post_state_matches_plan", "passed": false}, {"check": "no_collateral_change", "passed": true}, {"check": "service_health", "passed": false}]'::jsonb
                else '[{"check": "post_state_matches_plan", "passed": true}, {"check": "no_collateral_change", "passed": true}, {"check": "service_health", "passed": true}]'::jsonb end,
                case when pid = p_fail and i = 2 then 'failed' else 'passed' end,
                's3://axiom-demo-evidence-ap-south-1/' || k || '/verification/' || i || '.json',
                pg_temp.did(k || '/corr/ver/' || aid), now() - interval '9 days');
        update public.remediation_actions set latest_verification_result_id = rid where id = aid;
      end if;

      if pid = p_fail and i = 2 then
        rid := pg_temp.did(k || '/rb/' || aid);
        insert into public.rollback_executions (id, tenant_id, action_id, batch_id, definition, definition_hash,
                                                triggered_by, status, result, correlation_id, started_at, finished_at)
        values (rid, t, aid, bat_fail, coalesce(a->'rollback', '{"strategy": "snapshot_restore"}'),
                pg_temp.hex(k || '/rb/' || aid), 'verification', 'succeeded',
                '{"restored": true, "duration_seconds": 41}', pg_temp.did(k || '/corr/rb/' || aid),
                now() - interval '10 days' + interval '150 minutes', now() - interval '10 days' + interval '151 minutes');
        update public.remediation_actions set latest_rollback_execution_id = rid where id = aid;
      end if;
    end loop;
  end loop;

  update public.remediation_plans p set aggregate_blast_radius = jsonb_build_object(
      'recordsAffected', (select coalesce(sum((blast_radius->>'recordsAffected')::int), 0)
                            from public.remediation_actions where plan_id = p.id),
      'systemsAffected', (select coalesce(jsonb_agg(distinct s), '[]'::jsonb)
                            from public.remediation_actions ra, jsonb_array_elements_text(ra.blast_radius->'systemsAffected') s
                           where ra.plan_id = p.id),
      'environment', 'production')
   where p.id in (p_done, p_live, p_fail, p_draft);

  update public.approval_tokens set action_ids =
    array(select id from public.remediation_actions where plan_id = approval_tokens.plan_id order by sequence)
   where id in (tok_done, tok_fail);
  update public.remediation_plans set plan_approval_token_id = tok_done where id = p_done;
  update public.remediation_plans set plan_approval_token_id = tok_fail where id = p_fail;

  insert into public.plan_reconciliations (tenant_id, plan_id, batch_id, approved_scope, executed_reality,
                                           unexecuted, verification_outcomes, statement, statement_signature)
  values (t, p_done, bat_done,
          jsonb_build_object('action_ids', (select jsonb_agg(id) from public.remediation_actions where plan_id = p_done)),
          jsonb_build_object('succeeded', (select count(*) from public.remediation_actions where plan_id = p_done)),
          '[]', '{"passed": "all"}',
          'Every approved action executed within its approved scope and passed verification. No out-of-scope change was observed.',
          'demo-fixture-statement-signature-' || pg_temp.hex(k || '/stmt')),
         (t, p_fail, bat_fail,
          jsonb_build_object('action_ids', (select jsonb_agg(id) from public.remediation_actions where plan_id = p_fail)),
          '{"succeeded": 1, "rolled_back": 1}',
          (select coalesce(jsonb_agg(id), '[]') from public.remediation_actions where plan_id = p_fail and sequence > 2),
          '{"passed": 1, "failed": 1}',
          'Action 2 failed post-change verification and was rolled back automatically; remaining actions were halted by stop-on-failure.',
          'demo-fixture-statement-signature-' || pg_temp.hex(k || '/stmt2'));

  -- Agent runs --------------------------------------------------------
  i := 0;
  for x in select * from jsonb_array_elements(
      '[["drishti","succeeded",33],["vibhaag","succeeded",31],["parikshan","succeeded",28],["saakshi","succeeded",27],
        ["sudhaar","succeeded",26],["karya","succeeded",20],["parikshan","succeeded",19],["lekha","succeeded",18],
        ["nazar","succeeded",9],["karya","failed",10],["sudhaar","succeeded",3],["prativedan","succeeded",2],
        ["sanket","succeeded",1],["nazar","running",0],["drishti","queued",0]]'::jsonb) loop
    i := i + 1;
    insert into public.agent_runs (id, tenant_id, agent, engagement_id, plan_id, model_id, status, started_at,
                                   completed_at, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms,
                                   error, correlation_id, input_redacted_hash, output_redacted_hash, pii_redacted, metadata)
    values (pg_temp.did(k || '/run/' || i), t, x->>0, eng,
            case when x->>0 in ('sudhaar','karya') then case when x->>1 = 'failed' then p_fail else p_live end end,
            'axiom-gateway/qwen-2.5-72b-instruct-ap-south-1', x->>1,
            now() - make_interval(days => (x->>2)::int, hours => i),
            case when x->>1 in ('succeeded','failed') then now() - make_interval(days => (x->>2)::int, hours => i) + interval '4 minutes' end,
            1200 + pg_temp.jit(k || 'in' || i, 0, 8000), 300 + pg_temp.jit(k || 'out' || i, 0, 3000), null,
            round(pg_temp.jit(k || 'c' || i, 4, 90) / 1000.0, 6), 2000 + pg_temp.jit(k || 'l' || i, 0, 60000),
            case when x->>1 = 'failed' then 'verification_failed: post-state did not match plan' end,
            pg_temp.did(k || '/corr/run/' || i), pg_temp.hex(k || '/ri/' || i), pg_temp.hex(k || '/ro/' || i), true,
            jsonb_build_object('demo', true, 'sector', c->>'sector'));
  end loop;
  update public.agent_runs set total_tokens = input_tokens + output_tokens where tenant_id = t;

  -- DSARs -------------------------------------------------------------
  i := 0;
  for x in select * from jsonb_array_elements(c->'dsars') loop
    i := i + 1;
    insert into public.dsars (id, tenant_id, kind, status, data_principal_name, data_principal_email,
                              data_principal_phone, identity_verified, identity_verification_method,
                              due_by, received_at, completed_at, rejection_reason, assigned_to, notes)
    values (pg_temp.did(k || '/dsar/' || i), t, (x->>'kind')::public.dsar_kind, (x->>'status')::public.dsar_status,
            x->>'name', lower(replace(x->>'name', ' ', '.')) || '@principal.example', '+91-90000-0' || lpad(i::text, 4, '0'),
            x->>'status' not in ('received', 'identity_verification'),
            case when x->>'status' not in ('received', 'identity_verification') then x->>'method' end,
            now() - make_interval(days => (x->>'age')::int) + interval '30 days',
            now() - make_interval(days => (x->>'age')::int),
            case when x->>'status' in ('completed','rejected') then now() - make_interval(days => greatest((x->>'age')::int - 9, 0)) end,
            case when x->>'status' = 'rejected' then 'Identity could not be verified after two attempts.' end,
            owner, x->>'notes');
  end loop;

  -- Breaches & notifications --------------------------------------------
  i := 0;
  for x in select * from jsonb_array_elements(c->'breaches') loop
    i := i + 1;
    br := pg_temp.did(k || '/breach/' || i);
    insert into public.breaches (id, tenant_id, title, description, severity, status, occurred_at, detected_at,
                                 dpb_notification_due_by, affected_count, data_categories, dpb_notified_at,
                                 dpb_reference, principals_notified_at, owner_id, post_mortem, lessons_learned)
    values (br, t, x->>'title', x->>'desc', (x->>'severity')::public.breach_severity,
            (x->>'status')::public.breach_status,
            now() - make_interval(hours => (x->>'age_hours')::int + 6),
            now() - make_interval(hours => (x->>'age_hours')::int),
            now() - make_interval(hours => (x->>'age_hours')::int) + interval '72 hours',
            (x->>'affected')::int, array(select jsonb_array_elements_text(x->'cats')),
            case when x->>'status' in ('notifying_principals','post_mortem','closed')
                 then now() - make_interval(hours => (x->>'age_hours')::int) + interval '40 hours' end,
            case when x->>'status' in ('notifying_principals','post_mortem','closed') then 'DPB/2026/' || upper(k) || '/' || lpad(i::text, 4, '0') end,
            case when x->>'status' in ('post_mortem','closed') then now() - make_interval(hours => (x->>'age_hours')::int) + interval '60 hours' end,
            owner, x->>'post_mortem', x->>'lessons');
    -- Every breach gets a DPB draft; later-stage ones a reviewed or sent notice.
    insert into public.breach_notifications (tenant_id, breach_id, kind, status, language, subject, body,
                                             reviewed_by, reviewed_at, sent_by, sent_at, delivery_outcome,
                                             delivery_attempts, correlation_id, created_by)
    values (t, br, 'dpb',
            case when x->>'status' in ('detected','triaging','contained') then 'draft'
                 when x->>'status' = 'notifying_dpb' then 'reviewed' else 'sent' end::public.breach_notification_status,
            'en', 'Intimation of personal data breach — ' || (x->>'title'),
            'To the Data Protection Board of India. ' || (x->>'desc') ||
            ' Approximate number of affected Data Principals: ' || (x->>'affected') ||
            '. Containment and mitigation measures are under way; a detailed report follows within 72 hours.',
            case when x->>'status' not in ('detected','triaging','contained') then owner end,
            case when x->>'status' not in ('detected','triaging','contained') then now() - make_interval(hours => greatest((x->>'age_hours')::int - 20, 1)) end,
            case when x->>'status' in ('notifying_principals','post_mortem','closed') then founder end,
            case when x->>'status' in ('notifying_principals','post_mortem','closed') then now() - make_interval(hours => (x->>'age_hours')::int) + interval '40 hours' end,
            case when x->>'status' in ('notifying_principals','post_mortem','closed') then 'delivered' end,
            case when x->>'status' in ('notifying_principals','post_mortem','closed') then 1 else 0 end,
            pg_temp.did(k || '/corr/bn/' || i), drafter);
    if x->>'status' in ('notifying_dpb','notifying_principals','post_mortem','closed') then
      insert into public.breach_notifications (tenant_id, breach_id, kind, status, language, subject, body,
                                               reviewed_by, reviewed_at, correlation_id, created_by)
      values (t, br, 'affected_principal',
              case when x->>'status' = 'notifying_dpb' then 'draft' else 'reviewed' end::public.breach_notification_status,
              'hi', 'आपके व्यक्तिगत डेटा से संबंधित सूचना',
              'प्रिय ग्राहक, हम आपको सूचित करना चाहते हैं कि एक सुरक्षा घटना में आपका कुछ व्यक्तिगत डेटा प्रभावित हुआ हो सकता है। हमने तुरंत सुधारात्मक कदम उठाए हैं। अधिक जानकारी के लिए हमारे डेटा संरक्षण अधिकारी से संपर्क करें।',
              case when x->>'status' <> 'notifying_dpb' then owner end,
              case when x->>'status' <> 'notifying_dpb' then now() - interval '1 day' end,
              pg_temp.did(k || '/corr/bnp/' || i), drafter);
    end if;
  end loop;

  -- Consent: purposes, notice snapshots, records, withdrawals -------------
  i := 0;
  for x in select * from jsonb_array_elements(c->'purposes') loop
    i := i + 1;
    pid := pg_temp.did(k || '/purpose/' || i);
    insert into public.consent_purposes (id, tenant_id, purpose_key, name_en, name_hi, description_en,
                                         lawful_basis, notice_version, notice_en, notice_hi, is_active, created_by,
                                         created_at)
    values (pid, t, x->>'key', x->>'name', x->>'name_hi', x->>'desc', x->>'basis', 2,
            x->>'notice', x->>'notice_hi', true, owner, now() - interval '120 days');
    insert into public.consent_notice_versions (tenant_id, purpose_id, notice_version, notice_en, notice_hi,
                                                snapshot_sha256, provenance, created_by, created_at)
    values (t, pid, 1, 'Earlier notice: ' || (x->>'notice'), null, pg_temp.hex(k || '/notice/' || i || '/1'),
            'legacy_current', owner, now() - interval '120 days'),
           (t, pid, 2, x->>'notice', x->>'notice_hi', pg_temp.hex(k || '/notice/' || i || '/2'),
            'published', owner, now() - interval '45 days');
    n := (x->>'records')::int;
    for j in 1..n loop
      rid := pg_temp.did(k || '/consent/' || i || '/' || j);
      insert into public.consent_records (id, tenant_id, purpose_id, principal_type, principal_ref, notice_version,
                                          language, channel, status, granted_at, granted_by, withdrawn_at,
                                          legal_hold, expires_at, correlation_id, notice_snapshot_sha256)
      values (rid, t, pid,
              case when j % 4 = 0 then 'phone' when j % 7 = 0 then 'cookie_id' else 'email' end,
              case when j % 4 = 0 then '+91-98' || lpad((j * 7919 % 100000000)::text, 8, '0')
                   when j % 7 = 0 then 'ck_' || substr(md5(k || i || j), 1, 20)
                   else 'principal.' || i || '.' || j || '@principal.example' end,
              case when j % 3 = 0 then 1 else 2 end,
              case when j % 5 = 0 then 'hi' else 'en' end,
              (array['form','api','cookie','offline'])[1 + j % 4],
              case when j % (x->>'withdraw_every')::int = 0 then 'withdrawn' else 'granted' end,
              now() - make_interval(days => 5 + (j * 13) % 110), owner,
              case when j % (x->>'withdraw_every')::int = 0 then now() - make_interval(days => (j * 3) % 20) end,
              j = 2, now() + interval '1 year',
              pg_temp.did(k || '/corr/consent/' || i || '/' || j),
              pg_temp.hex(k || '/notice/' || i || '/' || case when j % 3 = 0 then 1 else 2 end));
      if j % (x->>'withdraw_every')::int = 0 then
        fid := pg_temp.did(k || '/withdraw/' || i || '/' || j);
        insert into public.consent_withdrawals (id, tenant_id, consent_record_id, purpose_id, principal_type,
                                                principal_ref, reason, language, downstream_completed_at,
                                                requested_by, correlation_id, created_at)
        select fid, t, r.id, r.purpose_id, r.principal_type, r.principal_ref,
               (array['No longer a customer','Too many messages','Privacy preference', null])[1 + j % 4],
               r.language, case when j % 2 = 0 then r.withdrawn_at + interval '6 hours' end,
               owner, pg_temp.did(k || '/corr/wd/' || i || '/' || j), r.withdrawn_at
          from public.consent_records r where r.id = rid;
        update public.consent_records set withdrawn_via_consent_id = fid where id = rid;
      end if;
    end loop;
  end loop;

  -- Continuous monitoring -----------------------------------------------
  insert into public.monitoring_schedules (id, tenant_id, estate_id, name, kind, cadence, status, created_by,
                                           last_run_at, next_run_at)
  values (pg_temp.did(k || '/sched/1'), t, estate, 'Nightly drift check', 'drift_check', '30 1 * * *', 'active', owner,
          now() - interval '22 hours', now() + interval '2 hours'),
         (pg_temp.did(k || '/sched/2'), t, estate, 'Weekly rediscovery', 'rediscovery', '0 3 * * 1', 'active', owner,
          now() - interval '9 days', now() - interval '2 days'),
         (pg_temp.did(k || '/sched/3'), t, estate, 'Quarterly reassessment', 'reassessment', '0 4 1 */3 *',
          case when c->>'sector' = 'saas' then 'active' else 'paused' end, owner,
          now() - interval '80 days', now() + interval '10 days');

  i := 0;
  for x in select * from jsonb_array_elements(c->'drift') loop
    i := i + 1;
    insert into public.drift_events (id, tenant_id, estate_id, kind, severity, summary, source_ref, detected_at,
                                     acknowledged_by, acknowledged_at)
    values (pg_temp.did(k || '/drift/' || i), t, estate, x->>'kind', x->>'severity', x->>'summary', x->>'ref',
            now() - make_interval(hours => 6 + i * 19),
            case when (x->>'ack')::boolean then owner end,
            case when (x->>'ack')::boolean then now() - make_interval(hours => i * 5) end);
    insert into public.monitoring_alerts (tenant_id, alert_type, severity, title, summary, source_id, source_type,
                                          status, dispatched_at, acknowledged_at, acknowledged_by, metadata)
    values (t, case when x->>'severity' = 'critical' then 'drift_critical' else 'drift_high' end,
            x->>'severity', 'Drift detected: ' || (x->>'kind'), x->>'summary',
            pg_temp.did(k || '/drift/' || i)::text, 'drift_event',
            case when (x->>'ack')::boolean then 'acknowledged' when i = 1 then 'unread' else 'read' end,
            now() - make_interval(hours => 6 + i * 19),
            case when (x->>'ack')::boolean then now() - make_interval(hours => i * 5) end,
            case when (x->>'ack')::boolean then owner end,
            jsonb_build_object('estate', c->>'estate_name', 'demo', true))
    on conflict do nothing;
  end loop;
  insert into public.monitoring_alerts (tenant_id, alert_type, severity, title, summary, source_id, source_type, status, metadata)
  values (t, 'schedule_overdue', 'medium', 'Weekly rediscovery is overdue',
          'The weekly rediscovery schedule missed its last window; the estate inventory may be stale.',
          pg_temp.did(k || '/sched/2')::text, 'monitoring_schedule', 'unread', '{"demo": true}')
  on conflict do nothing;
  insert into public.monitoring_alerts (tenant_id, alert_type, severity, title, summary, source_id, source_type, status, metadata)
  select t, case when d.due_by < now() then 'compliance_deadline_breached' else 'compliance_deadline_burning' end,
         case when d.due_by < now() then 'high' else 'medium' end,
         'DSAR deadline ' || case when d.due_by < now() then 'missed' else 'approaching' end || ': ' || d.kind,
         'Request from ' || d.data_principal_name || ' is due ' || to_char(d.due_by, 'DD Mon YYYY') || '.',
         d.id::text, 'dsar', 'unread', '{"demo": true}'
    from public.dsars d
   where d.tenant_id = t and d.status not in ('completed','rejected') and d.due_by < now() + interval '7 days'
  on conflict do nothing;

  insert into public.compliance_events (tenant_id, title, description, due_at, control_id, dsar_id, breach_id, plan_id, status, completed_at)
  select t, 'DSAR due: ' || d.kind || ' — ' || d.data_principal_name, 'Statutory response window.', d.due_by,
         'DPDPA-DAT-001', d.id, null, null,
         case when d.status in ('completed','rejected') then 'completed' else 'open' end,
         d.completed_at
    from public.dsars d where d.tenant_id = t;
  insert into public.compliance_events (tenant_id, title, description, due_at, control_id, breach_id, status)
  select t, 'DPB intimation due: ' || b.title, '72-hour detailed report to the Data Protection Board.',
         b.dpb_notification_due_by, 'DPDPA-BRCH-001', b.id,
         case when b.dpb_notified_at is null then 'open' else 'completed' end
    from public.breaches b where b.tenant_id = t;
  insert into public.compliance_events (tenant_id, title, description, due_at, control_id, plan_id, status)
  values (t, 'Annual board privacy report', 'Present posture and residual risk to the Board.', now() + interval '25 days',
          'DPDPA-AUD-002', null, 'open'),
         (t, 'Approve remediation plan: ' || (c->'plans'->'live'->>'title'), 'Pending human approval.',
          now() + interval '5 days', null, p_live, 'open');

  -- Standing approval policies --------------------------------------------
  insert into public.standing_approval_policies (id, tenant_id, name, version, scope, status, created_by,
                                                 approved_by, expires_at, created_at)
  values (pg_temp.did(k || '/sap/1'), t, 'Low-risk notice and consent UI updates', 1,
          '{"action_types": ["notice.update", "config.consent_ui_update"], "max_risk_class": "low", "max_rows": 0}',
          'active', owner, founder, now() + interval '90 days', now() - interval '30 days'),
         (pg_temp.did(k || '/sap/2'), t, 'Masking in non-production replicas', 1,
          '{"action_types": ["data.mask"], "max_risk_class": "medium", "environments": ["staging", "analytics"]}',
          case when c->>'sector' = 'health' then 'revoked' else 'active' end, owner, founder,
          now() + interval '60 days', now() - interval '28 days');
  insert into public.policy_evaluations (tenant_id, policy_id, plan_id, decision, matched_scope, correlation_id, evaluated_at)
  values (t, pg_temp.did(k || '/sap/1'), p_done, 'within_policy', '{"action_types": ["notice.update"]}',
          pg_temp.did(k || '/corr/pe/1'), now() - interval '20 days'),
         (t, pg_temp.did(k || '/sap/2'), p_live, 'escalated', '{"reason": "production data in scope"}',
          pg_temp.did(k || '/corr/pe/2'), now() - interval '3 days');

  -- Classification reviews ------------------------------------------------
  i := 0;
  for x in select * from jsonb_array_elements(c->'classifications') loop
    i := i + 1;
    insert into public.classification_reviews (tenant_id, estate_id, system_id, resource_path, sensitivity_level,
                                               detected_categories, confidence_score, reviewed_by, decision,
                                               adjusted_sensitivity, justification, created_at)
    values (t, estate, pg_temp.did(k || '/sys/' || (x->>'sys'))::text, x->>'path', x->>'level',
            array(select jsonb_array_elements_text(x->'cats')), (x->>'conf')::numeric, reviewer, x->>'decision',
            x->>'adjusted', x->>'why', now() - make_interval(days => i * 2));
  end loop;

  -- Invitations (one pending, one revoked) --------------------------------
  insert into public.tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at, created_at)
  values (t, 'auditor@' || (c->>'domain'), 'reviewer', pg_temp.hex(k || '/inv/1'), owner,
          now() + interval '10 days', now() - interval '1 day');
  insert into public.tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at,
                                         revoked_at, revoked_by, created_at)
  values (t, 'contractor@' || (c->>'domain'), 'viewer', pg_temp.hex(k || '/inv/2'), owner,
          now() + interval '5 days', now() - interval '2 days', owner, now() - interval '6 days');

  -- Ledger narrative (sanctioned writer only) ------------------------------
  corr := pg_temp.did(k || '/corr/ledger');
  for x in select * from jsonb_array_elements(jsonb_build_array(
      jsonb_build_array('system','platform','tenant.created', c->>'name', 'success', '{}'::jsonb),
      jsonb_build_array('human', owner::text, 'estate.created', c->>'estate_name', 'success', '{}'::jsonb),
      jsonb_build_array('agent','drishti','discovery.started', c->>'estate_name', 'success', '{}'::jsonb),
      jsonb_build_array('agent','drishti','discovery.batch.completed', c->'systems'->0->>'name', 'success',
                        jsonb_build_object('systems', jsonb_array_length(c->'systems'), 'records_sampled', 184000)),
      jsonb_build_array('agent','vibhaag','classification.batch.completed', c->'systems'->1->>'name', 'success',
                        '{"columns_classified": 412, "critical_pii_columns": 37}'::jsonb),
      jsonb_build_array('agent','vibhaag','classification.review_queued', c->'systems'->1->>'name', 'pending', '{"queued": 6}'::jsonb),
      jsonb_build_array('agent','parikshan','assessment.started', eng::text, 'success', '{}'::jsonb),
      jsonb_build_array('agent','parikshan','assessment.scored', eng::text, 'success', jsonb_build_object('posture_score', posture)),
      jsonb_build_array('agent','saakshi','evidence.collected', eng::text, 'success', jsonb_build_object('items', jsonb_array_length(c->'evidence'))),
      jsonb_build_array('agent','saakshi','evidence.sealed', eng::text, 'success', '{"worm": "compliance_mode", "retention_years": 7}'::jsonb),
      jsonb_build_array('agent','sudhaar','plan.generated', p_done::text, 'success', '{}'::jsonb),
      jsonb_build_array('agent','sudhaar','plan.dry_run.completed', p_done::text, 'success', '{}'::jsonb),
      jsonb_build_array('human', approver::text, 'approval.token.issued', p_done::text, 'success', '{"mfa": "totp"}'::jsonb),
      jsonb_build_array('agent','karya','execution.started', p_done::text, 'success', '{}'::jsonb),
      jsonb_build_array('agent','karya','execution.batch.completed', p_done::text, 'success', '{}'::jsonb),
      jsonb_build_array('agent','parikshan','verification.passed', p_done::text, 'success', '{}'::jsonb),
      jsonb_build_array('agent','karya','execution.action.failed', p_fail::text, 'failure', '{"reason": "post-state verification failed"}'::jsonb),
      jsonb_build_array('agent','karya','execution.rollback.completed', p_fail::text, 'rolled_back', '{"duration_seconds": 41}'::jsonb),
      jsonb_build_array('agent','sudhaar','plan.generated', p_live::text, 'success', '{}'::jsonb),
      jsonb_build_array('agent','sudhaar','plan.approval_requested', p_live::text, 'pending', '{}'::jsonb),
      jsonb_build_array('human', owner::text, 'dsar.received', 'dsar', 'success', jsonb_build_object('count', jsonb_array_length(c->'dsars'))),
      jsonb_build_array('human', owner::text, 'dsar.fulfilled', 'dsar', 'success', '{}'::jsonb),
      jsonb_build_array('human', owner::text, 'breach.detected', c->'breaches'->0->>'title', 'success', '{}'::jsonb),
      jsonb_build_array('agent','nazar','discovery.drift_detected', c->'drift'->0->>'ref', 'success', '{}'::jsonb),
      jsonb_build_array('agent','lekha','report.generated', eng::text, 'success', '{"kind": "gap_scan"}'::jsonb)
    )) loop
    perform public.append_ledger(
      t, corr, (x->>0)::public.actor_type, x->>1,
      case when x->>0 = 'agent' then '1.4.0' end,
      case when x->>0 = 'agent' then 'axiom-gateway/qwen-2.5-72b-instruct-ap-south-1' end,
      case when x->>0 = 'agent' then pg_temp.hex(k || '/prompt/' || (x->>2)) end,
      (x->>2)::public.ledger_action_type, x->>3,
      pg_temp.hex(k || '/in/' || (x->>2) || (x->>3)), pg_temp.hex(k || '/out/' || (x->>2) || (x->>3)),
      case when x->>2 = 'approval.token.issued' then tok_done end,
      case when x->>2 = 'approval.token.issued' then approver end,
      null, null, (x->>4)::public.ledger_result, (x->5) || '{"demo": true}'::jsonb);
  end loop;

  -- Operator workflows: RoPA, delivery tasks, policy drafts -----------------
  ropa_id := null;
  i := 0;
  for x in select * from jsonb_array_elements(c->'ropa') loop
    i := i + 1;
    receipt := public.record_operator_workflow(t, owner, pg_temp.did(k || '/ow/ropa/' || i), 'ropa',
                 x || jsonb_build_object('engagementId', eng), pg_temp.did(k || '/corr/ow/ropa/' || i));
    if receipt ? 'error' then raise exception 'ropa workflow refused for %: %', k, receipt; end if;
    if ropa_id is null then
      select id into ropa_id from public.operator_workflow_records
       where tenant_id = t and operation_key = pg_temp.did(k || '/ow/ropa/' || i);
    end if;
  end loop;
  i := 0;
  for x in select * from jsonb_array_elements(c->'tasks') loop
    i := i + 1;
    receipt := public.record_operator_workflow(t, owner, pg_temp.did(k || '/ow/task/' || i), 'delivery_task',
                 x || jsonb_build_object('engagementId', eng), pg_temp.did(k || '/corr/ow/task/' || i));
    if receipt ? 'error' then raise exception 'delivery task refused for %: %', k, receipt; end if;
  end loop;
  i := 0;
  for x in select * from jsonb_array_elements(c->'policies') loop
    i := i + 1;
    receipt := public.record_operator_workflow(t, owner, pg_temp.did(k || '/ow/policy/' || i), 'policy_draft',
                 x || jsonb_build_object('engagementId', eng, 'sourceRopaId', ropa_id,
                                         'sourceNote', 'Drafted from the recorded RoPA and current findings.'),
                 pg_temp.did(k || '/corr/ow/policy/' || i));
    if receipt ? 'error' then raise exception 'policy draft refused for %: %', k, receipt; end if;
  end loop;
end $fn$;

-- ── Sector configurations ───────────────────────────────────────────
select pg_temp.seed_company('fd5e0001-0000-4000-8000-000000000001', $json$
{
  "key": "kosha", "sector": "bfsi", "name": "Kosha Capital Finance Ltd", "domain": "kosha-capital.example",
  "estate_name": "Kosha lending and payments estate",
  "estate_desc": "NBFC digital lending, UPI collections and co-branded credit cards. Primary region ap-south-1.",
  "title": "DPDPA FY26 assessment — lending & payments", "status": "awaiting_approval", "exposure": 1850000000,
  "prev_title": "DPDPA readiness baseline (FY25)", "prev_exposure": 3200000000,
  "base_score": 74, "improvement": 14,
  "domain_scores": {"SEC": 86, "CNS": 64, "RTN": 52, "XBR": 80, "CHD": 92, "BRCH": 78, "DAT": 70, "AUD": 82, "GOV": 80, "SDF": 68, "DPIA": 60},
  "rationale": {"RTN": "Rejected loan applications retained beyond 36 months in the data lake.",
                "CNS": "Cross-sell marketing consent bundled with loan T&C on the mobile app.",
                "SDF": "DPO appointed; first independent data audit not yet scheduled."},
  "systems": [
    {"name": "Loan Origination DB (Oracle)", "kind": "database", "ref": "oracle://lo-prod.kosha.internal/LOANS", "desc": "Applications, KYC references, bureau scores.", "cats": ["kyc-identity", "financial-account", "credit-history", "contact-details"]},
    {"name": "KYC Vault (Aadhaar / PAN)", "kind": "storage", "ref": "s3://kosha-kyc-vault-ap-south-1", "desc": "Masked Aadhaar, PAN images, video-KYC recordings.", "cats": ["kyc-identity", "biometric-image"]},
    {"name": "Kosha Mobile Lending App", "kind": "application", "ref": "app://com.kosha.lend", "desc": "Customer onboarding, EMI payments, offers.", "cats": ["contact-details", "device-identifiers", "location"]},
    {"name": "Credit Bureau Gateway", "kind": "saas", "ref": "https://bureau-gw.kosha.example", "desc": "Bureau pulls and account-aggregator fetches.", "cats": ["credit-history", "financial-account"]},
    {"name": "Customer Data Lake", "kind": "storage", "ref": "s3://kosha-datalake-ap-south-1", "desc": "Analytics copies of loan and repayment history.", "cats": ["financial-account", "credit-history", "kyc-identity"]},
    {"name": "Collections CRM", "kind": "saas", "ref": "https://kosha-collections.crm.example", "desc": "Collections agent workflows and call notes.", "cats": ["contact-details", "financial-account"]},
    {"name": "Workforce Identity (Okta)", "kind": "identity", "ref": "https://kosha.okta.example", "desc": "Staff SSO and MFA.", "cats": ["employee-identity"]}
  ],
  "evidence": [
    {"file": "privacy-policy-v4.pdf", "mime": "application/pdf", "type": "document", "desc": "Published privacy policy v4 (EN/HI).", "controls": ["DPDPA-GOV-002", "DPDPA-CNS-002"]},
    {"file": "dpo-appointment-board-resolution.pdf", "mime": "application/pdf", "type": "attestation", "desc": "Board resolution appointing the DPO.", "controls": ["DPDPA-SDF-001", "DPDPA-GOV-001"]},
    {"file": "okta-mfa-policy-export.json", "mime": "application/json", "type": "config", "desc": "Workforce MFA policy export.", "controls": ["DPDPA-SEC-001", "DPDPA-SEC-002"]},
    {"file": "kms-backup-encryption.json", "mime": "application/json", "type": "config", "desc": "Backup KMS encryption configuration.", "controls": ["DPDPA-SEC-005"]},
    {"file": "vapt-report-q2.pdf", "mime": "application/pdf", "type": "report", "desc": "Q2 VAPT by CERT-In empanelled auditor.", "controls": ["DPDPA-SEC-004"]},
    {"file": "consent-ledger-sample.csv", "mime": "text/csv", "type": "log", "desc": "Consent ledger sample, 500 rows.", "controls": ["DPDPA-CNS-003"]},
    {"file": "ropa-lending.xlsx", "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "type": "inventory", "desc": "RoPA for lending purposes.", "controls": ["DPDPA-RCD-001", "DPDPA-RCD-002"]},
    {"file": "breach-playbook-v2.pdf", "mime": "application/pdf", "type": "document", "desc": "Breach response playbook with DPB timelines.", "controls": ["DPDPA-BRCH-003", "DPDPA-SEC-007"]}
  ],
  "plans": {
    "done": {"title": "Harden access to KYC data", "desc": "Least-privilege and MFA for systems holding KYC data.",
      "actions": [
        {"type": "config.mfa_enforce", "desc": "Enforce phishing-resistant MFA for Collections CRM admins", "risk": "low", "score": 18, "blast": {"users": 42, "target": "Collections CRM"}},
        {"type": "config.rbac_update", "desc": "Remove standing read access to KYC Vault for analytics roles", "risk": "medium", "score": 35, "blast": {"roles": 4, "target": "KYC Vault"}},
        {"type": "config.audit_log_enable", "desc": "Enable object-level access logging on KYC Vault", "risk": "low", "score": 10, "blast": {"buckets": 1, "target": "KYC Vault"}}
      ]},
    "live": {"title": "Retention and consent clean-up — lending", "desc": "Purge stale rejected applications and unbundle marketing consent.",
      "actions": [
        {"type": "data.retention_purge", "desc": "Purge rejected loan applications older than 36 months from the data lake", "risk": "high", "score": 62, "blast": {"rows": 128400, "target": "Customer Data Lake"}, "params": {"table": "loan_applications_rejected", "older_than_months": 36}, "rollback": {"strategy": "point_in_time_snapshot_restore", "snapshot_ref": "snap-datalake-mumbai-0412"}},
        {"type": "data.mask", "desc": "Mask Aadhaar numbers (all but last 4) in analytics replicas", "risk": "medium", "score": 30, "blast": {"rows": 23800, "target": "Customer Data Lake"}, "params": {"columns": ["aadhaar_number"]}, "rollback": {"strategy": "drop_masking_policy", "policy": "mask_aadhaar_analytics"}},
        {"type": "config.consent_ui_update", "desc": "Separate cross-sell marketing consent from loan terms in the mobile app", "risk": "low", "score": 15, "blast": {"screens": 3, "target": "Kosha Mobile Lending App"}, "rollback": {"strategy": "feature_flag_revert", "flag": "consent_unbundled"}}
      ]},
    "failed": {"title": "Encrypt legacy statement exports", "desc": "Move statement exports to KMS-encrypted storage.",
      "actions": [
        {"type": "config.backup_encrypt", "desc": "Enable default KMS encryption on statement export bucket", "risk": "low", "score": 12, "blast": {"buckets": 1, "target": "statement-exports"}},
        {"type": "data.delete", "desc": "Delete unencrypted statement exports after copy", "risk": "high", "score": 70, "blast": {"rows": 9100, "target": "statement-exports"}, "rollback": {"strategy": "versioned_object_restore"}},
        {"type": "policy.update", "desc": "Update export retention standard", "risk": "low", "score": 8}
      ]},
    "draft": {"title": "Account-aggregator consent artefacts", "desc": "Align AA consent artefacts with DPDPA notice requirements.",
      "actions": [
        {"type": "notice.update", "desc": "Publish AA data-fetch notice in English and Hindi", "risk": "low", "score": 10},
        {"type": "consent.update", "desc": "Re-collect consent for AA fetches older than 12 months", "risk": "medium", "score": 40, "blast": {"rows": 61000}}
      ]}
  },
  "dsars": [
    {"kind": "access", "status": "completed", "name": "Rohan Mehta", "age": 25, "method": "aadhaar_otp", "notes": "Account and repayment summary delivered."},
    {"kind": "correction", "status": "in_fulfilment", "name": "Priya Nair", "age": 12, "method": "registered_mobile_otp", "notes": "Address correction pending bureau update."},
    {"kind": "erasure", "status": "identity_verification", "name": "Arjun Singh", "age": 4, "notes": "Closed loan account; erasure subject to RBI retention."},
    {"kind": "erasure", "status": "rejected", "name": "Kavita Joshi", "age": 40, "method": "video_kyc", "notes": "Active loan; statutory retention applies."},
    {"kind": "portability", "status": "received", "name": "Sameer Khan", "age": 1, "notes": "Requests repayment history as CSV."},
    {"kind": "nominate", "status": "completed", "name": "Lakshmi Iyer", "age": 33, "method": "aadhaar_otp", "notes": "Nominee recorded."},
    {"kind": "access", "status": "escalated", "name": "Vikram Desai", "age": 28, "method": "registered_mobile_otp", "notes": "Escalated by grievance officer — response overdue."}
  ],
  "breaches": [
    {"title": "Misdirected loan statement emails", "desc": "A mail-merge fault sent 214 monthly statements to the wrong recipients.", "severity": "medium", "status": "closed", "age_hours": 1100, "affected": 214, "cats": ["financial-account", "contact-details"], "post_mortem": "Mail-merge key used a non-unique customer reference.", "lessons": "Add a recipient checksum to every statement batch."}
  ],
  "purposes": [
    {"key": "loan_processing", "name": "Loan processing", "name_hi": "ऋण प्रक्रिया", "desc": "Assess and service loan applications.", "basis": "consent", "notice": "We use your identity, income and bureau data to assess and service your loan.", "notice_hi": "हम आपके ऋण के मूल्यांकन के लिए आपकी पहचान और आय जानकारी का उपयोग करते हैं।", "records": 18, "withdraw_every": 9},
    {"key": "credit_bureau_check", "name": "Credit bureau check", "name_hi": "क्रेडिट ब्यूरो जाँच", "desc": "Fetch your credit report.", "basis": "consent", "notice": "We fetch your credit report from licensed bureaus to decide on your application.", "records": 14, "withdraw_every": 7},
    {"key": "marketing_cross_sell", "name": "Offers and cross-sell", "name_hi": "प्रस्ताव", "desc": "Send offers for other products.", "basis": "consent", "notice": "We would like to send you offers for cards and insurance. You can withdraw at any time.", "records": 16, "withdraw_every": 3},
    {"key": "fraud_prevention", "name": "Fraud prevention", "desc": "Detect and prevent fraud.", "basis": "legitimate_uses", "notice": "We process device and transaction signals to prevent fraud.", "records": 6, "withdraw_every": 100}
  ],
  "drift": [
    {"kind": "system_added", "severity": "high", "summary": "New S3 bucket kosha-marketing-exports created without classification.", "ref": "s3://kosha-marketing-exports", "ack": false},
    {"kind": "control_drift", "severity": "medium", "summary": "Access logging disabled on one KYC Vault prefix.", "ref": "s3://kosha-kyc-vault-ap-south-1/vkyc/", "ack": true},
    {"kind": "connection_lost", "severity": "low", "summary": "Credit Bureau Gateway read connector failed health check.", "ref": "bureau-gw", "ack": true}
  ],
  "classifications": [
    {"sys": 1, "path": "LOANS.APPLICANTS.PAN_NUMBER", "level": "critical_pii", "cats": ["kyc-identity"], "conf": 97.5, "decision": "confirmed", "why": "PAN is a government identifier."},
    {"sys": 2, "path": "vkyc/2026/09/*.mp4", "level": "critical_pii", "cats": ["biometric-image"], "conf": 91.0, "decision": "confirmed", "why": "Video-KYC contains face biometrics."},
    {"sys": 5, "path": "analytics/repayments/*.parquet", "level": "confidential", "cats": ["financial-account"], "conf": 72.0, "decision": "adjusted", "adjusted": "restricted", "why": "Joins to customer ids; treat as restricted."},
    {"sys": 3, "path": "events.device_fingerprint", "level": "restricted", "cats": ["device-identifiers"], "conf": 64.0, "decision": "adjusted", "adjusted": "confidential", "why": "Hashed fingerprint, not directly identifying."},
    {"sys": 6, "path": "call_notes.free_text", "level": "internal", "cats": ["contact-details"], "conf": 55.0, "decision": "overridden", "adjusted": "restricted", "why": "Agents record health and family details in free text."},
    {"sys": 7, "path": "okta.users.title", "level": "internal", "cats": ["employee-identity"], "conf": 81.0, "decision": "dismissed", "why": "Job titles only; not personal data of customers."}
  ],
  "ropa": [
    {"sourceNote": "Lending operations workshop with the DPO.", "system": "Loan Origination DB (Oracle)", "purpose": "Loan origination and servicing", "legalBasis": "Consent", "retentionMonths": 96, "dataCategories": ["KYC identity", "Income", "Bureau score"], "processors": ["Credit bureau", "Cloud provider (Mumbai)"], "region": "ap-south-1", "crossBorder": false, "securityMeasures": "Encryption at rest, column masking, MFA for admins.", "dataPrincipals": ["Loan applicants", "Co-borrowers"], "recipients": ["Credit bureaus", "RBI (on request)"], "destinationCountries": [], "transferSafeguards": null, "dpiaRequired": true},
    {"sourceNote": "Marketing team interview.", "system": "Kosha Mobile Lending App", "purpose": "Cross-sell offers", "legalBasis": "Consent", "retentionMonths": 24, "dataCategories": ["Contact details", "Product holdings"], "processors": ["SMS gateway"], "region": "ap-south-1", "crossBorder": false, "securityMeasures": "Opt-out honoured within 24h.", "dataPrincipals": ["Customers"], "recipients": [], "destinationCountries": [], "transferSafeguards": null, "dpiaRequired": false}
  ],
  "tasks": [
    {"taskName": "Bureau consent mapping workshop", "source": "DPO calendar", "durationMinutes": 90, "repetitions": 1, "notes": "Map bureau pulls to consent artefacts."},
    {"taskName": "Weekly DSAR triage", "source": "Grievance desk", "durationMinutes": 30, "repetitions": 12, "notes": "Review open requests and deadlines."}
  ],
  "policies": [
    {"title": "Data retention standard — lending", "category": "retention", "content": "1. Scope: all lending systems.\n2. Rejected applications are erased after 36 months unless a legal hold applies.\n3. KYC records follow RBI master direction retention.\n4. Exceptions are recorded in the exception register."},
    {"title": "Customer privacy notice (EN/HI)", "category": "privacy_notice", "content": "Kosha Capital collects identity, income and bureau data to process your loan. You may access, correct or erase your data, nominate another person, and withdraw consent at any time through the app or our DPO."}
  ]
}
$json$::jsonb);

select pg_temp.seed_company('fd5e0002-0000-4000-8000-000000000002', $json$
{
  "key": "sanjeevani", "sector": "health", "name": "Sanjeevani Care Hospitals Pvt Ltd", "domain": "sanjeevani-care.example",
  "estate_name": "Sanjeevani clinical and patient estate",
  "estate_desc": "Three multi-specialty hospitals, paediatric wing, telemedicine and diagnostics.",
  "title": "DPDPA assessment — clinical systems and telemedicine", "status": "planning", "exposure": 2500000000,
  "prev_title": "Initial privacy gap scan", "prev_exposure": 2500000000,
  "base_score": 47, "improvement": 6,
  "domain_scores": {"SEC": 42, "BRCH": 30, "CHD": 35, "CNS": 50, "DAT": 55, "GOV": 62, "RCD": 40, "RTN": 45, "XBR": 70, "AUD": 38, "SDF": 48, "DPIA": 32, "DPF": 66},
  "rationale": {"SEC": "Imaging archive bucket lacked access controls until the incident.",
                "CHD": "Paediatric telemedicine sign-up has no verifiable parental consent.",
                "BRCH": "Breach playbook exists but DPB timelines were not rehearsed."},
  "systems": [
    {"name": "HIS / EMR (PostgreSQL)", "kind": "database", "ref": "postgres://emr-prod.sanjeevani.internal/emr", "desc": "Patient records, diagnoses, prescriptions.", "cats": ["health-records", "contact-details", "abha-id"]},
    {"name": "PACS Imaging Archive", "kind": "storage", "ref": "s3://sanjeevani-pacs-ap-south-1", "desc": "DICOM images and reports.", "cats": ["diagnostic-images", "health-records"]},
    {"name": "Telemedicine App", "kind": "application", "ref": "app://in.sanjeevani.care", "desc": "Video consults including paediatrics.", "cats": ["health-records", "children-data", "contact-details"]},
    {"name": "Laboratory Information System", "kind": "application", "ref": "https://lis.sanjeevani.internal", "desc": "Lab orders and results.", "cats": ["health-records", "genetic-data"]},
    {"name": "Insurance TPA Exchange", "kind": "saas", "ref": "https://tpa-exchange.example", "desc": "Cashless claims with TPAs.", "cats": ["insurance-policy", "health-records"]},
    {"name": "Patient Portal Identity", "kind": "identity", "ref": "https://id.sanjeevani-care.example", "desc": "Patient login and family accounts.", "cats": ["contact-details", "children-data"]}
  ],
  "evidence": [
    {"file": "patient-consent-form-v2.pdf", "mime": "application/pdf", "type": "document", "desc": "Admission consent form (EN/HI).", "controls": ["DPDPA-CNS-001", "DPDPA-CNS-002"]},
    {"file": "pacs-bucket-policy-after-fix.json", "mime": "application/json", "type": "config", "desc": "PACS bucket policy after incident fix.", "controls": ["DPDPA-SEC-001", "DPDPA-SEC-002"]},
    {"file": "incident-timeline-pacs.pdf", "mime": "application/pdf", "type": "report", "desc": "Incident timeline for the PACS exposure.", "controls": ["DPDPA-BRCH-001", "DPDPA-SEC-007"]},
    {"file": "dpo-designation.pdf", "mime": "application/pdf", "type": "attestation", "desc": "DPO designation letter.", "controls": ["DPDPA-SDF-001"]},
    {"file": "emr-access-review.csv", "mime": "text/csv", "type": "log", "desc": "Quarterly EMR access review.", "controls": ["DPDPA-SEC-003"]}
  ],
  "plans": {
    "done": {"title": "Contain PACS exposure", "desc": "Close public access and enable logging on the imaging archive.",
      "actions": [
        {"type": "config.rbac_update", "desc": "Block public access on PACS archive bucket", "risk": "medium", "score": 40, "blast": {"buckets": 1, "target": "PACS Imaging Archive"}},
        {"type": "config.audit_log_enable", "desc": "Enable server access logging on PACS archive", "risk": "low", "score": 10, "blast": {"buckets": 1, "target": "PACS Imaging Archive"}}
      ]},
    "live": {"title": "Children's data and health record safeguards", "desc": "Parental consent for paediatric telemedicine and masking in research extracts.",
      "actions": [
        {"type": "consent.update", "desc": "Require verifiable parental consent before paediatric tele-consults", "risk": "medium", "score": 38, "blast": {"screens": 4, "target": "Telemedicine App"}, "rollback": {"strategy": "feature_flag_revert", "flag": "parental_consent_gate"}},
        {"type": "data.mask", "desc": "Mask patient names and ABHA ids in research extracts", "risk": "medium", "score": 34, "blast": {"rows": 86000, "target": "HIS / EMR (PostgreSQL)"}, "params": {"columns": ["patient_name", "abha_id"]}},
        {"type": "config.backup_encrypt", "desc": "Encrypt LIS nightly backups with hospital KMS key", "risk": "low", "score": 14, "blast": {"target": "Laboratory Information System"}},
        {"type": "breach.playbook_publish", "desc": "Publish revised breach playbook with 72-hour DPB timeline", "risk": "low", "score": 6}
      ]},
    "failed": {"title": "Purge discharged-patient duplicates", "desc": "Remove duplicate demographic records after merge.",
      "actions": [
        {"type": "data.mask", "desc": "Mask duplicate demographic rows before merge", "risk": "low", "score": 20, "blast": {"rows": 4100}},
        {"type": "data.delete", "desc": "Delete merged duplicate patient records", "risk": "critical", "score": 82, "blast": {"rows": 9100, "target": "HIS / EMR (PostgreSQL)"}, "rollback": {"strategy": "point_in_time_snapshot_restore"}},
        {"type": "policy.update", "desc": "Record merge rule in data quality standard", "risk": "low", "score": 5}
      ]},
    "draft": {"title": "DPIA for AI radiology triage", "desc": "Assess the proposed AI triage pilot before launch.",
      "actions": [
        {"type": "review.accept_risk", "desc": "Record DPIA outcome for the radiology triage pilot", "risk": "medium", "score": 45}
      ]}
  },
  "dsars": [
    {"kind": "access", "status": "in_fulfilment", "name": "Meena Pillai", "age": 22, "method": "abha_otp", "notes": "Copy of discharge summaries and lab reports."},
    {"kind": "correction", "status": "completed", "name": "Harish Rao", "age": 30, "method": "registered_mobile_otp", "notes": "Date of birth corrected."},
    {"kind": "erasure", "status": "escalated", "name": "Zoya Shaikh", "age": 35, "method": "abha_otp", "notes": "Requests erasure of telemedicine recordings; clinical retention conflict."},
    {"kind": "access", "status": "identity_verification", "name": "Gurpreet Kaur", "age": 3, "notes": "Parent requesting a child's records."},
    {"kind": "nominate", "status": "received", "name": "Thomas Mathew", "age": 1, "notes": "Nominee for an elderly patient."},
    {"kind": "portability", "status": "in_fulfilment", "name": "Anita Desai", "age": 27, "method": "aadhaar_otp", "notes": "Transfer records to another hospital — due soon."}
  ],
  "breaches": [
    {"title": "PACS imaging archive publicly listable", "desc": "A misconfigured bucket policy allowed anonymous listing of DICOM metadata (names, ages, study types) for about 31,000 studies.", "severity": "critical", "status": "notifying_dpb", "age_hours": 40, "affected": 31200, "cats": ["diagnostic-images", "health-records", "children-data"]},
    {"title": "Unencrypted laptop lost at billing desk", "desc": "A billing laptop with cached TPA claim spreadsheets was reported lost.", "severity": "medium", "status": "contained", "age_hours": 300, "affected": 1450, "cats": ["insurance-policy", "contact-details"]}
  ],
  "purposes": [
    {"key": "treatment", "name": "Treatment and care", "name_hi": "उपचार", "desc": "Provide medical care.", "basis": "legitimate_uses", "notice": "We process your health information to treat you.", "notice_hi": "हम आपके उपचार के लिए आपकी स्वास्थ्य जानकारी का उपयोग करते हैं।", "records": 10, "withdraw_every": 100},
    {"key": "telemedicine_recording", "name": "Consult recording", "name_hi": "परामर्श रिकॉर्डिंग", "desc": "Record video consultations.", "basis": "consent", "notice": "With your consent we record tele-consultations for quality and continuity of care.", "records": 15, "withdraw_every": 4},
    {"key": "research_use", "name": "De-identified research", "desc": "Use de-identified data for research.", "basis": "consent", "notice": "We may use de-identified records for approved clinical research.", "records": 12, "withdraw_every": 3}
  ],
  "drift": [
    {"kind": "control_drift", "severity": "critical", "summary": "PACS bucket policy allowed anonymous ListBucket.", "ref": "s3://sanjeevani-pacs-ap-south-1", "ack": true},
    {"kind": "system_added", "severity": "high", "summary": "Unregistered AI radiology vendor endpoint receiving DICOM studies.", "ref": "https://ai-triage-vendor.example/ingest", "ack": false},
    {"kind": "system_changed", "severity": "high", "summary": "EMR read replica opened to the research VPC.", "ref": "postgres://emr-replica.sanjeevani.internal", "ack": false},
    {"kind": "connection_lost", "severity": "medium", "summary": "LIS connector lost credentials after password rotation.", "ref": "lis.sanjeevani.internal", "ack": false}
  ],
  "classifications": [
    {"sys": 1, "path": "emr.diagnoses.icd_code", "level": "critical_pii", "cats": ["health-records"], "conf": 96.0, "decision": "confirmed", "why": "Diagnosis linked to patient id."},
    {"sys": 2, "path": "dicom/*/PatientName", "level": "critical_pii", "cats": ["diagnostic-images"], "conf": 93.0, "decision": "confirmed", "why": "DICOM header contains patient names."},
    {"sys": 3, "path": "consults.child_profile", "level": "restricted", "cats": ["children-data"], "conf": 77.0, "decision": "adjusted", "adjusted": "critical_pii", "why": "Children's health data is highest sensitivity."},
    {"sys": 4, "path": "lis.results.genomic_panel", "level": "restricted", "cats": ["genetic-data"], "conf": 69.0, "decision": "adjusted", "adjusted": "critical_pii", "why": "Genetic data."},
    {"sys": 5, "path": "claims.policy_number", "level": "confidential", "cats": ["insurance-policy"], "conf": 84.0, "decision": "confirmed", "why": "Policy number linked to treatment."}
  ],
  "ropa": [
    {"sourceNote": "Medical records committee.", "system": "HIS / EMR (PostgreSQL)", "purpose": "Treatment and continuity of care", "legalBasis": "Legitimate use (medical treatment)", "retentionMonths": 120, "dataCategories": ["Health records", "ABHA id", "Contact details"], "processors": ["Cloud provider (Mumbai)"], "region": "ap-south-1", "crossBorder": false, "securityMeasures": "Role-based access, audit logging, encryption at rest.", "dataPrincipals": ["Patients", "Guardians of minors"], "recipients": ["TPAs", "Referring doctors"], "destinationCountries": [], "transferSafeguards": null, "dpiaRequired": true},
    {"sourceNote": "Radiology department.", "system": "PACS Imaging Archive", "purpose": "Diagnostic imaging", "legalBasis": "Legitimate use (medical treatment)", "retentionMonths": 84, "dataCategories": ["Diagnostic images", "Health records"], "processors": ["AI triage vendor (pilot)"], "region": "ap-south-1", "crossBorder": true, "securityMeasures": "Bucket policy fixed after incident; logging enabled.", "dataPrincipals": ["Patients"], "recipients": ["Radiologists"], "destinationCountries": ["Singapore"], "transferSafeguards": "Vendor contract pending review.", "dpiaRequired": true}
  ],
  "tasks": [
    {"taskName": "Breach tabletop with clinical leads", "source": "DPO", "durationMinutes": 120, "repetitions": 1, "notes": "Rehearse 72-hour DPB intimation."},
    {"taskName": "Parental consent UX review", "source": "Telemedicine product", "durationMinutes": 60, "repetitions": 2, "notes": "Validate guardian verification flow."}
  ],
  "policies": [
    {"title": "Breach response policy — clinical systems", "category": "breach_response", "content": "1. Any suspected exposure of patient data is reported to the DPO within 1 hour.\n2. The DPO intimates the Data Protection Board within 72 hours.\n3. Affected patients are informed in English and Hindi."},
    {"title": "Children's data handling standard", "category": "data_protection", "content": "Processing of a child's personal data requires verifiable consent of a parent or lawful guardian. No tracking or behavioural monitoring of children."}
  ]
}
$json$::jsonb);

select pg_temp.seed_company('fd5e0003-0000-4000-8000-000000000003', $json$
{
  "key": "nimbus", "sector": "saas", "name": "Nimbus Stack Technologies Pvt Ltd", "domain": "nimbus-stack.example",
  "estate_name": "Nimbus HR and payroll platform",
  "estate_desc": "Multi-tenant B2B HR, attendance and payroll SaaS serving 1,200 Indian employers.",
  "title": "DPDPA processor assurance — Nimbus platform", "status": "verifying", "exposure": 420000000,
  "prev_title": "SOC 2 to DPDPA mapping baseline", "prev_exposure": 1100000000,
  "base_score": 88, "improvement": 17,
  "domain_scores": {"XBR": 58, "DPIA": 70, "CHD": 96, "SEC": 92, "GOV": 90, "CNS": 86, "AUD": 93, "SDF": 90},
  "rationale": {"XBR": "Product analytics and the data warehouse replicate employee data to a US region.",
                "DPIA": "DPIA not refreshed for the new AI payslip assistant."},
  "systems": [
    {"name": "Tenant App DB (Aurora PostgreSQL)", "kind": "database", "ref": "postgres://aurora-prod.nimbus.internal/app", "desc": "Employee master, attendance, payroll.", "cats": ["employee-records", "salary-bank-details", "contact-details"]},
    {"name": "Payroll Exports", "kind": "storage", "ref": "s3://nimbus-payroll-exports-ap-south-1", "desc": "Bank transfer files and payslips.", "cats": ["salary-bank-details"]},
    {"name": "Product Analytics", "kind": "saas", "ref": "https://analytics.vendor.example/project/nimbus", "desc": "In-app event analytics (US region).", "cats": ["usage-telemetry", "device-identifiers"]},
    {"name": "Data Warehouse", "kind": "database", "ref": "bigquery://nimbus-dw/us-central1", "desc": "Reporting warehouse — replicated to US.", "cats": ["employee-records", "usage-telemetry"]},
    {"name": "Support Desk", "kind": "saas", "ref": "https://nimbus.support.example", "desc": "Customer support tickets.", "cats": ["support-tickets", "contact-details"]},
    {"name": "Customer Identity (Auth0)", "kind": "identity", "ref": "https://nimbus.auth.example", "desc": "Employer and employee login.", "cats": ["contact-details"]},
    {"name": "Email Delivery", "kind": "saas", "ref": "https://email-delivery.example", "desc": "Payslip and notification emails.", "cats": ["contact-details"]}
  ],
  "evidence": [
    {"file": "soc2-type2-report-2026.pdf", "mime": "application/pdf", "type": "report", "desc": "SOC 2 Type II report.", "controls": ["DPDPA-SEC-001", "DPDPA-SEC-003", "DPDPA-AUD-001"]},
    {"file": "dpa-template-v3.pdf", "mime": "application/pdf", "type": "document", "desc": "Customer DPA template.", "controls": ["DPDPA-GOV-003"]},
    {"file": "subprocessor-register.csv", "mime": "text/csv", "type": "inventory", "desc": "Sub-processor register with regions.", "controls": ["DPDPA-RCD-003", "DPDPA-XBR-002"]},
    {"file": "auth0-mfa-config.json", "mime": "application/json", "type": "config", "desc": "Customer MFA enforcement.", "controls": ["DPDPA-SEC-002"]},
    {"file": "pentest-2026-h1.pdf", "mime": "application/pdf", "type": "report", "desc": "Annual penetration test.", "controls": ["DPDPA-SEC-004"]},
    {"file": "retention-job-logs.json", "mime": "application/json", "type": "log", "desc": "Nightly retention job output.", "controls": ["DPDPA-RTN-001", "DPDPA-RTN-002"]},
    {"file": "privacy-training-completion.csv", "mime": "text/csv", "type": "log", "desc": "Staff privacy training completion (98%).", "controls": ["DPDPA-GOV-005"]}
  ],
  "plans": {
    "done": {"title": "Payroll export hardening", "desc": "Encrypt and expire payroll exports.",
      "actions": [
        {"type": "config.backup_encrypt", "desc": "Enforce KMS encryption on payroll exports bucket", "risk": "low", "score": 12, "blast": {"buckets": 1, "target": "Payroll Exports"}},
        {"type": "data.retention_purge", "desc": "Expire payroll export files after 90 days", "risk": "medium", "score": 32, "blast": {"rows": 48210, "target": "Payroll Exports"}},
        {"type": "notice.update", "desc": "Update employee privacy notice with export retention", "risk": "low", "score": 6}
      ]},
    "live": {"title": "Localise analytics and warehouse data", "desc": "Close the cross-border gap for employee data.",
      "actions": [
        {"type": "data.mask", "desc": "Pseudonymise employee ids before events leave India", "risk": "medium", "score": 36, "blast": {"rows": 152400, "target": "Product Analytics"}, "params": {"fields": ["employee_id", "email"]}},
        {"type": "config.rbac_update", "desc": "Restrict US warehouse datasets to aggregated views only", "risk": "medium", "score": 28, "blast": {"datasets": 6, "target": "Data Warehouse"}},
        {"type": "dpa.execute", "desc": "Execute transfer addendum with analytics vendor", "risk": "low", "score": 8}
      ]},
    "failed": {"title": "Support desk attachment clean-up", "desc": "Remove payslip attachments from old tickets.",
      "actions": [
        {"type": "data.mask", "desc": "Redact bank account numbers in ticket bodies", "risk": "low", "score": 18, "blast": {"rows": 2200}},
        {"type": "data.delete", "desc": "Delete payslip attachments older than 12 months", "risk": "high", "score": 55, "blast": {"rows": 9100, "target": "Support Desk"}, "rollback": {"strategy": "vendor_trash_restore"}}
      ]},
    "draft": {"title": "DPIA refresh — AI payslip assistant", "desc": "Refresh the DPIA before general availability.",
      "actions": [
        {"type": "review.accept_risk", "desc": "Record DPIA residual-risk decision", "risk": "medium", "score": 30}
      ]}
  },
  "dsars": [
    {"kind": "access", "status": "completed", "name": "Neha Kapoor", "age": 20, "method": "employer_sso", "notes": "Routed via employer (controller); fulfilled as processor."},
    {"kind": "erasure", "status": "completed", "name": "Rahul Verma", "age": 45, "method": "employer_sso", "notes": "Ex-employee erasure after statutory payroll retention."},
    {"kind": "portability", "status": "in_fulfilment", "name": "Sneha Kulkarni", "age": 6, "method": "employer_sso", "notes": "Attendance history export."},
    {"kind": "correction", "status": "received", "name": "Imran Ali", "age": 2, "notes": "Bank IFSC correction."}
  ],
  "breaches": [
    {"title": "Over-shared support export link", "desc": "A support agent shared a time-limited export link in a public community thread for 40 minutes.", "severity": "low", "status": "closed", "age_hours": 2200, "affected": 37, "cats": ["employee-records", "contact-details"], "post_mortem": "Export links now require login and expire in 15 minutes.", "lessons": "Disable public sharing for support exports."}
  ],
  "purposes": [
    {"key": "payroll_processing", "name": "Payroll processing", "name_hi": "वेतन प्रक्रिया", "desc": "Process salaries for the employer.", "basis": "legitimate_uses", "notice": "Your employer uses Nimbus to process your salary and statutory deductions.", "records": 12, "withdraw_every": 100},
    {"key": "product_analytics", "name": "Product analytics", "desc": "Improve the product.", "basis": "consent", "notice": "With your consent we collect usage analytics to improve Nimbus.", "records": 20, "withdraw_every": 5},
    {"key": "ai_payslip_assistant", "name": "AI payslip assistant", "desc": "Answer questions about your payslip.", "basis": "consent", "notice": "The assistant reads your payslip to answer your questions. Data stays in India.", "records": 9, "withdraw_every": 4}
  ],
  "drift": [
    {"kind": "system_changed", "severity": "medium", "summary": "Warehouse replication job added a new employee table to the US dataset.", "ref": "bigquery://nimbus-dw/us-central1/hr_events", "ack": false},
    {"kind": "control_drift", "severity": "low", "summary": "One engineer exempted from MFA for 24h.", "ref": "auth0/rules/mfa", "ack": true}
  ],
  "classifications": [
    {"sys": 1, "path": "app.employees.bank_account", "level": "critical_pii", "cats": ["salary-bank-details"], "conf": 98.0, "decision": "confirmed", "why": "Bank account numbers."},
    {"sys": 3, "path": "events.properties.email", "level": "restricted", "cats": ["contact-details"], "conf": 88.0, "decision": "confirmed", "why": "Emails leaking into analytics events."},
    {"sys": 4, "path": "hr_events.salary_band", "level": "confidential", "cats": ["employee-records"], "conf": 70.0, "decision": "adjusted", "adjusted": "restricted", "why": "Salary band plus team is identifying."},
    {"sys": 5, "path": "tickets.attachments", "level": "internal", "cats": ["support-tickets"], "conf": 52.0, "decision": "overridden", "adjusted": "restricted", "why": "Attachments frequently include payslips."}
  ],
  "ropa": [
    {"sourceNote": "Platform architecture review.", "system": "Tenant App DB (Aurora PostgreSQL)", "purpose": "Payroll and attendance processing on behalf of employers", "legalBasis": "Contract (processor)", "retentionMonths": 96, "dataCategories": ["Employee records", "Salary and bank details"], "processors": ["Cloud provider (Mumbai)", "Email delivery"], "region": "ap-south-1", "crossBorder": false, "securityMeasures": "SOC 2 controls, encryption, tenant isolation.", "dataPrincipals": ["Employees of customers"], "recipients": ["Employers", "Banks"], "destinationCountries": [], "transferSafeguards": null, "dpiaRequired": false},
    {"sourceNote": "Data platform team.", "system": "Data Warehouse", "purpose": "Product analytics and reporting", "legalBasis": "Consent", "retentionMonths": 24, "dataCategories": ["Usage telemetry", "Employee records"], "processors": ["Analytics vendor"], "region": "us-central1", "crossBorder": true, "securityMeasures": "Pseudonymisation planned; access restricted.", "dataPrincipals": ["Employees of customers"], "recipients": [], "destinationCountries": ["United States"], "transferSafeguards": "Transfer addendum in negotiation.", "dpiaRequired": true}
  ],
  "tasks": [
    {"taskName": "Sub-processor register review", "source": "Vendor management", "durationMinutes": 45, "repetitions": 4, "notes": "Quarterly region check."}
  ],
  "policies": [
    {"title": "Customer DPA template v4", "category": "dpa_template", "content": "Nimbus processes personal data only on documented instructions of the Customer. Sub-processors are listed in Annex 2. Data is hosted in India unless the Customer agrees otherwise."},
    {"title": "Vendor and cross-border transfer standard", "category": "vendor_management", "content": "No employee personal data leaves India without pseudonymisation and a signed transfer addendum."}
  ]
}
$json$::jsonb);

-- ── Every run: keep the approval journey demonstrable ───────────────
-- (Moved below the re-arm block: every action still awaiting approval gets a
-- fresh recorded dry run there.)

-- If a live approval consumed the approvable plan, add a fresh one.
do $$
declare
  t record; n int; pid uuid; eng uuid; lib text; aid uuid;
begin
  for t in select id, slug from public.tenants where slug like 'demo-%' and is_demo loop
    perform 1 from public.remediation_plans p
      where p.tenant_id = t.id and p.status in ('draft','review')
        and exists (select 1 from public.remediation_actions a where a.plan_id = p.id
                     and a.approval_status = 'awaiting_approval');
    if found then continue; end if;
    select id, library_version into eng, lib from public.engagements
      where tenant_id = t.id order by started_at desc limit 1;
    if eng is null then continue; end if;
    select count(*) into n from public.remediation_plans where tenant_id = t.id;
    pid := gen_random_uuid();
    insert into public.remediation_plans (id, tenant_id, engagement_id, library_version, title, description, status)
    values (pid, t.id, eng, lib, 'Demo approval round ' || n, 'Re-created by the demo seed so the approval journey can be shown again.', 'review');
    aid := gen_random_uuid();
    insert into public.remediation_actions (id, tenant_id, plan_id, sequence, action_type, parameters, description,
      risk_class, risk_score, blast_radius, rollback_definition, rollback_validated, rollback_validated_at,
      approval_status)
    values (aid, t.id, pid, 1, 'data.mask', '{"columns": ["email"]}',
      'Mask customer email addresses in the analytics replica', 'low', 15,
      '{"recordsAffected": 12000, "systemsAffected": ["analytics replica"], "environment": "production"}',
      '{"strategy": "drop_masking_policy", "estimatedRollbackTimeSeconds": 60}', true, now(),
      'awaiting_approval');
    raise notice 'added approvable plan % for %', pid, t.slug;
  end loop;
end $$;

-- BR-2 (0157): approval needs a RECORDED dry run, never just the action's
-- status field. Every demo action awaiting approval whose recorded run is
-- missing, unsuccessful or due to expire within the hour is re-simulated
-- through record_dry_run — the only write path — with its fixed 24-hour
-- window. Re-run the seed to refresh the window before an approval demo.
do $$
declare
  a record; r jsonb;
begin
  for a in
    select ra.* from public.remediation_actions ra
      join public.tenants t on t.id = ra.tenant_id and t.slug like 'demo-%' and t.is_demo
      left join public.dry_runs d on d.tenant_id = ra.tenant_id and d.id = ra.latest_dry_run_id
     where ra.approval_status = 'awaiting_approval' and ra.rollback_validated
       and ra.execution_status = 'draft'
       and (d.id is null or d.status <> 'succeeded' or d.expires_at <= now() + interval '1 hour'
            -- 0157's own rule: e.g. runs seeded before 2026-10-18 carry placeholder
            -- hashes, so they no longer answer for the stored content.
            or cardinality(array_remove(public.action_approval_blockers(ra.tenant_id, ra.id),
                                        'rollback_not_validated')) > 0)
  loop
    r := public.record_dry_run(a.tenant_id, a.id, 'succeeded',
      jsonb_build_object('summary', a.description, 'changes', case
        when a.action_type::text = 'data.mask' then (
          select coalesce(jsonb_agg(jsonb_build_object('field', col, 'before', 'cleartext',
                                                       'after', 'masked (last 4 visible)', 'role', 'masked')),
                          '[{"field": "pii_columns", "before": "cleartext", "after": "masked"}]'::jsonb)
            from jsonb_array_elements_text(coalesce(a.parameters->'columns', a.parameters->'fields', '[]'::jsonb)) col)
        when a.action_type::text in ('data.retention_purge', 'data.delete') then jsonb_build_array(
          jsonb_build_object('field', 'rows in scope', 'before',
                             coalesce((a.blast_radius->>'recordsAffected')::int, 0), 'after', 0, 'role', 'removed'))
        else jsonb_build_array(jsonb_build_object('field', a.action_type::text,
                                                  'before', 'current version', 'after', 'remediated version'))
        end),
      null, 'sudhaar', a.parameters, a.rollback_definition, gen_random_uuid());
    if r ? 'error' then
      raise exception 'demo dry run not recorded for %: %', a.id, r ->> 'error';
    end if;
  end loop;
end $$;

-- Summary
select t.name,
       (select posture_score from public.engagements e where e.tenant_id = t.id order by started_at desc limit 1) as posture,
       (select count(*) from public.findings f where f.tenant_id = t.id) as findings,
       (select count(*) from public.remediation_plans p where p.tenant_id = t.id) as plans,
       (select count(*) from public.remediation_actions a where a.tenant_id = t.id and a.approval_status = 'awaiting_approval') as awaiting_approval,
       (select count(*) from public.dsars d where d.tenant_id = t.id) as dsars,
       (select count(*) from public.consent_records r where r.tenant_id = t.id) as consents,
       (select count(*) from public.audit_ledger l where l.tenant_id = t.id) as ledger,
       (select count(*) from public.tenant_users m where m.tenant_id = t.id) as members
  from public.tenants t where t.slug like 'demo-%' order by t.slug;

commit;
