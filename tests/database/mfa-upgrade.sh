#!/usr/bin/env bash
# A populated 0031 database keeps credentials unchanged when 0032 is applied.
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 32: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres mfa_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d mfa_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database mfa_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000081','upgrade-mfa@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-000000000081','upgrade-mfa@test.invalid');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-4000-8000-000000000082','00000000-0000-4000-8000-000000000081','totp','active','sealed-old'),
 ('00000000-0000-4000-8000-000000000083','00000000-0000-4000-8000-000000000081','totp','pending','sealed-new');
insert into public.user_mfa_factors(user_id,factor_type,status,code_hash) values
 ('00000000-0000-4000-8000-000000000081','recovery_code','active','old-hash');
SQL
before=$(sql -c "select md5(jsonb_agg(t order by id)::text) from public.user_mfa_factors t")
python3 scripts/migrate-database.py --container "$container" --user postgres --database mfa_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(t order by id)::text) from public.user_mfa_factors t")" ]
[ "$(sql -c "select has_function_privilege('service_role','public.activate_totp_factor(uuid,uuid,bigint)','execute')")" = f ]
[ "$(sql -c "select has_function_privilege('service_role','public.finalize_totp_enrolment(uuid,uuid,bigint,text[])','execute')")" = t ]
echo 'MFA upgrade: existing active/pending factors and recovery rows preserved; BFF must use atomic completion.'
