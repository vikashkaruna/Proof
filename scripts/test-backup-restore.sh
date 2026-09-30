#!/usr/bin/env bash
# Database-only diagnostic, or a signed scheduled-backup recovery drill with
# evidence-object restoration. Neither mode ever targets the default postgres
# maintenance database as Axiom's application database.
set -euo pipefail
umask 077

MODE="${AXIOM_RESTORE_MODE:-diagnostic}"
SOURCE_DB="${AXIOM_RESTORE_SOURCE_DB:-}"
CONTAINER_NAME="${AXIOM_RESTORE_DB_CONTAINER:-}"
if [[ ! "$SOURCE_DB" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || [ "$SOURCE_DB" = postgres ]; then
  echo 'Set AXIOM_RESTORE_SOURCE_DB to the exact Axiom application database (never postgres).' >&2
  exit 1
fi
if [ "$MODE" != diagnostic ] && [ "$MODE" != scheduled ]; then
  echo 'AXIOM_RESTORE_MODE must be diagnostic or scheduled.' >&2; exit 1
fi
DRILL_DB="axiom_restore_drill_$(date +%s)_$$"
TMP_DUMP="$(mktemp "${TMPDIR:-/tmp}/axiom-restore-XXXXXX")"
TMP_INVENTORY="$(mktemp "${TMPDIR:-/tmp}/axiom-restored-versions-XXXXXX")"
USE_DOCKER=false
CREATED_DB=false
COPIED_DUMP=false
MAX_RTO_SECONDS=14400
BACKUP_FILE="$TMP_DUMP"
RESTORE_START="$(date +%s)"

cleanup() {
  if [ "$COPIED_DUMP" = true ]; then
    docker exec "$CONTAINER_NAME" rm -f "/tmp/${DRILL_DB}.sql" \
      || echo 'WARNING: remove the temporary restore dump from the container manually' >&2
  fi
  if [ "$CREATED_DB" = true ]; then
    if [ "$USE_DOCKER" = true ]; then
      docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
        -c "DROP DATABASE ${DRILL_DB};" >/dev/null || echo 'WARNING: remove the disposable restore database manually' >&2
    else
      psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DROP DATABASE ${DRILL_DB};" >/dev/null \
        || echo 'WARNING: remove the disposable restore database manually' >&2
    fi
  fi
  rm -f "$TMP_DUMP"
  rm -f "$TMP_INVENTORY"
}
trap 'status=$?; cleanup; exit "$status"' EXIT

if [ -n "$CONTAINER_NAME" ]; then
  if [[ ! "$CONTAINER_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] ||
    ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    echo 'Named restore source container is not running; refusing another database.' >&2; exit 1
  fi
  USE_DOCKER=true
elif [ -z "${DATABASE_URL:-}" ]; then
  echo 'An explicit AXIOM_RESTORE_DB_CONTAINER or DATABASE_URL is required.' >&2
  exit 1
fi
if [ "$MODE" = scheduled ] && [ "$USE_DOCKER" != true ]; then
  echo 'Scheduled on-prem restore requires an explicit running database container.' >&2; exit 1
fi
if [ "$MODE" = scheduled ]; then
  OWNER="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}:{{ index .Config.Labels "com.docker.compose.service" }}' "$CONTAINER_NAME")"
  [ "$OWNER" = 'axiom-proof-onprem:supabase-db' ] || {
    echo 'Scheduled restore target is not the owned on-prem application database container.' >&2; exit 1;
  }
fi

source_sql() {
  if [ "$USE_DOCKER" = true ]; then
    docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$SOURCE_DB" -At -c "$1"
  else
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c "$1"
  fi
}

admin_sql() {
  if [ "$USE_DOCKER" = true ]; then
    docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c "$1"
  else
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c "$1"
  fi
}

restored_sql() {
  if [ "$USE_DOCKER" = true ]; then
    docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$DRILL_DB" -At -c "$1"
  else
    # A bare \connect reuses the URL's host, port, user and credentials.
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c "\\connect $DRILL_DB" -c "$1" | tail -n 1
  fi
}

ledger_fingerprint_sql="select count(*)::text || ':' || encode(digest(coalesce(string_agg(row_to_json(a)::text, E'\\n' order by tenant_id, sequence_no), ''), 'sha256'), 'hex') from public.audit_ledger a;"
ledger_breaks_sql="select count(*) from (select distinct tenant_id from public.audit_ledger) t where exists (select 1 from public.verify_ledger(t.tenant_id));"
table_count_sql="select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';"
rls_count_sql="select count(*) from pg_tables where schemaname = 'public' and rowsecurity;"

if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
else
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

if [ "$MODE" = scheduled ]; then
  for required in AXIOM_RECOVERY_MANIFEST AXIOM_SCHEDULED_DB_DUMP AXIOM_EVIDENCE_BACKUP_ROOT AXIOM_RECOVERY_INCIDENT_AT AXIOM_RECOVERY_MANIFEST_KEY AXIOM_RESTORE_S3_BUCKET; do
    if [ -z "${!required:-}" ]; then
      echo "${required} is required for scheduled recovery acceptance." >&2; exit 1
    fi
  done
  RECOVERY_EXPECTED="$(python3 scripts/recovery-evidence.py validate "$AXIOM_RECOVERY_MANIFEST" \
    "$AXIOM_SCHEDULED_DB_DUMP" "$AXIOM_EVIDENCE_BACKUP_ROOT" \
    "$SOURCE_DB" "$AXIOM_RECOVERY_INCIDENT_AT")"
  SOURCE_TABLES="$(printf '%s' "$RECOVERY_EXPECTED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tableCount"])')"
  SOURCE_RLS="$(printf '%s' "$RECOVERY_EXPECTED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rlsCount"])')"
  SOURCE_LEDGER="$(printf '%s' "$RECOVERY_EXPECTED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ledgerFingerprint"])')"
  INCIDENT_EPOCH="$(printf '%s' "$RECOVERY_EXPECTED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["incidentEpoch"])')"
  RPO_SECONDS="$(printf '%s' "$RECOVERY_EXPECTED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rpoSeconds"])')"
  BACKUP_FILE="$AXIOM_SCHEDULED_DB_DUMP"
  echo 'Restoring signed scheduled backup and evidence inventory...'
else
  echo 'Checking source ledger integrity...'
  [ "$(source_sql 'select current_database()')" = "$SOURCE_DB" ] || {
    echo 'Database connection does not match AXIOM_RESTORE_SOURCE_DB.' >&2; exit 1;
  }
  SOURCE_TABLES="$(source_sql "$table_count_sql")"
  SOURCE_RLS="$(source_sql "$rls_count_sql")"
  SOURCE_LEDGER="$(source_sql "$ledger_fingerprint_sql")"
  [ "$SOURCE_TABLES" -ge 80 ] || { echo 'Source database is missing expected Axiom tables.' >&2; exit 1; }
  [ "$SOURCE_RLS" -gt 0 ] || { echo 'Source database has no RLS tables.' >&2; exit 1; }
  [ "$(source_sql "$ledger_breaks_sql")" = 0 ] || { echo 'Source ledger chain is broken.' >&2; exit 1; }
  echo 'Creating fresh database-only diagnostic backup...'
  if [ "$USE_DOCKER" = true ]; then
    docker exec "$CONTAINER_NAME" pg_dump -U postgres -d "$SOURCE_DB" > "$TMP_DUMP"
  else
    pg_dump "$DATABASE_URL" > "$TMP_DUMP"
  fi
fi
[ "$(wc -c < "$BACKUP_FILE")" -ge 50000 ] || { echo 'Backup is suspiciously small.' >&2; exit 1; }
BACKUP_SHA="$(hash_file "$BACKUP_FILE")"
if [ "$MODE" = diagnostic ]; then
  [ "$(source_sql "$ledger_fingerprint_sql")" = "$SOURCE_LEDGER" ] || {
    echo 'Source ledger changed during backup; retry in a quiet window.' >&2; exit 1;
  }
fi

echo 'Restoring into a disposable database...'
admin_sql "CREATE DATABASE ${DRILL_DB};" >/dev/null
CREATED_DB=true
if [ "$USE_DOCKER" = true ]; then
  docker cp "$BACKUP_FILE" "$CONTAINER_NAME:/tmp/${DRILL_DB}.sql"
  COPIED_DUMP=true
  docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d "$DRILL_DB" \
    -f "/tmp/${DRILL_DB}.sql" >/dev/null
  docker exec "$CONTAINER_NAME" rm -f "/tmp/${DRILL_DB}.sql"
  COPIED_DUMP=false
else
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "\\connect $DRILL_DB" -f "$BACKUP_FILE" >/dev/null
fi
[ "$(hash_file "$BACKUP_FILE")" = "$BACKUP_SHA" ] || { echo 'Backup changed before verification.' >&2; exit 1; }

echo 'Checking restored schema and ledger...'
[ "$(restored_sql "$table_count_sql")" = "$SOURCE_TABLES" ] || { echo 'Restored table count differs.' >&2; exit 1; }
[ "$(restored_sql "$rls_count_sql")" = "$SOURCE_RLS" ] || { echo 'Restored RLS table count differs.' >&2; exit 1; }
[ "$(restored_sql "$ledger_breaks_sql")" = 0 ] || { echo 'Restored ledger chain is broken.' >&2; exit 1; }
[ "$(restored_sql "$ledger_fingerprint_sql")" = "$SOURCE_LEDGER" ] || {
  echo 'Restored ledger differs from source.' >&2; exit 1;
}
if [ "$MODE" = scheduled ]; then
  # Discover all retained-version tables by their common persisted schema,
  # including future board/statutory/approval archives. The signed object
  # inventory must cover every referenced version, not a selected sample.
  VERSION_UNION="$(restored_sql "select string_agg(format('select bucket,object_key,version_id,content_hash,byte_size from public.%I',table_name),' union all ' order by table_name) from (select table_name from information_schema.columns where table_schema='public' and column_name in ('bucket','object_key','version_id','content_hash','byte_size') group by table_name having count(distinct column_name)=5) t")"
  [ -n "$VERSION_UNION" ] || { echo 'No retained evidence version tables found.' >&2; exit 1; }
  restored_sql "select coalesce(json_agg(json_build_object('bucket',bucket,'key',object_key,'versionId',version_id,'sha256',content_hash,'byteSize',byte_size)),'[]'::json)::text from (${VERSION_UNION}) v" > "$TMP_INVENTORY"
  python3 scripts/recovery-evidence.py inventory "$AXIOM_RECOVERY_MANIFEST" "$TMP_INVENTORY" >/dev/null || {
    echo 'Scheduled evidence inventory does not match restored database references.' >&2; exit 1;
  }
  ENV_FILE="${AXIOM_ONPREM_ENV_FILE:-infra/docker/environments/.env.onprem}"
  [ -f "$ENV_FILE" ] || { echo 'Protected on-prem environment file is required for evidence restore.' >&2; exit 1; }
  MANIFEST_ABS="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$AXIOM_RECOVERY_MANIFEST")"
  EVIDENCE_ABS="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$AXIOM_EVIDENCE_BACKUP_ROOT")"
  SCRIPT_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/recovery-evidence.py"
  export AXIOM_RECOVERY_MANIFEST_KEY AXIOM_RESTORE_S3_BUCKET
  docker compose --env-file "$ENV_FILE" -f infra/docker/docker-compose.onprem.yml \
    run --rm --no-deps --user "$(id -u):$(id -g)" \
    -v "$MANIFEST_ABS:/recovery/manifest.json:ro" \
    -v "$EVIDENCE_ABS:/recovery/evidence:ro" \
    -v "$SCRIPT_ABS:/recovery/recovery-evidence.py:ro" \
    -e AXIOM_RECOVERY_MANIFEST_KEY -e AXIOM_RESTORE_S3_BUCKET \
    -e AXIOM_RESTORE_S3_ENDPOINT=http://minio:9000 \
    --entrypoint python agent-runtime /recovery/recovery-evidence.py restore \
      /recovery/manifest.json /recovery/evidence >/dev/null || {
    echo 'Evidence-object restore/readback failed.' >&2; exit 1;
  }
fi
RTO_SECONDS=$(( $(date +%s) - RESTORE_START ))
[ "$RTO_SECONDS" -le "$MAX_RTO_SECONDS" ] || { echo "RTO exceeded ${MAX_RTO_SECONDS}s." >&2; exit 1; }
if [ "$MODE" = scheduled ]; then
  INCIDENT_RTO_SECONDS=$(( $(date +%s) - INCIDENT_EPOCH ))
  [ "$INCIDENT_RTO_SECONDS" -ge 0 ] && [ "$INCIDENT_RTO_SECONDS" -le "$MAX_RTO_SECONDS" ] || {
    echo "Incident-to-recovery RTO exceeded ${MAX_RTO_SECONDS}s." >&2; exit 1;
  }
  echo "Scheduled database and evidence restore passed: RPO=${RPO_SECONDS}s, incident-to-recovery RTO=${INCIDENT_RTO_SECONDS}s, drill duration=${RTO_SECONDS}s, database SHA-256=${BACKUP_SHA}; exact-version evidence readback verified."
else
  echo "Database-only diagnostic passed: RTO=${RTO_SECONDS}s, fresh backup SHA-256=${BACKUP_SHA}."
  echo 'RPO and evidence-object recovery UNVERIFIED: scheduled mode is required for release acceptance.'
fi
