"""Owned-disposable149 observed races. No retained database is accepted.

This module performs no transport at import time. Root executes the canonical
harness after source review; existing145 ownership checks and barrier budgets
are reused unchanged. Only nonce-owned databases are created/removed.
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
TENANT = "99143000-0000-4000-8000-000000000011"


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    if spec is None or spec.loader is None:
        raise RuntimeError("owned_fixture_dependency_unavailable")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


BASE = load("local-custody-issuance-races.py")
BARRIER = BASE.BARRIER


def setup(root):
    text = (
        root / "tests/database/local-custody-intent-cancellation.test.sql"
    ).read_text()
    if text.count("-- @local149_fixture_prefix_end") != 1:
        raise ValueError("exact149_fixture_prefix_required")
    prefix = text.split("-- @local149_fixture_prefix_end")[0]
    prefix = prefix.replace("pg_temp.", "local149_race.")
    prefix = prefix.replace(
        "begin;\n",
        "begin;\ncreate schema local149_race;\ngrant usage on schema local149_race to human_action_writer,service_role;\n",
        1,
    )
    return (
        prefix
        + """
create table local149_race.intents(name text primary key,original text not null,cancellation text not null,challenge uuid not null);
insert into local149_race.intents select 'new',local149_race.request(61,'request'),local149_race.cancellation(161,local149_race.request(61,'request')),local149_race.cancel_challenge(1,local149_race.cancellation(161,local149_race.request(61,'request')));
create function local149_race.original() returns jsonb language sql as $$select local149_race.write(original,1) from local149_race.intents where name='new'$$;
create function local149_race.cancel() returns jsonb language sql as $$select local149_race.cancel(cancellation,1,challenge) from local149_race.intents where name='new'$$;
set constraints all immediate;commit;
"""
    )


def scenarios():
    lock = f"select pg_advisory_xact_lock(hashtextextended('{TENANT}',47));"
    original = "select local149_race.original()"
    cancel = "select local149_race.cancel()"
    return [
        {
            "name": "original-before-cancel",
            "holder": original,
            "contender": cancel,
            "error": None,
            "counts": [1, 1, 1, 0, 1],
        },
        {
            "name": "cancel-before-original",
            "holder": cancel,
            "contender": original,
            "error": "23505",
            "counts": [0, 0, 0, 1, 1],
        },
        {
            "name": "duplicate-cancel",
            "holder": cancel,
            "contender": cancel,
            "error": None,
            "counts": [0, 0, 0, 1, 1],
        },
        {
            "name": "changed-original-key-body",
            "holder": cancel,
            "contender": "select local149_race.write(controller_security.canonical_questionnaire_json(original::jsonb||jsonb_build_object('reason','changed')),1) from local149_race.intents",
            "error": "23505",
            "counts": [0, 0, 0, 1, 1],
        },
        {
            "name": "actor-retired-before-cancel",
            "holder": lock
            + f"update public.tenant_users set role='viewer' where tenant_id='{TENANT}' and user_id='99143000-0000-4000-8000-000000000001'",
            "contender": cancel,
            "error": "42501",
            "counts": [0, 0, 0, 0, 0],
        },
        {
            "name": "original-mfa-expiry-after-wait",
            "holder": lock,
            "contender": "select 'RACE_DEADLINE='||expires_at::text from public.mfa_challenges where id=(select challenge from local149_race.intents);"
            + cancel,
            "error": "42501",
            "counts": [0, 0, 0, 0, 0],
            "mode": "expires",
        },
    ]


TABLES = (
    "local_custody_policy_versions",
    "local_custody_policy_events",
    "local_custody_policy_heads",
    "local_custody_intent_cancellations",
    "audit_ledger",
)
SNAPSHOT = (
    "select jsonb_build_object("
    + ",".join(
        "'"
        + table
        + "',(select jsonb_build_object('count',count(*),'sha',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex')) from public."
        + table
        + " t)"
        for table in TABLES
    )
    + ", 'violations',(select count(*) from public.verify_ledger('"
    + TENANT
    + "')))"
)


class Runner(BASE.Runner):
    def create(self, suffix, template):
        name = "axiom_proof_local_149_" + self.nonce + "_" + suffix
        if not re.fullmatch(r"axiom_proof_local_149_[a-f0-9]{12}_[a-z0-9]+", name):
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
        if case.get("mode") == "expires":
            self.sql(
                database,
                "update public.mfa_challenges set expires_at=clock_timestamp()+interval '5 seconds' where id=(select challenge from local149_race.intents)",
            )
        before = json.loads(self.sql(database, SNAPSHOT))
        history = self.sql(
            database,
            "select encode(sha256(convert_to(jsonb_agg(to_jsonb(t) order by name)::text,'UTF8')),'hex') from axiom_migrations.applied t",
        )
        self.owned()
        argv = [
            "barrier",
            self.cid,
            "supabase_admin",
            case["holder"],
            "begin;\\set VERBOSITY verbose\n" + case["contender"] + ";commit",
            str(folder / "holder.log"),
            str(folder / "contender.log"),
            str(folder / "status"),
            case.get("mode", "blocked"),
            "error" if case["error"] else "success",
            "custody145:tenant:" + TENANT,
            database,
        ]
        # psql meta-command must begin a new line, independent of coordinator SQL.
        argv[4] = argv[4].replace("begin;\\set", "begin;\n\\set")
        prior = sys.argv
        try:
            sys.argv = argv
            if BARRIER.main() != 0:
                raise RuntimeError("observed149race_failed")
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
        if after["violations"] != 0 or before["violations"] != 0:
            raise ValueError("ledger_chain_failed")
        for table, delta in zip(TABLES, case["counts"], strict=True):
            if after[table]["count"] != before[table]["count"] + delta or (
                delta == 0 and after[table] != before[table]
            ):
                raise ValueError("atomic149_outcome_failed")
        if history != self.sql(
            database,
            "select encode(sha256(convert_to(jsonb_agg(to_jsonb(t) order by name)::text,'UTF8')),'hex') from axiom_migrations.applied t",
        ):
            raise ValueError("migration_history_changed")
        self.sql(database, "set constraints all immediate;")
        print(
            json.dumps(
                {
                    "localCustody149RaceProof": {
                        "name": case["name"],
                        "observed": True,
                        "before": before,
                        "after": after,
                        "lockWitness": json.loads(witness.read_text()),
                        "expectedSqlState": case["error"],
                    }
                }
            ),
            flush=True,
        )


def main():
    if len(sys.argv) != 3:
        raise ValueError("owned_fixture_name_and_image_required")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="axiom-local149-races-") as raw:
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
        except BaseException:
            for log in sorted(Path(raw).rglob("*.log")):
                print(
                    log.name + ": " + log.read_text(errors="replace"), file=sys.stderr
                )
            raise
        finally:
            runner.cleanup()
    print("Local custody149: six observed races; owned databases removed.")


if __name__ == "__main__":
    main()
