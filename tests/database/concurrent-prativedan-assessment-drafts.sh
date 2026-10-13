#!/usr/bin/env bash
# Parent registration required. Executes ONLY inside the database-policy runner's
# owned disposable container, in a NEW isolated database removed on every exit.
set -euo pipefail
container="${1:?owned policy-test container required}"
case "$container" in axiom-db-test-[0-9]*) ;; *) echo 'Refusing foreign container' >&2; exit 1;; esac
[ "$(docker inspect --format '{{ index .Config.Labels "com.axiom.fixture" }}' "$container")" = database-policy-test ]
[ "$(docker inspect --format '{{ index .Config.Labels "com.axiom.fixture.project" }}' "$container")" = axiom-db-tests ]
[ "$(docker inspect --format '{{ index .Config.Labels "com.axiom.owner-worktree" }}' "$container")" = "$(pwd)" ]
database="axiom_prativedan123_$$"
result_dir=$(mktemp -d "${TMPDIR:-/tmp}/axiom-prativedan123.XXXXXX")
chmod 700 "$result_dir"
pids=()
created=false
cleanup() {
  for pid in "${pids[@]:-}"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
  if [ "$created" = true ]; then
    docker exec "$container" dropdb -U postgres --if-exists "$database" >/dev/null
  fi
  rm -rf "$result_dir"
}
trap cleanup EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -Atq; }
docker exec "$container" createdb -U postgres "$database"
created=true
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database "$database"
# Reuse the source test's real assessment preparation and reviewed request.
# This dedicated database permits committed fixtures visible across sessions;
# no fixtures are written into the parent test database or retained databases.
python3 - <<'PY' | sql
from pathlib import Path
import re
text = Path('tests/database/prativedan-assessment-drafts.test.sql').read_text()
marker = "-- P123_CONCURRENCY_FIXTURE_END: reviewed request, no claim."
if text.count(marker) != 1:
    raise SystemExit('Source fixture boundary changed; review concurrency fixture')
text = text.split(marker, 1)[0]
text = text.replace('begin;', 'begin;\ncreate schema p123_fixture;\ngrant usage on schema p123_fixture to human_action_writer,agent_ledger_writer;', 1)
text = text.replace('pg_temp.', 'p123_fixture.')
text = text.replace('create temporary table ', 'create table ')
for table in ('issued', 'p123_context'):
    text = re.sub(rf'\b{table}\b', 'p123_fixture.' + table, text)
print(text + '\ncommit;')
PY
for worker in $(seq 1 8); do
  sql > "$result_dir/$worker.json" <<'SQL' &
set role agent_ledger_writer;
select public.claim_prativedan_assessment_draft(p123_fixture.id(11),p123_fixture.id(55),(reply->>'run_id')::uuid,
 encode(sha256(convert_to(human_text,'UTF8')),'hex'),input_text) from p123_fixture.p123_context;
SQL
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
pids=()
python3 - "$result_dir" <<'PY'
import json
from pathlib import Path
import sys
items = [json.loads(Path(sys.argv[1], f'{n}.json').read_text()) for n in range(1, 9)]
if sum(item.get('claimed') is True for item in items) != 1:
    raise SystemExit('Exclusive one-shot claim count invalid')
if sum(item.get('claimed') is False and item.get('invocation_uncertain') is True for item in items) != 7:
    raise SystemExit('Claim replay incorrectly authorizes redispatch')
proof = items[0]['readback']
if any(item['readback'] != proof for item in items):
    raise SystemExit('Concurrent losers did not recover original exact proof')
print('Prativedan: one claim owner, seven exact uncertain readbacks, no redispatch.')
PY
sql <<'SQL'
do $$begin
 if (select count(*) from public.prativedan_draft_claims)<>1
  or (select count(*) from public.audit_ledger where action_type::text='prativedan.draft.claimed')<>1
  or exists(select 1 from public.prativedan_draft_outputs)
  or exists(select 1 from public.board_report_requests)
 then raise exception 'Concurrency wrote duplicate or unauthorized workflow';end if;
end $$;
SQL
