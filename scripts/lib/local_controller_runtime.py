"""Pure reviewed configuration and credential requests for the local controller."""

from __future__ import annotations

import hashlib
import json
import re
import uuid

UID, SCHEDULER_UID, SOCKET_GROUP = 20103, 20104, 20111
DOMAIN = "local.axiomproof.test"
WORKLOAD_ALIAS = "axiom-workload-api-local"
TENANTS = {
    "kosha": ("fd5e0001-0000-4000-8000-000000000001", 7443),
    "sanjeevani": ("fd5e0002-0000-4000-8000-000000000002", 7444),
    "nimbus": ("fd5e0003-0000-4000-8000-000000000003", 7445),
}


def canonical(value: dict) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def identifier(value: str) -> str:
    parsed = str(uuid.UUID(value))
    if value != parsed or uuid.UUID(value).int == 0:
        raise ValueError("Identity refused")
    return value


def issue_request(
    tenant_id: str,
    configuration_sha: str,
    approval_reference: str,
    now: int,
    predecessor: str | None = None,
    credential_id: str | None = None,
) -> tuple[bytes, str]:
    if (
        not re.fullmatch(r"[a-f0-9]{64}", configuration_sha)
        or type(now) is not int
        or now < 0
    ):
        raise ValueError("Request refused")
    value = {
        "schemaVersion": 1,
        "purpose": "controller-backend-issue",
        "credentialId": identifier(credential_id or str(uuid.uuid4())),
        "tenantId": identifier(tenant_id),
        "configurationSha256": configuration_sha,
        "approvalReference": identifier(approval_reference),
        "predecessorId": identifier(predecessor) if predecessor else None,
        "issuedAt": now,
        "expiresAt": now + 3600,
    }
    if value["credentialId"] == predecessor:
        raise ValueError("Predecessor refused")
    raw = canonical(value)
    return raw, hashlib.sha256(raw).hexdigest()


def renewal_due(previous: dict, now: int, margin: int = 1200) -> bool:
    if type(margin) is not int or not 60 <= margin < 3600 or type(now) is not int:
        raise ValueError("Renewal window refused")
    if type(previous["expiresAt"]) is not int or previous["expiresAt"] <= now:
        raise ValueError("Expired predecessor requires explicit fresh issuance")
    return previous["expiresAt"] - now <= margin


def build_configuration(
    slug: str,
    active: dict,
    manifest: dict,
    node_id: str,
    worker_image: str,
    namespace: str,
) -> dict:
    tenant_id, port = TENANTS[slug]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", worker_image) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", namespace
    ):
        raise ValueError("Runtime pin refused")
    if not re.fullmatch(
        r"spiffe://local\.axiomproof\.test/spire/agent/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)+",
        node_id,
    ):
        raise ValueError("Issuer refused")
    text = manifest["policyText"]
    sha = hashlib.sha256(text.encode()).hexdigest()
    policy = json.loads(text)
    if (
        sha != manifest["policySha256"]
        or sha != active["policySha256"]
        or text != active["policyText"]
        or policy["tenantId"] != tenant_id
    ):
        raise ValueError("Exact active manifest required")
    if type(active["epoch"]) is not int or not 1 <= active["epoch"] <= 9007199254740991:
        raise ValueError("Activation epoch refused")
    for value in (policy["keyPolicySha256"], policy["deploymentBindingSha256"]):
        if not re.fullmatch(r"[a-f0-9]{64}", value):
            raise ValueError("Digest refused")
    if policy["servicePrincipals"] != {
        "producer": f"spiffe://{DOMAIN}/service/assessment-dispatch-producer",
        "controller": f"spiffe://{DOMAIN}/controller/assessment",
    }:
        raise ValueError("Principals refused")
    prefix = "/etc/axiom/assessment-controller"
    return {
        "controller": {
            "schemaVersion": 1,
            "tenantId": tenant_id,
            "trustDomain": DOMAIN,
            "workloadSocket": "/run/workload/api.sock",
            "issuerNodeId": node_id,
            "namespace": namespace,
            "launcher": {
                "executable": "/usr/bin/docker",
                "dockerHost": "unix:///run/docker.sock",
                "image": worker_image,
                "workloadApiVolume": WORKLOAD_ALIAS,
            },
            "keys": {
                "provider": "local",
                "workloadId": identifier(policy["targetWorkloadId"]),
                "custody": {
                    "custodyPolicyId": identifier(policy["policyId"]),
                    "custodyPolicySha256": sha,
                    "keyPolicySha256": policy["keyPolicySha256"],
                    "activationEventId": identifier(active["activationEventId"]),
                    "activationEpoch": active["epoch"],
                    "deploymentBindingSha256": policy["deploymentBindingSha256"],
                },
                "keyService": {
                    "spiffeId": f"spiffe://{DOMAIN}/service/local-key-service",
                    "endpoint": {"host": "127.0.0.1", "port": port},
                },
                "workload": {
                    "socketPath": "/run/workload/api.sock",
                    "spiffeId": policy["servicePrincipals"]["controller"],
                    "issuerNodeId": node_id,
                    "healthFile": "/run/spire-health/status.json",
                },
            },
        },
        "socket": {
            "directory": "/run/assessment-controller",
            "socketGroup": SOCKET_GROUP,
        },
        "backendServiceKeyFile": f"{prefix}/backend.key",
    }


def alias_options(source: dict) -> dict[str, str]:
    if (
        source.get("Name") != "axiom-spire-workload"
        or source.get("Driver") != "local"
        or source.get("Labels", {}).get("axiom.purpose") != "local-spire"
    ):
        raise ValueError("Source Workload API volume refused")
    path = source.get("Mountpoint", "")
    if not re.fullmatch(
        r"/[A-Za-z0-9_./-]+/axiom-spire-workload/_data", path
    ) or ".." in path.split("/"):
        raise ValueError("Source mount refused")
    return {"type": "none", "o": "bind", "device": path}
