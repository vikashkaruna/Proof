#!/usr/bin/env bash
# A populated 0069/0071 installation cannot manufacture historic notice bytes.
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil, sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 72:
        shutil.copy2(path, Path(sys.argv[1]) / path.name)
PY
docker exec "$container" createdb -U postgres consent_notice_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d consent_notice_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database consent_notice_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into auth.users(id,email) values('99720000-0000-4000-8000-000000000001','upgrade-owner@example.invalid');
insert into public.users(id,email) values('99720000-0000-4000-8000-000000000001','upgrade-owner@example.invalid');
insert into public.tenants(id,slug,name) values('99720000-0000-4000-8000-000000000010','notice-upgrade','Existing');
insert into public.tenant_users(tenant_id,user_id,role) values('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000001','owner');
insert into public.consent_purposes(id,tenant_id,purpose_key,name_en,lawful_basis,notice_version,notice_en,created_by)
values('99720000-0000-4000-8000-000000000030','99720000-0000-4000-8000-000000000010','legacy','Existing purpose','consent',2,'Only known current text','99720000-0000-4000-8000-000000000001');
insert into public.consent_records(tenant_id,purpose_id,principal_type,principal_ref,notice_version,language,channel,granted_by,correlation_id)
select '99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000030','cookie_id','legacy-cookie-'||v,v,'en','cookie','99720000-0000-4000-8000-000000000001',gen_random_uuid()
from generate_series(1,2) v;
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(t) order by id)::text) from public.consent_records t')
python3 scripts/migrate-database.py --container "$container" --user postgres --database consent_notice_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(to_jsonb(t)-'notice_snapshot_sha256' order by id)::text) from public.consent_records t")" ]
[ "$(sql -c 'select count(*) from public.consent_notice_versions')" = 1 ]
[ "$(sql -c "select count(*) from public.consent_notice_versions where notice_version=2 and notice_en='Only known current text' and notice_hi is null and provenance='legacy_current'")" = 1 ]
[ "$(sql -c 'select count(*) from public.consent_records where notice_snapshot_sha256 is null')" = 2 ]
[ "$(sql -c "select public.record_consent('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000030',2,'cookie_id','new-cookie','hi','cookie',null,'99720000-0000-4000-8000-000000000001',gen_random_uuid())->>'error'")" = missing_notice ]
[ "$(sql -c "select public.record_consent('99720000-0000-4000-8000-000000000010','99720000-0000-4000-8000-000000000030',2,'cookie_id','new-cookie','en','cookie',null,'99720000-0000-4000-8000-000000000001',gen_random_uuid())->>'status'")" = granted ]
[ "$(sql -c 'select count(*) from public.consent_records where notice_snapshot_sha256 is not null')" = 1 ]
# A second migration pass must not invent a second backfill or touch captures.
python3 scripts/migrate-database.py --container "$container" --user postgres --database consent_notice_upgrade_test > "$fixture_dir/reapply.log"
[ "$(sql -c 'select count(*) from public.consent_notice_versions')" = 1 ]
echo 'Consent notice upgrade: existing captures preserved; only known current notice backfilled; no invented historical notice or translation.'
