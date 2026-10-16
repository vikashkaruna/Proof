#!/usr/bin/env bash
# Original owned disposable fixture only; no retained operator database.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Expected owned fixture name and explicit existing image reference' >&2
  exit 1
fi
python3 tests/database/lib/local-public-control-assessment-dispatch-races.py "$1" "$2"
