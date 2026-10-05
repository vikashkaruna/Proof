#!/usr/bin/env bash
# Owned disposable test DB only; read locks are observed through real barriers.
set -euo pipefail
container="${1:?test container required}"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
python3 - <<'PY' | sql
from pathlib import Path
s=Path('tests/database/public-source-reads.test.sql').read_text()
s=s[s.index('create function pg_temp.id'):s.index('-- Every new RPC')]
s=s.replace('pg_temp.','source_read_race.').replace('99100700-','99101700-').replace('source-read-','source-read-race-')
s=s.replace('create temporary table source_fixture','create table source_read_race.source_fixture')
s=s.replace('on source_fixture ','on source_read_race.source_fixture ').replace('into source_fixture ','into source_read_race.source_fixture ').replace('from source_fixture ','from source_read_race.source_fixture ')
print('create schema source_read_race;')
print('grant usage on schema source_read_race to human_action_writer,agent_ledger_writer,service_role;')
print(s)
PY
race() { race_run "$1" "$2" "$result_dir/first" "$result_dir/second"; }
race 'select source_read_race.choices()' 'delete from public.tenant_users where tenant_id=source_read_race.id(11) and user_id=source_read_race.id(3)'
grep -q '"data":' "$result_dir/first"
[ "$(sql -c "select source_read_race.choices()->>'error'")" = forbidden ]
sql -c "insert into public.tenant_users(tenant_id,user_id,role) values(source_read_race.id(11),source_read_race.id(3),'viewer');"
race "update public.engagements set status='cancelled' where id=source_read_race.id(31)" 'select source_read_race.history()'
grep -q context_refused "$result_dir/second"
sql -c "update public.engagements set status='intake' where id=source_read_race.id(31);"
race 'select source_read_race.history()' "update public.engagements set status='cancelled' where id=source_read_race.id(31)"
grep -q '"data":' "$result_dir/first"
race 'update public.users set is_axiom_internal=false where id=source_read_race.id(4)' "select source_read_race.choices(jsonb_build_object('actor',source_read_race.id(4)))"
grep -q forbidden "$result_dir/second"
# None of these reads appended a runtime claim or observation or human event.
[ "$(sql -c 'select count(*) from public.public_source_dispatch_claims where tenant_id=source_read_race.id(11)')" = 0 ]
[ "$(sql -c 'select count(*) from public.public_source_observations where tenant_id=source_read_race.id(11)')" = 0 ]
[ "$(sql -c 'select count(*) from public.audit_ledger where tenant_id=source_read_race.id(11)')" = 1 ]
sql -c 'drop schema source_read_race cascade' >/dev/null 2>&1
echo 'Public source read concurrency: membership, cancellation and internal flags serialize; reads create no work or ledger events.'
