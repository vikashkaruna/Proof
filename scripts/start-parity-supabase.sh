#!/usr/bin/env bash
# Isolated real Auth/Postgres stack. Does not reset or stop existing projects.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
state_dir="${AXIOM_PARITY_STATE_DIR:-$PWD/.axiom-runtime/parity}"
mkdir -p "$state_dir/supabase"
chmod 700 "$state_dir"
python3 - "$state_dir" <<'PY'
from pathlib import Path
import sys
state = Path(sys.argv[1])
config = Path('infra/supabase/config.toml').read_text()
config = config.replace('project_id = "axiom-proof"', 'project_id = "axiom-w0-parity"').replace('553', '563')
config = config.replace('[studio]\nenabled = true', '[studio]\nenabled = false').replace('[analytics]\nenabled = true', '[analytics]\nenabled = false')
# Historical bootstrap needs the Supabase administration role. CLI migrations
# use restricted postgres; apply via the checksummed runner AFTER Auth starts.
config += '\n[db.seed]\nenabled = false\n\n[db.migrations]\nenabled = false\n'
(state / 'supabase/config.toml').write_text(config)
PY
if ! supabase start --workdir "$state_dir" --exclude studio,postgres-meta,realtime,logflare,vector,edge-runtime,imgproxy > "$state_dir/start.log" 2>&1; then
  echo "Supabase startup failed. Inspect the protected log at $state_dir/start.log" >&2
  exit 1
fi
python3 scripts/migrate-database.py --container supabase_db_axiom-w0-parity
# Reload API schema only after the whole migration series succeeds.
docker exec supabase_db_axiom-w0-parity psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c "notify pgrst, 'reload schema';"
supabase status --workdir "$state_dir" -o json > "$state_dir/status.json" 2> "$state_dir/status.log"
chmod 600 "$state_dir/status.json"
echo 'Isolated Supabase Auth/Postgres ready on port 56321; credentials retained in protected local state.'
