#!/usr/bin/env bash
set -euo pipefail
container="$1"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
python3 - "$fixture_dir" <<'PY'
from pathlib import Path
import shutil,sys
for path in Path('infra/supabase/migrations').glob('*.sql'):
    if int(path.name[:4]) < 43: shutil.copy2(path, Path(sys.argv[1])/path.name)
PY
docker exec "$container" createdb -U postgres confirmation_upgrade_test
sql() { docker exec -i "$container" psql -X -U postgres -d confirmation_upgrade_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database confirmation_upgrade_test --migrations "$fixture_dir" > "$fixture_dir/migrate.log"
sql <<'SQL'
create function pg_temp.id(n int) returns uuid language sql immutable as $$select ('48480000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION: %',m; end if; end$$;
create function pg_temp.reject(q text,code text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then return; end if; raise; end; raise exception 'Unexpected success'; end$$;
insert into auth.users(id,email) values(pg_temp.id(1),'worker-assessment@test.invalid');
insert into public.users(id,email) values(pg_temp.id(1),'worker-assessment@test.invalid');
insert into public.tenants(id,slug,name) values(pg_temp.id(11),'worker-assessment','Worker fixture');
insert into public.tenant_users(tenant_id,user_id,role) values(pg_temp.id(11),pg_temp.id(1),'owner');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count)
 values('worker-assessment-v1',now(),'test','Synthetic fixture',2);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 select 'WA-'||n,'worker-assessment-v1','Fixture','Fixture','SEC','low','[]','[]','[]','{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":1000000}','{}','worker-assessment-v1' from generate_series(1,2) n;
insert into public.estates(id,tenant_id,name,slug) values(pg_temp.id(22),pg_temp.id(11),'Synthetic estate','synthetic');
insert into public.engagements(id,tenant_id,estate_id,library_version,title) values(pg_temp.id(21),pg_temp.id(11),pg_temp.id(22),'worker-assessment-v1','New assessment');
insert into public.workload_identities(id,tenant_id,agent_name,spiffe_id,status)
 values(pg_temp.id(31),pg_temp.id(11),'parikshan','spiffe://axiom.test/parikshan','active');
create temporary table issued as select (public.delegate_workload_task(pg_temp.id(11),pg_temp.id(1),pg_temp.id(31),'parikshan',pg_temp.id(22),pg_temp.id(21),pg_temp.id(41),repeat('a',64),repeat('b',64),array['control_library.read','findings.write'],clock_timestamp()+interval '10 minutes')->>'run_id')::uuid run_id;
grant select on issued to service_role;
create function pg_temp.start_tool(proof text default repeat('b',64),input_hash text default repeat('a',64),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.start_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),proof,input_hash,deadline)$$;
create function pg_temp.result() returns jsonb language sql immutable as $$select '{"library_version":"worker-assessment-v1","posture_score":50,"estimated_exposure_inr":10000000,"findings":[{"control_id":"WA-1","score":0,"risk_points":10,"rationale":"No answers comply"},{"control_id":"WA-2","score":100,"risk_points":0,"rationale":"All answers comply"}]}'::jsonb$$;
create function pg_temp.finish_tool(result jsonb default pg_temp.result(),deadline timestamptz default clock_timestamp()+interval '5 minutes') returns jsonb language sql as $$
 select public.complete_workload_assessment(pg_temp.id(11),(select run_id from issued),pg_temp.id(31),repeat('b',64),(select library_digest from public.workload_assessment_packets where run_id=(select run_id from issued)),result,deadline)$$;
select pg_temp.start_tool();
select pg_temp.finish_tool();

SQL

fingerprint() { sql -c "select md5((select jsonb_agg(to_jsonb(e) order by id)::text from public.engagements e)||(select jsonb_agg(to_jsonb(f) order by id)::text from public.findings f))"; }
before=$(fingerprint)
python3 scripts/migrate-database.py --container "$container" --user postgres --database confirmation_upgrade_test > "$fixture_dir/upgrade.log"
[ "$before" = "$(fingerprint)" ]
[ "$(sql -c 'select count(*) from public.workload_assessment_packets where finalized_receipt is null')" = 1 ]
[ "$(sql -c "set role service_role; select public.confirm_workload_assessment(tenant_id,run_id)->>'status' from public.workload_assessment_packets")" = succeeded ]
echo 'Confirmation upgrade: populated assessment result preserved and recoverable without worker redispatch.'
