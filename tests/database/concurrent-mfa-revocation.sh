#!/usr/bin/env bash
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
first_pid=''
second_pid=''
barrier_open=false
cleanup() {
  if [ "$barrier_open" = true ]; then
    printf 'rollback;\n\\q\n' >&3 2>/dev/null || true
    exec 3>&-
  fi
  for worker_pid in "$first_pid" "$second_pid"; do
    if [ -n "$worker_pid" ]; then
      kill "$worker_pid" 2>/dev/null || true
      wait "$worker_pid" 2>/dev/null || true
    fi
  done
  rm -rf "$result_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000e1','mfa-race@test.invalid');
insert into public.users(id,email) values ('00000000-0000-4000-8000-0000000000e1','mfa-race@test.invalid');
insert into public.user_mfa_factors(id,user_id,factor_type,status,secret_encrypted) values
 ('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-0000000000e1','totp','active','sealed');
SQL
revoke="select public.revoke_totp_factor('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2')"
attest="insert into public.mfa_session_attestations(user_id,session_id,factor_id,expires_at) values ('00000000-0000-4000-8000-0000000000e1','racing-session','00000000-0000-4000-8000-0000000000e2',now()+interval '1 hour')"
for first in revoke attest; do
  sql -c "update public.user_mfa_factors set status='active',revoked_at=null where id='00000000-0000-4000-8000-0000000000e2'; delete from public.mfa_session_attestations where session_id='racing-session';"
  if [ "$first" = revoke ]; then before="$revoke"; after="$attest"; else before="$attest"; after="$revoke"; fi
  input="$result_dir/first-input"
  mkfifo "$input"
  sql < "$input" > "$result_dir/first" 2>&1 &
  first_pid=$!
  exec 3> "$input"
  barrier_open=true
  printf "set application_name='mfa-race-first'; begin; set local role service_role; %s;\n" "$before" >&3
  # Keep the first transaction open until its actual lock contender is observed.
  ready=false
  deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    first_backend_pid="$(sql -c "select pid from pg_stat_activity where application_name='mfa-race-first' and datname=current_database() and state='idle in transaction'")"
    if [[ "$first_backend_pid" =~ ^[0-9]+$ ]]; then ready=true; break; fi
    if ! kill -0 "$first_pid" 2>/dev/null; then break; fi
    sleep 0.05
  done
  [ "$ready" = true ] || { echo 'MFA race missed first barrier'; cat "$result_dir/first"; exit 1; }
  sql -c "set application_name='mfa-race-second'; set role service_role; $after;" 3>&- > "$result_dir/second" 2>&1 &
  second_pid=$!
  blocked=false
  deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(sql -c "select count(*) from pg_stat_activity contender where application_name='mfa-race-second' and datname=current_database() and wait_event_type='Lock' and $first_backend_pid=any(pg_blocking_pids(contender.pid))")" = 1 ]; then blocked=true; break; fi
    if ! kill -0 "$second_pid" 2>/dev/null; then break; fi
    sleep 0.05
  done
  [ "$blocked" = true ] || { echo 'MFA race did not contend on the factor'; cat "$result_dir/second"; exit 1; }
  printf 'commit;\n\\q\n' >&3
  exec 3>&-
  barrier_open=false
  wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
  first_pid=''
  if [ "$first" = revoke ]; then
    if wait "$second_pid"; then echo 'Late attestation was accepted'; exit 1; fi
    grep -q 'MFA session requires an active factor' "$result_dir/second"
  else
    wait "$second_pid"
  fi
  second_pid=''
  rm "$input"
  [ "$(sql -c "select count(*) from public.mfa_session_attestations where session_id='racing-session' and revoked_at is null")" = 0 ]
done
echo 'Concurrent MFA: either ordering of login and revocation leaves no live attestation.'
