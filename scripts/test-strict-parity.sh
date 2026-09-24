#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/start-parity-supabase.sh
for environment in staging preprod production onprem; do
  pnpm exec tsx scripts/verify-strict-parity.ts "$environment"
done
python3 - <<'PY'
import json, os
from pathlib import Path
state = Path(os.environ.get('AXIOM_PARITY_STATE_DIR', '.axiom-runtime/parity'))
expected = json.loads((state / 'staging.json').read_text())
for environment in ['preprod', 'production', 'onprem']:
    actual = json.loads((state / f'{environment}.json').read_text())
    assert actual == expected, f'Behavioral divergence in {environment}'
print('Strict parity: all four topology labels produced identical security outcomes.')
PY
