"""Source-only producer proof with mocked database/provider/process transports."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


M = load("scheduled_backup", "scripts/scheduled-backup.py")
C = load("scheduled_backup_consumer", "scripts/recovery-evidence.py")
NOW = datetime.now(UTC) - timedelta(seconds=2)
CONTENT = b"exact retained synthetic evidence bytes"
KEY = "ab" * 32


class FakeSnapshot:
    def __init__(self, config):
        self.backup_at = NOW.isoformat()
        self.closed = False
        self.calls = []
        self.metadata = {
            "tableCount": 86,
            "rlsCount": 84,
            "ledgerFingerprint": "5:" + "a" * 64,
            "ledgerBreaks": 0,
            "references": [
                {
                    "bucket": config.bucket,
                    "key": "tenants/t1/evidence/item",
                    "versionId": "exact-v1",
                    "sha256": hashlib.sha256(CONTENT).hexdigest(),
                    "byteSize": len(CONTENT),
                }
            ],
        }

    def __enter__(self):
        self.calls.append("begin")
        return self

    def __exit__(self, *args):
        self.closed = True
        self.calls.append("close")

    def inventory(self):
        self.calls.append("inventory")
        return self.metadata

    def dump(self, path):
        self.calls.append("dump")
        self.dump_path = path
        with M.secure_open(path) as stream:
            stream.write(b"S" * 60000)
            stream.flush()
            os.fsync(stream.fileno())


class FakeS3:
    def __init__(self):
        self.region = "ap-south-1"
        self.mode = "COMPLIANCE"
        self.years = 7
        self.expiry = NOW + timedelta(
            days=3
        )  # Old locked evidence need not have seven future years.
        self.hold = "ON"
        self.content = CONTENT
        self.version = "exact-v1"
        self.size = len(CONTENT)
        self.calls = []
        self.bodies = []

    def get_bucket_location(self, **kwargs):
        return {"LocationConstraint": self.region}

    def get_object_lock_configuration(self, **kwargs):
        return {
            "ObjectLockConfiguration": {
                "ObjectLockEnabled": "Enabled",
                "Rule": {"DefaultRetention": {"Mode": self.mode, "Years": self.years}},
            }
        }

    def get_object_retention(self, **kwargs):
        self.calls.append(kwargs)
        return {"Retention": {"Mode": self.mode, "RetainUntilDate": self.expiry}}

    def get_object_legal_hold(self, **kwargs):
        self.calls.append(kwargs)
        return {"LegalHold": {"Status": self.hold}}

    def get_object(self, **kwargs):
        self.calls.append(kwargs)
        body = io.BytesIO(self.content)
        self.bodies.append(body)
        return {
            "Body": body,
            "VersionId": self.version,
            "ContentLength": self.size,
            "ServerSideEncryption": "AES256",
        }


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="axiom-backup-mocked-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.passfile = self.root / "pgpass"
        self.passfile.write_text(
            "localhost:5432:axiom_onprem:backup:synthetic-password\n"
        )
        self.passfile.chmod(0o600)
        self.env = {
            "PGHOST": "localhost",
            "PGPORT": "5432",
            "PGUSER": "backup",
            "PGDATABASE": "axiom_onprem",
            "PGPASSFILE": str(self.passfile),
            "AXIOM_BACKUP_OUTPUT": str(self.root),
            "AXIOM_BACKUP_SOURCE_BUCKET": "original-evidence",
            "AXIOM_RECOVERY_MANIFEST_KEY": KEY,
            "AXIOM_BACKUP_SOURCE_REGION": "ap-south-1",
            "AXIOM_BACKUP_STORAGE_ACCESS_KEY_ID": "synthetic-access",
            "AXIOM_BACKUP_STORAGE_SECRET_ACCESS_KEY": "synthetic-source-secret",
        }
        self.config = M.Config.from_environment(self.env)
        self.snapshot = FakeSnapshot(self.config)
        self.s3 = FakeS3()

    def produce(self):
        return M.produce(self.config, lambda _: self.snapshot, lambda _: self.s3)

    def no_publication(self):
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["pgpass"])

    def test_complete_backup_interoperates_with_real_consumer(self):
        final = self.produce()
        manifest = json.loads((final / "manifest.json").read_text())
        self.assertEqual(manifest["backupAt"], NOW.isoformat())
        self.assertEqual(
            manifest["evidence"][0]["retainUntil"], self.s3.expiry.isoformat()
        )
        self.assertEqual(self.snapshot.calls, ["begin", "inventory", "dump", "close"])
        self.assertTrue(self.snapshot.closed)
        self.assertTrue(all(b.closed for b in self.s3.bodies))
        for call in self.s3.calls:
            self.assertEqual(
                call,
                {
                    "Bucket": self.config.bucket,
                    "Key": "tenants/t1/evidence/item",
                    "VersionId": "exact-v1",
                },
            )
        with patch.dict(os.environ, {"AXIOM_RECOVERY_MANIFEST_KEY": KEY}):
            result = C.validate(
                final / "manifest.json",
                final / "database.sql",
                final,
                "axiom_onprem",
                (NOW + timedelta(seconds=1)).isoformat(),
            )
            self.assertEqual(result["evidenceCount"], 1)
            rows = self.root / "references.json"
            rows.write_text(json.dumps(self.snapshot.metadata["references"]))
            self.assertEqual(C.check_inventory(final / "manifest.json", rows), 1)
        for path in (final, final / "objects"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        for path in final.rglob("*"):
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_duplicate_references_are_deduplicated_and_all_unique_versions_captured(
        self,
    ):
        first = self.snapshot.metadata["references"][0]
        self.snapshot.metadata["references"] += [dict(first)]
        final = self.produce()
        self.assertEqual(
            len(json.loads((final / "manifest.json").read_text())["evidence"]), 1
        )

    def test_every_unique_retained_version_is_captured(self):
        original = self.snapshot.metadata["references"][0]
        self.snapshot.metadata["references"].append(
            {**original, "versionId": "exact-v2"}
        )
        read = self.s3.get_object

        def version_read(**kwargs):
            self.s3.version = kwargs["VersionId"]
            return read(**kwargs)

        with patch.object(self.s3, "get_object", side_effect=version_read):
            final = self.produce()
        manifest = json.loads((final / "manifest.json").read_text())
        self.assertEqual(
            [i["sourceVersionId"] for i in manifest["evidence"]],
            ["exact-v1", "exact-v2"],
        )
        self.assertEqual(len(list((final / "objects").iterdir())), 2)

    def test_mutation_during_capture_is_refused_before_signing(self):
        read = self.s3.get_object

        def mutate(**kwargs):
            self.snapshot.dump_path.write_bytes(b"M" * 60000)
            return read(**kwargs)

        with (
            patch.object(self.s3, "get_object", side_effect=mutate),
            self.assertRaisesRegex(M.BackupRefused, "captured_database_changed"),
        ):
            self.produce()
        self.no_publication()

    def test_prior_evidence_mutation_during_capture_is_refused(self):
        original = self.snapshot.metadata["references"][0]
        self.snapshot.metadata["references"].append(
            {**original, "versionId": "exact-v2"}
        )
        read = self.s3.get_object

        def mutate(**kwargs):
            self.s3.version = kwargs["VersionId"]
            if kwargs["VersionId"] == "exact-v2":
                (self.snapshot.dump_path.parent / "objects/0.bin").write_bytes(
                    b"tampered"
                )
            return read(**kwargs)

        with (
            patch.object(self.s3, "get_object", side_effect=mutate),
            self.assertRaisesRegex(M.BackupRefused, "captured_evidence_changed"),
        ):
            self.produce()
        self.no_publication()

    def test_snapshot_time_is_not_replaced_by_completion_time(self):
        self.snapshot.backup_at = (NOW - timedelta(minutes=50)).isoformat()
        final = self.produce()
        self.assertEqual(
            json.loads((final / "manifest.json").read_text())["backupAt"],
            self.snapshot.backup_at,
        )

    def test_inventory_refusals_publish_nothing(self):
        original = self.snapshot.metadata["references"][0]
        cases = [
            [],
            [{**original, "bucket": "foreign-bucket"}],
            [{**original, "versionId": "null"}],
            [{**original, "byteSize": True}],
            [{**original, "sha256": "bad"}],
            [original, {**original, "sha256": "b" * 64}],
            [{**original, "key": "outside/item"}],
            [{**original, "extra": 1}],
            [{**original, "byteSize": M.MAX_OBJECT_BYTES + 1}],
        ]
        for value in cases:
            with self.subTest(value=value):
                self.snapshot.metadata["references"] = value
                with self.assertRaises(M.BackupRefused):
                    self.produce()
                self.no_publication()

    def test_inventory_and_total_bounds(self):
        item = self.snapshot.metadata["references"][0]
        with patch.object(M, "MAX_OBJECTS", 1), self.assertRaises(M.BackupRefused):
            M.references([item, dict(item)], self.config.bucket)
        with (
            patch.object(M, "MAX_TOTAL_BYTES", len(CONTENT) - 1),
            self.assertRaises(M.BackupRefused),
        ):
            self.produce()
        self.no_publication()

    def test_database_metadata_refusals(self):
        cases = [
            ("tableCount", 79),
            ("rlsCount", 0),
            ("ledgerBreaks", 1),
            ("ledgerFingerprint", "invented"),
            ("tableCount", True),
        ]
        for name, value in cases:
            original = self.snapshot.metadata[name]
            with self.subTest(name=name):
                self.snapshot.metadata[name] = value
                with self.assertRaises(M.BackupRefused):
                    self.produce()
                self.no_publication()
            self.snapshot.metadata[name] = original

    def test_actual_provider_identity_bytes_lock_hold_and_region_refusals(self):
        cases = [
            ("region", "us-east-1"),
            ("mode", "GOVERNANCE"),
            ("years", 6),
            ("expiry", NOW),
            ("hold", "UNKNOWN"),
            ("version", "latest-v2"),
            ("size", len(CONTENT) + 1),
            ("content", b"tampered"),
            ("content", CONTENT + b"extra"),
        ]
        for name, value in cases:
            original = getattr(self.s3, name)
            with self.subTest(name=name):
                setattr(self.s3, name, value)
                with self.assertRaises(M.BackupRefused):
                    self.produce()
                self.no_publication()
                self.assertTrue(all(body.closed for body in self.s3.bodies))
            setattr(self.s3, name, original)

    def test_interruption_dump_provider_and_signing_failure_cleanup(self):
        for failure in (RuntimeError("sensitive-provider-value"), KeyboardInterrupt()):
            with (
                patch.object(self.s3, "get_object", side_effect=failure),
                self.assertRaises((M.BackupRefused, KeyboardInterrupt)),
            ):
                self.produce()
                self.no_publication()
                self.assertTrue(self.snapshot.closed)
        with (
            patch.object(
                self.snapshot, "dump", side_effect=RuntimeError("sensitive-db-value")
            ),
            self.assertRaisesRegex(M.BackupRefused, "backup_capture_failed"),
        ):
            self.produce()
            self.no_publication()
        with (
            patch.object(
                M.hmac, "new", side_effect=RuntimeError("sensitive-key-value")
            ),
            self.assertRaisesRegex(M.BackupRefused, "backup_capture_failed"),
        ):
            self.produce()
            self.no_publication()

    def test_incomplete_dump_and_future_timestamp_refuse(self):
        def small(path):
            with M.secure_open(path) as stream:
                stream.write(b"small")

        with (
            patch.object(self.snapshot, "dump", side_effect=small),
            self.assertRaises(M.BackupRefused),
        ):
            self.produce()
        self.snapshot.backup_at = (NOW + timedelta(days=1)).isoformat()
        with self.assertRaises(M.BackupRefused):
            self.produce()
        self.no_publication()

    def test_atomic_no_overwrite_even_empty_destination(self):
        source, target = self.root / "source", self.root / "target"
        source.mkdir(mode=0o700)
        target.mkdir(mode=0o700)
        with self.assertRaisesRegex(M.BackupRefused, "backup_destination_exists"):
            M.publish_no_replace(source, target)
        self.assertTrue(source.exists())
        self.assertTrue(target.exists())

    def test_parent_sync_failure_retains_signed_publication_for_operator_readback(self):
        sync = M.sync_directory

        def fail_parent(path):
            if path == self.config.output:
                raise OSError("sensitive-storage-value")
            sync(path)

        with (
            patch.object(M, "sync_directory", side_effect=fail_parent),
            self.assertRaisesRegex(M.BackupRefused, "backup_publication_uncertain"),
        ):
            self.produce()
        published = list(self.root.glob("backup-*"))
        self.assertEqual(len(published), 1)
        self.assertEqual(list(self.root.glob(".pending-*")), [])
        final = published[0]
        with patch.dict(os.environ, {"AXIOM_RECOVERY_MANIFEST_KEY": KEY}):
            self.assertEqual(
                C.validate(
                    final / "manifest.json",
                    final / "database.sql",
                    final,
                    "axiom_onprem",
                    (NOW + timedelta(seconds=1)).isoformat(),
                )["evidenceCount"],
                1,
            )
        self.assertEqual(self.snapshot.calls.count("dump"), 1)
        self.assertEqual(final.stat().st_mode & 0o777, 0o700)
        self.assertTrue(
            all(
                path.stat().st_mode & 0o777 == 0o600
                for path in final.rglob("*")
                if path.is_file()
            )
        )

    def test_producer_collision_preserves_existing_empty_directory_and_private_source(
        self,
    ):
        identifier = SimpleNamespace(hex="fixed-existing")
        existing = self.root / "backup-fixed-existing"
        existing.mkdir(mode=0o700)
        inode = existing.stat().st_ino
        publish = M.publish_no_replace
        observed = []

        def observe(source, destination):
            observed.append(source.stat().st_mode & 0o777)
            self.assertTrue(
                all(
                    path.stat().st_mode & 0o777 == 0o600
                    for path in source.rglob("*")
                    if path.is_file()
                )
            )
            publish(source, destination)

        with (
            patch.object(M.uuid, "uuid4", return_value=identifier),
            patch.object(M, "publish_no_replace", side_effect=observe),
            self.assertRaisesRegex(M.BackupRefused, "backup_destination_exists"),
        ):
            self.produce()
        self.assertEqual(observed, [0o700])
        self.assertEqual(existing.stat().st_ino, inode)
        self.assertEqual(existing.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(existing.iterdir()), [])
        self.assertEqual(list(self.root.glob(".pending-*")), [])

    def test_hex_equivalent_authority_and_gcp_endpoint_guards(self):
        with self.assertRaisesRegex(M.BackupRefused, "manifest_authority_not_distinct"):
            M.Config.from_environment({**self.env, "APPROVAL_SIGNING_KEY": KEY.upper()})
        with self.assertRaisesRegex(
            M.BackupRefused, "explicit_gcp_storage_endpoint_required"
        ):
            M.Config.from_environment(
                {**self.env, "AXIOM_BACKUP_SOURCE_REGION": "asia-south1"}
            )
        config = M.Config.from_environment(
            {
                **self.env,
                "AXIOM_BACKUP_SOURCE_REGION": "asia-south1",
                "AXIOM_BACKUP_S3_ENDPOINT": "https://storage.googleapis.com",
            }
        )
        self.assertEqual(config.endpoint, "https://storage.googleapis.com")

    def test_configuration_refusals_and_secret_separation(self):
        for name, value in [
            ("PGDATABASE", "postgres"),
            ("PGPORT", "bad"),
            ("AXIOM_RECOVERY_MANIFEST_KEY", "0" * 64),
            ("APPROVAL_SIGNING_KEY", KEY),
            ("AXIOM_BACKUP_SOURCE_REGION", "us-east-1"),
            ("AXIOM_BACKUP_S3_ENDPOINT", "https://user:pass@example.invalid"),
            ("AXIOM_BACKUP_S3_ENDPOINT", "http://remote.invalid"),
            ("PGHOST", ""),
        ]:
            with self.subTest(name=name), self.assertRaises(M.BackupRefused):
                M.Config.from_environment({**self.env, name: value})
        self.passfile.chmod(0o644)
        with self.assertRaises(M.BackupRefused):
            M.Config.from_environment(self.env)

    def test_remote_postgres_requires_verified_transport_and_protected_ca(self):
        remote = {**self.env, "PGHOST": "database.example.invalid"}
        for params in (
            {},
            {"PGSSLMODE": "prefer"},
            {"PGSSLMODE": "disable"},
            {"PGSSLMODE": "verify-full"},
        ):
            with self.subTest(params=params), self.assertRaises(M.BackupRefused):
                M.Config.from_environment({**remote, **params})
        ca = self.root / "ca.pem"
        ca.write_text("synthetic-ca")
        ca.chmod(0o600)
        config = M.Config.from_environment(
            {**remote, "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(ca)}
        )
        self.assertEqual(config.pg_env["PGSSLMODE"], "verify-full")
        self.assertEqual(config.pg_env["PGSSLROOTCERT"], str(ca))
        self.assertNotIn("PGPASSWORD", config.pg_env)
        ca.chmod(0o644)
        with self.assertRaises(M.BackupRefused):
            M.Config.from_environment(
                {**remote, "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(ca)}
            )

    def test_safe_explicit_local_socket_and_loopback_transport(self):
        socket = self.root / "socket"
        socket.mkdir(mode=0o700)
        config = M.Config.from_environment({**self.env, "PGHOST": str(socket)})
        self.assertEqual(config.pg_env["PGSSLMODE"], "disable")
        socket.chmod(0o777)
        with self.assertRaises(M.BackupRefused):
            M.Config.from_environment({**self.env, "PGHOST": str(socket)})

    def test_symlink_output_and_artifact_refusal(self):
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(M.BackupRefused):
            M.Config.from_environment({**self.env, "AXIOM_BACKUP_OUTPUT": str(link)})
        with self.assertRaises(M.BackupRefused):
            M.private_regular(link)

    def test_bytes_mutation_is_detected_by_existing_consumer(self):
        final = self.produce()
        (final / "objects/0.bin").write_bytes(b"tampered")
        with (
            patch.dict(os.environ, {"AXIOM_RECOVERY_MANIFEST_KEY": KEY}),
            self.assertRaisesRegex(ValueError, "Evidence backup bytes"),
        ):
            C.validate(
                final / "manifest.json",
                final / "database.sql",
                final,
                "axiom_onprem",
                (NOW + timedelta(seconds=1)).isoformat(),
            )

    def test_cli_rejects_arguments_and_withholds_sensitive_error(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["scheduled-backup.py", "old-manifest.json"]),
            patch("sys.stderr", output),
        ):
            self.assertEqual(M.main(), 1)
        self.assertNotIn("old-manifest", output.getvalue())
        with (
            patch.object(sys, "argv", ["scheduled-backup.py"]),
            patch.object(
                M.Config,
                "from_environment",
                side_effect=RuntimeError("sensitive-key-value"),
            ),
            patch("sys.stderr", output),
        ):
            self.assertEqual(M.main(), 1)
        self.assertNotIn("sensitive-key-value", output.getvalue())

    def test_cli_uncertain_publication_requires_operator_readback_without_retry(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["scheduled-backup.py"]),
            patch.object(M.Config, "from_environment", return_value=self.config),
            patch.object(
                M,
                "produce",
                side_effect=M.BackupRefused("backup_publication_uncertain"),
            ) as capture,
            patch("sys.stderr", output),
        ):
            self.assertEqual(M.main(), 1)
        capture.assert_called_once_with(self.config)
        self.assertIn("backup_publication_uncertain", output.getvalue())
        self.assertIn("Operator readback is required", output.getvalue())

    def test_storage_adapter_uses_only_explicit_injected_credentials(self):
        fake = SimpleNamespace(
            client=lambda *args, **kwargs: kwargs, Config=lambda **kwargs: kwargs
        )
        with patch.object(M.importlib, "import_module", return_value=fake):
            result = M.storage_client(self.config)
        self.assertEqual(result["region_name"], "ap-south-1")
        self.assertEqual(result["config"]["read_timeout"], 30)
        self.assertEqual(result["config"]["retries"]["total_max_attempts"], 2)
        self.assertEqual(result["aws_secret_access_key"], self.config.secret_key)
        self.assertEqual(result["aws_access_key_id"], self.config.access_key)


class FakeInput:
    def __init__(self, process):
        self.process = process

    def write(self, wire):
        self.process.commands.append(wire.decode())
        marker = wire.decode().split("\\echo ")[1].strip()
        reply = self.process.replies.pop(0)
        os.write(
            self.process.writer,
            json.dumps(reply).encode() + b"\n" + marker.encode() + b"\n",
        )

    def flush(self):
        pass

    def close(self):
        os.close(self.process.writer)


class FakeProcess:
    def __init__(self, replies):
        reader, self.writer = os.pipe()
        self.stdout = os.fdopen(reader, "rb", buffering=0)
        self.stdin = FakeInput(self)
        self.commands = []
        self.replies = replies
        self.status = None

    def poll(self):
        return self.status

    def wait(self, timeout):
        self.status = 0
        return 0

    def kill(self):
        self.status = -9


class AdapterTests(unittest.TestCase):
    setUp = Tests.setUp

    def test_real_postgres_adapter_protocol_uses_one_exported_snapshot(self):
        replies = [
            {
                "database": self.config.database,
                "backupAt": NOW.isoformat(),
                "snapshot": "00000003-0000001B-1",
            },
            {k: v for k, v in self.snapshot.metadata.items() if k != "references"},
            ["evidence_version_references", "board_artifact_versions"],
            self.snapshot.metadata["references"],
        ]
        process = FakeProcess(replies)
        calls = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            kwargs["stdout"].write(b"D" * 60000)
            return SimpleNamespace(returncode=0)

        with (
            patch.object(
                M.shutil, "which", side_effect=lambda name, **_: "/approved/bin/" + name
            ),
            patch.object(M.subprocess, "Popen", return_value=process) as spawn,
            patch.object(M.subprocess, "run", side_effect=run),
        ):
            final = M.produce(self.config, M.PostgresSnapshot, lambda _: self.s3)
        self.assertTrue((final / "manifest.json").exists())
        self.assertIn("REPEATABLE READ READ ONLY", process.commands[0])
        self.assertIn("pg_export_snapshot()", process.commands[0])
        self.assertIn('public."board_artifact_versions"', process.commands[3])
        self.assertEqual(
            calls[0][0],
            [
                "/approved/bin/pg_dump",
                "--format=plain",
                "--snapshot=00000003-0000001B-1",
            ],
        )
        self.assertEqual(calls[0][1]["stderr"], subprocess.DEVNULL)
        self.assertEqual(spawn.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertNotIn("password", " ".join(calls[0][0]))
        self.assertEqual(calls[0][1]["env"]["PGPASSFILE"], str(self.passfile))
        self.assertEqual(process.status, 0)

    def test_postgres_adapter_rejects_snapshot_and_catalog_substitution(self):
        for initial in (
            {
                "database": self.config.database,
                "backupAt": NOW.isoformat(),
                "snapshot": "not-a-snapshot",
            },
            {
                "database": self.config.database,
                "backupAt": "naive",
                "snapshot": "00000003-0000001B-1",
            },
        ):
            process = FakeProcess([initial])
            with (
                patch.object(M.shutil, "which", return_value="/approved/bin/psql"),
                patch.object(M.subprocess, "Popen", return_value=process),
                self.assertRaises(M.BackupRefused),
                M.PostgresSnapshot(self.config),
            ):
                pass
            self.assertEqual(process.status, 0)
        process = FakeProcess(
            [
                {
                    "database": self.config.database,
                    "backupAt": NOW.isoformat(),
                    "snapshot": "00000003-0000001B-1",
                },
                {k: v for k, v in self.snapshot.metadata.items() if k != "references"},
                ["bad;DROP TABLE tenants"],
            ]
        )
        with (
            patch.object(M.shutil, "which", return_value="/approved/bin/psql"),
            patch.object(M.subprocess, "Popen", return_value=process),
            self.assertRaisesRegex(M.BackupRefused, "invalid_version_table"),
            M.PostgresSnapshot(self.config) as snapshot,
        ):
            snapshot.inventory()
        self.assertEqual(len(process.commands), 3)

    def test_postgres_query_timeout_is_bounded(self):
        snapshot = M.PostgresSnapshot(self.config)
        process = FakeProcess([])
        snapshot.process = process
        with (
            patch.object(M.select, "select", return_value=([], [], [])),
            self.assertRaisesRegex(M.BackupRefused, "snapshot_query_timeout"),
        ):
            snapshot.line(100)
        snapshot.__exit__()

    def test_postgres_adapter_wrong_database_refuses_and_closes(self):
        process = FakeProcess(
            [
                {
                    "database": "foreign_database",
                    "backupAt": NOW.isoformat(),
                    "snapshot": "00000003-0000001B-1",
                }
            ]
        )
        with (
            patch.object(M.shutil, "which", return_value="/approved/bin/psql"),
            patch.object(M.subprocess, "Popen", return_value=process),
            self.assertRaisesRegex(M.BackupRefused, "snapshot_database_mismatch"),
            M.PostgresSnapshot(self.config),
        ):
            pass
        self.assertEqual(process.status, 0)

    def test_postgres_adapter_failed_dump_is_not_published(self):
        process = FakeProcess(
            [
                {
                    "database": self.config.database,
                    "backupAt": NOW.isoformat(),
                    "snapshot": "00000003-0000001B-1",
                }
            ]
        )
        with (
            patch.object(M.shutil, "which", return_value="/approved/bin/tool"),
            patch.object(M.subprocess, "Popen", return_value=process),
            patch.object(
                M.subprocess, "run", return_value=SimpleNamespace(returncode=1)
            ),
            M.PostgresSnapshot(self.config) as snapshot,
            self.assertRaisesRegex(M.BackupRefused, "database_dump_failed"),
        ):
            snapshot.dump(self.root / "failed.sql")
        self.assertEqual(process.status, 0)


if __name__ == "__main__":
    unittest.main()
