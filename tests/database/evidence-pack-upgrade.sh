#!/usr/bin/env bash
# Historical published reports remain historical, not newly verified archives.
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
 if int(path.name[:4])<74: shutil.copy2(path,Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres evidence_pack_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d evidence_pack_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database evidence_pack_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into auth.users(id,email) values('99747777-0000-4000-8000-000000000001','report-upgrade@example.invalid');
insert into public.users(id,email,is_axiom_internal) values('99747777-0000-4000-8000-000000000001','report-upgrade@example.invalid',true);
insert into public.tenants(id,slug,name) values('99747777-0000-4000-8000-000000000010','report-upgrade','Historical reports');
insert into public.tenant_users(tenant_id,user_id,role) values('99747777-0000-4000-8000-000000000010','99747777-0000-4000-8000-000000000001','founder');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('test-report-upgrade',now(),'fixture','historic',0);
-- This is the actual pre-0074 trusted service write path, including its old weakness.
set role service_role;
insert into public.reports(id,tenant_id,kind,title,storage_uri,content,library_version,generated_by_agent,status)
values('99747777-0000-4000-8000-000000000030','99747777-0000-4000-8000-000000000010','board','Legacy published claim','s3://legacy/no-version','{"legacy":true}','test-report-upgrade','legacy-fixture','published'),
 ('99747777-0000-4000-8000-000000000031','99747777-0000-4000-8000-000000000010','auditor','Legacy approved claim','s3://legacy/approved','{"legacy":true}','test-report-upgrade','legacy-fixture','approved');
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(r) order by id)::text) from public.reports r')
python3 scripts/migrate-database.py --container "$container" --user postgres --database evidence_pack_upgrade_test > "$fixture_dir/upgrade.log"
after=$(sql -c "select md5(jsonb_agg(to_jsonb(r)-array['operation_key','created_by','content_text','content_sha256','reviewed_content_hash','released_by','released_archive_hash'] order by id)::text) from public.reports r")
[ "$before" = "$after" ]
[ "$(sql -c 'select count(*) from public.evidence_packs')" = 0 ]
[ "$(sql -c 'select count(*) from public.report_reviews')" = 0 ]
[ "$(sql -c 'select count(*) from public.evidence_pack_archives')" = 0 ]
[ "$(sql -c 'select count(*) from public.reports where content_text is not null or reviewed_content_hash is not null or released_archive_hash is not null')" = 0 ]
[ "$(sql -c "select public.release_report('99747777-0000-4000-8000-000000000010','99747777-0000-4000-8000-000000000031','99747777-0000-4000-8000-000000000001',repeat('a',64),null,gen_random_uuid())->>'error'")" = legacy_report_requires_revision ]
[ "$(sql -c "select has_table_privilege('service_role','public.reports','INSERT')")" = f ]
[ "$(sql -c "select has_table_privilege('service_role','public.reports','TRUNCATE')")" = f ]
python3 scripts/migrate-database.py --container "$container" --user postgres --database evidence_pack_upgrade_test > "$fixture_dir/reapply.log"
[ "$(sql -c 'select count(*) from public.reports')" = 2 ]
echo 'Report upgrade: old rows unchanged, no invented review/archive proof, unsafe direct insert closed, old approved outputs require a new reviewed revision.'
