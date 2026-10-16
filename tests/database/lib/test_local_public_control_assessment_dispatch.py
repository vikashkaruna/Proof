"""Offline147 fixture/observed-witness contracts. Never starts Docker or SQL."""

import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    if spec is None or spec.loader is None:
        raise RuntimeError("fixture_dependency_missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FIXTURE = load("local-public-control-assessment-dispatch-fixture.py")
RACES = load("local-public-control-assessment-dispatch-races.py")
BARRIER = RACES.BARRIER
TENANT = RACES.TENANT
ACTOR = "99134700-0000-4000-8000-000000000003"


class Local147(unittest.TestCase):
    def test_fixture_reuses_pinned_actual_capture_review_and_quorum(self):
        text = FIXTURE.setup()
        self.assertTrue(text.startswith("begin;"))
        self.assertNotIn("pg_temp.", text)
        self.assertNotIn("local147_fixture.local147_fixture", text)
        self.assertIn("immutable fixture catalogue differs", text)
        self.assertIn("record_local_custody_policy_event", text)
        self.assertIn("record_public_control_review_set", text)
        self.assertIn("record_public_website_asset_operation", text)
        self.assertIn("request2(81", text)
        self.assertNotIn(
            "insert into public.assessment_local_custody_authorizations", text
        )
        self.assertNotIn("arn:aws:", text)
        # The enqueue fixture must not take HEAD before the new policy actor
        # union locks. It derives input from retained bytes, not a prior resolve.
        enqueue = text.split("create function local147_fixture.enqueue", 1)[1]
        self.assertNotIn("resolve_public_control_assessment_source", enqueue)
        self.assertNotIn("commit;", text)

    def test_committed_template_requires_owned_name_and_actual_maintenance_actor(self):
        text = FIXTURE.setup(committed=True)
        self.assertIn("^axiom_proof_local_147_[a-f0-9]{12}_template$", text)
        self.assertIn("session_user<>'supabase_admin'", text)
        self.assertTrue(text.rstrip().endswith("commit;"))

    def test_modified_source_refused_before_sql_generation(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "tests/database"
            target.mkdir(parents=True)
            (target / "public-control-review-set.test.sql").write_text("forged")
            with self.assertRaisesRegex(ValueError, "reviewed_capture_fixture_changed"):
                FIXTURE.setup(root)

    def test_real_inverse_rows_and_original_deadline_cases_are_explicit(self):
        cases = RACES.scenarios()
        self.assertEqual(len(cases), 15)
        self.assertEqual(len({v["name"] for v in cases}), 15)
        by_name = {v["name"]: v for v in cases}
        self.assertTrue(
            by_name["new-before-actor-offboard"]["contract"].startswith(
                "custody147:row:membership:"
            )
        )
        self.assertTrue(
            by_name["new-before-source-withdraw"]["contract"].startswith(
                "custody147:row:user:"
            )
        )
        self.assertIn(
            "revoked_at=clock_timestamp()",
            by_name["credential-revoke-before-claim"]["holder"],
        )
        self.assertEqual(by_name["credential-revoke-before-claim"]["error"], "42501")
        for name in (
            "task-original-expiry-after-wait",
            "controller-original-expiry-after-wait",
        ):
            self.assertEqual(by_name[name]["mode"], "expires")
            self.assertIn("RACE_DEADLINE=", by_name[name]["contender"])
            self.assertEqual(by_name[name]["error"], "42501")
        self.assertNotIn("pg_sleep", repr(cases))

    def test_query_requires_canonical_ids_fixed_relations_and_exact_ctid_wait(self):
        query = BARRIER.custody147_probe_query(
            f"custody147:row:user:{TENANT}:{ACTOR}", 12, 13
        )
        self.assertIn("using(transactionid)", query)
        self.assertIn("pg_blocking_pids(13)", query)
        self.assertIn("l.locktype='tuple'", query)
        self.assertIn("target.ctid", query)
        self.assertIn("target.id='" + ACTOR, query)
        self.assertIn("public.users", query)
        self.assertIsNone(
            BARRIER.custody147_probe_query("custody145:tenant:" + TENANT, 12, 13)
        )
        for bad in (
            f"custody147:row:arbitrary:{TENANT}:{ACTOR}",
            f"custody147:row:user:{TENANT.replace('-4000-', '-0000-')}:{ACTOR}",
            "custody147:row:user:..:..",
            f"custody147:row:user:{TENANT}:{ACTOR};select 1",
        ):
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.custody147_probe_query(bad, 12, 13)
        for a, b in ((True, 13), (12, 12), (0, 13), (12, 2**31)):
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.custody147_probe_query(
                    f"custody147:row:user:{TENANT}:{ACTOR}", a, b
                )

    def test_all15_mode_contracts_retain_actual_witness_and_legacy_modes(self):
        cases = RACES.scenarios()
        self.assertEqual(len(cases), 15)
        for case in cases:
            contract, mode = case["contract"], case["mode"]
            if contract.startswith("custody147:"):
                BARRIER.validate_custody147_mode(contract, mode)
                query = BARRIER.custody147_probe_query(contract, 12, 13)
            else:
                self.assertTrue(contract.startswith("custody145:tenant:"))
                self.assertIn(mode, {"blocked", "expires"})
                query = BARRIER.custody145_probe_query(contract, 12, 13)
            self.assertIn("pg_blocking_pids(13)", query)
        contract = "custody147:engagement:" + TENANT
        self.assertEqual(
            BARRIER.custody147_probe_query(contract, 12, 13),
            BARRIER.review141_probe_query("review141:engagement:" + TENANT, 12, 13),
        )
        for mode in ("blocked", "expires"):
            BARRIER.validate_custody147_mode(contract, mode)
        for rejected_contract, mode in (
            (contract, "nonblocking"),
            (contract + ";select 1", "expires"),
            ("custody147:engagement:..", "blocked"),
            (f"custody147:row:user:{TENANT}:{ACTOR}", "expires"),
            (f"custody147:row:user:{TENANT}:{ACTOR}", "nonblocking"),
            ("review141:engagement:" + TENANT, "expires"),
        ):
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.validate_custody147_mode(rejected_contract, mode)

    def test_expiry_engagement_witness_requires_actual_pre_head_block(self):
        value = {
            "phase": "engagement",
            "holder": 12,
            "contender": 13,
            "blocked_by_holder": True,
            "holder_phase": True,
            "contender_phase": True,
            "contender_head": False,
            "locks": [],
        }
        self.assertEqual(BARRIER.validate_custody147_phase(value), value)
        for field in ("blocked_by_holder", "holder_phase", "contender_phase"):
            for missing in (False, True):
                bad = {**value}
                if missing:
                    del bad[field]
                else:
                    bad[field] = False
                with self.assertRaises(BARRIER.BarrierFailure):
                    BARRIER.validate_custody147_phase(bad)
        for missing in (False, True):
            bad = {**value}
            if missing:
                del bad["contender_head"]
            else:
                bad["contender_head"] = True
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.validate_custody147_phase(bad)
        query = BARRIER.custody147_probe_query(
            "custody147:engagement:" + TENANT, 12, 13
        )
        self.assertIn("using(transactionid)", query)
        self.assertIn("not waiter.granted", query)
        self.assertIn("owner.pid=12", query)
        self.assertIn("public.engagements", query)

    def test_original141_expiry_still_refuses_before_any_process(self):
        argv = [
            "barrier",
            "owned-disposable",
            "supabase_admin",
            "select 1",
            "select 2",
            "holder",
            "contender",
            "status",
            "expires",
            "error",
            "review141:engagement:" + TENANT,
        ]
        with (
            patch.object(sys, "argv", argv),
            patch.object(
                BARRIER.subprocess,
                "Popen",
                side_effect=AssertionError("must refuse before process creation"),
            ) as spawn,
            self.assertRaisesRegex(
                BARRIER.BarrierFailure, "Review141 proof requires blocked mode"
            ),
        ):
            BARRIER.main()
        spawn.assert_not_called()

    def witness(self):
        return {
            "phase": "row",
            "kind": "user",
            "tenant": TENANT,
            "actor": ACTOR,
            "holder": 12,
            "contender": 13,
            "blocked_by_holder": True,
            "transaction_wait": True,
            "exact_tuple": True,
            "holder_relation": True,
            "contender_relation": True,
            "locks": [
                {
                    "pid": 12,
                    "locktype": "transactionid",
                    "relation": None,
                    "page": None,
                    "tuple": None,
                    "mode": "ExclusiveLock",
                    "granted": True,
                    "transactionid": "456",
                },
                {
                    "pid": 13,
                    "locktype": "tuple",
                    "relation": "123",
                    "page": 0,
                    "tuple": 1,
                    "mode": "RowShareLock",
                    "granted": True,
                    "transactionid": None,
                },
                {
                    "pid": 13,
                    "locktype": "transactionid",
                    "relation": None,
                    "page": None,
                    "tuple": None,
                    "mode": "ShareLock",
                    "granted": False,
                    "transactionid": "456",
                },
            ],
        }

    def test_relation_presence_alone_cannot_qualify_row_witness(self):
        value = self.witness()
        self.assertEqual(BARRIER.validate_custody147_phase(value), value)
        for field in (
            "blocked_by_holder",
            "transaction_wait",
            "exact_tuple",
            "holder_relation",
            "contender_relation",
        ):
            bad = copy.deepcopy(value)
            bad[field] = False
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.validate_custody147_phase(bad)
        bad = copy.deepcopy(value)
        bad["locks"][0]["transactionid"] = "different"
        with self.assertRaises(BARRIER.BarrierFailure):
            BARRIER.validate_custody147_phase(bad)
        for kind in ("tuple", "transactionid"):
            bad = copy.deepcopy(value)
            bad["locks"] = [v for v in bad["locks"] if v["locktype"] != kind]
            with self.assertRaises(BARRIER.BarrierFailure):
                BARRIER.validate_custody147_phase(bad)

    def test_reciprocal_or_duplicate_counts_never_qualify(self):
        before = {
            "history": "exact",
            "violations": 0,
            "orphans": 0,
            "jobs": 1,
            "tasks": 1,
            "runs": 1,
            "sources": 1,
            "grants": 1,
            "ledger": 9,
            "claimed": 0,
        }
        case = next(c for c in RACES.scenarios() if c["name"] == "duplicate-enqueue")
        after = {
            **before,
            **{k: 2 for k in ("jobs", "tasks", "runs", "sources", "grants")},
            "ledger": 11,
        }
        RACES.validate(before, after, case)
        for field in (
            "history",
            "violations",
            "orphans",
            "grants",
            "ledger",
            "claimed",
        ):
            bad = {
                **after,
                field: "changed" if field == "history" else after[field] + 1,
            }
            with self.assertRaises(ValueError):
                RACES.validate(before, bad, case)


if __name__ == "__main__":
    unittest.main()
