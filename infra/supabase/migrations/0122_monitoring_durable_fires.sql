-- One transactional monitoring fire per original due slot. No live discovery,
-- assessment, remediation, grant issuance or scheduler activation is added.
create table public.monitoring_schedule_fires (
 id uuid primary key,
 tenant_id uuid not null,
 schedule_id uuid not null,
 estate_id uuid not null,
 kind text not null,
 cadence text not null,
 due_at timestamptz not null,
 calculation_after timestamptz not null,
 next_run_at timestamptz not null,
 correlation_id uuid not null,
 observation_outcome text not null check(observation_outcome in ('drift_detected','no_drift','no_baseline','failed','unwired')),
 recording_outcome text not null check(recording_outcome in ('recorded','failed')),
 failure_code text check(failure_code in ('cadence_invalid','probe_invalid','probe_failed','event_recording_failed','live_executor_unwired')),
 detected_count integer not null check(detected_count between 0 and 2000),
 recorded_count integer not null check(recorded_count between 0 and 2000),
 failed_count integer not null check(failed_count between 0 and 2000),
 schedule_receipt bigint not null references public.audit_ledger(id) on delete restrict,
 event_receipts jsonb not null check(jsonb_typeof(event_receipts)='array'),
 unique(tenant_id,schedule_id,due_at),
 foreign key(tenant_id,schedule_id) references public.monitoring_schedules(tenant_id,id) on delete restrict,
 foreign key(tenant_id,estate_id) references public.estates(tenant_id,id) on delete restrict,
 check(recorded_count+failed_count=detected_count),
 check(jsonb_array_length(event_receipts)=recorded_count),
 check(due_at<=calculation_after and next_run_at>calculation_after),
 check((recording_outcome='recorded' and failure_code is null and failed_count=0)
  or (recording_outcome='failed' and failure_code is not null and recorded_count=0))
);
alter table public.monitoring_schedule_fires enable row level security;
revoke all on public.monitoring_schedule_fires from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;
create trigger monitoring_fire_immutable before update or delete on public.monitoring_schedule_fires
 for each row execute function public.evidence_receipt_immutable();
create trigger monitoring_fire_no_truncate before truncate on public.monitoring_schedule_fires
 for each statement execute function public.evidence_receipt_immutable();

-- Same numeric five-field subset and expanded DOM/DOW-set semantics as
-- axiom.cron_next. Integer casts are bounded before conversion.
create function controller_security.monitoring_cron_field(p_field text,p_low integer,p_high integer)
returns integer[] language plpgsql immutable set search_path='' as $$
declare atom text; body text; pieces text[]; first_value integer; last_value integer; step_value integer; first_numeric numeric; last_numeric numeric; step_numeric numeric; field_values integer[]:='{}';
begin
 if p_field is null or length(p_field) not between 1 and 100 then return null;end if;
 foreach atom in array string_to_array(p_field,',') loop
  if atom !~ '^([0-9]+|\*|[0-9]+-[0-9]+)(/[0-9]+)?$' then return null;end if;
  pieces:=string_to_array(atom,'/');body:=pieces[1];step_numeric:=coalesce(pieces[2]::numeric,1);
  if step_numeric<1 then return null;end if;
  step_value:=least(step_numeric,p_high-p_low+1)::integer;
  if body='*' then first_numeric:=p_low;last_numeric:=p_high;
  elsif position('-' in body)>0 then
   first_numeric:=split_part(body,'-',1)::numeric;last_numeric:=split_part(body,'-',2)::numeric;
  else first_numeric:=body::numeric;last_numeric:=case when array_length(pieces,1)=2 then p_high else first_numeric end;end if;
  if first_numeric<p_low or last_numeric>p_high or first_numeric>last_numeric then return null;end if;
  first_value:=first_numeric::integer;last_value:=last_numeric::integer;
  field_values:=field_values||array(select generate_series(first_value,last_value,step_value));
 end loop;
 return array(select distinct value from unnest(field_values) value order by value);
end $$;

create function controller_security.monitoring_cron_next(p_cadence text,p_after timestamptz)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare fields text[]; minutes integer[];hours integer[];doms integer[];months integer[];dows integer[];
 moment timestamp;horizon timestamp;day_ok boolean;candidate integer;
begin
 if p_after is null or not isfinite(p_after) or p_cadence is null or length(p_cadence) not between 1 and 100 then return null;end if;
 fields:=regexp_split_to_array(btrim(p_cadence),'\s+');if cardinality(fields)<>5 then return null;end if;
 minutes:=controller_security.monitoring_cron_field(fields[1],0,59);
 hours:=controller_security.monitoring_cron_field(fields[2],0,23);
 doms:=controller_security.monitoring_cron_field(fields[3],1,31);
 months:=controller_security.monitoring_cron_field(fields[4],1,12);
 dows:=controller_security.monitoring_cron_field(fields[5],0,6);
 if minutes is null or hours is null or doms is null or months is null or dows is null then return null;end if;
 moment:=date_trunc('minute',(p_after at time zone 'UTC')+interval '1 minute');
 horizon:=(p_after at time zone 'UTC')+interval '732 days';
 while moment<=horizon loop
  day_ok:=extract(month from moment)::integer=any(months) and
   case when cardinality(doms)<31 and cardinality(dows)<7
    then extract(day from moment)::integer=any(doms) or extract(dow from moment)::integer=any(dows)
    else extract(day from moment)::integer=any(doms) and extract(dow from moment)::integer=any(dows) end;
  if not day_ok then moment:=date_trunc('day',moment)+interval '1 day';continue;end if;
  if not extract(hour from moment)::integer=any(hours) then
   select min(value) into candidate from unnest(hours) value where value>extract(hour from moment);
   if candidate is null then moment:=date_trunc('day',moment)+interval '1 day';
   else moment:=date_trunc('day',moment)+candidate*interval '1 hour';end if;continue;
  end if;
  if extract(minute from moment)::integer=any(minutes) then return moment at time zone 'UTC';end if;
  select min(value) into candidate from unnest(minutes) value where value>extract(minute from moment);
  if candidate is null then moment:=date_trunc('hour',moment)+interval '1 hour';
  else moment:=date_trunc('hour',moment)+candidate*interval '1 minute';end if;
 end loop;
 return null;
end $$;
revoke all on function controller_security.monitoring_cron_field(text,integer,integer),controller_security.monitoring_cron_next(text,timestamptz)
 from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

-- Readback earns proof from actual immutable event and ledger rows. Neither a
-- caller correlation nor the schedule's later configuration can rewrite a fire.
create function controller_security.monitoring_fire_response(p_fire_id uuid,p_replayed boolean)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f public.monitoring_schedule_fires;r public.audit_ledger;e public.audit_ledger;d public.drift_events;
 item jsonb;seen_events uuid[]:='{}';seen_receipts bigint[]:='{}';previous_receipt bigint:=0;
begin
 select * into f from public.monitoring_schedule_fires where id=p_fire_id;
 if not found then return jsonb_build_object('error','fire_proof_refused');end if;
 select * into r from public.audit_ledger where tenant_id=f.tenant_id and id=f.schedule_receipt;
 if r.id is null or r.action_type<>'monitoring.schedule.fired' or r.actor_type<>'system'
  or r.actor_id<>'continuous-compliance-scheduler' or r.target_ref is distinct from f.schedule_id::text
  or r.correlation_id is distinct from f.correlation_id
  or r.result is distinct from (case when f.recording_outcome='failed' then 'failure'::public.ledger_result else 'success'::public.ledger_result end)
  or r.detail is distinct from jsonb_build_object('fire_id',f.id,'schedule_id',f.schedule_id,'estate_id',f.estate_id,
   'kind',f.kind,'cadence',f.cadence,'due_at',f.due_at,'calculation_after',f.calculation_after,'next_run_at',f.next_run_at,
   'observation_outcome',f.observation_outcome,'recording_outcome',f.recording_outcome,'failure_code',f.failure_code,
   'detected_count',f.detected_count,'recorded_count',f.recorded_count,'failed_count',f.failed_count,'event_receipts',f.event_receipts)
 then return jsonb_build_object('error','fire_proof_refused');end if;
 for item in select value from jsonb_array_elements(f.event_receipts) loop
  select * into e from public.audit_ledger where tenant_id=f.tenant_id and id=(item->>'id')::bigint;
  select * into d from public.drift_events where tenant_id=f.tenant_id and id=(item->>'eventId')::uuid;
  if e.id is null or d.id is null or d.estate_id<>f.estate_id or e.entry_hash is distinct from item->>'entryHash'
   or e.id<=previous_receipt or e.id>=r.id or d.id=any(seen_events) or e.id=any(seen_receipts)
   or e.actor_type<>'system' or e.actor_id<>'continuous-compliance-scheduler' or e.action_type<>'monitoring.drift.detected'
   or e.correlation_id is distinct from f.correlation_id or e.target_ref is distinct from f.estate_id::text
   or e.result is distinct from (case when d.severity in ('high','critical') then 'failure'::public.ledger_result else 'success'::public.ledger_result end)
   or e.detail is distinct from jsonb_build_object('fire_id',f.id,'drift_event_id',d.id,'kind',d.kind,'severity',d.severity,'summary',d.summary,'source_ref',d.source_ref)
  then return jsonb_build_object('error','fire_proof_refused');end if;
  seen_events:=array_append(seen_events,d.id);seen_receipts:=array_append(seen_receipts,e.id);previous_receipt:=e.id;
 end loop;
 return jsonb_build_object('tenantId',f.tenant_id,'fireId',f.id,'scheduleId',f.schedule_id,'estateId',f.estate_id,'kind',f.kind,
  'cadence',f.cadence,'dueAt',f.due_at,'calculationAfter',f.calculation_after,'nextRunAt',f.next_run_at,
  'correlationId',f.correlation_id,'replayed',p_replayed,'observationOutcome',f.observation_outcome,
  'recordingOutcome',f.recording_outcome,'failureCode',f.failure_code,'detectedCount',f.detected_count,
  'recordedCount',f.recorded_count,'failedCount',f.failed_count,
  'scheduleReceipt',jsonb_build_object('id',r.id::text,'entryHash',r.entry_hash),'eventReceipts',f.event_receipts);
end $$;
revoke all on function controller_security.monitoring_fire_response(uuid,boolean) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer;

create function public.read_monitoring_schedule_fire(p_tenant_id uuid,p_schedule_id uuid,p_estate_id uuid,
 p_expected_kind text,p_expected_cadence text,p_expected_due_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.monitoring_schedule_fires;
begin
 select * into f from public.monitoring_schedule_fires where tenant_id=p_tenant_id and schedule_id=p_schedule_id and due_at=p_expected_due_at;
 if not found then return jsonb_build_object('missing',true);end if;
 if f.estate_id is distinct from p_estate_id or f.kind is distinct from p_expected_kind or f.cadence is distinct from p_expected_cadence
 then return jsonb_build_object('error','fire_context_refused');end if;
 return controller_security.monitoring_fire_response(f.id,true);
end $$;

create function public.fire_monitoring_schedule(p_tenant_id uuid,p_schedule_id uuid,p_estate_id uuid,
 p_expected_kind text,p_expected_cadence text,p_expected_due_at timestamptz,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set timezone='UTC' as $$
declare s public.monitoring_schedules;f public.monitoring_schedule_fires;v_fire_id uuid:=gen_random_uuid();
 calculation timestamptz;next_at timestamptz;probe jsonb;key text;item jsonb;items jsonb:='[]';events jsonb:='[]';
 observation text:='failed';recording text:='failed';failure text;detected integer:=0;recorded integer:=0;failed integer:=0;
 event_id uuid;receipt_id bigint;event_hash text;schedule_receipt_id bigint;response jsonb;advanced integer;
begin
 if p_tenant_id is null or p_schedule_id is null or p_estate_id is null or p_correlation_id is null
  or '00000000-0000-0000-0000-000000000000'::uuid in (p_tenant_id,p_schedule_id,p_estate_id,p_correlation_id)
  or p_expected_due_at is null or not isfinite(p_expected_due_at) or p_expected_kind is null or p_expected_cadence is null
 then return jsonb_build_object('error','invalid_fire');end if;
 -- The schedule fence precedes EVERY event/receipt write, not just the final
 -- advancement. The unique retained slot is a second defence, never a lease.
 select * into s from public.monitoring_schedules where tenant_id=p_tenant_id and id=p_schedule_id for update;
 if not found then return jsonb_build_object('error','schedule_not_found');end if;
 select * into f from public.monitoring_schedule_fires where tenant_id=p_tenant_id and schedule_id=p_schedule_id and due_at=p_expected_due_at;
 if found then
  if f.estate_id is distinct from p_estate_id or f.kind is distinct from p_expected_kind or f.cadence is distinct from p_expected_cadence
  then return jsonb_build_object('error','fire_context_refused');end if;
  return controller_security.monitoring_fire_response(f.id,true);
 end if;
 if s.status<>'active' or s.estate_id is distinct from p_estate_id or s.kind is distinct from p_expected_kind
  or s.cadence is distinct from p_expected_cadence or s.next_run_at is distinct from p_expected_due_at
 then return jsonb_build_object('error','schedule_snapshot_changed');end if;
 calculation:=clock_timestamp();
 if s.next_run_at>calculation then return jsonb_build_object('error','schedule_not_due');end if;
 next_at:=controller_security.monitoring_cron_next(s.cadence,calculation);
 if next_at is null then
  next_at:=calculation+interval '24 hours';failure:='cadence_invalid';
 else
  begin
   probe:=public.onboarding_estate_drift(p_tenant_id,p_estate_id);
   if jsonb_typeof(probe) is distinct from 'object' or octet_length(probe::text)>1048576 then
    failure:='probe_invalid';
   elsif probe->>'status'='no_baseline' and (select count(*) from jsonb_object_keys(probe))=3
    and jsonb_typeof(probe->'baselineWizardId')='string'
    and probe->>'baselineWizardId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and probe->>'baselineWizardId'<>'00000000-0000-0000-0000-000000000000'
    and jsonb_typeof(probe->'completedAt')='string'
    and probe->>'completedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and isfinite((probe->>'completedAt')::timestamptz) and (probe->>'completedAt')::timestamptz<=calculation then
    observation:='no_baseline';recording:='recorded';
   elsif (probe->>'status'='not_onboarded' and (select count(*) from jsonb_object_keys(probe))=1)
    or (probe->>'error'='not_found' and (select count(*) from jsonb_object_keys(probe))=1) then failure:='probe_failed';
   elsif probe->>'status' in ('current','drifted') and (select count(*) from jsonb_object_keys(probe))=7 and probe?&array['added','removed','changed','connectionLost','baselineWizardId','completedAt'] then
    foreach key in array array['added','removed','changed','connectionLost'] loop
     if jsonb_typeof(probe->key) is distinct from 'array' then failure:='probe_invalid';exit;end if;
     for item in select value from jsonb_array_elements(probe->key) loop
      if jsonb_typeof(item) is distinct from 'object' or not(item?&array['id','name'])
       or (select count(*) from jsonb_object_keys(item))<>2 or jsonb_typeof(item->'id') is distinct from 'string'
       or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or item->>'id'='00000000-0000-0000-0000-000000000000'
       or jsonb_typeof(item->'name') is distinct from 'string' or length(item->>'name') not between 1 and 300
      then failure:='probe_invalid';exit;end if;
      items:=items||jsonb_build_array(item||jsonb_build_object('kind',case key when 'added' then 'system_added'
       when 'removed' then 'system_removed' when 'changed' then 'system_changed' else 'connection_lost' end));
      if jsonb_array_length(items)>2000 then failure:='probe_invalid';exit;end if;
     end loop;
     exit when failure is not null;
    end loop;
    if failure is null and (jsonb_typeof(probe->'baselineWizardId') is distinct from 'string'
     or probe->>'baselineWizardId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or probe->>'baselineWizardId'='00000000-0000-0000-0000-000000000000'
     or jsonb_typeof(probe->'completedAt') is distinct from 'string'
     or probe->>'completedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
     or not isfinite((probe->>'completedAt')::timestamptz) or (probe->>'completedAt')::timestamptz>calculation) then failure:='probe_invalid';end if;
    if failure is null and (select count(*)<>count(distinct (value->>'kind',value->>'id')) from jsonb_array_elements(items)) then failure:='probe_invalid';end if;
    if failure is null and ((probe->>'status'='current') is distinct from (jsonb_array_length(items)=0)) then failure:='probe_invalid';end if;
    if failure is null then detected:=jsonb_array_length(items);observation:=case when detected=0 then 'no_drift' else 'drift_detected' end;
     if s.kind<>'drift_check' then observation:='unwired';failure:='live_executor_unwired';detected:=0;items:='[]';
     else recording:='recorded';end if;
    end if;
   else failure:='probe_invalid';end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
   failure:='probe_invalid';observation:='failed';recording:='failed';detected:=0;items:='[]';
  when others then failure:='probe_failed';observation:='failed';recording:='failed';detected:=0;items:='[]';
  end;
 end if;
 if failure is not null then recording:='failed';end if;
 if detected>0 and failure is null then
  begin
   for item in select value from jsonb_array_elements(items) loop
    insert into public.drift_events(tenant_id,estate_id,kind,severity,summary,source_ref)
    values(p_tenant_id,p_estate_id,item->>'kind',case when item->>'kind' in ('system_removed','connection_lost') then 'high' else 'medium' end,
     left(replace(item->>'kind','_',' ')||': '||(item->>'name'),300),item->>'id') returning id into event_id;
    receipt_id:=public.append_ledger(p_tenant_id,p_correlation_id,'system','continuous-compliance-scheduler',null,null,null,
     'monitoring.drift.detected',p_estate_id::text,null,null,null,null,null,null,
     case when item->>'kind' in ('system_removed','connection_lost') then 'failure'::public.ledger_result else 'success'::public.ledger_result end,
     jsonb_build_object('fire_id',v_fire_id,'drift_event_id',event_id,'kind',item->>'kind',
      'severity',case when item->>'kind' in ('system_removed','connection_lost') then 'high' else 'medium' end,
      'summary',left(replace(item->>'kind','_',' ')||': '||(item->>'name'),300),'source_ref',item->>'id'));
    select entry_hash into strict event_hash from public.audit_ledger where tenant_id=p_tenant_id and id=receipt_id;
    events:=events||jsonb_build_array(jsonb_build_object('eventId',event_id,'id',receipt_id::text,'entryHash',event_hash));
   end loop;
   recorded:=detected;
  exception when others then
   -- All event writes and their audit appends roll back together. Keep the
   -- actual detection count, never turn failure into no_drift/partial proof.
   events:='[]';recorded:=0;failed:=detected;recording:='failed';failure:='event_recording_failed';
  end;
 end if;
 -- Recording and ledger contention may cross a cron boundary. Recompute from
 -- actual completion time, then refuse the whole fire if its final append
 -- consumes the remaining interval before schedule advancement.
 calculation:=clock_timestamp();
 next_at:=case when failure='cadence_invalid' then calculation+interval '24 hours'
  else controller_security.monitoring_cron_next(s.cadence,calculation) end;
 if next_at is null then raise exception 'monitoring next run refused';end if;
 schedule_receipt_id:=public.append_ledger(p_tenant_id,p_correlation_id,'system','continuous-compliance-scheduler',null,null,null,
  'monitoring.schedule.fired',p_schedule_id::text,null,null,null,null,null,null,
  case when recording='failed' then 'failure'::public.ledger_result else 'success'::public.ledger_result end,
  jsonb_build_object('fire_id',v_fire_id,'schedule_id',s.id,'estate_id',s.estate_id,'kind',s.kind,'cadence',s.cadence,
   'due_at',s.next_run_at,'calculation_after',calculation,'next_run_at',next_at,'observation_outcome',observation,
   'recording_outcome',recording,'failure_code',failure,'detected_count',detected,'recorded_count',recorded,'failed_count',failed,'event_receipts',events));
 insert into public.monitoring_schedule_fires values(v_fire_id,p_tenant_id,s.id,s.estate_id,s.kind,s.cadence,s.next_run_at,
  calculation,next_at,p_correlation_id,observation,recording,failure,detected,recorded,failed,schedule_receipt_id,events);
 update public.monitoring_schedules set last_run_at=calculation,next_run_at=next_at,updated_at=calculation where tenant_id=p_tenant_id and id=s.id and next_at>clock_timestamp();
 get diagnostics advanced=row_count;
 if advanced<>1 then raise exception 'monitoring next run expired';end if;
 response:=controller_security.monitoring_fire_response(v_fire_id,false);
 if response?'error' then raise exception 'monitoring fire proof refused';end if;
 return response;
end $$;
revoke all on function public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid),
 public.read_monitoring_schedule_fire(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated,human_action_writer,agent_ledger_writer;
grant execute on function public.fire_monitoring_schedule(uuid,uuid,uuid,text,text,timestamptz,uuid),
 public.read_monitoring_schedule_fire(uuid,uuid,uuid,text,text,timestamptz) to service_role;
-- Historical definitions/proofs remain. The scheduler service can no longer
-- bypass the fire fence with caller-invented drift or bookkeeping outcomes.
revoke execute on function public.record_drift_event(uuid,uuid,text,text,text,text,uuid),
 public.record_schedule_run(uuid,uuid,timestamptz,text,uuid) from service_role;
