#!/usr/bin/env python3
"""Generate protected profile inputs from one explicit private environment file.

Cloud outputs (image digests and actual secret versions) are separate manifests.
No values or secrets are printed. Does not contact or mutate cloud resources.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("ops_env_parse", ROOT / "scripts/lib/ops-env-parse.py")
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


def profile(env: dict[str, str], release: dict, versions: dict, services: bool, lifecycle_proof: dict | None = None) -> dict:
    def required(key: str) -> str:
        value = env.get(key, "")
        if not value or (re.search(r"<[^>]+>", value) and not (key == "AXIOM_FROM_EMAIL" and re.search(r"<[^<>\s]+@[^<>\s]+>", value))):
            raise ValueError("Missing or placeholder configuration: " + key)
        return value

    def boolean(key: str) -> bool:
        value = required(key)
        if value not in {"true", "false"}:
            raise ValueError("Expected explicit boolean: " + key)
        return value == "true"

    if required("ENVIRONMENT") != "preprod" or required("GCP_REGION") != "asia-south1" or required("AXIOM_DEPLOYMENT_PROFILE") != "marketing":
        raise ValueError("Requires the Mumbai marketing preprod profile")
    for left, right in [("GCP_PROJECT_ID", "AXIOM_PROJECT_ID"), ("GCP_REGION", "AXIOM_REGION")]:
        if env.get(right) and env[right] != required(left):
            raise ValueError("Conflicting configuration aliases: " + left + "/" + right)
    sha = release.get("release_sha", "")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid release manifest revision")
    components = ["marketing", "bff", "auth", "rest", "gateway"]
    if set(release.get("images", {})) != set(components):
        raise ValueError("Requires exactly five marketing release images")
    namespace = required("GCP_PROJECT_ID")
    for image in release["images"].values():
        if not re.fullmatch(r"asia-south1-docker\.pkg\.dev/" + re.escape(namespace) + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}", image):
            raise ValueError("Image manifest does not match the selected project")
    result = {
        "project_id": namespace, "environment": env["ENVIRONMENT"], "region": env["GCP_REGION"],
        "release_sha": sha, "images": release["images"], "firebase_origin": required("AXIOM_PROOF_MARKETING_URL"),
        "deploy_services": services,
        "migration_account_id": required("MARKETING_MIGRATION_ACCOUNT_ID"),
        "bootstrap_secrets": {"admin_db_url": required("MARKETING_ADMIN_DB_URL_SECRET"), "auth_password": required("MARKETING_AUTH_PASSWORD_SECRET"), "rest_password": required("MARKETING_REST_PASSWORD_SECRET")},
    }
    mapping = {
        "cloud_sql_instance_name": "CLOUD_SQL_INSTANCE_NAME", "cloud_sql_database_name": "CLOUD_SQL_DATABASE_NAME",
        "cloud_sql_tier": "CLOUD_SQL_TIER", "cloud_sql_database_version": "CLOUD_SQL_DATABASE_VERSION",
        "cloud_sql_admin_user": "CLOUD_SQL_DATABASE_USER", "cloud_sql_admin_password": "CLOUD_SQL_ADMIN_PASSWORD",
        "network_name": "MARKETING_NETWORK_NAME", "subnetwork_name": "MARKETING_SUBNETWORK_NAME",
        "sql_range_name": "MARKETING_SQL_RANGE_NAME", "subnet_cidr": "MARKETING_SUBNET_CIDR",
    }
    result.update({key: required(source) for key, source in mapping.items()})
    numbers = {"cloud_sql_disk_size_gb": "CLOUD_SQL_DISK_SIZE_GB", "sql_range_prefix_length": "MARKETING_SQL_RANGE_PREFIX_LENGTH", "cloud_sql_backup_retention": "CLOUD_SQL_BACKUP_RETENTION", "min_instance_count": "AXIOM_RUN_MIN_INSTANCES", "max_instance_count": "AXIOM_RUN_MAX_INSTANCES"}
    result.update({key: int(required(source)) for key, source in numbers.items()})
    result["cloud_sql_backup_enabled"] = boolean("CLOUD_SQL_BACKUP_ENABLED")
    result["cloud_sql_pitr_enabled"] = boolean("CLOUD_SQL_PITR_ENABLED")
    lifecycle_proof = lifecycle_proof or {}
    lifecycle_mapping = {
        "lifecycle_service_name": "MARKETING_LIFECYCLE_SERVICE_NAME",
        "lifecycle_controller_account_id": "MARKETING_LIFECYCLE_ACCOUNT_ID",
        "lifecycle_scheduler_account_id": "MARKETING_SCHEDULER_ACCOUNT_ID",
        "lifecycle_scheduler_name": "MARKETING_LIFECYCLE_SCHEDULER_NAME",
        "lifecycle_sql_role_id": "MARKETING_LIFECYCLE_SQL_ROLE_ID",
        "lifecycle_state_role_id": "MARKETING_LIFECYCLE_STATE_ROLE_ID",
        "lifecycle_state_bucket": "AXIOM_IDLE_STATE_BUCKET",
        "lifecycle_state_object": "AXIOM_IDLE_STATE_OBJECT",
        "lifecycle_scheduler_schedule": "MARKETING_LIFECYCLE_SCHEDULE",
        "lifecycle_scheduler_time_zone": "MARKETING_LIFECYCLE_TIME_ZONE",
    }
    result.update({key: required(source) for key, source in lifecycle_mapping.items()})
    result.update({key: int(required(source)) for key, source in {
        "lifecycle_request_seconds": "AXIOM_DATABASE_REQUEST_TIMEOUT_SECONDS",
        "lifecycle_lease_seconds": "AXIOM_IDLE_LEASE_SECONDS",
        "lifecycle_idle_seconds": "AXIOM_IDLE_TIMEOUT_SECONDS",
    }.items()})
    result.update({
        "lifecycle_settings": {"cpu": required("MARKETING_LIFECYCLE_CPU"), "memory": required("MARKETING_LIFECYCLE_MEMORY"), "port": int(required("MARKETING_LIFECYCLE_PORT")), "concurrency": int(required("MARKETING_LIFECYCLE_CONCURRENCY"))},
        "lifecycle_image": release.get("auxiliary_images", {}).get("lifecycle", ""),
        "lifecycle_target_manifest_sha256": release.get("lifecycle_target_manifest_sha256", ""),
        "lifecycle_scheduler_paused": boolean("MARKETING_LIFECYCLE_PAUSED"),
        "lifecycle_state_initialized": lifecycle_proof.get("state_initialized", False),
        "lifecycle_seed_generation": str(lifecycle_proof.get("seed_generation", "")),
        "lifecycle_seed_target_sha256": lifecycle_proof.get("seed_target_sha256", ""),
        "lifecycle_acceptance_manifest_path": lifecycle_proof.get("acceptance_manifest_path", ""),
        "lifecycle_acceptance_manifest_sha256": lifecycle_proof.get("acceptance_manifest_sha256", ""),
    })
    result["service_names"] = {c: required("MARKETING_" + c.upper() + "_SERVICE_NAME") for c in components}
    result["service_account_ids"] = {c: required("MARKETING_" + c.upper() + "_ACCOUNT_ID") for c in components}
    result["service_settings"] = {c: {"cpu": required("MARKETING_" + c.upper() + "_CPU"), "memory": required("MARKETING_" + c.upper() + "_MEMORY"), "port": int(required("MARKETING_" + c.upper() + "_PORT"))} for c in components}
    refs = {
        "auth": {"GOTRUE_DB_DATABASE_URL": "MARKETING_AUTH_DB_URL_SECRET", "GOTRUE_JWT_SECRET": "MARKETING_JWT_SECRET"},
        "rest": {"PGRST_DB_URI": "MARKETING_REST_DB_URL_SECRET", "PGRST_JWT_SECRET": "MARKETING_JWT_SECRET"},
        "bff": {"SUPABASE_SERVICE_KEY": "MARKETING_SERVICE_KEY_SECRET"},
    }
    result["service_secrets"] = {}
    for component, secrets in refs.items():
        result["service_secrets"][component] = {}
        for key, source in secrets.items():
            secret = required(source)
            version = versions.get(secret, "")
            if services and not re.fullmatch(r"[1-9][0-9]*", str(version)):
                raise ValueError("Missing materialized secret version: " + source)
            result["service_secrets"][component][key] = {"secret": secret, "version": str(version)}
    modes = {k: required(k) for k in ["AXIOM_CONTACT_EMAIL_MODE", "AXIOM_REPORT_EMAIL_MODE"]}
    if any(v not in {"disabled", "delivery"} for v in modes.values()):
        raise ValueError("Invalid email delivery mode")
    result["service_env"] = {"auth": {"GOTRUE_DB_MAX_POOL_SIZE": required("GOTRUE_DB_MAX_POOL_SIZE")}, "rest": {"PGRST_DB_POOL": required("PGRST_DB_POOL")}, "bff": {**modes, "GCP_PROJECT_ID": namespace, "AXIOM_IDLE_PROJECT_ID": namespace}, "marketing": {"AXIOM_PROOF_MARKETING_URL": required("AXIOM_PROOF_MARKETING_URL"), "AXIOM_PROOF_PLATFORM_URL": required("AXIOM_PROOF_PLATFORM_URL")}}
    if "delivery" in modes.values():
        secret = required("MARKETING_EMAIL_KEY_SECRET")
        version = versions.get(secret, "")
        if services and not re.fullmatch(r"[1-9][0-9]*", str(version)):
            raise ValueError("Missing materialized email key version")
        result["service_secrets"]["bff"]["RESEND_API_KEY"] = {"secret": secret, "version": str(version)}
        result["service_env"]["bff"].update({k: required(k) for k in ["AXIOM_FROM_EMAIL", "CONTACT_RECIPIENT_EMAIL", "AXIOM_SALES_EMAIL", "AXIOM_FOUNDER_EMAIL"]})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-coverage", action="store_true")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--release-manifest", type=Path)
    parser.add_argument("--secret-manifest", type=Path)
    parser.add_argument("--lifecycle-manifest", type=Path)
    parser.add_argument("--services", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        if args.check_coverage:
            # Shape-only synthetic input; never credentials or deployment clearance.
            env = loader.parse(ROOT / "infra/docker/environments/.env.preprod.example")
            env = {k: ("synthetic-coverage-value" * 3 if re.search(r"<[^>]+>", v) else v) for k, v in env.items()}
            images = {c: f"asia-south1-docker.pkg.dev/{env['GCP_PROJECT_ID']}/synthetic/{c}@sha256:" + "a" * 64 for c in ["marketing", "bff", "auth", "rest", "gateway"]}
            actual = set(profile(env, {"release_sha": "a" * 40, "images": images}, {}, False))
            declared = set(re.findall(r'^variable "([a-z0-9_]+)"', (ROOT / "infra/terraform/envs/marketing-preprod/variables.tf").read_text(), re.M))
            if actual != declared:
                raise ValueError("Profile mapping does not cover declared Terraform variables")
            print(f"Marketing profile mapping covers all {len(declared)} declared Terraform variables (synthetic shape only).")
            return 0
        if not args.env_file or not args.release_manifest or not args.output:
            raise ValueError("Explicit environment, release manifest and output required")
        if args.env_file.name.endswith(".example"):
            raise ValueError("Templates cannot drive deployment")
        env = loader.parse(args.env_file)
        release = json.loads(args.release_manifest.read_text())
        versions = json.loads(args.secret_manifest.read_text()) if args.secret_manifest else {}
        current = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        if release.get("release_sha") != current:
            raise ValueError("Release manifest differs from this checkout")
        lifecycle_proof = json.loads(args.lifecycle_manifest.read_text()) if args.lifecycle_manifest else {}
        values = profile(env, release, versions, args.services, lifecycle_proof)
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if args.output.is_symlink():
            raise ValueError("Refusing symlink output")
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(values, output, indent=2)
            output.write("\n")
        args.output.chmod(0o600)
        print("Protected marketing profile configuration generated; no cloud changes.")
        return 0
    except (ValueError, OSError, subprocess.SubprocessError):
        # JSON/environment errors can contain values, so only safe diagnostics leave this process.
        print("Marketing configuration refused; review required keys, manifests and file permissions.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
