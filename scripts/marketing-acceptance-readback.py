#!/usr/bin/env python3
"""Exact synthetic retained-row readback. Runtime transaction is READ ONLY.
No database writes, arbitrary SQL, cloud deployment or migration execution.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parent.parent


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


config_helper = load_module(
    "acceptance_config", "scripts/marketing-acceptance-config.py"
)
job_helper = load_module("marketing_job", "scripts/marketing-db-job.py")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def expected_source(browser: dict, library: dict) -> dict:
    config = browser["config"]
    seed = library["seed"]
    seed_hash = digest(json.dumps(seed, separators=(",", ":"), ensure_ascii=False))
    health = browser.get("health", {})
    if (
        library.get("schemaVersion") != 1
        or library.get("seedSha256") != seed_hash
        or not seed.get("controls")
        or library.get("controlCount") != len(seed["controls"])
        or len({c["id"] for c in seed["controls"]}) != len(seed["controls"])
        or any(c["library_version"] != seed["version"] for c in seed["controls"])
        or not library.get("sourceHashes")
        or any(
            not re.fullmatch(r"[a-f0-9]{64}", v)
            for v in library["sourceHashes"].values()
        )
        or health.get("status") != "healthy"
        or health.get("profile") != "marketing"
        or health.get("releaseSha") != config["releaseSha"]
        or browser.get("emailConfiguration", {})
        .get("contact", {})
        .get("emailDeliveryEnabled")
        is not False
        or browser.get("emailConfiguration", {})
        .get("report", {})
        .get("emailDeliveryEnabled")
        is not False
    ):
        raise ValueError("Exact generated library and deployed browser source required")
    if (
        browser.get("status") != "browser-and-api-green-storage-and-lifecycle-pending"
        or config.get("environment") != "preprod"
        or config["releaseSha"] != library["releaseSha"]
        or len(browser["contacts"]) != 2
        or len(browser["gapScans"]) != 1
    ):
        raise ValueError("Exact hosted synthetic browser source required")
    run = str(UUID(browser["run"]))
    contacts = []
    names = {
        "bff": "Synthetic preprod acceptance",
        "firebase-browser": "Synthetic browser acceptance",
    }
    messages = {
        "bff": f"Recorded preprod acceptance {run}; retain synthetic record without email.",
        "firebase-browser": f"Recorded browser preprod acceptance {run}; no email delivery requested.",
    }
    for record in browser["contacts"]:
        channel = record["channel"]
        email = (
            ("marketing-" if channel == "bff" else "browser-")
            + run
            + "@example.invalid"
        )
        if (
            channel not in names
            or record["email"] != email
            or record["response"]["delivery"] != "not_configured"
        ):
            raise ValueError("Only bounded synthetic source emails accepted")
        contacts.append(
            {
                "id": str(UUID(record["response"]["id"])),
                "name": names[channel],
                "email": email,
                "company": f"Synthetic {run}",
                "message": messages[channel],
            }
        )
    if len({c["id"] for c in contacts}) != 2 or {
        r["channel"] for r in browser["contacts"]
    } != set(names):
        raise ValueError("Duplicate or missing synthetic contact source")
    gap = browser["gapScans"][0]
    questions = gap["questionIds"]
    if (
        len(questions) != 12
        or len(set(questions)) != 12
        or gap["response"]["emailSent"] is not False
    ):
        raise ValueError("Canonical twelve-question no-mail source required")
    proof_hash = gap["sessionCookie"]["accessProofSha256"]
    if len(proof_hash) != 64 or any(c not in "0123456789abcdef" for c in proof_hash):
        raise ValueError("Exact hashed browser access proof required")
    return {
        "schemaVersion": 1,
        "project": config["project"],
        "releaseSha": config["releaseSha"],
        "approvalSha256": config["approvalSha256"],
        "run": run,
        "contacts": contacts,
        "gap": {
            "id": str(UUID(gap["id"])),
            "access_hash": proof_hash,
            "answers": {q: False for q in questions},
            "library_version": library["seed"]["version"],
            "posture_score": gap["response"]["postureScore"],
            "estimated_exposure_inr": gap["response"]["estimatedExposureInr"],
            "findings_count": gap["response"]["findingsCount"],
        },
    }


def validate_expected(expected: dict) -> None:
    run = str(UUID(expected["run"]))
    contacts = expected["contacts"]
    if (
        expected.get("schemaVersion") != 1
        or len(contacts) != 2
        or len({c["id"] for c in contacts}) != 2
    ):
        raise ValueError("Bounded synthetic expected rows required")
    emails = {f"marketing-{run}@example.invalid", f"browser-{run}@example.invalid"}
    if {c["email"] for c in contacts} != emails:
        raise ValueError("Only exact run-scoped synthetic email identities accepted")
    for contact in contacts:
        UUID(contact["id"])
        direct = contact["email"].startswith("marketing-")
        name = (
            "Synthetic preprod acceptance" if direct else "Synthetic browser acceptance"
        )
        message = (
            f"Recorded preprod acceptance {run}; retain synthetic record without email."
            if direct
            else f"Recorded browser preprod acceptance {run}; no email delivery requested."
        )
        if contact != {
            "id": contact["id"],
            "email": contact["email"],
            "name": name,
            "company": f"Synthetic {run}",
            "message": message,
        }:
            raise ValueError("Original synthetic submitted content required")
    gap = expected["gap"]
    UUID(gap["id"])
    if len(gap["access_hash"]) != 64 or any(
        c not in "0123456789abcdef" for c in gap["access_hash"]
    ):
        raise ValueError("Exact source access hash required")
    if len(gap["answers"]) != 12 or any(
        value is not False for value in gap["answers"].values()
    ):
        raise ValueError("Original twelve negative source answers required")


def readback_sql(expected: dict) -> str:
    # Identifiers/tables are fixed. Untrusted data is one escaped JSON literal.
    validate_expected(expected)
    literal = json.dumps(expected, separators=(",", ":")).replace("'", "''")
    return f"""begin transaction read only;
set local statement_timeout='20s';set local lock_timeout='2s';
with source as(select '{literal}'::jsonb s),
contacts as(select c.id,c.name,c.email,c.company,c.message,c.delivery_status,c.created_at,
 c.delivery_attempted_at,c.delivery_completed_at,c.provider_message_id,c.delivery_error_code
 from public.contact_inquiries c,source where exists
 (select 1 from jsonb_array_elements(s->'contacts') e where c.id=(e->>'id')::uuid
 and (c.name,c.email,c.company,c.message)=(e->>'name',e->>'email',e->>'company',e->>'message'))),
gap as(select g.id,g.answers,g.report_snapshot,g.access_token_hash,g.library_version,g.posture_score,
 g.estimated_exposure_inr,g.contact_email,g.follow_up_requested,g.created_at
 from public.gap_scan_responses g,source where g.id=(s->'gap'->>'id')::uuid and g.access_token_hash=s->'gap'->>'access_hash'),
budgets as(select r.bucket,r.subject,r.attempts,r.window_ends_at from public.request_rate_limits r
 where (r.bucket='contact-sender' and r.subject in(select encode(sha256(convert_to(lower(email),'UTF8')),'hex') from contacts))
 or(r.bucket='gap-scan-create' and r.subject in(select access_token_hash from gap)))
select json_build_object('database',current_database(),'role',current_user,
 'role_posture',(select json_build_object('superuser',rolsuper,'bypassrls',rolbypassrls) from pg_roles where rolname=current_user),
 'ssl',(select ssl from pg_stat_ssl where pid=pg_backend_pid()),
 'transaction_read_only',current_setting('transaction_read_only'),
 'contacts',(select coalesce(json_agg(contacts),'[]') from contacts),
 'gap',(select coalesce(json_agg(gap),'[]') from gap),
 'budgets',(select coalesce(json_agg(budgets),'[]') from budgets));
rollback;
"""


def validate_readback(expected: dict, actual: dict) -> dict:
    validate_expected(expected)
    if (
        actual.get("transaction_read_only") != "on"
        or actual.get("ssl") is not True
        or actual.get("role_posture") != {"superuser": False, "bypassrls": False}
    ):
        raise ValueError("Actual readonly TLS limited-role observations required")
    rows = actual["contacts"]
    if len(rows) != 2 or len(actual["gap"]) != 1:
        raise ValueError("Exact retained row counts differ")
    indexed = {row["id"]: row for row in rows}
    for contact in expected["contacts"]:
        row = indexed.get(contact["id"])
        if (
            not row
            or any(row.get(key) != value for key, value in contact.items())
            or row["delivery_status"] != "not_configured"
        ):
            raise ValueError("Retained synthetic contact content/delivery differs")
        if any(
            row.get(key) is not None
            for key in (
                "delivery_attempted_at",
                "delivery_completed_at",
                "provider_message_id",
                "delivery_error_code",
            )
        ):
            raise ValueError("Unexpected provider delivery activity")
    gap = actual["gap"][0]
    for key in (
        "id",
        "answers",
        "library_version",
        "posture_score",
        "estimated_exposure_inr",
    ):
        if gap.get(key) != expected["gap"][key]:
            raise ValueError("Retained gap source/result differs")
    snapshot = gap["report_snapshot"]
    if (
        gap["access_token_hash"] != expected["gap"]["access_hash"]
        or gap["contact_email"] is not None
        or gap["follow_up_requested"] is not False
        or snapshot["postureScore"] != expected["gap"]["posture_score"]
        or snapshot["estimatedExposureInr"] != expected["gap"]["estimated_exposure_inr"]
        or len(snapshot["findings"]) != expected["gap"]["findings_count"]
    ):
        raise ValueError("Actual stored report/access/no-mail observations differ")
    budgets = {(b["bucket"], b["subject"]): b for b in actual["budgets"]}
    keys = [
        ("contact-sender", digest(c["email"].lower())) for c in expected["contacts"]
    ] + [("gap-scan-create", expected["gap"]["access_hash"])]
    if len(budgets) != 3 or any(
        key not in budgets
        or type(budgets[key]["attempts"]) is not int
        or budgets[key]["attempts"] != 1
        for key in keys
    ):
        raise ValueError("Actual unique synthetic request-budget observations differ")
    for row in rows + [gap]:
        key = (
            ("contact-sender", digest(row["email"].lower()))
            if "email" in row
            else ("gap-scan-create", gap["access_token_hash"])
        )
        created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        window_end = datetime.fromisoformat(
            budgets[key]["window_ends_at"].replace("Z", "+00:00")
        )
        if created.tzinfo is None or window_end.tzinfo is None or window_end <= created:
            raise ValueError(
                "Observed rate window did not cover retained source timestamp"
            )
    return {
        "schemaVersion": 1,
        "project": expected["project"],
        "releaseSha": expected["releaseSha"],
        "approvalSha256": expected["approvalSha256"],
        "run": expected["run"],
        "observations": actual,
        "observationSha256": digest(
            json.dumps(actual, sort_keys=True, separators=(",", ":"))
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--browser-proof", type=Path, required=True)
    prepare.add_argument("--library", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    run = sub.add_parser("run")
    run.add_argument("--expected", type=Path, required=True)
    run.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.mode == "prepare":
            browser, browser_sha = config_helper.json_input(args.browser_proof)
            library, library_sha = config_helper.json_input(args.library)
            expected = expected_source(browser, library)
            expected["sourceHashes"] = {"browser": browser_sha, "library": library_sha}
            config_helper.write_private(args.output, expected)
        else:
            expected, _ = config_helper.json_input(args.expected)
            env = dict(os.environ)
            if (
                env.get("ENVIRONMENT") != "preprod"
                or env.get("GCP_PROJECT_ID") != expected["project"]
                or env.get("AXIOM_RELEASE_SHA") != expected["releaseSha"]
            ):
                raise ValueError("Explicit source-bound runtime target required")
            pg = job_helper.runtime_environment(env)
            result = subprocess.run(
                ["psql", "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-At"],
                input=readback_sql(expected),
                env=pg,
                capture_output=True,
                text=True,
                timeout=25,
                check=True,
            )
            actual = json.loads(result.stdout)
            if (
                actual["database"] != env["CLOUD_SQL_DATABASE_NAME"]
                or actual["role"] != env["CLOUD_SQL_ADMIN_USER"]
            ):
                raise ValueError("Observed database identity differs")
            config_helper.write_private(
                args.output, validate_readback(expected, actual)
            )
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        print(
            "Synthetic readonly acceptance readback refused; private inputs/credentials withheld"
        )
        return 1
    print(
        "Synthetic acceptance readback phase completed; no database mutation performed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
