#!/usr/bin/env python3
"""Prepare source-bound hosted marketing test scope; never performs HTTP/cloud work."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent


def protected_read(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        facts = os.fstat(descriptor)
        if not stat.S_ISREG(facts.st_mode) or facts.st_mode & 0o077:
            raise ValueError("Input must be an owner-only regular file")
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            return source.read(1024 * 1024 + 1)
    finally:
        if descriptor != -1:
            os.close(descriptor)


def json_input(path: Path) -> tuple[dict, str]:
    body = protected_read(path)
    if len(body) > 1024 * 1024:
        raise ValueError("Input manifest exceeds bound")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise TypeError("Manifest object required")
    return value, hashlib.sha256(body).hexdigest()


def origin(value: str, cloud_run: bool = False) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.hostname in ("localhost", "127.0.0.1")
        or (cloud_run and not parsed.hostname.endswith(".run.app"))
    ):
        raise ValueError("Verified HTTPS origin required")
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        pass
    else:
        raise ValueError("Published DNS origin required")
    return value.rstrip("/")


def prepare(
    env_file: Path, services_file: Path, hosting_file: Path, approval_file: Path
) -> dict:
    protected_read(env_file)
    spec = importlib.util.spec_from_file_location(
        "literal", ROOT / "scripts/lib/ops-env-parse.py"
    )
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    env = parser.parse(env_file)
    services, services_hash = json_input(services_file)
    hosting, hosting_hash = json_input(hosting_file)
    approval, approval_hash = json_input(approval_file)
    project = env.get("GCP_PROJECT_ID")
    release = services.get("release_sha", "")
    if not isinstance(project, str) or not re.fullmatch(
        r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project
    ):
        raise ValueError("Explicit selected project required")
    if (
        env.get("ENVIRONMENT") != "preprod"
        or env.get("GCP_REGION") != "asia-south1"
        or env.get("AXIOM_CONTACT_EMAIL_MODE") != "disabled"
        or env.get("AXIOM_REPORT_EMAIL_MODE") != "disabled"
        or not re.fullmatch(r"[a-f0-9]{40}", release)
        or any(
            record.get("project") != project or record.get("release_sha") != release
            for record in (services, hosting, approval)
        )
        or hosting.get("services_receipt_sha256") != services_hash
        or approval.get("services_receipt_sha256") != services_hash
        or approval.get("hosting_receipt_sha256") != hosting_hash
        or approval.get("kind") != "marketing-preprod-synthetic-acceptance"
        or not isinstance(approval.get("approved_by"), str)
        or not approval["approved_by"].strip()
        or type(approval.get("max_contacts")) is not int
        or type(approval.get("max_gap_scans")) is not int
        or approval.get("max_contacts") != 2
        or approval.get("max_gap_scans") != 1
    ):
        raise ValueError("Recorded scope/source/environment mismatch")
    expires = datetime.fromisoformat(approval["expires_at"].replace("Z", "+00:00"))
    if expires.tzinfo is None or expires <= datetime.now(timezone.utc):
        raise ValueError("Recorded acceptance scope expired")
    url = origin(hosting["hosting_url"])
    canonical = origin(env["AXIOM_PROOF_MARKETING_URL"])
    if url != canonical:
        metadata = hosting.get("site_metadata")
        site = env.get("FIREBASE_HOSTING_SITE_ID", "")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,62}", site) or not isinstance(
            metadata, dict
        ):
            raise ValueError("Verified selected Firebase site API metadata required")
        projects = {project}
        number = env.get("GCP_PROJECT_NUMBER", "")
        if re.fullmatch(r"[1-9][0-9]{5,20}", number):
            projects.add(number)
        if metadata.get("name") not in {f"projects/{p}/sites/{site}" for p in projects}:
            raise ValueError(
                "Firebase site API resource differs from selected project/site"
            )
        actual_default = origin(metadata["defaultUrl"])
        if (
            url != actual_default
            or urlparse(actual_default).hostname != site + ".web.app"
        ):
            raise ValueError(
                "Runtime URL differs from actual selected site API defaultUrl"
            )
    return {
        "schemaVersion": 1,
        "environment": "preprod",
        "project": project,
        "releaseSha": release,
        "marketingUrl": url,
        "publishedCanonicalUrl": canonical,
        "bffUrl": origin(services["cloud_run_uris"]["bff"], True),
        "servicesReceiptSha256": services_hash,
        "hostingReceiptSha256": hosting_hash,
        "approvalSha256": approval_hash,
        "expiresAt": approval["expires_at"],
        "scope": {"maxContacts": 2, "maxGapScans": 1, "emailDelivery": "disabled"},
    }


def write_private(path: Path, data: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Private output regular file required")
        os.fchmod(descriptor, 0o600)
        os.ftruncate(descriptor, 0)
        with os.fdopen(descriptor, "w") as target:
            descriptor = -1
            json.dump(data, target, indent=2)
    finally:
        if descriptor != -1:
            os.close(descriptor)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    for key in (
        "env-file",
        "services-receipt",
        "hosting-receipt",
        "approval",
        "output",
    ):
        p.add_argument("--" + key, type=Path, required=True)
    args = p.parse_args()
    try:
        write_private(
            args.output,
            prepare(
                args.env_file,
                args.services_receipt,
                args.hosting_receipt,
                args.approval,
            ),
        )
    except (OSError, ValueError, KeyError, TypeError):
        print(
            "Hosted marketing acceptance configuration refused; no network work performed"
        )
        return 1
    print(
        "Protected hosted acceptance configuration prepared; no network work performed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
