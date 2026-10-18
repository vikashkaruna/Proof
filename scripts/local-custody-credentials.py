#!/usr/bin/env python3
"""Issue (or renew) one local custody verifier credential with the protected
issuer, for an ACTIVE custody policy on the local owner-test stack.

  python3 scripts/local-custody-credentials.py issue --tenant-id <uuid> --kind producer
  python3 scripts/local-custody-credentials.py issue --tenant-id <uuid> --kind producer --renew
  python3 scripts/local-custody-credentials.py renew-due              # all tenants, once
  python3 scripts/local-custody-credentials.py renew-due --watch 600  # keep renewing

It reads the active policy head, policy text and activation event (read-only),
builds the canonical request (scripts/lib/local_custody_credentials.py), runs
the unchanged issuer (python -I) into a fresh 0700 output directory, then
atomically publishes the credential at the stable path the key service reads:
``<root>/credentials/<tenant>/<kind>.key`` (0600, regular file). ``--renew``
names the last issued credential as predecessor. Each bearer lasts <= 1 h.
``renew-due`` renews every published credential with <= 20 minutes left and
re-stages that tenant's key service (``local-key-service.py sync``), which reads
the credential per request. Nothing here activates a policy.
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
from lib.local_custody_credentials import (
    DEFAULT_RENEW_MARGIN_S,
    KINDS,
    issue_request,
    last_expiry,
    renewal_due,
)
from lib.local_tenant_registry import tenant_alias, validate_manifest

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
    alias = tenant_alias(tenant)
    policy = active_policy(tenant)
    validate_manifest(alias, policy)
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



def due_kinds(base: Path, now: int, margin_s: int) -> list[str]:
    due = []
    for kind in KINDS:
        last = base / f"{kind}.last"
        if not last.exists():
            continue
        credential_id = last.read_text().strip()
        request = base / f"{credential_id}.request.json"
        try:
            expires_at = last_expiry(request.read_bytes(), credential_id)
        except (OSError, ValueError) as error:
            raise SystemExit(f"{base.name} {kind}: cannot read the last credential's expiry ({error}); renew it by hand")
        if renewal_due(expires_at, now, margin_s):
            due.append(kind)
    return due


def renew_due(tenant: str | None, margin_s: int, key_service_image: str | None = None) -> int:
    """Renew what is due; return how many tenants failed (0 = all fine)."""
    if key_service_image is not None and tenant is None:
        raise ValueError("Pinned key service image requires one explicit tenant")
    root = ISSUER_ROOT / "credentials"
    tenants = [str(uuid.UUID(tenant))] if tenant else sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else []
    failures = 0
    for tenant_id in tenants:
        try:
            kinds = due_kinds(root / tenant_id, int(time.time()), margin_s)
            for kind in kinds:
                issue(tenant_id, kind, renew=True)
            if kinds:
                name = tenant_alias(tenant_id)
                subprocess.run(  # nosec B603 - fixed launcher path, isolated interpreter
                    [sys.executable, "-I", str(ROOT / "scripts/local-key-service.py"), "sync", "--tenant", name,
                     *(["--image", key_service_image] if key_service_image is not None else [])],
                    check=True, timeout=300,
                )
            print(f"{tenant_id}: renewed {kinds or 'nothing (not due)'}")
        except (SystemExit, subprocess.SubprocessError, OSError, ValueError, TypeError) as error:
            failures += 1
            print(f"{tenant_id}: renewal FAILED: {error}", file=sys.stderr)
    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("issue")
    p.add_argument("--tenant-id", required=True)
    p.add_argument("--kind", required=True, choices=KINDS)
    p.add_argument("--renew", action="store_true")
    r = sub.add_parser("renew-due")
    r.add_argument("--tenant-id")
    r.add_argument("--key-service-image")
    r.add_argument("--margin", type=int, default=DEFAULT_RENEW_MARGIN_S)
    r.add_argument("--watch", type=int, metavar="SECONDS", help="repeat every SECONDS (60..1200)")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "issue":
        issue(args.tenant_id, args.kind, args.renew)
    else:
        if args.watch is not None and not 60 <= args.watch <= 1200:
            raise SystemExit("--watch must be 60..1200 seconds")
        while True:
            failed = renew_due(args.tenant_id, args.margin, args.key_service_image)
            if args.watch is None:
                raise SystemExit(1 if failed else 0)
            time.sleep(args.watch)
