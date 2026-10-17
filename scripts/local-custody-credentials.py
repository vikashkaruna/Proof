#!/usr/bin/env python3
"""Issue (or renew) one local custody verifier credential with the protected
issuer, for an ACTIVE custody policy on the local owner-test stack.

  python3 scripts/local-custody-credentials.py issue --tenant-id <uuid> --kind producer
  python3 scripts/local-custody-credentials.py issue --tenant-id <uuid> --kind producer --renew

It reads the active policy head, policy text and activation event (read-only),
builds the canonical request (scripts/lib/local_custody_credentials.py), runs
the unchanged issuer (python -I) into a fresh 0700 output directory, then
atomically publishes the credential at the stable path the key service reads:
``<root>/credentials/<tenant>/<kind>.key`` (0600, regular file). ``--renew``
names the last issued credential as predecessor. Each bearer lasts <= 1 h, so
renew at least every ~45 minutes. Nothing here activates a policy.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess  # nosec B404 - fixed docker/python argv lists, no shell
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.local_custody_credentials import KINDS, issue_request  # noqa: E402

DB = "supabase_db_axiom-owner-test"
ISSUER_ROOT = Path(
    os.environ.get(
        "AXIOM_LOCAL_CUSTODY_ISSUER_DIR", ROOT / ".axiom-runtime" / "local-custody-issuer"
    )
)


def sql(query: str, tenant: str) -> str:
    # The tenant travels as a psql variable (:'tenant'), never spliced into SQL.
    out = subprocess.run(  # nosec B603 B607 - fixed docker argv, read-only session, no shell
        ["docker", "exec", "-i", "-e", "PGOPTIONS=-c default_transaction_read_only=on", DB, "psql",
         "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", f"tenant={tenant}", "-h", "127.0.0.1",
         "-U", "supabase_admin", "-d", "postgres"],
        input=query, capture_output=True, text=True, timeout=30, check=True,
    )
    return out.stdout.strip()


def active_policy(tenant: str) -> dict:
    tenant = str(uuid.UUID(tenant))
    row = sql(
        "select json_build_object('policyText',v.policy_text,'policySha256',v.policy_sha256,"
        "'epoch',h.activation_epoch,'activationEventId',(select e.id from public.local_custody_policy_events e"
        " where e.tenant_id=h.tenant_id and e.policy_id=h.policy_id and e.transition='activate'"
        " and e.activation_epoch=h.activation_epoch))"
        " from public.local_custody_policy_heads h join public.local_custody_policy_versions v"
        " on v.id=h.policy_id and v.tenant_id=h.tenant_id where h.tenant_id=(:'tenant')::uuid and h.state='active';",
        tenant,
    )
    if not row:
        raise SystemExit("No ACTIVE custody policy for this tenant: request, approve and activate it first.")
    value = json.loads(row)
    if not value["activationEventId"]:
        raise SystemExit("Active policy has no activation event; refusing.")
    return value


def issue(tenant: str, kind: str, renew: bool) -> None:
    if kind not in KINDS:
        raise SystemExit("kind must be operator, producer or controller")
    policy = active_policy(tenant)
    settings = ISSUER_ROOT / "settings.json"
    settings_sha = (ISSUER_ROOT / "settings.sha256").read_text().strip()
    base = ISSUER_ROOT / "credentials" / tenant
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    last = base / f"{kind}.last"
    predecessor = last.read_text().strip() if renew and last.exists() else None
    if renew and predecessor is None:
        raise SystemExit("No previous credential to renew; issue first.")
    raw, digest = issue_request(
        policy_text=policy["policyText"],
        policy_sha256=policy["policySha256"],
        activation_event_id=policy["activationEventId"],
        activation_epoch=int(policy["epoch"]),
        configuration_sha256=settings_sha,
        kind=kind,
        issued_at=int(time.time()) - 5,
        reason=f"Local retained runtime {kind} verifier credential",
        predecessor_id=predecessor,
    )
    credential_id = json.loads(raw)["credentialId"]
    review = base / f"{credential_id}.request.json"
    fd = os.open(review, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
    target = base / credential_id
    subprocess.run(  # nosec B603 - fixed issuer path, isolated interpreter
        [sys.executable, "-I", str(ROOT / "infra/local-custody-issuer/issuer.py"), "--issue",
         str(review), digest, str(settings), settings_sha, str(target)],
        check=True, timeout=120,
    )
    key = (target / "backend.key").read_bytes()
    staged = base / f".{kind}.key.{credential_id}"
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(key)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(staged, base / f"{kind}.key")
    last.write_text(credential_id)
    last.chmod(0o600)
    print(f"{kind} credential {credential_id} published at {base / (kind + '.key')}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("issue")
    p.add_argument("--tenant-id", required=True)
    p.add_argument("--kind", required=True, choices=KINDS)
    p.add_argument("--renew", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    issue(args.tenant_id, args.kind, args.renew)
