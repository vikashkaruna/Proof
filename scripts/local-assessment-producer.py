#!/usr/bin/env python3
"""Stage/check/serve the local, wrap-only assessment producer for all demo tenants.

stage reads current active custody policies and exact retained manifests, then
stages protected files. check runs read-only registration/configuration checks;
it does not prove SVID/key-service/SQL enqueue readiness. serve replaces only
this launcher's labelled producer container. No database writes are performed.
BFF mounts SOCKET_VOLUME read-only at SOCKET and CLIENT_VOLUME read-only at
CLIENT; configure AXIOM_ASSESSMENT_PRODUCER_SOCKET_CONFIG_FILE=CLIENT/config.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess  # nosec B404 - fixed argv, no shell, sanitized failures
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.ci_fixture_images import fixture_image  # noqa: E402

UID, GROUP = 20102, 20110
NAME = "axiom-assessment-producer"
CONF_VOLUME, SOCKET_VOLUME, CLIENT_VOLUME = (
    f"{NAME}-{suffix}" for suffix in ("conf", "socket", "client")
)
CONF, SOCKET, CLIENT = (
    "/etc/axiom/assessment-producer",
    "/run/axiom-producer",
    "/run/axiom-producer-client",
)
PURPOSE = "local-assessment-producer"
DOMAIN = "local.axiomproof.test"
TENANTS = {
    "kosha": ("fd5e0001-0000-4000-8000-000000000001", 7443),
    "sanjeevani": ("fd5e0002-0000-4000-8000-000000000002", 7444),
    "nimbus": ("fd5e0003-0000-4000-8000-000000000003", 7445),
}
ISSUER_ROOT = Path(
    os.environ.get(
        "AXIOM_LOCAL_CUSTODY_ISSUER_DIR", ROOT / ".axiom-runtime/local-custody-issuer"
    )
)
HELPER = fixture_image(
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
)


def run(
    args: list[str], check: bool = True, **kwargs
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, text=True, capture_output=True, timeout=300, check=check, **kwargs
    )  # nosec B603 B607 - fixed docker argv, never shell


def checked_uuid(value: str) -> str:
    parsed = str(UUID(value))
    if parsed != value:
        raise ValueError("Non-canonical identity refused")
    return parsed


def read_manifest(tenant: str) -> dict:
    value = json.loads((ISSUER_ROOT / "manifests" / f"{tenant}.json").read_text())
    if not isinstance(value, dict) or set(value) != {"policyText", "policySha256"}:
        raise ValueError("Manifest refused")
    if (
        hashlib.sha256(value["policyText"].encode()).hexdigest()
        != value["policySha256"]
    ):
        raise ValueError("Manifest refused")
    return value


def active_policies() -> list[dict]:
    # Constants only; PGOPTIONS enforces read-only even if this query changes.
    tenants = ",".join(checked_uuid(value[0]) for value in TENANTS.values())
    sql = "select coalesce(jsonb_agg(jsonb_build_object('tenantId',h.tenant_id,'policyId',v.id,'policyText',v.policy_text,'policySha256',v.policy_sha256,'keyPolicySha256',v.key_policy_sha256,'activationEventId',a.id,'activationEpoch',h.activation_epoch)), '[]'::jsonb) from public.local_custody_policy_heads h join public.local_custody_policy_versions v on v.id=h.policy_id and v.tenant_id=h.tenant_id join public.local_custody_policy_events a on a.tenant_id=h.tenant_id and a.policy_id=h.policy_id and a.activation_epoch=h.activation_epoch and a.transition='activate' where h.state='active' and h.tenant_id = any(string_to_array(:'tenant_ids',',')::uuid[]);"
    output = run(
        [
            "docker",
            "exec",
            "-i",
            "-e",
            "PGOPTIONS=-c default_transaction_read_only=on",
            "supabase_db_axiom-owner-test",
            "psql",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-v",
            f"tenant_ids={tenants}",
            "-h",
            "127.0.0.1",
            "-U",
            "supabase_admin",
            "-d",
            "postgres",
        ],
        input=sql,
    )
    rows = json.loads(output.stdout)
    if not isinstance(rows, list):
        raise ValueError("Active policies refused")
    return rows


def build_config(
    policies: list[dict], manifests: dict[str, dict], node_id: str
) -> tuple[dict, dict]:
    if not re.fullmatch(
        r"spiffe://local\.axiomproof\.test/spire/agent/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)+",
        node_id,
    ):
        raise ValueError("Issuer refused")
    expected = {value[0] for value in TENANTS.values()}
    if (
        len(policies) != len(expected)
        or {row["tenantId"] for row in policies} != expected
    ):
        raise ValueError("One active policy per demo tenant is required")
    rows = {row["tenantId"]: row for row in policies}
    entries = []
    for slug, (tenant_id, port) in TENANTS.items():
        row, manifest = rows[tenant_id], manifests[slug]
        text = manifest["policyText"]
        sha = hashlib.sha256(text.encode()).hexdigest()
        policy = json.loads(text)
        if (
            row["policyText"] != text
            or row["policySha256"] != sha
            or manifest["policySha256"] != sha
            or policy["tenantId"] != tenant_id
            or policy["policyId"] != row["policyId"]
            or policy["keyPolicySha256"] != row["keyPolicySha256"]
        ):
            raise ValueError("Active policy does not match reviewed manifest")
        for field in ("policySha256", "keyPolicySha256"):
            if not re.fullmatch(r"[a-f0-9]{64}", row[field]):
                raise ValueError("Custody digest refused")
        if not re.fullmatch(r"[a-f0-9]{64}", policy["deploymentBindingSha256"]):
            raise ValueError("Deployment digest refused")
        if (
            type(row["activationEpoch"]) is not int
            or not 1 <= row["activationEpoch"] <= 9007199254740991
        ):
            raise ValueError("Activation epoch refused")
        principals = policy["servicePrincipals"]
        if principals != {
            "producer": f"spiffe://{DOMAIN}/service/assessment-dispatch-producer",
            "controller": f"spiffe://{DOMAIN}/controller/assessment",
        }:
            raise ValueError("Policy principals refused")
        entries.append(
            {
                "tenantId": tenant_id,
                "workloadId": checked_uuid(policy["targetWorkloadId"]),
                "trustDomain": DOMAIN,
                "keys": {
                    "provider": "local",
                    "custody": {
                        "custodyPolicyId": checked_uuid(row["policyId"]),
                        "custodyPolicySha256": sha,
                        "keyPolicySha256": row["keyPolicySha256"],
                        "activationEventId": checked_uuid(row["activationEventId"]),
                        "activationEpoch": row["activationEpoch"],
                        "deploymentBindingSha256": policy["deploymentBindingSha256"],
                    },
                    "keyService": {
                        "spiffeId": f"spiffe://{DOMAIN}/service/local-key-service",
                        "endpoint": {"host": "127.0.0.1", "port": port},
                    },
                    "workload": {
                        "socketPath": "/run/workload/api.sock",
                        "spiffeId": principals["producer"],
                        "issuerNodeId": node_id,
                        "healthFile": "/run/spire-health/status.json",
                    },
                },
            }
        )
    producer = {
        "producer": {"schemaVersion": 1, "tenants": entries},
        "socket": {"directory": SOCKET, "socketGroup": GROUP},
        "backendFile": f"{CONF}/backend.json",
    }
    client = {
        "schemaVersion": 1,
        "socketPath": f"{SOCKET}/producer.sock",
        "producerUid": UID,
        "socketGroup": GROUP,
        "tenantIds": [entry["tenantId"] for entry in entries],
    }
    return producer, client


def backend_config() -> dict[str, str]:
    raw = json.loads(
        run(
            ["docker", "inspect", "axiom-bff", "--format", "{{json .Config.Env}}"]
        ).stdout
    )
    env = dict(value.split("=", 1) for value in raw)
    names = {
        "url": "SUPABASE_URL",
        "anonKey": "SUPABASE_ANON_KEY",
        "serviceKey": "SUPABASE_SERVICE_KEY",
        "humanWriterKey": "SUPABASE_HUMAN_ACTION_WRITER_KEY",
    }
    result = {key: env[name] for key, name in names.items()}
    parsed = urlsplit(result["url"])
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Backend refused")
    if any(not 32 <= len(result[key]) <= 4096 for key in names if key != "url"):
        raise ValueError("Backend refused")
    return result


def owned_container(name: str) -> dict | None:
    value = run(["docker", "inspect", name], check=False)
    if value.returncode:
        return None
    info = json.loads(value.stdout)[0]
    if info.get("Config", {}).get("Labels", {}).get("axiom.purpose") != PURPOSE:
        raise ValueError("Foreign container refused")
    return info


def remove_owned(name: str) -> None:
    if name not in (NAME, f"{NAME}-stage"):
        raise ValueError("Container name refused")
    if owned_container(name) is not None:
        run(["docker", "rm", "-f", name])


def ensure_volume(name: str) -> None:
    if name not in (CONF_VOLUME, SOCKET_VOLUME, CLIENT_VOLUME):
        raise ValueError("Volume name refused")
    found = run(["docker", "volume", "inspect", name], check=False)
    if found.returncode == 0:
        info = json.loads(found.stdout)[0]
        if info.get("Labels", {}).get("axiom.purpose") != PURPOSE:
            raise ValueError("Foreign volume refused")
    else:
        run(["docker", "volume", "create", "--label", f"axiom.purpose={PURPOSE}", name])


def stage() -> None:
    current = owned_container(NAME)
    if current and current.get("State", {}).get("Running"):
        raise ValueError("Stop the producer before restaging")
    producer, client = build_config(
        active_policies(),
        {slug: read_manifest(slug) for slug in TENANTS},
        run(
            ["docker", "exec", "axiom-spire", "cat", "/var/lib/spire/node-id"]
        ).stdout.strip(),
    )
    backend = backend_config()
    for volume in (CONF_VOLUME, SOCKET_VOLUME, CLIENT_VOLUME):
        ensure_volume(volume)
    helper = f"{NAME}-stage"
    remove_owned(helper)
    command = f'chown -R {UID}:{UID} /conf && chmod 0700 /conf && chmod 0600 /conf/* && chown 0:0 /client /client/config.json && chmod 0700 /client && chmod 0600 /client/config.json && test -z "$(find /socket -mindepth 1 ! -name producer.sock -print -quit)" && rm -f /socket/producer.sock && chown {UID}:{GROUP} /socket && chmod 0700 /socket'
    run(
        [
            "docker",
            "create",
            "--pull",
            "never",
            "--name",
            helper,
            "--network",
            "none",
            "--label",
            f"axiom.purpose={PURPOSE}",
            "--mount",
            f"type=volume,src={CONF_VOLUME},dst=/conf",
            "--mount",
            f"type=volume,src={SOCKET_VOLUME},dst=/socket",
            "--mount",
            f"type=volume,src={CLIENT_VOLUME},dst=/client",
            HELPER,
            "sh",
            "-c",
            command,
        ]
    )
    try:
        with tempfile.TemporaryDirectory(
            prefix="axiom-assessment-producer-"
        ) as temporary:
            directory = Path(temporary)
            for name, data, destination in (
                ("config.json", producer, "/conf/config.json"),
                ("backend.json", backend, "/conf/backend.json"),
                ("client.json", client, "/client/config.json"),
            ):
                path = directory / name
                with os.fdopen(
                    os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
                ) as output:
                    json.dump(data, output)
                run(["docker", "cp", "-q", str(path), f"{helper}:{destination}"])
            run(["docker", "start", "-a", helper])
    finally:
        remove_owned(helper)
    print("Local producer configuration staged for three demo organisations.")


def reviewed_image(image: str | None) -> str:
    if image is None:
        image = run(
            ["docker", "inspect", "axiom-bff", "--format", "{{.Image}}"]
        ).stdout.strip()
    if not image or image.startswith("-") or re.search(r"\s", image):
        raise ValueError("Image refused")
    resolved = run(
        ["docker", "image", "inspect", image, "--format", "{{.Id}}"]
    ).stdout.strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", resolved):
        raise ValueError("Image refused")
    return resolved


def container_args(action: str, image: str) -> list[str]:
    if action not in ("check", "serve") or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", image
    ):
        raise ValueError("Producer launch refused")
    args = ["docker", "run", "--pull", "never"]
    args += (
        ["--name", NAME, "-d", "--restart", "unless-stopped", "--stop-timeout", "40"]
        if action == "serve"
        else ["--rm"]
    )
    args += [
        "--label",
        f"axiom.purpose={PURPOSE}",
        "--user",
        f"{UID}:{UID}",
        "--group-add",
        str(GROUP),
        "--network",
        "container:axiom-bff",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",  # nosec B108 - private container tmpfs
        "--mount",
        f"type=volume,src={CONF_VOLUME},dst={CONF},readonly",
        "--mount",
        f"type=volume,src={SOCKET_VOLUME},dst={SOCKET}",
        "--mount",
        "type=volume,src=axiom-spire-workload,dst=/run/workload,readonly",
        "--mount",
        "type=volume,src=axiom-spire-health,dst=/run/spire-health,readonly",
        "--workdir",
        "/app/services/bff",
        "--entrypoint",
        "/sbin/tini",
        image,
        "--",
        "node",
        "/app/services/bff/node_modules/tsx/dist/cli.mjs",
        "src/local-assessment-producer.ts",
        f"--{action if action == 'check' else 'serve'}",
        f"{CONF}/config.json",
    ]
    return args


def container(action: str, image: str | None) -> None:
    resolved = reviewed_image(image)
    if action == "serve":
        remove_owned(NAME)
    # Existing socket/config volumes must already have been staged explicitly.
    result = run(container_args(action, resolved), check=False)
    if result.returncode:
        raise ValueError("Producer launch refused")
    print(
        "Local producer check passed."
        if action == "check"
        else "Local assessment producer started."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("stage", "check", "serve"))
    parser.add_argument(
        "--image",
        help="Explicit reviewed, preloaded candidate image; resolved to its local immutable image ID",
    )
    args = parser.parse_args()
    try:
        if args.action == "stage":
            stage()
        else:
            container(args.action, args.image)
    except (Exception, KeyboardInterrupt):
        # Never echo docker argv, backend output, file contents or exception text.
        print("Local assessment producer operation refused.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
