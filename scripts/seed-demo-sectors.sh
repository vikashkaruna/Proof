#!/usr/bin/env bash
# Seed the three fictitious sector demo companies (BFSI, Healthcare, SaaS)
# into a LOCAL Supabase database. See infra/supabase/seed-demo-sectors.sql.
#
#   scripts/seed-demo-sectors.sh                 # owner-test stack (port 57122)
#   scripts/seed-demo-sectors.sh --port 55322    # parity stack
#   scripts/seed-demo-sectors.sh --check         # run everything, then roll back
#   scripts/seed-demo-sectors.sh --reset         # remove ONLY the demo companies, then re-seed
#
# Re-running is safe: history is written once, and each run re-arms the
# approval journey. Loopback hosts only; never point this at preprod or prod.
set -euo pipefail

port="${PGPORT:-57122}"
host="127.0.0.1"
check=0
reset=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    --check) check=1; shift ;;
    --reset) reset=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$host" in
  127.0.0.1|localhost|::1) ;;
  *) echo "refusing non-loopback host $host" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
sql="$root/infra/supabase/seed-demo-sectors.sql"

# Local Supabase superuser with the CLI's default local password.
export PGPASSWORD="${PGPASSWORD:-postgres}"
psql_cmd=(psql -h "$host" -p "$port" -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)

if [[ $reset -eq 1 && $check -eq 1 ]]; then
  echo "--reset and --check cannot be combined" >&2; exit 2
fi
if [[ $reset -eq 1 ]]; then
  "${psql_cmd[@]}" -f "$root/infra/supabase/reset-demo-sectors.sql"
fi

if [[ $check -eq 1 ]]; then
  echo "check mode: the seed runs in one transaction and is rolled back"
  sed -e 's/^commit;$/rollback;/' "$sql" | "${psql_cmd[@]}"
else
  "${psql_cmd[@]}" -f "$sql"
fi
