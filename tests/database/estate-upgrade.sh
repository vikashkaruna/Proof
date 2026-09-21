#!/usr/bin/env bash
# Apply 0029 to an actual pre-estate database containing an old engagement.
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 29: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres estate_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d estate_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database estate_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values ('00000000-0000-4000-8000-000000000011','upgrade-estate','Existing client');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values ('upgrade-estate',now(),'test','test',0);
insert into public.engagements(id,tenant_id,library_version,title,status) values
 ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000011','upgrade-estate','Existing assessment','intake');
SQL
python3 scripts/migrate-database.py --container "$container" --user postgres --database estate_upgrade_test > "$fixture_dir/upgrade.log"
[ "$(sql -c "select count(*) from public.engagements where id='00000000-0000-4000-8000-000000000021' and title='Existing assessment' and estate_id is null and status='intake'")" = 1 ]
[ "$(sql -c 'select count(*) from public.estates')" = 0 ]
echo 'Estate upgrade: existing assessment retained and explicitly unassigned; no invented estates.'
