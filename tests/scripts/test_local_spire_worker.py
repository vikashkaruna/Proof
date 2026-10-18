"""Dedicated local workload selector parity; never calls Docker."""

import ast
import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "local_spire_worker", ROOT / "scripts/local-spire.py"
)
spire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spire)
PARENT = f"spiffe://{spire.TRUST_DOMAIN}/spire/agent/join_token/local"


def entry(uid):
    return {
        "id": "reviewed-entry",
        "spiffe_id": {"path": "/agent/parikshan"},
        "parent_id": {"path": "/spire/agent/join_token/local"},
        "selectors": [{"type": "unix", "value": f"uid:{uid}"}],
    }


class WorkerIdentityTests(unittest.TestCase):
    def test_selector_matches_actual_fixed_supervisor_child_uid(self):
        # Host script checks run on Python 3.12; the runtime uses 3.14.
        # Parse the fixed assignment, not unrelated newer runtime syntax.
        source = (
            ROOT / "services/agent-runtime/src/axiom/assessment_supervisor.py"
        ).read_text()
        definitions = [
            line for line in source.splitlines() if line.startswith("WORKER_UID = ")
        ]
        self.assertEqual(len(definitions), 1)
        tree = ast.parse(definitions[0])
        assignments = {
            node.targets[0].id: ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.Assign)
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "WORKER_UID"
        }
        self.assertEqual(spire.ROLES["parikshan"][0], assignments["WORKER_UID"])
        self.assertEqual(spire.ROLES["parikshan"][0], 20003)
        self.assertEqual(spire.ROLES["controller"][0], 20103)
        self.assertEqual(
            len({uid for uid, _ in spire.ROLES.values()}), len(spire.ROLES)
        )

    def test_migration_changes_only_exact_old_worker_entry(self):
        with (
            patch.object(spire, "node_id", return_value=PARENT),
            patch.object(
                spire, "entries", side_effect=[[entry(20000)], [entry(20003)]]
            ),
            patch.object(spire, "run") as execute,
            patch("builtins.print"),
        ):
            spire.migrate_parikshan_uid()
        self.assertEqual(execute.call_count, 1)
        args = execute.call_args.args[0]
        self.assertIn("update", args)
        self.assertEqual(args[args.index("-entryID") + 1], "reviewed-entry")
        self.assertEqual(args[args.index("-selector") + 1], "unix:uid:20003")
        self.assertNotIn("unix:uid:20000", args)

    def test_unknown_selector_is_never_replaced(self):
        for uid in (0, 20103, 20102):
            with (
                patch.object(spire, "node_id", return_value=PARENT),
                patch.object(spire, "entries", return_value=[entry(uid)]),
                patch.object(spire, "run") as execute,
                self.assertRaises(RuntimeError),
            ):
                spire.migrate_parikshan_uid()
            execute.assert_not_called()

    def test_duplicate_or_foreign_parent_entry_is_never_changed(self):
        foreign = copy.deepcopy(entry(20000))
        foreign["parent_id"]["path"] = "/spire/agent/join_token/foreign"
        for entries in ([entry(20000), entry(20000)], [foreign], []):
            with (
                patch.object(spire, "node_id", return_value=PARENT),
                patch.object(spire, "entries", return_value=entries),
                patch.object(spire, "run") as execute,
                self.assertRaises(RuntimeError),
            ):
                spire.migrate_parikshan_uid()
            execute.assert_not_called()

    def test_already_migrated_entry_is_noop(self):
        with (
            patch.object(spire, "node_id", return_value=PARENT),
            patch.object(spire, "entries", return_value=[entry(20003)]),
            patch.object(spire, "run") as execute,
            patch("builtins.print"),
        ):
            spire.migrate_parikshan_uid()
        execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
