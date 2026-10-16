"""Six owned-disposable150 observed cases. Import never starts transport.

Reuse unchanged145 ownership/process cleanup and actual47 barrier witnesses.
All caller-time/deadline data is synthetic fixture data, never a product gate.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TENANT = "99150000-0000-4000-8000-000000000011"


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    if spec is None or spec.loader is None:
        raise RuntimeError("owned_fixture_dependency_unavailable")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


PREVIOUS = load("local-custody-cancellation-races.py")
BASE = PREVIOUS.BASE
BARRIER = BASE.BARRIER
SNAPSHOT = PREVIOUS.SNAPSHOT.replace(PREVIOUS.TENANT, TENANT)


def setup(root):
    text = (
        root / "tests/database/local-custody-mfa-time-contract.test.sql"
    ).read_text()
    marker = (
        "-- Negative legacy clock constructions remain refused by the UNCHANGED writer."
    )
    if text.count(marker) != 1:
        raise ValueError("exact150_fixture_prefix_required")
    prefix = text.split(marker)[0].replace("pg_temp.", "local150_race.")
    prefix = prefix.replace(
        "begin;\n",
        "begin;\ncreate schema local150_race;\ngrant usage on schema local150_race to service_role,human_action_writer;\n",
        1,
    )
    return (
        prefix
        + """
create table local150_race.state(c uuid not null,q text not null,issued_id uuid,held_until timestamptz,transaction_started_at timestamptz);
insert into local150_race.state(c,q) select local150_race.issue(1,q),q from (select local150_race.request(71,'request') q) t;
-- Synthetic BFF proof stand-in: the native test charges one attempt; real
-- TOTP/recovery proof remains exclusively in the production BFF/browser tests.
update public.mfa_challenges set attempts=1 where id=(select c from local150_race.state);
create function local150_race.satisfy() returns jsonb language plpgsql as $$declare v jsonb;s local150_race.state;binding_digest text;prior text:=current_user;begin
 select * into s from local150_race.state;binding_digest:=local150_race.binding(s.q,1);set local role service_role;
 v:=public.satisfy_local_custody_mfa_challenge(local150_race.id(11),local150_race.id(1),local150_race.id(101),local150_race.id(41),local150_race.id(71),binding_digest,s.c,1,'totp');
 execute format('set local role %I',prior);return v;
 exception when others then execute format('set local role %I',prior);raise;end$$;
create function local150_race.consume() returns jsonb language plpgsql as $$declare v jsonb;s local150_race.state;binding_digest text;prior text:=current_user;begin
 select * into s from local150_race.state;binding_digest:=local150_race.binding(s.q,1);set local role service_role;
 v:=public.consume_local_custody_mfa_challenge(local150_race.id(11),local150_race.id(1),local150_race.id(101),local150_race.id(41),local150_race.id(71),binding_digest,s.c,1,local150_race.id(71));
 execute format('set local role %I',prior);return v;
 exception when others then execute format('set local role %I',prior);raise;end$$;
create function local150_race.issue_after_release() returns uuid language plpgsql as $$declare v_issued_id uuid;begin
 -- No fixture pre-lock: the actual issue RPC itself must block on47.
 v_issued_id:=local150_race.issue(1,local150_race.request(81,'request'));
 update local150_race.state set issued_id=v_issued_id;return v_issued_id;
end$$;
set constraints all immediate;commit;
"""
    )


def scenarios():
    lock = f"select pg_advisory_xact_lock(hashtextextended('{TENANT}',47));"
    return [
        {
            "name": "issue-after-observed-release",
            "holder": lock,
            "contender": "update local150_race.state set held_until=clock_timestamp()+interval '2 seconds',transaction_started_at=transaction_timestamp();select local150_race.ok(transaction_started_at<held_until and held_until>clock_timestamp(),'fresh issue deadline before direct RPC') from local150_race.state;select 'RACE_DEADLINE='||held_until::text from local150_race.state;select local150_race.issue_after_release()",
            "error": None,
            "satisfied": False,
            "consumed": False,
            "issue": True,
            "mode": "expires",
        },
        {
            "name": "single-satisfaction-winner",
            "holder": "select local150_race.satisfy()",
            "contender": "select local150_race.satisfy()",
            "error": "42501",
            "satisfied": True,
            "consumed": False,
        },
        {
            "name": "single-consumption-winner",
            "prepareSatisfied": True,
            "holder": "select local150_race.consume()",
            "contender": "select local150_race.consume()",
            "error": "42501",
            "satisfied": True,
            "consumed": True,
        },
        {
            "name": "expiry-after-actual-wait",
            "holder": lock,
            "contender": "select 'RACE_DEADLINE='||expires_at::text from public.mfa_challenges where id=(select c from local150_race.state);select local150_race.satisfy()",
            "error": "42501",
            "satisfied": False,
            "consumed": False,
            "mode": "expires",
        },
        {
            "name": "factor-retirement-after-actual-wait",
            "prepareSatisfied": True,
            "holder": lock
            + "update public.user_mfa_factors set status='revoked',revoked_at=clock_timestamp() where id='99150000-0000-4000-8000-000000000041'",
            "contender": "select local150_race.consume()",
            "error": "42501",
            "satisfied": True,
            "consumed": False,
        },
        {
            "name": "session-retirement-after-actual-wait",
            "prepareSatisfied": True,
            "holder": lock
            + "update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='99150000-0000-4000-8000-000000000101'",
            "contender": "select local150_race.consume()",
            "error": "42501",
            "satisfied": True,
            "consumed": False,
        },
    ]


def validate_outcome(case, value, before, after):
    if before != after or after["violations"] != 0:
        raise ValueError("unrelated_authority_or_ledger_changed")
    if (
        value["satisfied"] is not case["satisfied"]
        or value["consumed"] is not case["consumed"]
    ):
        raise ValueError("exact_one_winner_state_required")
    if value["originalExpiryUnchanged"] is not True:
        raise ValueError("original_expiry_changed")
    if case.get("issue") and (
        value["deadlineAfterTransactionStart"] is not True
        or value["issuedAfterHeldDeadline"] is not True
        or value["issuedAfterTransactionStart"] is not True
        or value["exactTtl"] is not True
    ):
        raise ValueError("post_held_deadline_db_clock_required")


class Runner(PREVIOUS.Runner):
    def create(self, suffix, template):
        name = "axiom_proof_local_150_" + self.nonce + "_" + suffix
        if not re.fullmatch(r"axiom_proof_local_150_[a-f0-9]{12}_[a-z0-9]+", name):
            raise ValueError("owned_database_name_refused")
        if (
            self.sql(
                "postgres",
                "select count(*) from pg_database where datname='" + name + "'",
            )
            != "0"
        ):
            raise ValueError("preexisting_database_refused")
        self.databases.append(name)
        self.run(
            ["exec", self.cid, "createdb", "-U", "supabase_admin", "-T", template, name]
        )
        return name

    def race(self, database, case, index):
        folder = self.directory / f"{index:02d}-{case['name']}"
        folder.mkdir(mode=0o700)
        if case.get("prepareSatisfied"):
            self.sql(database, "select local150_race.satisfy()")
        if case["name"] == "expiry-after-actual-wait":
            self.sql(
                database,
                "update public.mfa_challenges set expires_at=clock_timestamp()+interval '2 seconds' where id=(select c from local150_race.state)",
            )
        original_expiry = self.sql(
            database,
            "select expires_at::text from public.mfa_challenges where id=(select c from local150_race.state)",
        )
        before = json.loads(self.sql(database, SNAPSHOT))
        history_sql = "select encode(sha256(convert_to(jsonb_agg(to_jsonb(t) order by name)::text,'UTF8')),'hex') from axiom_migrations.applied t"
        history = self.sql(database, history_sql)
        self.owned()
        argv = [
            "barrier",
            self.cid,
            "supabase_admin",
            case["holder"],
            "begin;\n\\set VERBOSITY verbose\n" + case["contender"] + ";commit",
            str(folder / "holder.log"),
            str(folder / "contender.log"),
            str(folder / "status"),
            case.get("mode", "blocked"),
            "error" if case["error"] else "success",
            "custody145:tenant:" + TENANT,
            database,
        ]
        prior = sys.argv
        try:
            sys.argv = argv
            if BARRIER.main() != 0:
                raise RuntimeError("observed150race_failed")
        finally:
            sys.argv = prior
        if case["error"] and not re.search(
            r"ERROR:\s+" + case["error"] + r"\b", (folder / "contender.log").read_text()
        ):
            raise ValueError("exact_expected_sqlstate_required")
        witness = folder / "holder.log.lock-proof.json"
        if not witness.is_file():
            raise ValueError("actual47_lock_witness_required")
        after = json.loads(self.sql(database, SNAPSHOT))
        outcome_sql = (
            """select jsonb_build_object('satisfied',c.satisfied_at is not null,'consumed',c.consumed_at is not null,'originalExpiryUnchanged',c.expires_at::text='"""
            + original_expiry
            + """','deadlineAfterTransactionStart',s.transaction_started_at<s.held_until,'issuedAfterHeldDeadline',i.created_at>=s.held_until,'issuedAfterTransactionStart',i.created_at>s.transaction_started_at,'exactTtl',i.expires_at-i.created_at=interval '300000 milliseconds') from local150_race.state s join public.mfa_challenges c on c.id=s.c left join public.mfa_challenges i on i.id=s.issued_id"""
        )
        value = json.loads(self.sql(database, outcome_sql))
        validate_outcome(case, value, before, after)
        if history != self.sql(database, history_sql):
            raise ValueError("migration_history_changed")
        print(
            json.dumps(
                {
                    "localCustody150RaceProof": {
                        "name": case["name"],
                        "observed": True,
                        "expectedSqlState": case["error"],
                        "outcome": value,
                        "lockWitness": json.loads(witness.read_text()),
                        "authorityAndLedgerUnchanged": True,
                        "migrationHistoryUnchanged": True,
                    }
                }
            ),
            flush=True,
        )


def main():
    if len(sys.argv) != 3:
        raise ValueError("owned_fixture_name_and_image_required")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="axiom-local150-races-") as raw:
        runner = Runner(sys.argv[1], sys.argv[2], Path(raw))
        try:
            template = runner.create("template", "axiom_policy_test")
            runner.sql(template, setup(BASE.OWNER))
            for index, case in enumerate(scenarios()):
                database = runner.create(str(index), template)
                runner.race(database, case, index)
                runner.run(
                    ["exec", runner.cid, "dropdb", "-U", "supabase_admin", database]
                )
                runner.databases.remove(database)
        finally:
            runner.cleanup()
    print("Local custody150: six observed races; owned databases removed.")


if __name__ == "__main__":
    main()
