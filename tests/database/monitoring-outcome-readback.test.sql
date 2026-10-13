-- Disposable PostgreSQL source regression: real durable fires/receipts, never a live target.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m;end if;end $$;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000001261','fire@test.invalid');
insert into public.users(id,email) values('00000000-0000-4000-8000-000000001261','fire@test.invalid');
insert into public.tenants(id,slug,name) values('00000000-0000-4000-8000-000000001262','outcome-readback','Durable Fire'),
 ('00000000-0000-4000-8000-000000001269','outcome-readback-other','Other Fire');
insert into public.estates(id,tenant_id,slug,name) values('00000000-0000-4000-8000-000000001263',
 '00000000-0000-4000-8000-000000001262','fire-estate','Fire Estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000001264','00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001263','Baseline','other'),
 ('00000000-0000-4000-8000-000000001265','00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001263','Added One','other'),
 ('00000000-0000-4000-8000-000000001266','00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001263','Added Two','other');
insert into public.tenant_onboarding_wizards(id,tenant_id,estate_id,status,completed_steps,started_by,completed_by,completed_at,readiness)
 values('00000000-0000-4000-8000-000000001267','00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001263',
 'completed',array['company','estate','inventory','connectors','grants','readiness'],'00000000-0000-4000-8000-000000001261',
 '00000000-0000-4000-8000-000000001261',now()-interval '2 days','{}');
insert into public.onboarding_attested_systems values('00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001267',
 '00000000-0000-4000-8000-000000001264',1,'{}',true,false);
insert into public.monitoring_schedules(id,tenant_id,estate_id,name,kind,cadence,created_by,next_run_at)
 values('00000000-0000-4000-8000-000000001268','00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001263',
 'Durable Drift','drift_check','*/15 * * * *','00000000-0000-4000-8000-000000001261','2026-01-01T00:00:00Z');

create function pg_temp.denied(statement text) returns void language plpgsql as $$ begin begin execute statement;exception when insufficient_privilege then return;end;raise exception 'Privilege was not denied';end $$;
insert into public.estates(id,tenant_id,slug,name) values('00000000-0000-4000-8000-000000001270','00000000-0000-4000-8000-000000001269','foreign-readback','Foreign Estate');
insert into public.monitoring_schedules(id,tenant_id,estate_id,name,kind,cadence,created_by) values('00000000-0000-4000-8000-000000001271','00000000-0000-4000-8000-000000001269','00000000-0000-4000-8000-000000001270','Foreign schedule','drift_check','*/15 * * * *','00000000-0000-4000-8000-000000001261');
insert into public.tenant_users(tenant_id,user_id,role) values ('00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001261','viewer');
insert into public.monitoring_schedules(id,tenant_id,estate_id,name,kind,cadence,created_by,status,last_run_at,next_run_at)
 values('00000000-0000-4000-8000-000000001260','00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001263','Legacy attempt','drift_check','*/15 * * * *','00000000-0000-4000-8000-000000001261','paused',now()-interval '1 day',now()+interval '1 day');
create function pg_temp.fire(due_at timestamptz,kind text default 'drift_check') returns jsonb language sql as $$
 select public.fire_monitoring_schedule('00000000-0000-4000-8000-000000001262','00000000-0000-4000-8000-000000001268','00000000-0000-4000-8000-000000001263',kind,'*/15 * * * *',due_at,gen_random_uuid());$$;
select pg_temp.ok(pg_temp.fire('2026-01-01')->>'recordingOutcome'='recorded','real initial drift fire recorded');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000001261","role":"authenticated"}',true);
set local role authenticated;
select 'W6_WIRE='||public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid,'00000000-0000-4000-8000-000000001260'::uuid])::text;
reset role;
update public.monitoring_schedules set kind='reassessment',next_run_at='2026-01-02' where id='00000000-0000-4000-8000-000000001268';
select pg_temp.ok(pg_temp.fire('2026-01-02','reassessment')->>'observationOutcome'='unwired','real subsequent reassessment is honestly unwired');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000001261","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid])#>>'{schedules,0,fire,observationOutcome}'='unwired','unwired outcome readback survives advanced next_run_at');
select 'W6_WIRE='||public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid,'00000000-0000-4000-8000-000000001260'::uuid])::text;
reset role;
update public.monitoring_schedules set kind='drift_check',next_run_at='2026-01-03' where id='00000000-0000-4000-8000-000000001268';
create function pg_temp.fail_event() returns trigger language plpgsql as $$ begin raise exception 'synthetic event failure';end $$;
create trigger outcome_fixture_event_failure before insert on public.drift_events for each row execute function pg_temp.fail_event();
select pg_temp.ok(pg_temp.fire('2026-01-03')->>'failureCode'='event_recording_failed','actual atomic event insertion failure retained');
drop trigger outcome_fixture_event_failure on public.drift_events;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000001261","role":"authenticated"}',true);
create temp table outcome_before_read as select (select count(*) from public.audit_ledger) ledger_count,(select count(*) from public.monitoring_schedule_fires) fire_count,(select count(*) from public.drift_events) event_count;
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid,'00000000-0000-4000-8000-000000001260'::uuid]);
 perform pg_temp.ok(r#>>'{schedules,0,fire,dueAt}'='2026-01-03T00:00:00+00:00','latest selected by original due, not next timestamp or insertion approximation');
 perform pg_temp.ok(r#>>'{schedules,0,fire,failureCode}'='event_recording_failed' and r#>>'{schedules,0,fire,detectedCount}'='2' and r#>>'{schedules,0,fire,recordedCount}'='0' and r#>>'{schedules,0,fire,failedCount}'='2','detected vs zero recorded failure truthful');
 perform pg_temp.ok(r#>>'{schedules,1,state}'='never_recorded' and r#>'{schedules,1,fire}'='null'::jsonb,'legacy last_run timestamp never manufactures journal/counts');
 perform pg_temp.ok(r#>>'{schedules,0,fire,scheduleReceipt,id}' is not null and r#>>'{schedules,0,fire,scheduleReceipt,entryHash}' ~ '^[a-f0-9]{64}$','actual immutable receipt linkage retained');
 perform pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001269','{}')->>'error'='monitoring_read_refused','foreign tenant refused even with empty selection');
 perform pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid,'00000000-0000-4000-8000-000000001271'::uuid])->>'error'='monitoring_read_refused','existing foreign schedule refuses whole mixed selection');
 perform pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid,'00000000-0000-4000-8000-000000001268'::uuid])->>'error'='monitoring_read_refused','duplicate schedule selection refused');
 perform pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',null)->>'error'='monitoring_read_refused','null selection refused');
 perform pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array[null::uuid])->>'error'='monitoring_read_refused','null item refused');
 perform pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array_fill('00000000-0000-4000-8000-000000001268'::uuid,array[101]))->>'error'='monitoring_read_refused','oversized request refused');
 perform pg_temp.denied('select count(*) from public.monitoring_schedule_fires');
 perform pg_temp.ok(not has_table_privilege(current_user,'public.monitoring_schedule_fires','SELECT'),'no direct fire SELECT grant');
end $$;
select 'W6_WIRE='||public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001268'::uuid,'00000000-0000-4000-8000-000000001260'::uuid])::text;
reset role;
select pg_temp.ok((select ledger_count=(select count(*) from public.audit_ledger) and fire_count=(select count(*) from public.monitoring_schedule_fires) and event_count=(select count(*) from public.drift_events) from outcome_before_read),'reads do not append or mutate retained facts');
select pg_temp.ok(not has_function_privilege('anon','public.read_monitoring_outcomes(uuid,uuid[])','EXECUTE') and not has_function_privilege('service_role','public.read_monitoring_outcomes(uuid,uuid[])','EXECUTE') and not has_function_privilege('agent_ledger_writer','public.read_monitoring_outcomes(uuid,uuid[])','EXECUTE') and not has_function_privilege('human_action_writer','public.read_monitoring_outcomes(uuid,uuid[])','EXECUTE'),'only authenticated user read authority');
update public.tenant_users set role='agent' where tenant_id='00000000-0000-4000-8000-000000001262';
set local role authenticated;
select pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262','{}')->>'error'='monitoring_read_refused','agent membership is not human posture authority');
reset role;
update public.tenant_users set role='viewer' where tenant_id='00000000-0000-4000-8000-000000001262';
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
set local role authenticated;
select pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262','{}')->>'error'='monitoring_read_refused','missing authenticated user refuses');
reset role;
-- Corrupt copied source is a refused test fixture, not fabricated successful proof.
insert into public.monitoring_schedule_fires select gen_random_uuid(),tenant_id,'00000000-0000-4000-8000-000000001260',estate_id,kind,cadence,due_at,calculation_after,next_run_at,correlation_id,observation_outcome,recording_outcome,failure_code,detected_count,recorded_count,failed_count,schedule_receipt,event_receipts from public.monitoring_schedule_fires where schedule_id='00000000-0000-4000-8000-000000001268' order by due_at desc limit 1;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000001261","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.ok(public.read_monitoring_outcomes('00000000-0000-4000-8000-000000001262',array['00000000-0000-4000-8000-000000001260'::uuid])->>'error'='monitoring_proof_unavailable','copied receipt with different schedule identity cannot authorize summary');
reset role;
rollback;
