#!/usr/bin/env bash
# A forged first contender and a legitimate signer race for one batch.
set -euo pipefail
container="${1:?disposable database container required}"
database="${2:-axiom_policy_test}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

docker exec -i "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -q \
  < tests/database/approval-reconciliation-race.fixture.sql > /dev/null

tenant='10000000-0000-4000-8000-000000000010'
plan='10000000-0000-4000-8000-000000000030'
batch='10000000-0000-4000-8000-000000000070'
statement="(public.prepare_plan_reconciliation('$tenant','$plan','$batch')->>'statement')"
forged="select public.record_plan_reconciliation('$tenant','$plan','$batch',gen_random_uuid(),$statement,repeat('b',64))->>'error';"
signed="select public.record_plan_reconciliation('$tenant','$plan','$batch',gen_random_uuid(),$statement,encode(hmac(convert_to($statement,'UTF8'),convert_to('test-reconciliation-signing-key-0123456789','UTF8'),'sha256'),'hex'))->'reconciliation'->>'id';"

docker exec "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -At -c "$forged" \
  > "$tmp_dir/forged" 2> "$tmp_dir/forged.err" &
forged_pid=$!
docker exec "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -At -c "$signed" \
  > "$tmp_dir/signed" 2> "$tmp_dir/signed.err" &
signed_pid=$!
wait "$forged_pid" || { cat "$tmp_dir/forged.err"; exit 1; }
wait "$signed_pid" || { cat "$tmp_dir/signed.err"; exit 1; }

if [ "$(cat "$tmp_dir/forged")" != 'reconciliation_signature_unverified' ]; then
  echo 'Forged contender was not refused.' >&2
  exit 1
fi
if ! grep -Eq '^[0-9a-f-]{36}$' "$tmp_dir/signed"; then
  echo 'Legitimate signer did not win the only reconciliation slot.' >&2
  exit 1
fi
proof="$(docker exec "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -At -c "
  select count(*)=1 and min(statement_signature)=encode(hmac(convert_to(min(statement),'UTF8'),
    convert_to('test-reconciliation-signing-key-0123456789','UTF8'),'sha256'),'hex')
  from public.plan_reconciliations where tenant_id='$tenant' and batch_id='$batch';")"
ledger="$(docker exec "$container" psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1 -At -c "
  select count(*) from public.audit_ledger where tenant_id='$tenant'
  and action_type='execution.reconciliation.recorded' and detail->>'batch_id'='$batch';")"
if [ "$proof" != 't' ] || [ "$ledger" != '1' ]; then
  echo 'Race did not leave exactly one verified row and one success ledger event.' >&2
  exit 1
fi
echo 'Concurrent forged/valid reconciliation: one HMAC-verified row and one ledger event.'
