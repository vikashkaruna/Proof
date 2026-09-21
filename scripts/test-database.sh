#!/usr/bin/env bash
# Disposable, real PostgreSQL integration tests. Never connects to an existing DB.
set -euo pipefail
cd "$(dirname "$0")/.."
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
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -f "$test_log"; }
trap cleanup EXIT
docker run --rm -d --name "$container" -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null
docker exec "$container" createdb -U postgres axiom_policy_test
sql() {
  if ! docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -q >"$test_log" 2>&1; then
    cat "$test_log"
    return 1
  fi
}
sql < tests/database/bootstrap.sql
python3 scripts/migrate-database.py --container "$container" --user postgres --database axiom_policy_test
bash tests/database/migration-runner.sh "$container"
# Prove the ordinary managed service role, not the Supabase image's implicit
# superuser-like RLS bypass. Only this disposable container is modified.
docker exec "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -q -c "alter role service_role nobypassrls;"
for suite in tests/database/*.test.sql; do
  echo "Testing $(basename "$suite")"
  sql < "$suite"
done
bash tests/database/concurrent-idempotency.sh "$container"
bash tests/database/concurrent-onboarding.sh "$container"
bash tests/database/concurrent-execution.sh "$container"
bash tests/database/concurrent-reviewed-approval.sh "$container"
bash tests/database/concurrent-mfa-revocation.sh "$container"
bash tests/database/concurrent-mfa-replacement.sh "$container"
bash tests/database/concurrent-estate.sh "$container"
bash tests/database/concurrent-connector.sh "$container"
bash tests/database/concurrent-proposal.sh "$container"
# The deployed path: the runner reached by DSN over TCP, and the deploy
# entrypoint that calls it. Starts its own published-port container, because
# every higher environment is reached over a network rather than docker exec.
bash tests/database/estate-upgrade.sh "$container"
bash tests/database/mfa-upgrade.sh "$container"
bash tests/database/connector-upgrade.sh "$container"
bash tests/database/connector-lifecycle-upgrade.sh "$container"
bash tests/database/gap-scan-upgrade.sh "$container"
bash tests/database/migration-dsn.sh
echo "Database migrations and security assertions passed."
