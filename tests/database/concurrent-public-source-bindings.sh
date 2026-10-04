#!/usr/bin/env bash
# Only the disposable migration-test container; barriers observe real blockers.
set -euo pipefail
container="${1:?test container required}"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
python3 - <<'PY' | sql
from pathlib import Path
s=Path('tests/database/public-source-bindings.test.sql').read_text()
s=s[s.index('create function pg_temp.id'):s.index('-- Privileges:')]
print('create schema public_source_race;')
print(s.replace('pg_temp.','public_source_race.').replace('99100500-','99101500-').replace('public-source-', 'source-race-'))
print('grant usage on schema public_source_race to human_action_writer;')
PY
race() { race_run "$1" "$2" "$result_dir/first" "$result_dir/second"; }
bind="select public_source_race.bind()"
race "$bind" "$bind"
grep -q '"created": true' "$result_dir/first"
grep -q '"replayed": true' "$result_dir/second"
[ "$(sql -c "select count(*) from public.public_source_bindings where tenant_id=public_source_race.id(11)")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=public_source_race.id(11) and action_type='public_source.bound'")" = 1 ]
# New context/correlation prevents existing snapshot replay from hiding a race.
race "delete from public.tenant_users where tenant_id=public_source_race.id(11) and user_id=public_source_race.id(2)" "select public_source_race.bind(jsonb_build_object('actor',public_source_race.id(2),'engagement',public_source_race.id(33),'correlation',public_source_race.id(102)))"
grep -q forbidden "$result_dir/second"
race "update public.users set is_axiom_internal=false where id=public_source_race.id(4)" "select public_source_race.bind(jsonb_build_object('actor',public_source_race.id(4),'engagement',public_source_race.id(33),'correlation',public_source_race.id(102)))"
grep -q forbidden "$result_dir/second"
# Binding first keeps authority/context stable until its durable human receipt.
next_bind="select public_source_race.bind(jsonb_build_object('engagement',public_source_race.id(33),'correlation',public_source_race.id(102)))"
race "$next_bind" "update public.tenant_users set role='viewer' where tenant_id=public_source_race.id(11) and user_id=public_source_race.id(1)"
grep -q '"created": true' "$result_dir/first"
[ "$(sql -c "select count(*) from public.public_source_bindings where tenant_id=public_source_race.id(11)")" = 2 ]
[ "$(sql -c "select public_source_race.bind()->>'error'")" = forbidden ]
# Preview is also authority locked and will not read through a flag revocation.
sql -c "update public.users set is_axiom_internal=true where id=public_source_race.id(4)"
race "update public.users set is_axiom_internal=false where id=public_source_race.id(4)" "select public_source_race.preview(jsonb_build_object('actor',public_source_race.id(4)))"
grep -q forbidden "$result_dir/second"
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id=public_source_race.id(11) and action_type='public_source.bound'")" = 2 ]
sql -c 'drop schema public_source_race cascade' >/dev/null 2>&1
echo 'Public source binding concurrency: one immutable snapshot/receipt; membership, internal flags and exact replay serialize.'
