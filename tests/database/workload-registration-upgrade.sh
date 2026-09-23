#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
 if int(path.name[:4]) < 48: shutil.copy2(path,Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres registration_upgrade
sql() { docker exec -i "$container" psql -X -U postgres -d registration_upgrade -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database registration_upgrade --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql -c 'create schema registration_upgrade'
python3 - <<'PY' | sql
from pathlib import Path
import re
s=Path('tests/database/workload-assessment.test.sql').read_text().split('set local role service_role;')[0]
s=s.replace('begin;\n','',1).replace('pg_temp','registration_upgrade').replace('create temporary table issued','create table issued')
s=re.sub(r'\bissued\b','registration_upgrade.issued',s)
print(s)
PY
before=$(sql -c "select md5(jsonb_agg(to_jsonb(w) order by id)::text) from public.workload_identities w")
python3 scripts/migrate-database.py --container "$container" --user postgres --database registration_upgrade > "$fixture_dir/upgrade.log"
[ "$before" = "$(sql -c "select md5(jsonb_agg(to_jsonb(w)-array['version','lifecycle_receipt','updated_at'] order by id)::text) from public.workload_identities w")" ]
sql <<'SQL'
select registration_upgrade.ok((select bool_and(version=1 and lifecycle_receipt is null) from public.workload_identities),'old identities get no fabricated approval');
select registration_upgrade.ok((select revoked_at is null from public.workload_task_delegations),'migration changes no outstanding authority');
grant usage on schema registration_upgrade to service_role;
grant execute on all functions in schema registration_upgrade to service_role;
set role service_role;
select registration_upgrade.reject('update public.workload_identities set status=''disabled''','42501');
select registration_upgrade.ok(public.manage_workload_identity(registration_upgrade.id(11),registration_upgrade.id(1),registration_upgrade.id(41),registration_upgrade.id(31),1,'parikshan','spiffe://axiom.test/parikshan','disabled')->>'version'='2','legacy binding can be disabled without rewriting');
select registration_upgrade.ok(public.manage_workload_identity(registration_upgrade.id(11),registration_upgrade.id(1),registration_upgrade.id(41),registration_upgrade.id(31),2,'parikshan','spiffe://axiom.test/parikshan','active')->>'error'='invalid_registration','noncanonical legacy identity requires separate reviewed enrollment');
select registration_upgrade.ok((select revoked_at is not null from public.workload_task_delegations),'reviewed disable permanently revokes old proof');
select registration_upgrade.ok((select count(*)=1 from public.agent_runs),'upgrade never creates an execution');
SQL
echo 'Registration upgrade: old bindings/statuses/proofs preserved until reviewed lifecycle; legacy disable is audited and irreversible for old proofs.'
