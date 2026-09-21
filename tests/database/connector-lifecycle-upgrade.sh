#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 38: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres connector_lifecycle_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d connector_lifecycle_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database connector_lifecycle_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values ('41410000-0000-4000-8000-000000000091','connector-upgrade','Existing');
insert into public.estates(id,tenant_id,slug,name) values ('41410000-0000-4000-8000-000000000092','41410000-0000-4000-8000-000000000091','prod','Existing estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values ('41410000-0000-4000-8000-000000000093','41410000-0000-4000-8000-000000000091','41410000-0000-4000-8000-000000000092','Existing system','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values ('41410000-0000-4000-8000-000000000094','legacy','1','sql','sandbox','{}');
insert into public.connectors(tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values ('41410000-0000-4000-8000-000000000091','41410000-0000-4000-8000-000000000093','41410000-0000-4000-8000-000000000094','sandbox','Legacy','old_ref','low','disabled');
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(t) order by id)::text) from public.connectors t')
python3 scripts/migrate-database.py --container "$container" --user postgres --database connector_lifecycle_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(to_jsonb(t)-'version'-'updated_at' order by id)::text) from public.connectors t")" ]
[ "$(sql -c 'select count(*) from public.connectors where version=1 and updated_at is not null')" = 1 ]
[ "$(sql -c 'select count(*) from public.connector_grants')" = 0 ]
echo 'Connector lifecycle upgrade: populated registrations preserved, versions initialized; no inferred grants.'
