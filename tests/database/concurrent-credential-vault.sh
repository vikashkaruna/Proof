#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql < tests/database/credential-vault-race-fixture.sql
sql -c 'grant usage on schema vault_race to human_action_writer;'
race() {
  race_run "set local role human_action_writer; select vault_race.manage('$1',1)" "set role human_action_writer; select vault_race.manage('$2',1)" "$result_dir/first" "$result_dir/second"
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
