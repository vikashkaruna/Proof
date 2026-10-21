"""Issue requests built by scripts/lib/local_custody_credentials.py must pass the
protected issuer's own request() validator unchanged."""

import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.local_custody_credentials import issue_request

_spec = importlib.util.spec_from_file_location(
    "axiom_local_custody_issuer", ROOT / "infra/local-custody-issuer/issuer.py"
)
issuer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(issuer)

TENANT = "fd5e0001-0000-4000-8000-000000000001"
POLICY = {
    "version": 1,
    "policyId": "cdd59617-ebbb-4988-8fb2-fc00dcda4379",
    "tenantId": TENANT,
    "mode": "operator_managed",
    "nominatedOperatorId": "33333333-3333-4333-8333-333333333333",
    "targetWorkloadId": "ce5ae6ce-cae4-4a5e-a8ab-8e08591b9e61",
    "servicePrincipals": {
        "producer": "spiffe://local.axiomproof.test/service/assessment-dispatch-producer",
        "controller": "spiffe://local.axiomproof.test/controller/assessment",
    },
    "deploymentBindingSha256": "9d8a4425d945217d023c35b3a4559469127c81cf904ff8867209b8f15b7ebe12",
}
TEXT = json.dumps(POLICY, sort_keys=True, separators=(",", ":"))
SHA = hashlib.sha256(TEXT.encode()).hexdigest()


def build(**over):
    args = {
        "policy_text": TEXT,
        "policy_sha256": SHA,
        "activation_event_id": "44444444-4444-4444-8444-444444444444",
        "activation_epoch": 1,
        "configuration_sha256": POLICY["deploymentBindingSha256"],
        "kind": "producer",
        "issued_at": 1_800_000_000,
        "reason": "Local retained runtime",
    }
    args.update(over)
    return issue_request(**args)


class IssueRequestTest(unittest.TestCase):
    def test_every_kind_passes_the_issuer_validator(self):
        for kind in ("operator", "producer", "controller"):
            raw, digest = build(kind=kind)
            value = issuer.request(raw, digest, "issue")
            self.assertEqual(value["principalKind"], kind)
            self.assertEqual(value["tenantId"], TENANT)
            self.assertEqual(value["expiresAt"] - value["issuedAt"], 3600)
        operator = issuer.request(*build(kind="operator"), "issue")
        self.assertEqual(operator["servicePrincipal"], "operator:" + POLICY["nominatedOperatorId"])
        self.assertEqual(operator["operatorId"], POLICY["nominatedOperatorId"])
        controller = issuer.request(*build(kind="controller"), "issue")
        self.assertIsNone(controller["operatorId"])
        self.assertEqual(controller["servicePrincipal"], POLICY["servicePrincipals"]["controller"])

    def test_renewal_names_its_predecessor(self):
        predecessor = "55555555-5555-4555-8555-555555555555"
        value = issuer.request(*build(predecessor_id=predecessor), "issue")
        self.assertEqual(value["predecessorId"], predecessor)

    def test_refuses_mismatched_inputs_before_the_issuer(self):
        with self.assertRaises(ValueError):
            build(policy_sha256="0" * 64)
        with self.assertRaises(ValueError):
            build(configuration_sha256="1" * 64)
        with self.assertRaises(ValueError):
            build(kind="key_service")
        with self.assertRaises(ValueError):
            build(lifetime_s=90000)

    def test_issuer_refuses_a_tampered_request(self):
        raw, digest = build()
        with self.assertRaises(ValueError):
            issuer.request(raw.replace(b'"producer"', b'"controller"', 1), digest, "issue")


if __name__ == "__main__":
    unittest.main()


class RenewalTiming(unittest.TestCase):
    """renew-due decides from the last published request's own expiry."""

    def test_due_inside_the_margin_and_after_expiry(self):
        from lib.local_custody_credentials import renewal_due

        now = 1_800_000_000
        self.assertFalse(renewal_due(now + 1201, now))
        self.assertTrue(renewal_due(now + 1200, now))
        self.assertTrue(renewal_due(now - 5, now))
        for margin in (59, 3600, 0):
            with self.assertRaises(ValueError):
                renewal_due(now + 10, now, margin)

    def test_expiry_is_read_only_from_the_named_credentials_request(self):
        from lib.local_custody_credentials import last_expiry

        raw, _ = build(credential_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        value = json.loads(raw)
        self.assertEqual(last_expiry(raw, value["credentialId"]), value["expiresAt"])
        with self.assertRaises(ValueError):
            last_expiry(raw, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        for bad in ({**value, "purpose": "other"}, {**value, "expiresAt": "soon"}, {**value, "expiresAt": True}):
            with self.assertRaises(ValueError):
                last_expiry(json.dumps(bad).encode(), value["credentialId"])

    def test_cli_picks_only_due_kinds_and_refuses_an_unreadable_expiry(self):
        import tempfile

        spec = importlib.util.spec_from_file_location("lcc_cli", ROOT / "scripts/local-custody-credentials.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for kind, issued in (("producer", 1_800_000_000), ("controller", 1_800_002_000)):
                raw, _ = build(kind=kind, issued_at=issued)
                cid = json.loads(raw)["credentialId"]
                (base / f"{kind}.last").write_text(cid)
                (base / f"{cid}.request.json").write_bytes(raw)
            # producer expires at +3600 (due at +2400); controller at +5600.
            self.assertEqual(cli.due_kinds(base, 1_800_002_400, 1200), ["producer"])
            self.assertEqual(cli.due_kinds(base, 1_800_002_399, 1200), [])
            self.assertEqual(cli.due_kinds(base, 1_800_004_400, 1200), ["producer", "controller"])
            (base / "controller.last").write_text("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
            with self.assertRaises(SystemExit):
                cli.due_kinds(base, 1_800_000_000, 1200)


class ExactIssuanceResume(unittest.TestCase):
    def test_uncertain_issue_resumes_same_request_and_never_replaces_pending(self):
        import subprocess
        import tempfile
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("custody_resume_cli", ROOT / "scripts/local-custody-credentials.py")
        cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "settings.json").write_text("{}")
            (root / "settings.sha256").write_text(POLICY["deploymentBindingSha256"])
            policy = {"policyText": TEXT, "policySha256": SHA, "activationEventId": "44444444-4444-4444-8444-444444444444", "epoch": 1}
            calls = []
            def issuer_run(args, **_kwargs):
                calls.append(args)
                target = Path(args[-1]); target.mkdir(mode=0o700, exist_ok=True)
                (target / "backend.key").write_text("synthetic-fixture")
                if len(calls) == 1:raise subprocess.CalledProcessError(1, args)
            with patch.object(cli, "ISSUER_ROOT", root), patch.object(cli, "tenant_alias", return_value="fixture"), patch.object(cli, "active_policy", return_value=policy), patch.object(cli, "validate_manifest"), patch.object(cli.subprocess, "run", side_effect=issuer_run):
                with self.assertRaises(subprocess.CalledProcessError):cli.issue(TENANT, "controller", False)
                base = root / "credentials" / TENANT
                pending = json.loads((base / "controller.pending.json").read_text())
                request = (base / (pending["credentialId"] + ".request.json")).read_bytes()
                with self.assertRaisesRegex(ValueError, "Uncertain"):
                    cli.issue(TENANT, "controller", False)
                self.assertEqual(len(calls), 1)
                cli.issue(TENANT, "controller", False, pending["credentialId"])
                self.assertIn("--resume-issue", calls[1])
                self.assertEqual(calls[0][-1], calls[1][-1])
                self.assertEqual((base / (pending["credentialId"] + ".request.json")).read_bytes(), request)
                self.assertFalse((base / "controller.pending.json").exists())
                self.assertEqual((base / "controller.last").read_text(), pending["credentialId"])
