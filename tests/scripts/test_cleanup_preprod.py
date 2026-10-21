"""Offline scope/fence regressions; never invoke gcloud or a cloud endpoint."""

import copy
import importlib.util
import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "cleanup_preprod",
    Path(__file__).resolve().parents[2] / "scripts/cleanup-preprod.py",
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
NOW = datetime(2026, 10, 20, tzinfo=timezone.utc)
OLD = "2025-01-01T00:00:00Z"
NEW = "2026-10-19T00:00:00Z"
REPO = "asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod-images"
NAME = "axiom-proof-preprod-postgres"
BUCKET = "axiom-proof-preprod-temp-123"
DIGESTS = ["sha256:" + chr(97 + index) * 64 for index in range(4)]


def args(*extra):
    result = M.parser().parse_args(
        [
            "--project",
            "axiom-proof",
            "--region",
            "asia-south1",
            "--env",
            "preprod",
            "--dry-run",
            *extra,
        ]
    )
    M.validate(result)
    return result


def revision(package, digest):
    return {
        "metadata": {"name": "old-zero-traffic"},
        "spec": {"containers": [{"image": package + ":old"}]},
        "status": {"imageDigest": package + "@" + digest},
    }


def image(package, digest, uploaded=OLD):
    return {
        "package": package,
        "version": digest,
        "createTime": uploaded,
        "metadata": {"mediaType": "application/vnd.oci.image.manifest.v1+json"},
    }


class ConfirmationTests(unittest.TestCase):
    def test_preview_and_no_categories_never_delete(self):
        with patch.object(M, "cloud") as cloud, redirect_stdout(io.StringIO()):
            self.assertEqual(
                M.main(
                    [
                        "--project",
                        "axiom-proof",
                        "--region",
                        "asia-south1",
                        "--env",
                        "preprod",
                        "--dry-run",
                    ]
                ),
                0,
            )
        cloud.assert_not_called()

    def test_execution_requires_exact_project_and_explicit_category(self):
        for flags in [
            ["--delete-sql-backups"],
            ["--prune-images", "--confirm-project", "other"],
        ]:
            a = args(*flags)
            a.dry_run = False
            with self.assertRaises(M.CleanupError):
                M.validate(a)
        a = args("--prune-images", "--confirm-project", "axiom-proof")
        a.dry_run = False
        M.validate(a)

    def test_foreign_project_region_repo_and_keep_zero_refused(self):
        for key, value in [
            ("project", "other"),
            ("region", "us-central1"),
            ("env", "prod"),
            ("repository", "foreign"),
            ("keep_latest", 0),
            ("older_than_days", 0),
        ]:
            a = args()
            setattr(a, key, value)
            with self.subTest(key=key), self.assertRaises(M.CleanupError):
                M.validate(a)

    def test_exact_legacy_repository_only_when_explicit(self):
        self.assertEqual(
            args("--repository", "axiom-proof-preprod").repository,
            "axiom-proof-preprod",
        )
        with patch.dict(
            M.os.environ, {"AXIOM_ARTIFACT_REPOSITORY": "axiom-proof-preprod"}
        ):
            with self.assertRaises(M.CleanupError):
                args()
        with self.assertRaises(M.CleanupError):
            args("--repository", "axiom-proof-preprod-foreign/escape")

    def test_cli_error_redacts_provider_payload(self):
        a = [
            "--project",
            "axiom-proof",
            "--region",
            "asia-south1",
            "--env",
            "preprod",
            "--delete-sql-backups",
            "--dry-run",
        ]
        output = io.StringIO()
        with patch.object(M.subprocess, "run") as run, redirect_stderr(output):
            run.return_value.returncode = 1
            run.return_value.stderr = "secret cloud payload"
            self.assertEqual(M.main(a), 1)
        self.assertNotIn("secret", output.getvalue())


class BackupDiskTests(unittest.TestCase):
    def test_only_old_successful_backup_in_canonical_regional_instance(self):
        instances = [
            {"name": NAME, "region": "asia-south1"},
            {"name": "foreign", "region": "asia-south1"},
            {"name": NAME + "-other", "region": "us-east1"},
        ]
        backups = [
            {"id": 42, "status": "SUCCESSFUL", "endTime": OLD},
            {"id": 43, "status": "FAILED"},
            {"id": 44, "status": "SUCCESSFUL", "endTime": NEW},
        ]
        with patch.object(M, "cloud", side_effect=[instances, backups]) as cloud:
            result = M.backup_plan(args(), NOW.replace(month=9))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["identity"], NAME + "/42")
        self.assertEqual(cloud.call_count, 2)

    def test_disk_attached_foreign_and_new_skipped(self):
        base = {
            "name": "axiom-proof-preprod-disk",
            "users": [],
            "status": "READY",
            "creationTimestamp": OLD,
            "zone": "https://compute/projects/axiom-proof/zones/asia-south1-a",
        }
        rows = [
            base,
            {**base, "name": base["name"] + "-attached", "users": ["vm"]},
            {**base, "name": "foreign"},
            {**base, "zone": "zones/us-east1-a"},
            {**base, "creationTimestamp": NEW},
        ]
        with patch.object(M, "cloud", return_value=rows):
            result = M.disk_plan(args(), NOW.replace(month=9))
        self.assertEqual(len(result), 1)
        self.assertIn("--zone", result[0]["command"])
        with patch.object(M, "cloud", return_value=[{**base, "users": "unknown"}]):
            with self.assertRaises(M.CleanupError):
                M.disk_plan(args(), NOW)

    def test_selected_sql_instance_needs_double_confirmation_and_stopped_primary(self):
        a = args("--delete-sql-instance", NAME, "--confirm-project", "axiom-proof")
        a.dry_run = False
        with self.assertRaises(M.CleanupError):
            M.validate(a)
        a.confirm_delete_instance = [NAME]
        M.validate(a)
        row = {
            "name": NAME,
            "region": "asia-south1",
            "instanceType": "CLOUD_SQL_INSTANCE",
            "settings": {
                "activationPolicy": "NEVER",
                "deletionProtectionEnabled": False,
            },
        }
        with patch.object(M, "cloud", return_value=[row]):
            self.assertEqual(len(M.instance_plan(a, NOW)), 1)
        for mutation in [
            {"replicaNames": ["replica"]},
            {"masterInstanceName": "primary"},
            {"instanceType": "READ_REPLICA_INSTANCE"},
            {"settings": {"activationPolicy": "ALWAYS"}},
            {
                "settings": {
                    "activationPolicy": "NEVER",
                    "deletionProtectionEnabled": True,
                }
            },
            {"region": "us-east1"},
        ]:
            with (
                self.subTest(mutation=mutation),
                patch.object(M, "cloud", return_value=[{**row, **mutation}]),
            ):
                with self.assertRaises(M.CleanupError):
                    M.instance_plan(a, NOW)


class StorageTests(unittest.TestCase):
    def fixture(self):
        a = args("--delete-storage-objects", "gs://" + BUCKET + "/old/")
        obj = {
            "bucket": BUCKET,
            "name": "old/item",
            "generation": "123",
            "metageneration": "4",
            "timeCreated": OLD,
        }
        info = {"name": BUCKET, "projectNumber": "123", "location": "ASIA-SOUTH1"}
        return a, obj, info

    def test_explicit_prefix_generation_and_metadata_conditional_delete(self):
        a, obj, info = self.fixture()
        with patch.object(
            M, "cloud", side_effect=[{"projectNumber": "123"}, info, [obj]]
        ):
            result = M.storage_plan(a, NOW)
        self.assertEqual(len(result), 1)
        self.assertIn("--if-generation-match=123", result[0]["command"])
        self.assertIn("--if-metageneration-match=4", result[0]["command"])
        self.assertNotIn("--recursive", result[0]["command"])

    def test_holds_retention_and_new_objects_preserved(self):
        a, obj, info = self.fixture()
        for addition in [
            {"temporaryHold": True},
            {"eventBasedHold": True},
            {"retentionExpirationTime": OLD},
            {"retention": {"mode": "Unlocked"}},
            {"timeCreated": NEW},
        ]:
            with patch.object(
                M,
                "cloud",
                side_effect=[{"projectNumber": "123"}, info, [{**obj, **addition}]],
            ):
                self.assertEqual(M.storage_plan(a, NOW.replace(month=9)), [])
        with patch.object(
            M,
            "cloud",
            side_effect=[
                {"projectNumber": "123"},
                {**info, "retentionPolicy": {"isLocked": False}},
            ],
        ) as cloud:
            self.assertEqual(M.storage_plan(a, NOW), [])
            self.assertEqual(cloud.call_count, 2)

    def test_entire_bucket_state_s3_wildcard_and_escape_refused(self):
        for target in [
            "gs://" + BUCKET,
            "gs://axiom-proof-preprod-state-123/old/",
            "s3://" + BUCKET + "/old/",
            "gs://" + BUCKET + "/old/*/",
            "gs://" + BUCKET + "/../",
        ]:
            with self.subTest(target=target), self.assertRaises(M.CleanupError):
                M.storage_scope(target)
        a, obj, info = self.fixture()
        for bad in [
            {**obj, "name": "other/item"},
            {**obj, "bucket": "foreign"},
            {**obj, "generation": None},
        ]:
            with patch.object(
                M, "cloud", side_effect=[{"projectNumber": "123"}, info, [bad]]
            ):
                with self.assertRaises(M.CleanupError):
                    M.storage_plan(a, NOW)
        with patch.object(
            M,
            "cloud",
            side_effect=[{"projectNumber": "123"}, {**info, "projectNumber": "999"}],
        ):
            with self.assertRaises(M.CleanupError):
                M.storage_plan(a, NOW)


class ImageTests(unittest.TestCase):
    def fixture(self):
        p, q = REPO + "/axiom-bff", REPO + "/axiom-web"
        versions = [
            image(p, DIGESTS[0], NEW),
            image(p, DIGESTS[1], "2025-02-01T00:00:00Z"),
            image(p, DIGESTS[2]),
            image(q, DIGESTS[3]),
        ]
        return p, q, versions

    def test_preserve_latest_each_package_and_zero_traffic_deployed(self):
        p, _, versions = self.fixture()
        with patch.object(
            M, "cloud", side_effect=[[revision(p, DIGESTS[1])], versions]
        ) as cloud:
            result = M.image_plan(args(), NOW.replace(month=9))
        self.assertEqual([x["identity"] for x in result], [p + "@" + DIGESTS[2]])
        self.assertNotIn("--filter", cloud.call_args_list[0].args[0])
        self.assertNotIn("--limit", cloud.call_args_list[0].args[0])

    def test_digest_deployed_under_other_package_is_still_preserved(self):
        p, q, versions = self.fixture()
        with patch.object(
            M,
            "cloud",
            side_effect=[[revision(q, DIGESTS[1]), revision(q, DIGESTS[2])], versions],
        ):
            self.assertEqual(M.image_plan(args(), NOW), [])

    def test_same_upload_time_ties_preserved_and_buildtime_ignored(self):
        p, _, versions = self.fixture()
        versions[1]["createTime"] = NEW
        versions[1]["metadata"].update(buildTime=OLD)
        with patch.object(M, "cloud", side_effect=[[], versions]):
            result = M.image_plan(args(), NOW.replace(month=9))
        self.assertEqual([x["identity"] for x in result], [p + "@" + DIGESTS[2]])

    def test_kept_index_protects_older_platform_manifest(self):
        package, _, versions = self.fixture()
        versions[0]["metadata"]["mediaType"] = "application/vnd.oci.image.index.v1+json"
        with (
            patch.object(M, "cloud", side_effect=[[], versions]),
            patch.object(
                M, "index_dependencies", return_value={DIGESTS[0], DIGESTS[2]}
            ) as dependencies,
        ):
            result = M.image_plan(args(), NOW)
        dependencies.assert_called_once_with(package + "@" + DIGESTS[0])
        self.assertEqual([x["identity"] for x in result], [package + "@" + DIGESTS[1]])

    def test_newer_child_does_not_displace_latest_release_index(self):
        package, _, versions = self.fixture()
        versions[1]["metadata"]["mediaType"] = "application/vnd.oci.image.index.v1+json"
        with (
            patch.object(M, "cloud", side_effect=[[], versions]),
            patch.object(
                M, "index_dependencies", return_value={DIGESTS[1], DIGESTS[2]}
            ) as dependencies,
        ):
            result = M.image_plan(args(), NOW)
        dependencies.assert_called_once_with(package + "@" + DIGESTS[1])
        self.assertEqual(result, [])

    def test_unknown_retained_index_closure_prevents_deletion(self):
        _, _, versions = self.fixture()
        versions[0]["metadata"]["mediaType"] = "application/vnd.oci.image.index.v1+json"
        with (
            patch.object(M, "cloud", side_effect=[[], versions]),
            patch.object(
                M, "index_dependencies", side_effect=M.CleanupError("unconfirmed")
            ),
            self.assertRaises(M.CleanupError),
        ):
            M.image_plan(args(), NOW)

    def test_keep_two_and_bare_resolved_digest(self):
        p, _, versions = self.fixture()
        r = revision(p, DIGESTS[2])
        r["status"]["imageDigest"] = DIGESTS[2]
        with patch.object(M, "cloud", side_effect=[[r], versions]):
            self.assertEqual(M.image_plan(args("--keep-latest", "2"), NOW), [])

    def test_unknown_revision_sidecar_inventory_or_foreign_package_refuses(self):
        p, _, versions = self.fixture()
        bad_revisions = [
            {"spec": {"containers": [{"image": p + ":mutable"}]}, "status": {}},
            {"spec": {}, "status": {}},
            {
                "spec": {
                    "containers": [
                        {"image": p + "@" + DIGESTS[0]},
                        {"image": p + ":sidecar"},
                    ]
                },
                "status": {},
            },
        ]
        for row in bad_revisions:
            with self.subTest(row=row), patch.object(M, "cloud", return_value=[row]):
                with self.assertRaises(M.CleanupError):
                    M.image_plan(args(), NOW)
        for mutation in [
            {"package": "foreign/image"},
            {"version": "latest"},
            {"createTime": None},
        ]:
            bad = copy.deepcopy(versions)
            bad[0].update(mutation)
            with patch.object(M, "cloud", side_effect=[[], bad]):
                with self.assertRaises(M.CleanupError):
                    M.image_plan(args(), NOW)

    def test_new_deployment_between_plan_and_delete_refuses_write(self):
        p, _, versions = self.fixture()
        with patch.object(M, "cloud", side_effect=[[], versions]):
            initial = M.image_plan(args(), NOW.replace(month=9))
        a = args("--prune-images")
        with patch.object(
            M,
            "cloud",
            side_effect=[[revision(p, DIGESTS[1]), revision(p, DIGESTS[2])], versions],
        ) as cloud:
            with self.assertRaises(M.CleanupError):
                M.execute(a, NOW.replace(month=9), initial)
        self.assertFalse(any(c.kwargs.get("write") for c in cloud.call_args_list))

    def test_successful_execution_rechecks_and_only_uses_explicit_delete_command(self):
        item = M.action(
            "detached-disk", "fixture", ["compute", "disks", "delete", "fixture"]
        )
        with (
            patch.object(M, "plan", return_value=[item]) as plan,
            patch.object(M, "cloud") as cloud,
        ):
            M.execute(args(), NOW, [item])
        plan.assert_called_once()
        cloud.assert_called_once_with(item["command"], write=True)


if __name__ == "__main__":
    unittest.main()
