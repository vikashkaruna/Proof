#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 41: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres workload_task_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d workload_task_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database workload_task_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values ('49490000-0000-4000-8000-000000000001','task-upgrade','Existing');
insert into public.agent_runs(tenant_id,agent,correlation_id,status,input_redacted_hash,metadata)
 values('49490000-0000-4000-8000-000000000001','drishti',gen_random_uuid(),'running',repeat('b',64),'{"legacy":"preserve"}');
insert into public.workload_identities(tenant_id,agent_name,spiffe_id)
 values('49490000-0000-4000-8000-000000000001','drishti','spiffe://test/legacy/drishti');
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(t) order by id)::text) from public.agent_runs t')
python3 scripts/migrate-database.py --container "$container" --user postgres --database workload_task_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c 'select md5(jsonb_agg(to_jsonb(t) order by id)::text) from public.agent_runs t')" ]
[ "$(sql -c 'select count(*) from public.workload_task_delegations')" = 0 ]
[ "$(sql -c "select public.read_workload_task(r.tenant_id,r.id,w.id,r.agent,repeat('a',64),'connector.read') is null from public.agent_runs r join public.workload_identities w on w.tenant_id=r.tenant_id")" = t ]
echo 'Task upgrade: historical runs unchanged; no inferred delegation or legacy connector authority.'
