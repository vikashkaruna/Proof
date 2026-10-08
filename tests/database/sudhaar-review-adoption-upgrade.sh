#!/usr/bin/env bash
# Populated 0116 -> 0117 parity, exclusively in the runner's disposable fixture.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=${1:?owned test container required}
case "$container" in axiom-db-test-[0-9]*) ;; *) echo 'Dedicated policy fixture required' >&2; exit 1;; esac
# Resolve once, then use and revalidate the immutable ID before every operation.
container_id=$(docker inspect --format '{{.Id}}' "$container")
[[ "$container_id" =~ ^[a-f0-9]{64}$ ]]
expected_owner=$(pwd)
check_identity(){
  docker inspect "$container_id" | python3 -c '
import json, sys
item, = json.load(sys.stdin)
labels = item.get("Config", {}).get("Labels") or {}
assert item.get("Id") == sys.argv[1]
assert item.get("Name") == "/" + sys.argv[2]
assert labels.get("com.axiom.owner-worktree") == sys.argv[3]
assert labels.get("com.axiom.fixture") == "database-policy-test"
assert labels.get("com.axiom.fixture.project") == "axiom-db-tests"
assert not any((item.get("HostConfig", {}).get("PortBindings") or {}).values())
assert not any((item.get("NetworkSettings", {}).get("Ports") or {}).values())
' "$container_id" "$container" "$expected_owner"
}
check_identity
scratch=$(mktemp -d)
database="axiom_adoption_upgrade_$(basename "$scratch" | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')"
created=false
# Keep command arguments after the immutable container target.
db_command(){ check_identity && docker exec "$container_id" "$@"; }
cleanup(){
  if "$created"; then
    if ! db_command dropdb -U postgres --if-exists "$database"; then
      echo "Fixture identity or cleanup failed; preserving evidence at $scratch" >&2
      return 1
    fi
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/migrations"
for migration in infra/supabase/migrations/*.sql; do
  if [[ "$(basename "$migration")" < 0117_ ]]; then cp "$migration" "$scratch/migrations/"; fi
done
db_command createdb -U postgres "$database"
created=true
sql(){ check_identity && docker exec -i "$container_id" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -q; }
migrate(){
  # The exact checksummed migration program uses the same checked SQL boundary.
  python3 - "$1" <<'PYTHON' | sql
import runpy, sys
from pathlib import Path
program = runpy.run_path("scripts/migrate-database.py")["migration_program"]
print(program(Path(sys.argv[1])))
PYTHON
}
sql < tests/database/bootstrap.sql
migrate "$scratch/migrations" >/dev/null
python3 - <<'PY' | sql
from pathlib import Path
fixture=Path('tests/database/sudhaar-settled-outputs.test.sql').read_text()
assert fixture.endswith('rollback;\n')
print(fixture[:-len('rollback;\n')]+'commit;')
PY
sql <<'SQL'
insert into public.remediation_plans(id,tenant_id,engagement_id,library_version,title,status)
 values('99770000-0000-4000-8000-000000000001','99750000-0000-4000-8000-000000000010','99750000-0000-4000-8000-000000000030','sudhaar-output-test-lib','Existing remediation proposal','review');
create table public.adoption_upgrade_snapshot as select
 (select jsonb_agg(to_jsonb(p)) from public.remediation_plans p) plans,
 (select jsonb_agg(to_jsonb(s)) from public.sudhaar_settled_outputs s) outputs,
 (select count(*) from public.audit_ledger) receipts;
SQL
migrate infra/supabase/migrations >/dev/null
sql <<'SQL'
do $$declare before public.adoption_upgrade_snapshot;begin
 select * into before from public.adoption_upgrade_snapshot;
 if before.plans is distinct from (select jsonb_agg(to_jsonb(p)-'purpose') from public.remediation_plans p)
  or exists(select 1 from public.remediation_plans where purpose<>'remediation')
  or before.outputs is distinct from (select jsonb_agg(to_jsonb(s)) from public.sudhaar_settled_outputs s)
  or before.receipts is distinct from (select count(*) from public.audit_ledger)
  or exists(select 1 from public.plan_source_review_adoptions)
  or exists(select 1 from public.plan_source_review_tasks)
 then raise exception 'Adoption upgrade reinterpreted legacy records or manufactured review authority';end if;
end$$;
SQL
echo 'Adoption upgrade: existing remediation purpose, exact outputs and receipts preserved; no inferred review tasks or human authority.'
