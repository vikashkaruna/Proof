-- Included after the settled public-source fixture by the paired shell runner.
create temporary table operator_source_fixture(k text primary key,v jsonb);
grant select,insert on operator_source_fixture to human_action_writer;
insert into operator_source_fixture values('payload',jsonb_build_object(
 'engagementId',pg_temp.id(31),'sourceNote','Retained public HTML structure only; private processing facts unknown',
 'system','Public contact form','purpose',null,'legalBasis',null,'retentionMonths',null,
 'dataCategories',null,'processors',null,'region',null,'crossBorder',null,'securityMeasures',null,
 'dataPrincipals',null,'recipients',null,'destinationCountries',null,'transferSafeguards',null,'dpiaRequired',null,
 'source',jsonb_build_object('observationId',pg_temp.observation(),'outputSha256',
  (select output_sha256 from public.public_source_observations where id=pg_temp.observation()))));
insert into operator_source_fixture values('ledger_before',(select to_jsonb(count(*)) from public.audit_ledger where tenant_id=pg_temp.id(11)));
create function pg_temp.workflow(payload jsonb,op integer,t integer default 11) returns jsonb language sql as $$
 select public.record_operator_workflow(pg_temp.id(t),pg_temp.id(1),pg_temp.id(op),'ropa',payload,gen_random_uuid())
$$;
set local role human_action_writer;
insert into operator_source_fixture values('record',pg_temp.workflow((select v from operator_source_fixture where k='payload'),700));
select pg_temp.ok((select v->'data'->'payload'=(select v from operator_source_fixture where k='payload') from operator_source_fixture where k='record'),
 'valid settled observation bound with all private facts unknown');
select pg_temp.ok(pg_temp.workflow((select v from operator_source_fixture where k='payload'),700)->>'replayed'='true','bound exact replay once');
select pg_temp.ok(pg_temp.workflow((select v from operator_source_fixture where k='payload')||jsonb_build_object('source',
 jsonb_build_object('observationId',pg_temp.observation(),'outputSha256',repeat('f',64))),701)->>'error'='digest_mismatch','stale output commitment refused');
select pg_temp.ok(pg_temp.workflow((select v from operator_source_fixture where k='payload')||jsonb_build_object('engagementId',pg_temp.id(32)),702)->>'error'='context_refused','foreign engagement refused');
select pg_temp.ok(pg_temp.workflow((select v from operator_source_fixture where k='payload')||jsonb_build_object('engagementId',pg_temp.id(32)),703,12)->>'error'='source_refused','same actor foreign tenant cannot reuse source observation');
select pg_temp.ok(pg_temp.workflow((select v from operator_source_fixture where k='payload')||jsonb_build_object('engagementId',null),704)->>'error'='invalid_record','source cannot be detached from engagement');
select pg_temp.ok(public.read_operator_workflow(pg_temp.id(11),pg_temp.id(3),(select (v->'data'->>'id')::uuid from operator_source_fixture where k='record'))->'data'->'payload'=
 (select v from operator_source_fixture where k='payload'),'reader loads exact source binding and unknowns');
reset role;
select pg_temp.ok((select count(*)=1 from public.operator_workflow_records where tenant_id=pg_temp.id(11)), 'only one human source-bound record');
select pg_temp.ok((select count(*)=(select (v#>>'{}')::bigint+1 from operator_source_fixture where k='ledger_before')
 from public.audit_ledger where tenant_id=pg_temp.id(11)),'one additional human receipt without stale-source or replay events');
select pg_temp.ok((select v=(select jsonb_agg(to_jsonb(o) order by id) from public.public_source_observations o where tenant_id=pg_temp.id(11))
 from source_fixture where k='original_sources'),'source outputs and private unknowns unchanged');
select pg_temp.ok(not exists(select 1 from public.verify_ledger(pg_temp.id(11),1)),'source and workflow ledger chain validates');
-- A trusted test seam changes only the dependency result, never immutable
-- source rows. The wrapper must not accept missing closed receipt evidence.
do $$declare definition text;r jsonb;begin
 select pg_get_functiondef('public.public_source_review_source(uuid,uuid,uuid,uuid,boolean)'::regprocedure) into definition;
 execute $fn$create or replace function public.public_source_review_source(p_tenant_id uuid,p_engagement_id uuid,p_binding_id uuid,p_observation_id uuid,p_lock boolean)
 returns jsonb language sql security definer set search_path='' as $body$select jsonb_build_object('error','source_refused')$body$ $fn$;
 set local role human_action_writer;
 r:=pg_temp.workflow((select v from operator_source_fixture where k='payload'),705);
 reset role;
 perform pg_temp.ok(r->>'error'='source_refused','closed receipt chain required for new record');
 execute definition;
end $$;
update public.engagements set status='cancelled' where id=pg_temp.id(31);
set local role human_action_writer;
select pg_temp.ok(pg_temp.workflow((select v from operator_source_fixture where k='payload'),700)->>'error'='context_refused','cancelled source context denies replay');
select pg_temp.ok(public.read_operator_workflow(pg_temp.id(11),pg_temp.id(3),(select (v->'data'->>'id')::uuid from operator_source_fixture where k='record'))->>'error'='context_refused','cancelled source context denies read');
reset role;
rollback;
