#!/usr/bin/env bash
# Only the disposable migration-test container passed by test-database.sh.
set -euo pipefail
container="${1:?test container required}"
database="${2:-axiom_policy_test}"
results=$(mktemp -d)
first_pid=''
second_pid=''
barrier_open=false
cleanup() {
 if [ "$barrier_open" = true ]; then
  printf 'rollback;\n\\q\n' >&3 2>/dev/null || true
  exec 3>&-
 fi
 for worker_pid in "$first_pid" "$second_pid"; do
  if [ -n "$worker_pid" ]; then
   kill "$worker_pid" 2>/dev/null || true
   wait "$worker_pid" 2>/dev/null || true
  fi
 done
 rm -rf "$results"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
sql() { docker exec -i "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -qAt "$@"; }
# Share the lifecycle fixtures without weakening tested RPCs or writing claims.
python3 - <<'PY' | sql
from pathlib import Path
source=Path('tests/database/generic-agent-runs.test.sql').read_text()
fixture=source[source.index('create function pg_temp.id'):source.index('-- Credentials expose')]
print('create schema generic_run_race;')
print(fixture.replace('pg_temp.', 'generic_run_race.').replace('99100400-', '99101400-').replace('generic-a', 'generic-race-a').replace('generic-b', 'generic-race-b').replace('generic-test', 'generic-race-test').replace('generic-sql-', 'generic-race-'))
print('grant usage on schema generic_run_race to human_action_writer,agent_ledger_writer;')
print('create table generic_run_race.state(run_id uuid,receipts jsonb);')
PY
race() {
 local input="$results/first-input"
 local ready=false blocked=false first_backend_pid='' deadline
 mkfifo "$input"
 sql < "$input" > "$results/first" 2>&1 &
 first_pid=$!
 exec 3> "$input"
 barrier_open=true
 printf "set application_name='generic-first';begin;%s;\n" "$1" >&3
 # Hold the transaction until its actual contender is observed. VM load
 # cannot make the first transaction commit before the race begins.
 deadline=$((SECONDS + 90))
 while [ "$SECONDS" -lt "$deadline" ]; do
  first_backend_pid="$(sql -c "select pid from pg_stat_activity where application_name='generic-first' and datname=current_database() and state='idle in transaction'")"
  if [[ "$first_backend_pid" =~ ^[0-9]+$ ]]; then ready=true;break;fi
  if ! kill -0 "$first_pid" 2>/dev/null;then break;fi
  sleep 0.05
 done
 [ "$ready" = true ] || { echo 'First generic lifecycle transaction did not reach its barrier.' >&2;cat "$results/first";exit 1; }
 sql -c "set application_name='generic-second';$2;" 3>&- > "$results/second" 2>&1 &
 second_pid=$!
 deadline=$((SECONDS + 90))
 while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$(sql -c "select count(*) from pg_stat_activity contender where application_name='generic-second' and datname=current_database() and wait_event_type='Lock' and $first_backend_pid=any(pg_blocking_pids(contender.pid))")" = 1 ]; then blocked=true;break;fi
  if ! kill -0 "$second_pid" 2>/dev/null;then break;fi
  sleep 0.05
 done
 [ "$blocked" = true ] || { echo 'Generic lifecycle contender did not wait for the first transaction.' >&2;cat "$results/second";exit 1; }
 printf 'commit;\n\\q\n' >&3
 exec 3>&-
 barrier_open=false
 wait "$first_pid" || { cat "$results/first";exit 1; }
 first_pid=''
 wait "$second_pid" || { cat "$results/second";exit 1; }
 second_pid=''
 rm "$input"
}
issue="select generic_run_race.start(jsonb_build_object('correlation',generic_run_race.id(101)))"
race "$issue" "$issue"
rg -q '"created": true' "$results/first"
rg -q '"created": false' "$results/second"
[ "$(sql -c "select count(*) from public.agent_runs where tenant_id=generic_run_race.id(11) and correlation_id=generic_run_race.id(101)")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=generic_run_race.id(11) and correlation_id=generic_run_race.id(101) and action_type='agent.invocation.requested'")" = 1 ]
setup() {
 sql <<'SQL'
truncate generic_run_race.state;
insert into generic_run_race.state(run_id) select (generic_run_race.start()->>'run_id')::uuid;
update generic_run_race.state set receipts=generic_run_race.pair(run_id);
SQL
}
finish="select generic_run_race.finish(run_id,receipts) from generic_run_race.state"
cancel="update public.agent_runs set status='cancelled',completed_at=clock_timestamp() where id=(select run_id from generic_run_race.state) and status='running'"
setup
race "$cancel" "$finish"
rg -q terminal_conflict "$results/second"
[ "$(sql -c 'select status from public.agent_runs where id=(select run_id from generic_run_race.state)')" = cancelled ]
setup
race "$finish" "$finish"
rg -q '"replayed": true' "$results/second"
[ "$(sql -c "select count(*) from public.audit_ledger where target_ref=(select run_id::text from generic_run_race.state) and action_type='agent.invocation.settled'")" = 1 ]
setup
race "$finish" "$cancel"
[ "$(sql -c 'select status from public.agent_runs where id=(select run_id from generic_run_race.state)')" = succeeded ]
race "delete from public.tenant_users where tenant_id=generic_run_race.id(11) and user_id=generic_run_race.id(1)" 'select generic_run_race.start()'
rg -q forbidden "$results/second"
sql -c 'drop schema generic_run_race cascade' >/dev/null 2>&1
echo 'Generic lifecycle concurrency: one dispatch, one settlement, cancellation and revocation serialized.'
