#!/usr/bin/env bash
# Populated 0116 -> 0117 parity, exclusively in the runner's disposable fixture.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=${1:?owned test container required}
case "$container" in axiom-db-test-[0-9]*) ;; *) echo 'Dedicated policy fixture required' >&2; exit 1;; esac
owner=$(docker inspect --format '{{ index .Config.Labels "com.axiom.owner-worktree" }}' "$container")
kind=$(docker inspect --format '{{ index .Config.Labels "com.axiom.fixture" }}' "$container")
[ "$owner" = "$(pwd)" ] && [ "$kind" = database-policy-test ]
database=axiom_adoption_upgrade
scratch=$(mktemp -d)
cleanup(){ docker exec "$container" dropdb -U postgres --if-exists "$database" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
mkdir "$scratch/migrations"
for migration in infra/supabase/migrations/*.sql; do
  if [[ "$(basename "$migration")" < 0117_ ]]; then cp "$migration" "$scratch/migrations/"; fi
done
docker exec "$container" createdb -U postgres "$database"
sql(){ docker exec -i "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -q; }
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database "$database" --migrations "$scratch/migrations" >/dev/null
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
python3 scripts/migrate-database.py --container "$container" --user postgres --database "$database" >/dev/null
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
