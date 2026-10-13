-- Real PostgreSQL proof. Synthetic fixture and fault hooks roll back together.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m;end if;end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin begin execute statement;exception when insufficient_privilege then return;end;raise exception 'Privilege was not denied';end $$;

insert into auth.users(id,email) values('00000000-0000-4000-8000-000000001221','fire@test.invalid');
insert into public.users(id,email) values('00000000-0000-4000-8000-000000001221','fire@test.invalid');
insert into public.tenants(id,slug,name) values('00000000-0000-4000-8000-000000001222','durable-fire','Durable Fire'),
 ('00000000-0000-4000-8000-000000001229','durable-fire-other','Other Fire');
insert into public.estates(id,tenant_id,slug,name) values('00000000-0000-4000-8000-000000001223',
 '00000000-0000-4000-8000-000000001222','fire-estate','Fire Estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000001224','00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001223','Baseline','other'),
 ('00000000-0000-4000-8000-000000001225','00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001223','Added One','other'),
 ('00000000-0000-4000-8000-000000001226','00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001223','Added Two','other');
insert into public.tenant_onboarding_wizards(id,tenant_id,estate_id,status,completed_steps,started_by,completed_by,completed_at,readiness)
 values('00000000-0000-4000-8000-000000001227','00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001223',
 'completed',array['company','estate','inventory','connectors','grants','readiness'],'00000000-0000-4000-8000-000000001221',
 '00000000-0000-4000-8000-000000001221',now()-interval '2 days','{}');
insert into public.onboarding_attested_systems values('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001227',
 '00000000-0000-4000-8000-000000001224',1,'{}',true,false);
insert into public.monitoring_schedules(id,tenant_id,estate_id,name,kind,cadence,created_by,next_run_at)
 values('00000000-0000-4000-8000-000000001228','00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001223',
 'Durable Drift','drift_check','*/15 * * * *','00000000-0000-4000-8000-000000001221','2026-01-01T00:00:00Z');
create function pg_temp.fire(due_at timestamptz,cadence text default '*/15 * * * *') returns jsonb language sql as $$
 select public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
 '00000000-0000-4000-8000-000000001223','drift_check',cadence,due_at,gen_random_uuid());$$;

-- UTC calculator mirrors existing Python semantics, not raw '*' detection.
select pg_temp.ok(controller_security.monitoring_cron_next('0 0 1-31 * 1','2026-01-06T09:00:00Z')='2026-01-12T00:00:00Z','full DOM set is unrestricted');
select pg_temp.ok(controller_security.monitoring_cron_next('0 0 */1 * 1','2026-01-06T09:00:00Z')='2026-01-12T00:00:00Z','step-expanded full DOM set is unrestricted');
select pg_temp.ok(controller_security.monitoring_cron_next('0 0 13 * 1','2026-01-06T09:00:00Z')='2026-01-12T00:00:00Z','restricted DOM/DOW use OR');
select pg_temp.ok(controller_security.monitoring_cron_next('0 0 29 2 *','2026-03-01T09:00:00Z')='2028-02-29T00:00:00Z','leap occurrence fits two-year horizon');
select pg_temp.ok(controller_security.monitoring_cron_next('0 0 31 2 *',now()) is null,'impossible date has no occurrence');
select pg_temp.ok(controller_security.monitoring_cron_next('*/999999999999999999999 * * * *','2026-01-06T09:01:30Z')='2026-01-06T10:00:00Z','large Python-compatible step selects first value only');
select pg_temp.ok(controller_security.monitoring_cron_next('*/1000 * * * *','2026-01-06T09:01:30Z')='2026-01-06T10:00:00Z','four digit step remains supported');
select pg_temp.ok(controller_security.monitoring_cron_next('00000 00000 * * *','2026-01-06T09:01:30Z')='2026-01-07T00:00:00Z','leading-zero numeric fields remain supported');
select pg_temp.ok(controller_security.monitoring_cron_next('0 0 13 * 0-6','2026-01-06T09:01:30Z')='2026-01-13T00:00:00Z','full DOW set is unrestricted');
select pg_temp.ok(controller_security.monitoring_cron_next('*/0 * * * *',now()) is null,'zero step invalid');
select pg_temp.ok(controller_security.monitoring_cron_next(repeat('9',101),now()) is null,'oversized parser input bounded');

do $$
declare r jsonb;q jsonb;events bigint;entries bigint;due_at timestamptz:='2026-01-01T00:00:00Z';
begin
 r:=pg_temp.fire(due_at);
 perform pg_temp.ok(r->>'observationOutcome'='drift_detected' and r->>'recordingOutcome'='recorded'
  and r->'failureCode'='null'::jsonb and (r->>'detectedCount')::integer=2 and (r->>'recordedCount')::integer=2
  and (r->>'failedCount')::integer=0 and jsonb_array_length(r->'eventReceipts')=2 and r->'replayed'='false'::jsonb,'real frozen-baseline drift recorded once');
 perform pg_temp.ok((select count(*)=2 from public.drift_events where tenant_id='00000000-0000-4000-8000-000000001222'),'two actual events');
 perform pg_temp.ok((select count(*)=3 from public.audit_ledger where correlation_id=(r->>'correlationId')::uuid),'two event receipts plus one final receipt');
 perform pg_temp.ok((select next_run_at=(r->>'nextRunAt')::timestamptz and last_run_at=(r->>'calculationAfter')::timestamptz
  from public.monitoring_schedules where id='00000000-0000-4000-8000-000000001228'),'schedule advancement bound to actual retained computation');
 select count(*) into events from public.drift_events;select count(*) into entries from public.audit_ledger;
 q:=pg_temp.fire(due_at);
 perform pg_temp.ok(q=r||jsonb_build_object('replayed',true),'same slot replay returns original IDs/correlation/receipts');
 q:=public.read_monitoring_schedule_fire('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
  '00000000-0000-4000-8000-000000001223','drift_check','*/15 * * * *',due_at);
 perform pg_temp.ok(q=r||jsonb_build_object('replayed',true),'lost-response readback returns exact original proof');
 perform pg_temp.ok((select count(*)=events from public.drift_events) and (select count(*)=entries from public.audit_ledger),'replay/readback creates no event or receipt');
 perform pg_temp.ok(public.read_monitoring_schedule_fire('00000000-0000-4000-8000-000000001229','00000000-0000-4000-8000-000000001228',
  '00000000-0000-4000-8000-000000001223','drift_check','*/15 * * * *',due_at)='{"missing":true}'::jsonb,'tenant isolation for readback');
 perform pg_temp.ok(public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001229','00000000-0000-4000-8000-000000001228',
  '00000000-0000-4000-8000-000000001223','drift_check','*/15 * * * *',due_at,gen_random_uuid())->>'error'='schedule_not_found','tenant isolation for firing');
 perform pg_temp.ok(pg_temp.fire(due_at,'0 0 * * *')->>'error'='fire_context_refused','retained slot rejects changed configuration');
end $$;

-- Current configuration/estate/kind/status fence prevents ALL writes.
update public.monitoring_schedules set next_run_at='2026-01-02T00:00:00Z',cadence='0 0 * * *'
 where id='00000000-0000-4000-8000-000000001228';
do $$
declare n bigint;
begin
 select count(*) into n from public.audit_ledger;
 perform pg_temp.ok(pg_temp.fire('2026-01-02')->>'error'='schedule_snapshot_changed','stale cadence rejected');
 perform pg_temp.ok(pg_temp.fire('2026-01-03','0 0 * * *')->>'error'='schedule_snapshot_changed','stale due rejected');
 perform pg_temp.ok(public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
  '00000000-0000-4000-8000-000000001224','drift_check','0 0 * * *','2026-01-02',gen_random_uuid())->>'error'='schedule_snapshot_changed','stale estate rejected');
 perform pg_temp.ok(public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
  '00000000-0000-4000-8000-000000001223','reassessment','0 0 * * *','2026-01-02',gen_random_uuid())->>'error'='schedule_snapshot_changed','stale kind rejected');
 perform pg_temp.ok((select count(*)=n from public.audit_ledger),'stale snapshots append no proof');
end $$;
update public.monitoring_schedules set status='retired' where id='00000000-0000-4000-8000-000000001228';
select pg_temp.ok(pg_temp.fire('2026-01-02','0 0 * * *')->>'error'='schedule_snapshot_changed','retirement prevents new fire');
select pg_temp.ok(pg_temp.fire('2026-01-01')->'replayed'='true'::jsonb,'retirement does not erase historic readback');
update public.monitoring_schedules set status='active',next_run_at='2026-01-03',cadence='*/0 * * * *' where id='00000000-0000-4000-8000-000000001228';
do $$
declare r jsonb;
begin
 r:=pg_temp.fire('2026-01-03','*/0 * * * *');
 perform pg_temp.ok(r->>'failureCode'='cadence_invalid' and r->>'observationOutcome'='failed' and r->>'recordingOutcome'='failed'
  and r->>'detectedCount'='0' and r->>'recordedCount'='0' and r->>'failedCount'='0'
  and (r->>'nextRunAt')::timestamptz=(r->>'calculationAfter')::timestamptz+interval '24 hours','invalid cadence earns failed receipt and bounded day backoff');
end $$;

-- Event work completes before the retained next-run calculation.
create temporary table event_completion_clock(observed_at timestamptz);
create function pg_temp.event_delay() returns trigger language plpgsql as $$
begin perform pg_sleep(0.01);insert into pg_temp.event_completion_clock values(clock_timestamp());return new;end $$;
create trigger durable_event_delay before insert on public.drift_events for each row execute function pg_temp.event_delay();
update public.monitoring_schedules set next_run_at='2026-01-03T00:01:00Z',cadence='*/15 * * * *' where id='00000000-0000-4000-8000-000000001228';
do $$
declare r jsonb;
begin
 r:=pg_temp.fire('2026-01-03T00:01:00Z');
 perform pg_temp.ok((r->>'calculationAfter')::timestamptz>=(select max(observed_at) from event_completion_clock)
  and (r->>'nextRunAt')::timestamptz>clock_timestamp(),'retained calculation follows completed event work and advances into future');
end $$;
drop trigger durable_event_delay on public.drift_events;

-- A second-event failure rolls back the first insert AND its receipt, while
-- preserving the observed two detections and a truthful failed fire receipt.
create temporary sequence event_fault_counter;
create function pg_temp.event_fault() returns trigger language plpgsql as $$
begin if nextval('pg_temp.event_fault_counter')=2 then raise exception 'synthetic event failure';end if;return new;end $$;
create trigger durable_event_fault before insert on public.drift_events for each row execute function pg_temp.event_fault();
update public.monitoring_schedules set next_run_at='2026-01-04',cadence='*/15 * * * *' where id='00000000-0000-4000-8000-000000001228';
do $$
declare r jsonb;n bigint;l bigint;
begin
 select count(*) into n from public.drift_events;select count(*) into l from public.audit_ledger;
 r:=pg_temp.fire('2026-01-04');
 perform pg_temp.ok(r->>'observationOutcome'='drift_detected' and r->>'recordingOutcome'='failed' and r->>'failureCode'='event_recording_failed'
  and r->>'detectedCount'='2' and r->>'recordedCount'='0' and r->>'failedCount'='2' and r->'eventReceipts'='[]'::jsonb,'failure preserves detections without fabricated recording proof');
 perform pg_temp.ok((select count(*)=n from public.drift_events) and (select count(*)=l+1 from public.audit_ledger),'all event writes/receipts roll back; only failed fire receipt survives');
end $$;
drop trigger durable_event_fault on public.drift_events;

-- Failure of an event audit append also rolls back every event insertion.
create temporary sequence event_audit_fault_counter;
create function pg_temp.event_audit_fault() returns trigger language plpgsql as $$
begin
 if new.action_type='monitoring.drift.detected' and nextval('pg_temp.event_audit_fault_counter')=2
 then raise exception 'synthetic event audit failure';end if;return new;
end $$;
create trigger durable_event_audit_fault before insert on public.audit_ledger for each row execute function pg_temp.event_audit_fault();
update public.monitoring_schedules set next_run_at='2026-01-04T00:01:00Z' where id='00000000-0000-4000-8000-000000001228';
do $$
declare r jsonb;n bigint;l bigint;
begin
 select count(*) into n from public.drift_events;select count(*) into l from public.audit_ledger;
 r:=pg_temp.fire('2026-01-04T00:01:00Z');
 perform pg_temp.ok(r->>'failureCode'='event_recording_failed' and r->>'detectedCount'='2'
  and r->>'recordedCount'='0' and r->>'failedCount'='2' and r->'eventReceipts'='[]'::jsonb,'event audit failure keeps only failed recording facts');
 perform pg_temp.ok((select count(*)=n from public.drift_events) and (select count(*)=l+1 from public.audit_ledger),'event audit failure rolls back all event writes and event receipts');
end $$;
drop trigger durable_event_audit_fault on public.audit_ledger;

-- Final-audit failure is never swallowed: even successfully recorded events,
-- retained fire and advancement must roll back if its final receipt fails.
create function pg_temp.final_audit_fault() returns trigger language plpgsql as $$
begin if new.action_type='monitoring.schedule.fired' then raise exception 'synthetic final audit failure';end if;return new;end $$;
create trigger durable_final_fault before insert on public.audit_ledger for each row execute function pg_temp.final_audit_fault();
update public.monitoring_schedules set next_run_at='2026-01-05' where id='00000000-0000-4000-8000-000000001228';
do $$
declare n bigint;l bigint;f bigint;refused boolean:=false;
begin
 select count(*) into n from public.drift_events;select count(*) into l from public.audit_ledger;select count(*) into f from public.monitoring_schedule_fires;
 begin perform pg_temp.fire('2026-01-05');exception when raise_exception then refused:=true;end;
 perform pg_temp.ok(refused and (select count(*)=n from public.drift_events) and (select count(*)=l from public.audit_ledger)
  and (select count(*)=f from public.monitoring_schedule_fires),'final audit failure rolls back every fire write');
 perform pg_temp.ok((select next_run_at='2026-01-05'::timestamptz from public.monitoring_schedules where id='00000000-0000-4000-8000-000000001228'),'failed final audit leaves original due slot pending');
end $$;
drop trigger durable_final_fault on public.audit_ledger;

-- Bounded deterministic timing injection: a valid calculator test double gives
-- a short future interval; a delayed final audit consumes it. Production uses
-- the unchanged cron calculator, but its final advancement guard must refuse
-- this boundary and roll back events, receipts, fire and original due together.
create temporary table original_cron_definition as select pg_get_functiondef('controller_security.monitoring_cron_next(text,timestamptz)'::regprocedure) as definition;
create or replace function controller_security.monitoring_cron_next(p_cadence text,p_after timestamptz)
 returns timestamptz language sql immutable set search_path='' as $$select p_after+interval '100 milliseconds'$$;
create function pg_temp.final_audit_delay() returns trigger language plpgsql as $$
begin if new.action_type='monitoring.schedule.fired' then perform pg_sleep(0.2);end if;return new;end $$;
create trigger durable_final_delay before insert on public.audit_ledger for each row execute function pg_temp.final_audit_delay();
update public.monitoring_schedules set next_run_at='2026-01-05T00:01:00Z' where id='00000000-0000-4000-8000-000000001228';
do $$
declare n bigint;l bigint;f bigint;refused boolean:=false;
begin
 select count(*) into n from public.drift_events;select count(*) into l from public.audit_ledger;select count(*) into f from public.monitoring_schedule_fires;
 begin perform pg_temp.fire('2026-01-05T00:01:00Z');exception when raise_exception then
  perform pg_temp.ok(sqlerrm='monitoring next run expired','timing boundary returns only bounded refusal');refused:=true;end;
 perform pg_temp.ok(refused and (select count(*)=n from public.drift_events) and (select count(*)=l from public.audit_ledger)
  and (select count(*)=f from public.monitoring_schedule_fires),'expired finalization rolls back the entire fire');
 perform pg_temp.ok((select next_run_at='2026-01-05T00:01:00Z'::timestamptz from public.monitoring_schedules
  where id='00000000-0000-4000-8000-000000001228'),'expired finalization preserves pending original slot');
end $$;
drop trigger durable_final_delay on public.audit_ledger;
do $$begin execute (select definition from original_cron_definition);end$$;

-- Malformed/throwing trusted probe test doubles exist only in this transaction.
create temporary table original_drift_definition as select pg_get_functiondef('public.onboarding_estate_drift(uuid,uuid)'::regprocedure) as definition;
create or replace function public.onboarding_estate_drift(p_tenant_id uuid,p_estate_id uuid) returns jsonb
 language sql stable security definer set search_path='' as $$select '{}'::jsonb$$;
update public.monitoring_schedules set next_run_at='2026-01-06' where id='00000000-0000-4000-8000-000000001228';
select pg_temp.ok(pg_temp.fire('2026-01-06')->>'failureCode'='probe_invalid','empty trusted probe is not a clean result');
create temporary table malformed_probe_fixture(value jsonb);
create or replace function public.onboarding_estate_drift(p_tenant_id uuid,p_estate_id uuid) returns jsonb
 language sql stable security definer set search_path='' as $$select value from pg_temp.malformed_probe_fixture$$;
do $$
declare payload jsonb;base jsonb;due_at timestamptz;pass integer:=0;r jsonb;n bigint;
begin
 base:=jsonb_build_object('status','current','baselineWizardId','00000000-0000-4000-8000-000000001227',
  'completedAt',now()-interval '2 days','added','[]'::jsonb,'removed','[]'::jsonb,'changed','[]'::jsonb,'connectionLost','[]'::jsonb);
 for payload in select value from jsonb_array_elements(jsonb_build_array(
  base||'{"baselineWizardId":"00000000-0000-0000-0000-000000000000"}'::jsonb,
  base||'{"completedAt":"infinity"}'::jsonb,
  base||'{"completedAt":"2026-99-99T25:00:00Z"}'::jsonb,
  base||'{"callerVerified":true}'::jsonb,
  base||'{"status":"drifted","added":[{"id":"00000000-0000-4000-8000-000000001225","name":"Injected","verified":true}]}'::jsonb,
  base||'{"status":"drifted","added":[{"id":"00000000-0000-0000-0000-000000000000","name":"Injected"}]}'::jsonb
 )) loop
  pass:=pass+1;due_at:='2026-02-01'::timestamptz+pass*interval '1 day';
  truncate malformed_probe_fixture;insert into malformed_probe_fixture values(payload);
  update public.monitoring_schedules set next_run_at=due_at where id='00000000-0000-4000-8000-000000001228';
  select count(*) into n from public.drift_events;
  r:=pg_temp.fire(due_at);
  perform pg_temp.ok(r->>'failureCode'='probe_invalid' and r->>'observationOutcome'='failed'
   and r->>'recordedCount'='0' and (select count(*)=n from public.drift_events),'malformed source metadata/items never earn drift or clean proof');
 end loop;
end $$;
create or replace function public.onboarding_estate_drift(p_tenant_id uuid,p_estate_id uuid) returns jsonb
 language plpgsql stable security definer set search_path='' as $$begin raise exception 'synthetic probe failure';end$$;
update public.monitoring_schedules set next_run_at='2026-01-07' where id='00000000-0000-4000-8000-000000001228';
select pg_temp.ok(pg_temp.fire('2026-01-07')->>'failureCode'='probe_failed','probe exception records honest failed observation');
do $$begin execute (select definition from original_drift_definition);end$$;

-- Live composition stays refused; the database scheduler does not invent it.
update public.monitoring_schedules set kind='rediscovery',next_run_at='2026-01-08' where id='00000000-0000-4000-8000-000000001228';
select pg_temp.ok(public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
 '00000000-0000-4000-8000-000000001223','rediscovery','*/15 * * * *','2026-01-08',gen_random_uuid())->>'failureCode'='live_executor_unwired','rediscovery remains honestly unwired');

update public.monitoring_schedules set kind='reassessment',next_run_at='2026-01-09' where id='00000000-0000-4000-8000-000000001228';
select pg_temp.ok(public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
 '00000000-0000-4000-8000-000000001223','reassessment','*/15 * * * *','2026-01-09',gen_random_uuid())->>'failureCode'='live_executor_unwired','reassessment remains honestly unwired');

-- Actual trusted probe clean/no-baseline paths have zero events and one receipt.
insert into public.onboarding_attested_systems
 select tenant_id,'00000000-0000-4000-8000-000000001227'::uuid,id,version,'{}'::text[],true,false
 from public.estate_systems where id in ('00000000-0000-4000-8000-000000001225','00000000-0000-4000-8000-000000001226');
update public.monitoring_schedules set kind='drift_check',next_run_at='2026-01-10' where id='00000000-0000-4000-8000-000000001228';
do $$
declare r jsonb;n bigint;l bigint;
begin
 select count(*) into n from public.drift_events;select count(*) into l from public.audit_ledger;
 r:=pg_temp.fire('2026-01-10');
 perform pg_temp.ok(r->>'observationOutcome'='no_drift' and r->>'recordingOutcome'='recorded' and r->'failureCode'='null'::jsonb
  and r->>'detectedCount'='0' and r->>'recordedCount'='0' and r->>'failedCount'='0'
  and (select count(*)=n from public.drift_events) and (select count(*)=l+1 from public.audit_ledger),'real clean probe records only its schedule receipt');
end $$;
delete from public.onboarding_attested_systems where wizard_id='00000000-0000-4000-8000-000000001227';
update public.monitoring_schedules set next_run_at='2026-01-11' where id='00000000-0000-4000-8000-000000001228';
do $$
declare r jsonb;n bigint;l bigint;
begin
 select count(*) into n from public.drift_events;select count(*) into l from public.audit_ledger;
 r:=pg_temp.fire('2026-01-11');
 perform pg_temp.ok(r->>'observationOutcome'='no_baseline' and r->>'recordingOutcome'='recorded' and r->'failureCode'='null'::jsonb
  and r->>'detectedCount'='0' and r->>'recordedCount'='0' and r->>'failedCount'='0'
  and (select count(*)=n from public.drift_events) and (select count(*)=l+1 from public.audit_ledger),'real absent baseline is preserved without false drift or event proof');
end $$;
update public.monitoring_schedules set next_run_at=clock_timestamp()+interval '1 hour' where id='00000000-0000-4000-8000-000000001228';
select pg_temp.ok(pg_temp.fire((select next_run_at from public.monitoring_schedules where id='00000000-0000-4000-8000-000000001228'))->>'error'='schedule_not_due','future slot never fires');
select pg_temp.ok(public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001222','00000000-0000-4000-8000-000000001228',
 '00000000-0000-4000-8000-000000001223','drift_check','*/15 * * * *','2026-01-12','00000000-0000-0000-0000-000000000000')->>'error'='invalid_fire','nil correlation never becomes proof');

select pg_temp.denied($q$update public.monitoring_schedule_fires set detected_count=0$q$);
select pg_temp.denied($q$delete from public.monitoring_schedule_fires$q$);
select pg_temp.denied($q$truncate public.monitoring_schedule_fires$q$);
select pg_temp.ok(not has_function_privilege('service_role','public.record_drift_event(uuid,uuid,text,text,text,text,uuid)','EXECUTE')
 and not has_function_privilege('service_role','public.record_schedule_run(uuid,uuid,timestamptz,text,uuid)','EXECUTE'),'legacy unfenced write paths revoked');
select pg_temp.ok(has_function_privilege('service_role','public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid)','EXECUTE')
 and not has_function_privilege('authenticated','public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid)','EXECUTE'),'only existing scheduler service gets transactional fire');
set local role service_role;
select pg_temp.denied($q$select public.record_drift_event(null,null,'system_added','low','invented',null,gen_random_uuid())$q$);
select pg_temp.denied($q$select public.record_schedule_run(null,null,now()+interval '1 hour','no_drift',gen_random_uuid())$q$);
select pg_temp.denied($q$delete from public.monitoring_schedule_fires$q$);
select pg_temp.denied($q$truncate public.monitoring_schedule_fires$q$);
select pg_temp.denied($q$update public.monitoring_schedule_fires set detected_count=0$q$);
reset role;
rollback;
