#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/credential-vault-race-fixture.sql
sql -c 'grant usage on schema vault_race to service_role;'
race() {
  sql -c "set application_name='vault-first'; begin; set local role service_role; select vault_race.manage('$1',1); select pg_sleep(3); commit;" > "$result_dir/first" 2>&1 &
  first_pid=$!
  ready=false
  for attempt in $(seq 1 50); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='vault-first' and wait_event='PgSleep'")" = 1 ]; then ready=true; break; fi
    sleep 0.05
  done
  [ "$ready" = true ] || { cat "$result_dir/first"; exit 1; }
  sql -c "set application_name='vault-second'; set role service_role; select vault_race.manage('$2',1);" > "$result_dir/second" 2>&1 &
  second_pid=$!
  blocked=false
  for attempt in $(seq 1 30); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='vault-second' and wait_event_type='Lock'")" = 1 ]; then blocked=true; break; fi
    sleep 0.05
  done
  [ "$blocked" = true ] || { cat "$result_dir/second"; exit 1; }
  wait "$first_pid"; wait "$second_pid"
  grep -q version_conflict "$result_dir/second"
}
race revoke rotate
[ "$(sql -c 'select revoked_at is not null and revision=2 from public.connector_credentials where id=vault_race.id(7)')" = t ]
# Reset only the disposable fixture to cover the inverse ordering.
sql -c 'update public.connector_credentials set revoked_at=null,revision=1 where id=vault_race.id(7);'
race rotate revoke
[ "$(sql -c 'select revoked_at is null and revision=2 from public.connector_credentials where id=vault_race.id(7)')" = t ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=vault_race.id(2) and action_type='connector.credential_changed'")" = 3 ]
sql -c 'drop schema vault_race cascade;' >/dev/null
echo 'Concurrent credential rotation/revocation: both orderings serialize; stale writers cannot resurrect or replace credentials.'
