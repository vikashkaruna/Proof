"""Offline SPIRE deployment policy. No enrollment, credentials or cloud calls."""

from __future__ import annotations

import ipaddress
import json
import re

VERSION = "1.15.3"
RELEASE_SHA256 = {
    "arm64": "a9982b3ca7de489def22265fd4586d8e13091ecb6fddf6adcea9291313b18886",
    "amd64": "ca1a4d1155317bdd2afc7f36663828a10410c7c840e54725b90b4064b0a301c7",
}
SERVER_SOCKET = "/run/spire-server/api.sock"
WORKLOAD_SOCKET = "/run/workload/api.sock"
FIELDS = {
    "schemaVersion", "trustDomain", "projectId", "runnerInstanceId",
    "issuerPrivateIp", "controllerImageConfigDigest", "assessmentImageConfigDigest",
}


def _match(value: object, pattern: str, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum or not re.fullmatch(pattern, value):
        raise ValueError("SPIRE deployment policy refused")
    return value


def deployment_bundle(value: object) -> dict[str, str]:
    """Render a reviewable bundle for exactly one runner and two implemented roles.

    An entry binds ALL selectors to the immutable node parent. This deliberately
    does not create a project-wide node alias, UID-only entry or admin workload.
    GCP IIT may attest other project nodes, but these entries authorize none of
    their workloads. Activation/revocation is a separate reviewed operation.
    """
    if not isinstance(value, dict) or set(value) != FIELDS or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise ValueError("SPIRE deployment policy refused")
    domain = _match(value["trustDomain"], r"[a-z0-9]+(?:[.-][a-z0-9]+)*", 253)
    # Match the existing application's canonical DNS trust-domain contract.
    if any(len(part) > 63 or part.startswith("-") or part.endswith("-") for part in domain.split(".")):
        raise ValueError("SPIRE deployment policy refused")
    project = _match(value["projectId"], r"[a-z][a-z0-9-]{4,28}[a-z0-9]", 30)
    instance = _match(value["runnerInstanceId"], r"[1-9][0-9]{0,19}", 20)
    if int(instance) > 2**64 - 1:
        raise ValueError("SPIRE deployment policy refused")
    ip = _match(value["issuerPrivateIp"], r"[0-9.]+", 15)
    address = ipaddress.IPv4Address(ip)
    if not any(address in ipaddress.IPv4Network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
        raise ValueError("SPIRE deployment policy refused")
    images = [_match(value[field], r"sha256:[0-9a-f]{64}", 71) for field in (
        "controllerImageConfigDigest", "assessmentImageConfigDigest",
    )]
    parent = f"spiffe://{domain}/spire/agent/gcp_iit/{project}/{instance}"
    # All substitutions are already canonical; JSON quoting is HCL-safe here.
    q = json.dumps
    server = f'''server {{
 bind_address = {q(ip)}
 bind_port = 8081
 socket_path = "{SERVER_SOCKET}"
 trust_domain = {q(domain)}
 data_dir = "/var/lib/spire/server"
 log_level = "ERROR"
 default_jwt_svid_ttl = "5m"
}}
plugins {{
 DataStore "sql" {{ plugin_data {{ database_type = "sqlite3" connection_string = "/var/lib/spire/server/db.sqlite3" }} }}
 KeyManager "disk" {{ plugin_data {{ keys_path = "/var/lib/spire/server/keys.json" }} }}
 NodeAttestor "gcp_iit" {{ plugin_data {{ projectid_allow_list = [{q(project)}] use_instance_metadata = false }} }}
}}
'''
    agent = f'''agent {{
 data_dir = "/var/lib/spire/agent"
 log_level = "ERROR"
 log_selectors = []
 trust_domain = {q(domain)}
 server_address = {q(ip)}
 server_port = 8081
 socket_path = "{WORKLOAD_SOCKET}"
 admin_socket_path = "/run/spire-admin/api.sock"
 trust_bundle_path = "/etc/axiom/spire/bootstrap.pem"
 insecure_bootstrap = false
 rebootstrap_mode = "never"
 allow_unauthenticated_verifiers = false
 disable_sds_api = true
}}
plugins {{
 KeyManager "disk" {{ plugin_data {{ directory = "/var/lib/spire/agent" }} }}
 NodeAttestor "gcp_iit" {{ plugin_data {{}} }}
 WorkloadAttestor "unix" {{ plugin_data {{}} }}
 WorkloadAttestor "docker" {{ plugin_data {{ docker_socket_path = "unix:///var/run/docker.sock" use_new_container_locator = true verbose_container_locator_logs = false }} }}
}}
'''
    registrations = []
    for path, uid, digest in zip(("controller/assessment", "agent/parikshan"), (20000, 20003), images):
        registrations.append([
            "spire-server", "entry", "create", "-socketPath", SERVER_SOCKET,
            "-parentID", parent, "-spiffeID", f"spiffe://{domain}/{path}",
            "-selector", f"unix:uid:{uid}", "-selector", f"docker:image_config_digest:{digest}",
            "-jwtSVIDTTL", "300", "-x509SVIDTTL", "300",
        ])
    release = {"version": VERSION, "sha256": RELEASE_SHA256, "expectedNodeId": parent}
    return {
        "server.conf": server, "agent.conf": agent,
        "registration-argv.json": json.dumps(registrations, indent=2) + "\n",
        "release.json": json.dumps(release, indent=2) + "\n",
    }
