"""Local, fail-closed agent acceptance collector and bounded BFF invocation.

Probe performs GET only. Invoke reads a reviewed private manifest and an existing
bearer token from AXIOM_AGENT_ACCEPTANCE_BEARER; it never seeds users, issues
approvals, executes Karya, seals evidence or bypasses dedicated workflows.
A successful generic invocation proves transport/runtime/audit completion only;
it is NOT persisted domain acceptance or all-agent end-to-end clearance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
AGENTS = (
    "drishti",
    "vibhaag",
    "parikshan",
    "saakshi",
    "sudhaar",
    "karya",
    "lekha",
    "nazar",
    "prativedan",
    "sanket",
    "samadhan",
    "pramaan",
)
SUPPORTED = {"parikshan", "sudhaar", "lekha", "nazar", "sanket"}
LIMIT = 2 * 1024 * 1024
CONTRACTS = {
    "drishti": (
        "stored_public_source_workflow",
        "Stored website-check/page/control hashes; dedicated dispatch; retained structural observations and human review.",
    ),
    "vibhaag": (
        "stored_public_source_workflow",
        "Same retained public source; source-bound classification indicators; unknown private-data processing remains unknown.",
    ),
    "parikshan": (
        "generic_assessment_compute",
        "Reviewed questionnaire/control-library version; nonempty findings; persisted assessment readback separately required.",
    ),
    "saakshi": (
        "retained_evidence_workflow",
        "Exact object version, content digest, retention/lock verification and receipt; generic response alone is insufficient.",
    ),
    "sudhaar": (
        "generic_proposal_compute",
        "Source finding identifiers and declared scope; typed actions and unvalidated rollback; plan persistence/review separately required.",
    ),
    "karya": (
        "approved_execution_workflow",
        "Recorded human approval, completed dry-run, validated rollback and live grant; concrete target mutation plus rollback/readback. Generic runtime currently defers connector execution.",
    ),
    "lekha": (
        "internal_ledger_verify",
        "Internal Workbench capability; existing nonempty ledger; intact full chain plus independently retained audit readback.",
    ),
    "nazar": (
        "trusted_government_capture_processor",
        "Implemented read-only processing requires an immutable government-source capture capability bound to the dispatch. Generic HTTP has no trusted source composition yet; baseline/content-change proposals are not verified legal changes or end-to-end acceptance.",
    ),
    "prativedan": (
        "board_report_workflow",
        "Finalized immutable source, founder review, retained released report version and hash; generic dispatch is refused.",
    ),
    "sanket": (
        "trusted_public_capture_processor",
        "Implemented read-only processing requires approved guarded public captures and internal Workbench authority. Generic HTTP source composition remains unavailable; explicit heading markers retain zero intent scores and do not prove buying intent or end-to-end acceptance.",
    ),
    "samadhan": (
        "persisted_reconciliation_workflow",
        "Persisted approved plan and execution batch; DB-authoritative reconciliation digest and exact current revision; generic BFF agent route does not expose it.",
    ),
    "pramaan": (
        "closure_dossier_workflow",
        "Source-bound released report, retained artifacts, exact reconciliations, founder review and dossier readback; dedicated BFF workflow, absent from generic runtime registry.",
    ),
}


class Refused(ValueError):
    """Only constant, non-sensitive error codes may leave this module."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused("http_redirect_refused")


def digest(value):
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
    ).hexdigest()


def origin(value):
    if not isinstance(value, str):
        raise Refused("local_origin_required")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise Refused("local_origin_required") from None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or not port
    ):
        raise Refused("local_origin_required")
    return value.rstrip("/")


def request_json(
    url, *, body=None, token=None, tenant=None, timeout=15, idempotency_key=None
):
    parsed = urlsplit(url)
    origin(f"{parsed.scheme}://{parsed.netloc}")
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if tenant:
        headers["X-Tenant-Id"] = tenant
    payload = None
    if body is not None:
        # The reviewed correlation supplies a stable, explicit request key.
        # This helper sends exactly once; an unknown outcome is reconciled,
        # never retried with a fresh key or correlation.
        headers["Idempotency-Key"] = uuid_text(idempotency_key)
        payload = json.dumps(body, allow_nan=False).encode()
        headers["Content-Type"] = "application/json"
    # Environment proxies and redirects must never receive fixture credentials.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        # Local HTTP only is enforced above, before Request construction.
        with opener.open(
            Request(url, data=payload, headers=headers), timeout=timeout
        ) as response:  # nosec B310
            status_code = response.status
            raw = response.read(LIMIT + 1)
    except HTTPError as error:
        status_code = error.code
        raw = error.read(LIMIT + 1)
    except (URLError, TimeoutError, OSError):
        raise Refused("transport_unconfirmed") from None
    if len(raw) > LIMIT:
        raise Refused("response_limit_exceeded")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Refused("response_json_refused") from None
    return status_code, value


def uuid_text(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise Refused("uuid_required") from None


def validate_manifest(value):
    fields = {
        "schemaVersion",
        "bffOrigin",
        "expectedRevision",
        "tenantId",
        "isolation",
        "humanRequestReference",
        "invocations",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value["schemaVersion"] != 1
    ):
        raise Refused("manifest_schema_refused")
    origin(value["bffOrigin"])
    if not isinstance(value["expectedRevision"], str) or not re.fullmatch(
        r"[a-f0-9]{40}", value["expectedRevision"]
    ):
        raise Refused("exact_revision_required")
    uuid_text(value["tenantId"])
    if value["isolation"] != "disposable-local-fixture":
        raise Refused("isolated_fixture_required")
    reference = value["humanRequestReference"]
    if not isinstance(reference, str) or not re.fullmatch(
        r"[A-Za-z0-9._:/-]{12,200}", reference
    ):
        raise Refused("recorded_request_reference_required")
    invocations = value["invocations"]
    if not isinstance(invocations, list) or not 1 <= len(invocations) <= len(SUPPORTED):
        raise Refused("bounded_invocations_required")
    seen = set()
    for invocation in invocations:
        if not isinstance(invocation, dict) or set(invocation) != {"agent", "input"}:
            raise Refused("invocation_schema_refused")
        agent, data = invocation["agent"], invocation["input"]
        if not isinstance(agent, str) or agent not in SUPPORTED or agent in seen:
            raise Refused("agent_workflow_refused")
        seen.add(agent)
        if (
            not isinstance(data, dict)
            or len(json.dumps(data, allow_nan=False).encode()) > 64 * 1024
        ):
            raise Refused("input_schema_refused")
        if any(
            key in data
            for key in (
                "approvalToken",
                "approval_token",
                "dispatch_context",
                "token",
                "credential",
                "password",
            )
        ):
            raise Refused("privileged_input_refused")
        for key in ("tenant_id", "tenantId"):
            if key in data and uuid_text(data[key]) != uuid_text(value["tenantId"]):
                raise Refused("tenant_mismatch")
        if "correlation_id" not in data:
            raise Refused("explicit_correlation_required")
        uuid_text(data["correlation_id"])
        if agent in {"parikshan", "sudhaar"}:
            uuid_text(data.get("engagement_id"))
        if agent == "parikshan" and (
            not isinstance(data.get("answers"), dict) or not data["answers"]
        ):
            raise Refused("reviewed_answers_required")
        if agent == "sudhaar" and (
            not isinstance(data.get("findings"), list)
            or not data["findings"]
            or any(
                not isinstance(item, dict) or not item.get("id")
                for item in data["findings"]
            )
        ):
            raise Refused("source_findings_required")
        if agent == "lekha" and (
            data.get("operation") != "verify" or data.get("from_sequence", 1) != 1
        ):
            raise Refused("full_ledger_verification_required")
    return value


def load_manifest(path, reviewed_sha):
    if not re.fullmatch(r"[a-f0-9]{64}", reviewed_sha or ""):
        raise Refused("reviewed_manifest_digest_required")
    location = Path(path)
    if location.is_symlink():
        raise Refused("private_manifest_required")
    fd = os.open(location, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_mode & 0o077
            or metadata.st_size > LIMIT
        ):
            raise Refused("private_manifest_required")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            raw = handle.read(LIMIT + 1)
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest() != reviewed_sha:
        raise Refused("manifest_review_digest_mismatch")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Refused("manifest_json_refused") from None
    return validate_manifest(value)


def assert_health(bff, expected_revision, fetch=request_json):
    code, health = fetch(origin(bff) + "/health")
    if (
        code != 200
        or not isinstance(health, dict)
        or health.get("status") != "ok"
        or health.get("authMode") != "strict"
        or health.get("revision") != expected_revision
    ):
        raise Refused("exact_strict_target_required")
    return {key: health.get(key) for key in ("status", "authMode", "revision")}


def public_capture_host(value):
    """Output URL consistency only; never replaces guarded DNS/HTTP capture."""
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.query
            or parsed.fragment
            or not parsed.hostname
            or not re.fullmatch(
                r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}",
                parsed.hostname,
            )
            or re.search(
                r"(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$",
                parsed.hostname,
            )
        ):
            return None
        return parsed.hostname
    except ValueError:
        return None


def source_processor_status(agent, output):
    observations = output.get("source_observations")
    if (
        output.get("processing_mode") != "verified_public_capture_review"
        or not isinstance(observations, list)
        or not 1 <= len(observations) <= 4
    ):
        return "trusted_public_capture_missing"
    government_hosts = {
        "meity.gov.in",
        "www.meity.gov.in",
        "dpb.gov.in",
        "www.dpb.gov.in",
        "egazette.gov.in",
        "www.egazette.gov.in",
    }
    hosts, references = [], set()
    for observation in observations:
        if (
            not isinstance(observation, dict)
            or observation.get("requires_human_review") is not True
        ):
            return "source_capture_provenance_refused"
        requested_host = public_capture_host(observation.get("requested_url"))
        final_host = public_capture_host(observation.get("final_url"))
        if not requested_host or not final_host:
            return "source_capture_provenance_refused"
        if agent == "nazar" and (
            requested_host not in government_hosts or final_host not in government_hosts
        ):
            return "source_capture_provenance_refused"
        if any(
            not isinstance(observation.get(key), str)
            or not re.fullmatch(r"[a-f0-9]{64}", observation[key])
            for key in ("content_sha256", "projection_sha256")
        ):
            return "source_capture_provenance_refused"
        try:
            reference = uuid_text(observation.get("capture_reference"))
            captured = datetime.fromisoformat(
                observation.get("checked_at", "").replace("Z", "+00:00")
            )
            if captured.tzinfo is None:
                return "source_capture_provenance_refused"
        except (Refused, ValueError, AttributeError):
            return "source_capture_provenance_refused"
        references.add(reference)
        hosts.append(final_host)
        if agent == "nazar" and observation.get("baseline_status") not in {
            "first_capture_baseline",
            "content_unchanged",
            "content_changed",
        }:
            return "source_capture_provenance_refused"
    if agent == "nazar":
        if output.get("sources_checked") != list(dict.fromkeys(hosts)):
            return "source_capture_provenance_refused"
        changes = output.get("changes")
        if not isinstance(changes, list) or any(
            not isinstance(change, dict)
            or change.get("affected_control_ids") != []
            or change.get("severity") != "info"
            for change in changes
        ):
            return "source_review_claim_refused"
    else:
        signals = output.get("signals")
        if output.get("high_intent") != [] or not isinstance(signals, list):
            return "source_review_claim_refused"
        for signal in signals:
            if (
                not isinstance(signal, dict)
                or type(signal.get("score")) is not int
                or signal["score"] != 0
                or signal.get("source") not in references
                or signal.get("company") not in hosts
                or signal.get("signal")
                not in {
                    "public_rfp_heading",
                    "public_dpo_heading",
                    "public_hiring_heading",
                }
            ):
                return "source_review_claim_refused"
    # A component-shaped result cannot prove installed HTTP source authority,
    # retained source/domain state or all-agent composition. This gate remains
    # pending until a dedicated trusted HTTP source workflow is independently accepted.
    return "source_processor_http_composition_pending"


def classify_output(agent, correlation, code, result):
    if not isinstance(result, dict) or code != 200:
        return "http_refused"
    if (
        result.get("agent") != agent
        or result.get("correlation_id") != correlation
        or result.get("status") != "succeeded"
        or result.get("error") is not None
        or not isinstance(result.get("output"), dict)
    ):
        return "runtime_unconfirmed"
    ledger_ids = result.get("ledger_entry_ids")
    if (
        not isinstance(ledger_ids, list)
        or len(ledger_ids) != 2
        or any(
            not isinstance(item, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", item)
            for item in ledger_ids
        )
        or len(set(ledger_ids)) != 2
    ):
        return "audit_completion_unconfirmed"
    output = result["output"]
    if agent in {"nazar", "sanket"}:
        return source_processor_status(agent, output)
    if agent == "parikshan":
        findings = output.get("findings")
        if (
            not isinstance(findings, list)
            or not findings
            or any(
                not isinstance(item, dict) or not item.get("control_id")
                for item in findings
            )
        ):
            return "meaningful_output_missing"
    if agent == "sudhaar":
        actions = output.get("actions")
        if (
            not isinstance(actions, list)
            or not actions
            or any(
                not isinstance(item, dict)
                or not item.get("closes_finding_id")
                or not isinstance(item.get("rollback"), dict)
                or item["rollback"].get("validatedExecutable") is not False
                for item in actions
            )
        ):
            return "proposal_or_rollback_refused"
    if agent == "lekha" and (
        output.get("operation") != "verify"
        or output.get("intact") is not True
        or output.get("first_break") is not None
    ):
        return "ledger_integrity_not_confirmed"
    return "runtime_completed_domain_acceptance_pending"


def verify_audit_readback(agent, correlation, tenant, result, code, body):
    """Require both reported receipt IDs in a tenant-scoped durable BFF read."""
    if (
        code != 200
        or not isinstance(body, dict)
        or not isinstance(body.get("entries"), list)
    ):
        return False
    ids = result.get("ledger_entry_ids", [])
    if len(ids) != 2:
        return False
    found = {
        str(item.get("id")): item for item in body["entries"] if isinstance(item, dict)
    }
    if any(identifier not in found for identifier in ids):
        return False
    started, completed = (found[identifier] for identifier in ids)
    for item in (started, completed):
        if (
            item.get("actor_type") != "agent"
            or item.get("actor_id") != agent
            or item.get("tenant_id") != tenant
            or item.get("correlation_id") != correlation
            or not isinstance(item.get("input_hash"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", item["input_hash"])
        ):
            return False
    detail = completed.get("detail")
    started_detail = started.get("detail")
    if not isinstance(started_detail, dict) or not isinstance(detail, dict):
        return False
    try:
        run_id = uuid_text(started_detail.get("run_id"))
        if uuid_text(detail.get("run_id")) != run_id:
            return False
    except Refused:
        return False
    request_hash = started_detail.get("request_hash")
    if (
        not isinstance(request_hash, str)
        or not re.fullmatch(r"[a-f0-9]{64}", request_hash)
        or detail.get("request_hash") != request_hash
        or started_detail.get("phase") != "started"
        or detail.get("phase") != "completed"
    ):
        return False
    human_requests = [
        item
        for item in found.values()
        if item.get("action_type") == "agent.invocation.requested"
        and item.get("target_ref") == run_id
        and item.get("tenant_id") == tenant
        and item.get("correlation_id") == correlation
        and item.get("input_hash") == request_hash
        and item.get("actor_type") == "human"
        and item.get("result") == "pending"
    ]
    settlements = [
        item
        for item in found.values()
        if item.get("action_type") == "agent.invocation.settled"
        and item.get("target_ref") == run_id
        and item.get("tenant_id") == tenant
        and item.get("correlation_id") == correlation
        and item.get("input_hash") == request_hash
        and item.get("actor_type") == "system"
        and item.get("actor_id") == "bff-generic-agent-controller"
        and item.get("result") == "success"
    ]
    if len(human_requests) != 1 or len(settlements) != 1:
        return False
    requested, settled = human_requests[0], settlements[0]
    settled_detail = settled.get("detail")
    if (
        not isinstance(settled_detail, dict)
        or settled_detail.get("requested_by") != requested.get("actor_id")
        or settled_detail.get("agent") != agent
        or settled_detail.get("runtime_outcome") != "receipt_confirmed"
        or settled_detail.get("started_receipt") != ids[0]
        or settled_detail.get("completed_receipt") != ids[1]
        or settled.get("output_hash") != completed.get("output_hash")
    ):
        return False
    sequence = [
        item.get("sequence_no") for item in (requested, started, completed, settled)
    ]
    if any(
        type(item) is not int or item < 1 for item in sequence
    ) or sequence != sorted(set(sequence)):
        return False
    return (
        started.get("result") == "pending"
        and completed.get("result") == "success"
        and started["input_hash"] == completed["input_hash"]
        and isinstance(completed.get("output_hash"), str)
        and re.fullmatch(r"[a-f0-9]{64}", completed["output_hash"]) is not None
        and isinstance(detail, dict)
        and str(detail.get("started_entry")) == ids[0]
    )


def run_manifest(manifest, token, fetch=request_json):
    manifest = validate_manifest(manifest)
    if (
        not isinstance(token, str)
        or len(token) < 20
        or any(character.isspace() for character in token)
    ):
        raise Refused("existing_bearer_required")
    bff = origin(manifest["bffOrigin"])
    health = assert_health(bff, manifest["expectedRevision"], fetch)
    receipts = []
    for invocation in manifest["invocations"]:
        # One request, no retry: timeout or failed settlement is unconfirmed.
        agent, data = invocation["agent"], invocation["input"]
        try:
            code, result = fetch(
                bff + f"/v1/agents/{agent}/run",
                body=data,
                token=token,
                tenant=manifest["tenantId"],
                timeout=135,
                idempotency_key=uuid_text(data["correlation_id"]),
            )
        except Refused:
            receipts.append(
                {
                    "agent": agent,
                    "httpStatus": None,
                    "status": "transport_unconfirmed",
                    "inputSha256": digest(data),
                    "input": data,
                    "response": None,
                }
            )
            break
        status = classify_output(agent, data["correlation_id"].lower(), code, result)
        readback = None
        if status in {
            "runtime_completed_domain_acceptance_pending",
            "source_processor_http_composition_pending",
        }:
            try:
                read_code, readback = fetch(
                    bff + "/v1/ledger?limit=1000",
                    token=token,
                    tenant=manifest["tenantId"],
                )
            except Refused:
                read_code, readback = 0, None
            if not verify_audit_readback(
                agent,
                data["correlation_id"].lower(),
                uuid_text(manifest["tenantId"]),
                result,
                read_code,
                readback,
            ):
                status = "durable_audit_readback_unconfirmed"
        if (
            status == "runtime_completed_domain_acceptance_pending"
            and agent == "sudhaar"
        ):
            source_ids = {item["id"] for item in data["findings"]}
            action_ids = {
                item["closes_finding_id"] for item in result["output"]["actions"]
            }
            if action_ids != source_ids:
                status = "proposal_source_binding_refused"
        if (
            status == "runtime_completed_domain_acceptance_pending"
            and agent == "parikshan"
            and result["output"].get("library_version")
            != data.get("library_version", "0.1.0")
        ):
            status = "assessment_library_binding_refused"
        receipts.append(
            {
                "agent": agent,
                "httpStatus": code,
                "status": status,
                "inputSha256": digest(data),
                "responseSha256": digest(result),
                "input": data,
                "response": result,
                "auditReadback": readback,
            }
        )
        if status not in {
            "runtime_completed_domain_acceptance_pending",
            "source_processor_http_composition_pending",
        }:
            break
    return {
        "schemaVersion": 1,
        "mode": "invoke",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "target": health,
        "manifestSha256": digest(manifest),
        "authorization": "Caller supplied reviewed human-request reference; BFF enforces live authority. No execution approval is created.",
        "humanRequestReference": manifest["humanRequestReference"],
        "receipts": receipts,
        "allAgentEndToEndAccepted": False,
        "limitation": "Generic completion cannot prove persisted findings/plans, real source retrieval, retained artifacts, client mutation or all-agent composition.",
    }


def probe(bff, runtime, gateway, expected_revision, fetch=request_json):
    health = assert_health(bff, expected_revision, fetch)
    observations = {}
    for name, base, path in (
        ("runtimeHealth", runtime, "/health"),
        ("runtimeReady", runtime, "/ready"),
        ("gatewayHealth", gateway, "/health"),
        ("runtimeRegistry", runtime, "/agents"),
    ):
        try:
            code, value = fetch(origin(base) + path)
            if code != 200 or not isinstance(value, dict):
                observations[name] = {"status": "unconfirmed", "httpStatus": code}
            elif name == "runtimeRegistry":
                agents = value.get("agents")
                if not isinstance(agents, list):
                    raise Refused("registry_schema_refused")
                observations[name] = {
                    "status": "observed",
                    "agents": [
                        {
                            key: item.get(key)
                            for key in (
                                "name",
                                "version",
                                "can_mutate",
                                "mutates_client_estate",
                                "writes_axiom_state",
                            )
                        }
                        for item in agents
                        if isinstance(item, dict) and item.get("name") in AGENTS
                    ],
                }
            else:
                observations[name] = {
                    key: value.get(key) for key in ("status", "gateway_healthy")
                }
        except Refused as error:
            observations[name] = {"status": "unconfirmed", "reason": str(error)}
    registered = {
        item["name"]
        for item in observations.get("runtimeRegistry", {}).get("agents", [])
    }
    return {
        "schemaVersion": 1,
        "mode": "probe",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "target": health,
        "observations": observations,
        "allAgentEndToEndAccepted": False,
        "agents": [
            {
                "agent": agent,
                "runtimeRegistered": agent in registered,
                "workflow": CONTRACTS[agent][0],
                "requiredProof": CONTRACTS[agent][1],
                "acceptance": "not_run",
            }
            for agent in AGENTS
        ],
        "limitation": "Unauthenticated loopback GET reachability/registry only; no agent execution, credentials, database reads or workflow proof.",
    }


def validate_output(output, root=ROOT):
    destination = Path(output).absolute()
    boundary = root / ".axiom-runtime/review/all-agent-acceptance"
    if not destination.is_relative_to(boundary) or ".." in destination.parts:
        raise Refused("private_receipt_location_required")
    for ancestor in (destination, *destination.parents):
        if ancestor == root.parent:
            break
        if ancestor.is_symlink():
            raise Refused("receipt_symlink_refused")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    current = destination.parent
    while current.is_relative_to(boundary):
        if current.stat().st_mode & 0o077:
            raise Refused("private_receipt_directory_required")
        current = current.parent
    if destination.exists():
        raise Refused("fresh_receipt_required")
    return destination


def write_private(value, output, root=ROOT):
    destination = validate_output(output, root)
    # A fresh immutable filename prevents accidental overwrite of earlier proof.
    fd = os.open(
        destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("probe", "invoke"))
    parser.add_argument("--bff", default="http://127.0.0.1:4000")
    parser.add_argument("--runtime", default="http://127.0.0.1:8000")
    parser.add_argument("--gateway", default="http://127.0.0.1:8001")
    parser.add_argument("--expected-revision")
    parser.add_argument("--manifest")
    parser.add_argument("--reviewed-manifest-sha256")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        validate_output(args.output)
        if args.mode == "probe":
            if not re.fullmatch(r"[a-f0-9]{40}", args.expected_revision or ""):
                raise Refused("exact_revision_required")
            value = probe(args.bff, args.runtime, args.gateway, args.expected_revision)
        else:
            if not args.manifest:
                raise Refused("private_manifest_required")
            manifest = load_manifest(args.manifest, args.reviewed_manifest_sha256)
            value = run_manifest(
                manifest, os.environ.get("AXIOM_AGENT_ACCEPTANCE_BEARER")
            )
        write_private(value, args.output)
        summary = {"mode": args.mode, "allAgentEndToEndAccepted": False}
        if args.mode == "invoke":
            summary["agents"] = [
                {"agent": item["agent"], "status": item["status"]}
                for item in value["receipts"]
            ]
        else:
            summary["registeredAgents"] = sum(
                item["runtimeRegistered"] for item in value["agents"]
            )
        print(json.dumps(summary))
        return (
            0 if args.mode == "probe" else 1
        )  # Never green-light all-agent acceptance.
    except (Refused, OSError, ValueError):
        print(
            "Agent acceptance refused or unconfirmed; no clearance granted.",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
