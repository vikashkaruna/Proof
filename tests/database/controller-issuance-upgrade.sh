#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
 if int(path.name[:4]) < 50: shutil.copy2(path,Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres issuer_upgrade
sql() { docker exec -i "$container" psql -X -U postgres -d issuer_upgrade -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database issuer_upgrade --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values('74760000-0000-4000-8000-000000000001','issuer-upgrade','Issuer upgrade');
insert into controller_security.credentials(id,tenant_id,expires_at,revoked_at) values
 ('74760000-0000-4000-8000-000000000010','74760000-0000-4000-8000-000000000001',clock_timestamp()+interval '1 hour',null),
 ('74760000-0000-4000-8000-000000000011','74760000-0000-4000-8000-000000000001',clock_timestamp()+interval '1 hour',clock_timestamp());
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(c) order by id)::text) from controller_security.credentials c')
python3 scripts/migrate-database.py --container "$container" --user postgres --database issuer_upgrade > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c 'select md5(jsonb_agg(to_jsonb(c) order by id)::text) from controller_security.credentials c')" ]
[ "$(sql -c 'select count(*) from controller_security.issuances')" = 0 ]
[ "$(sql -c 'select count(*) from controller_security.revocations')" = 0 ]
[ "$(sql -c "select count(*) from pg_auth_members where member='axiom_controller_issuer'::regrole or (roleid='axiom_controller_issuer'::regrole and (member<>'postgres'::regrole or not admin_option or inherit_option or set_option))")" = 0 ]
# Run actual new issuance and privilege assertions on an upgraded database too.
docker exec -i "$container" psql -X -U supabase_admin -d issuer_upgrade -v ON_ERROR_STOP=1 -q < tests/database/controller-credential-issuance.test.sql > "$fixture_dir/assertions.log"
echo 'Issuer upgrade: legacy active/revoked records unchanged, no fabricated reviews or usable runtime issuer membership, new lifecycle and privilege checks pass.'
