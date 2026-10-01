#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MOCK_LOG:?}"
case "$1" in
  ps) echo 'axiom-restore-fixture-db'; exit 0 ;;
  inspect) if [ "${MOCK_CASE:-success}" = wrong_owner ]; then echo 'other-project:supabase-db'; else echo 'axiom-proof-onprem:supabase-db'; fi; exit 0 ;;
  cp) exit 0 ;;
  exec) shift 2 ;;
  compose) exit 0 ;;
  *) exit 2 ;;
esac
case "$1" in
  pg_dump)
    awk 'BEGIN { for (i=0; i<60000; i++) printf "x" }'
    exit 0 ;;
  rm) exit 0 ;;
  psql)
    args=" $* "
    if [[ "$args" == *"current_database()"* ]]; then
      if [ "${MOCK_CASE:-success}" = wrong_database ]; then echo postgres; else echo axiom_onprem; fi
      exit 0
    fi
    if [[ "$args" == *' -f '* ]]; then
      [ "${MOCK_CASE:-success}" != restore_failure ]
      exit $?;
    fi
    if [[ "$args" == *'CREATE DATABASE'* || "$args" == *'DROP DATABASE'* ]]; then exit 0; fi
    if [[ "$args" == *"information_schema.tables"* ]]; then echo 86; exit 0; fi
    if [[ "$args" == *"pg_tables"* ]]; then echo 84; exit 0; fi
    if [[ "$args" == *"having count(distinct column_name)=5"* ]]; then
      echo 'select bucket,object_key,version_id,content_hash,byte_size from public.evidence_object_versions'; exit 0
    fi
    if [[ "$args" == *"json_agg(json_build_object"* ]]; then
      cat "${MOCK_INVENTORY:?}"; exit 0
    fi
    if [[ "$args" == *"verify_ledger"* ]]; then
      if [[ "${MOCK_CASE:-success}" == broken_ledger && "$args" == *' -d axiom_restore_drill_'* ]]; then echo 1; else echo 0; fi
      exit 0
    fi
    if [[ "$args" == *"string_agg"* ]]; then
      if [[ "${MOCK_CASE:-success}" == mismatch && "$args" == *' -d axiom_restore_drill_'* ]]; then printf '5:%064d\n' 0; else printf '5:%064d\n' 0 | tr 0 a; fi
      exit 0
    fi
    exit 2 ;;
esac
exit 2
MOCK
chmod +x "$TMP/bin/docker"
run_case() {
  local test_case="$1" expected="$2" message="$3" status=0
  : > "$TMP/calls"
  MOCK_CASE="$test_case" AXIOM_RESTORE_SOURCE_DB=axiom_onprem \
    AXIOM_RESTORE_DB_CONTAINER=axiom-restore-fixture-db MOCK_LOG="$TMP/calls" PATH="$TMP/bin:$PATH" \
    bash "$ROOT_DIR/scripts/test-backup-restore.sh" >"$TMP/output" 2>&1 || status=$?
  if [ "$expected" = pass ]; then
    [ "$status" -eq 0 ] || { cat "$TMP/output" >&2; exit 1; }
  else
    [ "$status" -ne 0 ] || { echo "$test_case should fail" >&2; exit 1; }
  fi
  grep -q "$message" "$TMP/output" || { cat "$TMP/output" >&2; exit 1; }
}
run_case success pass 'RPO and evidence-object recovery UNVERIFIED'
grep -q 'pg_dump -U postgres -d axiom_onprem' "$TMP/calls"
! grep -q 'pg_dump -U postgres -d postgres' "$TMP/calls"
run_case restore_failure fail 'Restoring into a disposable database'
run_case mismatch fail 'Restored ledger differs from source'
run_case broken_ledger fail 'Restored ledger chain is broken'
run_case wrong_database fail 'Database connection does not match AXIOM_RESTORE_SOURCE_DB'
AXIOM_RESTORE_SOURCE_DB=postgres AXIOM_RESTORE_DB_CONTAINER=axiom-restore-fixture-db \
  MOCK_LOG="$TMP/calls" PATH="$TMP/bin:$PATH" bash "$ROOT_DIR/scripts/test-backup-restore.sh" >"$TMP/output" 2>&1 && {
  echo 'maintenance database should be refused' >&2; exit 1;
}
grep -q 'never postgres' "$TMP/output"
AXIOM_RESTORE_SOURCE_DB=axiom_onprem AXIOM_RESTORE_DB_CONTAINER=axiom-restore-fixture-db \
  AXIOM_RESTORE_MODE=scheduled MOCK_LOG="$TMP/calls" PATH="$TMP/bin:$PATH" \
  bash "$ROOT_DIR/scripts/test-backup-restore.sh" >"$TMP/output" 2>&1 && {
  echo 'scheduled mode must require recovery inputs' >&2; exit 1;
}
grep -q 'AXIOM_RECOVERY_MANIFEST is required' "$TMP/output"

mkdir -p "$TMP/evidence/tenant"
printf 'retained fixture' > "$TMP/evidence/tenant/object.bin"
awk 'BEGIN { for (i=0; i<60000; i++) printf "x" }' > "$TMP/scheduled.sql"
cat > "$TMP/.env" <<'ENV'
AXIOM_STORAGE_ACCESS_KEY_ID=synthetic-root-access-key
AXIOM_STORAGE_SECRET_ACCESS_KEY=synthetic-root-secret-key-0123456789
AXIOM_RECOVERY_STORAGE_ACCESS_KEY_ID=synthetic-restore-access-key
AXIOM_RECOVERY_STORAGE_SECRET_ACCESS_KEY=synthetic-restore-secret-key-0123456789
ENV
chmod 600 "$TMP/.env"
AXIOM_RECOVERY_MANIFEST_KEY="$(printf 'ab%.0s' {1..32})"
export AXIOM_RECOVERY_MANIFEST_KEY
export RECOVERY_TEST_ROOT="$TMP"
AXIOM_RECOVERY_INCIDENT_AT="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat())
PY
)"
export AXIOM_RECOVERY_INCIDENT_AT
python3 - <<'PY'
import hashlib,hmac,json,os
from datetime import datetime,timedelta,timezone
from pathlib import Path
root=Path(os.environ['RECOVERY_TEST_ROOT'])
content=(root/'evidence/tenant/object.bin').read_bytes()
manifest={'schemaVersion':1,'sourceDatabase':'axiom_onprem','sourceBucket':'original-evidence',
 'backupAt':(datetime.now(timezone.utc)-timedelta(minutes=15)).isoformat(),
 'database':{'sha256':hashlib.sha256((root/'scheduled.sql').read_bytes()).hexdigest(),
  'byteSize':60000,'ledgerFingerprint':'5:'+'a'*64,'tableCount':86,'rlsCount':84},
 'evidence':[{'path':'tenant/object.bin','key':'tenants/t1/evidence/object.bin',
  'sourceVersionId':'original-v1','sha256':hashlib.sha256(content).hexdigest(),
  'byteSize':len(content),'retainUntil':(datetime.now(timezone.utc)+timedelta(days=2555)).isoformat(),
  'legalHold':True}]}
wire=json.dumps(manifest,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
manifest['signature']=hmac.new(bytes.fromhex(os.environ['AXIOM_RECOVERY_MANIFEST_KEY']),wire,hashlib.sha256).hexdigest()
path=root/'manifest.json';path.write_text(json.dumps(manifest));path.chmod(0o600)
row={'bucket':'original-evidence','key':manifest['evidence'][0]['key'],'versionId':'original-v1',
 'sha256':manifest['evidence'][0]['sha256'],'byteSize':len(content)}
(root/'inventory.json').write_text(json.dumps([row]))
PY
MOCK_CASE=success AXIOM_RESTORE_SOURCE_DB=axiom_onprem \
  AXIOM_RESTORE_DB_CONTAINER=axiom-restore-fixture-db AXIOM_RESTORE_MODE=scheduled \
  AXIOM_RECOVERY_MANIFEST="$TMP/manifest.json" AXIOM_SCHEDULED_DB_DUMP="$TMP/scheduled.sql" \
  AXIOM_EVIDENCE_BACKUP_ROOT="$TMP/evidence" AXIOM_RESTORE_S3_BUCKET=isolated-restore \
  AXIOM_ONPREM_ENV_FILE="$TMP/.env" MOCK_INVENTORY="$TMP/inventory.json" \
  MOCK_LOG="$TMP/calls" PATH="$TMP/bin:$PATH" \
  bash "$ROOT_DIR/scripts/test-backup-restore.sh" >"$TMP/output" 2>&1 || {
  cat "$TMP/output" >&2; exit 1;
}
grep -q 'Scheduled database and evidence restore passed: RPO=' "$TMP/output"
grep -q 'compose --env-file.*--profile recovery.*--entrypoint python recovery' "$TMP/calls"
MOCK_CASE=wrong_owner AXIOM_RESTORE_SOURCE_DB=axiom_onprem \
  AXIOM_RESTORE_DB_CONTAINER=axiom-restore-fixture-db AXIOM_RESTORE_MODE=scheduled \
  MOCK_LOG="$TMP/calls" PATH="$TMP/bin:$PATH" \
  bash "$ROOT_DIR/scripts/test-backup-restore.sh" >"$TMP/output" 2>&1 && {
  echo 'foreign Compose project must be refused before restore' >&2; exit 1;
}
grep -q 'not the owned on-prem' "$TMP/output"
echo 'backup restore drill command-path regressions passed'
