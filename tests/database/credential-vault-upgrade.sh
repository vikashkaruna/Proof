#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 39: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres credential_vault_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d credential_vault_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database credential_vault_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values ('42420000-0000-4000-8000-000000000091','vault-upgrade','Existing');
insert into public.estates(id,tenant_id,slug,name) values ('42420000-0000-4000-8000-000000000092','42420000-0000-4000-8000-000000000091','prod','Existing estate');
insert into public.estate_systems(id,tenant_id,estate_id,name,system_kind) values ('42420000-0000-4000-8000-000000000093','42420000-0000-4000-8000-000000000091','42420000-0000-4000-8000-000000000092','Existing system','database');
insert into public.connector_descriptors(id,slug,version,transport,target_binding,manifest) values ('42420000-0000-4000-8000-000000000094','legacy-vault','1','sql','sandbox','{}');
insert into public.connectors(id,tenant_id,system_id,descriptor_id,target_binding,name,endpoint_ref,assurance,status) values ('42420000-0000-4000-8000-000000000095','42420000-0000-4000-8000-000000000091','42420000-0000-4000-8000-000000000093','42420000-0000-4000-8000-000000000094','sandbox','Legacy','old_ref','low','disabled');
insert into public.connector_credentials(tenant_id,connector_id,grant_type,key_ref,algorithm,nonce,ciphertext,wrapped_data_key)
 select '42420000-0000-4000-8000-000000000091','42420000-0000-4000-8000-000000000095','client_credentials','legacy/key','aes-256-gcm',decode(repeat('aa',12),'hex'),decode(repeat('bb',32),'hex'),decode('cc','hex') from generate_series(1,2);
SQL
before=$(sql -c 'select md5(jsonb_agg(to_jsonb(t) order by id)::text) from public.connector_credentials t')
python3 scripts/migrate-database.py --container "$container" --user postgres --database credential_vault_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(to_jsonb(t)-array['format_version','revision','descriptor_sha256','endpoint_ref','target_binding'] order by id)::text) from public.connector_credentials t")" ]
[ "$(sql -c 'select count(*) from public.connector_credentials where format_version=0 and revision=1 and descriptor_sha256 is null')" = 2 ]
echo 'Vault upgrade: duplicate historical envelopes preserved byte-for-byte; unknown formats stay unavailable to broker.'
