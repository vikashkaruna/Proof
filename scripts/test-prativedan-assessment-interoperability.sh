#!/usr/bin/env bash
# Real synthetic PostgreSQL -> Python renderer -> TypeScript verification.
# Creates only its own disposable GitHub-hosted fixture; no retained database.
set -euo pipefail
# Bind all CLI/subprocess calls to the isolated runner daemon.
unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
cd "$(dirname "$0")/.."
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
  echo 'This fixture requires an isolated GitHub-hosted runner.' >&2
  exit 1
fi
fixture_dir="$(pwd -P)/.axiom-runtime/contracts/prativedan-assessment-v2"
if [ -e "$fixture_dir" ]; then
  echo 'Refusing to replace existing contract evidence.' >&2
  exit 1
fi
mkdir -p .axiom-runtime/contracts
mkdir -m 700 "$fixture_dir"
container="axiom-prativedan-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
image="${AXIOM_TEST_POSTGRES_IMAGE:?pinned PostgreSQL fixture image required}"
created_id=''
cleanup() {
  if [ -n "$created_id" ]; then
    # Remove only the immutable ID returned by our successful creation, including
    # its anonymous image volume. Never prune or use a shared stack/name prefix.
    docker rm -f -v "$created_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
created_id=$(docker create --name "$container" \
  --label com.axiom.fixture=database-policy-test \
  --label com.axiom.fixture.project=axiom-db-tests \
  --label "com.axiom.owner-worktree=$(pwd)" \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image")
docker start "$created_id" >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$created_id" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$created_id" pg_isready -h 127.0.0.1 -U postgres >/dev/null
bash tests/database/prativedan-assessment-codec-fixture.sh "$container" "$fixture_dir"
pnpm exec tsx scripts/check-prativedan-assessment-interoperability.ts "$fixture_dir"
