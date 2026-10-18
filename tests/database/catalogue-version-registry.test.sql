-- 0159: the public-control review gate reads its approved catalogue contract
-- from public.approved_catalogue_versions instead of literals. The 0.1.1 row
-- holds exactly the former literals (public-control-review-set.test.sql proves
-- the 0.1.1 path is unchanged); the registry is immutable and private.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;
create function pg_temp.refused(q text) returns void language plpgsql as $$
begin begin execute q; exception when others then return; end; raise exception 'ASSERTION: not refused: %',q; end$$;

select pg_temp.ok((select count(*) from public.approved_catalogue_versions)=1,'exactly one approved version');
select pg_temp.ok((select row(rows_hash,questionnaire_digest,catalogue_manifest_sha256,mapping_version,published_by,published_at,control_count)
  from public.approved_catalogue_versions where library_version='0.1.1')
  = row('ddf7b3202e731871a78012ddeffa7b8ebde4c2f4b8b3dbbfa7fd95e1c6a7a011'::text,
        '1fcd03e3c5e1cbec9bf09f86a0f26d05ec117d4d4acb3a8a448195e5ee897b0e'::text,
        '3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6'::text,
        'public-evidence-1'::text,'Axiom Minds · Founder'::text,'2026-09-20'::timestamptz,46),'0.1.1 row holds the former literals');
select pg_temp.ok((select change_log like '0.1.1 — CITATION CORRECTION (PATCH; assessments remain comparable).%'
  and change_log like '%land in 0.2.0 as a MINOR.' and position('children''s-data' in change_log)>0
  from public.approved_catalogue_versions where library_version='0.1.1'),'change log copied verbatim');
select pg_temp.ok(not exists(select 1 from public.approved_catalogue_versions where library_version='0.2.0'),'0.2.0 is not approved');

-- The gate and the validator no longer pin the contract.
select pg_temp.ok(position('ddf7b320' in pg_get_functiondef('controller_security.public_control_review_context(uuid,uuid,uuid,uuid,boolean)'::regprocedure))=0
  and position('3bdf816d' in pg_get_functiondef('controller_security.public_control_review_context(uuid,uuid,uuid,uuid,boolean)'::regprocedure))=0
  and position('approved_catalogue_versions' in pg_get_functiondef('controller_security.public_control_review_context(uuid,uuid,uuid,uuid,boolean)'::regprocedure))>0,
  'review context reads the registry');
select pg_temp.ok(position('''0.1.1''' in pg_get_functiondef('controller_security.public_control_review_request_valid(jsonb,jsonb)'::regprocedure))=0
  and position('public-evidence-1' in pg_get_functiondef('controller_security.public_control_review_request_valid(jsonb,jsonb)'::regprocedure))=0,
  'request validator takes the version from the trusted context');

-- Immutable, and private to the security-definer gate.
select pg_temp.refused($q$update public.approved_catalogue_versions set control_count=47$q$);
select pg_temp.refused($q$delete from public.approved_catalogue_versions$q$);
select pg_temp.refused($q$truncate public.approved_catalogue_versions$q$);
select pg_temp.ok(not has_table_privilege(r,'public.approved_catalogue_versions',p),'no '||p||' for '||r)
  from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer']) r,
       unnest(array['select','insert','update','delete']) p;
select pg_temp.ok(not has_function_privilege(r,'controller_security.public_control_review_context(uuid,uuid,uuid,uuid,boolean)','execute'),'no gate execute for '||r)
  from unnest(array['anon','authenticated','service_role','human_action_writer']) r;
rollback;
