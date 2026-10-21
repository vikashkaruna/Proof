#!/usr/bin/env python3
"""Explicit, scoped preprod leftovers cleanup. No secrets or infrastructure teardown.

Run --dry-run first. Concurrent deployment must be quiesced by the operator:
registry/revision APIs offer no atomic cross-service deletion transaction. Every
candidate is re-inventoried immediately before deletion; drift stops execution.
No retention/hold policy is modified; buckets/repositories are never deleted.
SQL instances require separate exact-name deletion and confirmation flags.
GCS requests use exact generation AND metageneration preconditions.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess  # nosec B404
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

PREFIX = "axiom-proof-preprod-"
PROJECT = "axiom-proof"
REGION = "asia-south1"
MAX_ROWS = 10000


class CleanupError(ValueError):
    """Sanitized refusal; cloud output must never be echoed."""


def cloud(args, *, write=False):
    # Fixed gcloud executable; internally constructed argv, no shell.
    result = subprocess.run(  # nosec B603, B607
        ["gcloud", *args, "--quiet" if write else "--format=json"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode:
        raise CleanupError("Cloud command failed; no error payload was logged")
    if write:
        return None
    try:
        return json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise CleanupError("Unreadable cloud inventory") from exc


def rows(value):
    if (
        not isinstance(value, list)
        or len(value) > MAX_ROWS
        or any(not isinstance(x, dict) for x in value)
    ):
        raise CleanupError("Unknown or oversized cloud inventory")
    return value


def text(value):
    if not isinstance(value, str) or not value:
        raise CleanupError("Missing inventory identity")
    return value


def instant(value):
    try:
        value = datetime.fromisoformat(text(value).replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError("Timezone required")
        return value
    except (ValueError, TypeError) as exc:
        raise CleanupError("Unknown inventory timestamp") from exc


def canonical(name):
    return (
        isinstance(name, str)
        and re.fullmatch(PREFIX + r"[a-z0-9]+(?:-[a-z0-9]+)*", name) is not None
    )


def storage_scope(value):
    url = urlsplit(value)
    bucket, prefix = url.netloc, url.path.lstrip("/")
    if (
        any(char in value for char in "?#")
        or url.scheme != "gs"
        or url.query
        or url.fragment
        or not canonical(bucket)
        or "state" in bucket.split("-")
        or not prefix
        or not prefix.endswith("/")
        or any(x in prefix for x in "*?[]#\\\r\n")
        or any(x in {"", ".", ".."} for x in prefix.rstrip("/").split("/"))
    ):
        raise CleanupError(
            "Storage requires a non-state canonical gs://bucket/explicit-prefix/"
        )
    return bucket, prefix


def validate(args):
    if (args.project, args.region, args.env) != (PROJECT, REGION, "preprod"):
        raise CleanupError(
            "Only approved axiom-proof / asia-south1 / preprod is supported"
        )
    explicit_repository = args.repository is not None
    args.repository = args.repository or os.environ.get(
        "AXIOM_ARTIFACT_REPOSITORY", PREFIX + "images"
    )
    legacy = args.repository == "axiom-proof-preprod" and explicit_repository
    if (
        (not canonical(args.repository) and not legacy)
        or not 1 <= args.keep_latest <= 100
        or not 1 <= args.older_than_days <= 36500
    ):
        raise CleanupError("Invalid repository, retention count or age cutoff")
    for target in args.delete_storage_objects:
        storage_scope(target)
    if len(set(args.delete_sql_instance)) != len(args.delete_sql_instance) or any(
        not canonical(n) for n in args.delete_sql_instance
    ):
        raise CleanupError("Explicit canonical SQL instance identities required")
    if (
        args.delete_sql_instance
        and not args.dry_run
        and set(args.delete_sql_instance) != set(args.confirm_delete_instance)
    ):
        raise CleanupError(
            "Each SQL instance deletion requires matching --confirm-delete-instance"
        )
    selected = (
        args.delete_sql_backups
        or args.delete_storage_objects
        or args.delete_detached_disks
        or args.prune_images
        or args.delete_sql_instance
    )
    if selected and not args.dry_run and args.confirm_project != args.project:
        raise CleanupError(
            "Execution requires --confirm-project matching the exact project"
        )


def action(kind, identity, command):
    return {"category": kind, "identity": identity, "command": command}


def backup_plan(args, cutoff):
    result = []
    instances = rows(cloud(["sql", "instances", "list", "--project", args.project]))
    for instance in instances:
        name = text(instance.get("name"))
        if not canonical(name) or instance.get("region") != args.region:
            continue
        if instance.get("project", args.project) != args.project:
            raise CleanupError("Foreign SQL instance identity")
        backups = rows(
            cloud(
                [
                    "sql",
                    "backups",
                    "list",
                    "--instance",
                    name,
                    "--project",
                    args.project,
                ]
            )
        )
        for backup in backups:
            if backup.get("status") != "SUCCESSFUL":
                continue
            if instant(backup.get("endTime")) >= cutoff:
                continue
            identifier = str(backup.get("id", ""))
            if (
                not re.fullmatch(r"[0-9]+", identifier)
                or backup.get("instance", name) != name
            ):
                raise CleanupError("Unknown SQL backup identity")
            result.append(
                action(
                    "sql-backup",
                    name + "/" + identifier,
                    [
                        "sql",
                        "backups",
                        "delete",
                        identifier,
                        "--instance",
                        name,
                        "--project",
                        args.project,
                    ],
                )
            )
    return result


def instance_plan(args, _cutoff):
    inventory = {
        text(item.get("name")): item
        for item in rows(cloud(["sql", "instances", "list", "--project", args.project]))
    }
    result = []
    for name in args.delete_sql_instance:
        instance = inventory.get(name)
        if (
            not isinstance(instance, dict)
            or instance.get("region") != args.region
            or instance.get("project", args.project) != args.project
        ):
            raise CleanupError(
                "Exact SQL instance absent or outside approved region/project"
            )
        settings = instance.get("settings")
        if (
            not isinstance(settings, dict)
            or settings.get("activationPolicy") != "NEVER"
            or instance.get("instanceType") != "CLOUD_SQL_INSTANCE"
            or instance.get("masterInstanceName")
            or instance.get("replicaNames", []) != []
            or settings.get("deletionProtectionEnabled", False) is not False
            or instance.get("deletionProtectionEnabled", False) is not False
        ):
            raise CleanupError(
                "SQL instance must be stopped primary without replicas/protection; "
                "policy is never altered"
            )
        result.append(
            action(
                "sql-instance",
                name,
                ["sql", "instances", "delete", name, "--project", args.project],
            )
        )
    return result


def storage_plan(args, cutoff):
    result = []
    project = cloud(["projects", "describe", args.project])
    if (
        not isinstance(project, dict)
        or project.get("projectId", args.project) != args.project
        or not str(project.get("projectNumber", "")).isdigit()
    ):
        raise CleanupError("Unknown project number")
    for target in args.delete_storage_objects:
        bucket, prefix = storage_scope(target)
        info = cloud(
            [
                "storage",
                "buckets",
                "describe",
                "gs://" + bucket,
                "--raw",
                "--project",
                args.project,
            ]
        )
        if (
            not isinstance(info, dict)
            or info.get("name") != bucket
            or str(info.get("projectNumber")) != str(project["projectNumber"])
            or text(info.get("location")).lower() != args.region
        ):
            raise CleanupError("Bucket project/location identity differs")
        # Any bucket retention policy is deliberately preserved, even unlocked.
        if info.get("retentionPolicy") or info.get("objectRetention"):
            continue
        objects = rows(
            cloud(
                [
                    "storage",
                    "objects",
                    "list",
                    target + "**",
                    "--raw",
                    "--project",
                    args.project,
                ]
            )
        )
        for obj in objects:
            name = text(obj.get("name"))
            if (
                obj.get("bucket") != bucket
                or not name.startswith(prefix)
                or any(x in name for x in "*?[]#\\\r\n")
            ):
                raise CleanupError("Object escaped exact reviewed prefix")
            if any(
                key in obj and type(obj[key]) is not bool
                for key in ["temporaryHold", "eventBasedHold"]
            ):
                raise CleanupError("Unknown object hold metadata")
            if (
                obj.get("temporaryHold")
                or obj.get("eventBasedHold")
                or obj.get("retention")
                or obj.get("retentionExpirationTime")
            ):
                continue
            if instant(obj.get("timeCreated")) >= cutoff:
                continue
            generation, meta = (
                str(obj.get("generation", "")),
                str(obj.get("metageneration", "")),
            )
            if not generation.isdigit() or not meta.isdigit():
                raise CleanupError("Missing immutable object version")
            url = "gs://" + bucket + "/" + name
            result.append(
                action(
                    "storage-object",
                    url + "#" + generation,
                    [
                        "storage",
                        "rm",
                        url,
                        "--if-generation-match=" + generation,
                        "--if-metageneration-match=" + meta,
                        "--project",
                        args.project,
                    ],
                )
            )
    return result


def disk_plan(args, cutoff):
    result = []
    for disk in rows(cloud(["compute", "disks", "list", "--project", args.project])):
        name = text(disk.get("name"))
        if not canonical(name):
            continue
        if disk.get("selfLink") and "/projects/" + args.project + "/" not in text(
            disk["selfLink"]
        ):
            raise CleanupError("Foreign disk project identity")
        users = disk.get("users", [])  # Compute omits an empty repeated field.
        if not isinstance(users, list):
            raise CleanupError("Unknown disk attachment inventory")
        if users or disk.get("status") != "READY":
            continue
        if instant(disk.get("creationTimestamp")) >= cutoff:
            continue
        if disk.get("zone"):
            zone = text(disk["zone"]).rsplit("/", 1)[-1]
            if not re.fullmatch(re.escape(args.region) + "-[a-z]", zone):
                continue
            scope = ["--zone", zone]
        elif disk.get("region"):
            if text(disk["region"]).rsplit("/", 1)[-1] != args.region:
                continue
            scope = ["--region", args.region]
        else:
            raise CleanupError("Unknown disk location")
        result.append(
            action(
                "detached-disk",
                name + "/" + scope[-1],
                ["compute", "disks", "delete", name, *scope, "--project", args.project],
            )
        )
    return result


def deployed_images(args):
    protected = set()
    revisions = rows(
        cloud(
            [
                "run",
                "revisions",
                "list",
                "--project",
                args.project,
                "--region",
                args.region,
            ]
        )
    )
    for revision in revisions:
        spec, status = revision.get("spec"), revision.get("status")
        if not isinstance(spec, dict) or not isinstance(status, dict):
            raise CleanupError("Unknown revision inventory; images retained")
        containers = spec.get("containers")
        if not isinstance(containers, list) or not containers:
            raise CleanupError("Unknown revision containers; images retained")
        for index, container in enumerate(containers):
            if not isinstance(container, dict):
                raise CleanupError("Unknown revision container")
            image = text(container.get("image"))
            resolved = status.get("imageDigest") if index == 0 else None
            if isinstance(resolved, str) and resolved:
                if resolved.startswith("sha256:"):
                    resolved = image.split("@", 1)[0].rsplit(":", 1)[0] + "@" + resolved
                image = resolved
            if not re.fullmatch(r"[^@\s]+@sha256:[a-f0-9]{64}", image):
                raise CleanupError(
                    "Unresolved deployed revision image; images retained"
                )
            protected.add(image)
            protected.add(image.rsplit("@", 1)[1])
    return protected


@lru_cache(maxsize=128)
def index_dependencies(identity):
    """Read OCI/Docker index closure; never delete a kept platform/attestation."""
    registry = identity.split("/", 1)[0]
    package = identity.rsplit("@", 1)[0]
    protected, pending = set(), [identity]
    with tempfile.TemporaryDirectory(prefix="axiom-registry-read-") as directory:
        config = Path(directory) / "config.json"
        config.write_text(
            json.dumps(
                {
                    "credHelpers": {registry: "gcloud"},
                    "cliPluginsExtraDirs": [
                        str(Path.home() / ".docker/cli-plugins"),
                        "/Applications/Docker.app/Contents/Resources/cli-plugins",
                        "/usr/local/lib/docker/cli-plugins",
                        "/usr/libexec/docker/cli-plugins",
                    ],
                }
            )
        )
        config.chmod(0o600)
        while pending:
            current = pending.pop()
            digest = current.rsplit("@", 1)[1]
            if digest in protected:
                continue
            if len(protected) >= 256:
                raise CleanupError("Image dependency inventory exceeded limit")
            result = subprocess.run(  # nosec B603, B607
                [
                    "docker",
                    "--config",
                    directory,
                    "buildx",
                    "imagetools",
                    "inspect",
                    "--raw",
                    current,
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                env={**os.environ, "CLOUDSDK_CORE_PROJECT": PROJECT},
            )
            if result.returncode or len(result.stdout) > 2_000_000:
                raise CleanupError("Retained image dependency read failed; images kept")
            try:
                document = json.loads(result.stdout)
            except ValueError as exc:
                raise CleanupError("Unreadable retained manifest; images kept") from exc
            if not isinstance(document, dict) or document.get("schemaVersion") != 2:
                raise CleanupError("Unknown retained manifest")
            media = document.get("mediaType")
            if media in (
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
            ):
                descriptors = rows(document.get("manifests"))
                if not descriptors:
                    raise CleanupError("Empty retained image index")
                for descriptor in descriptors:
                    child = descriptor.get("digest")
                    if not isinstance(child, str) or not re.fullmatch(
                        r"sha256:[a-f0-9]{64}", child
                    ):
                        raise CleanupError("Unknown retained child manifest")
                    pending.append(package + "@" + child)
            elif media not in (
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.v2+json",
            ):
                raise CleanupError("Unknown retained manifest media type")
            protected.add(digest)
    return protected


def image_plan(args, cutoff):
    prefix = args.region + "-docker.pkg.dev/" + args.project + "/" + args.repository
    deployed = deployed_images(args)
    images = rows(
        cloud(
            ["artifacts", "docker", "images", "list", prefix, "--project", args.project]
        )
    )
    packages = {}
    for image in images:
        package, version = text(image.get("package")), text(image.get("version"))
        if (
            not package.startswith(prefix + "/")
            or not re.fullmatch(r"[a-z0-9][a-z0-9._/-]*", package[len(prefix) + 1 :])
            or "/../" in package
        ):
            raise CleanupError("Foreign registry package")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", version):
            raise CleanupError("Unknown image digest")
        # gcloud DockerImageToLegacy maps API uploadTime to createTime,
        # not buildTime or updateTime.
        uploaded = instant(image.get("uploadTime", image.get("createTime")))
        media = (image.get("metadata") or {}).get("mediaType")
        if media not in (
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        ):
            raise CleanupError("Unknown registry media type; images retained")
        packages.setdefault(package, []).append((uploaded, version, media))
    result = []
    for package, versions in packages.items():
        if len(set(version for _, version, _ in versions)) != len(versions):
            raise CleanupError("Duplicate image digest inventory")
        versions.sort(reverse=True)
        threshold = versions[min(args.keep_latest, len(versions)) - 1][0]
        # Index upload order can precede its platform/attestation children.
        # Keep the newest release indexes independently of newer child blobs.
        indexes = [
            v
            for v in versions
            if v[2]
            in (
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
            )
        ]
        retained_indexes = {v[1] for v in indexes[: args.keep_latest]}
        deployed.update(retained_indexes)
        for uploaded, version, media in versions:
            identity = package + "@" + version
            if (
                uploaded >= threshold or identity in deployed or version in deployed
            ) and media in (
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
            ):
                deployed.update(index_dependencies(identity))
        for uploaded, version, _ in versions:
            identity = package + "@" + version
            if uploaded >= threshold or identity in deployed or version in deployed:
                continue
            result.append(
                action(
                    "registry-image",
                    identity,
                    [
                        "artifacts",
                        "docker",
                        "images",
                        "delete",
                        identity,
                        "--delete-tags",
                        "--project",
                        args.project,
                    ],
                )
            )
    return result


def plan(args, cutoff):
    result = []
    for enabled, planner in [
        (args.delete_sql_backups, backup_plan),
        (args.delete_storage_objects, storage_plan),
        (args.delete_detached_disks, disk_plan),
        (args.prune_images, image_plan),
        (args.delete_sql_instance, instance_plan),
    ]:
        if enabled:
            result.extend(planner(args, cutoff))
    if len({(item["category"], item["identity"]) for item in result}) != len(result):
        raise CleanupError("Duplicate cleanup targets")
    return result


def write_receipt(value):
    directory = Path(__file__).resolve().parents[1] / ".axiom-runtime" / "softstop"
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise CleanupError("Owned cleanup receipt directory required")
    directory.chmod(0o700)
    destination = directory / "preprod-cleanup.json"
    if destination.is_symlink():
        raise CleanupError("Cleanup receipt symlink refused")
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = Path(stream.name)
    temporary.replace(destination)


def execute(args, cutoff, initial, receipt=None):
    for index, item in enumerate(initial):
        # Recheck attachment/holds/retention/generation/latest and ALL revisions.
        # Any inventory failure stops; no unverified deletion is attempted.
        current = plan(args, cutoff)
        if item not in current:
            raise CleanupError("Cleanup inventory changed; remaining targets retained")
        if receipt is not None:
            receipt["outcomes"][index]["state"] = "unconfirmed"
            write_receipt(receipt)
        cloud(item["command"], write=True)
        if receipt is not None:
            receipt["outcomes"][index]["state"] = "command_confirmed"
            write_receipt(receipt)


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--project", required=True)
    value.add_argument("--region", required=True)
    value.add_argument("--env", choices=["preprod"], required=True)
    value.add_argument("--dry-run", action="store_true")
    value.add_argument("--confirm-project")
    value.add_argument("--delete-sql-backups", action="store_true")
    value.add_argument(
        "--delete-sql-instance", action="append", default=[], metavar="EXACT_NAME"
    )
    value.add_argument(
        "--confirm-delete-instance", action="append", default=[], metavar="EXACT_NAME"
    )
    value.add_argument(
        "--delete-storage-objects",
        action="append",
        default=[],
        metavar="gs://BUCKET/PREFIX/",
    )
    value.add_argument("--delete-detached-disks", action="store_true")
    value.add_argument("--prune-images", action="store_true")
    value.add_argument(
        "--repository",
        help=(
            "Canonical repository; exact legacy axiom-proof-preprod "
            "requires this explicit flag"
        ),
    )
    value.add_argument("--keep-latest", type=int, default=1)
    value.add_argument("--older-than-days", type=int, default=30)
    return value


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        validate(args)
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.older_than_days)
        items = plan(args, cutoff)
        print(
            json.dumps(
                {
                    "dryRun": args.dry_run,
                    "cutoff": cutoff.isoformat(),
                    "targets": items,
                    "retainedManual": [
                        "Secrets and secret versions",
                        "Subscriptions and vendor configuration",
                        "S3/Object Lock evidence",
                        "Buckets/repositories; SQL instances unless separately "
                        "selected and confirmed",
                    ],
                },
                indent=2,
            )
        )
        if not args.dry_run:
            receipt = {
                "project": args.project,
                "region": args.region,
                "at": datetime.now(timezone.utc).isoformat(),
                "completed": False,
                "outcomes": [
                    {
                        "identity": item["identity"],
                        "category": item["category"],
                        "state": "pending",
                    }
                    for item in items
                ],
            }
            write_receipt(receipt)
            execute(args, cutoff, items, receipt)
            receipt["completed"] = True
            write_receipt(receipt)
        return 0
    except (CleanupError, OSError, subprocess.TimeoutExpired) as exc:
        print(
            str(exc)
            if isinstance(exc, CleanupError)
            else "Cloud command unavailable; cleanup stopped",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
