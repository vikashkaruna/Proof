#!/usr/bin/env bash
# Disposable database only: barriers prove transactions really overlap.
set -euo pipefail
container="$1"
result_dir=$(mktemp -d)
trap 'rm -rf "$result_dir"' EXIT
sql() { docker exec -i "$container" psql -X -U supabase_admin -d axiom_policy_test -v ON_ERROR_STOP=1 -Atq "$@"; }
sql <<'SQL'
create schema issuer_race;
create function issuer_race.id(n int) returns uuid language sql immutable as $$select ('74750000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function issuer_race.hash(v text) returns text language sql immutable security definer set search_path='' as $$select encode(pg_catalog.sha256(convert_to(v,'UTF8')),'hex')$$;
insert into public.tenants(id,slug,name) values(issuer_race.id(1),'issuer-race','Issuer race');
create table issuer_race.requests(n int primary key,body text);
insert into issuer_race.requests select n,jsonb_build_object('schemaVersion',1,'purpose','controller-backend-issue','credentialId',issuer_race.id(n),'tenantId',issuer_race.id(1),
 'configurationSha256',repeat('a',64),'approvalReference',issuer_race.id(n+100),'predecessorId',issuer_race.id(case when n in(11,12) then 10 when n=21 then 20 when n=31 then 30 end),
 'issuedAt',floor(extract(epoch from now())),'expiresAt',floor(extract(epoch from now()))+3600)::text
 from unnest(array[10,11,12,20,21,30,31,40]) n;
create function issuer_race.issue(n int) returns jsonb language sql as $$select controller_security.issue_credential(body,issuer_race.hash(body)) from issuer_race.requests where requests.n=$1$$;
create function issuer_race.retire(n int) returns jsonb language sql as $$
 with request as(select jsonb_build_object('schemaVersion',1,'purpose','controller-backend-revoke','credentialId',issuer_race.id(n),'tenantId',issuer_race.id(1),'configurationSha256',repeat('a',64),'approvalReference',issuer_race.id(n+200),'issuanceSha256',issuer_race.hash(body))::text body from issuer_race.requests where requests.n=$1)
 select controller_security.revoke_credential(body,issuer_race.hash(body)) from request$$;
grant usage on schema issuer_race to axiom_controller_issuer;
grant select on issuer_race.requests to axiom_controller_issuer;
grant execute on all functions in schema issuer_race to axiom_controller_issuer;
set role axiom_controller_issuer;
select issuer_race.issue(10),issuer_race.issue(20),issuer_race.issue(30);
SQL
barrier() {
 for attempt in $(seq 1 100); do
  if [ "$(sql -c "select count(*) from pg_stat_activity where application_name='$1' and $2='$3'")" = 1 ]; then return; fi
  sleep 0.05
 done
 echo 'Issuer concurrency barrier not reached'; exit 1
}
race() {
 sql -c "set application_name='issuer-first'; begin; set local role axiom_controller_issuer; $1; select pg_sleep(2); commit;" > "$result_dir/first" 2>&1 &
 local first_pid=$!
 barrier issuer-first wait_event PgSleep
 sql -c "set application_name='issuer-second'; set role axiom_controller_issuer; $2;" > "$result_dir/second" 2>&1 &
 local second_pid=$!
 barrier issuer-second wait_event_type Lock
 wait "$first_pid" || { cat "$result_dir/first"; exit 1; }
 if [ "$3" = success ]; then
  wait "$second_pid" || { cat "$result_dir/second"; exit 1; }
 else
  if wait "$second_pid"; then echo 'Forbidden concurrent issuance accepted'; exit 1; fi
  grep -q "$3" "$result_dir/second"
 fi
}
race 'select issuer_race.issue(40)' 'select issuer_race.issue(40)' success
[ "$(sql -c 'select count(*) from controller_security.issuances where credential_id=issuer_race.id(40)')" = 1 ]
race 'select issuer_race.issue(11)' 'select issuer_race.issue(12)' 'duplicate key'
[ "$(sql -c 'select count(*) from controller_security.credentials where id=issuer_race.id(12)')" = 0 ]
race 'select issuer_race.retire(20)' 'select issuer_race.issue(21)' 'predecessor unavailable'
[ "$(sql -c 'select count(*) from controller_security.credentials where id=issuer_race.id(21)')" = 0 ]
race 'select issuer_race.issue(31)' 'select issuer_race.retire(30)' success
[ "$(sql -c 'select revoked_at is null from controller_security.credentials where id=issuer_race.id(31)')" = t ]
[ "$(sql -c 'select revoked_at is not null from controller_security.credentials where id=issuer_race.id(30)')" = t ]
race 'select issuer_race.retire(40)' 'select issuer_race.retire(40)' success
[ "$(sql -c 'select count(*) from controller_security.revocations where credential_id=issuer_race.id(40)')" = 1 ]
echo 'Issuer concurrency: exact retries, competing successors and renewal/retirement in both orders serialize without orphan authority.'
