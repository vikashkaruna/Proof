#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 37: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres gap_scan_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d gap_scan_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database gap_scan_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('gap-upgrade',now(),'test','fixture',0);
insert into public.gap_scan_responses(id,session_id,library_version,report_snapshot,contact_email)
values('00000000-0000-4000-8000-000000000097',repeat('b',64),'gap-upgrade','{"legacy":true}','fixture@example.invalid');
SQL
before=$(sql -c "select md5(jsonb_agg(to_jsonb(t)-'access_token_hash' order by id)::text) from public.gap_scan_responses t")
python3 scripts/migrate-database.py --container "$container" --user postgres --database gap_scan_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(to_jsonb(t)-'access_token_hash' order by id)::text) from public.gap_scan_responses t")" ]
[ "$(sql -c "select count(*) from public.gap_scan_responses where access_token_hash=encode(sha256(convert_to(repeat('b',64),'UTF8')),'hex')")" = 1 ]
echo 'Gap-scan upgrade: report/contact contents preserved; legacy cookie ownership hashed.'
