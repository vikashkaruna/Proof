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
from lib.local_custody_credentials import issue_request  # noqa: E402

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
    args = dict(
        policy_text=TEXT,
        policy_sha256=SHA,
        activation_event_id="44444444-4444-4444-8444-444444444444",
        activation_epoch=1,
        configuration_sha256=POLICY["deploymentBindingSha256"],
        kind="producer",
        issued_at=1_800_000_000,
        reason="Local retained runtime",
    )
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
