#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
cleanup() {
 local pid running_pids
 running_pids=$(jobs -pr)
 for pid in $running_pids; do kill "$pid" 2>/dev/null || true; done
 for pid in $running_pids; do wait "$pid" 2>/dev/null || true; done
 rm -rf "$result_dir"
}
trap cleanup EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
index=0
fixture() {
 index=$((index+1)); scope="registration_race_$index"
 sql -c "create schema $scope"
 python3 - "$scope" "$index" <<'PY' | sql
from pathlib import Path
import re,sys
s=Path('tests/database/workload-registration.test.sql').read_text().split('-- LIFECYCLE_FIXTURE_READY')[0]
s=s.replace('begin;\n','',1).replace('pg_temp',sys.argv[1]).replace('76760000',f'7777{int(sys.argv[2]):04d}').replace('registration-lifecycle',sys.argv[1])
s=s.replace("repeat('b',64)","encode(sha256(convert_to('"+sys.argv[1]+".proof','UTF8')),'hex')")
s=s.replace('create temporary table issued','create table issued')
s=re.sub(r'\bissued\b',sys.argv[1]+'.issued',s)
print(s)
print(f'grant usage on schema {sys.argv[1]} to service_role; grant execute on all functions in schema {sys.argv[1]} to service_role;')
PY
 sql -c "select $scope.start_tool()" > "$result_dir/setup"
}
barrier() {
 for attempt in $(seq 1 100); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
  sleep 0.05
 done
 echo "Registration concurrency barrier not reached: $1 $2 $3"; exit 1
}
race() {
 # Keep the first writer's transaction open until the second writer is
 # demonstrably blocked. A fixed pg_sleep window can elapse while a busy
 # hosted runner is launching/observing the second Docker exec.
 local gate="$result_dir/gate-$index"
 mkfifo "$gate"
 sql < "$gate" > "$result_dir/gate" 2>&1 &
 local gate_pid=$!
 exec 9> "$gate"
 printf "set application_name='registration-gate'; begin; select pg_advisory_xact_lock(777701,%s);\n" "$index" >&9
 barrier registration-gate state 'idle in transaction'
 sql 9>&- -c "set statement_timeout='45s'; set application_name='registration-first'; begin; set local role service_role; $1; select pg_advisory_xact_lock(777701,$index); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier registration-first wait_event advisory
 sql 9>&- -c "set statement_timeout='45s'; set application_name='registration-second'; set role service_role; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier registration-second wait_event_type Lock
 printf 'commit;\n' >&9
 exec 9>&-
 wait "$gate_pid" || { cat "$result_dir/gate"; exit 1; }
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
 }
fixture
race "select $scope.manage(1,'disabled')" "select $scope.finish_tool()"
grep -q task_refused "$result_dir/second"
[ "$(sql -c "select count(*) from public.findings where tenant_id=$scope.id(11)")" = 0 ]
fixture
race "select $scope.finish_tool()" "select $scope.manage(1,'disabled')"
[ "$(sql -c "select count(*) from public.findings where tenant_id=$scope.id(11)")" = 2 ]
[ "$(sql -c "select revoked_at is not null from public.workload_task_delegations where tenant_id=$scope.id(11)")" = t ]
fixture
race "select $scope.manage(1,'disabled')" "select public.delegate_workload_task($scope.id(11),$scope.id(1),$scope.id(31),'parikshan',$scope.id(22),$scope.id(21),$scope.id(41),repeat('a',64),encode(sha256(convert_to('$scope.extra','UTF8')),'hex'),array['control_library.read','findings.write'],clock_timestamp()+interval '5 minutes')"
grep -q workload_refused "$result_dir/second"
fixture
race "select public.delegate_workload_task($scope.id(11),$scope.id(1),$scope.id(31),'parikshan',$scope.id(22),$scope.id(21),$scope.id(41),repeat('a',64),encode(sha256(convert_to('$scope.extra','UTF8')),'hex'),array['control_library.read','findings.write'],clock_timestamp()+interval '5 minutes')" "select $scope.manage(1,'disabled')"
[ "$(sql -c "select count(*)=2 and bool_and(revoked_at is not null) from public.workload_task_delegations where tenant_id=$scope.id(11)")" = t ]
fixture
race "select $scope.manage(1,'disabled')" "select $scope.manage(1,'active')"
grep -q version_conflict "$result_dir/second"
fixture
race "select $scope.manage(1,'active')" "select $scope.manage(1,'disabled')"
grep -q version_conflict "$result_dir/second"
echo 'Registration concurrency: disable/tool, disable/issuance and competing reviewed status changes serialize in both orderings.'
