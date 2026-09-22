#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 45: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres scheduling_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d scheduling_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database scheduling_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql -c 'create schema scheduling_upgrade'
sed '/set local role service_role/,$d' tests/database/assessment-dispatch.test.sql | sed '/^begin;$/d;s/pg_temp/scheduling_upgrade/g' | sql
sql <<'SQL'
do $$begin
 perform scheduling_upgrade.enqueue(51);
 perform scheduling_upgrade.enqueue(52);
 perform scheduling_upgrade.enqueue(53);
 perform public.claim_assessment_dispatch(scheduling_upgrade.id(11),scheduling_upgrade.id(52));
end$$;
update public.workload_task_delegations set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where run_id=(select run_id from public.assessment_dispatch_jobs where id=scheduling_upgrade.id(53));
SQL
fingerprint() { sql -c "select md5(jsonb_agg(jsonb_build_object('id',id,'run_id',run_id,'tenant_id',tenant_id,'input_hash',input_hash,'key_ref',key_ref,'nonce',nonce,'ciphertext',ciphertext,'wrapped_key',wrapped_key,'claimed_at',claimed_at) order by id)::text) from public.assessment_dispatch_jobs"; }
before=$(fingerprint)
python3 scripts/migrate-database.py --container "$container" --user postgres --database scheduling_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(fingerprint)" ]
[ "$(sql -c "select count(*) from public.assessment_dispatch_jobs where scheduling_status='pending' and scheduling_attempts=0 and scheduling_receipt is null")" = 3 ]
sql <<'SQL'
create temporary table reserved as select public.reserve_assessment_schedules('default',scheduling_upgrade.id(11),3) value;
select scheduling_upgrade.ok((select jsonb_array_length(value->'jobs')=3 from reserved),'all existing jobs retain a recovery path');
select scheduling_upgrade.ok((select count(*)=1 from reserved,jsonb_array_elements(value->'jobs') j where j->'startBefore'<>'null'::jsonb),'only still-authorized unclaimed work permits a first submission');
select scheduling_upgrade.ok((select count(*)=1 from public.assessment_dispatch_jobs where claimed_at is not null),'no claim was reset');
select scheduling_upgrade.ok((select count(*)=3 from public.agent_runs),'no migration or reservation invented a run');
select scheduling_upgrade.ok((select count(*)=0 from public.audit_ledger where action_type='workload.dispatch_scheduled'),'no fabricated submission acknowledgement');
SQL
echo 'Scheduling upgrade: live, claimed and expired outbox jobs preserved; no payload/authority/history was invented.'
