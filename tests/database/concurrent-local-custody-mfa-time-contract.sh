#!/usr/bin/env bash
# Only the existing labelled/nonce-owned disposable fixture is accepted.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Expected owned fixture name and explicit existing image reference' >&2
  exit 1
fi
python3 tests/database/lib/local-custody-mfa-time-races.py "$1" "$2"
