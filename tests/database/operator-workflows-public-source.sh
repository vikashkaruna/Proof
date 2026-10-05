#!/usr/bin/env bash
# Reuse closed synthetic source receipts; all workflow mutations roll back.
set -euo pipefail
container="${1:?Disposable test container required}"
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
python3 - "$repo_root" <<'PY' | docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1
from pathlib import Path
import sys
root = Path(sys.argv[1])
fixture = (root / 'tests/database/public-source-reviews.test.sql').read_text()
print(fixture[:fixture.index('-- Review tests start here')])
print((root / 'tests/database/operator-workflows-public-source.sql').read_text())
PY
