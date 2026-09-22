#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 42: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres assessment_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d assessment_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database assessment_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
insert into public.tenants(id,slug,name) values ('53530000-0000-4000-8000-000000000001','assessment-upgrade','Existing');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values('assessment-upgrade',now(),'test','Historical fixture',1);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('UP-1','assessment-upgrade','Historical','Historical','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','assessment-upgrade');
insert into public.engagements(id,tenant_id,library_version,title,status,posture_score,estimated_exposure_inr)
 values('53530000-0000-4000-8000-000000000002','53530000-0000-4000-8000-000000000001','assessment-upgrade','Historical assessment','review',0,10000000);
insert into public.findings(tenant_id,engagement_id,control_id,library_version,score,risk_points,rationale)
 values('53530000-0000-4000-8000-000000000001','53530000-0000-4000-8000-000000000002','UP-1','assessment-upgrade',0,10,'Preserve historical finding');
SQL
fingerprint() { sql -c "select md5((select jsonb_agg(to_jsonb(e) order by id)::text from public.engagements e)||(select jsonb_agg(to_jsonb(f) order by id)::text from public.findings f))"; }
before=$(fingerprint)
python3 scripts/migrate-database.py --container "$container" --user postgres --database assessment_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(fingerprint)" ]
[ "$(sql -c 'select count(*) from public.workload_assessment_packets')" = 0 ]
echo 'Assessment upgrade: existing findings/scores/status preserved; no inferred task snapshot or write authority.'
