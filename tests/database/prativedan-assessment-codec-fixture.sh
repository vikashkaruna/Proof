#!/usr/bin/env bash
# CI source only: caller owns the disposable container; this script owns only
# its newly created database and protected intermediate files. Never run against
# a retained stack. No report completion or settlement receipt is synthesized.
set -euo pipefail
# Bind all CLI/subprocess calls to the isolated runner daemon.
unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
umask 077
container="${1:?owned disposable container required}"
output_dir="${2:?explicit existing empty protected output directory required}"
runtime_python="${3:-$(pwd)/services/agent-runtime/.venv/bin/python}"
[[ "$container" =~ ^axiom-prativedan-[a-f0-9]{12}$ || "$container" =~ ^axiom-db-test-[0-9]+$ ]] || { echo 'Refusing foreign container' >&2; exit 1; }
[[ "$runtime_python" = "$(pwd)/services/agent-runtime/.venv/bin/python" && -x "$runtime_python" ]] || { echo 'Refusing foreign Python environment' >&2; exit 1; }
python3 - "$output_dir" <<'PY'
import os
from pathlib import Path
import stat
import sys
p = Path(sys.argv[1])
if not p.is_absolute() or p.resolve() != p or p.is_symlink():
    raise SystemExit('Output must be an absolute directory without symlinks')
s = p.stat()
if not p.is_dir() or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700 or any(p.iterdir()):
    raise SystemExit('Output must be an owned, empty 0700 directory')
PY
[ "$(docker inspect --format '{{ index .Config.Labels "com.axiom.fixture" }}' "$container")" = database-policy-test ]
[ "$(docker inspect --format '{{ index .Config.Labels "com.axiom.fixture.project" }}' "$container")" = axiom-db-tests ]
[ "$(docker inspect --format '{{ index .Config.Labels "com.axiom.owner-worktree" }}' "$container")" = "$(pwd)" ]
database=axiom_proof_local
created=false
cleanup() {
  if [ "$created" = true ]; then
    docker exec "$container" dropdb -U postgres --if-exists "$database" >/dev/null
  fi
}
trap cleanup EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -Atq; }
# createdb refuses an existing database. Do not mark it owned until successful.
docker exec "$container" createdb -U postgres "$database"
created=true
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database "$database"
python3 - <<'PY' | sql > "$output_dir/preparation.log"
from pathlib import Path
import re
text = Path('tests/database/prativedan-assessment-drafts.test.sql').read_text()
marker = '-- P123_CONCURRENCY_FIXTURE_END: reviewed request, no claim.'
if text.count(marker) != 1:
    raise SystemExit('Reviewed fixture boundary changed')
text = text.split(marker, 1)[0]
text = text.replace('begin;', 'begin;\ncreate schema p123_fixture;\ngrant usage on schema p123_fixture to human_action_writer,agent_ledger_writer;', 1)
text = text.replace('pg_temp.', 'p123_fixture.').replace('create temporary table ', 'create table ')
for table in ('issued', 'p123_context'):
    text = re.sub(rf'\b{table}\b', 'p123_fixture.' + table, text)
print(text + '\ncommit;')
PY
sql > "$output_dir/pg-requested.json" <<'SQL'
set role human_action_writer;
with journal as (select public.read_prativedan_assessment_draft(p123_fixture.id(11),p123_fixture.id(1),human_text) j,input_text from p123_fixture.p123_context)
select jsonb_build_object('schema_version',1,'fixture_kind','disposable_postgres_assessment_v2',
 'requested_readback',j,'sql_input_projection',input_text::jsonb,'expected_binding',
 jsonb_build_object('tenant_id',j->'tenant_id','actor_id',j->'actor_id','operation_key',j->'operation_key',
  'engagement_id',j->'engagement_id','assessment_run_id',j->'assessment_run_id','source_id',j->'source_id',
  'run_id',j->'run_id','request_text',j->'request_text','source_sha256',j->'source_sha256')) from journal;
SQL
mkdir -m 700 "$output_dir/initial" "$output_dir/final"
export PYTHONPATH="$(pwd)/services/agent-runtime/src:$(pwd)/packages/offline-license-python"
"$runtime_python" services/agent-runtime/tests/prativedan_assessment_interop.py --fixture "$output_dir/pg-requested.json" --output-dir "$output_dir/initial"
python3 - "$output_dir/initial/normalized-input.txt" <<'PY' | sql > "$output_dir/pg-claim-first.json"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text(encoding='utf-8')
literal = "'" + text.replace("'", "''") + "'"
print("set standard_conforming_strings=on; set role agent_ledger_writer;")
print("select public.claim_prativedan_assessment_draft(p123_fixture.id(11),p123_fixture.id(55),(reply->>'run_id')::uuid,encode(sha256(convert_to(human_text,'UTF8')),'hex')," + literal + ") from p123_fixture.p123_context;")
PY
python3 - "$output_dir/initial/normalized-input.txt" <<'PY' | sql > "$output_dir/pg-claim-replay.json"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text(encoding='utf-8')
literal = "'" + text.replace("'", "''") + "'"
print("set standard_conforming_strings=on; set role agent_ledger_writer;")
print("select public.claim_prativedan_assessment_draft(p123_fixture.id(11),p123_fixture.id(55),(reply->>'run_id')::uuid,encode(sha256(convert_to(human_text,'UTF8')),'hex')," + literal + ") from p123_fixture.p123_context;")
PY
sql > "$output_dir/pg-ledger.json" <<'SQL'
select jsonb_agg(to_jsonb(l)||jsonb_build_object('id',l.id::text) order by l.id) from public.audit_ledger l where tenant_id=p123_fixture.id(11);
do $$begin
 if (select count(*) from public.prativedan_draft_claims)<>1
  or exists(select 1 from public.verify_ledger(p123_fixture.id(11)))
  or exists(select 1 from public.prativedan_draft_outputs) or exists(select 1 from public.prativedan_draft_reviews)
  or exists(select 1 from public.board_report_requests)
  or (select count(*) from public.audit_ledger where action_type::text='prativedan.draft.claimed')<>1
  or exists(select 1 from public.audit_ledger where action_type::text in ('prativedan.draft.settled','prativedan.draft.reviewed','report.generated'))
 then raise exception 'Interop crossed unmounted invocation boundary';end if;
end $$;
SQL
python3 - "$output_dir" <<'PY'
import json
from pathlib import Path
import sys
p = Path(sys.argv[1])
fixture = json.loads((p/'pg-requested.json').read_text())
fixture['claim_first'] = json.loads((p/'pg-claim-first.json').read_text())
fixture['claim_replay'] = json.loads((p/'pg-claim-replay.json').read_text())
fixture['actual_ledger_rows'] = json.loads((p/'pg-ledger.json').read_text())
with (p/'pg-fixture.json').open('x', encoding='utf-8') as f:
    json.dump(fixture,f,ensure_ascii=False,indent=2)
PY
"$runtime_python" services/agent-runtime/tests/prativedan_assessment_interop.py --fixture "$output_dir/pg-fixture.json" --output-dir "$output_dir/final"
echo 'Actual PostgreSQL source/request/first-claim/replay verified with pure Python renderer; no runtime completion receipts or settlement.'
