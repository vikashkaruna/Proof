#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ps) echo 'supabase_db_axiom-proof'; exit 0 ;;
  cp) exit 0 ;;
  exec) shift 2 ;;
  *) exit 2 ;;
esac
case "$1" in
  pg_dump)
    awk 'BEGIN { for (i=0; i<60000; i++) printf "x" }'
    exit 0 ;;
  rm) exit 0 ;;
  psql)
    args=" $* "
    if [[ "$args" == *' -f '* ]]; then
      [ "${MOCK_CASE:-success}" != restore_failure ]
      exit $?;
    fi
    if [[ "$args" == *'CREATE DATABASE'* || "$args" == *'DROP DATABASE'* ]]; then exit 0; fi
    if [[ "$args" == *"information_schema.tables"* ]]; then echo 86; exit 0; fi
    if [[ "$args" == *"pg_tables"* ]]; then echo 84; exit 0; fi
    if [[ "$args" == *"verify_ledger"* ]]; then
      if [[ "${MOCK_CASE:-success}" == broken_ledger && "$args" == *' -d axiom_restore_drill_'* ]]; then echo 1; else echo 0; fi
      exit 0
    fi
    if [[ "$args" == *"string_agg"* ]]; then
      if [[ "${MOCK_CASE:-success}" == mismatch && "$args" == *' -d axiom_restore_drill_'* ]]; then echo '5:bbbb'; else echo '5:aaaa'; fi
      exit 0
    fi
    exit 2 ;;
esac
exit 2
MOCK
chmod +x "$TMP/bin/docker"
run_case() {
  local test_case="$1" expected="$2" message="$3" status=0
  MOCK_CASE="$test_case" PATH="$TMP/bin:$PATH" bash "$ROOT_DIR/scripts/test-backup-restore.sh" >"$TMP/output" 2>&1 || status=$?
  if [ "$expected" = pass ]; then
    [ "$status" -eq 0 ] || { cat "$TMP/output" >&2; exit 1; }
  else
    [ "$status" -ne 0 ] || { echo "$test_case should fail" >&2; exit 1; }
  fi
  grep -q "$message" "$TMP/output" || { cat "$TMP/output" >&2; exit 1; }
}
run_case success pass 'RPO unverified'
run_case restore_failure fail 'Restoring into a disposable database'
run_case mismatch fail 'Restored ledger differs from source'
run_case broken_ledger fail 'Restored ledger chain is broken'
echo 'backup restore drill command-path regressions passed'
