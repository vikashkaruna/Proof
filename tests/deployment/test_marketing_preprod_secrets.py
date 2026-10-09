"""No-cloud, unittest-discoverable checks for marketing secret materialization."""

from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "marketing_preprod_secrets", ROOT / "scripts/marketing-preprod-secrets.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def valid_inputs() -> tuple[dict[str, str], dict]:
    env = {
        "ENVIRONMENT": "preprod",
        "GCP_PROJECT_ID": "axiom-proof",
        "GCP_REGION": "asia-south1",
        "AXIOM_DEPLOYMENT_PROFILE": "marketing",
        "CLOUD_SQL_INSTANCE_NAME": "axiom-proof-preprod-postgres",
        "CLOUD_SQL_DATABASE_NAME": "axiom_proof_preprod",
        "CLOUD_SQL_DATABASE_USER": "axiom_admin",
        "CLOUD_SQL_ADMIN_PASSWORD": "admin:secret/with space",
        "GOTRUE_DB_PASSWORD": "auth:secret/with space",
        "REST_DB_PASSWORD": "rest:secret/with space",
        "SUPABASE_JWT_SECRET": "jwt-secret-sentinel",
        "SUPABASE_SERVICE_KEY": "service-key-sentinel",
        "RESEND_API_KEY": "email-key-sentinel",
        "AXIOM_CONTACT_EMAIL_MODE": "disabled",
        "AXIOM_REPORT_EMAIL_MODE": "disabled",
        "MARKETING_AUTH_DB_URL_SECRET": "axiom-proof-preprod-auth-db-url",
        "MARKETING_REST_DB_URL_SECRET": "axiom-proof-preprod-rest-db-url",
        "MARKETING_JWT_SECRET": "axiom-proof-preprod-jwt-secret",
        "MARKETING_SERVICE_KEY_SECRET": "axiom-proof-preprod-service-key",
        "MARKETING_ADMIN_DB_URL_SECRET": "axiom-proof-preprod-admin-db-url",
        "MARKETING_AUTH_PASSWORD_SECRET": "axiom-proof-preprod-auth-password",
        "MARKETING_REST_PASSWORD_SECRET": "axiom-proof-preprod-rest-password",
        "MARKETING_EMAIL_KEY_SECRET": "axiom-proof-preprod-email-key",
    }
    database = {
        "instance": env["CLOUD_SQL_INSTANCE_NAME"],
        "name": env["CLOUD_SQL_DATABASE_NAME"],
        "private_ip": "10.73.1.4",
        "connection_name": "axiom-proof:asia-south1:axiom-proof-preprod-postgres",
    }
    return env, database


def response(argv: list[str], *, returncode: int = 0, stdout: str | bytes = "", stderr: str | bytes = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)


def secret_descriptor(secret: str, project: str = "axiom-proof", location: str = "asia-south1") -> str:
    return json.dumps({"name": f"projects/{project}/secrets/{secret}", "replication": {"userManaged": {"replicas": [{"location": location}]}}})


class SecretMaterializationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env, self.database = valid_inputs()
        self.secret = self.env["MARKETING_AUTH_DB_URL_SECRET"]

    def test_duplicate_secret_payload_ids_refuse_before_cloud(self) -> None:
        fields = [
            "MARKETING_REST_DB_URL_SECRET", "MARKETING_JWT_SECRET",
            "MARKETING_SERVICE_KEY_SECRET", "MARKETING_ADMIN_DB_URL_SECRET",
            "MARKETING_AUTH_PASSWORD_SECRET", "MARKETING_REST_PASSWORD_SECRET",
            "MARKETING_EMAIL_KEY_SECRET",
        ]
        for field in fields:
            for dry_run in (False, True):
                with self.subTest(field=field, dry_run=dry_run), patch.object(MODULE.subprocess, "run") as run:
                    env = dict(self.env)
                    env[field] = env["MARKETING_AUTH_DB_URL_SECRET"]
                    env["AXIOM_CONTACT_EMAIL_MODE"] = "delivery"
                    with self.assertRaisesRegex(ValueError, "Distinct secret"):
                        MODULE.materialize(env, self.database, dry_run)
                    run.assert_not_called()

    def test_existing_secret_descriptor_requires_exact_identity_and_mumbai_replication(self) -> None:
        valid = json.loads(secret_descriptor(self.secret))
        variants = [
            {**valid, "name": "projects/foreign-project/secrets/" + self.secret},
            {**valid, "name": "projects/axiom-proof/secrets/foreign-secret"},
            {**valid, "replication": {"automatic": {}}},
            {**valid, "replication": {"userManaged": {"replicas": [{"location": "us-central1"}]}}},
            {**valid, "replication": {"userManaged": {"replicas": [{"location": "asia-south1"}, {"location": "us-central1"}]}}},
            {**valid, "replication": {}},
            {**valid, "replication": {"userManaged": {"replicas": []}}},
            {**valid, "replication": {"userManaged": {"replicas": [{"location": "asia-south1"}]}, "automatic": {}}},
        ]
        for descriptor in variants:
            with self.subTest(descriptor=descriptor), patch.object(MODULE.subprocess, "run", return_value=response([], stdout=json.dumps(descriptor))) as run:
                with self.assertRaisesRegex(ValueError, "ownership or regional"):
                    MODULE.materialize(self.env, self.database, False)
                self.assertEqual(run.call_count, 1)
        env = {**self.env, "GCP_PROJECT_NUMBER": "188516662106"}
        MODULE.verify_secret_descriptor(secret_descriptor(self.secret, project="188516662106"), env, self.secret)
        with self.assertRaises(ValueError):
            MODULE.verify_secret_descriptor(secret_descriptor(self.secret, project="188516662106"), self.env, self.secret)

    def test_created_secret_is_reverified_before_any_payload_write(self) -> None:
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv)
            if argv[2] == "create":
                return response(argv)
            if len(calls) == 1:
                return response(argv, returncode=1, stderr="NOT_FOUND")
            return response(argv, stdout=secret_descriptor(self.secret, location="us-central1"))
        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(ValueError, "ownership or regional"):
                MODULE.materialize(self.env, self.database, False)
        self.assertEqual([argv[2] for argv in calls], ["describe", "create", "describe"])

    def test_complete_batch_preflight_refuses_before_any_cloud_write(self) -> None:
        cases = [
            ("GOTRUE_DB_PASSWORD", "<auth-password>"),
            ("REST_DB_PASSWORD", "<rest-password>"),
            ("CLOUD_SQL_ADMIN_PASSWORD", "<admin-password>"),
            ("SUPABASE_JWT_SECRET", ""),
            ("SUPABASE_SERVICE_KEY", "placeholder-service-key"),
            ("RESEND_API_KEY", "<email-api-key>"),
            ("MARKETING_REST_PASSWORD_SECRET", "foreign-last-secret"),
            ("MARKETING_EMAIL_KEY_SECRET", "foreign-email-secret"),
        ]
        for key, value in cases:
            with self.subTest(key=key), patch.object(MODULE.subprocess, "run") as run:
                env = {**self.env, "AXIOM_CONTACT_EMAIL_MODE": "delivery", key: value}
                with self.assertRaisesRegex(ValueError, "Invalid secret"):
                    MODULE.materialize(env, self.database, False)
                run.assert_not_called()

    def test_dry_run_never_contacts_cloud_and_only_returns_planned_refs(self) -> None:
        with patch.object(MODULE.subprocess, "run") as run:
            versions = MODULE.materialize(self.env, self.database, True)
        run.assert_not_called()
        self.assertEqual(len(versions), 7)
        self.assertEqual(versions[self.secret], "planned")
        self.assertNotIn(self.env["MARKETING_EMAIL_KEY_SECRET"], versions)

    def test_rejects_wrong_target_or_non_private_database_before_cloud(self) -> None:
        changes = (
            ("ENVIRONMENT", "production"),
            ("AXIOM_DEPLOYMENT_PROFILE", "full"),
            ("GCP_REGION", "us-central1"),
            ("instance", "axiom-proof-production-postgres"),
            ("name", "wrong_database"),
            ("connection_name", "other:asia-south1:axiom-proof-preprod-postgres"),
            ("private_ip", "8.8.8.8"),
            ("private_ip", "10.999.999.999"),
        )
        for key, value in changes:
            with self.subTest(key=key, value=value), patch.object(MODULE.subprocess, "run") as run:
                env = dict(self.env)
                database = dict(self.database)
                (database if key in database else env)[key] = value
                with self.assertRaises(ValueError):
                    MODULE.materialize(env, database, True)
                run.assert_not_called()

    def test_latest_enabled_identical_payload_reuses_exact_numeric_version(self) -> None:
        seen: list[tuple[list[str], dict]] = []

        def fake_run(argv: list[str], **kwargs):
            seen.append((argv, kwargs))
            if argv[2] == "describe":
                return response(argv, stdout=secret_descriptor(argv[3]))
            if argv[2:4] == ["versions", "list"]:
                return response(argv, stdout=json.dumps([
                    {"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/2", "state": "ENABLED"},
                    {"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/5", "state": "ENABLED"},
                ]))
            if argv[2:4] == ["versions", "access"]:
                return response(argv, stdout=expected_payload(argv[5].removeprefix("--secret="), self.env, self.database))
            self.fail(f"Unexpected cloud mutation: {argv}")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            versions = MODULE.materialize(self.env, self.database, False)
        self.assertEqual(set(versions.values()), {"5"})
        self.assertEqual(len(versions), 7)
        self.assertTrue(all("--project=axiom-proof" in argv and "--billing-project=axiom-proof" in argv for argv, _ in seen))
        all_argv = " ".join(" ".join(argv) for argv, _ in seen)
        for secret in (self.env["GOTRUE_DB_PASSWORD"], self.env["REST_DB_PASSWORD"], self.env["SUPABASE_JWT_SECRET"], self.env["SUPABASE_SERVICE_KEY"]):
            self.assertNotIn(secret, all_argv)
        self.assertFalse(any(argv[2:4] == ["versions", "add"] for argv, _ in seen))

    def test_different_existing_payload_refuses_without_rotation(self) -> None:
        seen = []

        def fake_run(argv: list[str], **kwargs):
            seen.append(argv)
            if argv[2] == "describe":
                return response(argv, stdout=secret_descriptor(argv[3]))
            if argv[2:4] == ["versions", "list"]:
                return response(argv, stdout=json.dumps([{"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/3", "state": "ENABLED"}]))
            if argv[2:4] == ["versions", "access"]:
                return response(argv, stdout=b"different-existing-payload")
            self.fail(f"Unexpected cloud mutation: {argv}")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(ValueError):
                MODULE.materialize(self.env, self.database, False)
        self.assertFalse(any(argv[2:4] == ["versions", "add"] for argv in seen))

    def test_unproven_absence_refuses_without_create_or_add(self) -> None:
        seen = []

        def fake_run(argv: list[str], **kwargs):
            seen.append(argv)
            return response(argv, returncode=1, stderr="PERMISSION_DENIED inventory unavailable")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(ValueError):
                MODULE.materialize(self.env, self.database, False)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][1:3], ["secrets", "describe"])

    def test_explicit_not_found_creates_secret_and_records_added_numeric_version(self) -> None:
        seen: list[tuple[list[str], dict]] = []

        created = set()
        def fake_run(argv: list[str], **kwargs):
            seen.append((argv, kwargs))
            if argv[2] == "describe":
                if argv[3] not in created:
                    return response(argv, returncode=1, stderr="NOT_FOUND")
                return response(argv, stdout=secret_descriptor(argv[3]))
            if argv[2] == "create":
                created.add(argv[3])
                return response(argv)
            if argv[2:4] == ["versions", "list"]:
                return response(argv, stdout="[]")
            if argv[2:4] == ["versions", "add"]:
                return response(argv, stdout=json.dumps({"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/1"}).encode())
            self.fail(f"Unexpected cloud command: {argv}")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            versions = MODULE.materialize(self.env, self.database, False)
        self.assertEqual(set(versions.values()), {"1"})
        add_calls = [(argv, kwargs) for argv, kwargs in seen if argv[2:4] == ["versions", "add"]]
        self.assertEqual(len(add_calls), 7)
        self.assertTrue(all("--data-file=-" in argv and isinstance(kwargs["input"], bytes) for argv, kwargs in add_calls))
        all_argv = " ".join(" ".join(argv) for argv, _ in seen)
        self.assertNotIn(self.env["GOTRUE_DB_PASSWORD"], all_argv)

    def test_disabled_existing_versions_never_trigger_implicit_rotation(self) -> None:
        seen = []

        def fake_run(argv: list[str], **kwargs):
            seen.append(argv)
            if argv[2] == "describe":
                return response(argv, stdout=secret_descriptor(argv[3]))
            if argv[2:4] == ["versions", "list"]:
                return response(argv, stdout=json.dumps([{"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/9", "state": "DISABLED"}]))
            self.fail(f"Unexpected cloud mutation: {argv}")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(ValueError):
                MODULE.materialize(self.env, self.database, False)
        self.assertFalse(any(argv[2:4] == ["versions", "add"] for argv in seen))

    def test_older_enabled_version_cannot_replace_disabled_latest_version(self) -> None:
        seen = []

        def fake_run(argv: list[str], **kwargs):
            seen.append(argv)
            if argv[2] == "describe":
                return response(argv, stdout=secret_descriptor(argv[3]))
            if argv[2:4] == ["versions", "list"]:
                return response(argv, stdout=json.dumps([
                    {"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/8", "state": "ENABLED"},
                    {"name": f"projects/axiom-proof/secrets/{argv[4]}/versions/9", "state": "DISABLED"},
                ]))
            self.fail(f"Unexpected cloud operation: {argv}")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(ValueError):
                MODULE.materialize(self.env, self.database, False)
        self.assertFalse(any(argv[2:4] in (["versions", "access"], ["versions", "add"]) for argv in seen))

    def test_malformed_inventory_and_created_ordinal_refused(self) -> None:
        for listed in ("not-json", json.dumps([{"name": "latest"}])):
            with self.subTest(listed=listed):
                def fake_run(argv: list[str], **kwargs):
                    if argv[2] == "describe":
                        return response(argv, stdout=secret_descriptor(argv[3]))
                    if argv[2:4] == ["versions", "list"]:
                        return response(argv, stdout=listed)
                    self.fail(f"Unexpected cloud mutation: {argv}")

                with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                    with self.assertRaises(ValueError):
                        MODULE.materialize(self.env, self.database, False)

    def test_created_version_must_be_a_numeric_ordinal(self) -> None:
        def fake_run(argv: list[str], **kwargs):
            if argv[2] == "describe":
                return response(argv, stdout=secret_descriptor(argv[3]))
            if argv[2:4] == ["versions", "list"]:
                return response(argv, stdout="[]")
            if argv[2:4] == ["versions", "add"]:
                return response(argv, stdout=b'{"name":"projects/p/secrets/s/versions/latest"}')
            self.fail(f"Unexpected cloud command: {argv}")

        with patch.object(MODULE.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(ValueError):
                MODULE.materialize(self.env, self.database, False)

    def test_cli_error_diagnostics_do_not_print_secret_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "selected.private.env"
            selected.write_text("".join(f"{key}={value}\n" for key, value in self.env.items()))
            database = root / "database.json"
            database.write_text(json.dumps({**self.database, "private_ip": "8.8.8.8"}))
            output = root / "versions.json"
            stdout = io.StringIO()
            with patch.object(sys, "argv", ["secrets", "--env-file", str(selected), "--database-output", str(database), "--output", str(output), "--dry-run"]), redirect_stdout(stdout), patch.object(MODULE.subprocess, "run") as run:
                code = MODULE.main()
            self.assertEqual(code, 1)
            self.assertFalse(output.exists())
            run.assert_not_called()
            message = stdout.getvalue()
            for key in ("GOTRUE_DB_PASSWORD", "REST_DB_PASSWORD", "CLOUD_SQL_ADMIN_PASSWORD", "SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_KEY"):
                self.assertNotIn(self.env[key], message)


def expected_payload(secret: str, env: dict[str, str], database: dict) -> bytes:
    from urllib.parse import quote

    host = database["private_ip"]
    db = quote(database["name"], safe="")
    password_by_secret = {
        env["MARKETING_AUTH_DB_URL_SECRET"]: f"postgresql://supabase_auth_admin:{quote(env['GOTRUE_DB_PASSWORD'], safe='')}@{host}:5432/{db}?sslmode=require&search_path=auth",
        env["MARKETING_REST_DB_URL_SECRET"]: f"postgresql://authenticator:{quote(env['REST_DB_PASSWORD'], safe='')}@{host}:5432/{db}?sslmode=require",
        env["MARKETING_JWT_SECRET"]: env["SUPABASE_JWT_SECRET"],
        env["MARKETING_SERVICE_KEY_SECRET"]: env["SUPABASE_SERVICE_KEY"],
        env["MARKETING_ADMIN_DB_URL_SECRET"]: f"postgresql://{env['CLOUD_SQL_DATABASE_USER']}:{quote(env['CLOUD_SQL_ADMIN_PASSWORD'], safe='')}@{host}:5432/{db}?sslmode=require",
        env["MARKETING_AUTH_PASSWORD_SECRET"]: env["GOTRUE_DB_PASSWORD"],
        env["MARKETING_REST_PASSWORD_SECRET"]: env["REST_DB_PASSWORD"],
    }
    return password_by_secret[secret].encode()


if __name__ == "__main__":
    unittest.main()
