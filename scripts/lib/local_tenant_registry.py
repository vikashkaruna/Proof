"""Read a protected, explicitly digest-reviewed LOCAL deployment registry.

AXIOM_LOCAL_TENANT_REGISTRY_FILE and AXIOM_LOCAL_TENANT_REGISTRY_SHA256 must
be configured together. Entries select deployments only: active custody,
issuer authority and exact database policy checks remain independently required.
Without either setting, preserve the three existing local demo deployments.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import NamedTuple
from uuid import UUID

MAX_BYTES = 65536
FILE_ENV = "AXIOM_LOCAL_TENANT_REGISTRY_FILE"
SHA_ENV = "AXIOM_LOCAL_TENANT_REGISTRY_SHA256"


class Deployment(NamedTuple):
    tenant_id: str
    key_service_port: int
    scheduler_port: int
    policy_sha256: str | None = None
    deployment_binding_sha256: str | None = None


# Compatibility for already-reviewed deployments; new tenants require the file.
LEGACY_DEPLOYMENTS = {
    "kosha": Deployment("fd5e0001-0000-4000-8000-000000000001", 7443, 8181),
    "sanjeevani": Deployment("fd5e0002-0000-4000-8000-000000000002", 7444, 8182),
    "nimbus": Deployment("fd5e0003-0000-4000-8000-000000000003", 7445, 8183),
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate deployment registry field refused")
        result[key] = value
    return result


def identifier(value):
    if not isinstance(value, str):
        raise TypeError("Deployment identity refused")
    parsed = UUID(value)
    if str(parsed) != value or parsed.int == 0:
        raise ValueError("Deployment identity refused")
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("Reviewed deployment digest refused")
    return value


def parse_registry(raw: bytes) -> dict[str, Deployment]:
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Deployment registry size refused")
    value = json.loads(raw, object_pairs_hook=unique_object)
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "environment", "deployments"}
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or value["environment"] != "local"
        or not isinstance(value["deployments"], list)
        or not 1 <= len(value["deployments"]) <= 100
    ):
        raise ValueError("Local deployment registry refused")
    entries, identities, ports = {}, set(), set()
    fields = {
        "alias",
        "tenantId",
        "keyServicePort",
        "schedulerPort",
        "policySha256",
        "deploymentBindingSha256",
    }
    for row in value["deployments"]:
        if not isinstance(row, dict) or set(row) != fields:
            raise ValueError("Deployment entry refused")
        alias = row["alias"]
        if not isinstance(alias, str) or not re.fullmatch(
            r"[a-z][a-z0-9-]{0,31}", alias
        ):
            raise ValueError("Deployment alias refused")
        tenant = identifier(row["tenantId"])
        selected_ports = (row["keyServicePort"], row["schedulerPort"])
        for previous_alias, previous in LEGACY_DEPLOYMENTS.items():
            if (alias == previous_alias or tenant == previous.tenant_id) and (
                alias != previous_alias
                or tenant != previous.tenant_id
                or selected_ports
                != (previous.key_service_port, previous.scheduler_port)
            ):
                raise ValueError(
                    "Existing deployment rebinding requires a separate migration review"
                )
        if any(
            type(port) is not int or not 1024 <= port <= 65535
            for port in selected_ports
        ):
            raise ValueError("Deployment port refused")
        if (
            alias in entries
            or tenant in identities
            or len(set(selected_ports)) != 2
            or ports.intersection(selected_ports)
        ):
            raise ValueError("Duplicate deployment binding refused")
        entries[alias] = Deployment(
            tenant,
            *selected_ports,
            digest(row["policySha256"]),
            digest(row["deploymentBindingSha256"]),
        )
        identities.add(tenant)
        ports.update(selected_ports)
    return entries


def deployments() -> dict[str, Deployment]:
    path_value, reviewed = os.environ.get(FILE_ENV), os.environ.get(SHA_ENV)
    if path_value is None and reviewed is None:
        return dict(LEGACY_DEPLOYMENTS)
    if not path_value or not reviewed:
        raise ValueError("Registry file and reviewed digest must be selected together")
    digest(reviewed)
    path = Path(path_value)
    parent = path.parent.stat()
    if (
        not path.is_absolute()
        or path.parent.is_symlink()
        or parent.st_uid != os.geteuid()
        or stat.S_IMODE(parent.st_mode) != 0o700
    ):
        raise ValueError("Protected registry directory refused")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or stat.S_IMODE(before.st_mode) != 0o600
            or not 0 < before.st_size <= MAX_BYTES
        ):
            raise ValueError("Protected registry file refused")
        raw = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
    ) or hashlib.sha256(raw).hexdigest() != reviewed:
        raise ValueError("Reviewed registry bytes changed")
    return parse_registry(raw)


def tenant_bindings() -> dict[str, tuple[str, int]]:
    return {
        alias: (entry.tenant_id, entry.key_service_port)
        for alias, entry in deployments().items()
    }


def scheduler_port(alias: str) -> int:
    return deployments()[alias].scheduler_port


def tenant_alias(tenant_id: str) -> str:
    tenant = identifier(tenant_id)
    for alias, entry in deployments().items():
        if entry.tenant_id == tenant:
            return alias
    raise ValueError("Tenant is outside the reviewed deployment registry")


def validate_manifest(alias: str, manifest: dict) -> dict:
    entry = deployments()[alias]
    if not isinstance(manifest, dict) or not isinstance(
        manifest.get("policyText"), str
    ):
        raise TypeError("Reviewed policy manifest refused")
    actual = hashlib.sha256(manifest["policyText"].encode()).hexdigest()
    policy = json.loads(manifest["policyText"], object_pairs_hook=unique_object)
    if (
        not isinstance(policy, dict)
        or actual != manifest.get("policySha256")
        or policy.get("tenantId") != entry.tenant_id
        or (entry.policy_sha256 is not None and actual != entry.policy_sha256)
        or (
            entry.deployment_binding_sha256 is not None
            and policy.get("deploymentBindingSha256") != entry.deployment_binding_sha256
        )
    ):
        raise ValueError("Policy differs from reviewed deployment binding")
    return policy
