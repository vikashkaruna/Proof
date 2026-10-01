#!/usr/bin/env bash
# Isolated real Auth/Postgres stack. Does not reset or stop existing projects.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
state_dir="${AXIOM_PARITY_STATE_DIR:-$PWD/.axiom-runtime/parity}"
project_id="${AXIOM_PARITY_PROJECT_ID:-axiom-w0-parity}"
port_prefix="${AXIOM_PARITY_PORT_PREFIX:-563}"
if [[ ! "$project_id" =~ ^axiom-[a-z0-9-]+$ || ! "$port_prefix" =~ ^[0-9]{3}$ ]]; then
  echo 'Invalid isolated Supabase project or port prefix.' >&2
  exit 1
fi
db_container="supabase_db_${project_id}"
mkdir -p "$state_dir/supabase"
chmod 700 "$state_dir"
python3 - "$state_dir" "$project_id" "$port_prefix" <<'PY'
from pathlib import Path
import sys
state = Path(sys.argv[1])
config = Path('infra/supabase/config.toml').read_text()
config = config.replace('project_id = "axiom-proof"', f'project_id = "{sys.argv[2]}"').replace('553', sys.argv[3])
config = config.replace('[studio]\nenabled = true', '[studio]\nenabled = false').replace('[analytics]\nenabled = true', '[analytics]\nenabled = false')
# Historical bootstrap needs the Supabase administration role. CLI migrations
# use restricted postgres; apply via the checksummed runner AFTER Auth starts.
config += '\n[db.seed]\nenabled = false\n\n[db.migrations]\nenabled = false\n'
(state / 'supabase/config.toml').write_text(config)
PY
started=false
for attempt in 1 2 3; do
  if supabase start --workdir "$state_dir" --exclude studio,postgres-meta,realtime,logflare,vector,edge-runtime,imgproxy > "$state_dir/start.log" 2>&1; then
    started=true
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "Supabase start attempt $attempt failed; retrying in $((attempt * 5))s..." >&2
    supabase stop --workdir "$state_dir" > /dev/null 2>&1 || true
    sleep $((attempt * 5))
  fi
done
if [ "$started" != true ]; then
  echo "Supabase startup failed. Inspect the protected log at $state_dir/start.log" >&2
  # Logs may contain generated credentials. Emit only fixed diagnostic labels,
  # never raw startup logs or status JSON into CI logs/artifacts.
  python3 - "$state_dir/start.log" <<'PYDIAG'
from pathlib import Path
import sys
message = Path(sys.argv[1]).read_text().lower()
patterns = {
    'image registry/auth/rate-limit failure': ['toomanyrequests', 'pull access denied', 'manifest unknown', 'failed to pull', 'error pulling', 'unauthorized', '429 too many'],
    'container health/startup failure': ['unhealthy', 'health check', 'failed to start'],
    'host resource/port failure': ['no space left', 'address already in use', 'port is already allocated', 'out of memory'],
    'network timeout/connectivity failure': ['timeout', 'connection refused', 'connection reset', 'no such host', 'tls handshake'],
}
found = [label for label, terms in patterns.items() if any(term in message for term in terms)]
print('Startup diagnostic categories: ' + (', '.join(found) or 'unclassified; protected log required'), file=sys.stderr)
PYDIAG
  docker ps -a --filter "name=$project_id" --format '{{.Names}}: {{.Status}}' >&2
  exit 1
fi
python3 scripts/migrate-database.py --container "$db_container"
# Synthetic browser personas use one fixed test-only HMAC key. Provision it
# through the DB administration role, never through the PostgREST service key.
docker exec -i "$db_container" psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
insert into axiom_secrets.reconciliation_keys(scope,key_bytes)
values('global',convert_to('axiom-e2e-persona-harness-approval-signing-key','UTF8'))
on conflict(scope) do update set key_bytes=excluded.key_bytes
where axiom_secrets.reconciliation_keys.key_bytes=excluded.key_bytes;
select 1 / case when (select key_bytes=convert_to(
  'axiom-e2e-persona-harness-approval-signing-key','UTF8')
  from axiom_secrets.reconciliation_keys where scope='global') then 1 else 0 end;
SQL
# Reload API schema only after the whole migration series succeeds.
docker exec "$db_container" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c "notify pgrst, 'reload schema';"
supabase status --workdir "$state_dir" -o json > "$state_dir/status.json" 2> "$state_dir/status.log"
chmod 600 "$state_dir/status.json"
echo "Isolated Supabase Auth/Postgres ready on port ${port_prefix}21; credentials retained in protected local state."
