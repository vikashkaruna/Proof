-- 0160: no public-control function pins catalogue 0.1.1 any more; versions come
-- from the recorded review request and are checked against the registry. The
-- existing review, assessment-source, dispatch and report suites prove 0.1.1
-- behaviour is unchanged.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m;end if;end$$;

select pg_temp.ok(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','controller_security') and p.prosrc like '%''0.1.1''%'),
  'no function compares with or emits the literal 0.1.1: '||coalesce((select string_agg(p.proname,',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','controller_security') and p.prosrc like '%''0.1.1''%'),''));

select pg_temp.ok(controller_security.catalogue_approved('0.1.1',null),'0.1.1 approved');
select pg_temp.ok(controller_security.catalogue_approved('0.1.1','public-evidence-1'),'0.1.1 with its mapping approved');
select pg_temp.ok(not controller_security.catalogue_approved('0.1.1','public-evidence-2'),'wrong mapping refused');
select pg_temp.ok(not controller_security.catalogue_approved('0.1.1',''),'empty mapping refused');
select pg_temp.ok(not controller_security.catalogue_approved('0.2.0',null),'0.2.0 not approved');
select pg_temp.ok(not controller_security.catalogue_approved(null,null),'null refused');
select pg_temp.ok(not has_function_privilege(r,'controller_security.catalogue_approved(text,text)','execute'),'no execute for '||r)
  from unnest(array['anon','authenticated','service_role','human_action_writer','agent_ledger_writer']) r;
select pg_temp.ok(provolatile='s','STABLE: '||proname) from pg_proc
  where oid in ('controller_security.coverage144_original(text,text)'::regprocedure,'controller_security.public_control_review_request_shape(jsonb)'::regprocedure);
-- request_shape still refuses a JSON-null mapping version.
select pg_temp.ok(not controller_security.public_control_review_request_shape(jsonb_build_object(
  'version',1,'operationKey','11111111-1111-4111-8111-111111111111','engagementId','11111111-1111-4111-8111-111111111112',
  'checkId','11111111-1111-4111-8111-111111111113','expectedEstateId',null,'expectedPreviousReviewId',null,
  'expectedSource',jsonb_build_object('payloadSha256',repeat('a',64),'catalogueManifestSha256',repeat('b',64),'mappingVersion',null,'libraryVersion','0.1.1','questionnaireDigest',repeat('c',64)),
  'answers','{}'::jsonb,'applicability',jsonb_build_object('sdfSelfAttested',null,'processesChildren',null,'processesHealth',null,'rationale','r'))),
  'null mapping version refused');
rollback;
