#!/usr/bin/env python3
"""Scoped live lifecycle observations and one bounded in-flight refusal probe.
No stop/wake execution, deployment, SQL or automatic mutation retry.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "config", ROOT / "scripts/marketing-acceptance-config.py"
)
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def http(url: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        data=None if body is None else json.dumps(body).encode(),
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Provider response bound exceeded")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise TypeError("Provider object required")
        return response.status, value


def prepare(
    env_path: Path,
    services_path: Path,
    manifest_path: Path,
    approval_path: Path,
    phase: str,
) -> dict:
    config.protected_read(env_path)
    parser_spec = importlib.util.spec_from_file_location(
        "literal", ROOT / "scripts/lib/ops-env-parse.py"
    )
    parser = importlib.util.module_from_spec(parser_spec)
    parser_spec.loader.exec_module(parser)
    env = parser.parse(env_path)
    services, service_hash = config.json_input(services_path)
    manifest, manifest_hash = config.json_input(manifest_path)
    approval, approval_hash = config.json_input(approval_path)
    selected = {
        "environment": env["ENVIRONMENT"],
        "project": env["GCP_PROJECT_ID"],
        "instance": env["CLOUD_SQL_INSTANCE_NAME"],
        "bucket": env["AXIOM_IDLE_STATE_BUCKET"],
        "object": env["AXIOM_IDLE_STATE_OBJECT"],
    }
    if (
        selected["environment"] != "preprod"
        or env["GCP_REGION"] != "asia-south1"
        or manifest != selected
        or manifest_hash != env["AXIOM_IDLE_TARGET_MANIFEST_SHA256"]
        or selected["object"] != "marketing-preprod/lifecycle/state.json"
        or services["project"] != selected["project"]
    ):
        raise ValueError("Exact approved private preprod target required")
    required = (
        ["observe"]
        if phase == "observe"
        else ["observe", "gate/acquire", "idle/check", "gate/release"]
    )
    if (
        approval.get("kind") != "marketing-preprod-lifecycle-acceptance"
        or approval.get("project") != selected["project"]
        or approval.get("release_sha") != services["release_sha"]
        or approval.get("services_receipt_sha256") != service_hash
        or approval.get("target_manifest_sha256") != manifest_hash
        or not isinstance(approval.get("approved_by"), str)
        or not approval["approved_by"].strip()
        or approval.get("actions") != required
        or type(approval.get("expires_unix")) is not int
        or approval["expires_unix"] <= time.time()
        or approval["expires_unix"] > time.time() + 3600
    ):
        raise ValueError("Bounded recorded lifecycle scope required")
    return {
        **selected,
        "targetHash": manifest_hash,
        "servicesHash": service_hash,
        "approvalHash": approval_hash,
        "releaseSha": services["release_sha"],
        "controllerUrl": config.origin(services["lifecycle_controller_uri"], True),
        "expiresUnix": approval["expires_unix"],
    }


def observe(source: dict, access_token: str, transport=http) -> dict:
    bucket = urllib.parse.quote(source["bucket"], safe="")
    obj = urllib.parse.quote(source["object"], safe="")
    url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{obj}"
    status, metadata = transport(url, access_token)
    if (
        status != 200
        or metadata.get("bucket") != source["bucket"]
        or metadata.get("name") != source["object"]
        or not str(metadata.get("generation", "")).isdigit()
    ):
        raise ValueError("Exact GCS metadata observation required")
    status, state = transport(
        url + "?alt=media&generation=" + str(metadata["generation"]), access_token
    )
    if status != 200 or state.get("targetHash") != source["targetHash"]:
        raise ValueError("Generation-bound target state differs")
    sql_url = f"https://sqladmin.googleapis.com/v1/projects/{urllib.parse.quote(source['project'], safe='')}/instances/{urllib.parse.quote(source['instance'], safe='')}"
    status, instance = transport(sql_url, access_token)
    if (
        status != 200
        or instance.get("name") != source["instance"]
        or instance.get("project") != source["project"]
    ):
        raise ValueError("Exact provider SQL identity differs")
    return {
        "generation": str(metadata["generation"]),
        "state": state,
        "sql": {
            "name": instance["name"],
            "project": instance["project"],
            "state": instance["state"],
            "activationPolicy": instance["settings"]["activationPolicy"],
            "settingsVersion": instance["settings"]["settingsVersion"],
        },
    }


def hold_and_refuse(
    source: dict, access: str, identity: str, save, transport=http
) -> dict:
    request = {"requestId": str(uuid4()), "leaseToken": secrets.token_hex(32)}
    proof = {
        "source": source,
        "requestId": request["requestId"],
        "leaseToken": request["leaseToken"],
        "observations": [],
        "actions": [],
    }
    admitted = False

    def action(path, body):
        if time.time() >= source["expiresUnix"]:
            raise ValueError("Recorded mutation scope expired")
        entry = {"path": path, "outcome": "unknown"}
        proof["actions"].append(entry)
        save(proof)  # Preserve intent and recovery token BEFORE transmission.
        status, value = transport(source["controllerUrl"] + path, identity, body)
        entry.update(status=status, response=value, outcome="observed")
        save(proof)
        return status, value

    try:
        before = observe(source, access, transport)
        proof["observations"].append(before)
        if (
            before["state"]["phase"] != "running"
            or before["sql"]["activationPolicy"] != "ALWAYS"
            or before["sql"]["state"] != "RUNNABLE"
        ):
            raise ValueError(
                "Hold probe requires already-running target; no implicit wake"
            )
        status, reply = action("/gate/acquire", request)
        admitted = status == 200 and reply.get("status") == "admitted"
        if not admitted:
            raise ValueError("Admission not observed; unknown lease remains retained")
        held = observe(source, access, transport)
        lease = held["state"]["leases"].get(request["requestId"])
        if not lease or lease["tokenHash"] != sha(request["leaseToken"].encode()):
            raise ValueError("Durable exact lease observation required")
        proof["observations"].append(held)
        status, reply = action("/idle/check", {})
        if status != 503 or reply.get("status") != "in_flight_or_completion_unknown":
            raise ValueError("Actual in-flight stop refusal missing")
        after = observe(source, access, transport)
        proof["observations"].append(after)
        if (
            after["sql"]["activationPolicy"] != "ALWAYS"
            or after["state"]["phase"] != "running"
        ):
            raise ValueError("Provider changed despite held lease")
    finally:
        if admitted:
            status, reply = action("/gate/release", request)
            if status != 200 or reply.get("status") != "released":
                raise ValueError("Release outcome uncertain; retain recovery artifact")
            released = observe(source, access, transport)
            proof["observations"].append(released)
            if request["requestId"] in released["state"]["leases"]:
                raise ValueError("Released durable lease still present")
        save(proof)
    proof["status"] = "actual-in-flight-refusal-observed-cold-cycle-pending"
    save(proof)
    return proof


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "env-file",
        "services-receipt",
        "target-manifest",
        "approval",
        "tokens",
        "output",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--phase", choices=("observe", "hold"), required=True)
    args = parser.parse_args()
    try:
        if args.output.exists() or args.output.is_symlink():
            raise ValueError("Fresh protected proof path required")
        source = prepare(
            args.env_file,
            args.services_receipt,
            args.target_manifest,
            args.approval,
            args.phase,
        )
        tokens, _ = config.json_input(args.tokens)
        save = lambda proof: config.write_private(args.output, proof)
        if args.phase == "observe":
            save(
                {
                    "source": source,
                    "observation": observe(source, tokens["accessToken"]),
                }
            )
        else:
            hold_and_refuse(
                source, tokens["accessToken"], tokens["controllerIdToken"], save
            )
    except (OSError, ValueError, TypeError, KeyError):
        print(
            "Lifecycle proof refused or uncertain; protected recovery evidence retained, secrets withheld"
        )
        return 1
    print(
        "Lifecycle proof phase completed; cold stop/wake and DB readback remain separate"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
