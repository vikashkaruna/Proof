#!/usr/bin/env bash
# Restore a fresh PostgreSQL backup into a disposable database and compare its
# audit chain with the source. This measures restore time; a fresh backup cannot
# establish the age of an operational backup or prove an RPO.
set -euo pipefail

CONTAINER_NAME="${AXIOM_RESTORE_DB_CONTAINER:-supabase_db_axiom-proof}"
DRILL_DB="axiom_restore_drill_$(date +%s)_$$"
TMP_DUMP="$(mktemp "${TMPDIR:-/tmp}/axiom-restore-XXXXXX")"
USE_DOCKER=false
CREATED_DB=false
COPIED_DUMP=false
MAX_RTO_SECONDS=14400

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
}
trap cleanup EXIT

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  USE_DOCKER=true
elif [ -z "${DATABASE_URL:-}" ]; then
  echo 'A running Supabase database container or DATABASE_URL is required.' >&2
  exit 1
fi

source_sql() {
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

echo 'Checking source ledger integrity...'
SOURCE_TABLES="$(source_sql "$table_count_sql")"
SOURCE_RLS="$(source_sql "$rls_count_sql")"
SOURCE_LEDGER="$(source_sql "$ledger_fingerprint_sql")"
[ "$SOURCE_TABLES" -ge 80 ] || { echo 'Source database is missing expected Axiom tables.' >&2; exit 1; }
[ "$SOURCE_RLS" -gt 0 ] || { echo 'Source database has no RLS tables.' >&2; exit 1; }
[ "$(source_sql "$ledger_breaks_sql")" = 0 ] || { echo 'Source ledger chain is broken.' >&2; exit 1; }

echo 'Creating a consistent backup...'
BACKUP_AT="$(date +%s)"
if [ "$USE_DOCKER" = true ]; then
  docker exec "$CONTAINER_NAME" pg_dump -U postgres -d postgres > "$TMP_DUMP"
else
  pg_dump "$DATABASE_URL" > "$TMP_DUMP"
fi
[ "$(wc -c < "$TMP_DUMP")" -ge 50000 ] || { echo 'Backup is suspiciously small.' >&2; exit 1; }
BACKUP_SHA="$(hash_file "$TMP_DUMP")"
[ "$(source_sql "$ledger_fingerprint_sql")" = "$SOURCE_LEDGER" ] || {
  echo 'Source ledger changed during backup; retry in a quiet window.' >&2; exit 1;
}

echo 'Restoring into a disposable database...'
source_sql "CREATE DATABASE ${DRILL_DB};" >/dev/null
CREATED_DB=true
RESTORE_START="$(date +%s)"
if [ "$USE_DOCKER" = true ]; then
  docker cp "$TMP_DUMP" "$CONTAINER_NAME:/tmp/${DRILL_DB}.sql"
  COPIED_DUMP=true
  docker exec "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d "$DRILL_DB" \
    -f "/tmp/${DRILL_DB}.sql" >/dev/null
  docker exec "$CONTAINER_NAME" rm -f "/tmp/${DRILL_DB}.sql"
  COPIED_DUMP=false
else
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "\\connect $DRILL_DB" -f "$TMP_DUMP" >/dev/null
fi
[ "$(hash_file "$TMP_DUMP")" = "$BACKUP_SHA" ] || { echo 'Backup changed before verification.' >&2; exit 1; }

echo 'Checking restored schema and ledger...'
[ "$(restored_sql "$table_count_sql")" = "$SOURCE_TABLES" ] || { echo 'Restored table count differs.' >&2; exit 1; }
[ "$(restored_sql "$rls_count_sql")" = "$SOURCE_RLS" ] || { echo 'Restored RLS table count differs.' >&2; exit 1; }
[ "$(restored_sql "$ledger_breaks_sql")" = 0 ] || { echo 'Restored ledger chain is broken.' >&2; exit 1; }
[ "$(restored_sql "$ledger_fingerprint_sql")" = "$SOURCE_LEDGER" ] || {
  echo 'Restored ledger differs from source.' >&2; exit 1;
}
RTO_SECONDS=$(( $(date +%s) - RESTORE_START ))
[ "$RTO_SECONDS" -le "$MAX_RTO_SECONDS" ] || { echo "RTO exceeded ${MAX_RTO_SECONDS}s." >&2; exit 1; }
echo "Restore drill passed: RTO=${RTO_SECONDS}s, backup SHA-256=${BACKUP_SHA}, source snapshot at ${BACKUP_AT}."
echo 'RPO unverified: test the age of scheduled backups against an incident timestamp separately.'
echo 'Evidence-object restoration and readback are outside this database drill.'
