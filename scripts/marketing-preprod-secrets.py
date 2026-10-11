#!/usr/bin/env python3
"""Materialize approved marketing secrets from the private file, without rotation.

Requires real Terraform database outputs. Existing differing payloads refuse;
matching payloads reuse their exact version. Passwords never appear in argv/logs.
"""
from __future__ import annotations

import argparse
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("ops_env_parse", ROOT / "scripts/lib/ops-env-parse.py")
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


def verify_secret_descriptor(raw: str, env: dict[str, str], secret: str) -> None:
    descriptor = json.loads(raw)
    projects = [env["GCP_PROJECT_ID"]]
    if re.fullmatch(r"[0-9]+", env.get("GCP_PROJECT_NUMBER", "")):
        projects.append(env["GCP_PROJECT_NUMBER"])
    names = {f"projects/{project}/secrets/{secret}" for project in projects}
    expected_replication = {"userManaged": {"replicas": [{"location": env["GCP_REGION"]}]}}
    if not isinstance(descriptor, dict) or descriptor.get("name") not in names or descriptor.get("replication") != expected_replication:
        raise ValueError("Secret ownership or regional replication differs")


def materialize(env: dict[str, str], database: dict, dry_run: bool) -> dict:
    project = env["GCP_PROJECT_ID"]
    if env.get("ENVIRONMENT") != "preprod" or env.get("GCP_REGION") != "asia-south1" or env.get("AXIOM_DEPLOYMENT_PROFILE") != "marketing":
        raise ValueError("Wrong deployment profile")
    address = ipaddress.IPv4Address(database["private_ip"])
    private_ranges = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    if database.get("connection_name") != f"{project}:{env['GCP_REGION']}:{env['CLOUD_SQL_INSTANCE_NAME']}" or database["instance"] != env["CLOUD_SQL_INSTANCE_NAME"] or database["name"] != env["CLOUD_SQL_DATABASE_NAME"] or not any(address in ipaddress.IPv4Network(cidr) for cidr in private_ranges):
        raise ValueError("Database outputs do not match the approved environment")
    host = database["private_ip"]
    name = quote(database["name"], safe="")
    def uri(user: str, password: str, auth: bool = False) -> str:
        value = f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}@{host}:5432/{name}?sslmode=require"
        return value + "&search_path=auth" if auth else value

    secret_keys = [
        "MARKETING_AUTH_DB_URL_SECRET", "MARKETING_REST_DB_URL_SECRET",
        "MARKETING_JWT_SECRET", "MARKETING_SERVICE_KEY_SECRET",
        "MARKETING_ADMIN_DB_URL_SECRET", "MARKETING_AUTH_PASSWORD_SECRET",
        "MARKETING_REST_PASSWORD_SECRET",
    ]
    if "delivery" in [env.get("AXIOM_CONTACT_EMAIL_MODE"), env.get("AXIOM_REPORT_EMAIL_MODE")]:
        secret_keys.append("MARKETING_EMAIL_KEY_SECRET")
    # JWT is one shared payload consumed by Auth and REST. Other payloads must
    # never collapse into the same Secret Manager ID before cloud mutations.
    secret_ids = [env[key] for key in secret_keys]
    if len(set(secret_ids)) != len(secret_ids):
        raise ValueError("Distinct secret payload identifiers required")
    if any(not re.fullmatch(r"axiom-proof-preprod-[a-z0-9-]+", secret) for secret in secret_ids):
        raise ValueError("Invalid secret configuration")
    credential_keys = ["GOTRUE_DB_PASSWORD", "REST_DB_PASSWORD", "CLOUD_SQL_ADMIN_PASSWORD", "SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_KEY"]
    if "MARKETING_EMAIL_KEY_SECRET" in secret_keys:
        credential_keys.append("RESEND_API_KEY")
    # Validate originals before URI escaping can disguise a template placeholder.
    if any(not env[key] or "placeholder" in env[key].lower() or re.search(r"<[^>]+>", env[key]) for key in credential_keys):
        raise ValueError("Invalid secret configuration")

    payloads = {
        env["MARKETING_AUTH_DB_URL_SECRET"]: uri("supabase_auth_admin", env["GOTRUE_DB_PASSWORD"], True),
        env["MARKETING_REST_DB_URL_SECRET"]: uri("authenticator", env["REST_DB_PASSWORD"]),
        env["MARKETING_JWT_SECRET"]: env["SUPABASE_JWT_SECRET"],
        env["MARKETING_SERVICE_KEY_SECRET"]: env["SUPABASE_SERVICE_KEY"],
        env["MARKETING_ADMIN_DB_URL_SECRET"]: uri(env["CLOUD_SQL_DATABASE_USER"], env["CLOUD_SQL_ADMIN_PASSWORD"]),
        env["MARKETING_AUTH_PASSWORD_SECRET"]: env["GOTRUE_DB_PASSWORD"],
        env["MARKETING_REST_PASSWORD_SECRET"]: env["REST_DB_PASSWORD"],
    }
    if "delivery" in [env.get("AXIOM_CONTACT_EMAIL_MODE"), env.get("AXIOM_REPORT_EMAIL_MODE")]:
        payloads[env["MARKETING_EMAIL_KEY_SECRET"]] = env["RESEND_API_KEY"]
    # Validate the complete batch before any payload can be written.
    if any(not payload or "placeholder" in payload.lower() or re.search(r"<[^>]+>", payload) for payload in payloads.values()):
        raise ValueError("Invalid secret configuration")
    versions = {}
    for secret, payload in payloads.items():
        if dry_run:
            versions[secret] = "planned"
            continue
        common = ["--project=" + project, "--billing-project=" + project]
        read = subprocess.run(["gcloud", "secrets", "describe", secret, *common, "--format=json"], capture_output=True, text=True, timeout=30)
        if read.returncode:
            if not re.search(r"\bNOT_FOUND\b", read.stderr) or re.search(r"PERMISSION_DENIED|UNAUTHENTICATED|FORBIDDEN", read.stderr):
                raise ValueError("Secret inventory could not prove absence")
            create = subprocess.run(["gcloud", "secrets", "create", secret, *common, "--replication-policy=user-managed", "--locations=" + env["GCP_REGION"], "--quiet"], capture_output=True, text=True, timeout=45)
            if create.returncode:
                raise ValueError("Secret creation failed")
            # A creation acknowledgement does not prove resource ownership or
            # regional replication; read the actual resulting descriptor.
            read = subprocess.run(["gcloud", "secrets", "describe", secret, *common, "--format=json"], capture_output=True, text=True, timeout=30)
            if read.returncode:
                raise ValueError("Created secret descriptor unavailable")
        verify_secret_descriptor(read.stdout, env, secret)
        listed = subprocess.run(["gcloud", "secrets", "versions", "list", secret, *common, "--format=json(name,state)"], capture_output=True, text=True, timeout=30)
        if listed.returncode:
            raise ValueError("Secret version inventory failed")
        existing = json.loads(listed.stdout or "[]")
        if not isinstance(existing, list):
            raise ValueError("Malformed secret inventory")
        def ordinal(record: dict) -> int:
            if not isinstance(record, dict) or not isinstance(record.get("name"), str):
                raise ValueError("Malformed secret version")
            approved_projects = [project]
            if re.fullmatch(r"[0-9]+", env.get("GCP_PROJECT_NUMBER", "")):
                approved_projects.append(env["GCP_PROJECT_NUMBER"])
            match = re.fullmatch(r"projects/(?:" + "|".join(re.escape(p) for p in approved_projects) + r")/secrets/" + re.escape(secret) + r"/versions/([1-9][0-9]*)", record["name"])
            if not match:
                raise ValueError("Malformed secret version")
            return int(match[1])
        if any(not isinstance(v, dict) or v.get("state") != "ENABLED" for v in existing):
            raise ValueError("Inactive historical secret version requires explicit review")
        if existing:
            version = max(ordinal(v) for v in existing)
            read_payload = subprocess.run(["gcloud", "secrets", "versions", "access", str(version), "--secret=" + secret, *common], capture_output=True, timeout=30)
            if read_payload.returncode or read_payload.stdout != payload.encode():
                raise ValueError("Existing secret differs; rotation requires explicit review")
            versions[secret] = str(version)
        else:
            created = subprocess.run(["gcloud", "secrets", "versions", "add", secret, *common, "--data-file=-", "--format=json(name)"], input=payload.encode(), capture_output=True, timeout=45)
            if created.returncode:
                raise ValueError("Secret version creation failed")
            versions[secret] = str(ordinal(json.loads(created.stdout)))
    return versions


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env-file", type=Path, required=True)
    p.add_argument("--database-output", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    try:
        if args.env_file.name.endswith(".example"):
            raise ValueError("Private file required")
        env = loader.parse(args.env_file)
        versions = materialize(env, json.loads(args.database_output.read_text()), args.dry_run)
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if args.output.is_symlink():
            raise ValueError("Refusing symlink output")
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(versions, output, indent=2)
            output.write("\n")
        args.output.chmod(0o600)
        print("Recorded approved secret references; no payloads printed.")
        return 0
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        print("Secret materialization refused; inspect configuration and existing secret ownership. No credentials printed.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
