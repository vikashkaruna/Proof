#!/usr/bin/env bash
# Quota and rate-limit races across real PostgreSQL connections.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -q <<'SQL'
insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000062','quota-race@test.invalid');
insert into public.users(id,email) values('00000000-0000-0000-0000-000000000062','quota-race@test.invalid');
insert into public.onboarding_entitlements(user_id,max_owned_tenants,allowed_tiers,granted_by,grant_reason,valid_until)
 values('00000000-0000-0000-0000-000000000062',1,array['growth']::public.tenant_tier[],'00000000-0000-0000-0000-000000000062','Race fixture',now()+interval '1 day');
insert into public.control_libraries(version,published_at,published_by,change_log,control_count,is_current)
 values('quota-race',now(),'test','fixture',1,true);
insert into public.controls(id,library_version,title,obligation,domain,severity,citations,evidence_required,assessment_questions,scoring,remediation_patterns,introduced_in_version)
 values('TEST','quota-race','Test','Test','GOV','low','[]','[]','[]','{}','{}','quota-race');
SQL
pids=()
for worker in $(seq 1 8); do
  docker exec "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq -c \
    "set role service_role; select coalesce(public.onboard_organization('00000000-0000-0000-0000-000000000062',gen_random_uuid()::text,'Concurrent client','growth',false,false,false,null,null,'[]','quota-race',gen_random_uuid())->>'error','created'); select public.take_rate_limit('concurrent-onboarding','test-subject',3,3600)->>'allowed';" > "$result_dir/$worker" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
python3 - "$result_dir" <<'PY'
from collections import Counter
from pathlib import Path
import sys
results = [p.read_text().splitlines() for p in Path(sys.argv[1]).iterdir()]
quota = Counter(r[0] for r in results)
rate = Counter(r[1] for r in results)
assert quota == {'created': 1, 'tenant_quota_exceeded': 7}, quota
assert rate == {'true': 3, 'false': 5}, rate
print('Concurrent onboarding: one organization, seven quota refusals; rate limit admits exactly three.')
PY
