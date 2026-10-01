#!/usr/bin/env bash
# Legacy entrypoint retained for operators; the only supported flow is the
# exact-revision, strict-Auth, synthetic-persona deployed acceptance runner.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: run-preprod-flow.sh PRIVATE_PREPROD_TARGET_JSON' >&2
  echo 'Create a mode-0600 AXIOM_ACCEPTANCE_TARGET file and use the deployed acceptance contract.' >&2
  exit 2
fi
exec "$(dirname "$0")/run-deployed-acceptance.sh" "$1"
