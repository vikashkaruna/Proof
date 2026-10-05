"""Bounded acceptance cannot convert reachability or component replies into clearance."""

import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "agent_acceptance", ROOT / "scripts/run-agent-acceptance.py"
)
acceptance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acceptance)
REVISION = "a" * 40
TENANT = "11111111-1111-4111-8111-111111111111"
CORRELATION = "22222222-2222-4222-8222-222222222222"
ENGAGEMENT = "33333333-3333-4333-8333-333333333333"


def manifest():
    return {
        "schemaVersion": 1,
        "bffOrigin": "http://127.0.0.1:4439",
        "expectedRevision": REVISION,
        "tenantId": TENANT,
        "isolation": "disposable-local-fixture",
        "humanRequestReference": "test:user-request-reference",
        "invocations": [
            {
                "agent": "sudhaar",
                "input": {
                    "engagement_id": ENGAGEMENT,
                    "correlation_id": CORRELATION,
                    "findings": [{"id": "source-finding-1"}],
                },
            }
        ],
    }


def result(agent="sudhaar"):
    return {
        "agent": agent,
        "correlation_id": CORRELATION,
        "status": "succeeded",
        "error": None,
        "output": {
            "actions": [
                {
                    "closes_finding_id": "source-finding-1",
                    "rollback": {"validatedExecutable": False},
                }
            ]
        },
        "ledger_entry_ids": ["71", "72"],
    }


def audit():
    base = {
        "actor_type": "agent",
        "actor_id": "sudhaar",
        "tenant_id": TENANT,
        "correlation_id": CORRELATION,
        "input_hash": "1" * 64,
        "detail": {"run_id": ENGAGEMENT, "request_hash": "4" * 64, "phase": "started"},
    }
    return {
        "entries": [
            {**base, "id": 71, "sequence_no": 71, "result": "pending"},
            {
                **base,
                "id": 72,
                "sequence_no": 72,
                "result": "success",
                "output_hash": "2" * 64,
                "detail": {
                    "started_entry": "71",
                    "run_id": ENGAGEMENT,
                    "request_hash": "4" * 64,
                    "phase": "completed",
                },
            },
            {
                "id": 70,
                "sequence_no": 70,
                "action_type": "agent.invocation.requested",
                "target_ref": ENGAGEMENT,
                "tenant_id": TENANT,
                "correlation_id": CORRELATION,
                "input_hash": "4" * 64,
                "actor_type": "human",
                "actor_id": "test-human",
                "result": "pending",
            },
            {
                "id": 73,
                "sequence_no": 73,
                "action_type": "agent.invocation.settled",
                "target_ref": ENGAGEMENT,
                "tenant_id": TENANT,
                "correlation_id": CORRELATION,
                "input_hash": "4" * 64,
                "actor_type": "system",
                "actor_id": "bff-generic-agent-controller",
                "result": "success",
                "output_hash": "2" * 64,
                "detail": {
                    "requested_by": "test-human",
                    "agent": "sudhaar",
                    "runtime_outcome": "receipt_confirmed",
                    "started_receipt": "71",
                    "completed_receipt": "72",
                },
            },
        ]
    }


class AgentAcceptanceTests(unittest.TestCase):
    def test_post_transport_sends_reviewed_request_key_and_credential_headers_once(self):
        response = Mock(status=200)
        response.read.return_value = b'{"ok":true}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(acceptance, "build_opener", return_value=opener):
            self.assertEqual(
                acceptance.request_json(
                    "http://127.0.0.1:4439/v1/agents/lekha/run",
                    body={"operation": "verify", "correlation_id": CORRELATION},
                    token="fictional-bearer-credential",
                    tenant=TENANT,
                    idempotency_key=CORRELATION.upper(),
                ),
                (200, {"ok": True}),
            )
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Idempotency-key"), CORRELATION)
        self.assertEqual(request.get_header("X-tenant-id"), TENANT)
        self.assertEqual(
            request.get_header("Authorization"), "Bearer fictional-bearer-credential"
        )

    def test_post_missing_or_invalid_key_refused_before_network(self):
        with patch.object(acceptance, "build_opener") as build:
            for key in (None, "", "invalid", "unsafe\r\nheader:value"):
                with self.subTest(key=key), self.assertRaises(acceptance.Refused):
                    acceptance.request_json(
                        "http://127.0.0.1:4439/v1/agents/lekha/run",
                        body={"operation": "verify"},
                        idempotency_key=key,
                    )
            build.assert_not_called()

    def test_transport_failure_never_retries_or_changes_request_key(self):
        opener = Mock()
        opener.open.side_effect = URLError("fictional timeout")
        with (
            patch.object(acceptance, "build_opener", return_value=opener),
            self.assertRaisesRegex(acceptance.Refused, "transport_unconfirmed"),
        ):
            acceptance.request_json(
                "http://127.0.0.1:4439/v1/agents/lekha/run",
                body={"operation": "verify", "correlation_id": CORRELATION},
                idempotency_key=CORRELATION,
            )
        opener.open.assert_called_once()
        self.assertEqual(
            opener.open.call_args.args[0].get_header("Idempotency-key"), CORRELATION
        )

    def test_rejects_remote_origins_and_credential_or_path_origins(self):
        for value in (
            "https://localhost:4439",
            "http://example.org:4439",
            "http://user:secret@localhost:4439",
            "http://localhost:4439/v1",
            "http://localhost:4439?token=secret",
            "http://localhost:4439#fragment",
        ):
            with self.subTest(value=value), self.assertRaises(acceptance.Refused):
                acceptance.origin(value)

    def test_accepts_explicit_loopback_origins(self):
        for value in (
            "http://localhost:4439",
            "http://127.0.0.1:4439",
            "http://[::1]:4439/",
        ):
            self.assertTrue(acceptance.origin(value))

    def test_manifest_requires_recorded_request_isolation_and_revision(self):
        for key, replacement in (
            ("isolation", "selected-stable"),
            ("expectedRevision", "main"),
            ("humanRequestReference", ""),
            ("schemaVersion", 2),
        ):
            value = manifest()
            value[key] = replacement
            with self.subTest(key=key), self.assertRaises(acceptance.Refused):
                acceptance.validate_manifest(value)

    def test_mutating_and_dedicated_workflow_agents_never_enter_generic_runner(self):
        for agent in set(acceptance.AGENTS) - acceptance.SUPPORTED:
            value = manifest()
            value["invocations"][0]["agent"] = agent
            with self.subTest(agent=agent), self.assertRaises(acceptance.Refused):
                acceptance.validate_manifest(value)

    def test_cross_tenant_and_privileged_input_refused(self):
        for key, replacement in (
            ("tenant_id", ENGAGEMENT),
            ("approvalToken", {}),
            ("dispatch_context", {}),
            ("password", "fictional"),
        ):
            value = manifest()
            value["invocations"][0]["input"][key] = replacement
            with self.subTest(key=key), self.assertRaises(acceptance.Refused):
                acceptance.validate_manifest(value)

    def test_empty_compute_cannot_claim_real_work(self):
        for agent, inputs in (
            ("parikshan", {"answers": {}}),
            ("sudhaar", {"findings": []}),
        ):
            value = manifest()
            value["invocations"][0]["agent"] = agent
            value["invocations"][0]["input"].update(inputs)
            with self.subTest(agent=agent), self.assertRaises(acceptance.Refused):
                acceptance.validate_manifest(value)

    def test_duplicates_and_missing_correlation_refused_before_dispatch(self):
        value = manifest()
        value["invocations"].append(copy.deepcopy(value["invocations"][0]))
        with self.assertRaises(acceptance.Refused):
            acceptance.validate_manifest(value)
        value = manifest()
        del value["invocations"][0]["input"]["correlation_id"]
        with self.assertRaises(acceptance.Refused):
            acceptance.validate_manifest(value)

    def test_partial_ledger_verification_refused(self):
        value = manifest()
        value["invocations"][0] = {
            "agent": "lekha",
            "input": {
                "operation": "verify",
                "from_sequence": 99,
                "correlation_id": CORRELATION,
            },
        }
        with self.assertRaises(acceptance.Refused):
            acceptance.validate_manifest(value)

    def test_private_manifest_mode_and_review_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            raw = json.dumps(manifest()).encode()
            path.write_bytes(raw)
            path.chmod(0o600)
            reviewed = hashlib.sha256(raw).hexdigest()
            self.assertEqual(acceptance.load_manifest(path, reviewed), manifest())
            with self.assertRaises(acceptance.Refused):
                acceptance.load_manifest(path, "b" * 64)
            path.chmod(0o644)
            with self.assertRaises(acceptance.Refused):
                acceptance.load_manifest(path, reviewed)

    def test_health_is_exact_revision_and_strict(self):
        for field, replacement in (
            ("revision", "b" * 40),
            ("authMode", "dev"),
            ("status", "unhealthy"),
        ):
            health = {"status": "ok", "revision": REVISION, "authMode": "strict"}
            health[field] = replacement
            with self.subTest(field=field), self.assertRaises(acceptance.Refused):
                acceptance.assert_health(
                    "http://localhost:4439",
                    REVISION,
                    lambda _url, selected=health: (200, selected),
                )

    def test_no_post_when_target_revision_mismatches(self):
        calls = []

        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            return 200, {"status": "ok", "authMode": "strict", "revision": "b" * 40}

        with self.assertRaises(acceptance.Refused):
            acceptance.run_manifest(manifest(), "fictional-bearer-credential", fetch)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("body", calls[0][1])

    def test_agent_or_correlation_mismatch_not_completed(self):
        for key, replacement in (
            ("agent", "parikshan"),
            ("correlation_id", ENGAGEMENT),
            ("status", "failed"),
            ("error", "runtime_failure"),
            ("output", None),
        ):
            value = result()
            value[key] = replacement
            with self.subTest(key=key):
                self.assertNotEqual(
                    acceptance.classify_output("sudhaar", CORRELATION, 200, value),
                    "runtime_completed_domain_acceptance_pending",
                )

    def test_uncomposed_source_outputs_never_pass_even_successful_transport(self):
        for agent in ("nazar", "sanket"):
            value = result(agent)
            self.assertEqual(
                acceptance.classify_output(agent, CORRELATION, 200, value),
                "trusted_public_capture_missing",
            )

    def source_output(self, agent):
        observation = {
            "requested_url": "https://www.meity.gov.in/"
            if agent == "nazar"
            else "https://axiomminds.ai/",
            "final_url": "https://www.meity.gov.in/"
            if agent == "nazar"
            else "https://axiomminds.ai/",
            "checked_at": "2026-10-05T06:00:00Z",
            "content_sha256": "5" * 64,
            "projection_sha256": "6" * 64,
            "capture_reference": ENGAGEMENT,
            "requires_human_review": True,
        }
        out = {
            "processing_mode": "verified_public_capture_review",
            "source_observations": [observation],
        }
        if agent == "nazar":
            observation["baseline_status"] = "first_capture_baseline"
            out.update(sources_checked=["www.meity.gov.in"], changes=[])
        else:
            out.update(signals=[], high_intent=[])
        return out

    def test_processor_contracts_describe_required_uncomposed_source_authority(self):
        for agent in ("nazar", "sanket"):
            workflow, proof = acceptance.CONTRACTS[agent]
            self.assertIn("capture_processor", workflow)
            self.assertNotIn("stub", proof.lower())
            self.assertIn("HTTP", proof)

    def test_no_captures_cannot_become_source_or_runtime_completion(self):
        for agent in ("nazar", "sanket"):
            response = result(agent)
            response["output"] = self.source_output(agent)
            response["output"]["source_observations"] = []
            self.assertEqual(
                acceptance.classify_output(agent, CORRELATION, 200, response),
                "trusted_public_capture_missing",
            )

    def test_pure_component_and_wrapped_component_never_grant_http_acceptance(self):
        for agent in ("nazar", "sanket"):
            component = self.source_output(agent)
            self.assertEqual(
                acceptance.classify_output(agent, CORRELATION, 200, component),
                "runtime_unconfirmed",
            )
            response = result(agent)
            response["output"] = component
            self.assertEqual(
                acceptance.classify_output(agent, CORRELATION, 200, response),
                "source_processor_http_composition_pending",
            )

    def test_component_reply_and_audit_still_leave_all_agent_and_http_acceptance_pending(
        self,
    ):
        value = manifest()
        value["invocations"] = [
            {
                "agent": "nazar",
                "input": {"correlation_id": CORRELATION, "sources": ["meity.gov.in"]},
            }
        ]
        response = result("nazar")
        response["output"] = self.source_output("nazar")
        evidence = audit()
        evidence["entries"][0]["actor_id"] = "nazar"
        evidence["entries"][1]["actor_id"] = "nazar"
        evidence["entries"][3]["detail"]["agent"] = "nazar"

        def fetch(url, **kwargs):
            if url.endswith("/health"):
                return 200, {"status": "ok", "authMode": "strict", "revision": REVISION}
            if "/ledger?" in url:
                return 200, evidence
            return 200, response

        receipt = acceptance.run_manifest(value, "fictional-bearer-credential", fetch)
        self.assertFalse(receipt["allAgentEndToEndAccepted"])
        self.assertEqual(
            receipt["receipts"][0]["status"],
            "source_processor_http_composition_pending",
        )

    def test_source_hash_review_flag_government_origin_and_checked_hosts_required(self):
        for field, replacement in (
            ("content_sha256", "bad"),
            ("capture_reference", "bad"),
            ("requires_human_review", False),
            ("checked_at", "2026-10-05"),
            ("final_url", "https://unapproved.ai/"),
        ):
            response = result("nazar")
            response["output"] = self.source_output("nazar")
            response["output"]["source_observations"][0][field] = replacement
            self.assertEqual(
                acceptance.classify_output("nazar", CORRELATION, 200, response),
                "source_capture_provenance_refused",
            )
        response = result("nazar")
        response["output"] = self.source_output("nazar")
        response["output"]["source_observations"][0]["requested_url"] = (
            "https://axiomminds.ai/"
        )
        response["output"]["source_observations"][0]["final_url"] = (
            "https://axiomminds.ai/"
        )
        response["output"]["sources_checked"] = ["axiomminds.ai"]
        self.assertEqual(
            acceptance.classify_output("nazar", CORRELATION, 200, response),
            "source_capture_provenance_refused",
        )
        response = result("nazar")
        response["output"] = self.source_output("nazar")
        response["output"]["sources_checked"] = []
        self.assertEqual(
            acceptance.classify_output("nazar", CORRELATION, 200, response),
            "source_capture_provenance_refused",
        )

    def test_processor_results_cannot_promote_legal_or_buying_intent_claims(self):
        response = result("nazar")
        response["output"] = self.source_output("nazar")
        response["output"]["changes"] = [
            {"affected_control_ids": ["DPDPA-GOV-001"], "severity": "critical"}
        ]
        self.assertEqual(
            acceptance.classify_output("nazar", CORRELATION, 200, response),
            "source_review_claim_refused",
        )
        response = result("sanket")
        response["output"] = self.source_output("sanket")
        signal = {
            "source": ENGAGEMENT,
            "company": "axiomminds.ai",
            "signal": "public_dpo_heading",
            "score": 100,
        }
        response["output"]["signals"] = [signal]
        self.assertEqual(
            acceptance.classify_output("sanket", CORRELATION, 200, response),
            "source_review_claim_refused",
        )
        signal["score"] = 0
        response["output"]["high_intent"] = [signal]
        self.assertEqual(
            acceptance.classify_output("sanket", CORRELATION, 200, response),
            "source_review_claim_refused",
        )

    def test_audit_missing_duplicate_or_invalid_receipts_refused(self):
        for ids in ([], ["71"], ["71", "71"], ["secret-token", "72"]):
            value = result()
            value["ledger_entry_ids"] = ids
            self.assertEqual(
                acceptance.classify_output("sudhaar", CORRELATION, 200, value),
                "audit_completion_unconfirmed",
            )

    def test_no_forged_validated_rollback_from_proposal(self):
        value = result()
        value["output"]["actions"][0]["rollback"]["validatedExecutable"] = True
        self.assertEqual(
            acceptance.classify_output("sudhaar", CORRELATION, 200, value),
            "proposal_or_rollback_refused",
        )

    def test_empty_findings_and_broken_ledger_refused(self):
        value = result("parikshan")
        value["output"] = {"findings": []}
        self.assertEqual(
            acceptance.classify_output("parikshan", CORRELATION, 200, value),
            "meaningful_output_missing",
        )
        value = result("lekha")
        value["output"] = {"operation": "verify", "intact": False}
        self.assertEqual(
            acceptance.classify_output("lekha", CORRELATION, 200, value),
            "ledger_integrity_not_confirmed",
        )

    def test_durable_audit_binding_rejects_foreign_missing_and_failed_rows(self):
        self.assertTrue(
            acceptance.verify_audit_readback(
                "sudhaar", CORRELATION, TENANT, result(), 200, audit()
            )
        )
        for key, replacement in (
            ("actor_id", "parikshan"),
            ("tenant_id", ENGAGEMENT),
            ("correlation_id", ENGAGEMENT),
            ("result", "failure"),
            ("input_hash", "3" * 64),
            ("output_hash", None),
            ("detail", {"started_entry": "69"}),
        ):
            value = audit()
            value["entries"][1][key] = replacement
            with self.subTest(key=key):
                self.assertFalse(
                    acceptance.verify_audit_readback(
                        "sudhaar", CORRELATION, TENANT, result(), 200, value
                    )
                )
        self.assertFalse(
            acceptance.verify_audit_readback(
                "sudhaar", CORRELATION, TENANT, result(), 200, {"entries": []}
            )
        )

    def test_recorded_human_request_and_ordered_settlement_required(self):
        for field, replacement in (
            ("sequence_no", 69),
            ("result", "failure"),
            ("input_hash", "8" * 64),
        ):
            value = audit()
            value["entries"][3][field] = replacement
            with self.subTest(field=field):
                self.assertFalse(
                    acceptance.verify_audit_readback(
                        "sudhaar", CORRELATION, TENANT, result(), 200, value
                    )
                )
        value = audit()
        value["entries"] = value["entries"][:2]
        self.assertFalse(
            acceptance.verify_audit_readback(
                "sudhaar", CORRELATION, TENANT, result(), 200, value
            )
        )
        value = audit()
        value["entries"][3]["detail"]["requested_by"] = "forged-human"
        self.assertFalse(
            acceptance.verify_audit_readback(
                "sudhaar", CORRELATION, TENANT, result(), 200, value
            )
        )

    def test_success_is_bounded_runtime_and_audit_not_all_agent_clearance(self):
        calls = []

        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith("/health"):
                return 200, {"status": "ok", "authMode": "strict", "revision": REVISION}
            if "/ledger?" in url:
                return 200, audit()
            return 200, result()

        value = acceptance.run_manifest(
            manifest(), "fictional-bearer-credential", fetch
        )
        self.assertFalse(value["allAgentEndToEndAccepted"])
        self.assertEqual(
            value["receipts"][0]["status"],
            "runtime_completed_domain_acceptance_pending",
        )
        self.assertEqual(len([item for item in calls if "body" in item[1]]), 1)
        post = next(item for item in calls if "body" in item[1])
        self.assertEqual(post[1]["idempotency_key"], CORRELATION)
        self.assertEqual(
            value["receipts"][0]["inputSha256"],
            acceptance.digest(manifest()["invocations"][0]["input"]),
        )

    def test_transport_failure_never_retries_post(self):
        calls = []

        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith("/health"):
                return 200, {"status": "ok", "authMode": "strict", "revision": REVISION}
            raise acceptance.Refused("transport_unconfirmed")

        value = acceptance.run_manifest(
            manifest(), "fictional-bearer-credential", fetch
        )
        self.assertEqual(value["receipts"][0]["status"], "transport_unconfirmed")
        self.assertFalse(value["allAgentEndToEndAccepted"])
        self.assertEqual(len([item for item in calls if "body" in item[1]]), 1)
        post = next(item for item in calls if "body" in item[1])
        self.assertEqual(post[1]["idempotency_key"], CORRELATION)

    def test_missing_durable_audit_and_changed_source_cannot_complete(self):
        def fetch(url, **kwargs):
            if url.endswith("/health"):
                return 200, {"status": "ok", "authMode": "strict", "revision": REVISION}
            if "/ledger?" in url:
                return 200, {"entries": []}
            return 200, result()

        value = acceptance.run_manifest(
            manifest(), "fictional-bearer-credential", fetch
        )
        self.assertEqual(
            value["receipts"][0]["status"], "durable_audit_readback_unconfirmed"
        )

        def foreign(url, **kwargs):
            if "/ledger?" in url:
                return 200, audit()
            if url.endswith("/health"):
                return fetch(url, **kwargs)
            response = result()
            response["output"]["actions"][0]["closes_finding_id"] = (
                "foreign-source-finding"
            )
            return 200, response

        value = acceptance.run_manifest(
            manifest(), "fictional-bearer-credential", foreign
        )
        self.assertEqual(
            value["receipts"][0]["status"], "proposal_source_binding_refused"
        )

    def test_probe_only_get_and_lists_twelve_including_dedicated_pramaan(self):
        calls = []

        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith("/agents"):
                return 200, {
                    "agents": [
                        {"name": agent}
                        for agent in acceptance.AGENTS
                        if agent != "pramaan"
                    ]
                }
            return 200, {"status": "ok", "authMode": "strict", "revision": REVISION}

        value = acceptance.probe(
            "http://localhost:4000",
            "http://localhost:8000",
            "http://localhost:8001",
            REVISION,
            fetch,
        )
        self.assertFalse(value["allAgentEndToEndAccepted"])
        self.assertEqual(len(value["agents"]), 12)
        pramaan = next(item for item in value["agents"] if item["agent"] == "pramaan")
        self.assertEqual(pramaan["workflow"], "closure_dossier_workflow")
        self.assertFalse(pramaan["runtimeRegistered"])
        self.assertTrue(all(not kwargs for _, kwargs in calls))

    def test_private_receipt_location_modes_freshness_and_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = root / ".axiom-runtime/review/all-agent-acceptance/proof.json"
            acceptance.write_private(
                {"allAgentEndToEndAccepted": False}, destination, root
            )
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(destination.parent.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(acceptance.Refused):
                acceptance.write_private({}, destination, root)
            with self.assertRaises(acceptance.Refused):
                acceptance.write_private({}, root / "public.json", root)
            linked = destination.parent / "linked.json"
            linked.symlink_to(root / "outside.json")
            with self.assertRaises(acceptance.Refused):
                acceptance.write_private({}, linked, root)

    def test_redirect_does_not_send_bearer_elsewhere(self):
        with self.assertRaises(acceptance.Refused):
            acceptance.NoRedirect().redirect_request(
                None, None, 302, "", {}, "http://example.org"
            )


if __name__ == "__main__":
    unittest.main()
