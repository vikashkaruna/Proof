#!/usr/bin/env bash
# CI-only actual BaseAgent invocation against scoped, real disposable SQL RPCs.
# No PostgREST authentication/workload admission/deployment claim. Old pure
# rendering gate remains separate. Caller owns container; we own only new DB.
set -euo pipefail
# Bind all CLI/subprocess calls to the isolated runner daemon.
unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
umask 077
[[ "${GITHUB_ACTIONS:-}" = true && "${RUNNER_ENVIRONMENT:-}" = github-hosted ]] || { echo 'Hosted disposable fixture required' >&2; exit 1; }
container="${1:?owned disposable container required}"
output_dir="${2:?explicit existing empty protected output directory required}"
runtime_python="${3:-$(pwd)/services/agent-runtime/.venv/bin/python}"
[[ "$container" =~ ^axiom-prativedan-controller-[a-f0-9]{12}$ ]] || { echo 'Refusing foreign container' >&2; exit 1; }
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
container_id="$(docker inspect --format '{{.Id}}' "$container")"
[[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid immutable container ID' >&2; exit 1; }
container="$container_id"
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
mkdir -m 700 "$output_dir/runtime"
export PYTHONPATH="$(pwd)/services/agent-runtime/src:$(pwd)/packages/offline-license-python"
"$runtime_python" services/agent-runtime/tests/prativedan_assessment_runtime_interop.py --container-id "$container_id" --fixture "$output_dir/pg-requested.json" --output-dir "$output_dir/runtime"
# Independently query actual SQL witness; never copy the runtime envelope as proof.
python3 - "$output_dir/runtime/runtime-envelope.json" <<'PYCODE' | sql > "$output_dir/runtime/pg-runtime-witness.json"
import json
from pathlib import Path
import sys
v=json.loads(Path(sys.argv[1]).read_text())
a={k:v[k] for k in ('tenant_id','operation_key','run_id','request_sha256')}
a['started']=v['started_receipt']['id'];a['completed']=v['completed_receipt']['id']
literal="'"+json.dumps(a).replace("'","''")+"'::jsonb"
print("set standard_conforming_strings=on;set timezone='UTC';set role agent_ledger_writer;")
print("select public.read_prativedan_assessment_runtime_receipts((v->>'tenant_id')::uuid,(v->>'operation_key')::uuid,(v->>'run_id')::uuid,v->>'request_sha256',(v->>'started')::bigint,(v->>'completed')::bigint) from (select "+literal+" v)a;")
PYCODE
sql > "$output_dir/runtime/pg-runtime-ledger.json" <<'SQL'
select jsonb_agg(to_jsonb(l)||jsonb_build_object('id',l.id::text) order by l.id) from public.audit_ledger l where tenant_id=p123_fixture.id(11);
do $$begin
 if exists(select 1 from public.verify_ledger(p123_fixture.id(11)))
  or (select count(*) from public.prativedan_draft_claims)<>1
  or (select count(*) from public.audit_ledger where tenant_id=p123_fixture.id(11) and action_type::text='report.generated')<>2
  or exists(select 1 from public.prativedan_draft_outputs) or exists(select 1 from public.prativedan_draft_reviews)
  or exists(select 1 from public.board_report_requests)
 then raise exception 'Actual runtime fixture proof refused';end if;
end $$;
SQL
cp "$output_dir/pg-requested.json" "$output_dir/runtime/pg-requested.json"
pnpm exec tsx scripts/check-prativedan-assessment-controller-interoperability.ts runtime "$output_dir/runtime"
# The TS semantic guard owns response bytes (domain five), not Python or PG.
python3 - "$output_dir/runtime/settlement-arguments.json" "$output_dir/runtime/response-output.txt" <<'PYCODE' > "$output_dir/settle.sql"
import json
from pathlib import Path
import sys
args=json.loads(Path(sys.argv[1]).read_text())
expected={'t':'uuid','k':'uuid','r':'uuid','rh':'text','input_hash':'text','config_text':'text','output_text':'text','response_text':'text','started':'bigint','completed':'bigint'}
if set(args)!=set(expected) or args['response_text']!=Path(sys.argv[2]).read_text():
 raise SystemExit('Validated TS settlement handoff refused')
literal="'"+json.dumps(args,ensure_ascii=False,allow_nan=False).replace("'","''")+"'::jsonb"
print("set standard_conforming_strings=on;set timezone='UTC';set role agent_ledger_writer;")
print('select public.settle_prativedan_assessment_draft('+','.join(k+"=>((a.v->>'"+k+"')::"+typ+')' for k,typ in expected.items())+') from (select '+literal+' v)a;')
PYCODE
sql < "$output_dir/settle.sql" > "$output_dir/runtime/pg-settled.json"
sql < "$output_dir/settle.sql" > "$output_dir/runtime/pg-settle-replay.json"
sql > "$output_dir/runtime/pg-retained.json" <<'SQL'
set timezone='UTC';set role human_action_writer;
select public.read_prativedan_assessment_draft(p123_fixture.id(11),p123_fixture.id(1),human_text) from p123_fixture.p123_context;
SQL
sql > "$output_dir/runtime/pg-settled-ledger.json" <<'SQL'
select jsonb_agg(to_jsonb(l)||jsonb_build_object('id',l.id::text) order by l.id) from public.audit_ledger l where tenant_id=p123_fixture.id(11);
do $$begin
 if exists(select 1 from public.verify_ledger(p123_fixture.id(11)))
  or (select count(*) from public.prativedan_draft_outputs)<>1
  or (select count(*) from public.audit_ledger where action_type::text='prativedan.draft.settled')<>1
  or exists(select 1 from public.prativedan_draft_reviews) or exists(select 1 from public.board_report_requests)
 then raise exception 'Actual settlement/recovery proof refused';end if;
end $$;
SQL
pnpm exec tsx scripts/check-prativedan-assessment-controller-interoperability.ts settled "$output_dir/runtime"
echo 'Actual disposable SQL/BaseAgent/receipt witness/TS settlement/readback gate passed; no deployment or authentication claim.'
