#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 33: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres connector_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d connector_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database connector_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-000000000091','connector-upgrade','Existing client');
insert into public.estates(id,tenant_id,slug,name) values ('00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000091','prod','Existing estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values ('00000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000092','Existing system','database');
SQL
before=$(sql -c "select md5(jsonb_agg(t order by id)::text) from public.estate_systems t")
python3 scripts/migrate-database.py --container "$container" --user postgres --database connector_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(t order by id)::text) from public.estate_systems t")" ]
for table in connector_descriptors connectors connector_credentials connector_grants connector_health_checks workload_identities mcp_tool_registry; do
  [ "$(sql -c "select count(*) from public.$table")" = 0 ]
done
echo 'Connector upgrade: existing system unchanged; seven new tables empty, no inferred connectors or grants.'
