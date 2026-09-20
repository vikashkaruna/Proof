#!/usr/bin/env bash
set -euo pipefail
container="$1"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
python3 scripts/migrate-database.py --container "$container" --user postgres --database axiom_policy_test > "$test_dir/repeat.log"
if grep '^Applying:' "$test_dir/repeat.log"; then
  echo 'A repeat run reapplied a migration' >&2; exit 1
fi
mkdir "$test_dir/checksum" "$test_dir/failure"
cp infra/supabase/migrations/0001_init_tenants_users.sql "$test_dir/checksum/0001_init_tenants_users.sql"
echo '-- checksum tamper' >> "$test_dir/checksum/0001_init_tenants_users.sql"
if python3 scripts/migrate-database.py --container "$container" --user postgres --database axiom_policy_test --migrations "$test_dir/checksum" > "$test_dir/checksum.log" 2>&1; then
  echo 'Changed historical migration accepted' >&2; exit 1
fi
grep -q 'Applied migration has changed' "$test_dir/checksum.log"
cat > "$test_dir/failure/9999_failure.sql" <<'SQL'
begin;
create table public.must_rollback(id integer);
select 1/0;
commit;
SQL
if python3 scripts/migrate-database.py --container "$container" --user postgres --database axiom_policy_test --migrations "$test_dir/failure" > "$test_dir/failure.log" 2>&1; then
  echo 'Failed migration reported success' >&2; exit 1
fi
grep -q 'division by zero' "$test_dir/failure.log"
docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -q <<'SQL'
do $$ begin
  if to_regclass('public.must_rollback') is not null or exists(select 1 from axiom_migrations.applied where name='9999_failure.sql') then
    raise exception 'Failed migration left partial state';
  end if;
end $$;
SQL
echo 'Migration runner: repeat-safe, historical checksums enforced, failed DDL rolled back.'
