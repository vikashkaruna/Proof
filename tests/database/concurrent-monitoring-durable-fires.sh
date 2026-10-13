#!/usr/bin/env bash
# Runs only inside scripts/test-database.sh's owned disposable PostgreSQL.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq; }
sql <<'SQL'
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000002221','fire-race@test.invalid');
insert into public.users(id,email) values('00000000-0000-4000-8000-000000002221','fire-race@test.invalid');
insert into public.tenants(id,slug,name) values('00000000-0000-4000-8000-000000002222','fire-race','Fire Race');
insert into public.estates(id,tenant_id,slug,name) values('00000000-0000-4000-8000-000000002223','00000000-0000-4000-8000-000000002222','race-estate','Race Estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values
 ('00000000-0000-4000-8000-000000002224','00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002223','Baseline','other'),
 ('00000000-0000-4000-8000-000000002225','00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002223','Concurrent Addition','other');
insert into public.tenant_onboarding_wizards(id,tenant_id,estate_id,status,completed_steps,started_by,completed_by,completed_at,readiness)
 values('00000000-0000-4000-8000-000000002227','00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002223',
 'completed',array['company','estate','inventory','connectors','grants','readiness'],'00000000-0000-4000-8000-000000002221',
 '00000000-0000-4000-8000-000000002221',now()-interval '2 days','{}');
insert into public.onboarding_attested_systems values('00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002227',
 '00000000-0000-4000-8000-000000002224',1,'{}',true,false);
insert into public.monitoring_schedules(id,tenant_id,estate_id,name,kind,cadence,created_by,next_run_at)
 values('00000000-0000-4000-8000-000000002228','00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002223',
 'Race Drift','drift_check','*/15 * * * *','00000000-0000-4000-8000-000000002221','2026-01-01T00:00:00Z');
SQL
pids=()
for worker in $(seq 1 8); do
  sql > "$result_dir/$worker.json" <<'SQL' &
set role service_role;
select public.fire_monitoring_schedule('00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002228',
 '00000000-0000-4000-8000-000000002223','drift_check','*/15 * * * *','2026-01-01T00:00:00Z',gen_random_uuid());
SQL
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
python3 - "$result_dir" <<'PY'
import json
from pathlib import Path
import sys
items = [json.loads(path.read_text()) for path in Path(sys.argv[1]).glob('*.json')]
assert len(items) == 8 and sum(item['replayed'] is False for item in items) == 1
assert all(item['detectedCount'] == item['recordedCount'] == 1 and item['failedCount'] == 0 for item in items)
proofs = [{key: value for key, value in item.items() if key != 'replayed'} for item in items]
assert all(proof == proofs[0] for proof in proofs), 'Concurrent losers must recover the same original proof'
print('Concurrent durable fire: one writer, seven exact original-proof replays.')
PY
sql <<'SQL'
do $$begin
 if (select count(*) from public.monitoring_schedule_fires where tenant_id='00000000-0000-4000-8000-000000002222')<>1
  or (select count(*) from public.drift_events where tenant_id='00000000-0000-4000-8000-000000002222')<>1
  or (select count(*) from public.audit_ledger where tenant_id='00000000-0000-4000-8000-000000002222')<>2
 then raise exception 'Same-slot race duplicated fire/event/audit';end if;
end$$;
-- A configuration edit wins the row lock before a stale worker. There are no
-- event writes before the stale worker's final comparison.
update public.monitoring_schedules set next_run_at='2026-01-02T00:00:00Z' where id='00000000-0000-4000-8000-000000002228';
SQL
sql > "$result_dir/retirement.log" <<'SQL' &
begin;
update public.monitoring_schedules set status='retired' where id='00000000-0000-4000-8000-000000002228';
select pg_sleep(1);
commit;
SQL
retirement_pid=$!
# Wait until the retirement session demonstrably owns the schedule tuple lock.
# The observation is bounded and read-only; it does not substitute for the RPC fence.
retirement_seen=false
for attempt in $(seq 1 50); do
  if [ "$(sql <<'SQL'
select exists(select 1 from pg_stat_activity where datname='axiom_policy_test' and pid<>pg_backend_pid() and query like '%pg_sleep(1)%' and wait_event='PgSleep');
SQL
)" = t ]; then retirement_seen=true; break; fi
  sleep 0.02
done
[ "$retirement_seen" = true ] || { echo "Retirement lock barrier was not observed" >&2; wait "$retirement_pid"; exit 1; }
sql > "$result_dir/stale.json" <<'SQL'
set role service_role;
select public.fire_monitoring_schedule('00000000-0000-4000-8000-000000002222','00000000-0000-4000-8000-000000002228',
 '00000000-0000-4000-8000-000000002223','drift_check','*/15 * * * *','2026-01-02T00:00:00Z',gen_random_uuid());
SQL
wait "$retirement_pid"
python3 - "$result_dir/stale.json" <<'PY'
import json,sys
with open(sys.argv[1]) as stream:
    assert json.load(stream) == {'error': 'schedule_snapshot_changed'}
PY
sql <<'SQL'
do $$begin
 if (select count(*) from public.monitoring_schedule_fires where tenant_id='00000000-0000-4000-8000-000000002222')<>1
  or (select count(*) from public.drift_events where tenant_id='00000000-0000-4000-8000-000000002222')<>1
  or (select count(*) from public.audit_ledger where tenant_id='00000000-0000-4000-8000-000000002222')<>2
 then raise exception 'Retirement race wrote stale events or proof';end if;
end$$;
SQL
