"""Pure synthetic setup generator; never executes SQL or provisions resources.

The real145 fixture's reviewed quorum/MFA/issuance prefix is retained verbatim
except for namespacing its temporary helpers. Only the owned disposable race
coordinator may commit it. This does not establish real Auth or live issuer TLS.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

FIXTURE_SHA256 = "7de87d1180367a7effeda680e639ade5a8829319cf4f34e2b08a3f1e6646caac"
SCHEMA = "local145_race"
OPERATOR = "axiom_local_custody_145_fixture_operator"
BRIDGE = "axiom_local_custody_145_fixture_bridge"


def setup(source: Path) -> str:
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != FIXTURE_SHA256:
        raise ValueError("reviewed145fixture_changed")
    text = raw.decode("utf8").split("-- No direct registry, ledger", 1)[0]
    if (
        not text.startswith("-- STAGED/UNEXECUTED.")
        or text.count("insert into issuer145_saved") != 3
    ):
        raise ValueError("reviewed145prefix_boundary_changed")
    text = text.replace(
        "begin;\n",
        """begin;
do $owned145$begin
 if current_database() !~ '^axiom_proof_local_145_[a-f0-9]{12}_template$'
  or current_user <> 'supabase_admin' or session_user <> 'supabase_admin'
  or not exists(select 1 from pg_roles where rolname=current_user and rolsuper)
 then raise exception 'owned145 synthetic template only' using errcode='42501';end if;
end $owned145$;
create schema local145_race;
grant usage on schema local145_race to human_action_writer;
""",
        1,
    )
    text = text.replace("pg_temp.", SCHEMA + ".")
    text = text.replace("create temporary table ", "create table ")
    for name in ("custody_saved", "issuer145_clock", "issuer145_saved"):
        text = re.sub(r"\b" + name + r"\b", SCHEMA + "." + name, text)
    # The reviewed write() helper changes role before evaluating id(). Unlike
    # pg_temp, this persistent owned namespace needs explicit narrow access.
    text = text.replace(
        "create table local145_race.custody_saved",
        "grant execute on function local145_race.id(int) to human_action_writer;\n"
        "create table local145_race.custody_saved",
        1,
    )
    return (
        text
        + """
create table local145_race.requests(name text primary key,body text not null);
insert into local145_race.requests select 'existing',request_text from local145_race.issuer145_saved where kind='controller';
insert into local145_race.requests values
 ('new',local145_race.issue145(204)),
 ('successor_a',local145_race.issue145(205,'controller',local145_race.id(201))),
 ('successor_b',local145_race.issue145(206,'controller',local145_race.id(201))),
 ('revoke',local145_race.revoke145((select body from local145_race.requests where name='existing')));
create function local145_race.issue(name text) returns jsonb language sql as $$
 select controller_security.issue_local_custody_credential(body,encode(sha256(convert_to(body,'UTF8')),'hex')) from local145_race.requests where requests.name=$1$$;
create function local145_race.retire() returns jsonb language sql as $$
 select controller_security.revoke_local_custody_credential(body,encode(sha256(convert_to(body,'UTF8')),'hex')) from local145_race.requests where name='revoke'$$;
create function local145_race.policy_revoke() returns jsonb language sql as $$
 select local145_race.write(local145_race.request(64,'revoke',(select (v->>'eventId')::uuid from local145_race.custody_saved where kind='activate')),1)$$;
revoke all on schema local145_race from public;
revoke all on all tables in schema local145_race from public;
revoke all on all functions in schema local145_race from public;
grant usage on schema local145_race to axiom_local_custody_issuer;
grant select on local145_race.requests to axiom_local_custody_issuer;
grant execute on function local145_race.issue(text),local145_race.retire() to axiom_local_custody_issuer;
set constraints all immediate;
do $owned145_roles$begin
 execute format('comment on role axiom_local_custody_145_fixture_operator is %L','axiom-local145-race:'||current_database());
 execute format('comment on role axiom_local_custody_145_fixture_bridge is %L','axiom-local145-race:'||current_database());
end $owned145_roles$;
commit;
"""
    )


if __name__ == "__main__":
    print(
        setup(
            Path(__file__).resolve().parents[1]
            / "local-custody-credential-issuance.test.sql"
        )
    )
