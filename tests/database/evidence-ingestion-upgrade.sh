#!/usr/bin/env bash
# Existing evidence must survive unchanged and never gain invented assurance.
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
 if int(path.name[:4])<73: shutil.copy2(path,Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres evidence_ingestion_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d evidence_ingestion_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database evidence_ingestion_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into auth.users(id,email) values('99737777-0000-4000-8000-000000000001','evidence-upgrade@example.invalid');
insert into public.users(id,email) values('99737777-0000-4000-8000-000000000001','evidence-upgrade@example.invalid');
insert into public.tenants(id,slug,name) values('99737777-0000-4000-8000-000000000010','evidence-upgrade','Legacy evidence');
insert into public.tenant_users(tenant_id,user_id,role) values('99737777-0000-4000-8000-000000000010','99737777-0000-4000-8000-000000000001','owner');
insert into public.evidence(tenant_id,content_hash,storage_uri,byte_size,evidence_type,collected_by_agent,worm_lock_until,description)
values('99737777-0000-4000-8000-000000000010',repeat('c',64),'s3://legacy-bucket/no-version',123,'document','saakshi',now()+interval '7 years','Legacy claim is not a provider receipt');
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(e) order by id)::text) from public.evidence e')
python3 scripts/migrate-database.py --container "$container" --user postgres --database evidence_ingestion_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c 'select md5(jsonb_agg(to_jsonb(e) order by id)::text) from public.evidence e')" ]
[ "$(sql -c 'select count(*) from public.evidence_object_versions')" = 0 ]
[ "$(sql -c 'select count(*) from public.evidence_ingestions')" = 0 ]
# The legacy path remains available to existing fixtures, but cannot confer a receipt.
sql -c "set role service_role; insert into public.evidence(tenant_id,content_hash,storage_uri,evidence_type,collected_by_agent) values('99737777-0000-4000-8000-000000000010',repeat('d',64),'s3://legacy-bucket/other','log','fixture');"
[ "$(sql -c 'select count(*) from public.evidence_object_versions')" = 0 ]
python3 scripts/migrate-database.py --container "$container" --user postgres --database evidence_ingestion_upgrade_test > "$fixture_dir/reapply.log"
[ "$(sql -c 'select count(*) from public.evidence')" = 2 ]
[ "$(sql -c 'select count(*) from public.evidence_object_versions')" = 0 ]
echo 'Evidence upgrade: populated legacy rows preserved, no version/receipt fabricated, legacy fixture inserts remain unverified.'
