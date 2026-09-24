#!/usr/bin/env bash
# Two sessions race to accept one invitation token, and two sessions race to
# invite the same address. Each race must yield exactly one committed outcome.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U postgres -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
tenant='00000000-0000-4000-8000-00000000c1e2'
owner='00000000-0000-4000-8000-00000000c1e1'
invitee='00000000-0000-4000-8000-00000000c1e3'
sql <<SQL
insert into auth.users(id,email,email_confirmed_at) values ('$owner','invite-race-owner@test.invalid',now()),('$invitee','invite-race@test.invalid',now());
insert into public.users(id,email) values ('$owner','invite-race-owner@test.invalid');
insert into public.tenants(id,slug,name) values ('$tenant','invite-race','Invite race');
insert into public.tenant_users(tenant_id,user_id,role) values ('$tenant','$owner','owner');
SQL
hash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

race() { # $1 label, $2 statement run by both sessions; the first holds its transaction open
  sql -c "set application_name='$1-first'; begin; set local role service_role; select $2; select pg_sleep(3); commit;" > "$result_dir/$1-first" 2>&1 &
  local first_pid=$! ready=false blocked=false
  for attempt in $(seq 1 60); do
    [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1-first' and wait_event='PgSleep'")" = 1 ] && { ready=true; break; }
    sleep 0.05
  done
  [ "$ready" = true ] || { echo "$1 race missed barrier"; cat "$result_dir/$1-first"; exit 1; }
  sql -c "set application_name='$1-second'; set role service_role; select $2;" > "$result_dir/$1-second" 2>&1 &
  local second_pid=$!
  for attempt in $(seq 1 40); do
    [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1-second' and wait_event_type='Lock'")" = 1 ] && { blocked=true; break; }
    sleep 0.05
  done
  [ "$blocked" = true ] || { echo "$1 race did not contend"; cat "$result_dir/$1-second"; exit 1; }
  wait "$first_pid"; wait "$second_pid"
}

create="public.create_tenant_invitation('$tenant','$owner','invite-race@test.invalid','viewer','{}',encode(gen_random_bytes(32),'hex'),72,false,gen_random_uuid())"
race create "$create"
grep -q '"invitation"' "$result_dir/create-first"
grep -q 'invitation_open' "$result_dir/create-second"
[ "$(sql -c "select count(*) from public.tenant_invitations where tenant_id='$tenant'")" = 1 ]

token=$(hash accept-race-token)
sql <<SQL
insert into public.tenant_invitations(tenant_id,email,role,token_hash,invited_by,expires_at)
  select '$tenant','invite-race-2@test.invalid','reviewer','$token','$owner',now()+interval '1 day';
update auth.users set email='invite-race-2@test.invalid' where id='$invitee';
SQL
accept="public.accept_tenant_invitation('$token','$invitee',gen_random_uuid())"
race accept "$accept"
grep -q '"replayed": false' "$result_dir/accept-first"
grep -q '"replayed": true' "$result_dir/accept-second"
[ "$(sql -c "select count(*) from public.tenant_users where tenant_id='$tenant' and user_id='$invitee'")" = 1 ]
[ "$(sql -c "select count(*) from public.audit_ledger where tenant_id='$tenant' and action_type='tenant.invitation.accepted'")" = 1 ]
echo 'Concurrent invitations: one open invitation per address; one acceptance, membership and audit event.'
