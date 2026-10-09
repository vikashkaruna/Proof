#!/usr/bin/env python3
"""Guarded first phases of the isolated marketing preprod deployment.

Prepare is local. Plan reads the explicitly selected remote Terraform state.
Base applies only a reviewed create/no-op plan. Later phases refuse until their
job, seed, acceptance and Hosting receipts have a reviewed executable contract.
No command output or credential is printed by this coordinator.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import stat
import subprocess
import time
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
TF_ROOT = ROOT / "infra/terraform/envs/marketing-preprod"
spec = importlib.util.spec_from_file_location(
    "marketing_preprod_config", ROOT / "scripts/marketing-preprod-config.py"
)
assert spec and spec.loader
config_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config_module)
job_spec = importlib.util.spec_from_file_location(
    "marketing_db_job", ROOT / "scripts/marketing-db-job.py"
)
assert job_spec and job_spec.loader
job_module = importlib.util.module_from_spec(job_spec)
job_spec.loader.exec_module(job_module)

CORE = frozenset({"marketing", "bff", "auth", "rest", "gateway"})
CHECKS = frozenset({"unit", "typecheck", "terraform", "security", "database-rehearsal"})
REGISTRY_CHECKS = frozenset({"unit", "typecheck", "terraform", "security"})
PHASES = (
    "registry-plan",
    "registry",
    "prepare",
    "plan",
    "base",
    "bootstrap-roles-plan",
    "bootstrap-roles",
    "bootstrap-auth-plan",
    "bootstrap-auth",
    "bootstrap-series-plan",
    "bootstrap-series",
    "seed-plan",
    "seed",
    "services-plan",
    "services",
    "acceptance",
    "hosting",
)
DEFERRED = frozenset({"seed", "acceptance", "hosting"})
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
PROJECT = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]\Z")
STATE_BUCKET = re.compile(r"[a-z0-9][a-z0-9._-]{2,61}[a-z0-9]\Z")
STATE_PREFIX = re.compile(r"terraform/state/marketing-preprod(?:/[a-z0-9-]+)?\Z")
IMAGE = re.compile(
    r"asia-south1-docker\.pkg\.dev/([a-z][a-z0-9-]+)/[^/]+/[^@]+@sha256:[a-f0-9]{64}\Z"
)
REPOSITORY = re.compile(r"[a-z][a-z0-9-]{4,62}\Z")
BASE_ADDRESSES = frozenset(
    {
        "google_project_service.apis",
        "google_compute_network.marketing",
        "google_compute_subnetwork.run",
        "google_compute_global_address.sql",
        "google_service_networking_connection.sql",
        "google_sql_database_instance.marketing",
        "google_sql_database.marketing",
        "terraform_data.configuration",
        "google_sql_user.bootstrap",
        "google_secret_manager_secret.runtime",
        "google_service_account.runtime",
        "google_service_account.migration",
        "google_secret_manager_secret_iam_member.migration",
    }
)
LIFECYCLE_ADDRESSES = frozenset(
    {
        "google_project_service.lifecycle",
        "google_service_account.lifecycle",
        "google_service_account.lifecycle_scheduler",
        "google_project_iam_custom_role.lifecycle_sql",
        "google_project_iam_member.lifecycle_sql",
        "google_project_iam_custom_role.lifecycle_state",
        "google_storage_bucket_iam_member.lifecycle_state",
        "google_cloud_run_v2_service.lifecycle",
        "google_cloud_run_v2_service_iam_member.lifecycle",
        "terraform_data.lifecycle_release",
        "google_cloud_scheduler_job.lifecycle",
    }
)
MODULE_RESOURCES = frozenset(
    {
        "google_secret_manager_secret_iam_member.runtime",
        "google_cloud_run_v2_service.request",
        "google_cloud_run_v2_service_iam_member.invoke",
    }
)


def protected_json(path: Path) -> dict:
    if path.name.endswith(".example") or path.is_symlink() or not path.is_file():
        raise ValueError("Protected input missing or unsafe")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("Protected input permissions are too broad")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError("Expected protected JSON object")
    return value


def protected_env(path: Path) -> dict[str, str]:
    if path.name.endswith(".example") or path.is_symlink() or not path.is_file():
        raise ValueError("Protected environment input missing or unsafe")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("Protected environment permissions are too broad")
    return config_module.loader.parse(path)


def clean_revision(root: Path) -> str:
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout.strip()
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout
    if not SHA40.fullmatch(sha) or dirty:
        raise ValueError("Exact clean source revision required")
    return sha


def validate_inputs(
    env: dict[str, str], release: dict, clearance: dict, source_sha: str
) -> dict:
    project = env.get("GCP_PROJECT_ID", "")
    if (
        not PROJECT.fullmatch(project)
        or env.get("ENVIRONMENT") != "preprod"
        or env.get("GCP_REGION") != "asia-south1"
        or env.get("AXIOM_DEPLOYMENT_PROFILE") != "marketing"
        or env.get("AXIOM_RELEASE_SHA") != source_sha
        or release.get("release_sha") != source_sha
        or not STATE_BUCKET.fullmatch(env.get("AXIOM_TF_STATE_BUCKET", ""))
        or not env["AXIOM_TF_STATE_BUCKET"].startswith(project + "-preprod-state-")
        or not STATE_PREFIX.fullmatch(env.get("AXIOM_MARKETING_TF_STATE_PREFIX", ""))
    ):
        raise ValueError(
            "Marketing release target or source differs from reviewed inputs"
        )
    images = release.get("images")
    if not isinstance(images, dict) or set(images) != CORE:
        raise ValueError("Five exact core release images required")
    auxiliary = release.get("auxiliary_images", {})
    if not isinstance(auxiliary, dict) or set(auxiliary) != {"migrations", "lifecycle"}:
        raise ValueError("Exact immutable migration and lifecycle images required")
    for image in images.values():
        match = IMAGE.fullmatch(image) if isinstance(image, str) else None
        if not match or match[1] != project:
            raise ValueError("Release image belongs to a foreign project or is mutable")
    if (
        clearance.get("release_sha") != source_sha
        or clearance.get("project") != project
        or clearance.get("region") != "asia-south1"
        or clearance.get("profile") != "marketing"
        or not isinstance(clearance.get("images"), dict)
        or clearance["images"] != {**images, **auxiliary}
    ):
        raise ValueError("Security clearance does not bind this exact release")
    for image in clearance["images"].values():
        match = IMAGE.fullmatch(image) if isinstance(image, str) else None
        if not match or match[1] != project:
            raise ValueError("Security clearance contains a mutable or foreign image")
    validate_evidence_checks(
        clearance.get("checks"),
        required=CHECKS,
        source_sha=source_sha,
        project=project,
        images={**images, **auxiliary},
    )
    return config_module.profile(env, release, {}, False)


def validate_evidence_checks(
    checks: object,
    *,
    required: frozenset[str],
    source_sha: str,
    project: str,
    images: dict[str, str] | None = None,
) -> None:
    if (
        not isinstance(checks, list)
        or {item.get("name") for item in checks if isinstance(item, dict)} != required
        or len(checks) != len(required)
    ):
        raise ValueError("Required security checks are incomplete")
    if any(
        not isinstance(item, dict)
        or item.get("status") != "passed"
        or not SHA256.fullmatch(item.get("evidence_sha256", ""))
        or not isinstance(item.get("evidence_path"), str)
        for item in checks
    ):
        raise ValueError("Security clearance evidence is incomplete")
    root = ROOT.resolve()
    for item in checks:
        path = Path(item["evidence_path"])
        if not path.is_absolute() or not path.is_relative_to(root):
            raise ValueError(
                "Security evidence is outside the selected source checkout"
            )
        relative = path.relative_to(root)
        if any(
            (root / Path(*relative.parts[:index])).is_symlink()
            for index in range(1, len(relative.parts) + 1)
        ):
            raise ValueError("Security evidence symlink refused")
        if (
            not path.is_file()
            or not stat.S_ISREG(path.stat().st_mode)
            or stat.S_IMODE(path.stat().st_mode) & 0o077
        ):
            raise ValueError("Security evidence must be a protected regular file")
        raw = path.read_bytes()
        if (
            not raw
            or len(raw) > 4 * 1024 * 1024
            or hashlib.sha256(raw).hexdigest() != item["evidence_sha256"]
        ):
            raise ValueError("Security evidence bytes differ from clearance")
        try:
            evidence = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            evidence = None
        if isinstance(evidence, dict) and any(
            key in evidence and evidence[key] != expected
            for key, expected in (
                ("release_sha", source_sha),
                ("project", project),
                ("images", images),
                ("name", item["name"]),
                ("status", "passed"),
            )
            if expected is not None
        ):
            raise ValueError("Security evidence metadata differs from reviewed release")


def validate_approval(
    approval: dict, *, env: dict[str, str], source_sha: str, plan_sha: str, phase: str
) -> None:
    rollback = approval.get("rollback")
    if (
        approval.get("release_sha") != source_sha
        or approval.get("project") != env["GCP_PROJECT_ID"]
        or approval.get("region") != "asia-south1"
        or approval.get("profile") != "marketing"
        or approval.get("source") != "human-user"
        or not isinstance(approval.get("allowed_phases"), list)
        or phase not in approval["allowed_phases"]
        or approval.get("dry_run_plan_sha256") != plan_sha
        or not isinstance(rollback, dict)
        or rollback.get("preserve_database") is not True
        or rollback.get("prevent_publication") is not True
        or rollback.get("production") is not False
    ):
        raise ValueError(
            "Human approval, exact dry-run plan and rollback review required"
        )


def registry_target(env: dict[str, str], source_sha: str) -> dict[str, str]:
    project = env.get("GCP_PROJECT_ID", "")
    repository = env.get("AXIOM_ARTIFACT_REPOSITORY", "")
    if (
        not PROJECT.fullmatch(project)
        or env.get("ENVIRONMENT") != "preprod"
        or env.get("GCP_REGION") != "asia-south1"
        or env.get("AXIOM_DEPLOYMENT_PROFILE") != "marketing"
        or env.get("AXIOM_RELEASE_SHA") != source_sha
        or not REPOSITORY.fullmatch(repository)
        or not repository.startswith(project + "-preprod-")
    ):
        raise ValueError(
            "Registry target differs from exact preprod source and environment"
        )
    return {
        "release_sha": source_sha,
        "project": project,
        "region": "asia-south1",
        "repository": repository,
        "format": "DOCKER",
        "action": "create",
    }


def validate_registry_clearance(clearance: dict, *, target: dict[str, str]) -> None:
    if (
        clearance.get("release_sha") != target["release_sha"]
        or clearance.get("project") != target["project"]
        or clearance.get("region") != target["region"]
        or clearance.get("profile") != "marketing"
    ):
        raise ValueError("Source clearance differs from registry target")
    validate_evidence_checks(
        clearance.get("checks"),
        required=REGISTRY_CHECKS,
        source_sha=target["release_sha"],
        project=target["project"],
    )


def registry_inventory(target: dict[str, str]) -> list[dict]:
    raw = run_command(
        [
            "gcloud",
            "artifacts",
            "repositories",
            "list",
            "--project=" + target["project"],
            "--location=" + target["region"],
            "--format=json",
        ],
        cwd=ROOT,
        stdout=True,
    )
    found = json.loads(raw)
    if not isinstance(found, list) or any(not isinstance(item, dict) for item in found):
        raise ValueError("Registry inventory is incomplete")
    return found


def require_absent_registry(target: dict[str, str], found: list[dict]) -> None:
    full_name = (
        f"projects/{target['project']}/locations/{target['region']}"
        f"/repositories/{target['repository']}"
    )
    if any(item.get("name") == full_name for item in found):
        raise ValueError("Registry already exists; create-only phase refused")
    if any(not isinstance(item.get("name"), str) for item in found):
        raise ValueError("Registry inventory contains malformed names")


def registry_phase(
    phase: str,
    *,
    work: Path,
    env: dict[str, str],
    source_sha: str,
    approval: dict | None,
    clearance: dict,
) -> None:
    target = registry_target(env, source_sha)
    validate_registry_clearance(clearance, target=target)
    plan_file = work / "registry.plan.private.json"
    found = registry_inventory(target)
    require_absent_registry(target, found)
    if phase == "registry-plan":
        if plan_file.exists() or plan_file.is_symlink():
            raise ValueError("Registry plan already exists")
        protected_output(plan_file, target)
        return
    if phase != "registry":
        raise ValueError("Unsupported registry phase")
    plan = protected_json(plan_file)
    if plan != target:
        raise ValueError("Registry plan differs from current target")
    validate_approval(
        approval or {},
        env=env,
        source_sha=source_sha,
        plan_sha=hashlib.sha256(plan_file.read_bytes()).hexdigest(),
        phase="registry",
    )
    if (approval or {}).get("rollback", {}).get("retain_repository") is not True:
        raise ValueError("Repository retention must be reviewed before creation")
    run_command(
        [
            "gcloud",
            "artifacts",
            "repositories",
            "create",
            target["repository"],
            "--repository-format=docker",
            "--project=" + target["project"],
            "--location=" + target["region"],
            "--description=Isolated marketing preprod immutable release images",
            "--quiet",
        ],
        cwd=ROOT,
    )
    full_name = (
        f"projects/{target['project']}/locations/{target['region']}"
        f"/repositories/{target['repository']}"
    )
    matching = [
        item for item in registry_inventory(target) if item.get("name") == full_name
    ]
    if len(matching) != 1 or matching[0].get("format") != "DOCKER":
        raise ValueError("Created registry could not be verified")
    protected_output(work / "registry.receipt.private.json", target)


def seed_candidate(
    env: dict[str, str], release: dict, database: dict, proof: dict, now: int
) -> tuple[bytes, bytes]:
    project = env["GCP_PROJECT_ID"]
    instance = env["CLOUD_SQL_INSTANCE_NAME"]
    bucket = env["AXIOM_IDLE_STATE_BUCKET"]
    object_name = env["AXIOM_IDLE_STATE_OBJECT"]
    if (
        env.get("ENVIRONMENT") != "preprod"
        or env.get("GCP_REGION") != "asia-south1"
        or not instance.startswith(project + "-preprod-")
        or not bucket.startswith(project + "-preprod-state-")
        or object_name != "marketing-preprod/lifecycle/state.json"
        or database.get("instance") != instance
        or database.get("name") != env["CLOUD_SQL_DATABASE_NAME"]
        or database.get("connection_name") != f"{project}:asia-south1:{instance}"
        or not ipaddress.IPv4Address(database.get("private_ip", "")).is_private
        or proof.get("release_sha") != release.get("release_sha")
        or proof.get("project") != project
        or proof.get("connection_name") != database["connection_name"]
        or proof.get("roles_applied") is not True
        or proof.get("auth_applied") is not True
        or proof.get("series_applied") is not True
        or proof.get("exclusive_client_adoption") is not True
        or proof.get("no_other_clients") is not True
        or not isinstance(now, int)
        or now < 1_700_000_000
    ):
        raise ValueError(
            "Seed lacks exact database and exclusive-client bootstrap proof"
        )
    selected = {
        "environment": "preprod",
        "project": project,
        "instance": instance,
        "bucket": bucket,
        "object": object_name,
    }
    manifest = (
        json.dumps(selected, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    digest = hashlib.sha256(manifest).hexdigest()
    if release.get("lifecycle_target_manifest_sha256") != digest:
        raise ValueError("Release image target manifest differs from seed target")
    state = {
        "version": 1,
        "targetHash": digest,
        "phase": "running",
        "lastActivity": now,
        "leases": {},
        "transition": None,
        "operation": None,
    }
    return manifest, (
        json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def create_only_seed(
    *,
    env: dict[str, str],
    release: dict,
    database: dict,
    proof: dict,
    work: Path,
    now: int,
) -> None:
    manifest, body = seed_candidate(env, release, database, proof, now)
    token = run_command(
        ["gcloud", "auth", "print-access-token"], cwd=ROOT, stdout=True
    ).strip()
    if not re.fullmatch(rb"[A-Za-z0-9._~+/-]{20,16384}", token):
        raise ValueError("Cloud identity token unavailable")
    bucket = quote(env["AXIOM_IDLE_STATE_BUCKET"], safe="")
    object_name = quote(env["AXIOM_IDLE_STATE_OBJECT"], safe="")
    endpoint = f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=media&name={object_name}&ifGenerationMatch=0"
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token.decode("ascii"),
            "Content-Type": "application/json",
        },
    )
    # No retry: a timeout after POST could mean the object was created.
    with urlopen(request, timeout=25) as response:
        metadata = json.loads(response.read(65537))
    generation = metadata.get("generation") if isinstance(metadata, dict) else None
    if (
        not isinstance(generation, str)
        or not re.fullmatch(r"[1-9][0-9]{0,29}", generation)
        or metadata.get("bucket") != env["AXIOM_IDLE_STATE_BUCKET"]
        or metadata.get("name") != env["AXIOM_IDLE_STATE_OBJECT"]
    ):
        raise ValueError("Seed creation response could not be verified")
    verify_url = (
        f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{object_name}"
        f"?alt=media&generation={generation}"
    )
    with urlopen(
        Request(
            verify_url, headers={"Authorization": "Bearer " + token.decode("ascii")}
        ),
        timeout=25,
    ) as response:
        if response.read(len(body) + 1) != body:
            raise ValueError("Created seed bytes differ from reviewed candidate")
    protected_output(
        work / "seed.receipt.private.json",
        {
            "release_sha": release["release_sha"],
            "project": env["GCP_PROJECT_ID"],
            "bucket": env["AXIOM_IDLE_STATE_BUCKET"],
            "object": env["AXIOM_IDLE_STATE_OBJECT"],
            "seed_generation": generation,
            "seed_target_sha256": hashlib.sha256(manifest).hexdigest(),
            "seed_body_sha256": hashlib.sha256(body).hexdigest(),
            "state_initialized": True,
        },
    )


def seed_phase(
    *,
    planning: bool,
    work: Path,
    env: dict[str, str],
    release: dict,
    database: dict,
    proof: dict,
    approval: dict | None,
) -> None:
    for phase in ("roles", "series"):
        receipt = protected_json(work / f"bootstrap-{phase}.receipt.private.json")
        if (
            receipt.get("release_sha") != release["release_sha"]
            or receipt.get("project") != env["GCP_PROJECT_ID"]
            or receipt.get("database_connection_name") != database["connection_name"]
            or receipt.get("phase") != phase
        ):
            raise ValueError("Exact completed bootstrap Job receipts required")
    auth = protected_json(work / "bootstrap-auth.receipt.private.json")
    if (
        auth.get("release_sha") != release["release_sha"]
        or auth.get("project") != env["GCP_PROJECT_ID"]
        or auth.get("database_connection_name") != database["connection_name"]
        or auth.get("service_ready") is not True
    ):
        raise ValueError("GoTrue bootstrap receipt required before seed")
    plan_file = work / "seed.plan.private.json"
    if planning:
        if plan_file.exists() or plan_file.is_symlink():
            raise ValueError("Use a fresh lifecycle seed plan")
        now = int(time.time())
    else:
        plan = protected_json(plan_file)
        now = plan.get("created_unix")
    manifest, body = seed_candidate(env, release, database, proof, now)
    descriptor = {
        "release_sha": release["release_sha"],
        "project": env["GCP_PROJECT_ID"],
        "bucket": env["AXIOM_IDLE_STATE_BUCKET"],
        "object": env["AXIOM_IDLE_STATE_OBJECT"],
        "connection_name": database["connection_name"],
        "created_unix": now,
        "target_manifest_sha256": hashlib.sha256(manifest).hexdigest(),
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "action": "create-only-ifGenerationMatch-0",
    }
    if planning:
        protected_output(plan_file, descriptor)
        return
    if plan != descriptor:
        raise ValueError("Lifecycle seed candidate changed since plan review")
    validate_approval(
        approval or {},
        env=env,
        source_sha=release["release_sha"],
        plan_sha=hashlib.sha256(plan_file.read_bytes()).hexdigest(),
        phase="seed",
    )
    if (work / "seed.receipt.private.json").exists():
        raise ValueError("Lifecycle seed already has a receipt; no overwrite")
    create_only_seed(
        env=env,
        release=release,
        database=database,
        proof=proof,
        work=work,
        now=now,
    )


def bootstrap_job_descriptor(
    *,
    phase: str,
    env: dict[str, str],
    release: dict,
    database: dict,
    versions: dict,
    migration_identity: dict,
) -> dict:
    if phase not in ("roles", "series"):
        raise ValueError("Unsupported bootstrap job phase")
    project = env["GCP_PROJECT_ID"]
    instance = env["CLOUD_SQL_INSTANCE_NAME"]
    if (
        database.get("instance") != instance
        or database.get("name") != env["CLOUD_SQL_DATABASE_NAME"]
        or database.get("connection_name") != f"{project}:asia-south1:{instance}"
    ):
        raise ValueError("Bootstrap job database differs from applied base")
    host = job_module.private_ip(database.get("private_ip", ""))
    account = (
        f"{env['MARKETING_MIGRATION_ACCOUNT_ID']}@{project}.iam.gserviceaccount.com"
    )
    if migration_identity != {
        "email": account,
        "project": project,
        "release_sha": release["release_sha"],
    }:
        raise ValueError("Migration Job identity differs from applied base")
    image = release.get("auxiliary_images", {}).get("migrations", "")
    if not isinstance(image, str) or not IMAGE.fullmatch(image):
        raise ValueError("Immutable migration job image required")
    source = dict(env)
    source.update(
        {
            "CLOUD_SQL_PRIVATE_IP": host,
            "CLOUD_SQL_ADMIN_USER": env["CLOUD_SQL_DATABASE_USER"],
            "MARKETING_MIGRATION_IMAGE": image,
            "MARKETING_MIGRATION_SERVICE_ACCOUNT": account,
            "MARKETING_MIGRATION_JOB_NAME": env["MARKETING_MIGRATION_JOB_NAME"]
            + "-"
            + phase,
        }
    )
    secret_names = {
        "ADMIN_DB_URL": "MARKETING_ADMIN_DB_URL_SECRET",
        "GOTRUE_DB_PASSWORD": "MARKETING_AUTH_PASSWORD_SECRET",
        "REST_DB_PASSWORD": "MARKETING_REST_PASSWORD_SECRET",
    }
    for target, source_key in secret_names.items():
        secret_id = env.get(source_key, "")
        version = versions.get(secret_id)
        if not re.fullmatch(r"[1-9][0-9]*", str(version)):
            raise ValueError(
                "Bootstrap job requires materialized numeric secret versions"
            )
        source[f"MARKETING_{target}_SECRET_ID"] = secret_id
        source[f"MARKETING_{target}_SECRET_VERSION"] = str(version)
    payload = job_module.job_payload(source, phase)
    if payload["template"]["template"]["containers"][0]["image"] != image:
        raise ValueError("Job helper changed reviewed migration image")
    return {
        "release_sha": release["release_sha"],
        "project": project,
        "region": "asia-south1",
        "phase": phase,
        "database_connection_name": database["connection_name"],
        "job": payload,
    }


def run_job_api(method: str, path: str, token: bytes, body: dict | None = None) -> dict:
    if not re.fullmatch(
        r"projects/[a-z][a-z0-9-]+/locations/asia-south1/"
        r"(?:jobs\?jobId=[A-Za-z0-9-]+|operations/[A-Za-z0-9_-]+|jobs/[A-Za-z0-9-]+(?::run|/executions/[A-Za-z0-9_-]+)?)",
        path,
    ) or method not in ("GET", "POST"):
        raise ValueError("Cloud Run Jobs API path refused")
    raw = (
        None
        if body is None
        else json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    )
    request = Request(
        "https://run.googleapis.com/v2/" + path,
        data=raw,
        method=method,
        headers={
            "Authorization": "Bearer " + token.decode("ascii"),
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=30) as response:
        document = json.loads(response.read(1_048_577))
    if not isinstance(document, dict):
        raise TypeError("Cloud Run Jobs response malformed")
    return document


def wait_job_operation(
    operation: dict, *, token: bytes, project: str, deadline: float
) -> dict:
    prefix = f"projects/{project}/locations/asia-south1/operations/"
    name = operation.get("name")
    if not isinstance(name, str) or not name.startswith(prefix):
        raise ValueError("Cloud Run Job operation targets another project")
    while True:
        if time.monotonic() >= deadline:
            raise ValueError(
                "Cloud Run Job operation timed out; outcome requires review"
            )
        current = run_job_api("GET", name, token)
        if current.get("name") != name:
            raise ValueError("Cloud Run Job operation identity changed")
        if current.get("done") is True:
            if current.get("error") or not isinstance(current.get("response"), dict):
                raise ValueError("Cloud Run Job operation failed or lacked response")
            return current["response"]
        time.sleep(5)


def execute_bootstrap_job(descriptor: dict, *, work: Path) -> None:
    project = descriptor["project"]
    job = descriptor["job"]
    name = job["name"]
    expected_prefix = f"projects/{project}/locations/asia-south1/jobs/"
    if not name.startswith(expected_prefix):
        raise ValueError("Bootstrap Job targets another project")
    token = run_command(
        ["gcloud", "auth", "print-access-token"], cwd=ROOT, stdout=True
    ).strip()
    if not re.fullmatch(rb"[A-Za-z0-9._~+/-]{20,16384}", token):
        raise ValueError("Cloud identity token unavailable")
    # Separate phase jobs are create-only; an existing Job is never patched.
    created = run_job_api(
        "POST",
        f"projects/{project}/locations/asia-south1/jobs?jobId={name.removeprefix(expected_prefix)}",
        token,
        {key: value for key, value in job.items() if key != "name"},
    )
    deadline = time.monotonic() + 1800
    result = wait_job_operation(
        created, token=token, project=project, deadline=deadline
    )
    if result.get("name") != name:
        raise ValueError("Created Job identity differs from reviewed descriptor")
    execution_op = run_job_api("POST", name + ":run", token, {})
    execution = wait_job_operation(
        execution_op, token=token, project=project, deadline=deadline
    )
    execution_name = execution.get("name")
    prefix = name + "/executions/"
    if not isinstance(execution_name, str) or not execution_name.startswith(prefix):
        raise ValueError("Job execution identity differs from reviewed target")
    while True:
        if time.monotonic() >= deadline:
            raise ValueError(
                "Job execution timed out; database outcome requires review"
            )
        current = run_job_api("GET", execution_name, token)
        if current.get("name") != execution_name:
            raise ValueError("Job execution identity changed")
        if current.get("completionTime"):
            if (
                current.get("taskCount") != 1
                or current.get("succeededCount") != 1
                or current.get("failedCount", 0) != 0
                or current.get("cancelledCount", 0) != 0
            ):
                raise ValueError("Bootstrap Job did not complete successfully")
            protected_output(
                work / f"bootstrap-{descriptor['phase']}.receipt.private.json",
                {
                    "release_sha": descriptor["release_sha"],
                    "project": project,
                    "phase": descriptor["phase"],
                    "database_connection_name": descriptor["database_connection_name"],
                    "job": name,
                    "execution": execution_name,
                    "completion_time": current["completionTime"],
                    "descriptor_sha256": hashlib.sha256(
                        (
                            json.dumps(
                                descriptor, sort_keys=True, separators=(",", ":")
                            )
                            + "\n"
                        ).encode()
                    ).hexdigest(),
                },
            )
            return
        time.sleep(5)


def bootstrap_job_phase(
    *,
    phase: str,
    planning: bool,
    work: Path,
    env: dict[str, str],
    release: dict,
    database: dict,
    versions: dict,
    migration_identity: dict,
    approval: dict | None,
) -> None:
    descriptor = bootstrap_job_descriptor(
        phase=phase,
        env=env,
        release=release,
        database=database,
        versions=versions,
        migration_identity=migration_identity,
    )
    if phase == "series":
        roles = protected_json(work / "bootstrap-roles.receipt.private.json")
        auth = protected_json(work / "bootstrap-auth.receipt.private.json")
        if (
            roles.get("release_sha") != release["release_sha"]
            or roles.get("project") != env["GCP_PROJECT_ID"]
            or roles.get("database_connection_name") != database["connection_name"]
            or roles.get("phase") != "roles"
            or auth.get("release_sha") != release["release_sha"]
            or auth.get("project") != env["GCP_PROJECT_ID"]
            or auth.get("database_connection_name") != database["connection_name"]
            or auth.get("service_ready") is not True
        ):
            raise ValueError("Exact roles and GoTrue bootstrap receipts required")
    plan_file = work / f"bootstrap-{phase}.plan.private.json"
    if planning:
        if plan_file.exists() or plan_file.is_symlink():
            raise ValueError("Use a fresh bootstrap Job plan")
        protected_output(plan_file, descriptor)
        return
    plan = protected_json(plan_file)
    if plan != descriptor:
        raise ValueError("Bootstrap Job descriptor changed since plan review")
    validate_approval(
        approval or {},
        env=env,
        source_sha=release["release_sha"],
        plan_sha=hashlib.sha256(plan_file.read_bytes()).hexdigest(),
        phase=f"bootstrap-{phase}",
    )
    if (work / f"bootstrap-{phase}.receipt.private.json").exists():
        raise ValueError("Bootstrap phase already has a receipt; no rerun")
    execute_bootstrap_job(descriptor, work=work)


def inspect_base_plan(
    plan: dict,
    *,
    project: str,
    release_sha: str | None = None,
    migration_account_id: str | None = None,
    bootstrap_secrets: dict | None = None,
) -> dict[str, int]:
    if not isinstance(plan, dict) or plan.get("format_version") is None:
        raise ValueError("Malformed Terraform plan")
    if release_sha is not None:
        variables = plan.get("variables")
        expected = {
            "project_id": project,
            "environment": "preprod",
            "region": "asia-south1",
            "release_sha": release_sha,
            "deploy_services": False,
        }
        if migration_account_id is not None:
            expected["migration_account_id"] = migration_account_id
        if bootstrap_secrets is not None:
            expected["bootstrap_secrets"] = bootstrap_secrets
        if not isinstance(variables, dict) or any(
            not isinstance(variables.get(key), dict)
            or variables[key].get("value") != value
            for key, value in expected.items()
        ):
            raise ValueError(
                "Terraform plan variables differ from reviewed base inputs"
            )
    changes = plan.get("resource_changes")
    if not isinstance(changes, list):
        raise TypeError("Terraform resource changes missing")
    summary = {"create": 0, "no-op": 0}
    for item in changes:
        if not isinstance(item, dict) or item.get("mode") != "managed":
            raise ValueError("Foreign Terraform plan scope")
        address = item.get("address")
        root = re.sub(r"\[.*$", "", address) if isinstance(address, str) else ""
        if root not in BASE_ADDRESSES or item.get("module_address"):
            raise ValueError("Foreign Terraform plan scope")
        change = item.get("change")
        actions = change.get("actions") if isinstance(change, dict) else None
        if actions not in (["create"], ["no-op"]):
            raise ValueError("Terraform replacement, deletion or update refused")
        after = change.get("after")
        if actions == ["create"] and isinstance(after, dict):
            for key in ("project", "project_id"):
                if key in after and after[key] not in (None, project):
                    raise ValueError("Terraform plan targets another project")
        summary[actions[0]] += 1
    return summary


def inspect_service_plan(plan: dict, *, values: dict, phase: str) -> dict[str, int]:
    if phase not in ("bootstrap-auth", "services"):
        raise ValueError("Unsupported service plan phase")
    variables = plan.get("variables") if isinstance(plan, dict) else None
    expected = {
        "project_id": values["project_id"],
        "environment": "preprod",
        "region": "asia-south1",
        "release_sha": values["release_sha"],
        "deploy_services": True,
        "images": values["images"],
        "service_secrets": values["service_secrets"],
        "lifecycle_scheduler_paused": True,
    }
    if phase == "services":
        expected.update(
            {
                "lifecycle_state_initialized": True,
                "lifecycle_seed_generation": values["lifecycle_seed_generation"],
                "lifecycle_seed_target_sha256": values["lifecycle_seed_target_sha256"],
            }
        )
    if not isinstance(variables, dict) or any(
        not isinstance(variables.get(key), dict) or variables[key].get("value") != value
        for key, value in expected.items()
    ):
        raise ValueError("Service Terraform plan variables differ from reviewed inputs")
    changes = plan.get("resource_changes")
    if not isinstance(changes, list):
        raise TypeError("Service Terraform resource changes missing")
    summary = {"create": 0, "no-op": 0}
    for item in changes:
        if not isinstance(item, dict) or item.get("mode") != "managed":
            raise ValueError("Foreign service Terraform scope")
        address = item.get("address")
        if not isinstance(address, str):
            raise TypeError("Malformed service resource address")
        module_match = re.fullmatch(
            r"module\.(marketing|bff|auth|rest|gateway)\[0\]\.(.+)", address
        )
        if module_match:
            component, resource = module_match.groups()
            root = re.sub(r"\[.*$", "", resource)
            if (
                root not in MODULE_RESOURCES
                or item.get("module_address") != f"module.{component}[0]"
                or (phase == "bootstrap-auth" and component != "auth")
            ):
                raise ValueError("Unreviewed service module resource")
        else:
            root = re.sub(r"\[.*$", "", address)
            if (
                item.get("module_address")
                or root not in BASE_ADDRESSES | LIFECYCLE_ADDRESSES
            ):
                raise ValueError("Foreign service Terraform resource")
            if phase == "bootstrap-auth" and root in LIFECYCLE_ADDRESSES:
                raise ValueError("Targeted auth plan includes lifecycle changes")
        actions = item.get("change", {}).get("actions")
        if actions not in (["create"], ["no-op"]):
            raise ValueError("Service replacement, deletion or update refused")
        after = item["change"].get("after")
        if isinstance(after, dict):
            for key in ("project", "project_id"):
                if key in after and after[key] not in (None, values["project_id"]):
                    raise ValueError("Service plan targets another project")
            if "location" in after and after["location"] not in (None, "asia-south1"):
                raise ValueError("Service plan targets another region")
        summary[actions[0]] += 1
    if summary["create"] == 0:
        raise ValueError("Service phase has no create-only changes")
    return summary


def protected_output(path: Path, payload: dict) -> None:
    if path.is_symlink():
        raise ValueError("Refusing symlink output")
    if path.exists() and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("Protected output permissions are too broad")
    raw = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(raw)


def run_command(argv: list[str], *, cwd: Path, stdout: bool = False) -> bytes:
    # Terraform's inherited CLI/workspace/variable flags could override the
    # reviewed plan. Preserve credential transport, not ambient TF settings.
    clean_env = {
        key: value for key, value in os.environ.items() if not key.startswith("TF_")
    }
    clean_env.update({"TF_IN_AUTOMATION": "1", "TF_INPUT": "0"})
    result = subprocess.run(
        argv, cwd=cwd, env=clean_env, capture_output=True, check=False, timeout=600
    )
    if result.returncode:
        raise ValueError("Reviewed deployment command failed")
    return result.stdout if stdout else b""


def terraform(phase: str, *, work: Path, env: dict[str, str], values: dict) -> None:
    tfvars = work / "base.auto.tfvars.json"
    plan_file = work / "base.tfplan"
    meta_file = work / "base.plan.private.json"
    prefix = ["terraform", f"-chdir={TF_ROOT}"]
    if phase == "prepare":
        protected_output(tfvars, values)
        return
    if phase == "plan":
        if (
            plan_file.exists()
            or plan_file.is_symlink()
            or meta_file.exists()
            or meta_file.is_symlink()
        ):
            raise ValueError("Use a fresh protected work directory for each plan")
        protected_output(tfvars, values)
        run_command(
            prefix
            + [
                "init",
                "-reconfigure",
                "-input=false",
                "-no-color",
                "-backend-config=bucket=" + env["AXIOM_TF_STATE_BUCKET"],
                "-backend-config=prefix=" + env["AXIOM_MARKETING_TF_STATE_PREFIX"],
            ],
            cwd=ROOT,
        )
        if (
            run_command(prefix + ["workspace", "show"], cwd=ROOT, stdout=True).strip()
            != b"default"
        ):
            raise ValueError("Terraform workspace is not the reviewed default")
        run_command(
            prefix
            + [
                "plan",
                "-input=false",
                "-no-color",
                "-lock-timeout=60s",
                "-var-file=" + str(tfvars),
                "-out=" + str(plan_file),
            ],
            cwd=ROOT,
        )
        if not plan_file.is_file() or plan_file.is_symlink():
            raise ValueError("Terraform plan artifact missing")
        plan_file.chmod(0o600)
        document = json.loads(
            run_command(
                prefix + ["show", "-json", str(plan_file)], cwd=ROOT, stdout=True
            )
        )
        summary = inspect_base_plan(
            document,
            project=env["GCP_PROJECT_ID"],
            release_sha=values["release_sha"],
            migration_account_id=values["migration_account_id"],
            bootstrap_secrets=values["bootstrap_secrets"],
        )
        protected_output(
            meta_file,
            {
                "release_sha": values["release_sha"],
                "project": env["GCP_PROJECT_ID"],
                "plan_sha256": hashlib.sha256(plan_file.read_bytes()).hexdigest(),
                "summary": summary,
            },
        )
        return
    if phase == "base":
        raise AssertionError("Use apply_base after approval validation")
    raise ValueError("Unsupported Terraform phase")


def service_values(
    *,
    phase: str,
    env: dict[str, str],
    release: dict,
    versions: dict,
    seed_receipt: dict | None = None,
) -> dict:
    if phase not in ("bootstrap-auth", "services"):
        raise ValueError("Unsupported service profile")
    proof = seed_receipt or {}
    if phase == "services" and (
        proof.get("release_sha") != release["release_sha"]
        or proof.get("project") != env["GCP_PROJECT_ID"]
        or proof.get("bucket") != env["AXIOM_IDLE_STATE_BUCKET"]
        or proof.get("object") != env["AXIOM_IDLE_STATE_OBJECT"]
        or proof.get("seed_target_sha256")
        != release.get("lifecycle_target_manifest_sha256")
        or proof.get("state_initialized") is not True
        or not re.fullmatch(r"[1-9][0-9]*", str(proof.get("seed_generation", "")))
    ):
        raise ValueError("Full services require exact create-only state seed receipt")
    return config_module.profile(env, release, versions, True, proof)


def verify_seed_receipt(env: dict[str, str], release: dict, receipt: dict) -> None:
    if (
        receipt.get("release_sha") != release["release_sha"]
        or receipt.get("project") != env["GCP_PROJECT_ID"]
        or receipt.get("bucket") != env["AXIOM_IDLE_STATE_BUCKET"]
        or receipt.get("object") != env["AXIOM_IDLE_STATE_OBJECT"]
        or receipt.get("seed_target_sha256")
        != release.get("lifecycle_target_manifest_sha256")
        or not re.fullmatch(
            r"[1-9][0-9]{0,29}", str(receipt.get("seed_generation", ""))
        )
        or not SHA256.fullmatch(str(receipt.get("seed_body_sha256", "")))
    ):
        raise ValueError("Lifecycle seed receipt differs from exact release")
    token = run_command(
        ["gcloud", "auth", "print-access-token"], cwd=ROOT, stdout=True
    ).strip()
    if not re.fullmatch(rb"[A-Za-z0-9._~+/-]{20,16384}", token):
        raise ValueError("Cloud identity token unavailable")
    bucket = quote(receipt["bucket"], safe="")
    object_name = quote(receipt["object"], safe="")
    generation = receipt["seed_generation"]
    url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{object_name}?generation={generation}"
    header = {"Authorization": "Bearer " + token.decode("ascii")}
    with urlopen(Request(url, headers=header), timeout=25) as response:
        metadata = json.loads(response.read(65537))
    if (
        not isinstance(metadata, dict)
        or metadata.get("bucket") != receipt["bucket"]
        or metadata.get("name") != receipt["object"]
        or metadata.get("generation") != generation
    ):
        raise ValueError("Live lifecycle state generation differs from receipt")
    with urlopen(Request(url + "&alt=media", headers=header), timeout=25) as response:
        body = response.read(65537)
    if hashlib.sha256(body).hexdigest() != receipt["seed_body_sha256"]:
        raise ValueError("Live lifecycle state bytes differ from seed receipt")
    state = json.loads(body)
    if (
        not isinstance(state, dict)
        or state.get("version") != 1
        or state.get("targetHash") != receipt["seed_target_sha256"]
        or state.get("phase") not in ("running", "stopped")
        or not isinstance(state.get("leases"), dict)
    ):
        raise ValueError("Live lifecycle state is incompatible with target")


def run_app_origin(value: str) -> bool:
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and parsed.hostname is not None
        and parsed.hostname.endswith(".run.app")
        and parsed.username is None
        and parsed.password is None
        and parsed.port is None
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    )


def service_terraform(
    *,
    phase: str,
    planning: bool,
    work: Path,
    env: dict[str, str],
    values: dict,
    approval: dict | None,
) -> None:
    prefix = ["terraform", f"-chdir={TF_ROOT}"]
    tfvars = work / f"{phase}.tfvars.private.json"
    binary = work / f"{phase}.tfplan"
    meta_file = work / f"{phase}.plan.private.json"
    if planning and (
        binary.exists()
        or binary.is_symlink()
        or meta_file.exists()
        or meta_file.is_symlink()
    ):
        raise ValueError("Use a fresh protected service plan")
    if planning:
        protected_output(tfvars, values)
    elif protected_json(tfvars) != values:
        raise ValueError("Service input variables changed since planning")
    run_command(
        prefix
        + [
            "init",
            "-reconfigure",
            "-input=false",
            "-no-color",
            "-backend-config=bucket=" + env["AXIOM_TF_STATE_BUCKET"],
            "-backend-config=prefix=" + env["AXIOM_MARKETING_TF_STATE_PREFIX"],
        ],
        cwd=ROOT,
    )
    if (
        run_command(prefix + ["workspace", "show"], cwd=ROOT, stdout=True).strip()
        != b"default"
    ):
        raise ValueError("Terraform workspace is not reviewed default")
    if planning:
        command = prefix + [
            "plan",
            "-input=false",
            "-no-color",
            "-lock-timeout=60s",
            "-var-file=" + str(tfvars),
            "-out=" + str(binary),
        ]
        if phase == "bootstrap-auth":
            command += ["-target=module.auth[0]"]
        run_command(command, cwd=ROOT)
        if not binary.is_file() or binary.is_symlink():
            raise ValueError("Service Terraform plan artifact missing")
        binary.chmod(0o600)
    elif (
        binary.is_symlink()
        or not binary.is_file()
        or stat.S_IMODE(binary.stat().st_mode) & 0o077
    ):
        raise ValueError("Protected service Terraform plan missing")
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    plan = json.loads(
        run_command(prefix + ["show", "-json", str(binary)], cwd=ROOT, stdout=True)
    )
    summary = inspect_service_plan(plan, values=values, phase=phase)
    if planning:
        protected_output(
            meta_file,
            {
                "release_sha": values["release_sha"],
                "project": env["GCP_PROJECT_ID"],
                "plan_sha256": digest,
                "summary": summary,
                "phase": phase,
            },
        )
        return
    meta = protected_json(meta_file)
    if meta != {
        "release_sha": values["release_sha"],
        "project": env["GCP_PROJECT_ID"],
        "plan_sha256": digest,
        "summary": summary,
        "phase": phase,
    }:
        raise ValueError("Service plan differs from reviewed descriptor")
    validate_approval(
        approval or {},
        env=env,
        source_sha=values["release_sha"],
        plan_sha=digest,
        phase=phase,
    )
    if (work / f"{phase}.receipt.private.json").exists():
        raise ValueError("Service phase already has a receipt")
    run_command(prefix + ["apply", "-input=false", "-no-color", str(binary)], cwd=ROOT)
    if phase == "bootstrap-auth":
        service = values["service_names"]["auth"]
        described = json.loads(
            run_command(
                [
                    "gcloud",
                    "run",
                    "services",
                    "describe",
                    service,
                    "--project=" + env["GCP_PROJECT_ID"],
                    "--region=asia-south1",
                    "--format=json",
                ],
                cwd=ROOT,
                stdout=True,
            )
        )
        resource_name = described.get("name") or described.get("metadata", {}).get(
            "name"
        )
        conditions = described.get("conditions") or described.get("status", {}).get(
            "conditions", []
        )
        v2_ready = (
            described.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED"
            and described.get("reconciling") is False
            and described.get("observedGeneration") == described.get("generation")
            and bool(described.get("latestReadyRevision"))
            and described.get("latestReadyRevision")
            == described.get("latestCreatedRevision")
        )
        v1_ready = (
            "terminalCondition" not in described
            and "reconciling" not in described
            and any(
                item.get("type") == "Ready" and item.get("status") == "True"
                for item in conditions
            )
        )
        if resource_name not in (
            service,
            f"projects/{env['GCP_PROJECT_ID']}/locations/asia-south1/services/{service}",
        ) or not (v2_ready or v1_ready):
            raise ValueError("Targeted GoTrue service is not ready")
        protected_output(
            work / "bootstrap-auth.receipt.private.json",
            {
                "release_sha": values["release_sha"],
                "project": env["GCP_PROJECT_ID"],
                "database_connection_name": f"{env['GCP_PROJECT_ID']}:asia-south1:{values['cloud_sql_instance_name']}",
                "service": service,
                "service_ready": True,
            },
        )
        return
    outputs = json.loads(
        run_command(prefix + ["output", "-json"], cwd=ROOT, stdout=True)
    )
    uris = outputs.get("cloud_run_uris", {}).get("value")
    controller = outputs.get("lifecycle_controller_uri", {}).get("value")
    idle_enabled = outputs.get("idle_automation_enabled", {}).get("value")
    if (
        not isinstance(uris, dict)
        or set(uris) != CORE
        or any(
            not isinstance(uri, str) or not run_app_origin(uri) for uri in uris.values()
        )
        or not isinstance(controller, str)
        or not run_app_origin(controller)
        or idle_enabled is not False
    ):
        raise ValueError("Applied service URI or paused scheduler output invalid")
    protected_output(
        work / "services.receipt.private.json",
        {
            "release_sha": values["release_sha"],
            "project": env["GCP_PROJECT_ID"],
            "cloud_run_uris": uris,
            "lifecycle_controller_uri": controller,
            "idle_automation_enabled": False,
        },
    )


def apply_base(
    *, work: Path, env: dict[str, str], values: dict, approval: dict
) -> None:
    plan_file = work / "base.tfplan"
    meta = protected_json(work / "base.plan.private.json")
    if (
        plan_file.is_symlink()
        or not plan_file.is_file()
        or stat.S_IMODE(plan_file.stat().st_mode) & 0o077
    ):
        raise ValueError("Protected Terraform plan missing")
    digest = hashlib.sha256(plan_file.read_bytes()).hexdigest()
    if (
        meta.get("plan_sha256") != digest
        or meta.get("project") != env["GCP_PROJECT_ID"]
        or meta.get("release_sha") != values["release_sha"]
    ):
        raise ValueError("Terraform plan changed since dry-run review")
    prefix = ["terraform", f"-chdir={TF_ROOT}"]
    shown = json.loads(
        run_command(prefix + ["show", "-json", str(plan_file)], cwd=ROOT, stdout=True)
    )
    summary = inspect_base_plan(
        shown,
        project=env["GCP_PROJECT_ID"],
        release_sha=values["release_sha"],
        migration_account_id=values["migration_account_id"],
        bootstrap_secrets=values["bootstrap_secrets"],
    )
    if summary != meta.get("summary"):
        raise ValueError("Terraform plan summary changed")
    validate_approval(
        approval,
        env=env,
        source_sha=values["release_sha"],
        plan_sha=digest,
        phase="base",
    )
    run_command(
        prefix
        + [
            "init",
            "-reconfigure",
            "-input=false",
            "-no-color",
            "-backend-config=bucket=" + env["AXIOM_TF_STATE_BUCKET"],
            "-backend-config=prefix=" + env["AXIOM_MARKETING_TF_STATE_PREFIX"],
        ],
        cwd=ROOT,
    )
    if (
        run_command(prefix + ["workspace", "show"], cwd=ROOT, stdout=True).strip()
        != b"default"
    ):
        raise ValueError("Terraform workspace is not the reviewed default")
    run_command(
        prefix + ["apply", "-input=false", "-no-color", str(plan_file)], cwd=ROOT
    )
    output = json.loads(
        run_command(prefix + ["output", "-json"], cwd=ROOT, stdout=True)
    )
    wrapped = output.get("database") if isinstance(output, dict) else None
    database = wrapped.get("value") if isinstance(wrapped, dict) else None
    if (
        not isinstance(database, dict)
        or database.get("instance") != values["cloud_sql_instance_name"]
        or database.get("name") != values["cloud_sql_database_name"]
        or database.get("connection_name")
        != f"{env['GCP_PROJECT_ID']}:asia-south1:{values['cloud_sql_instance_name']}"
    ):
        raise ValueError("Applied database output differs from reviewed target")
    address = ipaddress.IPv4Address(database.get("private_ip", ""))
    if not address.is_private:
        raise ValueError("Applied database address is not private")
    migration_wrapped = output.get("migration_service_account")
    migration_email = (
        migration_wrapped.get("value") if isinstance(migration_wrapped, dict) else None
    )
    if (
        migration_email
        != f"{env['MARKETING_MIGRATION_ACCOUNT_ID']}@{env['GCP_PROJECT_ID']}.iam.gserviceaccount.com"
    ):
        raise ValueError("Applied migration identity differs from reviewed target")
    protected_output(work / "database.private.json", database)
    protected_output(
        work / "migration-identity.private.json",
        {
            "email": migration_email,
            "project": env["GCP_PROJECT_ID"],
            "release_sha": values["release_sha"],
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=PHASES, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--release-manifest", type=Path)
    parser.add_argument("--security-clearance", type=Path, required=True)
    parser.add_argument("--secret-manifest", type=Path)
    parser.add_argument("--seed-proof", type=Path)
    parser.add_argument("--approval-record", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        os.umask(0o077)
        if args.phase in DEFERRED:
            raise ValueError(
                "Later deployment phase lacks a reviewed executable contract"
            )
        source_sha = clean_revision(ROOT)
        env = protected_env(args.env_file)
        clearance = protected_json(args.security_clearance)
        if args.phase in ("registry-plan", "registry"):
            target = registry_target(env, source_sha)
            validate_registry_clearance(clearance, target=target)
            if args.work_dir.is_symlink() or (
                args.work_dir.exists() and not args.work_dir.is_dir()
            ):
                raise ValueError("Protected work directory is unsafe")
            if args.dry_run:
                print(
                    f"Marketing registry local preflight accepted for project {target['project']} and source {source_sha}; no registry inventory or cloud changes were made."
                )
                return 0
            args.work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            args.work_dir.chmod(0o700)
            approval = (
                protected_json(args.approval_record) if args.approval_record else None
            )
            registry_phase(
                args.phase,
                work=args.work_dir,
                env=env,
                source_sha=source_sha,
                approval=approval,
                clearance=clearance,
            )
            print(f"Marketing {args.phase} completed; inspect protected receipt.")
            return 0
        if args.release_manifest is None:
            raise ValueError("Exact immutable release manifest required")
        release = protected_json(args.release_manifest)
        values = validate_inputs(env, release, clearance, source_sha)
        if args.work_dir.is_symlink() or (
            args.work_dir.exists() and not args.work_dir.is_dir()
        ):
            raise ValueError("Protected work directory is unsafe")
        approval = None
        if args.phase in (
            "bootstrap-roles-plan",
            "bootstrap-roles",
            "bootstrap-series-plan",
            "bootstrap-series",
        ):
            if args.secret_manifest is None:
                raise ValueError("Materialized secret version manifest required")
            database = protected_json(args.work_dir / "database.private.json")
            migration_identity = protected_json(
                args.work_dir / "migration-identity.private.json"
            )
            versions = protected_json(args.secret_manifest)
            if not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in versions.items()
            ):
                raise ValueError("Secret version manifest malformed")
            if args.phase in ("bootstrap-roles", "bootstrap-series"):
                approval = (
                    protected_json(args.approval_record) if args.approval_record else {}
                )
        if args.phase in ("seed-plan", "seed"):
            if args.seed_proof is None:
                raise ValueError("Exact bootstrap and exclusive-client proof required")
            database = protected_json(args.work_dir / "database.private.json")
            seed_proof = protected_json(args.seed_proof)
            if args.phase == "seed":
                approval = (
                    protected_json(args.approval_record) if args.approval_record else {}
                )
        if args.phase in (
            "bootstrap-auth-plan",
            "bootstrap-auth",
            "services-plan",
            "services",
        ):
            if args.secret_manifest is None:
                raise ValueError("Materialized secret version manifest required")
            versions = protected_json(args.secret_manifest)
            service_phase = "bootstrap-auth" if "auth" in args.phase else "services"
            if service_phase == "bootstrap-auth":
                roles = protected_json(
                    args.work_dir / "bootstrap-roles.receipt.private.json"
                )
                if (
                    roles.get("release_sha") != source_sha
                    or roles.get("project") != env["GCP_PROJECT_ID"]
                    or roles.get("phase") != "roles"
                ):
                    raise ValueError("Completed roles receipt required before GoTrue")
                lifecycle_receipt = None
            else:
                series = protected_json(
                    args.work_dir / "bootstrap-series.receipt.private.json"
                )
                if (
                    series.get("release_sha") != source_sha
                    or series.get("project") != env["GCP_PROJECT_ID"]
                    or series.get("phase") != "series"
                ):
                    raise ValueError(
                        "Completed migration series receipt required before services"
                    )
                lifecycle_receipt = protected_json(
                    args.work_dir / "seed.receipt.private.json"
                )
                verify_seed_receipt(env, release, lifecycle_receipt)
            service_config = service_values(
                phase=service_phase,
                env=env,
                release=release,
                versions=versions,
                seed_receipt=lifecycle_receipt,
            )
            if args.phase in ("bootstrap-auth", "services"):
                approval = (
                    protected_json(args.approval_record) if args.approval_record else {}
                )
        if args.phase == "base":
            approval = (
                protected_json(args.approval_record) if args.approval_record else {}
            )
            plan_file = args.work_dir / "base.tfplan"
            meta = protected_json(args.work_dir / "base.plan.private.json")
            if not plan_file.is_file() or plan_file.is_symlink():
                raise ValueError("Reviewed Terraform plan missing")
            validate_approval(
                approval,
                env=env,
                source_sha=source_sha,
                plan_sha=hashlib.sha256(plan_file.read_bytes()).hexdigest(),
                phase="base",
            )
            if meta.get("release_sha") != source_sha:
                raise ValueError("Reviewed Terraform plan differs from release")
        if args.dry_run:
            print(
                f"Marketing {args.phase} local preflight accepted for project {env['GCP_PROJECT_ID']} and source {source_sha}; no Terraform plan or cloud changes were made."
            )
            return 0
        args.work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        args.work_dir.chmod(0o700)
        if args.phase in ("prepare", "plan"):
            terraform(args.phase, work=args.work_dir, env=env, values=values)
        elif args.phase == "base":
            apply_base(work=args.work_dir, env=env, values=values, approval=approval)
        elif args.phase in ("seed-plan", "seed"):
            seed_phase(
                planning=args.phase == "seed-plan",
                work=args.work_dir,
                env=env,
                release=release,
                database=database,
                proof=seed_proof,
                approval=approval,
            )
        elif args.phase in (
            "bootstrap-auth-plan",
            "bootstrap-auth",
            "services-plan",
            "services",
        ):
            service_terraform(
                phase=service_phase,
                planning=args.phase.endswith("-plan"),
                work=args.work_dir,
                env=env,
                values=service_config,
                approval=approval,
            )
        else:
            bootstrap_job_phase(
                phase="roles" if "roles" in args.phase else "series",
                planning=args.phase.endswith("-plan"),
                work=args.work_dir,
                env=env,
                release=release,
                database=database,
                versions=versions,
                migration_identity=migration_identity,
                approval=approval,
            )
        print(
            f"Marketing {args.phase} phase completed; consult protected artifacts and verify cloud state before continuing."
        )
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        print(
            "Marketing deployment phase refused; review protected inputs, exact plan and target evidence. No credentials printed."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
