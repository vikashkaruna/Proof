#!/usr/bin/env bash
# W0.1 — the migration runner reached over the network, as a deployed database is.
#
# `--container` covers the local Docker path. Every higher environment is
# reached by DSN instead, and that path had no coverage at all: preprod applied
# migrations through `migrate-cloudsql.sh`, which swallowed failures and printed
# a tick anyway. This proves the runner behaves over TCP exactly as it does over
# `docker exec` — applies once, refuses changed history, and FAILS when it fails.
set -euo pipefail
cd "$(dirname "$0")/../.."

image="${AXIOM_TEST_POSTGRES_IMAGE:-supabase/postgres:17.6.1.127}"
container="axiom-dsn-test-$$"
workdir=$(mktemp -d)
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$workdir"; }
trap cleanup EXIT

docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
# Published on loopback only; a test database must not be reachable off-host.
# A password, because a deployed database has one and the DSN path must carry
# it without ever putting it in argv. Published on loopback only.
db_password='dsn-test-p@ss word'
docker run --rm -d --name "$container" -p 127.0.0.1:0:5432 \
  -e POSTGRES_PASSWORD="$db_password" "$image" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null
port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$port" ] || { echo 'No published port'; exit 1; }

docker exec "$container" createdb -U postgres axiom_dsn_test
# The password is percent-encoded in the URL, which also exercises the decoding
# the runner does before handing it to libpq.
encoded='dsn-test-p%40ss%20word'
base="postgresql://postgres:${encoded}@127.0.0.1:${port}/axiom_dsn_test"
# sslmode=disable: this container serves plaintext. The runner defaults to
# `require`, which is the point of the next assertion.
dsn="${base}?sslmode=disable"
PGPASSWORD="$db_password" psql -w "$dsn" -v ON_ERROR_STOP=1 -q -f tests/database/bootstrap.sql

# ─── TLS is required unless the caller opts out ──────────────────────
# A deployed database is reached over a network the runner does not own, so
# inheriting libpq's `prefer` (which silently falls back to plaintext) is not
# acceptable. Same DSN without sslmode must therefore be refused by this
# plaintext-only server.
if python3 scripts/migrate-database.py --dsn "$base" >/dev/null 2>&1; then
  echo 'FAIL: connected without TLS when no sslmode was given'
  exit 1
fi
echo '  ✓ TLS required by default'

# ─── Malformed DSNs are refused before anything runs ─────────────────
for bad in "mysql://u:p@h/db" "postgres://u:p@/db" "postgres://u:p@h"; do
  if python3 scripts/migrate-database.py --dsn "$bad" >/dev/null 2>&1; then
    echo "FAIL: accepted malformed DSN $bad"; exit 1
  fi
done
echo '  ✓ Malformed DSNs refused'

# ─── The series applies ──────────────────────────────────────────────
cp -R infra/supabase/migrations "$workdir/migrations"
expected=$(ls "$workdir"/migrations/*.sql | wc -l | tr -d ' ')
applied=$(python3 scripts/migrate-database.py --dsn "$dsn" --migrations "$workdir/migrations" \
  | grep -c '^Applying:')
[ "$applied" = "$expected" ] || { echo "FAIL: applied ${applied} of ${expected}"; exit 1; }
echo "  ✓ Applied ${applied} migrations over TCP"

# ─── Re-running is a no-op, not a re-application ─────────────────────
again=$(python3 scripts/migrate-database.py --dsn "$dsn" --migrations "$workdir/migrations" \
  | grep -c '^Applying:' || true)
[ "$again" = "0" ] || { echo "FAIL: re-applied ${again} migrations"; exit 1; }
echo '  ✓ Re-run applies nothing'

# ─── Changed history is refused ──────────────────────────────────────
printf '\n-- tampered\n' >> "$workdir/migrations/0001_init_tenants_users.sql"
if python3 scripts/migrate-database.py --dsn "$dsn" --migrations "$workdir/migrations" >/dev/null 2>&1; then
  echo 'FAIL: an edited applied migration was accepted'
  exit 1
fi
echo '  ✓ Edited history refused'

# ─── A failing migration exits non-zero ──────────────────────────────
# The defect this whole file exists for: migrate-cloudsql.sh ran each file,
# swallowed the error twice, and printed a tick regardless.
git checkout -- infra/supabase/migrations 2>/dev/null || true
rm -rf "$workdir/migrations"; cp -R infra/supabase/migrations "$workdir/migrations"
printf '\nselect 1/0;\n' >> "$workdir/migrations/9999_deliberate_failure.sql"
if python3 scripts/migrate-database.py --dsn "$dsn" --migrations "$workdir/migrations" >/dev/null 2>&1; then
  echo 'FAIL: a failing migration reported success'
  exit 1
fi
echo '  ✓ A failing migration exits non-zero'

# ─── The deploy entrypoint is fail-closed too ────────────────────────
# migrate-cloudsql.sh is what the GCP pipeline actually calls. Its previous
# version swallowed every failure and printed a tick, so these assertions are
# about it refusing rather than about it working.
export AXIOM_DB_WAIT_ATTEMPTS=1 AXIOM_DB_WAIT_SECONDS=1

if ./scripts/migrate-cloudsql.sh >/dev/null 2>&1; then
  echo 'FAIL: ran with no connection URL'; exit 1
fi
echo '  ✓ Refuses with no connection URL'

if ./scripts/migrate-cloudsql.sh --skip-seeds \
     "postgresql://postgres:x@127.0.0.1:1/nope?sslmode=disable" >/dev/null 2>&1; then
  echo 'FAIL: an unreachable database reported success'; exit 1
fi
echo '  ✓ Refuses an unreachable database'

# Against the live one it succeeds, and is idempotent.
./scripts/migrate-cloudsql.sh --skip-seeds "$dsn" >/dev/null
./scripts/migrate-cloudsql.sh --skip-seeds "$dsn" >/dev/null
echo '  ✓ Applies and re-applies cleanly against a live database'

# The control-library seed is required, not best-effort: without the Supabase
# service endpoint it must refuse rather than report a seeded library.
if SUPABASE_URL='' SUPABASE_SERVICE_KEY='' ./scripts/migrate-cloudsql.sh "$dsn" >/dev/null 2>&1; then
  echo 'FAIL: reported success without seeding the control library'; exit 1
fi
echo '  ✓ Refuses to skip the statutory control library silently'

# Fixed-password persona logins never land in production.
if ENVIRONMENT=production ./scripts/migrate-cloudsql.sh --seed-identities "$dsn" >/dev/null 2>&1; then
  echo 'FAIL: seeded fixed-password identities into production'; exit 1
fi
echo '  ✓ Refuses fixed-password identities in production'

echo 'Migration runner over DSN: TLS enforced, applied once, history immutable, failures fatal.'
echo 'Deploy entrypoint: refuses without a URL, without a database, and without the control library.'
