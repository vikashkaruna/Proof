"""The verifier key must travel over TLS or the on-prem local DB socket."""

import importlib.util
import os
from pathlib import Path
from unittest import TestCase, mock


PATH = Path(__file__).resolve().parents[2] / "scripts/provision-reconciliation-key.py"
SPEC = importlib.util.spec_from_file_location("provision_reconciliation_key", PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProvisionReconciliationKeyTests(TestCase):
    def test_remote_plaintext_and_opportunistic_tls_are_refused(self):
        for mode in ("disable", "allow", "prefer"):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "requires TLS"):
                MODULE.dsn_environment(f"postgresql://admin:secret@db.example/postgres?sslmode={mode}")
        self.assertEqual(
            MODULE.dsn_environment("postgresql://admin:secret@db.example/postgres")["PGSSLMODE"],
            "require",
        )

    def test_onprem_socket_provisions_without_secret_in_argv(self):
        signing_key = "synthetic-signing-key-with-at-least-32-bytes"
        with mock.patch.dict(os.environ, {"APPROVAL_SIGNING_KEY": signing_key}, clear=True), \
             mock.patch("sys.argv", [str(PATH), "--container", "axiom-supabase-db"]), \
             mock.patch.object(MODULE.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.assertEqual(MODULE.main(), 0)
            command = run.call_args.args[0]
            self.assertEqual(command[:6], ["docker", "exec", "-i", "-u", "postgres", "axiom-supabase-db"])
            self.assertNotIn(signing_key, " ".join(command))
            self.assertNotIn("APPROVAL_SIGNING_KEY", run.call_args.kwargs["env"])
