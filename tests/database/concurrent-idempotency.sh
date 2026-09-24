#!/usr/bin/env bash
# Called only by the disposable database runner. Eight independent sessions
# compete for a single key: exactly one can cross the mutation boundary.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
docker exec "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -q -c \
  "insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000052','race@test.invalid');"
pids=()
for worker in $(seq 1 8); do
  docker exec "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq -c \
    "set role service_role; select public.claim_request('00000000-0000-0000-0000-000000000052',null,'/race','POST','concurrent-key',repeat('a',64),repeat('b',64))->>'decision';" > "$result_dir/$worker" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
python3 - "$result_dir" <<'PY'
from collections import Counter
from pathlib import Path
import sys
results = Counter(path.read_text().strip() for path in Path(sys.argv[1]).iterdir())
assert results == {'claimed': 1, 'in_progress': 7}, results
print('Concurrent idempotency: one owner, seven refused duplicates.')
PY
