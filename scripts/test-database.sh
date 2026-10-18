#!/usr/bin/env bash
# Disposable, real PostgreSQL integration tests. Never connects to an existing DB.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -W error::ResourceWarning -m unittest discover -s tests/database/lib -p 'test_*.py'
python3 -W error::ResourceWarning tests/database/sudhaar-review-adoption-upgrade-identity.test.py
container="axiom-db-test-$$"
image="${AXIOM_TEST_POSTGRES_IMAGE:-supabase/postgres:17.6.1.127}"
# Public ECR can throttle clean CI runners. Prefer Docker Hub; a pinned mirror
# is a fallback only for image acquisition, never for a failing test.
if ! docker image inspect "$image" >/dev/null 2>&1; then
  if ! docker pull "$image"; then
    if [ -n "${AXIOM_TEST_POSTGRES_IMAGE:-}" ]; then exit 1; fi
    image="public.ecr.aws/supabase/postgres:17.6.1.127"
    docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
  fi
fi
test_log=$(mktemp)
phase_dir=$(mktemp -d "${TMPDIR:-/tmp}/axiom-report-policy.XXXXXXXX")
phase_dir=$(cd "$phase_dir" && pwd -P)
container_id=""
cleanup() {
  # Only a successful create response establishes ownership. A name collision
  # or uncertain create outcome must never remove somebody else's container.
  if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  rm -f "$test_log"
  rm -rf "$phase_dir"
}
trap cleanup EXIT
python3 tests/database/lib/report-policy-phases.py prepare --directory "$phase_dir"
pnpm exec tsx scripts/lib/coverage-first-report-sql-fixtures.ts "$phase_dir"
container_id=$(docker run --rm -d --name "$container" --label com.axiom.fixture=database-policy-test --label com.axiom.fixture.project=axiom-db-tests --label "com.axiom.owner-worktree=$(pwd)" -e POSTGRES_HOST_AUTH_METHOD=trust "$image")
for attempt in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null
docker exec "$container" createdb -U postgres axiom_policy_test
sql() {
  local database="${1:-axiom_policy_test}"
  if ! docker exec -i "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -q >"$test_log" 2>&1; then
    cat "$test_log"
    return 1
  fi
}
sql < tests/database/bootstrap.sql
# Explicit privileged role bootstrap only for this owned disposable fixture.
python3 tests/database/lib/preprovision-local-custody-verifier.py --container "$container" --image "$image"
python3 tests/database/lib/preprovision-local-custody-issuer.py --container "$container" --image "$image"

# Original138/142 assertions exercise their genuine historical NEW-request policy.
python3 scripts/migrate-database.py --container "$container" --user postgres --database axiom_policy_test --migrations "$phase_dir/migrations143"
# Prove the ordinary service role, never the fixture image's implicit RLS bypass.
docker exec "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -q -c "alter role service_role nobypassrls;"
while IFS= read -r suite; do
  echo "Testing $suite (historical143)"
  sql < "tests/database/$suite"
  printf '143|%s\n' "$suite" >> "$phase_dir/executed-suites.txt"
done < <(python3 tests/database/lib/report-policy-phases.py historical-list --directory "$phase_dir")
# Fresh owned databases retain actual source2/3 pending rows through the upgrade.
# Their lifetime is the already-owned disposable container; no retained DB is used.
for version in 2 3; do
  legacy_database="axiom_proof_local_report_source$version"
  docker exec "$container" createdb -U postgres "$legacy_database"
  sql "$legacy_database" < tests/database/bootstrap.sql
  python3 scripts/migrate-database.py --container "$container" --user postgres --database "$legacy_database" --migrations "$phase_dir/migrations143"
  python3 tests/database/lib/report-policy-phases.py legacy-program --directory "$phase_dir" --version "$version" | sql "$legacy_database"
done
python3 scripts/migrate-database.py --container "$container" --user postgres --database axiom_policy_test
bash tests/database/migration-runner.sh "$container"
python3 tests/database/lib/owned-postgres-role-fixture.py "$container" "$image"
current_version=$(python3 tests/database/lib/report-policy-phases.py current-version --directory "$phase_dir")
while IFS= read -r suite; do
  echo "Testing $suite (current$current_version)"
  if [[ "$suite" = postgresql-discovery-requests.test.sql || "$suite" = owned-postgres-target.test.sql || "$suite" = owned-human-plans.test.sql ]]; then
    { python3 tests/database/lib/postgresql-discovery-fixture.py; cat "tests/database/$suite"; } | docker exec -i "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -q > "$test_log" 2>&1 || { cat "$test_log"; exit 1; }
  elif [[ "$suite" = postgresql-sandbox-discovery.test.sql || "$suite" = controller-credential-issuance.test.sql || "$suite" = local-custody-credential-issuance.test.sql || "$suite" = local-custody-credential-issuance-demo.test.sql || "$suite" = local-custody-credential-identity.test.sql ]]; then
    # The production migration deliberately grants no issuer membership to
    # postgres. Only this disposable test session assumes the private role.
    docker exec -i "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -q < "tests/database/$suite" > "$test_log" 2>&1 || { cat "$test_log"; exit 1; }
  elif [ "$suite" = catalogue-current-version.test.sql ]; then
    { echo "begin;"; pnpm exec tsx scripts/lib/catalogue-version-sql-fixture.ts; sed '/^rollback;$/d' tests/database/catalogue-founder-approval.test.sql; cat "tests/database/$suite"; } | sql
  elif [ "$suite" = catalogue-founder-approval.test.sql ]; then
    { echo "begin;"; pnpm exec tsx scripts/lib/catalogue-version-sql-fixture.ts; cat "tests/database/$suite"; } | sql
  elif [ "$suite" = full-closure-source-graph.test.sql ]; then
    { python3 tests/database/lib/full-closure-source-graph.py; cat "tests/database/$suite"; } | sql
  elif [ "$suite" = coverage-first-public-reports.test.sql ]; then
    python3 tests/database/lib/report-policy-phases.py current-program --directory "$phase_dir" | sql
  elif [ "$suite" = local-public-control-assessment-dispatch.test.sql ]; then
    # SQL-only sessions/MFA + stored owner/founder/operator policy events in the
    # owned fixture. No real Auth/SPIRE/key-service acceptance is claimed.
    { python3 tests/database/lib/local-public-control-assessment-dispatch-fixture.py; cat "tests/database/$suite"; } | docker exec -i "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -q > "$test_log" 2>&1 || { cat "$test_log"; exit 1; }
  else
    sql < "tests/database/$suite"
  fi
  printf '%s|%s\n' "$current_version" "$suite" >> "$phase_dir/executed-suites.txt"
done < <(python3 tests/database/lib/report-policy-phases.py current-list --directory "$phase_dir")
python3 tests/database/lib/report-policy-phases.py verify --directory "$phase_dir"
python3 tests/database/sudhaar-review-adoption-fixture.py | sql
bash tests/database/operator-workflows-public-source.sh "$container"
bash tests/database/concurrent-operator-workflows.sh "$container"
bash tests/database/concurrent-idempotency.sh "$container"
bash tests/database/concurrent-monitoring-durable-fires.sh "$container"
bash tests/database/concurrent-prativedan-assessment-drafts.sh "$container"
bash tests/database/concurrent-onboarding.sh "$container"
bash tests/database/concurrent-execution.sh "$container"
bash tests/database/concurrent-reviewed-approval.sh "$container"
bash tests/database/concurrent-approval-factor.sh "$container"
bash tests/database/concurrent-mfa-revocation.sh "$container"
bash tests/database/concurrent-mfa-replacement.sh "$container"
bash tests/database/concurrent-estate.sh "$container"
bash tests/database/concurrent-public-website-assets.sh "$container"
bash tests/database/concurrent-assessment-intake.sh "$container"
bash tests/database/concurrent-connector.sh "$container"
bash tests/database/concurrent-credential-vault.sh "$container"
bash tests/database/concurrent-proposal.sh "$container"
bash tests/database/concurrent-workload-task.sh "$container"
bash tests/database/concurrent-workload-assessment.sh "$container"
bash tests/database/concurrent-assessment-confirmation.sh "$container"
bash tests/database/concurrent-reviewed-assessment-source.sh "$container"
bash tests/database/concurrent-control-source-snapshots.sh "$container"
bash tests/database/concurrent-generic-agent-runs.sh "$container"
bash tests/database/concurrent-public-source-bindings.sh "$container"
bash tests/database/concurrent-public-source-observations.sh "$container"
bash tests/database/concurrent-public-source-reads.sh "$container"
bash tests/database/concurrent-public-source-reviews.sh "$container"
bash tests/database/concurrent-public-control-review-sets.sh "$container"
bash tests/database/public-control-assessment-sources.sh "$container"
bash tests/database/concurrent-public-control-review-assets.sh "$container"
bash tests/database/concurrent-local-custody-issuance.sh "$container" "$image"
bash tests/database/concurrent-local-public-control-assessment-dispatch.sh "$container" "$image"
bash tests/database/concurrent-local-custody-cancellation.sh "$container" "$image"
bash tests/database/concurrent-local-custody-mfa-time-contract.sh "$container" "$image"
bash tests/database/concurrent-assessment-dispatch.sh "$container"
bash tests/database/concurrent-assessment-scheduling.sh "$container"
bash tests/database/concurrent-assessment-retention.sh "$container"
bash tests/database/concurrent-dispatch-key-policy.sh "$container"
bash tests/database/concurrent-workload-registration.sh "$container"
bash tests/database/concurrent-controller-issuance.sh "$container"
bash tests/database/concurrent-invitation.sh "$container"
bash tests/database/concurrent-consent-notice.sh "$container"
bash tests/database/concurrent-evidence-ingestion.sh "$container"
bash tests/database/concurrent-evidence-pack.sh "$container"
bash tests/database/concurrent-approval-reconciliation.sh "$container"
# The deployed path: the runner reached by DSN over TCP, and the deploy
# entrypoint that calls it. Starts its own published-port container, because
# every higher environment is reached over a network rather than docker exec.
bash tests/database/estate-upgrade.sh "$container"
bash tests/database/mfa-upgrade.sh "$container"
bash tests/database/connector-upgrade.sh "$container"
bash tests/database/connector-lifecycle-upgrade.sh "$container"
bash tests/database/credential-vault-upgrade.sh "$container"
bash tests/database/gap-scan-upgrade.sh "$container"
bash tests/database/workload-task-upgrade.sh "$container"
bash tests/database/workload-assessment-upgrade.sh "$container"
bash tests/database/assessment-confirmation-upgrade.sh "$container"
bash tests/database/assessment-dispatch-upgrade.sh "$container"
bash tests/database/assessment-scheduling-upgrade.sh "$container"
bash tests/database/assessment-retention-upgrade.sh "$container"
bash tests/database/dispatch-key-policy-upgrade.sh "$container"
bash tests/database/workload-registration-upgrade.sh "$container"
bash tests/database/controller-issuance-upgrade.sh "$container"
bash tests/database/consent-notice-upgrade.sh "$container"
bash tests/database/evidence-ingestion-upgrade.sh "$container"
bash tests/database/evidence-pack-upgrade.sh "$container"
bash tests/database/sudhaar-review-adoption-upgrade.sh "$container"
# Bind the new race harness to this exact disposable container, never a retained stack.
sudhaar_race_evidence=$(mktemp -d)
python3 - "$container" "$sudhaar_race_evidence/proof.json" "$(pwd)" <<'PYPROOF'
import json,os,subprocess,sys
name,path,owner=sys.argv[1:]
item=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
with open(path,'w') as stream:
 json.dump({'containerId':item['Id'],'name':name,'ownerWorktree':owner,'project':'axiom-db-tests','database':'axiom_policy_test','loopbackPort':None},stream)
os.chmod(path,0o600)
PYPROOF
python3 -I tests/database/concurrent-sudhaar-settled-outputs.py --fixture-proof "$sudhaar_race_evidence/proof.json" --evidence "$sudhaar_race_evidence"
python3 -I tests/database/concurrent-sudhaar-review-adoption.py --fixture-proof "$sudhaar_race_evidence/proof.json" --evidence "$sudhaar_race_evidence/adoption"
python3 -I tests/database/concurrent-reviewed-workflow-drafts.py --fixture-proof "$sudhaar_race_evidence/proof.json" --evidence "$sudhaar_race_evidence/reviewed-workflows"
rm -rf "$sudhaar_race_evidence"
bash tests/database/migration-dsn.sh
echo "Database migrations and security assertions passed."
