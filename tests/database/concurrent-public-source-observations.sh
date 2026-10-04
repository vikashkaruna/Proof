#!/usr/bin/env bash
# An owned disposable migration-test DB only; barriers observe real blockers.
set -euo pipefail
container="${1:?test container required}"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
python3 - <<'PY' | sql
from pathlib import Path
s=Path('tests/database/public-source-observations.test.sql').read_text()
s=s[s.index('create function pg_temp.id'):s.index('-- Every role')]
s=s.replace('pg_temp.', 'source_observation_race.').replace('99100600-', '99101600-').replace('source-observation-', 'observation-race-')
s=s.replace('create temporary table source_fixture', 'create table source_observation_race.source_fixture')
s=s.replace('on source_fixture ', 'on source_observation_race.source_fixture ').replace('into source_fixture ', 'into source_observation_race.source_fixture ').replace('from source_fixture ', 'from source_observation_race.source_fixture ')
print('create schema source_observation_race;')
print('grant usage on schema source_observation_race to human_action_writer,agent_ledger_writer,service_role;')
print(s)
print("create function source_observation_race.run() returns uuid language sql as $$select (v#>>'{}')::uuid from source_observation_race.source_fixture where k='run'$$;")
print("create function source_observation_race.output() returns jsonb language sql as $$select v from source_observation_race.source_fixture where k='output'$$;")
print("insert into source_observation_race.source_fixture values('run',to_jsonb(source_observation_race.start()));")
print("select source_observation_race.dispatch(source_observation_race.run());")
PY
race() { race_run "$1" "$2" "$result_dir/first" "$result_dir/second"; }
claim='select source_observation_race.claim(source_observation_race.run())'
race "$claim" "$claim"
grep -q '"claimed": true' "$result_dir/first"
grep -q '"claimed": false' "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_source_dispatch_claims where tenant_id=source_observation_race.id(11)')" = 1 ]
# Unknown outcomes do not clear/reclaim a claimed dispatch.
[ "$(sql -c "select source_observation_race.claim(source_observation_race.run())->>'claimed'")" = false ]
# Complete a real synthetic producer pair; concurrent artifact replays persist
# one immutable observation bound to that one request/claim/completion.
sql -c "insert into source_observation_race.source_fixture values('output',source_observation_race.expected(source_observation_race.load()->'input','drishti'));select source_observation_race.complete(source_observation_race.run(),source_observation_race.output());"
observe='select source_observation_race.observe(source_observation_race.run(),source_observation_race.output())'
race "$observe" "$observe"
grep -q '"created": true' "$result_dir/first"
grep -q '"replayed": true' "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_source_observations where tenant_id=source_observation_race.id(11)')" = 1 ]
# Register fresh independent running requests before racing current authority.
sql -c "insert into source_observation_race.source_fixture values('revocation_run',to_jsonb(source_observation_race.start()));select source_observation_race.dispatch((select (v#>>'{}')::uuid from source_observation_race.source_fixture where k='revocation_run'));"
revocation_claim="select source_observation_race.claim((select (v#>>'{}')::uuid from source_observation_race.source_fixture where k='revocation_run'))"
race 'delete from public.tenant_users where tenant_id=source_observation_race.id(11) and user_id=source_observation_race.id(1)' "$revocation_claim"
grep -q forbidden "$result_dir/second"
[ "$(sql -c 'select count(*) from public.public_source_dispatch_claims where tenant_id=source_observation_race.id(11)')" = 1 ]
sql -c "insert into public.tenant_users(tenant_id,user_id,role) values(source_observation_race.id(11),source_observation_race.id(1),'owner');"
race "$revocation_claim" "update public.engagements set status='cancelled' where id=source_observation_race.id(31)"
grep -q '"claimed": true' "$result_dir/first"
[ "$(sql -c "select source_observation_race.runtime((select (v#>>'{}')::uuid from source_observation_race.source_fixture where k='revocation_run'))->>'error'")" = context_refused ]
[ "$(sql -c 'select count(*) from public.public_source_dispatch_claims where tenant_id=source_observation_race.id(11)')" = 2 ]
sql -c 'drop schema source_observation_race cascade' >/dev/null 2>&1
echo 'Public source observations concurrency: one immutable runtime claim and observation; replay and live authority serialize.'
