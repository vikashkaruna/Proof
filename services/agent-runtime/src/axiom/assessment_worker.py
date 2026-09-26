"""Credential-less, single-task Parikshan process with private framed stdio tools.

The controller launches this under its registered workload UID. SVIDs are fetched
by this process from the Workload API, freshly for each tool. This module never
imports BaseAgent, runtime settings or a database/vault/model client. Private
frames must never be sent to a browser, log collector or workflow history.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess  # nosec B404 - fixed spire-agent CLI for SVID fetch; constant argv, no shell
import sys
from functools import partial
from uuid import UUID

from .assessment_scoring import AssessmentInput, score_assessment
from .control_library_loader import ControlLibrary, _parse_control
from .process_lifetime import bind_parent_lifetime

MAX_FRAME = 4 * 1024 * 1024


def parse_json(value: str):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = item
        return result

    def invalid_constant(_):
        raise ValueError("Non-finite number")

    return json.loads(value, object_pairs_hook=pairs, parse_constant=invalid_constant)


def read_frame():
    line = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not line.endswith(b"\n") or len(line) > MAX_FRAME:
        raise ValueError("Invalid frame")
    return parse_json(line.decode("utf-8"))


def write_frame(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def fetch_svid(spiffe_id: str) -> str:
    # Arguments contain only public identity selectors; no bearer or task secret.
    if not re.fullmatch(r"spiffe://[a-z0-9.-]+/agent/parikshan", spiffe_id):
        raise ValueError("Invalid workload identity")
    result = subprocess.run(  # nosec B603 - spiffe_id is regex-validated above, all other argv is constant, no shell
        [
            "/usr/local/bin/spire-agent",
            "api",
            "fetch",
            "jwt",
            "-socketPath",
            "/run/workload/api.sock",
            "-audience",
            "axiom-assessment-tools",
            "-spiffeID",
            spiffe_id,
            "-output",
            "json",
        ],
        preexec_fn=partial(bind_parent_lifetime, os.getpid()),
        capture_output=True,
        timeout=15,
        check=False,
    )
    if result.returncode or len(result.stdout) > MAX_FRAME:
        raise ValueError("Identity unavailable")
    payload = parse_json(result.stdout.decode("utf-8"))
    svids = next(part["svids"] for part in payload if "svids" in part)
    if len(svids) != 1 or svids[0]["spiffe_id"] != spiffe_id:
        raise ValueError("Identity mismatch")
    token = svids[0]["svid"]
    if not isinstance(token, str) or not 1 <= len(token) <= 16384:
        raise ValueError("Identity unavailable")
    return token


def private_tool(operation: str, request: dict, spiffe_id: str):
    request["authorization"]["workloadProof"] = fetch_svid(spiffe_id)
    write_frame({"tool": operation, "request": request})
    response = read_frame()
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "value"}
        or response["ok"] is not True
    ):
        raise ValueError("Tool refused")
    return response["value"]


def execute(envelope: dict, call=private_tool) -> dict:
    if not isinstance(envelope, dict) or set(envelope) != {
        "tenantId",
        "runId",
        "taskProof",
        "inputJson",
        "inputHash",
        "spiffeId",
    }:
        raise ValueError("Invalid assignment")
    for key in ("tenantId", "runId"):
        if str(UUID(envelope[key])) != envelope[key]:
            raise ValueError("Invalid assignment")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", envelope["taskProof"]):
        raise ValueError("Invalid assignment")
    wire_input = envelope["inputJson"]
    if not isinstance(wire_input, str) or len(wire_input.encode("utf-8")) > 1048576:
        raise ValueError("Invalid assignment")
    if hashlib.sha256(wire_input.encode("utf-8")).hexdigest() != envelope["inputHash"]:
        raise ValueError("Input binding mismatch")
    raw = parse_json(wire_input)
    required = {"tenant_id", "engagement_id", "library_version"}
    allowed = required | {"answers", "sdf_self_attested", "processes_children", "processes_health"}
    if not isinstance(raw, dict) or not required <= set(raw) or not set(raw) <= allowed:
        raise ValueError("Invalid input")
    if (
        raw["tenant_id"] != envelope["tenantId"]
        or str(UUID(raw["engagement_id"])) != raw["engagement_id"]
    ):
        raise ValueError("Invalid input context")
    if not isinstance(raw["library_version"], str) or not 1 <= len(raw["library_version"]) <= 200:
        raise ValueError("Invalid library")
    answers = raw.get("answers", {})
    if not isinstance(answers, dict) or any(not isinstance(a, dict) for a in answers.values()):
        raise ValueError("Invalid answers")
    flags = {
        key: raw.get(key, False)
        for key in ("sdf_self_attested", "processes_children", "processes_health")
    }
    if any(type(value) is not bool for value in flags.values()):
        raise ValueError("Invalid input flags")
    authorization = {key: envelope[key] for key in ("tenantId", "runId", "taskProof")}
    packet = call(
        "assessment.start",
        {
            "authorization": dict(authorization),
            "inputHash": envelope["inputHash"],
        },
        envelope["spiffeId"],
    )
    if (
        packet["engagement_id"] != raw["engagement_id"]
        or packet["library_version"] != raw["library_version"]
    ):
        raise ValueError("Packet context mismatch")
    definitions = packet["controls"]
    if not isinstance(definitions, list) or not 1 <= len(definitions) <= 500:
        raise ValueError("Invalid controls")
    if len({c["id"] for c in definitions}) != len(definitions) or any(
        c["library_version"] != raw["library_version"] for c in definitions
    ):
        raise ValueError("Invalid library snapshot")
    controls = [_parse_control(c) for c in definitions]
    for control in controls:
        if any(
            type(v) not in (int, float) or not math.isfinite(v) or v < 0
            for v in (
                control.scoring.weight,
                control.scoring.penalty_points,
                control.scoring.max_penalty_inr,
            )
        ):
            raise ValueError("Invalid scoring definition")
    library = ControlLibrary(packet["library_version"], controls)
    computed = score_assessment(library, AssessmentInput(raw["library_version"], answers, **flags))
    # Persist only the typed finding fields, never raw questionnaire answers.
    result = {
        key: computed[key] for key in ("library_version", "posture_score", "estimated_exposure_inr")
    }
    result["findings"] = [
        {key: finding[key] for key in ("control_id", "score", "risk_points", "rationale")}
        for finding in computed["findings"]
    ]
    receipt = call(
        "assessment.complete",
        {
            "authorization": dict(authorization),
            "libraryDigest": packet["library_digest"],
            "result": result,
        },
        envelope["spiffeId"],
    )
    if not isinstance(receipt, dict) or set(receipt) != {"completed_receipt", "result_digest"}:
        raise ValueError("Invalid receipt")
    if not re.fullmatch(r"[1-9][0-9]*", receipt["completed_receipt"]) or not re.fullmatch(
        r"[a-f0-9]{64}", receipt["result_digest"]
    ):
        raise ValueError("Invalid receipt")
    return {"status": "persisted", "runId": envelope["runId"], **receipt}


def main():
    try:
        write_frame({"result": execute(read_frame())})
    except Exception:
        # No traceback, private input, tool response, or exception interpolation.
        write_frame({"error": "assessment_worker_failed"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
