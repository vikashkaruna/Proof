#!/usr/bin/env bash
# Hold the first claim uncommitted while a different token competes for the
# same actions. A serial-only test cannot expose this MVCC race.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
source tests/database/lib/concurrency-barrier.sh
sql < tests/database/execution-fixture.sql
sql -c "update public.approval_tokens set action_ids = array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[] where nonce = 'nonce-2';"
claim_sql() {
  printf "set local role service_role; select public.claim_plan_execution('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3',
      '00000000-0000-0000-0000-0000000000e%s',
      array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[], 'race-%s')->>'decision'" "$1" "$1"
}
race_run "$(claim_sql 1)" "begin; $(claim_sql 2); commit" "$result_dir/first" "$result_dir/second"
python3 - "$result_dir" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
first, second = (p/'first').read_text().strip(), (p/'second').read_text().strip()
assert first == 'claimed', first
assert second == 'already_executing', f'Same actions were claimed twice: {first}, {second}'
PY
[ "$(sql -c "select count(*) from public.approval_tokens where nonce in ('nonce-1','nonce-2') and status='consumed'")" = 1 ]
[ "$(sql -c "select count(*) from public.execution_dispatch_outbox where request_key like 'race-%'")" = 1 ]
echo 'Concurrent execution: one claim/outbox, competing token remains issued.'
