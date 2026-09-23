#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'COPY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 46: shutil.copy2(path, Path(sys.argv[1])/path.name)
COPY
docker exec "$container" createdb -U postgres retention_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d retention_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database retention_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql -c 'create schema retention_upgrade'
sed '/-- FIXTURE_READY/,$d' tests/database/assessment-retention.test.sql | sed '/^begin;$/d;s/pg_temp/retention_upgrade/g;s/create temporary table issued/create table retention_upgrade.issued/g;s/from issued/from retention_upgrade.issued/g;s/on issued/on retention_upgrade.issued/g;/create function retention_upgrade.purge/d' | sql > "$fixture_dir/fixture.log"
sql <<'SQL'
select public.confirm_workload_assessment(retention_upgrade.id(11),(select run_id from retention_upgrade.issued));
update public.workload_assessment_packets set finalized_at=clock_timestamp()-interval '91 days';
select retention_upgrade.enqueue(52);
SQL
fingerprint() { sql -c "select md5(jsonb_agg(to_jsonb(d) order by id)::text) from (select id,run_id,key_ref,nonce,ciphertext,wrapped_key,claimed_at from public.assessment_dispatch_jobs) d"; }
before=$(fingerprint)
python3 scripts/migrate-database.py --container "$container" --user postgres --database retention_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(fingerprint)" ]
sql <<'SQL'
select retention_upgrade.ok((select count(*)=0 from public.assessment_dispatch_jobs where payload_purged_at is not null),'migration never implicitly purges');
grant usage on schema retention_upgrade to service_role;
set role service_role;
select retention_upgrade.ok(public.purge_next_assessment_dispatch_payload(90,retention_upgrade.id(11))->>'status'='purged','old confirmed job supports explicit cleanup');
select retention_upgrade.ok(public.purge_next_assessment_dispatch_payload(90,retention_upgrade.id(11))->>'status'='idle','old unresolved job retained');
reset role;
select retention_upgrade.ok((select ciphertext is not null from public.assessment_dispatch_jobs where id=retention_upgrade.id(52)),'pending payload preserved');
select retention_upgrade.ok((select count(*)=2 from public.findings),'evidence of computation retained');
SQL
echo 'Retention upgrade: existing ciphertext preserved until explicit maintenance; only confirmed eligible job purged.'
