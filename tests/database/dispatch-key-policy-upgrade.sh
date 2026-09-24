#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'COPY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 47: shutil.copy2(path, Path(sys.argv[1])/path.name)
COPY
docker exec "$container" createdb -U postgres policy_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d policy_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database policy_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql -c 'create schema policy_upgrade'
python3 - <<'FIXTURE' | sql
from pathlib import Path
s=Path('tests/database/assessment-dispatch.test.sql').read_text().split('set local role service_role;')[0]
s=s.replace('begin;\n','',1).replace('pg_temp','policy_upgrade').replace("'synthetic-key/v1'","'arn:aws:kms:ap-south-1:123456789012:key/'||policy_upgrade.id(61)::text")
print(s)
FIXTURE
sql -c 'select policy_upgrade.enqueue(51); select policy_upgrade.enqueue(52); select public.claim_assessment_dispatch(policy_upgrade.id(11),policy_upgrade.id(52));' > "$fixture_dir/populate.log"
fingerprint() { sql -c "select md5(jsonb_agg(to_jsonb(d) order by id)::text) from public.assessment_dispatch_jobs d"; }
before=$(fingerprint)
python3 scripts/migrate-database.py --container "$container" --user postgres --database policy_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(fingerprint)" ]
sql <<'SQL'
select policy_upgrade.ok((select count(*)=0 from public.assessment_dispatch_key_policies),'migration invents no policy');
select policy_upgrade.ok(public.claim_assessment_dispatch(policy_upgrade.id(11),policy_upgrade.id(51))->>'error'='policy_required','legacy production-key delivery waits for policy');
select policy_upgrade.ok(policy_upgrade.enqueue(53)->>'error'='policy_required','old production writer cannot create unmanaged work');
select policy_upgrade.ok(public.publish_assessment_dispatch_key_policy(policy_upgrade.id(11),policy_upgrade.id(1),policy_upgrade.id(41),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||policy_upgrade.id(62)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||policy_upgrade.id(62)::text])->>'error'='policy_keys_required','bootstrap cannot omit historical key');
select policy_upgrade.ok(public.publish_assessment_dispatch_key_policy(policy_upgrade.id(11),policy_upgrade.id(1),policy_upgrade.id(41),0,'aws','arn:aws:kms:ap-south-1:123456789012:key/'||policy_upgrade.id(61)::text,array['arn:aws:kms:ap-south-1:123456789012:key/'||policy_upgrade.id(61)::text])->>'revision'='1','explicit reviewed policy adopts preserved old ciphertext');
select policy_upgrade.ok(public.claim_assessment_dispatch(policy_upgrade.id(11),policy_upgrade.id(51),1,(select fingerprint from public.assessment_dispatch_key_policies where tenant_id=policy_upgrade.id(11))) ? 'ciphertext','matching reader can claim preserved work');
select policy_upgrade.ok((select count(*)=2 from public.assessment_dispatch_jobs where claimed_at is not null),'old claim preserved, new claim delivered once');
select policy_upgrade.ok((select count(*)=2 from public.agent_runs),'upgrade never duplicates tasks');
SQL
echo 'Policy upgrade: legacy ciphertext and claims preserved; explicit reviewed policy required for production keys.'
