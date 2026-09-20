#!/usr/bin/env bash
# ==============================================================================
# Axiom Proof — migrations for a deployed database (W0.1)
# ==============================================================================
# Usage:
#   ./scripts/migrate-cloudsql.sh [OPTIONS] <DATABASE_URL>
#   SUPABASE_DB_URL=postgresql://... ./scripts/migrate-cloudsql.sh
#
# Options:
#   --seed-identities   Also seed representative tenants and persona logins.
#                       Off by default; refused outright for production.
#   --skip-seeds        Apply migrations only.
#
# This script used to apply every .sql file in order with psql, retry once on
# failure, and then `|| true` the result before printing "✓ Applied". A failed
# migration was therefore reported as a success, and the deploy carried on to
# report a healthy preprod on top of a schema that had not been applied. It
# also re-ran every file on every deploy, kept no history, and `|| true`'d all
# three seeds including the statutory control library.
#
# It now delegates to scripts/migrate-database.py, which records a checksum per
# migration, refuses changed history, wraps each file in its own transaction
# and serialises concurrent runners on an advisory lock. Every step here is
# fatal. A deploy that cannot migrate is a deploy that must stop.
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SEED_IDENTITIES=false
SKIP_SEEDS=false
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --seed-identities) SEED_IDENTITIES=true; shift ;;
    --skip-seeds) SKIP_SEEDS=true; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

DB_URL="${POSITIONAL[0]:-${SUPABASE_DB_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "Error: database connection URL required (argument or SUPABASE_DB_URL)." >&2
  echo "Usage: ./scripts/migrate-cloudsql.sh [--seed-identities] <DATABASE_URL>" >&2
  exit 1
fi

# Never echo the URL: it carries the database password.
DB_HOST="$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(p.hostname or "")' "$DB_URL")"
DB_NAME="$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print((p.path or "").lstrip("/"))' "$DB_URL")"
if [ -z "$DB_HOST" ] || [ -z "$DB_NAME" ]; then
  echo "Error: connection URL must name a host and a database." >&2
  exit 1
fi

echo "================================================================="
echo "  Axiom Proof — applying migrations to ${DB_NAME} at ${DB_HOST}"
echo "================================================================="

# ─── 1. The database must actually be reachable ──────────────────────
# A freshly created Cloud SQL instance takes a moment to accept connections,
# so this waits. It does not proceed without one: the previous version warned
# "Proceeding to attempt migrations..." and carried on regardless.
echo "▶ Waiting for the database to accept connections..."
CONNECTED=0
# Bounded, and the bound is visible so a test can shorten it. A fresh Cloud SQL
# instance needs a minute or so; nothing needs two and a half.
WAIT_ATTEMPTS="${AXIOM_DB_WAIT_ATTEMPTS:-30}"
WAIT_SECONDS="${AXIOM_DB_WAIT_SECONDS:-5}"
for attempt in $(seq 1 "$WAIT_ATTEMPTS"); do
  if psql -w "$DB_URL" -c 'select 1' >/dev/null 2>&1; then CONNECTED=1; break; fi
  [ "$attempt" = 1 ] && echo "  (not yet accepting connections; retrying)"
  sleep "$WAIT_SECONDS"
done
if [ "$CONNECTED" -ne 1 ]; then
  echo "  ✗ Could not connect to ${DB_HOST}/${DB_NAME} after ${WAIT_ATTEMPTS} attempts." >&2
  echo "    Check the instance is running and this host is in its authorized networks." >&2
  exit 1
fi
echo "  ✓ Database is accepting connections"

# ─── 2. Migrations, checksummed and fatal ────────────────────────────
echo "▶ Applying the migration series..."
python3 scripts/migrate-database.py --dsn "$DB_URL"
echo "  ✓ Migration series applied"

if [ "$SKIP_SEEDS" = true ]; then
  echo "▶ Seeds skipped (--skip-seeds)"
  echo "  ✓ Done"
  exit 0
fi

# ─── 3. The statutory control library ────────────────────────────────
# Not optional and not best-effort. The published library is what every
# client-facing report cites; a deployment whose library did not seed would
# serve an empty or stale control set while reporting success.
#
# This one goes through the REST API rather than the database, so it needs the
# Supabase service endpoint to be up — which is why it runs after migrations
# rather than alongside them.
echo "▶ Seeding the statutory DPDPA control library..."
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "  ✗ SUPABASE_URL and SUPABASE_SERVICE_KEY are required to seed the control library." >&2
  echo "    Pass --skip-seeds to apply schema only." >&2
  exit 1
fi
SUPABASE_DB_URL="$DB_URL" pnpm seed:controls
echo "  ✓ Control library seeded"

# ─── 4. Representative identities, only when asked ───────────────────
# W0.1 wants representative data so RLS and RBAC are genuinely exercised:
# several tenants and a login for every persona. Those logins have fixed,
# published passwords, so seeding them is a deliberate act and never a
# side effect of deploying.
if [ "$SEED_IDENTITIES" != true ]; then
  echo "▶ Representative identities not seeded (pass --seed-identities to include them)"
  echo "================================================================="
  echo "  ✓ Migrations complete"
  echo "================================================================="
  exit 0
fi

if [ "${ENVIRONMENT:-}" = "production" ]; then
  echo "  ✗ Refusing to seed fixed-password identities into production." >&2
  exit 1
fi

echo "▶ Seeding representative tenants and persona logins..."
psql -w "$DB_URL" -v ON_ERROR_STOP=1 -q -f infra/supabase/seed-users.sql
SUPABASE_DB_URL="$DB_URL" pnpm seed:users
SUPABASE_DB_URL="$DB_URL" pnpm tsx scripts/seed-platform-baseline.ts
echo "  ✓ Representative identities seeded"

echo "================================================================="
echo "  ✓ Migrations and seeds complete"
echo "================================================================="
