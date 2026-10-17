#!/usr/bin/env python3
"""Run one tenant's LOCAL custody key service container (item 5).

  python3 scripts/local-key-service.py check --tenant kosha     # config/policy checks only
  python3 scripts/local-key-service.py provision --tenant kosha # create the primary key once
  python3 scripts/local-key-service.py serve --tenant kosha     # long-running service
  python3 scripts/local-key-service.py sync --tenant kosha      # re-stage renewed credentials

Layout (local-only substitutions, never production):
- Runs the BFF image's ``src/local-key-service.ts`` (via tsx, as the BFF does) as uid 20101, the SPIRE
  ``local-key-service`` identity (scripts/local-spire.py).
- Shares ``axiom-bff``'s network namespace, because the key service only listens
  on 127.0.0.1. Kosha 7443, Sanjeevani 7444, Nimbus 7445. Recreate it whenever
  axiom-bff is recreated.
- Config, the policy text and verifier credentials are staged into
  ``axiom-key-service-<tenant>-conf`` (owned by 20101, files 0600, mounted
  read-only). Master keys live only in ``axiom-key-service-<tenant>-keys``
  (0700, owned by 20101).
- The policy text is the operator-prepared manifest the owner requested. Once
  the policy is active the database must hold exactly that text (checked by
  ``provision`` and ``serve``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess  # nosec B404 - fixed docker argv lists, no shell
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.ci_fixture_images import fixture_image  # noqa: E402

TENANTS = {
    "kosha": ("fd5e0001-0000-4000-8000-000000000001", 7443),
    "sanjeevani": ("fd5e0002-0000-4000-8000-000000000002", 7444),
    "nimbus": ("fd5e0003-0000-4000-8000-000000000003", 7445),
}
UID = 20101
TRUST_DOMAIN = "local.axiomproof.test"
SPIFFE = f"spiffe://{TRUST_DOMAIN}/service/local-key-service"
CONF = "/etc/axiom/key-service"
KEYS = "/var/lib/axiom/keys"
HELPER = fixture_image(
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
)
ISSUER_ROOT = Path(
    os.environ.get(
        "AXIOM_LOCAL_CUSTODY_ISSUER_DIR", ROOT / ".axiom-runtime" / "local-custody-issuer"
    )
)


def run(args: list[str], check: bool = True, **kw) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=300, check=check, **kw)  # nosec B603 B607


def bff_image() -> str:
    return run(["docker", "inspect", "axiom-bff", "--format", "{{.Config.Image}}"]).stdout.strip()


def bff_env(name: str) -> str:
    env = json.loads(run(["docker", "inspect", "axiom-bff", "--format", "{{json .Config.Env}}"]).stdout)
    for item in env:
        key, _, value = item.partition("=")
        if key == name:
            return value
    raise SystemExit(f"axiom-bff has no {name}")


def node_id() -> str:
    return run(["docker", "exec", "axiom-spire", "cat", "/var/lib/spire/node-id"]).stdout.strip()


def manifest(tenant: str) -> dict:
    value = json.loads((ISSUER_ROOT / "manifests" / f"{tenant}.json").read_text())
    if hashlib.sha256(value["policyText"].encode("utf8")).hexdigest() != value["policySha256"]:
        raise SystemExit("manifest digest mismatch")
    return value


def database_policy_sha(tenant_id: str) -> str | None:
    out = run(
        ["docker", "exec", "-i", "-e", "PGOPTIONS=-c default_transaction_read_only=on",
         "supabase_db_axiom-owner-test", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
         "-v", f"tenant={tenant_id}", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres"],
        input="select v.policy_sha256 from public.local_custody_policy_heads h join "
        "public.local_custody_policy_versions v on v.id=h.policy_id and v.tenant_id=h.tenant_id "
        "where h.tenant_id=(:'tenant')::uuid and h.state='active';",
    )
    return out.stdout.strip() or None


def config(tenant: str, policy: dict, credentials: dict[str, str]) -> dict:
    text = json.loads(policy["policyText"])
    _, port = TENANTS[tenant]
    return {
        "policyFile": f"{CONF}/policy.json",
        "policySha256": policy["policySha256"],
        "keyDirectory": KEYS,
        "endpoint": {"host": "127.0.0.1", "port": port},
        "supabaseUrl": bff_env("SUPABASE_URL"),
        "credentials": {kind: f"{CONF}/{kind}.key" for kind in credentials},
        "workload": {
            "socketPath": "/run/workload/api.sock",
            "spiffeId": SPIFFE,
            "issuerNodeId": node_id(),
            "healthFile": "/run/spire-health/status.json",
        },
        "peers": [
            {"spiffeId": text["servicePrincipals"]["producer"], "role": "producer"},
            {"spiffeId": text["servicePrincipals"]["controller"], "role": "controller"},
        ],
    }


def stage(tenant: str, require_active: bool) -> None:
    tenant_id, _ = TENANTS[tenant]
    policy = manifest(tenant)
    active = database_policy_sha(tenant_id)
    if require_active and active != policy["policySha256"]:
        raise SystemExit("The ACTIVE database policy is not this manifest; activate it first.")
    creds_dir = ISSUER_ROOT / "credentials" / tenant_id
    credentials = {
        kind: str(creds_dir / f"{kind}.key")
        for kind in ("operator", "producer", "controller")
        if (creds_dir / f"{kind}.key").exists()
    }
    conf, keys = f"axiom-key-service-{tenant}-conf", f"axiom-key-service-{tenant}-keys"
    for volume in (conf, keys):
        run(["docker", "volume", "create", "--label", "axiom.purpose=local-key-service", volume])
    with tempfile.TemporaryDirectory(prefix="axiom-key-service-") as temp:
        staging = Path(temp)
        (staging / "policy.json").write_text(policy["policyText"])
        (staging / "config.json").write_text(json.dumps(config(tenant, policy, credentials), indent=1))
        for kind, path in credentials.items():
            (staging / f"{kind}.key").write_bytes(Path(path).read_bytes())
        helper = f"axiom-key-service-{tenant}-stage"
        run(["docker", "rm", "-f", helper], check=False)
        run(["docker", "create", "--name", helper, "--network", "none",
             "--mount", f"type=volume,src={conf},dst=/conf",
             "--mount", f"type=volume,src={keys},dst=/keys", HELPER,
             "sh", "-c", f"chown -R {UID}:{UID} /conf /keys && chmod 0700 /conf /keys && chmod 0600 /conf/*"])
        try:
            for item in staging.iterdir():
                run(["docker", "cp", "-q", str(item), f"{helper}:/conf/{item.name}"])
            run(["docker", "start", "-a", helper])
        finally:
            run(["docker", "rm", "-f", helper], check=False)
    print(f"{tenant}: staged config, policy and {sorted(credentials) or 'no'} credentials")


def container(tenant: str, mode: str, detach: bool) -> None:
    name = f"axiom-key-service-{tenant}"
    if mode == "--serve":
        run(["docker", "rm", "-f", name], check=False)
    args = ["docker", "run", "--name" if detach else "--rm", *( [name] if detach else [] ),
            *(["-d", "--restart", "unless-stopped"] if detach else []),
            "--user", f"{UID}:{UID}", "--network", "container:axiom-bff",
            "--label", "axiom.purpose=local-key-service", "--read-only", "--cap-drop", "ALL",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
            "--security-opt", "no-new-privileges:true",
            "--mount", f"type=volume,src=axiom-key-service-{tenant}-conf,dst={CONF},readonly",
            "--mount", f"type=volume,src=axiom-key-service-{tenant}-keys,dst={KEYS}",
            "--mount", "type=volume,src=axiom-spire-workload,dst=/run/workload,readonly",
            "--mount", "type=volume,src=axiom-spire-health,dst=/run/spire-health,readonly",
            "--entrypoint", "node", bff_image(), "/app/services/bff/node_modules/tsx/dist/cli.mjs",
            "src/local-key-service.ts", mode, f"{CONF}/config.json"]
    result = run(args, check=False)
    print((result.stdout or result.stderr).strip())
    if result.returncode != 0:
        raise SystemExit(f"{tenant}: key service {mode} refused")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("check", "provision", "serve", "sync"))
    parser.add_argument("--tenant", required=True, choices=sorted(TENANTS))
    args = parser.parse_args()
    if args.action == "check":
        stage(args.tenant, require_active=False)
        container(args.tenant, "--check", detach=False)
    elif args.action == "sync":
        stage(args.tenant, require_active=True)
    elif args.action == "provision":
        stage(args.tenant, require_active=True)
        container(args.tenant, "--provision", detach=False)
    else:
        stage(args.tenant, require_active=True)
        container(args.tenant, "--serve", detach=True)
