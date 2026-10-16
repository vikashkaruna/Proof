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
start_args=(start --workdir "$state_dir" --exclude studio,postgres-meta,realtime,logflare,vector,edge-runtime,imgproxy)
if [ "${AXIOM_PARITY_STARTUP_DEBUG+x}" = x ]; then
  if [ "$AXIOM_PARITY_STARTUP_DEBUG" != 1 ] || [ "${GITHUB_ACTIONS:-}" != true ] || \
     [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] || [ "${RUNNER_OS:-}" != Linux ] || \
     [ "$(uname -s)" != Linux ]; then
    echo 'Protected startup debug requires explicit opt-in on GitHub-hosted Linux.' >&2
    exit 1
  fi
  start_args+=(--debug)
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
  attempt_log="$state_dir/start-attempt-$attempt.log"
  observer_log="$state_dir/start-attempt-$attempt.observer.json"
  if [ "${AXIOM_PARITY_STARTUP_DEBUG:-}" = 1 ]; then
    if python3 .github/ci/observe_supabase_startup.py "$project_id" "$observer_log" -- \
      supabase "${start_args[@]}" > "$attempt_log" 2>&1; then
      started=true
    fi
  elif supabase "${start_args[@]}" > "$attempt_log" 2>&1; then
    started=true
  fi
  cp "$attempt_log" "$state_dir/start.log"
  chmod 600 "$attempt_log" "$state_dir/start.log"
  if [ "$started" = true ]; then
    break
  fi
  echo "Startup attempt $attempt diagnostics:" >&2
  # Emit bounded facts before retries can replace the first failure's context.
  python3 .github/ci/diagnose_supabase_startup.py "$attempt_log" "$project_id" || true
  if [ "${AXIOM_PARITY_STARTUP_DEBUG:-}" = 1 ]; then
    python3 .github/ci/observe_supabase_startup.py --report "$project_id" "$observer_log" || true
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
  exit 1
fi
# Privileged bootstrap accepts only the two reviewed disposable parity families.
# Inspect public image identities only; never read credentials/status for eligibility.
db_image=$(docker container inspect --format '{{.Image}}' "$db_container")
api_image=$(docker container inspect --format '{{.Image}}' "supabase_kong_${project_id}")
python3 tests/database/lib/preprovision-local-custody-issuer.py \
  --container "$db_container" --image "$db_image" --api-image "$api_image" \
  --parity-state "$state_dir" --project "$project_id" --port-prefix "$port_prefix"
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
